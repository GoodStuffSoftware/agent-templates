#!/usr/bin/env node
// write-target-guard.mjs — PreToolUse hook on Write|Edit|MultiEdit|NotebookEdit.
//
// Keeps CODE writes out of protected checkouts: a repo's PRIMARY/deploy worktree
// (merges land there, code work does not) and its unnamed auto-worktrees (a
// claude/* branch under .claude/worktrees/* never reaches staging). Code work
// belongs in a deliberately-named sibling worktree. In the primary, docs, .claude
// config and markdown are exempt (in a claude/* auto-worktree the branch rule runs
// first and exemptions do not apply). A conscious exception is made when the written content
// carries `guard-ack: primary-worktree` or `guard-ack: cowork-worktree`.
//
// Lineage: the original (2026-07-07) hard-coded one project (my-project). This
// version (2026-10-03) is CONFIG-DRIVEN so it can ship in a public plugin with no
// project-specific paths: the rules come from ~/.claude/write-target-guard.config.json
// (see write-target-guard.config.example.json). There is deliberately NO
// environment-variable override of the config or of any rule (a bypass vector): the
// home directory is the OS account's (os.userInfo().homedir), never USERPROFILE/HOME.
//
// 2026-10-03 — branch-keyed worktree classification (carried over from the live
// hook). A worktree under <primary>\.claude\worktrees\<name> is judged by its
// CURRENT BRANCH, not its path: a named feat|fix|docs|chore|refactor|perf|test|
// build|ci|style|revert|wip branch is allowed; claude/* auto-worktrees, other
// non-matching names, main/master/staging, backup/*, detached HEAD and UNKNOWN
// (.git missing/garbled/unreadable) stay blocked. Branch-resolution failure falls
// back to DENY (never allow). The branch is read from <root>\.git (+ <gitdir>\HEAD)
// with no git process spawned; a mid-rebase detached HEAD recovers the branch from
// rebase-merge/head-name then rebase-apply/head-name. A branch name containing `..`
// is never allowed.
//
// 2026-10-03 (alias-hardening) — before any path check, the target is CANONICALISED
// so an alternate spelling cannot dodge the guard:
//   P1 device/UNC prefixes: \\?\ and \\.\ are stripped (\\?\C: -> C:); \\?\UNC\ and
//      \\.\UNC\ reduce to \\; admin-share UNC to a loopback or this host's name
//      (\\localhost\C$, \\127.0.0.1\C$, \\[::1]\C$, \\<hostname>\C$) maps back to the
//      drive. Forms that CANNOT be resolved to a drive-letter or UNC path —
//      \\?\Volume{GUID}\, \\.\GLOBALROOT\, raw devices — are DENIED, not guessed at
//      (fail-closed for these exotic forms: they never appear in a normal Write/Edit
//      and exist here only as a guard-bypass vector; this is NOT the outer fail-open).
//   P2 ADS + trailing dot/space: a trailing ::$DATA / :$DATA / :stream on the final
//      component is dropped, and trailing dots/spaces are stripped per segment
//      (Windows opens "App.vue. " and "src " as "App.vue"/"src"); the drive and the
//      . / .. navigation segments are preserved for normalisation.
//   P3 8.3 / junctions / symlinks / subst: after lexical normalisation the deepest
//      EXISTING ancestor is resolved with fs.realpathSync.native (verified on this box
//      to fold MYPROJ~1 -> my-project and to fold a junction), then the not-yet-created
//      tail is re-appended. A realpath FAILURE is NOT an unexpected error: it falls
//      back to the lexical path (it does not fail open).
// 2026-10-03: unresolvable UNC targets (any write) are denied, lexically and after realpath.
//   A UNC path P1 cannot fold to a local drive (\\localhost\Users\..., \\<ip>\C$\...,
//   \\fileserver\share\...) cannot be matched against the drive-path checkouts, so it is
//   refused for EVERY Write/Edit, code or not, before self-protection and the repo rules.
//   The same check runs on the realpath result: a mapped drive or a symlink to a share
//   comes back as \\server\share\... (or \\?\UNC\...). The admin-share forms P1 already
//   folds (\\localhost\C$ etc.) still become C:\... and get their normal decision.
// 2026-10-03: configured paths are canonicalised like targets; a missing primary warns.
//   Each configured primary, and the worktree prefix (primary + worktreeMark), runs through
//   the same P1/P2/P3 pipeline as a target, so an 8.3 (MYPROJ~1) or junction spelling in the
//   CONFIG still matches the long, realpath'd target (before, it never matched: allow). A
//   primary that does not exist on this machine (or is not a directory) is KEPT, still
//   guarded as written, and warned about LOUDLY on every call (stderr + systemMessage).
// 2026-10-03 (P5) — root config files (package.json, lockfile, build config, etc.,
//   from the config's rootCodeFiles) count as CODE when they sit directly at a checkout
//   root: the primary root, and — when rootCodeFilesAtWorktreeRoots is set — a worktree
//   root too (editing a worktree's build config is code work).
// 2026-10-03 (self-protection) — a Write/Edit to the guard's own config file is DENIED
//   unless the content carries `guard-ack: guard-config`. (A Write|Edit hook cannot stop
//   a Bash `rm` of the config; that gap is covered by the loud warning below and an
//   out-of-band backup audit, documented in the plugin README.)
// 2026-10-03 (loud fail-open) — if the config is MISSING or MALFORMED the guard fails
//   OPEN (Write/Edit proceed) but LOUD in EVERY deployment: it emits a top-level JSON
//   `systemMessage` (the channel the docs show on a non-blocking exit-0 result — plain
//   stdout/stderr reach only the debug log) plus a stderr line. There is deliberately NO
//   plugin-mode exemption: once this machine runs the guard as a plugin, CLAUDE_PLUGIN_ROOT
//   is set, and a MISSING config is precisely the case that must stay loud there (a deleted
//   config is the one off-switch we refuse to make silent). The ONLY path to a silent allow
//   is an EXPLICIT opt-out inside a VALID config: top-level `"enabled": false`, or an empty
//   `"repos": []`. Everything else (a real config with repos) enforces.
// 2026-10-03: malformed config entries are dropped loudly; valid entries stay enforced.
//   A wrong-typed element (codeDirs ["src", 1]), field (worktreeMark 5), primary (42, or a
//   relative path) or entry (repos [null, ...]) is dropped with one WARNING naming the field
//   (stderr + systemMessage), and every valid rule and entry is still enforced (before, a
//   non-string element threw and the outer catch allowed everything silently). Only when NO
//   usable repo entry remains does the guard take the loud fail-open above (INACTIVE).
// 2026-10-03: drive-relative and rooted-relative targets are denied; . and .. are never trimmed.
//   A drive-relative target (C:foo, C:..\x: a drive letter not followed by a separator)
//   resolves against that drive's current directory, and a rooted-relative one (\foo, /foo:
//   one leading separator, not UNC or device) against the current drive; the guard cannot
//   see either, so EVERY write to such a target is refused with a fully-qualified-path hint
//   (before, P2 trimmed "C:.." to "C:" and C:..\src\x.ts was judged as C:\src\x.ts: allow).
//   A plain relative path (src\x.ts) resolves against the hook PROCESS cwd (the P3 realpath
//   walk does this; decide() never reads the payload's cwd). That is a change from the
//   pre-alias hook, which prefix-compared the raw relative string and so never matched: a
//   relative src\x.ts with the hook cwd at the primary now DENIES where it used to allow.
//   P2 never trims a segment made only of dots and/or spaces (" ", ". .", ".. ", "..."):
//   every Windows writer keeps it as ONE literal segment, so a following ".." cancels it,
//   not the segment before it (before, <P>\src\. .\..\x.ts was judged as <P>\x.ts: allow).
// 2026-10-03: \??\ device prefix handled like \\?\.
//   The NT-namespace prefix \??\ (which a plain Win32 CreateFile passes straight through:
//   \??\<P>\src\x.ts opens <P>\src\x.ts) is stripped like \\?\, and \??\UNC\ reduces to \\
//   like \\?\UNC\ (a non-loopback share then gets the unresolvable-UNC deny).
// 2026-10-03: NotebookEdit and MultiEdit are guarded like Write/Edit.
//   NotebookEdit's target is tool_input.notebook_path (tool_input.file_path if absent) and
//   its written content is new_source; MultiEdit's target is tool_input.file_path and its
//   written content is every edits[].new_string (an ack in any one of them counts).
// 2026-10-03: exemptDirs, codeDirs and scriptDir are matched only BELOW the checkout root.
//   The directory names are taken from the path RELATIVE to the checkout the write belongs
//   to, never from the ancestors above it: below the primary root, or for a worktree below
//   the worktree mark (the worktree's own name still counts, as before: a non-worktree
//   <P>\.claude\worktrees\scripts\a.mjs is still code). Before, a primary checked out under
//   any folder named docs / .claude / .husky had EVERY code write exempted, and one under
//   src / e2e / scripts had every write (LICENSE, .gitignore) treated as code. Below the
//   root nothing changed: an exempt dir still exempts at any depth, under a code dir too
//   (<P>\src\docs\x.ts, <P>\src\.claude\x.ts), which the pre-alias hook's own test requires.
// 2026-10-03: the config path ignores USERPROFILE/HOME.
//   The default is <os.userInfo().homedir>\.claude\write-target-guard.config.json: the OS
//   account record, not os.homedir(), which honours USERPROFILE (Windows) / HOME, so an
//   env var in the hook's environment could point the guard at a disabled config and
//   silently turn it off. The only override is a `--config <absolute path>` argument in
//   the hook's OWN registration (hooks.json / settings.json), which already decides whether
//   the hook runs at all; it is the test seam. A --config with no value or a relative path
//   is a broken registration: loud INACTIVE, like a malformed config. A home directory the
//   OS cannot report is the same loud INACTIVE.
// 2026-10-03: the INACTIVE stderr lines name Write, Edit, MultiEdit and NotebookEdit, like
//   the systemMessages beside them.
// 2026-10-03: a target longer than 32,767 characters is denied, and no step is quadratic.
//   32,767 is the Windows path maximum, so no real file has a longer path; a longer
//   file_path / notebook_path is refused before any other work. Below the cap every step on
//   the target is linear: P2's trailing dot/space trim is a plain loop (the old /[ .]+$/
//   backtracked quadratically on a long dot/space run NOT at the end: a 250 KB run ran past
//   the 15 s hook timeout, a non-blocking timeout, so the write went through unguarded).
// 2026-10-03: a target containing a control character (NUL or any of 0x01-0x1F) is denied
//   as an invalid path. No Windows file name holds one; a NUL made the guard judge the text
//   after it (<P>\src\x.ts\0.md was allowed as markdown) where a native writer stops at it.
// 2026-10-03: a --config given more than once is a broken registration: loud INACTIVE, like
//   a malformed config (before, the first value won silently).
// 2026-10-03: the P3 realpath walk is bounded. The first 64 probes walk up from the target,
//   exactly as before. Past that, a binary search finds the deepest depth that is not "not
//   found" (ENOENT/ENOTDIR: nothing below a missing or non-directory component exists), then
//   walks up to the first realpath success as before, so the result is the same deepest
//   existing ancestor; a 16k-segment tail at the 32,767-character maximum went from 16k
//   probes (3.8 s) to about 80. That walk up is itself capped at 64 probes (only a planted
//   chain such as a symlink loop, failing ELOOP at every depth, gets that far).
// 2026-10-03: past that cap, the walk no longer drops to the bare lexical path. It gallops
//   up and binary-searches for the deepest ancestor that resolves, and re-appends the rest.
//   The bare lexical path kept every alias ABOVE the loop unfolded: on a CI runner whose
//   temp dir is spelled with an 8.3 name (<user>~1), a 32,767-character target under a
//   junction loop in the primary did not match the primary's realpath'd root, so the write
//   was ALLOWED. A junction or subst alias of the checkout did the same on any machine.
// 2026-10-03: every file the hook reads is read through a size bound (open, fstat, a capped
//   read; never readFileSync): 4 KB for the .git file, HEAD and rebase head-name, 64 KiB for
//   the config. The gitdir: line is parsed in one linear pass with the same result as the
//   old /^gitdir:\s*(.+?)\s*$/m, which backtracked for 2.4 s on a planted 50 KB whitespace
//   run (a timed-out guard lets the write through). An oversized or non-regular .git, HEAD
//   or head-name is a branch-resolution failure (unknown, so DENY); an oversized config is
//   a malformed config (loud INACTIVE). `--config=<path>` is the same single occurrence as
//   `--config <path>`, and the two forms are counted together.
//
// The decision logic is the exported pure function decide(); main (stdin/stdout) runs
// when argv[1]'s BASENAME is write-target-guard.mjs — not a full-path compare, because
// Node realpaths the entry module and a junction/symlink/\\?\ launch would otherwise
// silently skip main (= allow everything). Importers (the .test.mjs) do not match.

import { statSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALLOW = { decision: 'allow' };

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ackRe = (ack) => new RegExp('guard-ack:\\s*' + escapeRegex(ack), 'i');

const CONFIG_NAME = 'write-target-guard.config.json';
// An absolute path: drive-rooted, UNC, or \??\ (the same test the configured primary gets).
const ABS_PATH_RE = /^([a-z]:[\\/]|[\\/]{2}|[\\/]\?\?[\\/])/i;

// The default config path, from the OS account record. NOT os.homedir(): that honours
// USERPROFILE (Windows) / HOME, so an environment variable could relocate the trust anchor.
// Throws if the OS cannot report the account's home directory.
function defaultConfigPath() {
  return path.win32.join(os.userInfo().homedir, '.claude', CONFIG_NAME);
}
const safeDefaultConfigPath = () => { try { return defaultConfigPath(); } catch { return null; } };

// The config path the hook process was registered with: `--config <absolute path>` in its
// own argv (hooks.json / settings.json), else null for the default. Never the environment.
// A --config given more than once, with no value or with a relative value is a broken
// registration: { error }. (Never "the first one wins": that would be a silent choice.)
// `--config=<path>` is the same occurrence as `--config <path>`; both forms count together.
function configPathFromArgv(argv) {
  const EQ = '--config=';
  const at = [];
  for (let k = 2; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--config' || (typeof a === 'string' && a.startsWith(EQ))) at.push(k);
  }
  if (at.length === 0) return { path: null };
  if (at.length > 1) {
    return { error: `--config was given ${at.length} times; give it exactly once, with the absolute path to the config file` };
  }
  const i = at[0];
  const v = argv[i] === '--config' ? argv[i + 1] : argv[i].slice(EQ.length);
  if (typeof v !== 'string' || !ABS_PATH_RE.test(v.trim())) {
    return { error: `--config needs an absolute path to the config file (got ${v === undefined ? 'nothing' : JSON.stringify(v)})` };
  }
  return { path: v.trim() };
}

// Bounded file reads. A planted multi-megabyte .git or HEAD must not make the hook outrun
// its (non-blocking) timeout, so nothing is read whole: open, fstat (a non-regular file
// throws before any read), then read at most max + 1 bytes, so a file that grows after the
// fstat is still caught. Over `max` bytes throws an error with code WTG_TOO_BIG.
const SMALL_FILE_MAX = 4096; // the .git file, HEAD, rebase head-name
const CONFIG_MAX = 64 * 1024; // a real config is ~1-2 KB; 64 KiB of tiny repo entries runs ~1.3 s, 1 MiB ~17 s
const WTG_TOO_BIG = 'WTG_TOO_BIG';
function readBounded(p, max) {
  const fd = openSync(p, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`not a regular file: ${p}`), { code: 'WTG_NOT_FILE' });
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > max) throw Object.assign(new Error(`larger than ${max} bytes: ${p}`), { code: WTG_TOO_BIG });
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

