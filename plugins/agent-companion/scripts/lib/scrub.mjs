// scrub.mjs — strip machine-identifying detail out of text that is about to
// leave the machine as a signal / notification line (detect.mjs's signals).
//
// A git error message, a configured repo path or a hit sample can carry the
// operator's own layout: a profile path (in any escaping), a dev-root path
// naming a private project, a path-encoded ~/.claude/projects entry, the OS
// handle glued to other text, a private repo's URL, or a private project
// name. Every one of those is replaced with a neutral marker. A repo URL or
// name that is KNOWN PUBLIC (passed in by the caller) is left alone — it is
// what the operator needs to read to act on the signal.
//
// Zero dependencies beyond this plugin's own leak-scan-core.mjs.

import { compileDerived } from './leak-scan-core.mjs';
import { normalizeGitUrl } from './publication-sweep.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// https://host/owner/repo(.git) · ssh://git@host/owner/repo · git@host:owner/repo
const REPO_URL_RE = /\b(?:https?|ssh|git):\/\/[^\s"'<>()]+|\b[\w.-]+@[\w.-]+:[\w.-]+\/[\w.-]+(?:\.git)?/gi;
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
//   publicUrls: repo URLs / owner/repo names known public; URLs normalizing
//               to one of them are kept, every other repo URL is replaced.
export function makeScrubber({ users = [], names = [], joined = [], publicUrls = [] } = {}) {
  const publicKeys = new Set(publicUrls.map((u) => normalizeGitUrl(/^[\w.-]+\/[\w.-]+$/.test(u) ? `https://github.com/${u}` : u)));
  const userRes = [...new Set(users.map((u) => String(u || '').trim()).filter((u) => u.length >= 3))]
    .map((u) => new RegExp(`(?<![A-Za-z0-9])${esc(u)}(?![A-Za-z0-9])`, 'gi'));
  const nameRes = compileDerived({ names, joined }).map((d) => d.re);
  return (text) => {
    let s = String(text ?? '');
    s = s.replace(REPO_URL_RE, (m) => (publicKeys.has(normalizeGitUrl(m.replace(/[.,;:]+$/, ''))) ? m : '<repo-url>'));
    for (const [re, mark] of PATH_RES) s = s.replace(re, mark);
    for (const re of userRes) s = s.replace(re, '<user>');
    for (const re of nameRes) s = s.replace(re, '<name>');
    return s;
  };
}
