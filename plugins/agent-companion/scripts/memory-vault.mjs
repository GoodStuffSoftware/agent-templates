// memory-vault.mjs — local git history for the Claude Code memory corpus.
//
// See docs/adr/0001-memory-corpus-backup-vault.md for the design and the
// alternatives it rejected. The one invariant every function here exists to
// protect: THIS FILE NEVER WRITES TO THE LIVE CORPUS
// (~/.claude/projects/*/memory/). Every read against it goes through
// hooks/lib/memory-index.mjs's discoverFiles(), the same reader the audit and
// the memory-search index already use — nothing here reimplements corpus
// discovery, and nothing here calls writeFileSync/rename/unlink/git against
// memoryRoot() or any path under it. The vault is a SEPARATE repository
// (default: ~/.claude/agent-companion/memory-vault/, i.e. under stateRoot(),
// the plugin's existing durable-state root) that copies files in and commits.
//
// Commands:
//   node memory-vault.mjs init             create the vault repo (idempotent;
//                                           refuses to clobber a non-vault dir)
//   node memory-vault.mjs sync [--json]    copy + commit changes since last sync
//   node memory-vault.mjs status [--json]  report vault state
//
// `sync` self-gates on the memory_vault plugin option (default OFF — see the
// ADR's "Why default-OFF"). It still runs, and does something, whenever it is
// invoked directly (by name, by hand, or by the scheduled routine) — same
// convention as memory-doctor.mjs and memory-search.mjs: the OPTION gates
// automatic/unattended use, not the script itself.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  opt, stateRoot, stateDir,
} from '../hooks/lib/context.mjs';
import { memoryRoot, discoverFiles } from '../hooks/lib/memory-index.mjs';

const MARKER_NAME = '.memory-vault.json';
const LOCK_STALE_MS = 120000;
const SCHEMA = 1;