const _cfgCache = new Map();
// Load the config at `p` (the default path when p is null/undefined), cached per path.
function loadConfig(p) {
  if (p == null) {
    try {
      p = defaultConfigPath();
    } catch (e) {
      return { status: 'malformed', error: `the OS did not report this account's home directory (${e && e.message})`, path: path.win32.join('<home>', '.claude', CONFIG_NAME) };
    }
  }
  if (!_cfgCache.has(p)) _cfgCache.set(p, readConfig(p));
  return _cfgCache.get(p);
}
function readConfig(p) {
  try {
    const raw = readBounded(p, CONFIG_MAX).replace(/^\uFEFF/, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { status: 'malformed', error: e.message, path: p };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repos)) {
      return { status: 'malformed', error: 'config has no "repos" array', path: p };
    }
    // Explicit, VALID opt-out — the only route to a silent allow.
    if (parsed.enabled === false || parsed.repos.length === 0) {
      return { status: 'disabled', config: parsed, path: p };
    }
    return { status: 'ok', config: parsed, path: p };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'missing', path: p };
    if (e && e.code === WTG_TOO_BIG) return { status: 'malformed', error: `the config file is larger than ${CONFIG_MAX} bytes`, path: p };
    return { status: 'malformed', error: e.message, path: p };
  }
}

function getHostnames() {
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  try { set.add(os.hostname().toLowerCase()); } catch { /* ignore */ }
  return set;
}

// A device prefix: \\?\ , \\.\ or the NT-namespace \??\ (after / -> \ folding).
const DEVICE_PREFIX = /^(?:\\\\[?.]\\|\\\?\?\\)/;

// Drop a trailing run of dots and spaces (Windows opens "App.vue. " as "App.vue"). A plain
// loop, linear in the segment: the regex /[ .]+$/ is not start-anchored, so on a long
// dot/space run followed by any other character it retries from every position (quadratic).
function trimDotsSpaces(seg) {
  let e = seg.length;
  while (e > 0) {
    const c = seg.charCodeAt(e - 1);
    if (c !== 0x20 && c !== 0x2e) break;
    e--;
  }
  return e === seg.length ? seg : seg.slice(0, e);
}

