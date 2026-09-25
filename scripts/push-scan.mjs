#!/usr/bin/env node
// scripts/push-scan.mjs — scans every commit a push would publish, on EVERY
// pushed ref (wip/** and backup/** included), before it leaves the machine.
//
// WHY. leak-check.mjs scans the working tree: what is committable NOW. A push
// publishes history, and history can carry what the tree no longer does — a
// private name added in one commit and deleted in the next is gone from the
// tree, passes leak-check, and is published forever by the push. This repo is
// public, so the only safe place to catch that is before the push.
//
// WHICH COMMITS. Every commit the push publishes that is not already public
// ON THE REMOTE BEING PUSHED TO. "Already public" is exactly:
//   - the remote tips git itself reports on the hook's stdin (what the
//     destination has for each ref being pushed, as of this push), and
//   - the remote-tracking refs of that one remote, refs/remotes/<remote>/*,
//     but only those whose commit the destination still advertises NOW
//     (one `git ls-remote <push URL>` per push).
// Scanning public history again would block a merge of main on main's own
// history. Nothing else counts: another remote's refs (a private mirror, a
// git-p4/git-svn import under refs/remotes/p4), a ref made by hand, or a
// tracking ref that is stale (the branch was deleted upstream, or scrubbed
// by a force-push from another machine) no longer make a commit look
// public. If ls-remote fails, only the stdin tips count (a warning says so).
//
// REF NAMES. Every pushed ref name, the local and the remote one, is checked
// like a path: a branch or tag name is published too.
//
// WHAT IS SCANNED, per commit:
//   - its CONTENT that is new: for every file the commit changes, the lines
//     of the new version that appear in no parent's version of that file (a
//     rename is compared with the file it was renamed from). For a merge, a
//     file identical to any one parent is skipped, so only lines new relative
//     to EVERY parent count (an "evil merge" is still caught). Lines are read
//     straight from the blobs (`git cat-file`), never from a rendered diff,
//     so .gitattributes `binary` / `-diff`, textconv and NUL bytes cannot hide
//     content. Each line is checked as UTF-8; the denylist also checks it as
//     latin1 when it is not valid UTF-8 and as UTF-16LE (both alignments)
//     when the file has NUL bytes. A file over the size cap (16 MiB, or
//     PUSH_SCAN_MAX_FILE_BYTES) is NOT scanned: a warning names it ("not
//     scanned (size)") and the push goes on — the cap bounds the scan's
//     memory and time, and a file that large is a build artefact or data
//     dump that is looked at by hand, not a place a name slips in by
//     accident. Its path is still checked. A compressed container (zip and
//     so docx/xlsx, gzip, bzip2, xz, zstd, 7z, a PNG zTXt/compressed iTXt
//     chunk, a PDF with filtered streams) is scanned as raw bytes only: a
//     warning names it ("compressed content not scanned") and the push goes
//     on;
//   - the commit message (%B — the body and its trailers), as UTF-8 and, for
//     the denylist, as latin1 when it is not valid UTF-8;
//   - every path the commit introduces (a name no parent has).
// Paths come from `git diff-tree -z`, NUL-separated and never C-quoted.
// Author and committer identity (name, email, dates) are NOT scanned: they
// are the operator's own identity by design, not content. Every git command
// runs with GIT_NO_REPLACE_OBJECTS=1 and no graft file, so `git replace`
// and .git/info/grafts cannot show the scan different objects from the ones
// the push sends.
//
// TWO CHECKS on each of those:
//   (a) leak-check.mjs's own classes — static tokens, derived names, private
//       paths, SHA-like runs — with the same derivation, the same per-file
//       exemptions (LICENSE etc.) and the same binary-extension skip, via its
//       exported buildScanContext/scanText. One exception, messages only: a
//       SHA-like run that names a commit IN THIS REPOSITORY is self-reference
//       (git revert writes one into every message it makes), not a leak.
//   (b) the local private-names denylist, <stateRoot>/config/private-names.txt
//       (stateRoot = $AGENT_COMPANION_STATE_DIR, else
//       ${CLAUDE_CONFIG_DIR:-~/.claude}/agent-companion — the plugin's own
//       resolution, hooks/lib/context.mjs stateRootPath()). One entry per
//       line, `#` comments and blank lines ignored, UTF-8 (a BOM is fine).
//       A plain entry is a case-insensitive literal that must sit on a WORD
//       BOUNDARY at both ends (see isNameBoundary): a character that is not
//       a letter or digit, a lower->Upper case change (fooBarName), the end
//       of an acronym (XMLParser), or a letter<->digit change (name2). So
//       "ann" hits "ann", "Ann's", "ann_x", "getAnnName" and "ann2" but not
//       "annotation", "joann" or "ANNOTATION". An entry starting `re:` is a
//       case-insensitive JavaScript regex, used as written. Text is also
//       matched in its NFKC form with invisible format characters removed,
//       and in its DECODED form: JSON/JS escapes (\n, \t, \r, \uXXXX, ...)
//       and URL percent-encoding (%2F, ...) undone, so "hi\nname" in a JSONL
//       transcript and "%2Fname" in a URL hit like "name" does.
//       Lines are separated by LF, CRLF, CR, U+2028 or U+2029.
//       A MISSING file is a one-line warning. A file that exists but cannot
//       be read or decoded (a directory, a permission error, UTF-16, invalid
//       UTF-8), an entry that is not a valid regex or that matches empty
//       text, or an entry holding a control character (a TAB, or a line
//       separator the file uses that is none of those five), BLOCKS: a
//       security list that silently drops out is worse than a push that
//       stops and says what to fix. Its contents are never printed.
//
// OUTPUT CONTRACT. A hit prints the commit SHA, where it is (file:line, the
// commit message, or a path) and which check fired — NEVER the matched text
// or the line. Every path printed goes through the same matchers first: each
// match is replaced by "[redacted]", control characters are escaped, and a
// path that still matches in any form is replaced by "[redacted path]".
// Every other line printed has the denylist redacted from it and the home
// directory shown as "~". The operator finds the text with the SHA; the
// terminal, a CI log or a screenshot never carries it.
//
// Usage (normally called by ci-local.mjs --pre-push-hook, not by hand):
//   node scripts/push-scan.mjs <commit-range-or-sha>...
//     scans exactly the commits `git rev-list <args>` names, e.g.
//     `origin/main..HEAD`.
// Exit code: 0 clean (warnings allowed), 1 hits or an unusable denylist, 2 on
// a bad invocation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, devNull } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildScanContext, scanText, scanOptionsForRel, skipsAsBinary } from './leak-check.mjs';
import { cleanGitEnv } from '../plugins/agent-companion/scripts/lib/git-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MAX_PRINTED_HITS = 50;
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
// Upper bound on blob bytes fetched by one `git cat-file --batch`.
const BATCH_BYTES = 256 * 1024 * 1024;
// How long `git ls-remote` may take before its answer is given up on.
const LS_REMOTE_TIMEOUT_MS = 30 * 1000;
export const REDACTED = '[redacted]';
export const REDACTED_PATH = '[redacted path]';
export const REDACTED_REF = '[redacted ref]';

