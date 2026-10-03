#!/usr/bin/env node
// write-target-guard.mjs — PreToolUse hook on Write|Edit.
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

// Canonicalise a raw file_path to a comparable lowercased backslash path, folding the
// alias families above. Returns { norm } or { unresolvable: true } for device/volume
// namespaces that cannot be mapped to a file path.
function canonicalize(raw, hostnames) {
  let s = String(raw).replace(/\//g, '\\').toLowerCase();

  // P1: \\?\UNC\server\share and \\.\UNC\server\share -> \\server\share
  s = s.replace(/^\\\\[?.]\\unc\\/, '\\\\');
  // P1: strip a \\?\ or \\.\ device prefix (\\?\C:\x -> C:\x)
  let deviceStripped = false;
  if (/^\\\\[?.]\\/.test(s)) {
    s = s.replace(/^\\\\[?.]\\/, '');
    deviceStripped = true;
  }
  // P1: forms that cannot be resolved to a drive/UNC path -> refuse to guess.
  if (/^(globalroot|volume\{|physicaldrive|harddiskvolume)/.test(s) || /^\\\\[?.]\\/.test(s)) {
    return { unresolvable: true };
  }
  if (deviceStripped && !/^[a-z]:/.test(s) && !/^\\\\/.test(s)) {
    return { unresolvable: true };
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
    if (seg === '' || /^\.+$/.test(seg) || /:$/.test(seg)) continue; // keep empties, . .. and the drive
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

const uncDeny = (raw, resolved) => ({
  decision: 'deny',
  reason:
    `WRONG WRITE TARGET: ${raw} ` +
    (resolved ? `resolves to the network (UNC) path ${resolved}` : 'is a network (UNC) path') +
    ' that this guard cannot map to a local drive path, so it cannot tell which checkout the write ' +
    'would land in. Every write to such a target is refused. Use the local drive path (C:\\...) instead.',
});

// Resolve a raw file_path for the checks: P1/P2 canonicalise, then P3 realpath. Returns
// { norm } (a lowercased local drive path) or { deny } (the decision to return). A UNC path
// P1 cannot fold to a drive is denied twice over: lexically, and again when realpath (a
// mapped drive, a symlink to a share) lands on one. realpathFn is the test seam; the hook
// always uses the default.
export function resolveTarget(rawPath, realpathFn = realpathSync.native) {
  const hostnames = getHostnames();
  const canon = canonicalize(rawPath, hostnames);
  if (canon.unresolvable) return { deny: DEVICE_DENY };
  if (isUnc(canon.norm)) return { deny: uncDeny(rawPath) };
  let norm = realpathAncestor(canon.norm, realpathFn);
  if (isUnc(norm)) {
    // Re-apply the P1 fold: a recognised loopback admin share returns to a drive path.
    const again = canonicalize(norm, hostnames);
    if (again.unresolvable) return { deny: DEVICE_DENY };
    if (isUnc(again.norm)) return { deny: uncDeny(rawPath, norm) };
    norm = realpathAncestor(again.norm, realpathFn);
    if (isUnc(norm)) return { deny: uncDeny(rawPath, norm) };
  }
  return { norm };
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

const primNorm = (primary) => {
  let p = path.win32.normalize(String(primary).replace(/\//g, '\\').toLowerCase());
  if (!p.endsWith('\\')) p += '\\';
  return p;
};
const wtMarkNorm = (m) => String(m == null ? '.claude\\worktrees\\' : m).replace(/\//g, '\\').toLowerCase();

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

function classifyRepo(norm, content, repo) {
  const prim = primNorm(repo.primary);
  if (!norm.startsWith(prim)) return ALLOW; // not this repo's tree
  const wtMark = wtMarkNorm(repo.worktreeMark);
  const wtPrefix = prim + wtMark;

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
    root = prim + wtMark + seg;
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

export function decide(hookInput, opts = {}) {
  const j = hookInput || {};
  const tool = j.tool_name;
  const ti = j.tool_input || {};
  const rawPath = String(ti.file_path || '');
  if (!rawPath || (tool !== 'Write' && tool !== 'Edit')) return ALLOW;
  const content = String(tool === 'Write' ? (ti.content ?? '') : (ti.new_string ?? ''));

  const cfg = opts.config ?? loadHomeConfig().config;
  if (cfg && cfg.enabled === false) return ALLOW; // explicit opt-out honoured by the classifier too
  let repos;
  if (opts.primary != null) {
    const base = (cfg && Array.isArray(cfg.repos) && cfg.repos[0]) ? cfg.repos[0] : {};
    repos = [{ ...base, primary: opts.primary }];
  } else {
    repos = (cfg && Array.isArray(cfg.repos)) ? cfg.repos : [];
  }

  const target = resolveTarget(rawPath);
  if (target.deny) return target.deny;
  const norm = target.norm;
  const hostnames = getHostnames();

  // Self-protection: the guard's own config (the trust anchor), plus the hook file itself.
  const selfTargets = new Set();
  const addSelf = (p) => {
    if (!p) return;
    const c = canonicalize(p, hostnames);
    if (!c.unresolvable) selfTargets.add(realpathAncestor(c.norm));
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

  for (const repo of repos) {
    if (!repo || !repo.primary) continue;
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

    const loaded = loadHomeConfig();
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

    let d;
    try {
      d = decide(j, { config: loaded.config, configPath: loaded.path, selfPaths: [process.argv[1]] });
    } catch {
      return out({}); // unexpected error -> fail open
    }
    if (d && d.decision === 'deny') {
      return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
    }
    return out({});
  });
}

// Run main when executed as the hook. Gate on argv[1]'s basename, case-insensitively:
// a full-path compare against import.meta.url fails silently when launched through a
// junction/symlink or a \\?\ path (Node realpaths the entry module), and a skipped
// main means empty stdout = allow everything. Importers (the .test.mjs) do not match.
if (path.basename(process.argv[1] || '').toLowerCase() === 'write-target-guard.mjs') main();