// Canonicalise a raw file_path to a comparable lowercased backslash path, folding the
// alias families above. Returns { norm }, { unresolvable: true } for device/volume
// namespaces that cannot be mapped to a file path, or { relative: true } for a
// drive-relative (C:foo) or rooted-relative (\foo) path.
function canonicalize(raw, hostnames) {
  let s = String(raw).replace(/\//g, '\\').toLowerCase();

  // P1: \\?\UNC\server\share, \\.\UNC\server\share and \??\UNC\server\share -> \\server\share
  s = s.replace(/^(?:\\\\[?.]\\|\\\?\?\\)unc\\/, '\\\\');
  // P1: strip a \\?\, \\.\ or \??\ device prefix (\\?\C:\x -> C:\x)
  let deviceStripped = false;
  if (DEVICE_PREFIX.test(s)) {
    s = s.replace(DEVICE_PREFIX, '');
    deviceStripped = true;
  }
  // P1: forms that cannot be resolved to a drive/UNC path -> refuse to guess.
  if (/^(globalroot|volume\{|physicaldrive|harddiskvolume)/.test(s) || DEVICE_PREFIX.test(s)) {
    return { unresolvable: true };
  }
  if (deviceStripped && !/^[a-z]:/.test(s) && !/^\\\\/.test(s)) {
    return { unresolvable: true };
  }
  // Drive-relative (C:foo, C:..\x, a bare C:) or rooted-relative (\foo: one leading
  // separator, not UNC): resolved against a per-drive current directory the guard cannot see.
  if (/^[a-z]:(?!\\)/.test(s) || /^\\(?!\\)/.test(s)) {
    return { relative: true };
  }

  // P1: admin-share UNC to a loopback / this host -> drive letter.
  const uncAdmin = /^\\\\([^\\]+)\\([a-z])\$(\\.*)?$/.exec(s);
  if (uncAdmin && hostnames.has(uncAdmin[1])) {
    s = uncAdmin[2] + ':' + (uncAdmin[3] || '\\');
  }

  // P2: drop an ADS stream from the final component, then trailing dots/spaces per segment.
  const parts = s.split('\\');
  let lastIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) { if (parts[i] !== '') { lastIdx = i; break; } }
  if (lastIdx > 0 && parts[lastIdx].includes(':')) {
    parts[lastIdx] = parts[lastIdx].slice(0, parts[lastIdx].indexOf(':'));
  }
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    // Keep empties, the drive, and every segment made only of dots and/or spaces: . and ..
    // navigate, and " ", ". .", ".. ", "..." are ONE literal segment to every Windows writer
    // (a following .. cancels it), so trimming one to "" would cancel the segment before it.
    if (seg === '' || seg.endsWith(':')) continue;
    const trimmed = trimDotsSpaces(seg);
    if (trimmed !== '') parts[i] = trimmed;
  }
  s = parts.join('\\');

  // collapse . / .. / doubled separators
  s = path.win32.normalize(s);
  return { norm: s };
}

// P3: realpath the deepest existing ancestor, re-append the not-yet-created tail.
// A realpath failure falls back to the lexical path (it does not fail open).
// Bounded: the first REALPATH_BOTTOM_UP probes walk up from the path itself, exactly as
// before (a real write's not-yet-created tail is a few segments). Past that, deepTailAncestor
// finds the same ancestor in a few probes, not 16k probes of up to 32,767 characters each.
const REALPATH_BOTTOM_UP = 64;
function realpathAncestor(norm, realpathFn = realpathSync.native) {
  try {
    let cur = norm;
    const tail = [];
    for (let probes = 0; probes < REALPATH_BOTTOM_UP; probes++) {
      try {
        const real = realpathFn(cur).toLowerCase();
        return tail.length ? path.win32.join(real, ...tail) : real;
      } catch {
        const parent = path.win32.dirname(cur);
        if (parent === cur) return norm; // reached the root, nothing existed
        tail.unshift(path.win32.basename(cur));
        cur = parent;
      }
    }
    return deepTailAncestor(cur, tail, norm, realpathFn);
  } catch {
    return norm;
  }
}

// The rest of realpathAncestor's walk, for a tail deeper than REALPATH_BOTTOM_UP: `cur` and
// its ancestors (none probed yet; every deeper path failed), with `tail` already split off
// below cur. Depth 0 is the top of the chain (the drive root, or '.' for a relative path:
// where the bottom-up walk also ends); depth segs.length is cur.
//
// A realpath that fails "not found" (ENOENT or ENOTDIR, or a throw with no code at all, which
// no real fs error is) fails the same way at every deeper path: the lookup walks the
// components in order. So a binary search finds the deepest depth that is not "not found"
// (it exists, or it failed some other way, such as EPERM on a protected directory whose
// children still resolve); nothing deeper can realpath. From there the walk goes up exactly
// as the bottom-up walk does, to the first realpath success: the same ancestor, in
// O(log depth) probes. That walk up stops after REALPATH_BOTTOM_UP probes: only a planted
// structure (a symlink loop, say, which fails ELOOP at every depth below it) gets that far,
// and probing all of it would run past the hook's time limit, which fails open. From there a
// gallop and a binary search find the deepest ancestor above that structure that resolves,
// so an alias above it still folds; the lexical path is used only when nothing resolves.
function deepTailAncestor(cur, tail, norm, realpathFn) {
  const root = path.win32.parse(cur).root; // 'c:\' for a drive path, '' for a relative one
  const rest = cur.slice(root.length);
  const segs = rest ? rest.split('\\') : [];
  const prefixAt = (d) => (d === 0 ? (root || '.') : root + segs.slice(0, d).join('\\'));
  const seen = new Map(); // depth -> { real } on success, { notFound } on failure
  const probe = (d) => {
    if (!seen.has(d)) {
      try {
        seen.set(d, { real: realpathFn(prefixAt(d)).toLowerCase() });
      } catch (e) {
        const code = e && e.code;
        seen.set(d, { notFound: !code || code === 'ENOENT' || code === 'ENOTDIR' });
      }
    }
    return seen.get(d);
  };
  let lo = 0; // the floor; every depth above hi is "not found"
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1; // >= 1, so depth 0 is never needed to pass
    if (probe(mid).notFound) hi = mid - 1;
    else lo = mid;
  }
  const resolvedAt = (d) => {
    const below = segs.slice(d).concat(tail);
    return below.length ? path.win32.join(probe(d).real, ...below) : probe(d).real;
  };
  let d = lo;
  for (let n = 0; d >= 0 && n < REALPATH_BOTTOM_UP; d--, n++) {
    if (probe(d).real !== undefined) return resolvedAt(d);
  }
  // Past the walk-up bound: depths lo..d+1 all failed in some way other than "not found",
  // a planted chain such as a junction loop, which fails at every depth below it (ELOOP
  // here; whatever code a runner returns, it is the same failure). The lexical path alone
  // is not enough: an alias ABOVE that chain (an 8.3 short name in the temp or profile
  // dir, a junction or subst drive into the checkout) never folds, so a target inside a
  // primary does not match the primary's realpath'd root, and the write was allowed. So
  // the deepest ancestor that DOES resolve is found: gallop up (1, 2, 4 ... levels) to a
  // success, then binary-search the boundary. Such a failure fails the same way at every
  // deeper path, so this is the bottom-up walk's answer in O(log depth) probes. Only when
  // nothing resolves at all (not even the top of the chain) is the lexical path used.
  let bad = d + 1; // the shallowest depth known to fail
  let good = -1; // a depth known to resolve
  for (let step = 1; bad > 0; step *= 2) {
    const up = Math.max(0, bad - step);
    if (probe(up).real !== undefined) { good = up; break; }
    bad = up;
  }
  if (good < 0) return norm; // nothing resolved
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    if (probe(mid).real !== undefined) good = mid;
    else bad = mid;
  }
  return resolvedAt(good);
}