// --- Secrets gate ------------------------------------------------------
// Standing gate, run on every sync, not a one-off. A match excludes that ONE
// file from the commit (the vault's prior copy, if any, is left untouched)
// and is reported by LABEL and FILE PATH only — the matched text itself is
// never logged, written, or returned from this module.
const SECRET_PATTERNS = [
  ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/],
  ['aws-secret-style', /\baws(.{0,20})?(secret|access)[_-]?key\b.{0,5}[:=]\s*['"]?[A-Za-z0-9/+=]{30,}/i],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai-api-key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['private-key-block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['jwt-like', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['connection-string-cred', /:\/\/[^/\s:@]+:[^/\s@]+@/],
  ['secret-assignment', /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i],
];

export function scanForSecrets(text) {
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

// --- Paths ---------------------------------------------------------------

export function vaultDir() {
  return join(stateRoot(), 'memory-vault');
}

function lockFile() {
  return join(stateDir(), 'memory-vault-sync.lock');
}

function statusCacheFile() {
  return join(stateDir(), 'memory-vault-status.json');
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

function isOurVault(dir) {
  return existsSync(join(dir, MARKER_NAME));
}

const VAULT_README = [
  '# agent-companion memory vault',
  '',
  'A local, plain-git history of the Claude Code memory corpus at',
  '`~/.claude/projects/*/memory/`, mirrored under `projects/` below in the',
  'same layout (`projects/<project>/memory/**`).',
  '',
  'This repository is written by the `agent-companion` Claude Code plugin\'s',
  '`scripts/memory-vault.mjs` (see that plugin\'s own source repository for',
  '`docs/adr/0001-memory-corpus-backup-vault.md`, which explains the design).',
  'It is a COPY — the live memory corpus is never a git working tree and is',
  'never written to by this feature.',
  '',
  '## Reading history',
  '',
  'Plain git, nothing else required, even if the plugin that wrote this is',
  'gone:',
  '',
  '```',
  'git log --oneline -- projects/<project>/memory/MEMORY.md',
  'git log -p -- projects/<project>/memory/MEMORY.md',
  'git show <sha>^:projects/<project>/memory/<file>.md   # content before a deletion',
  '```',
  '',
  '## What this is not',
  '',
  '- Not a sync target for session transcripts — those are never copied here.',
  '- Not the live corpus — editing files here does not affect Claude Code',
  '  memory, and native memory writes never touch this directory.',
  '- Not pushed anywhere by default. Add a remote when you are ready:',
  '  `git remote add origin <url> && git push -u origin main`.',
  '',
].join('\n') + '\n';

// Idempotent: a dir already carrying MARKER_NAME is treated as already
// initialized and this is a no-op. A NON-EMPTY dir with no marker is refused
// outright — this is the "refuses to clobber an existing repo" guarantee.
export function ensureInit() {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true });
  if (isOurVault(dir)) return { created: false, dir };

  const entries = readdirSync(dir);
  if (entries.length > 0) {
    const sample = entries.slice(0, 5).join(', ') + (entries.length > 5 ? ', ...' : '');
    throw new Error(
      `refusing to initialize — ${dir} already exists and is not an agent-companion `
      + `memory vault (found: ${sample}). Move or remove it, or relocate the vault by `
      + 'setting AGENT_COMPANION_STATE_DIR, then retry.',
    );
  }

  git(['init', '-q', '-b', 'main', dir]);
  git(['-C', dir, 'config', 'user.name', 'agent-companion memory-vault']);
  git(['-C', dir, 'config', 'user.email', 'memory-vault@agent-companion.local']);
  mkdirSync(join(dir, 'projects'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), VAULT_README);
  writeFileSync(
    join(dir, MARKER_NAME),
    JSON.stringify({ kind: 'agent-companion-memory-vault', schema: SCHEMA, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  git(['-C', dir, 'add', '-A']);
  git(['-C', dir, 'commit', '-q', '-m', 'memory-vault: initialize\n\nLocal git history for the Claude Code memory corpus. See README.md.']);
  return { created: true, dir };
}

// --- Locking (protects against two of OUR OWN sync runs racing on the vault's
// own git working tree — NEVER against the live corpus, which is never
// locked). wx-create is atomic on both Windows and POSIX, same technique
// hooks/lib/context.mjs uses for its agent-type dedup markers.
function acquireLock() {
  const f = lockFile();
  mkdirSync(dirname(f), { recursive: true });
  try {
    writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    // Already locked. Stale (older than LOCK_STALE_MS, i.e. a crashed prior
    // run) is taken over; a live lock returns false rather than waiting —
    // this feature must never block on another sync, same posture as
    // hooks/lib/state-sync.mjs's own sync.lock.
    try {
      const st = readFileSync(f, 'utf8');
      const parsed = JSON.parse(st);
      const age = Date.now() - Date.parse(parsed.at);
      if (Number.isFinite(age) && age > LOCK_STALE_MS) {
        unlinkSync(f);
        writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
        return true;
      }
    } catch { /* fall through to locked */ }
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(lockFile()); } catch { /* already gone: fine */ }
}

// --- Vault-tree walking (small and local — the vault is our own output, not
// an untrusted corpus, so this does not need discoverFiles()'s resilience).
function walkAllFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { walkAllFiles(full, base, out); continue; }
    out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function summarizeNameStatus(porcelain) {
  const added = []; const modified = []; const removed = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (status === 'A') added.push(path);
    else if (status === 'D') removed.push(path);
    else modified.push(path); // M, R*, C*, T all read as "changed" for reporting
  }
  return { added, modified, removed };
}

function buildCommitMessage({
  added, modified, removed, projectsTouched, flagged, readErrors,
}) {
  const lines = [
    `memory-vault sync: ${projectsTouched.length} project(s), `
    + `+${added.length} added, ${modified.length} modified, ${removed.length} deleted`,
    '',
    `Projects touched: ${projectsTouched.join(', ') || '(none)'}`,
  ];
  const listBlock = (label, arr) => {
    if (!arr.length) return;
    lines.push('', `${label}:`);
    for (const p of arr.slice(0, 50)) lines.push(`  ${p}`);
    if (arr.length > 50) lines.push(`  ... and ${arr.length - 50} more`);
  };
  listBlock('Added', added);
  listBlock('Modified', modified);
  listBlock('Deleted', removed);
  lines.push('', `Secrets scan: ${flagged.length} file(s) flagged and excluded from this commit`);
  if (readErrors.length) lines.push(`Read errors (left unchanged, retried next sync): ${readErrors.length}`);
  return lines.join('\n') + '\n';
}

// --- sync ------------------------------------------------------------------
// Returns a plain object describing what happened. Never throws for
// "disabled" or "nothing changed" — those are normal outcomes, not errors.
export function sync() {
  if (!opt('memory_vault', false)) {
    return { skipped: 'disabled', message: 'memory-vault: disabled (memory_vault option is off) — no-op' };
  }

  if (!acquireLock()) {
    return { skipped: 'locked', message: 'memory-vault: another sync is already running — skipped' };
  }

  try {
    const { dir } = ensureInit();

    const root = memoryRoot();
    let live;
    try { live = discoverFiles(root); } catch { live = []; }

    const projectsRoot = join(dir, 'projects');
    const vaultHasContent = existsSync(projectsRoot) && walkAllFiles(projectsRoot).length > 0;

    // SAFETY GUARD: a suspicious empty enumeration (unreadable root, transient
    // failure) must never be read as "everything was deleted." Abort with
    // nothing touched rather than mass-delete the vault's tracked content.
    if (live.length === 0 && vaultHasContent) {
      return {
        aborted: true,
        reason: 'empty-enumeration-guard',
        message: 'memory-vault: sync aborted — the live corpus enumerated to zero files while '
          + 'the vault already holds tracked content. Refusing to treat that as "everything '
          + 'deleted." Check that the corpus root is reachable and retry.',
      };
    }

    const byProject = new Map();
    for (const f of live) {
      if (!byProject.has(f.project)) byProject.set(f.project, []);
      byProject.get(f.project).push(f);
    }

    const flagged = [];
    const readErrors = [];
    const seenRelKeysByProject = new Map();

    for (const [project, files] of byProject) {
      const seen = new Set();
      seenRelKeysByProject.set(project, seen);
      for (const f of files) {
        let raw;
        try { raw = readFileSync(f.absPath); } catch { readErrors.push(f.relKey); continue; }
        // Only mark "seen" (i.e. exempt from deletion below) once the file is
        // successfully read — an unreadable file must not be treated as gone.
        seen.add(f.fileRel);
        const text = raw.toString('utf8');
        const hits = scanForSecrets(text);
        if (hits.length) { flagged.push({ relKey: f.relKey, labels: hits }); continue; }
        const dest = join(projectsRoot, project, 'memory', ...f.fileRel.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, raw);
      }
    }

    // Deletions: any file the vault currently mirrors for a project that WAS
    // enumerated this run, but is no longer in that project's live set, is
    // gone from the corpus — remove it here so `git add -A` records the
    // deletion. A project not enumerated at all this run (its memory/ dir no
    // longer exists) has ALL of its mirrored files removed, for the same
    // reason. A file that merely failed to READ (readErrors above) stays
    // "seen" is false for it — but it is not deleted either, because its
    // *listing* still exists; see the note below.
    const deleted = [];
    if (existsSync(projectsRoot)) {
      for (const projectDirName of readdirSync(projectsRoot)) {
        const memDir = join(projectsRoot, projectDirName, 'memory');
        if (!existsSync(memDir)) continue;
        const stillEnumerated = byProject.has(projectDirName);
        const liveSet = seenRelKeysByProject.get(projectDirName) || new Set();
        // Files this run could not read (readErrors) are still present on
        // disk (discoverFiles saw them) — protect them from deletion by also
        // treating any relKey that appears in `live` for this project (read
        // or not) as present.
        const listedThisRun = new Set(
          (byProject.get(projectDirName) || []).map((f) => f.fileRel),
        );
        for (const relPath of walkAllFiles(memDir)) {
          if (stillEnumerated && (liveSet.has(relPath) || listedThisRun.has(relPath))) continue;
          try { unlinkSync(join(memDir, relPath)); deleted.push(`${projectDirName}/${relPath}`); } catch { /* best effort */ }
        }
      }
    }

    git(['-C', dir, 'add', '-A', '--', 'projects']);
    const staged = git(['-C', dir, 'diff', '--cached', '--name-status']).trim();

    const now = new Date().toISOString();
    if (!staged) {
      writeStatusCache({
        lastSyncAt: now, committed: false, filesTracked: walkAllFiles(projectsRoot).length,
        flagged: flagged.length, readErrors: readErrors.length,
      });
      return {
        committed: false, added: 0, modified: 0, removed: 0,
        flagged: flagged.length, readErrors: readErrors.length,
        message: 'memory-vault: sync — no changes since last sync, nothing committed',
      };
    }

    const { added, modified, removed } = summarizeNameStatus(staged);
    const projectsTouched = [...new Set([...added, ...modified, ...removed]
      .map((p) => p.split('/')[1]).filter(Boolean))].sort();
    const msg = buildCommitMessage({
      added, modified, removed, projectsTouched, flagged, readErrors,
    });
    git(['-C', dir, 'commit', '-q', '-F', '-'], { input: msg });
    const sha = git(['-C', dir, 'rev-parse', 'HEAD']).trim();

    writeStatusCache({
      lastSyncAt: now, lastCommitSha: sha, committed: true,
      filesTracked: walkAllFiles(projectsRoot).length,
      added: added.length, modified: modified.length, removed: removed.length,
      flagged: flagged.length, readErrors: readErrors.length, projectsTouched,
    });

    return {
      committed: true, sha, added: added.length, modified: modified.length, removed: removed.length,
      flagged: flagged.length, flaggedFiles: flagged.map((f) => ({ file: f.relKey, labels: f.labels })),
      readErrors: readErrors.length, projectsTouched,
      message: `memory-vault: sync committed ${sha.slice(0, 12)} — ${projectsTouched.length} project(s), `
        + `+${added.length} ~${modified.length} -${removed.length} `
        + `(${flagged.length} flagged, ${readErrors.length} read error(s))`,
    };
  } finally {
    releaseLock();
  }
}

function writeStatusCache(obj) {
  try { writeFileSync(statusCacheFile(), JSON.stringify({ v: SCHEMA, ...obj }, null, 2)); } catch { /* best effort cache */ }
}

// --- status ------------------------------------------------------------
export function status() {
  const dir = vaultDir();
  const enabled = opt('memory_vault', false);
  if (!isOurVault(dir)) {
    return { enabled, initialized: false, dir };
  }
  let dirty = false;
  let lastCommit = null;
  try { dirty = git(['-C', dir, 'status', '--porcelain']).trim().length > 0; } catch { /* unknown */ }
  try {
    const raw = git(['-C', dir, 'log', '-1', '--format=%H%x1f%cI%x1f%s']).trim();
    if (raw) {
      const [sha, date, subject] = raw.split('\x1f');
      lastCommit = { sha, date, subject };
    }
  } catch { /* no commits yet, or git unavailable */ }
  const projectsRoot = join(dir, 'projects');
  const fileCount = existsSync(projectsRoot) ? walkAllFiles(projectsRoot).filter((f) => f.endsWith('.md')).length : 0;
  const projectCount = existsSync(projectsRoot) ? readdirSync(projectsRoot).length : 0;
  let cache = null;
  try { cache = JSON.parse(readFileSync(statusCacheFile(), 'utf8')); } catch { /* no cache yet */ }
  const ageMs = lastCommit ? Date.now() - Date.parse(lastCommit.date) : null;
  return {
    enabled, initialized: true, dir, dirty, lastCommit, fileCount, projectCount,
    lastSyncAt: cache?.lastSyncAt || null,
    staleDays: ageMs === null ? null : +(ageMs / 86400000).toFixed(2),
  };
}

// --- CLI ---------------------------------------------------------------
function printSync(r) {
  if (r.skipped) { console.log(r.message); return; }
  if (r.aborted) { console.error(r.message); return; }
  console.log(r.message);
  if (r.flagged) {
    for (const f of r.flaggedFiles || []) console.log(`  flagged (excluded): ${f.file} [${f.labels.join(', ')}]`);
  }
}

function printStatus(r) {
  console.log(`memory-vault — ${r.dir}`);
  console.log(`  option enabled : ${r.enabled}`);
  console.log(`  initialized    : ${r.initialized}`);
  if (!r.initialized) return;
  console.log(`  tracked files  : ${r.fileCount} across ${r.projectCount} project(s)`);
  console.log(`  working tree   : ${r.dirty ? 'DIRTY (uncommitted changes present)' : 'clean'}`);
  if (r.lastCommit) {
    console.log(`  last commit    : ${r.lastCommit.sha.slice(0, 12)}  ${r.lastCommit.date}`);
    console.log(`                   ${r.lastCommit.subject}`);
  } else {
    console.log('  last commit    : (none yet)');
  }
  if (r.staleDays !== null) console.log(`  age             : ${r.staleDays}d since last commit`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes('--json');
  try {
    if (cmd === 'init') {
      const r = ensureInit();
      if (json) console.log(JSON.stringify(r));
      else console.log(r.created ? `memory-vault: initialized at ${r.dir}` : `memory-vault: already initialized at ${r.dir}`);
      process.exit(0);
    }
    if (cmd === 'sync') {
      const r = sync();
      if (json) console.log(JSON.stringify(r));
      else printSync(r);
      process.exit(r.aborted ? 1 : 0);
    }
    if (cmd === 'status') {
      const r = status();
      if (json) console.log(JSON.stringify(r));
      else printStatus(r);
      process.exit(0);
    }
    console.error('usage: node memory-vault.mjs <init|sync|status> [--json]');
    process.exit(2);
  } catch (e) {
    console.error(`memory-vault: ${e.message}`);
    process.exit(1);
  }
}

// Main-module guard: importing this file (as checks.mjs does, for the
// memory-vault-drift check) must never execute CLI dispatch as a side
// effect. See
// lessons/universal/a-cli-script-without-a-main-guard-runs-on-import.md.
function normalize(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
const isMain = process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
if (isMain) main();
