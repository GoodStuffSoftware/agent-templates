// scrub.mjs — strip machine-identifying detail out of text that is about to
// leave the machine as a signal / notification line (detect.mjs's signals).
//
// A git error message, a configured repo path or a hit sample can carry the
// operator's own layout: a profile path (in any escaping), a dev-root path
// naming a private project, a path-encoded ~/.claude/projects entry, the OS
// handle glued to other text, a private repo's URL or owner/repo pair, a
// credential embedded in a URL, or a private project name. Every one of those
// is replaced with a neutral marker. A repo URL or owner/repo pair that is
// KNOWN PUBLIC (passed in by the caller) is left readable — it is what the
// operator needs to act on the signal — but ALWAYS loses its userinfo
// (`https://<token>@host/...` → `https://host/...`): a credential is never
// public, whatever repo it is attached to.
//
// Zero dependencies beyond this plugin's own leak-scan-core.mjs.

import { compileDerived } from './leak-scan-core.mjs';
import { normalizeGitUrl } from './publication-sweep.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- repo references ------------------------------------------------------
// One alternation, one left-to-right pass, so text a branch has already
// decided on (a kept public URL) is never re-scanned by a later branch.
// Every branch stops at whitespace, a quote, a bracket, and `:` in the path
// part — so `<url>:README.md:3` or `<url>: clone failed` never folds the
// file/line or the message into the URL.
const HOST = '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';
const USERINFO = '[^\\s/@"\'<>()\\[\\]]+@';
const SEG = '[\\w-]+(?:\\.[\\w-]+)*'; // owner or repo name, never ending in "."
const GIT_HOSTS = '(?:[A-Za-z0-9-]+\\.)*(?:github\\.com|gitlab\\.com|bitbucket\\.org)';
const NAMED_HOST = '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}'; // dotted, alphabetic TLD
const REPO_REF_RE = new RegExp([
  // 1. scheme://[userinfo@]host[:port][/path] — any scheme with an authority.
  `\\b([a-z][a-z0-9+.-]*):\\/\\/(${USERINFO})?(${HOST}(?::\\d+)?)((?:\\/[^\\s"'<>()\\[\\]:;,]*)?)`,
  // 2. scp form: [userinfo@]host:owner/repo(.git)
  `(?<![\\w.@/-])(${USERINFO})(${HOST}):(${SEG}\\/${SEG})(?![\\w/-])`,
  // 3. scheme-less host: [userinfo@]<host>/owner/repo[/more] for any named
  //    host, or github.com:owner/repo (no user) for a known git host. A
  //    longer path is taken whole (and so is only ever kept if it is exactly
  //    a public owner/repo).
  `(?<![\\w.@/-])(${USERINFO})?(${GIT_HOSTS}(?=:)|${NAMED_HOST}(?=\\/))[/:](${SEG}(?:\\/${SEG})+)(?![\\w-])`,
  // 4. any other userinfo@host/ — strip the userinfo, keep the rest to the later passes.
  `(?<![\\w.@/-])${USERINFO}(?=${HOST}\\/)`,
].join('|'), 'gi');

// A bare owner/repo pair ("repository myorg/privrepo not found"). Runs AFTER
// the path passes (so path fragments are already markers) and never inside a
// longer path: not preceded by a path/URL character, not followed by another
// segment. Not treated as a repo reference:
//   * a `<rel>:<line>` file reference (a hit sample's file, e.g. docs/x.md:3);
//   * a rate like "spawns/24h" / "runs/7d" (right side a number + short unit).
const BARE_PAIR_RE = /(?<![\w.@/\\:%<>-])([A-Za-z0-9][\w-]*)\/([\w-]+(?:\.[\w-]+)*)(?![\w/\\-]|\.\w|:\d)/g;
const RATE_RE = /^\d+[a-z]{0,3}$/i;

// A bare GitHub token anywhere in the text (classic ghp_/gho_/ghu_/ghs_/ghr_
// and fine-grained github_pat_), wherever it stands. Runs right AFTER the
// repo-reference pass (which already dropped every URL's userinfo, and must
// see "token@host" intact to recognise the URL at all — a "<token>@host"
// no longer parses as a URL, which would leave a private repo readable).
const GH_TOKEN_RE = /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