const isUnc = (p) => p.startsWith('\\\\');

const DEVICE_DENY = {
  decision: 'deny',
  reason:
    'WRONG WRITE TARGET: the path uses a Windows device or volume namespace ' +
    '(\\\\.\\ , \\\\?\\Volume{...}, GLOBALROOT, or a raw device) that this guard will not resolve ' +
    'to a file path — refusing to guess. Use a normal drive-letter path (C:\\...).',
};

const relativeDeny = (raw) => ({
  decision: 'deny',
  reason:
    `WRONG WRITE TARGET: ${raw} is a drive-relative (C:foo) or rooted-relative (\\foo) path. ` +
    'Windows resolves it against a per-drive current directory that this guard cannot see, so it ' +
    'cannot tell which checkout the write would land in. Every write to such a target is refused. ' +
    'Use a fully qualified path (C:\\...) instead.',
});

const uncDeny = (raw, resolved) => ({
  decision: 'deny',
  reason:
    `WRONG WRITE TARGET: ${raw} ` +
    (resolved ? `resolves to the network (UNC) path ${resolved}` : 'is a network (UNC) path') +
    ' that this guard cannot map to a local drive path, so it cannot tell which checkout the write ' +
    'would land in. Every write to such a target is refused. Use the local drive path (C:\\...) instead.',
});

// The one P1/P2/P3 pipeline, shared by targets and configured paths: canonicalise, then
// realpath the deepest existing ancestor. Returns { norm } (a lowercased local drive path),
// { device: true } (a namespace P1 refuses to resolve), { relative: true } (drive-relative
// or rooted-relative), or { unc: true, norm, resolved? } (a UNC path P1 cannot fold to a
// drive, lexically or after realpath: a mapped drive or a symlink to a share comes back as
// one; `resolved` is set in that after-realpath case).
function resolvePath(raw, realpathFn = realpathSync.native) {
  const hostnames = getHostnames();
  const canon = canonicalize(raw, hostnames);
  if (canon.unresolvable) return { device: true };
  if (canon.relative) return { relative: true };
  if (isUnc(canon.norm)) return { unc: true, norm: canon.norm };
  let norm = realpathAncestor(canon.norm, realpathFn);
  if (isUnc(norm)) {
    // Re-apply the P1 fold: a recognised loopback admin share returns to a drive path.
    const again = canonicalize(norm, hostnames);
    if (again.unresolvable || again.relative) return { device: true };
    if (isUnc(again.norm)) return { unc: true, norm, resolved: norm };
    norm = realpathAncestor(again.norm, realpathFn);
    if (isUnc(norm)) return { unc: true, norm, resolved: norm };
  }
  return { norm };
}

// The Windows path maximum (UTF-16 code units, which is what String length counts).
const MAX_PATH_CHARS = 32767;

const longPathDeny = (len) => ({
  decision: 'deny',
  reason:
    `WRONG WRITE TARGET: the path is ${len} characters long, more than the Windows maximum of ` +
    `${MAX_PATH_CHARS}. No real file has such a path, so this guard refuses it rather than ` +
    'spend its time limit judging it. Use the real, fully qualified path (C:\\...).',
});

const CONTROL_CHAR_DENY = {
  decision: 'deny',
  reason:
    'WRONG WRITE TARGET: the path contains a control character (NUL or another character ' +
    'below 0x20), which no Windows file name can hold. It is an invalid path, so this guard ' +
    'refuses it rather than guess which file a writer would open. Use the real, fully qualified path (C:\\...).',
};

// Resolve a raw file_path for the checks. Returns { norm } (a lowercased local drive path)
// or { deny } (the decision to return). A path longer than the Windows maximum, or holding
// a control character, is denied first, before any other work. A drive-relative or
// rooted-relative path is denied. A UNC path P1 cannot fold to a drive is denied twice over:
// lexically, and again when realpath (a mapped drive, a symlink to a share) lands on one.
// realpathFn is the test seam; the hook always uses the default.
export function resolveTarget(rawPath, realpathFn = realpathSync.native) {
  const raw = String(rawPath);
  if (raw.length > MAX_PATH_CHARS) return { deny: longPathDeny(raw.length) };
  if (/[\x00-\x1f]/.test(raw)) return { deny: CONTROL_CHAR_DENY };
  const r = resolvePath(raw, realpathFn);
  if (r.device) return { deny: DEVICE_DENY };
  if (r.relative) return { deny: relativeDeny(rawPath) };
  if (r.unc) return { deny: uncDeny(rawPath, r.resolved) };
  return { norm: r.norm };
}

// The value of a .git file's gitdir: line, in one linear pass. Same result as the old
// /^gitdir:\s*(.+?)\s*$/m (m[1], or null for no match), which backtracked quadratically on
// a long whitespace run. Only the FIRST `gitdir:` at the start of a line can matter: a later
// one would follow a non-whitespace character, and then the first already matched.
const isLineTerm = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
function parseGitdirLine(text) {
  const KEY = 'gitdir:';
  let at = text.indexOf(KEY);
  while (at > 0 && !isLineTerm(text[at - 1])) at = text.indexOf(KEY, at + 1);
  if (at < 0) return null;
  const rest = text.slice(at + KEY.length);
  // \s and trim() strip the same characters, line terminators included, as the old \s* did.
  const t = rest.trimStart();
  if (t) {
    let end = 0;
    while (end < t.length && !isLineTerm(t[end])) end++;
    return t.slice(0, end).trimEnd();
  }
  // Only whitespace is left: the old regex backtracked to capture the last character that is
  // not a line terminator (a lone space or tab), or found no match at all.
  for (let k = rest.length - 1; k >= 0; k--) if (!isLineTerm(rest[k])) return rest[k];
  return null;
}

