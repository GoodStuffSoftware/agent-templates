#!/usr/bin/env node
// write-target-guard.mjs — PreToolUse hook on Write|Edit|MultiEdit|NotebookEdit.
//
// Keeps CODE writes out of protected checkouts: a repo's PRIMARY/deploy worktree
// (merges land there, code work does not) and its unnamed auto-worktrees (a
// claude/* branch under .claude/worktrees/* never reaches staging). Code work
// belongs in a deliberately-named sibling worktree. Docs, .claude config and
// markdown are exempt. A conscious exception is made when the written content
// carries `guard-ack: primary-worktree` or `guard-ack: cowork-worktree`.
//
// Lineage: the original (2026-07-07) hard-coded one project (my-project). This
// version (2026-10-03) is CONFIG-DRIVEN so it can ship in a public plugin with no
// project-specific paths: the rules come from ~/.claude/write-target-guard.config.json
// (see write-target-guard.config.example.json). There is deliberately NO
// environment-variable override of the config or of any rule (a bypass vector).
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
//   A plain relative path (src\x.ts) is unchanged: it resolves against the hook PROCESS cwd.
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
//
// The decision logic is the exported pure function decide(); main (stdin/stdout) runs
// when argv[1]'s BASENAME is write-target-guard.mjs — not a full-path compare, because
// Node realpaths the entry module and a junction/symlink/\\?\ launch would otherwise
// silently skip main (= allow everything). Importers (the .test.mjs) do not match.

import { readFileSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ALLOW = { decision: 'allow' };

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ackRe = (ack) => new RegExp('guard-ack:\\s*' + escapeRegex(ack), 'i');

function defaultConfigPath() {
  return path.win32.join(os.homedir(), '.claude', 'write-target-guard.config.json');
}

let _cfgCache;
function loadHomeConfig() {
  if (_cfgCache) return _cfgCache;
  const p = defaultConfigPath();
  try {
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return (_cfgCache = { status: 'malformed', error: e.message, path: p });
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repos)) {
      return (_cfgCache = { status: 'malformed', error: 'config has no "repos" array', path: p });
    }
    // Explicit, VALID opt-out — the only route to a silent allow.
    if (parsed.enabled === false || parsed.repos.length === 0) {
      return (_cfgCache = { status: 'disabled', config: parsed, path: p });
    }
    return (_cfgCache = { status: 'ok', config: parsed, path: p });
  } catch (e) {
    if (e && e.code === 'ENOENT') return (_cfgCache = { status: 'missing', path: p });
    return (_cfgCache = { status: 'malformed', error: e.message, path: p });
  }
}

function getHostnames() {
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  try { set.add(os.hostname().toLowerCase()); } catch { /* ignore */ }
  return set;
}

// A device prefix: \\?\ , \\.\ or the NT-namespace \??\ (after / -> \ folding).
const DEVICE_PREFIX = /^(?:\\\\[?.]\\|\\\?\?\\)/;

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
    if (seg === '' || /^[ .]+$/.test(seg) || /:$/.test(seg)) continue;
    parts[i] = seg.replace(/[ .]+$/, '');
  }
  s = parts.join('\\');

  // collapse . / .. / doubled separators
  s = path.win32.normalize(s);
  return { norm: s };
}

// P3: realpath the deepest existing ancestor, re-append the not-yet-created tail.
// A realpath failure falls back to the lexical path (it does not fail open).
function realpathAncestor(norm, realpathFn = realpathSync.native) {
  try {
    let cur = norm;
    const tail = [];
    for (;;) {
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
  } catch {
    return norm;
  }
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

// Resolve a raw file_path for the checks. Returns { norm } (a lowercased local drive path)
// or { deny } (the decision to return). A drive-relative or rooted-relative path is denied.
// A UNC path P1 cannot fold to a drive is denied twice over: lexically, and again when
// realpath (a mapped drive, a symlink to a share) lands on one. realpathFn is the test seam;
// the hook always uses the default.
export function resolveTarget(rawPath, realpathFn = realpathSync.native) {
  const r = resolvePath(rawPath, realpathFn);
  if (r.device) return { deny: DEVICE_DENY };
  if (r.relative) return { deny: relativeDeny(rawPath) };
  if (r.unc) return { deny: uncDeny(rawPath, r.resolved) };
  return { norm: r.norm };
}

// Resolve a worktree root's current branch without spawning git.
// Returns { kind:'branch', name, rebase? } | { kind:'detached' } | { kind:'unknown' }.
function resolveBranch(root) {
  try {
    const dotGit = path.win32.join(root, '.git');
    let gitdir;
    if (statSync(dotGit).isDirectory()) {
      gitdir = dotGit;
    } else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8').replace(/^\uFEFF/, ''));
      if (!m) return { kind: 'unknown' };
      gitdir = path.win32.resolve(root, m[1]); // handles absolute and root-relative gitdir
    }
    const head = readFileSync(path.win32.join(gitdir, 'HEAD'), 'utf8').replace(/^\uFEFF/, '').trim();
    if (!head) return { kind: 'unknown' };
    const r = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (r) return { kind: 'branch', name: r[1].trim() };
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      let hn;
      try {
        hn = readFileSync(path.win32.join(gitdir, dir, 'head-name'), 'utf8').replace(/^\uFEFF/, '').trim();
      } catch {
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
const trimSep = (p) => { const t = p.replace(/[\\/]+$/, ''); return /^[a-z]:$/i.test(t) ? t + '\\' : t; };
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
    if (!isNonEmptyStr(rawPrim) || !/^([a-z]:[\\/]|[\\/]{2}|[\\/]\?\?[\\/])/i.test(rawPrim.trim())) {
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

function isCodePath(norm, root, repo) {
  const segs = norm.split('\\');
  const dirSegs = segs.slice(0, -1); // directory components only
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

function isExempt(norm, repo) {
  for (const d of (repo.exemptDirs || [])) {
    if (norm.includes('\\' + String(d).toLowerCase() + '\\')) return true;
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
  const isCode = isCodePath(norm, root, codeRepo);

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

  if (isExempt(norm, repo)) return ALLOW;

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

  const cfg = opts.config ?? loadHomeConfig().config;
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
  addSelf(opts.configPath ?? defaultConfigPath());
  for (const sp of (opts.selfPaths || [])) addSelf(sp);
  if (selfTargets.has(norm) && !ackRe('guard-config').test(content)) {
    return {
      decision: 'deny',
      reason:
        `WRONG WRITE TARGET: ${opts.configPath ?? defaultConfigPath()} and this guard's own files are the ` +
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

    let loaded = loadHomeConfig();
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
      process.stderr.write(`[write-target-guard] INACTIVE: no config at ${loaded.path} — Write/Edit are unguarded.\n`);
      return out({ systemMessage: `write-target-guard is INSTALLED but INACTIVE: no config file at ${loaded.path}. Write and Edit are UNGUARDED. Create that file (copy the plugin's write-target-guard.config.example.json and edit it for this machine) to activate it, or remove/disable the plugin if you do not want it.` });
    }
    if (loaded.status === 'malformed') {
      process.stderr.write(`[write-target-guard] INACTIVE: malformed config at ${loaded.path}: ${loaded.error}\n`);
      return out({ systemMessage: `write-target-guard is INACTIVE: config at ${loaded.path} is malformed (${loaded.error}). Write and Edit are UNGUARDED until it is fixed.` });
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