// Known residue (reviewed, accepted — not bugs to rediscover):
//   * A bare owner/repo pair is recognised heuristically: a private pair
//     whose repo half looks like a rate ("x/24h") or that is followed by
//     ":<digit>" (read as a file:line reference) is left as-is.
//   * A deeper path on a public repo URL (…/blob/main/x) is not "exactly a
//     public owner/repo" and is scrubbed to <repo-url> — safe, less readable.

const PATH_RES = [
  // Windows absolute path with / or 1-4 backslashes (JSON-escaped forms too).
  [/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,4}|\/)[^\s"'<>|;,]*/g, '<path>'],
  // UNC path.
  [/(?<![\w\\])\\\\[\w.$-]+\\[^\s"'<>|;,]*/g, '<path>'],
  // POSIX / macOS / WSL home paths.
  [/(?:\/mnt\/[a-z])?\/(?:home|Users)\/[^/\s"'<>;,]+(?:\/[^\s"'<>;,]*)?/gi, '<home>'],
  // ~/dev/<x>, $HOME/code/<x>, %USERPROFILE%\src\<x> …
  [/(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?:\\{1,4}|\/)[^\s"'<>;,]*/gi, '<path>'],
  // URL-encoded drive or /Users|/home path.
  [/(?:[A-Za-z](?::|%3A))?(?:%2F|%5C)(?:Users|home)(?:%2F|%5C)[^\s"'<>;,]*/gi, '<path>'],
  // path-encoded ~/.claude/projects dir: C--Users-<u>-dev-<p>, -home-<u>-…
  [/(?<![A-Za-z0-9])(?:[A-Za-z]--Users-|-(?:home|Users)-)[\w.-]+/gi, '<encoded-path>'],
];

// makeScrubber({ users, names, publicUrls }) -> (text) => scrubbed text.
//   users:      raw OS handle(s); each is replaced wherever it stands between
//               non-alphanumerics ("<u>_dev", "<u>-laptop", "<u>.local").
//   names:      derived PRIVATE project names (already public-subtracted by
//               the caller) — replaced by their compiled matchers.
//   publicUrls: repo URLs / owner/repo names known public; a repo reference
//               (URL in any form, or a bare owner/repo pair) normalizing to
//               one of them is kept (minus any userinfo), every other one is
//               replaced with <repo-url> / <repo>.
export function makeScrubber({ users = [], names = [], joined = [], publicUrls = [] } = {}) {
  const publicKeys = new Set(publicUrls.map((u) => normalizeGitUrl(/^[\w.-]+\/[\w.-]+$/.test(u) ? `https://github.com/${u}` : u)));
  const isPublic = (host, path) => publicKeys.has(normalizeGitUrl(`https://${host}/${String(path || '').replace(/^\/+/, '')}`));
  const userRes = [...new Set(users.map((u) => String(u || '').trim()).filter((u) => u.length >= 3))]
    .map((u) => new RegExp(`(?<![A-Za-z0-9])${esc(u)}(?![A-Za-z0-9])`, 'gi'));
  const nameRes = compileDerived({ names, joined }).map((d) => d.re);

  const repoRef = (m, scheme, _ui1, host1, path1, _ui2, host2, path2, _ui3, host3, path3) => {
    if (scheme !== undefined) {
      // Peel trailing sentence punctuation off the path so "…/repo." stays readable.
      const [, path, tail] = /^(.*?)([.]*)$/.exec(path1);
      return isPublic(host1, path) ? `${scheme}://${host1}${path}${tail}` : `<repo-url>${tail}`;
    }
    if (host2 !== undefined) return isPublic(host2, path2) ? `git@${host2}:${path2}` : '<repo-url>';
    if (host3 !== undefined) return isPublic(host3, path3) ? `${host3}/${path3}` : '<repo-url>';
    return ''; // branch 4: bare userinfo before a host — drop it
  };

  return (text) => {
    let s = String(text ?? '');
    s = s.replace(REPO_REF_RE, repoRef);
    s = s.replace(GH_TOKEN_RE, '<token>');
    for (const [re, mark] of PATH_RES) s = s.replace(re, mark);
    s = s.replace(BARE_PAIR_RE, (m, owner, repo) => (RATE_RE.test(repo) || isPublic('github.com', `${owner}/${repo}`) ? m : '<repo>'));
    for (const re of userRes) s = s.replace(re, '<user>');
    for (const re of nameRes) s = s.replace(re, '<name>');
    return s;
  };
}