// Resolve a worktree root's current branch without spawning git.
// Returns { kind:'branch', name, rebase? } | { kind:'detached' } | { kind:'unknown' }.
// Every read is bounded: an oversized .git, HEAD or head-name is unknown (DENY), never slow.
function resolveBranch(root) {
  try {
    const dotGit = path.win32.join(root, '.git');
    let gitdir;
    if (statSync(dotGit).isDirectory()) {
      gitdir = dotGit;
    } else {
      const g = parseGitdirLine(readBounded(dotGit, SMALL_FILE_MAX).replace(/^\uFEFF/, ''));
      if (g == null) return { kind: 'unknown' };
      gitdir = path.win32.resolve(root, g); // handles absolute and root-relative gitdir
    }
    const head = readBounded(path.win32.join(gitdir, 'HEAD'), SMALL_FILE_MAX).replace(/^\uFEFF/, '').trim();
    if (!head) return { kind: 'unknown' };
    const r = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (r) return { kind: 'branch', name: r[1].trim() };
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      let hn;
      try {
        hn = readBounded(path.win32.join(gitdir, dir, 'head-name'), SMALL_FILE_MAX).replace(/^\uFEFF/, '').trim();
      } catch (e) {
        if (e && e.code === WTG_TOO_BIG) return { kind: 'unknown' };
        continue;
      }
      const h = /^refs\/heads\/(.+)$/.exec(hn);
      if (h) return { kind: 'branch', name: h[1].trim(), rebase: true };
    }
    return { kind: 'detached' };
  } catch {
    return { kind: 'unknown' };
  }
}

const wtMarkNorm = (m) => String(m == null ? '.claude\\worktrees\\' : m).replace(/\//g, '\\').toLowerCase();
const withSlash = (p) => (p.endsWith('\\') ? p : p + '\\');
// Drop trailing separators before resolving (C:\ stays C:\, never the drive-relative C:).
// A loop, not /[\\/]+$/ (quadratic on a long separator run that is not at the end).
const trimSep = (p) => {
  let e = p.length;
  while (e > 0 && (p[e - 1] === '\\' || p[e - 1] === '/')) e--;
  const t = p.slice(0, e);
  return /^[a-z]:$/i.test(t) ? t + '\\' : t;
};
const showVal = (v) => {
  let s;
  try { s = JSON.stringify(v); } catch { /* fall through */ }
  if (s === undefined) s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
};

// Per-entry config fields by expected shape. Only `undefined` counts as absent; anything
// else of the wrong shape is dropped with a warning naming the field (the default applies).
const LIST_FIELDS = ['allowedBranchPrefixes', 'codeDirs', 'scriptExts', 'rootCodeFiles', 'exemptDirs', 'exemptExts'];
const STRING_FIELDS = ['worktreeMark', 'scriptDir', 'coworkAck', 'primaryAck'];
const BOOL_FIELDS = ['rootCodeFilesAtWorktreeRoots'];
const HINT_FIELDS = ['primaryLabel', 'siblingSlug', 'worktreeAddExample'];
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

// Validate and canonicalise the configured repos ONCE per call. Returns
// { repos: [{ cfg, prim, wtPrefix, wtMark }], warnings: [string] }: `cfg` is the entry with
// every invalid element/field dropped; `prim` and `wtPrefix` are lowercased canonical
// prefixes with a trailing backslash, resolved with the SAME pipeline as a target (P1/P2/P3)
// so an 8.3 or junction spelling in the config still matches. Never throws on any JSON
// shape; an entry that cannot be used is dropped with a warning, never silently.
function prepareRepos(rawRepos, realpathFn = realpathSync.native) {
  const repos = [];
  const warnings = [];
  if (!Array.isArray(rawRepos)) return { repos, warnings: ['"repos" is not an array'] };
  rawRepos.forEach((entry, i) => {
    const at = `repos[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${at} is not an object (got ${showVal(entry)}): entry dropped`);
      return;
    }
    const cfg = { ...entry };
    for (const f of LIST_FIELDS) {
      if (cfg[f] === undefined) continue;
      if (!Array.isArray(cfg[f])) {
        warnings.push(`${at}.${f} must be a list of non-empty strings (got ${showVal(cfg[f])}): the field is dropped and its default applies`);
        delete cfg[f];
        continue;
      }
      const bad = cfg[f].filter((x) => !isNonEmptyStr(x));
      if (bad.length) {
        warnings.push(`${at}.${f}: dropped ${bad.length} invalid element(s) ${showVal(bad)} (each must be a non-empty string); the valid ones are still enforced`);
        cfg[f] = cfg[f].filter(isNonEmptyStr);
      }
    }
    for (const f of STRING_FIELDS) {
      if (cfg[f] !== undefined && !isNonEmptyStr(cfg[f])) {
        warnings.push(`${at}.${f} must be a non-empty string (got ${showVal(cfg[f])}): the field is dropped and its default applies`);
        delete cfg[f];
      }
    }
    for (const f of BOOL_FIELDS) {
      if (cfg[f] !== undefined && typeof cfg[f] !== 'boolean') {
        warnings.push(`${at}.${f} must be true or false (got ${showVal(cfg[f])}): the field is dropped and its default applies`);
        delete cfg[f];
      }
    }
    if (cfg.hints !== undefined) {
      if (!cfg.hints || typeof cfg.hints !== 'object' || Array.isArray(cfg.hints)) {
        warnings.push(`${at}.hints must be an object (got ${showVal(cfg.hints)}): the field is dropped`);
        delete cfg.hints;
      } else {
        const hints = { ...cfg.hints };
        for (const h of HINT_FIELDS) {
          if (hints[h] !== undefined && typeof hints[h] !== 'string') {
            warnings.push(`${at}.hints.${h} must be a string (got ${showVal(hints[h])}): the field is dropped`);
            delete hints[h];
          }
        }
        cfg.hints = hints;
      }
    }

    // The primary: a non-empty ABSOLUTE path (a relative one would resolve against the
    // hook's cwd), canonicalised like a target.
    const rawPrim = cfg.primary;
    if (!isNonEmptyStr(rawPrim) || !ABS_PATH_RE.test(rawPrim.trim())) {
      warnings.push(`${at}.primary must be a non-empty absolute path string (got ${showVal(rawPrim)}): entry dropped`);
      return;
    }
    const rp = resolvePath(trimSep(rawPrim.trim()), realpathFn);
    if (rp.device) {
      warnings.push(`${at}.primary ${rawPrim} uses a device or volume namespace this guard will not resolve: entry dropped`);
      return;
    }
    if (rp.relative) { // \\?\C:foo or \??\C:foo: absolute-looking, drive-relative underneath
      warnings.push(`${at}.primary must be a non-empty absolute path string (got ${showVal(rawPrim)}): entry dropped`);
      return;
    }
    const prim = withSlash(rp.norm);
    if (!rp.unc) {
      let isDir = false;
      try { isDir = statSync(rp.norm).isDirectory(); } catch { /* missing or unreadable */ }
      if (!isDir) {
        warnings.push(`${at}.primary ${rawPrim} does not exist (or is not a directory) on this machine: check the path; writes under it are still guarded as written`);
      }
    }
    const wtMark = wtMarkNorm(cfg.worktreeMark);
    const rw = resolvePath(trimSep(prim + wtMark), realpathFn);
    const wtPrefix = (rw.device || !rw.norm) ? prim + wtMark : withSlash(rw.norm);
    repos.push({ cfg, prim, wtPrefix, wtMark });
  });
  return { repos, warnings };
}