// ---------------------------------------------------------------------------
// Output hygiene
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// C0/C1 controls plus the invisible and bidi characters that can hide or
// reorder text on a terminal.
// (Built from code-point ranges so the source stays plain ASCII.)
function uEsc(n) {
  return `\\u${n.toString(16).padStart(4, '0')}`;
}
const CONTROL_RE = new RegExp(`[${[
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
].map(([a, b]) => (a === b ? uEsc(a) : `${uEsc(a)}-${uEsc(b)}`)).join('')}]`, 'g');

// U+FFFD, what an invalid UTF-8 byte reads as.
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

// Every control character as a visible \xNN / \uNNNN escape.
export function escapeControls(s) {
  return String(s).replace(CONTROL_RE, (c) => {
    const n = c.codePointAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  });
}

// `s` with this machine's home directory (in its native, forward-slash and
// MSYS /c/... spellings) shown as "~". ci-local.mjs keeps an identical
// scrubHomeDir() for its own crash message: it must load without this file
// (it imports push-scan lazily, and this file cannot import it back — a
// cycle through its top-level await would never settle).
export function scrubHome(s, home = homedir()) {
  let out = String(s);
  if (!home) return out;
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(home);
  if (drive) variants.add(`/${drive[1]}/${drive[2].replace(/\\/g, '/')}`);
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(v), 'gi'), '~');
  }
  return out;
}