// Is the canonical path directly under `root` (no trailing backslash on root) with a
// basename in `names`? Used for P5 root-code-file classification.
function directChildIn(norm, root, names) {
  if (!norm.startsWith(root + '\\')) return false;
  const rel = norm.slice(root.length + 1);
  return rel.length > 0 && !rel.includes('\\') && names.has(rel);
}

// The path's components BELOW the checkout `root` (no trailing backslash on root): the
// directories and basename inside the checkout, never the ancestors above it. [] when the
// path is not strictly inside root.
function relSegments(norm, root) {
  const base = root + '\\';
  if (!norm.startsWith(base)) return [];
  const rel = norm.slice(base.length);
  return rel ? rel.split('\\') : [];
}

// Code: a codeDirs / scriptDir component below `base` (the primary root; for a worktree the
// worktree mark, so the worktree's own name still counts as before), or a rootCodeFiles
// basename directly under `root`.
function isCodePath(norm, root, repo, base = root) {
  const segs = relSegments(norm, base);
  const dirSegs = segs.slice(0, -1); // directory components below base only
  const codeDirs = new Set((repo.codeDirs || []).map((d) => d.toLowerCase()));
  if (dirSegs.some((d) => codeDirs.has(d))) return true;
  const scriptDir = (repo.scriptDir || 'scripts').toLowerCase();
  const scriptExts = new Set((repo.scriptExts || []).map((e) => e.toLowerCase()));
  if (dirSegs.includes(scriptDir)) {
    const base = segs[segs.length - 1] || '';
    const dot = base.lastIndexOf('.');
    if (dot >= 0 && scriptExts.has(base.slice(dot + 1))) return true;
  }
  const rootFiles = new Set((repo.rootCodeFiles || []).map((f) => f.toLowerCase()));
  return directChildIn(norm, root, rootFiles);
}

// Exempt (docs, config, markdown): an exemptDirs entry matched as \<dir>\ anywhere in the
// path BELOW the checkout root (the same substring rule as before, with the ancestors above
// the root cut off). Nested under a code dir still counts (src\docs\x.ts is exempt), as the
// pre-alias hook's own test requires for <P>\src\.claude\worktrees\...
function isExempt(norm, root, repo) {
  const rel = norm.startsWith(root + '\\') ? norm.slice(root.length) : ''; // keeps the leading '\'
  for (const d of (repo.exemptDirs || [])) {
    if (rel.includes('\\' + String(d).toLowerCase() + '\\')) return true;
  }
  for (const e of (repo.exemptExts || [])) {
    if (norm.endsWith('.' + String(e).toLowerCase())) return true;
  }
  return false;
}

function classifyRepo(norm, content, prepared) {
  const { cfg: repo, prim, wtPrefix, wtMark } = prepared;
  // Not this repo's tree. (The worktree prefix is checked on its own: when worktreeMark
  // resolves through a junction it can land outside the primary.)
  if (!norm.startsWith(prim) && !norm.startsWith(wtPrefix)) return ALLOW;

  const prefixes = (repo.allowedBranchPrefixes && repo.allowedBranchPrefixes.length)
    ? repo.allowedBranchPrefixes
    : ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert', 'wip'];
  const allowedBranchRe = new RegExp('^(' + prefixes.map(escapeRegex).join('|') + ')\\/[A-Za-z0-9._\\/-]+$');
  const isAllowedBranch = (name) => allowedBranchRe.test(name) && !name.includes('..');
  const coworkAck = repo.coworkAck || 'cowork-worktree';
  const primaryAck = repo.primaryAck || 'primary-worktree';
  const hints = repo.hints || {};

  // Which checkout root does this file belong to?
  let isWt = false;
  let seg = '';
  let root = prim.slice(0, -1); // primary root, no trailing backslash
  if (norm.startsWith(wtPrefix)) {
    isWt = true;
    seg = norm.slice(wtPrefix.length).split('\\')[0];
    root = wtPrefix + seg;
  }

  // Root config files count as code at a worktree root only when configured to.
  const codeRepo = (isWt && repo.rootCodeFilesAtWorktreeRoots === false)
    ? { ...repo, rootCodeFiles: [] }
    : repo;
  const isCode = isCodePath(norm, root, codeRepo, isWt ? wtPrefix.slice(0, -1) : root);

  if (isWt) {
    if (!isCode) return ALLOW;
    const br = seg ? resolveBranch(root) : { kind: 'unknown' };
    if (br.kind === 'branch' && isAllowedBranch(br.name)) return ALLOW;
    if (ackRe(coworkAck).test(content)) return ALLOW;
    const detected =
      br.kind === 'branch'
        ? `branch ${br.name}${br.rebase ? ' (rebase in progress)' : ''}`
        : br.kind === 'detached' ? 'detached HEAD' : 'branch unreadable';
    const prefixesList = prefixes.map((p) => p + '/').join(' ');
    return {
      decision: 'deny',
      reason:
        `WRONG WRITE TARGET: this is a worktree under ${wtMark} on ${detected} — only worktrees on a named ` +
        `${prefixesList} branch are allowed; a claude/* auto-worktree branch never reaches staging. ` +
        `Put the worktree on a named branch, or create the canonical sibling worktree instead: ` +
        `${hints.worktreeAddExample || '(see the write-target-guard config hints)'} — and do the code work there. ` +
        `If editing here is genuinely intended, include \`guard-ack: ${coworkAck}\` in the content.`,
    };
  }

  if (isExempt(norm, root, repo)) return ALLOW;

  if (isCode && !ackRe(primaryAck).test(content)) {
    return {
      decision: 'deny',
      reason:
        `WRONG WRITE TARGET: this is the ${hints.primaryLabel || 'PRIMARY worktree (merges land here; code work does not)'}. ` +
        `Create a sibling worktree and edit there: ${hints.worktreeAddExample || '(see the write-target-guard config hints)'}. ` +
        `If a user-directed hotfix in the primary is genuinely intended, include \`guard-ack: ${primaryAck}\` in the content.`,
    };
  }
  return ALLOW;
}