// JSON/JS string escapes and URL percent-encoding, one level deep:
//   \uXXXX  \u{X...}  \xXX  \n \r \t \b \f \v \0  \" \' \\ \/   and runs of %XX
// (a %XX run is read as UTF-8, or as latin1 when it is not valid UTF-8). An
// escaped backslash is decoded in the same pass, so "\\n" stays a backslash
// and an "n".
const ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbfv0'"\\/]))|((?:%[0-9a-fA-F]{2})+)/g;
const SIMPLE_ESCAPES = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', "'": "'", '"': '"', '\\': '\\', '/': '/',
};
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export function decodeEscapes(s) {
  if (!/[\\%]/.test(s)) return s;
  return s.replace(ESCAPE_RE, (m, brace, u4, x2, simple, pct) => {
    if (brace !== undefined) {
      const n = parseInt(brace, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
    if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
    if (simple !== undefined) return SIMPLE_ESCAPES[simple];
    const bytes = Buffer.from(pct.replace(/%/g, ''), 'hex');
    try {
      return UTF8_FATAL.decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  });
}

// The as-written forms of `s`: itself, NFKC-normalised (fullwidth,
// compatibility and decomposed forms), and that with invisible format
// characters (zero-width, soft hyphen, bidi) removed.
function writtenViews(s) {
  const views = [s];
  if (/[^\x00-\x7f]/.test(s)) {
    const n = s.normalize('NFKC');
    if (n !== s) views.push(n);
    const stripped = n.replace(/\p{Cf}/gu, '');
    if (stripped !== n) views.push(stripped);
  }
  return views;
}

// The forms a piece of text is matched in: its as-written forms, and those of
// its decoded form (decodeEscapes) when that differs. A name right after an
// escape ("hi\nname", "%2Fname") sits next to the escape's letter as
// written, which is no word boundary; decoded, it sits next to a newline or
// a slash, which is one.
export function textViews(s) {
  const views = writtenViews(s);
  const decoded = decodeEscapes(s);
  if (decoded !== s) for (const v of writtenViews(decoded)) if (!views.includes(v)) views.push(v);
  return views;
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

export function denylistPath(env = process.env) {
  const stateRoot = env.AGENT_COMPANION_STATE_DIR
    || join(env.CLAUDE_CONFIG_DIR || join(env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude'), 'agent-companion');
  return join(stateRoot, 'config', 'private-names.txt');
}

// The denylist's location as it is safe to print: through the variable that
// set it, or ~-relative — never an expanded home path.
export function denylistDisplayPath(env = process.env) {
  if (env.AGENT_COMPANION_STATE_DIR) return '$AGENT_COMPANION_STATE_DIR/config/private-names.txt';
  if (env.CLAUDE_CONFIG_DIR) return '$CLAUDE_CONFIG_DIR/agent-companion/config/private-names.txt';
  if (env.AGENT_COMPANION_HOME_OVERRIDE) return '$AGENT_COMPANION_HOME_OVERRIDE/.claude/agent-companion/config/private-names.txt';
  return '~/.claude/agent-companion/config/private-names.txt';
}

const RE_LETTER = /[\p{L}\p{M}]/u;
const RE_DIGIT = /\p{Nd}/u;
const RE_UPPER = /[\p{Lu}\p{Lt}]/u;
const RE_LOWER = /\p{Ll}/u;

// The code point that ends just before UTF-16 index i, or null at the start.
function cpBefore(s, i) {
  if (i <= 0) return null;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

// The code point that starts at UTF-16 index i, or null at the end.
function cpAt(s, i) {
  if (i >= s.length) return null;
  return String.fromCodePoint(s.codePointAt(i));
}

// Whether the gap before UTF-16 index i of `s` is a word boundary for a
// denylist literal. A boundary is: either end of the text; a neighbour that
// is not a letter or digit; a letter<->digit change ("name2", "2name"); a
// lower->Upper change ("fooBar"); or the end of an acronym, i.e. Upper->Upper
// where the next character is lower ("XMLParser" splits before the P).
// Digit->digit and lower->lower are never boundaries, and neither is
// Upper->lower, so "ann" never hits "annotation", "joann", "Annotation" or
// "ANNotation".
export function isNameBoundary(s, i) {
  const a = cpBefore(s, i);
  const b = cpAt(s, i);
  if (a === null || b === null) return true;
  const aLetter = RE_LETTER.test(a);
  const bLetter = RE_LETTER.test(b);
  const aWord = aLetter || RE_DIGIT.test(a);
  const bWord = bLetter || RE_DIGIT.test(b);
  if (!aWord || !bWord) return true;
  if (aLetter !== bLetter) return true;
  if (!aLetter) return false;
  if (RE_LOWER.test(a) && RE_UPPER.test(b)) return true;
  if (RE_UPPER.test(a) && RE_UPPER.test(b)) {
    const c = cpAt(s, i + b.length);
    if (c !== null && RE_LOWER.test(c)) return true;
  }
  return false;
}

function literalMatcher(entry) {
  const re = new RegExp(escapeRe(entry.normalize('NFKC')), 'giu');
  const ranges = (s) => {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (isNameBoundary(s, start) && isNameBoundary(s, end)) {
        out.push([start, end]);
        re.lastIndex = end;
      } else {
        re.lastIndex = start + 1;
      }
    }
    return out;
  };
  return { kind: 'literal', ranges, test: (s) => ranges(s).length > 0 };
}

function regexMatcher(body) {
  const re = new RegExp(body, 'gi');
  re.lastIndex = 0;
  if (re.test('')) throw new Error('matches empty text');
  // Only a non-empty match counts: a zero-width match carries no text.
  const ranges = (s) => {
    const out = [];
    for (const m of s.matchAll(re)) if (m[0].length) out.push([m.index, m.index + m[0].length]);
    return out;
  };
  return { kind: 'regex', ranges, test: (s) => ranges(s).length > 0 };
}

// One denylist line -> a matcher { kind, test(text), ranges(text) }. Throws
// on an invalid `re:` body, or one that matches empty text.
export function compileDenyEntry(raw) {
  const entry = String(raw).trim();
  if (entry.startsWith('re:')) return regexMatcher(entry.slice(3));
  return literalMatcher(entry);
}

// Denylist bytes -> { text } or { error } (a reason safe to print: it never
// quotes the file).
export function decodeDenylist(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { error: 'is UTF-16 encoded (it starts with a UTF-16 byte-order mark); re-save it as UTF-8' };
  }
  if (buf.includes(0)) {
    return { error: 'contains NUL bytes (UTF-16 without a byte-order mark, or not a text file); re-save it as UTF-8' };
  }
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body) };
  } catch {
    return { error: 'is not valid UTF-8; re-save it as UTF-8' };
  }
}

// { missing, error, entries: [{ lineNo, kind, test, ranges }], invalid: [lineNo] }.
//   missing: true only when the file does not exist (ENOENT / ENOTDIR).
//   error:   a printable reason when it exists but cannot be read or decoded.
// lineNo is 1-based within the denylist file — safe to print, unlike the entry.
export function loadDenylist(path, { readFile = readFileSync } = {}) {
  let buf;
  const none = { entries: [], invalid: [], controls: [] };
  try {
    buf = readFile(path);
  } catch (e) {
    const code = e && typeof e.code === 'string' && /^[A-Z0-9_]+$/.test(e.code) ? e.code : 'unknown error';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true, error: null, ...none };
    const error = code === 'EISDIR' ? 'is a directory, not a file (EISDIR)' : `could not be read (${code})`;
    return { missing: false, error, ...none };
  }
  const decoded = decodeDenylist(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
  if (decoded.error) return { missing: false, error: decoded.error, ...none };
  return parseDenylist(decoded.text);
}

// A denylist line ends at LF, CRLF, CR, U+2028 or U+2029. (Built from code
// points so the source stays plain ASCII.)
const DENY_LINE_RE = new RegExp(`\\r\\n|[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
// C0 and C1 control characters (TAB and NEL included) and DEL.
const CC_RE = /[\x00-\x1f\x7f-\x9f]/;

// { missing, error, entries, invalid: [lineNo], controls: [lineNo] }.
//   invalid:  `re:` entries that are not valid regexes, or match empty text.
//   controls: entries holding a control character — a TAB, or a line
//             separator other than the five above (NEL, VT, FF...) — which
//             could never match ordinary text.
export function parseDenylist(text) {
  const entries = [];
  const invalid = [];
  const controls = [];
  String(text).split(DENY_LINE_RE).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (CC_RE.test(t)) {
      controls.push(i + 1);
      return;
    }
    try {
      entries.push({ lineNo: i + 1, ...compileDenyEntry(t) });
    } catch {
      invalid.push(i + 1);
    }
  });
  return { missing: false, error: null, entries, invalid, controls };
}

// Every denylist entry that matches `text` in any of its views, as
// { entryLine, line } (line is 1-based within `text`). Never returns the
// matched substring.
export function matchDenylist(text, entries) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    const views = textViews(l);
    for (const e of entries) {
      if (views.some((v) => e.test(v))) out.push({ entryLine: e.lineNo, line: i + 1 });
    }
  });
  return out;
}

// The redaction layer every printed line and path goes through.
//   redact(s):      each denylist match and each leak-check token -> [redacted]
//   displayPath(p): a path as it is safe to print (see OUTPUT CONTRACT)
//   safeLine(s):    home -> "~", then denylist matches -> [redacted]
export function makeRedactor({ entries = [], leakCtx = null, home = homedir() } = {}) {
  const derived = leakCtx?.derived || [];
  const realUsers = leakCtx?.realUsers;
  const leakHits = (s) => (leakCtx ? scanText(s, { rel: '', derived, realUsers, noSha: true }).hits : []);
  const redactDeny = (s) => {
    let out = s;
    for (const e of entries) {
      const r = e.ranges(out);
      for (let k = r.length - 1; k >= 0; k -= 1) out = out.slice(0, r[k][0]) + REDACTED + out.slice(r[k][1]);
    }
    return out;
  };
  const redactLeak = (s) => {
    let out = s;
    for (const h of leakHits(out)) if (h.token) out = out.split(h.token).join(REDACTED);
    return out;
  };
  const anyHit = (s) => textViews(s).some((v) => entries.some((e) => e.test(v)) || leakHits(v).length > 0);
  const redact = (s) => redactLeak(redactDeny(String(s)));
  // `whole` is what is printed instead when the text cannot be cleaned.
  const displayPath = (p, whole = REDACTED_PATH) => {
    const text = typeof p === 'string' ? p : p.text;
    const latin1 = typeof p === 'string' ? null : p.latin1;
    const cut = redact(text);
    // Anything still matching after the cut — in any view (NFKC, format
    // characters removed, escapes decoded), or once control characters and
    // replacement characters are dropped (a name split by one, or by one
    // invalid UTF-8 byte, would read through it) — could not be cut out
    // cleanly: withhold the whole text.
    const bare = cut.replace(CONTROL_RE, '').split(REPLACEMENT_CHAR).join('');
    if (anyHit(cut) || anyHit(bare)) return whole;
    const r = escapeControls(cut);
    if (anyHit(r)) return whole;
    // Text that is not valid UTF-8 is printed in its UTF-8 reading, from
    // which a hit in its latin1 reading cannot be cut: withhold it.
    if (latin1 && (anyHit(latin1) || anyHit(latin1.replace(CONTROL_RE, '')))) return whole;
    return r;
  };
  const safeLine = (s) => redactDeny(scrubHome(String(s), home));
  return { redact, displayPath, safeLine, anyHit };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// The env every scan git command runs with: repo-locating variables
// stripped (cleanGitEnv), and replace refs and the graft file OFF. A push
// sends the real objects; with `git replace <bad> <good>` (or a graft) in
// effect, the scan would otherwise read <good> while <bad> is published.
export function scanGitEnv(env = process.env) {
  return { ...cleanGitEnv(env), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };
}

function makeGit(repo, env) {
  const childEnv = scanGitEnv(env);
  const run = (args, { input, buffer = false, maxBuffer = 512 * 1024 * 1024 } = {}) => {
    const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: repo,
      env: childEnv,
      input,
      maxBuffer,
      windowsHide: true,
      ...(buffer ? {} : { encoding: 'utf8' }),
    });
    if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.code || res.error.message}`);
    return res;
  };
  const git = (args, input) => run(args, { input });
  git.buf = (args, opts) => run(args, { ...opts, buffer: true });
  // `git ls-remote <target>`: { ok: true, shas: Set } or { ok: false, reason }.
  // Never throws, never prompts, and the reason never quotes git's output
  // (it can carry the URL, and a URL can carry a user name or a token).
  git.lsRemote = (target) => {
    const res = spawnSync('git', ['ls-remote', '--', target], {
      cwd: repo,
      env: { ...childEnv, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: LS_REMOTE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (res.error) {
      const code = res.error.code === 'ETIMEDOUT' ? `timed out after ${LS_REMOTE_TIMEOUT_MS / 1000} s` : 'could not start';
      return { ok: false, reason: code };
    }
    if (res.status !== 0) return { ok: false, reason: `exit ${res.status === null ? 'signal' : res.status}` };
    const shas = new Set();
    for (const line of String(res.stdout).split(/\r?\n/)) {
      const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t/.exec(line);
      if (m) shas.add(m[1]);
    }
    return { ok: true, shas };
  };
  return git;
}

function gitOk(git, args, input) {
  const res = git(args, input);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(res.stderr || '').trim()}`);
  return res.stdout;
}

function gitOkBuf(git, args, opts) {
  const res = git.buf(args, opts);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${String(res.stderr || '').trim()}`);
  return res.stdout;
}

const isZeroSha = (s) => /^0+$/.test(String(s || ''));
const isObjectId = (s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(s || ''));

// Each of `shas` that names a commit in this clone (a tag is peeled to its
// commit), as that commit's id; the rest are dropped.
function localCommits(git, shas) {
  const want = [...new Set(shas.filter(isObjectId))];
  if (want.length === 0) return [];
  const out = gitOk(git, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${want.map((s) => `${s}^{commit}`).join('\n')}\n`);
  const found = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) commit$/.exec(line.trim());
    if (m) found.add(m[1]);
  }
  return [...found];
}

// The commits already public on the push's destination, as commit ids:
//   - every remote tip git passed on stdin (`pushes[].remoteSha`): what the
//     destination has for each ref being pushed, as of this push;
//   - every ref under refs/remotes/<remote>/ — the remote this push goes to,
//     when it is a configured remote — whose commit the destination still
//     advertises (`git ls-remote <remoteUrl || remote>`). A stale tracking
//     ref (the branch was deleted or rewritten upstream) and a ref made by
//     hand do not count; neither does any other remote's ref.
// Returns { tips, tracking, stale, lsRemoteFailed }: `tracking` the number of
// the remote's tracking refs, `stale` how many of them were not advertised,
// `lsRemoteFailed` the reason ls-remote gave no answer (then no tracking
// ref counts), else null.
export function resolvePublicTips(git, { remote = null, remoteUrl = null, pushes = [], lsRemote } = {}) {
  const candidates = pushes.map((p) => p.remoteSha).filter((s) => isObjectId(s) && !isZeroSha(s));
  let tracking = 0;
  let stale = 0;
  let lsRemoteFailed = null;
  const names = remote ? gitOk(git, ['remote']).split(/\r?\n/).map((s) => s.trim()) : [];
  if (remote && names.includes(remote)) {
    const prefix = `refs/remotes/${remote}/`;
    const refs = gitOk(git, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/'])
      .split(/\r?\n/).map((l) => /^([0-9a-f]+) (.+)$/.exec(l)).filter((m) => m && m[2].startsWith(prefix));
    tracking = refs.length;
    if (tracking > 0) {
      const adv = (lsRemote || git.lsRemote)(remoteUrl || remote);
      if (!adv.ok) {
        lsRemoteFailed = adv.reason || 'no answer';
        stale = tracking;
      } else {
        for (const m of refs) {
          if (adv.shas.has(m[1])) candidates.push(m[1]);
          else stale += 1;
        }
      }
    }
  }
  return { tips: localCommits(git, candidates), tracking, stale, lsRemoteFailed };
}

// The commits a push of localSha publishes, oldest first: those reachable
// from localSha and not from remoteSha (when this clone has it) nor from any
// of `publicTips` (resolvePublicTips). Read through `rev-list --stdin`, so
// any number of tips fits.
export function listPushedCommits(git, { localSha, remoteSha }, publicTips = []) {
  if (isZeroSha(localSha)) return [];
  const exclude = new Set(publicTips);
  if (remoteSha && !isZeroSha(remoteSha)) for (const c of localCommits(git, [remoteSha])) exclude.add(c);
  const input = [localSha, ...[...exclude].map((t) => `^${t}`)].join('\n');
  return gitOk(git, ['rev-list', '--reverse', '--stdin'], `${input}\n`).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// The latin1 reading of `bytes` when they are not valid UTF-8, else null.
// Content lines, messages and paths are matched in their UTF-8 reading AND,
// when that reading loses bytes (invalid UTF-8 turns into U+FFFD), in their
// latin1 reading, which loses none. Valid UTF-8 is NOT also read as latin1:
// that reading is mojibake that invents word boundaries (French "annee" with
// an accented e, read as latin1, is "ann" + capital A-tilde + ..., which
// would make "ann" hit).
function latin1View(bytes) {
  const s = bytes.toString('latin1');
  if (!/[\x80-\xff]/.test(s)) return null;
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) ? null : s;
}

// A path as git stored it (raw bytes): `text` is its UTF-8 reading, `key` a
// lossless latin1 key, and `latin1` its latin1 reading when the bytes are not
// valid UTF-8 (so `text` does not show them all).
function pathObj(bytes) {
  return { text: bytes.toString('utf8'), key: bytes.toString('latin1'), latin1: latin1View(bytes) };
}

// A ref name (raw bytes as git gave them, or a string) as a path object.
export function refObj(ref) {
  return pathObj(Buffer.isBuffer(ref) ? ref : Buffer.from(String(ref ?? ''), 'utf8'));
}

// Parse `git diff-tree -r -z --raw` output: NUL-separated, so a path is
// taken byte-for-byte, never unquoted. Renames/copies carry two paths.
export function parseRawDiffZ(buf) {
  const parts = [];
  let start = 0;
  for (let i = buf.indexOf(0, start); i !== -1; i = buf.indexOf(0, start)) {
    parts.push(buf.subarray(start, i));
    start = i + 1;
  }
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const meta = parts[i++].toString('latin1');
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error('unexpected git diff-tree output');
    const [, srcMode, dstMode, srcOid, dstOid, status] = m;
    let src = null;
    if (status === 'R' || status === 'C') src = parts[i++];
    const dst = parts[i++];
    if (!dst) throw new Error('unexpected git diff-tree output');
    entries.push({ srcMode, dstMode, srcOid, dstOid, status, src: src ? pathObj(src) : null, dst: pathObj(dst) });
  }
  return entries;
}

// Split bytes into lines on LF, dropping one trailing CR per line.
export function splitLines(buf) {
  const out = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl === -1) nl = buf.length;
    let end = nl;
    if (end > start && buf[end - 1] === 13) end -= 1;
    out.push(buf.subarray(start, end));
    start = nl + 1;
  }
  return out;
}

// The lines of `newBuf` that appear in none of `oldBufs`, as
// { line (1-based in newBuf), buf, key }. Empty lines are dropped.
export function newLines(newBuf, oldBufs = []) {
  const old = new Set();
  for (const b of oldBufs) for (const l of splitLines(b)) old.add(l.toString('latin1'));
  const out = [];
  splitLines(newBuf).forEach((l, i) => {
    if (l.length === 0) return;
    const key = l.toString('latin1');
    if (!old.has(key)) out.push({ line: i + 1, buf: l, key });
  });
  return out;
}

// Map oid -> { type, size } for every oid; a missing object fails closed.
function batchCheck(git, oids) {
  const info = new Map();
  if (oids.length === 0) return info;
  const out = gitOk(git, ['cat-file', '--batch-check'], `${oids.join('\n')}\n`);
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [oid, type, size] = line.split(' ');
    if (type === 'missing' || size === undefined) throw new Error(`git object ${oid} is missing from this clone`);
    info.set(oid, { type, size: Number(size) });
  }
  return info;
}

// Map oid -> Buffer, fetched with `git cat-file --batch` in bounded batches.
function batchContents(git, oids, info) {
  const blobs = new Map();
  let i = 0;
  while (i < oids.length) {
    const group = [];
    let bytes = 0;
    while (i < oids.length && (group.length === 0 || bytes + info.get(oids[i]).size <= BATCH_BYTES)) {
      bytes += info.get(oids[i]).size;
      group.push(oids[i]);
      i += 1;
    }
    const out = gitOkBuf(git, ['cat-file', '--batch'], {
      input: `${group.join('\n')}\n`,
      maxBuffer: bytes + group.length * 128 + 1024 * 1024,
    });
    let pos = 0;
    for (const oid of group) {
      const nl = out.indexOf(10, pos);
      if (nl === -1) throw new Error('unexpected git cat-file output');
      const header = out.subarray(pos, nl).toString('latin1').split(' ');
      const size = Number(header[2]);
      if (header[1] === 'missing' || !Number.isFinite(size)) throw new Error(`git object ${oid} is missing from this clone`);
      blobs.set(oid, out.subarray(nl + 1, nl + 1 + size));
      pos = nl + 1 + size + 1;
    }
  }
  return blobs;
}

const GITLINK = '160000';

// Whether a zip holds an entry that is not stored as-is (deflated, or any
// other method): a local file header's method field is not 0.
function zipHasPackedEntry(buf) {
  for (let i = buf.indexOf('PK\x03\x04', 0, 'latin1'); i !== -1 && i + 10 <= buf.length; i = buf.indexOf('PK\x03\x04', i + 4, 'latin1')) {
    if (buf.readUInt16LE(i + 8) !== 0) return true;
  }
  return false;
}

// Whether a PNG has a zTXt chunk or an iTXt chunk whose text is compressed.
function pngHasPackedText(buf) {
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'zTXt') return true;
    if (type === 'iTXt') {
      const data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + len));
      const k = data.indexOf(0);
      if (k !== -1 && data[k + 1] === 1) return true;
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return false;
}

// PDF stream filters that turn text into bytes the scan cannot read
// (compression, and the ASCII85 / hex encodings), full and abbreviated names.
const PDF_FILTER_RE = /\/(?:FlateDecode|LZWDecode|RunLengthDecode|ASCII85Decode|ASCIIHexDecode|Fl|LZW|RL|A85|AHx)(?![A-Za-z0-9])/;

// The kind of compressed container `buf` is, keyed on its magic bytes, when
// its text cannot be read as it stands — else null. A zip whose entries are
// all stored, a PNG with only plain tEXt/iTXt text and a PDF without such
// filters are read as they are, so they are not reported.
export function compressedKind(buf) {
  const at = (bytes, off = 0) => buf.length >= off + bytes.length && bytes.every((b, i) => buf[off + i] === b);
  if (at([0x50, 0x4b, 0x03, 0x04])) return zipHasPackedEntry(buf) ? 'zip' : null;
  if (at([0x1f, 0x8b])) return 'gzip';
  if (at([0x42, 0x5a, 0x68]) && buf[3] >= 0x31 && buf[3] <= 0x39
    && (at([0x31, 0x41, 0x59, 0x26, 0x53, 0x59], 4) || at([0x17, 0x72, 0x45, 0x38, 0x50, 0x90], 4))) return 'bzip2';
  if (at([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (at([0x28, 0xb5, 0x2f, 0xfd])) return 'zstd';
  if (at([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return pngHasPackedText(buf) ? 'png' : null;
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return PDF_FILTER_RE.test(buf.toString('latin1')) ? 'pdf' : null;
  return null;
}

// Everything scanned in one commit:
//   { sha, parents, message, messageLatin1 (null unless not valid UTF-8),
//     files: [{ path, nameIsNew, binary, lines: [{ line, buf, key }], unscanned: null | { size },
//               compressed: null | kind (compressedKind) }] }
// `files` holds each path whose version differs from EVERY parent's (a root
// commit: from the empty tree), with only the lines new relative to all of
// them. nameIsNew: no parent has that path (it is added, or renamed to).
export function readCommit(git, sha, { maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const head = gitOkBuf(git, ['show', '-s', '--format=%P%x00%B', sha]);
  const nul = head.indexOf(0);
  if (nul === -1) throw new Error('unexpected git show output');
  const parents = head.subarray(0, nul).toString('latin1').trim().split(/\s+/).filter(Boolean);
  const message = head.subarray(nul + 1).toString('utf8');
  const messageLatin1 = latin1View(head.subarray(nul + 1));
  const bases = parents.length ? parents : [null];
  const maps = bases.map((p) => {
    const raw = gitOkBuf(git, ['diff-tree', '-r', '-z', '--raw', '-M', '--no-commit-id', ...(p ? [p, sha] : ['--root', sha])]);
    return new Map(parseRawDiffZ(raw).filter((e) => e.status !== 'D').map((e) => [e.dst.key, e]));
  });

  const files = [];
  for (const [key, first] of maps[0]) {
    const all = maps.map((m) => m.get(key));
    if (all.some((e) => !e)) continue; // identical to some parent: nothing new here
    files.push({
      path: first.dst,
      nameIsNew: all.every((e) => e.status === 'A' || e.status === 'R' || e.status === 'C'),
      newOid: first.dstOid,
      newMode: first.dstMode,
      oldOids: all.filter((e) => !isZeroSha(e.srcOid) && e.srcMode !== GITLINK).map((e) => e.srcOid),
      binary: false,
      lines: [],
      unscanned: null,
      compressed: null,
    });
  }

  const wanted = new Set();
  for (const f of files) {
    if (f.newMode === GITLINK) continue;
    wanted.add(f.newOid);
    for (const o of f.oldOids) wanted.add(o);
  }
  const info = batchCheck(git, [...wanted]);
  const fetch = [...wanted].filter((o) => info.get(o).type === 'blob' && info.get(o).size <= maxFileBytes);
  const blobs = batchContents(git, fetch, info);
  for (const f of files) {
    if (f.newMode === GITLINK) continue; // a submodule pointer: no content here
    const meta = info.get(f.newOid);
    if (meta.type !== 'blob') continue;
    if (meta.size > maxFileBytes) {
      f.unscanned = { size: meta.size };
      continue;
    }
    const buf = blobs.get(f.newOid);
    f.binary = buf.includes(0);
    f.compressed = compressedKind(buf);
    // An old version over the cap is not read: every line then counts as new.
    f.lines = newLines(buf, f.oldOids.map((o) => blobs.get(o)).filter(Boolean));
  }
  for (const f of files) {
    delete f.newOid;
    delete f.oldOids;
  }
  return { sha, parents, message, messageLatin1, files };
}

// ---------------------------------------------------------------------------
// Scanning one commit
// ---------------------------------------------------------------------------

// `bytes` read as UTF-16LE, decoded from a fresh, even-length copy. Node
// v24.21.0 corrupts its heap (0xC0000374) decoding some views as UTF-16LE
// when the view starts at an odd byte offset, has an odd length and runs to
// the end of its allocation — the shape `buf.subarray(1)` has. A copy
// starts at an aligned offset, so that shape never reaches the decoder.
export function utf16leOf(bytes) {
  return Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).toString('utf16le');
}

// The forms one content line is matched in: UTF-8 (and its textViews), latin1
// when it is not valid UTF-8, and UTF-16LE at both byte alignments when the
// file has NUL bytes (the odd alignment also reads UTF-16BE).
function lineViews(l, binary) {
  const utf8 = l.buf.toString('utf8');
  const views = textViews(utf8);
  const latin1 = latin1View(l.buf);
  if (latin1) views.push(latin1);
  if (binary) {
    views.push(utf16leOf(l.buf));
    if (l.buf.length > 1) views.push(utf16leOf(l.buf.subarray(1)));
  }
  return { utf8, views };
}

// Hits: { sha, where: 'diff'|'message'|'path', file?, line?, binary?, check, label }.
// `check` is 'leak-check' or 'private-names'; `label` is the leak-check class
// or "denylist line N". Nothing in a hit is text taken from the commit
// except `file`, a path object that formatHits() prints only through the
// redactor.
export function scanCommit(commit, { leakCtx = null, denylist = [], isRepoCommit = () => false } = {}) {
  const hits = [];
  const { sha } = commit;
  const derived = leakCtx?.derived || [];
  const realUsers = leakCtx?.realUsers;

  for (const f of commit.files) {
    if (f.lines.length === 0) continue;
    const rel = f.path.text;
    const decoded = f.lines.map((l) => lineViews(l, f.binary));
    const seen = new Set();
    const add = (i, check, label) => {
      const k = `${i}\0${check}\0${label}`;
      if (seen.has(k)) return;
      seen.add(k);
      hits.push({ sha, where: 'diff', file: f.path, line: f.lines[i].line, binary: f.binary, check, label });
    };
    if (leakCtx && !skipsAsBinary(rel)) {
      // The new lines as one text, so leak-check's line numbers map back
      // through f.lines[i].line to the real line of the new file.
      const text = decoded.map((d) => d.utf8).join('\n');
      for (const h of scanText(text, { ...scanOptionsForRel(rel), derived, realUsers }).hits) {
        add(h.line - 1, 'leak-check', h.label);
      }
    }
    decoded.forEach((d, i) => {
      for (const e of denylist) if (d.views.some((v) => e.test(v))) add(i, 'private-names', `denylist line ${e.lineNo}`);
    });
  }

  if (leakCtx) {
    for (const h of scanText(commit.message, { rel: '', derived, realUsers }).hits) {
      if (h.label === 'git-sha-like' && isRepoCommit(h.token)) continue;
      hits.push({ sha, where: 'message', line: h.line, check: 'leak-check', label: h.label });
    }
  }
  const msgSeen = new Set();
  for (const text of [commit.message, commit.messageLatin1]) {
    if (!text) continue;
    for (const m of matchDenylist(text, denylist)) {
      const k = `${m.line}\0${m.entryLine}`;
      if (msgSeen.has(k)) continue;
      msgSeen.add(k);
      hits.push({ sha, where: 'message', line: m.line, check: 'private-names', label: `denylist line ${m.entryLine}` });
    }
  }

  for (const f of commit.files) {
    if (!f.nameIsNew) continue;
    const views = [...textViews(f.path.text), ...(f.path.latin1 ? [f.path.latin1] : [])];
    if (leakCtx) {
      // A path is a name, not content: the SHA class is skipped here (a
      // fixture named after a hash is not a leak by itself, and a real SHA
      // inside the file is still caught by the content scan above).
      const labels = new Set();
      for (const v of views) for (const h of scanText(v, { rel: '', derived, realUsers, noSha: true }).hits) labels.add(h.label);
      for (const label of labels) hits.push({ sha, where: 'path', file: f.path, check: 'leak-check', label });
    }
    for (const e of denylist) {
      if (views.some((v) => e.test(v))) hits.push({ sha, where: 'path', file: f.path, check: 'private-names', label: `denylist line ${e.lineNo}` });
    }
  }
  return hits;
}

// Hits in the pushed ref names themselves: the remote ref (it is published)
// and the local one, each checked like a path — the denylist, and leak-check
// without its SHA class. { sha: the pushed sha, where: 'ref', side: 'remote
// ref' | 'local ref', file: the name as a path object, check, label }.
export function scanRefNames(pushes, { leakCtx = null, denylist = [] } = {}) {
  const hits = [];
  const derived = leakCtx?.derived || [];
  const realUsers = leakCtx?.realUsers;
  for (const p of pushes) {
    const seen = new Set();
    for (const [side, raw] of [['remote ref', p.remoteRefBytes ?? p.remoteRef], ['local ref', p.localRefBytes ?? p.localRef]]) {
      if (raw === undefined || raw === null || raw.length === 0) continue;
      const ref = refObj(raw);
      if (seen.has(ref.key)) continue; // the same name on both sides: one check
      seen.add(ref.key);
      const views = [...textViews(ref.text), ...(ref.latin1 ? textViews(ref.latin1) : [])];
      if (leakCtx) {
        const labels = new Set();
        for (const v of views) for (const h of scanText(v, { rel: '', derived, realUsers, noSha: true }).hits) labels.add(h.label);
        for (const label of labels) hits.push({ sha: p.localSha, where: 'ref', side, file: ref, check: 'leak-check', label });
      }
      for (const e of denylist) {
        if (views.some((v) => e.test(v))) hits.push({ sha: p.localSha, where: 'ref', side, file: ref, check: 'private-names', label: `denylist line ${e.lineNo}` });
      }
    }
  }
  return hits;
}

// Printable lines for a hit list. `showPath(file, whole)` turns a path object
// into the text printed for it (`whole` is the placeholder for one it
// cannot clean); the default withholds every path and ref name.
export function formatHits(hits, showPath = (file, whole = REDACTED_PATH) => whole) {
  const seen = new Set();
  const lines = [];
  for (const h of hits) {
    let where;
    if (h.where === 'message') where = `commit message:${h.line}`;
    else if (h.where === 'path') where = `path ${showPath(h.file)}`;
    else if (h.where === 'ref') where = `${h.side} ${showPath(h.file, REDACTED_REF)}`;
    else where = `${showPath(h.file)}:${h.line}${h.binary ? ' (binary)' : ''}`;
    const line = `  ${h.sha.slice(0, 12)}  ${where}  [${h.check}: ${h.label}]`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// The per-file size cap: the option, else PUSH_SCAN_MAX_FILE_BYTES when it is
// a positive integer, else DEFAULT_MAX_FILE_BYTES.
export function resolveMaxFileBytes(option, env = process.env) {
  if (Number.isInteger(option) && option > 0) return { value: option, warning: null };
  const raw = env.PUSH_SCAN_MAX_FILE_BYTES;
  if (raw === undefined || raw === '') return { value: DEFAULT_MAX_FILE_BYTES, warning: null };
  if (/^[1-9]\d*$/.test(String(raw).trim())) return { value: Number(String(raw).trim()), warning: null };
  return {
    value: DEFAULT_MAX_FILE_BYTES,
    warning: `push-scan: warning — ignoring PUSH_SCAN_MAX_FILE_BYTES (not a positive integer); using ${DEFAULT_MAX_FILE_BYTES}.`,
  };
}

// Scan what the given pushes publish: every pushed ref name, and every
// commit not already public on the destination. `pushes`: [{ localRef,
// localSha, remoteRef, remoteSha, localRefBytes?, remoteRefBytes? }] as git's
// pre-push stdin gives them (deleted refs are ignored), with `remote` and
// `remoteUrl` the hook's two arguments (the destination's name and URL); or
// pass `commits` to scan exactly those. Returns { status, hits, commits,
// warnings, unscanned, compressed, boundary, showRef } — `showRef(ref)` is a
// ref name as it is safe to print. Prints through `log`/`err` (default
// console), every line through the redactor. An internal error is rethrown
// with its message redacted the same way. `lsRemote(target)` replaces
// `git ls-remote` (tests).
export function runPushScan({
  repo = REPO_ROOT, pushes = [], commits = null, env = process.env,
  log = (m) => console.log(m), err = (m) => console.error(m), leakCtx,
  maxFileBytes, readDenylistFile, remote = null, remoteUrl = null, lsRemote,
} = {}) {
  const warnings = [];
  const display = denylistDisplayPath(env);
  const deny = loadDenylist(denylistPath(env), readDenylistFile ? { readFile: readDenylistFile } : {});
  let redactor = makeRedactor({ entries: deny.entries });
  const showRef = (ref) => redactor.displayPath(refObj(ref), REDACTED_REF);
  const say = (m) => log(redactor.safeLine(m));
  const shout = (m) => err(redactor.safeLine(m));
  const warn = (m) => {
    const s = redactor.safeLine(m);
    warnings.push(s);
    err(s);
  };
  const result = (status, extra = {}) => ({
    status, hits: [], commits: [], warnings, unscanned: [], compressed: [], boundary: null, showRef, ...extra,
  });

  if (deny.error) {
    shout(`push-scan: BLOCKED — the private-names denylist (${display}) exists but ${deny.error}. Its contents are not shown. Fix the file, then push again.`);
    return result(1);
  }
  if (deny.invalid.length) {
    shout(`push-scan: BLOCKED — private-names denylist line(s) ${deny.invalid.join(', ')} are not valid regexes, or match empty text (re: entries). Fix the file, then push again.`);
    return result(1);
  }
  if (deny.controls.length) {
    shout(`push-scan: BLOCKED — private-names denylist line(s) ${deny.controls.join(', ')} hold a control character (a TAB, or a line separator other than LF, CRLF, CR, U+2028 or U+2029), so they could never match. Fix the file, then push again.`);
    return result(1);
  }
  if (deny.missing) warn(`push-scan: warning — no private-names denylist at ${display}; scanning with leak-check only.`);
  else if (deny.entries.length === 0) warn(`push-scan: warning — the private-names denylist at ${display} has no entries; scanning with leak-check only.`);
  const cap = resolveMaxFileBytes(maxFileBytes, env);
  if (cap.warning) warn(cap.warning);

  const live = pushes.filter((p) => !isZeroSha(p.localSha));
  const malformed = live.findIndex((p) => !isObjectId(p.localSha) || !isObjectId(p.remoteSha));
  if (malformed !== -1) {
    shout(`push-scan: BLOCKED — pushed ref #${malformed + 1} is not in git's pre-push format (<local ref> <local sha> <remote ref> <remote sha>); nothing was scanned.`);
    return result(1);
  }

  try {
    const git = makeGit(repo, env);
    if (live.length === 0 && !(commits && commits.length)) {
      say('push-scan: no new commits to scan.');
      return result(0);
    }

    const ctx = leakCtx === undefined ? buildScanContext({ root: repo, quiet: true }, env) : leakCtx;
    if (ctx && ctx.error) {
      shout(`push-scan: BLOCKED — leak-check could not derive its names: ${ctx.error}`);
      return result(1);
    }
    redactor = makeRedactor({ entries: deny.entries, leakCtx: ctx });
    const hits = scanRefNames(live, { leakCtx: ctx, denylist: deny.entries });
    const refHitCount = hits.length;

    const shas = [];
    const seen = new Set();
    const add = (s) => { if (!seen.has(s)) { seen.add(s); shas.push(s); } };
    if (commits) commits.forEach(add);
    let boundary = null;
    if (live.length) {
      boundary = resolvePublicTips(git, { remote, remoteUrl, pushes: live, lsRemote });
      // Printed only below, when the remote has tracking refs — so `remote`
      // is then a configured remote NAME, never a URL (a URL can carry a
      // user name or a token). The URL itself is never printed.
      const where = remote ? redactor.displayPath(refObj(remote), '[redacted remote]') : 'the destination';
      if (boundary.lsRemoteFailed) {
        warn(`push-scan: warning — could not list what ${where} has now (git ls-remote: ${boundary.lsRemoteFailed}), so none of its ${boundary.tracking} remote-tracking ref(s) count as public: only the remote tips git reported for the refs being pushed do, and more history is scanned.`);
      } else if (boundary.stale) {
        say(`push-scan: note — ${boundary.stale} of ${boundary.tracking} remote-tracking ref(s) of ${where} do not match what it advertises now (deleted or rewritten upstream, or made by hand); commits only they reach are scanned too. \`git fetch --prune\` refreshes them.`);
      }
      for (const p of live) for (const s of listPushedCommits(git, p, boundary.tips)) add(s);
    }
    if (shas.length === 0 && hits.length === 0) {
      say(`push-scan: OK — no new commits to scan (everything pushed is already on the remote it is pushed to); ${live.length} pushed ref name(s) checked: no hits.`);
      return result(0, { boundary });
    }

    const repoCommitCache = new Map();
    const isRepoCommit = (tok) => {
      if (!repoCommitCache.has(tok)) {
        repoCommitCache.set(tok, git(['cat-file', '-e', `${tok}^{commit}`]).status === 0);
      }
      return repoCommitCache.get(tok);
    };

    const unscanned = [];
    const compressed = [];
    for (const sha of shas) {
      const c = readCommit(git, sha, { maxFileBytes: cap.value });
      for (const f of c.files) {
        if (f.unscanned) unscanned.push({ sha, file: f.path, size: f.unscanned.size });
        if (f.compressed) compressed.push({ sha, file: f.path, kind: f.compressed });
      }
      hits.push(...scanCommit(c, { leakCtx: ctx, denylist: deny.entries, isRepoCommit }));
    }

    for (const u of unscanned) {
      warn(`push-scan: warning — ${u.sha.slice(0, 12)}  ${redactor.displayPath(u.file)}  not scanned (size): ${u.size} bytes, over the ${cap.value}-byte cap. Its path was checked; check its content by hand before pushing.`);
    }
    for (const z of compressed) {
      warn(`push-scan: warning — ${z.sha.slice(0, 12)}  ${redactor.displayPath(z.file)}  compressed content not scanned (${z.kind}): only its raw bytes were checked; check what it holds by hand before pushing.`);
    }
    const notes = (unscanned.length ? ` ${unscanned.length} file(s) not scanned (size); see the warning(s) above.` : '')
      + (compressed.length ? ` ${compressed.length} file(s) with compressed content not scanned; see the warning(s) above.` : '');
    const extra = { commits: shas, unscanned, compressed, boundary };

    if (hits.length === 0) {
      say(`push-scan: OK — ${shas.length} commit(s) scanned (new content, message, new paths) and ${live.length} pushed ref name(s): no leak-check or private-names hits.${notes}`);
      return result(0, extra);
    }
    const lines = formatHits(hits, redactor.displayPath);
    const commitHits = hits.slice(refHitCount);
    const parts = [];
    if (commitHits.length) parts.push(`in ${new Set(commitHits.map((h) => h.sha)).size} of ${shas.length} commit(s)`);
    if (refHitCount) parts.push('in the pushed ref name(s)');
    shout(`push-scan: BLOCKED — ${lines.length} hit(s) ${parts.join(' and ')}. The matched text is never printed; inspect each commit with git show <sha>.${notes}`);
    for (const l of lines.slice(0, MAX_PRINTED_HITS)) shout(l);
    if (lines.length > MAX_PRINTED_HITS) shout(`  ... and ${lines.length - MAX_PRINTED_HITS} more.`);
    if (refHitCount) shout('A ref name is published with the push: push under another name (git push <remote> <local>:<new name>), then push again.');
    if (commitHits.length) shout('Rewrite those commits (e.g. an interactive rebase that edits them) so the text never enters history, then push again.');
    if (commitHits.length && boundary && boundary.lsRemoteFailed) {
      shout('The destination\'s refs could not be listed (see the warning above), so commits it may already have were scanned too. If every hit is in history that is already public, fix what stopped git ls-remote and push again.');
    }
    return result(1, { hits, ...extra });
  } catch (e) {
    throw new Error(redactor.safeLine(e && e.message ? e.message : String(e)));
  }
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/push-scan.mjs <rev-list args, e.g. origin/main..HEAD>');
    return argv.length === 0 ? 2 : 0;
  }
  const git = makeGit(REPO_ROOT, process.env);
  const res = git(['rev-list', '--reverse', ...argv]);
  if (res.status !== 0) {
    console.error(`push-scan: git rev-list failed: ${scrubHome((res.stderr || '').trim())}`);
    return 2;
  }
  const commits = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  try {
    return runPushScan({ commits }).status;
  } catch (e) {
    console.error(`push-scan: BLOCKED — the scan could not run: ${e.message}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