// The file-writing tools this guard judges, and for each the content it writes (where an
// ack must appear): Write content, Edit new_string, NotebookEdit new_source, and every
// MultiEdit edits[].new_string (an ack in any one of them counts, as in Edit's new_string).
const GUARDED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function writtenContent(tool, ti) {
  if (tool === 'Write') return String(ti.content ?? '');
  if (tool === 'NotebookEdit') return String(ti.new_source ?? '');
  if (tool === 'MultiEdit') {
    return Array.isArray(ti.edits)
      ? ti.edits.map((e) => (e && typeof e === 'object' ? String(e.new_string ?? '') : '')).join('\n')
      : '';
  }
  return String(ti.new_string ?? '');
}

export function decide(hookInput, opts = {}) {
  const j = hookInput || {};
  const tool = j.tool_name;
  const ti = j.tool_input || {};
  if (!GUARDED_TOOLS.has(tool)) return ALLOW;
  // NotebookEdit names its target notebook_path (file_path as a fallback); the rest file_path.
  const rawPath = String((tool === 'NotebookEdit' ? (ti.notebook_path || ti.file_path) : ti.file_path) || '');
  if (!rawPath) return ALLOW;
  const content = writtenContent(tool, ti);

  const cfg = opts.config ?? loadConfig(opts.configPath).config;
  if (cfg && cfg.enabled === false) return ALLOW; // explicit opt-out honoured by the classifier too

  const target = resolveTarget(rawPath);
  if (target.deny) return target.deny;
  const norm = target.norm;

  // Self-protection: the guard's own config (the trust anchor), plus the hook file itself.
  const selfTargets = new Set();
  const addSelf = (p) => {
    if (!p) return;
    const r = resolvePath(p);
    if (!r.device && r.norm) selfTargets.add(r.norm);
  };
  const cfgPath = opts.configPath ?? safeDefaultConfigPath();
  addSelf(cfgPath);
  for (const sp of (opts.selfPaths || [])) addSelf(sp);
  if (selfTargets.has(norm) && !ackRe('guard-config').test(content)) {
    return {
      decision: 'deny',
      reason:
        `WRONG WRITE TARGET: ${cfgPath || 'the guard config'} and this guard's own files are the ` +
        'write-target-guard trust anchor (they define what the guard protects). Editing one here is blocked. ' +
        'If this change is intended, include `guard-ack: guard-config` in the content.',
    };
  }

  // The repos, validated and canonicalised (main passes them prepared, with its warnings
  // already reported; a direct caller gets them prepared here, warnings unused).
  let repos = opts.primary == null ? opts.prepared : undefined;
  if (!repos) {
    let raw;
    if (opts.primary != null) {
      const base = (cfg && Array.isArray(cfg.repos) && cfg.repos[0] && typeof cfg.repos[0] === 'object') ? cfg.repos[0] : {};
      raw = [{ ...base, primary: opts.primary }];
    } else {
      raw = (cfg && Array.isArray(cfg.repos)) ? cfg.repos : [];
    }
    repos = prepareRepos(raw).repos;
  }

  for (const repo of repos) {
    const d = classifyRepo(norm, content, repo);
    if (d && d.decision === 'deny') return d;
  }
  return ALLOW;
}

function main() {
  const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let j;
    try {
      j = JSON.parse((input || '{}').replace(/^\uFEFF/, ''));
    } catch {
      return out({}); // garbage stdin -> fail open, silent
    }

    const cp = configPathFromArgv(process.argv);
    let loaded = cp.error ? { status: 'malformed', error: cp.error, path: '(--config argument)' } : loadConfig(cp.path);
    let prep = { repos: [], warnings: [] };
    if (loaded.status === 'ok') {
      try {
        prep = prepareRepos(loaded.config.repos);
      } catch {
        return out({}); // unexpected error -> fail open
      }
      if (!prep.repos.length) {
        // Nothing usable is left: the existing loud fail-open, naming what was dropped.
        loaded = { status: 'malformed', path: loaded.path, error: `no usable entry in "repos": ${prep.warnings.join('; ')}` };
      }
    }
    if (loaded.status === 'missing') {
      // LOUD in every deployment (plugin or standalone): a deleted config is the one
      // off-switch we refuse to make silent.
      process.stderr.write(`[write-target-guard] INACTIVE: no config at ${loaded.path} — Write, Edit, MultiEdit and NotebookEdit are unguarded.\n`);
      return out({ systemMessage: `write-target-guard is INSTALLED but INACTIVE: no config file at ${loaded.path}. Write, Edit, MultiEdit and NotebookEdit are UNGUARDED. Create that file (copy the plugin's write-target-guard.config.example.json and edit it for this machine) to activate it, or remove/disable the plugin if you do not want it.` });
    }
    if (loaded.status === 'malformed') {
      process.stderr.write(`[write-target-guard] INACTIVE: malformed config at ${loaded.path}: ${loaded.error} — Write, Edit, MultiEdit and NotebookEdit are unguarded.\n`);
      return out({ systemMessage: `write-target-guard is INACTIVE: config at ${loaded.path} is malformed (${loaded.error}). Write, Edit, MultiEdit and NotebookEdit are UNGUARDED until it is fixed.` });
    }
    if (loaded.status === 'disabled') {
      // Explicit, valid opt-out ("enabled": false or an empty "repos"): silent by design.
      return out({});
    }

    // Salvaged config problems: LOUD on every call (stderr + systemMessage), never silent,
    // while every valid entry and rule keeps being enforced.
    for (const w of prep.warnings) process.stderr.write(`[write-target-guard] WARNING: config at ${loaded.path}: ${w}\n`);
    const sys = prep.warnings.length
      ? { systemMessage: `write-target-guard WARNING: config at ${loaded.path} has problems: ${prep.warnings.join('; ')}. The guard is ACTIVE and every valid entry is still enforced; fix the config to clear this warning.` }
      : {};

    let d;
    try {
      d = decide(j, { config: loaded.config, prepared: prep.repos, configPath: loaded.path, selfPaths: [process.argv[1]] });
    } catch {
      return out({ ...sys }); // unexpected error -> fail open
    }
    if (d && d.decision === 'deny') {
      return out({ ...sys, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
    }
    return out({ ...sys });
  });
}

// Run main when executed as the hook. Gate on argv[1]'s basename, case-insensitively:
// a full-path compare against import.meta.url fails silently when launched through a
// junction/symlink or a \\?\ path (Node realpaths the entry module), and a skipped
// main means empty stdout = allow everything. Importers (the .test.mjs) do not match.
if (path.basename(process.argv[1] || '').toLowerCase() === 'write-target-guard.mjs') main();
