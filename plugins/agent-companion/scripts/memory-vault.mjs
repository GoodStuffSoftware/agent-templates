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
// ADR's "Why default-OFF"): `sync()` checks `opt('memory_vault', false)` as
// its first line, so a hand run with the option off is a no-op regardless of
// how it is invoked (by name, by hand, or by the scheduled routine). This is
// STRICTER than memory-doctor.mjs and memory-search.mjs, which do not check a
// master on/off option in their CLI path at all — do not assume parity with
// those two scripts here. opt() reads the option from settings.json as well as
// from CLAUDE_PLUGIN_OPTION_*, so enabling it in Claude Code is enough; the
// env var remains a per-invocation override.
//
// A gate that says no still writes to state/memory-vault-status.json. A sync
// that is turned away used to leave NO trace at all, which made "the option
// never reached this context" look identical to "nobody ran a sync" — see
// writeStatusCache() below.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { execFileSyncHidden } from './lib/proc.mjs';
import { fileURLToPath } from 'node:url';
import {
  opt, stateRoot, stateDir,
} from '../hooks/lib/context.mjs';
import { memoryRoot, discoverFiles } from '../hooks/lib/memory-index.mjs';

const MARKER_NAME = '.memory-vault.json';
const LOCK_STALE_MS = 120000;
const SCHEMA = 1;          // .memory-vault.json marker — do NOT bump with the status cache
const STATUS_SCHEMA = 2;   // memory-vault-status.json — see writeStatusCache()

// --- Secrets gate ------------------------------------------------------
// Standing gate, run on every sync, not a one-off. A match excludes that ONE
// file from the commit (the vault's prior copy, if any, is left untouched)
// and is reported by LABEL and FILE PATH only — the matched text itself is
// never logged, written, or returned from this module.
//
// This corpus is operational notes, not source code — PEM headers, example
// tokens and documented env-var names show up in PROSE routinely (explaining
// a CLI flag, quoting an SDK call signature, walking through a setup step).
// A pattern that matches on SHAPE ALONE, with no evidence the shape is a real
// secret rather than a description of one, will keep false-positiving on
// that kind of note. Each entry below is either a plain regex (kept because
// its shape is specific enough — a fixed prefix plus a length floor, e.g.
// `AKIA` + 16 chars, `sk-ant-` + 20 chars, a 3-part JWT — that prose is very
// unlikely to produce it by accident) or a `(text) => boolean` matcher that
// additionally requires evidence of REALNESS beyond shape. See the two
// matcher functions below for exactly what evidence each one demands.

// AWS's own documentation reuses ONE canonical, publicly-known example
// credential pair everywhere (S3/IAM tutorials, the SigV4 reference, etc.).
// Excluding these two EXACT strings removes a documented, widely-repeated
// false positive without narrowing detection of any real key: a real key can
// never be byte-for-byte identical to a string AWS itself tells the world is
// a placeholder.
const AWS_DOC_EXAMPLE_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const AWS_DOC_EXAMPLE_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function hasRealAwsAccessKeyId(text) {
  const re = /\bAKIA[0-9A-Z]{16}\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] !== AWS_DOC_EXAMPLE_ACCESS_KEY_ID) return true;
  }
  return false;
}

function hasRealAwsSecretStyle(text) {
  const re = /\baws(?:.{0,20})?(?:secret|access)[_-]?key\b.{0,5}[:=]\s*['"]?([A-Za-z0-9/+=]{30,})/gi;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== AWS_DOC_EXAMPLE_SECRET_ACCESS_KEY) return true;
  }
  return false;
}

// private-key-block — THE confirmed false positive this rewrite exists for.
// A bare `-----BEGIN ... PRIVATE KEY-----` header, alone, is common in prose
// that merely MENTIONS a PEM header: explaining that a CLI rejects a
// positional value starting with `-` (using the header as the illustration),
// or quoting an SDK call signature with the body elided (`"...\n"`). Neither
// case is a key. A genuine key always has all three of: a BEGIN marker, a
// matching END marker of the SAME key type, and a base64 body of its own
// between them spanning multiple lines — never a single line, never elided.
// Require all three; anything less does not flag.
function hasRealPrivateKeyBlock(text) {
  const re = /-----BEGIN ((?:RSA|EC|OPENSSH|DSA|PGP) )?PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/g;
  let m;
  while ((m = re.exec(text))) {
    if (isPlausibleKeyBody(m[2])) return true;
  }
  return false;
}

// A plausible body: 2+ lines that are THEMSELVES pure base64 alphabet (no
// prose, no elision markers) and long enough to be real key material — PEM
// wraps at 64 chars/line, so a genuine multi-line body always has several
// long, pure-base64 lines. An elided body ("...", "<redacted>", "$VAR", a
// lone ellipsis) never produces 2 such lines, so it never qualifies.
function isPlausibleKeyBody(body) {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const base64Line = /^[A-Za-z0-9+/]{20,}={0,2}$/;
  return lines.filter((l) => base64Line.test(l)).length >= 2;
}

const SECRET_PATTERNS = [
  ['aws-access-key-id', hasRealAwsAccessKeyId],
  ['aws-secret-style', hasRealAwsSecretStyle],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai-api-key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['private-key-block', hasRealPrivateKeyBlock],
  ['jwt-like', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  // Left as plain shape matches deliberately — see the module comment above
  // for why these two are NOT converted to realness-checking matchers.
  ['connection-string-cred', /:\/\/[^/\s:@]+:[^/\s@]+@/],
  ['secret-assignment', /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i],
];

export function scanForSecrets(text) {
  const hits = [];
  for (const [label, matcher] of SECRET_PATTERNS) {
    const isHit = typeof matcher === 'function' ? matcher(text) : matcher.test(text);
    if (isHit) hits.push(label);
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
  return execFileSyncHidden('git', args, { encoding: 'utf8', ...opts });
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
  'Files are stored and restored byte for byte: `.gitattributes` here carries',
  '`* -text`, which turns off git\'s line-ending conversion in both',
  'directions. Do not remove it — without it a checkout on a machine with',
  '`core.autocrlf` set will hand back LF-native files with CRLF endings.',
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

// --- byte-exactness -------------------------------------------------------
// The vault copies bytes in and must hand the same bytes back. git does not
// do that by default: with core.autocrlf (true on Windows) an LF-native
// memory store commits as LF and CHECKS OUT as CRLF. Nothing errors and
// nothing warns — the rewrite only becomes visible at restore time, which is
// the one moment this repository is the last remaining copy of the corpus.
// `* -text` switches every conversion off, in both directions.
const GITATTRIBUTES_NAME = '.gitattributes';
const GITATTRIBUTES = [
  '# Byte-exact storage. The vault copies memory files in verbatim and has to',
  '# hand them back verbatim, so git must not rewrite anything on the way in',
  '# or on the way out.',
  '#',
  '# Without this, core.autocrlf (true by default on Windows) converts line',
  '# endings on checkout: an LF-native memory store commits as LF and restores',
  '# as CRLF. Nothing errors and nothing warns, and the corruption surfaces',
  '# only at restore time — the one moment this repository is the last',
  '# remaining copy of the corpus.',
  '#',
  '# Existing history does not need rewriting for this to take effect. It',
  '# governs how git reads and writes the working tree from here on.',
  '* -text',
].join('\n') + '\n';

const GITATTRIBUTES_COMMIT_MSG = [
  'memory-vault: store and restore bytes verbatim',
  '',
  'Adds .gitattributes with `* -text` so git performs no line-ending',
  'conversion in this repository. Without it, core.autocrlf rewrites LF-native',
  'memory stores to CRLF on checkout — a silent corruption that only shows up',
  'at restore time.',
  '',
  'History is untouched: this governs the working tree from here on.',
].join('\n') + '\n';

// Someone else's .gitattributes may reach byte-exactness by another route.
// `binary` is git's own macro for `-diff -merge -text`, so it counts.
function disablesNormalization(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .some((l) => /^\*\s+(-text|binary)(\s|$)/.test(l));
}

export function vaultIsByteExact(dir) {
  try {
    return disablesNormalization(readFileSync(join(dir, GITATTRIBUTES_NAME), 'utf8'));
  } catch { return false; }
}

// Which tracked files' working-tree BYTES differ from their committed blob.
// Empty means switching normalization off changes nothing — every file is
// already stored exactly as it sits on disk, so `* -text` is a no-op for
// content and safe to add. Non-empty means adding it would start reporting
// those files as modified and the next sync would commit a whole-tree
// line-ending diff: a rewrite of the backup, not a backup.
//
// `git status` cannot answer this. It trusts its stat cache, a .gitattributes
// change does not invalidate that cache, and under core.autocrlf a file can
// be reported modified while `git diff` shows nothing (a stat mismatch with
// identical post-conversion content) or reported clean while its raw bytes
// differ from the blob. So the blob hashes are compared directly:
// `hash-object --no-filters` is the one path that applies no conversion at all.
function divergentFromIndex(dir) {
  const byPath = new Map();
  for (const e of git(['-C', dir, 'ls-files', '-s', '-z']).split('\0')) {
    const tab = e.indexOf('\t'); // "<mode> <sha> <stage>\t<path>"
    if (tab < 0) continue;
    const meta = e.slice(0, tab).trim().split(/\s+/);
    if (meta.length >= 2) byPath.set(e.slice(tab + 1), meta[1]);
  }
  const paths = [...byPath.keys()];
  if (paths.length === 0) return [];
  // --stdin-paths is newline-delimited, so a path containing one cannot be
  // checked. Unverifiable counts as divergent: this gate fails closed.
  if (paths.some((p) => p.includes('\n'))) return ['<unverifiable path>'];
  const hashes = git(['-C', dir, 'hash-object', '--no-filters', '--stdin-paths'],
    { input: `${paths.join('\n')}\n` })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (hashes.length !== paths.length) return ['<unverifiable tree>'];
  return paths.filter((p, i) => hashes[i] !== byPath.get(p));
}

// Backfill for a vault that predates the file. Returns what happened:
//   'present'    — already byte-exact, nothing to do
//   'differs'    — a .gitattributes exists that does NOT disable conversion.
//                  Left exactly as the operator wrote it; reported, never
//                  clobbered.
//   'backfilled' — written and committed as its own single-file commit
//   'blocked'    — writing it would renormalise tracked content, so it was
//                  backed out. See below: that is a rewrite of the backup, not
//                  a backup, and it is refused rather than committed.
//   'error'      — git unavailable or the write failed; the vault is unchanged
function backfillGitattributes(dir) {
  const file = join(dir, GITATTRIBUTES_NAME);
  if (existsSync(file)) {
    let current = null;
    try { current = readFileSync(file, 'utf8'); } catch { return 'error'; }
    return disablesNormalization(current) ? 'present' : 'differs';
  }
  try {
    // Checked BEFORE anything is written, so a vault that cannot take this
    // safely is never even momentarily changed.
    if (divergentFromIndex(dir).length) return 'blocked';
    writeFileSync(file, GITATTRIBUTES);
    git(['-C', dir, 'add', '--', GITATTRIBUTES_NAME]);
    git(['-C', dir, 'commit', '-q', '-F', '-'], { input: GITATTRIBUTES_COMMIT_MSG });
    return 'backfilled';
  } catch {
    // Only remove what we wrote, and only if it never got committed.
    try {
      const tracked = git(['-C', dir, 'ls-files', '--', GITATTRIBUTES_NAME]).trim();
      if (!tracked && existsSync(file)) unlinkSync(file);
    } catch { /* best effort */ }
    return 'error';
  }
}

// Idempotent: a dir already carrying MARKER_NAME is treated as already
// initialized and this is a no-op APART from backfilling .gitattributes when
// that can be done without rewriting anything (see backfillGitattributes).
// A NON-EMPTY dir with no marker is refused outright — this is the "refuses
// to clobber an existing repo" guarantee.
export function ensureInit() {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true });
  if (isOurVault(dir)) return { created: false, dir, gitattributes: backfillGitattributes(dir) };

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
  // Written BEFORE the first commit, so a new vault has never once stored a
  // file through a line-ending conversion.
  writeFileSync(join(dir, GITATTRIBUTES_NAME), GITATTRIBUTES);
  writeFileSync(
    join(dir, MARKER_NAME),
    JSON.stringify({ kind: 'agent-companion-memory-vault', schema: SCHEMA, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  git(['-C', dir, 'add', '-A']);
  git(['-C', dir, 'commit', '-q', '-m', 'memory-vault: initialize\n\nLocal git history for the Claude Code memory corpus. See README.md.']);
  return { created: true, dir, gitattributes: 'created' };
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
    // Record the attempt BEFORE returning. This is the whole point: a sync
    // that is turned away has to leave a trace, or an option that never
    // reaches this context is indistinguishable from nobody running a sync.
    const rec = writeStatusCache({ outcome: 'skipped', reason: 'disabled' });
    return {
      skipped: 'disabled', consecutiveSkips: rec.consecutiveSkips,
      message: 'memory-vault: disabled (memory_vault option is off) — no-op',
    };
  }

  if (!acquireLock()) {
    const rec = writeStatusCache({ outcome: 'skipped', reason: 'locked' });
    return {
      skipped: 'locked', consecutiveSkips: rec.consecutiveSkips,
      message: 'memory-vault: another sync is already running — skipped',
    };
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
      writeStatusCache({ outcome: 'aborted', reason: 'empty-enumeration-guard' });
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
        outcome: 'ran',
        now,
        run: {
          lastSyncAt: now, committed: false, filesTracked: walkAllFiles(projectsRoot).length,
          flagged: flagged.length, readErrors: readErrors.length,
        },
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
      outcome: 'ran',
      now,
      run: {
        lastSyncAt: now, lastCommitSha: sha, committed: true,
        filesTracked: walkAllFiles(projectsRoot).length,
        added: added.length, modified: modified.length, removed: removed.length,
        flagged: flagged.length, readErrors: readErrors.length, projectsTouched,
      },
    });

    return {
      committed: true, sha, added: added.length, modified: modified.length, removed: removed.length,
      flagged: flagged.length, flaggedFiles: flagged.map((f) => ({ file: f.relKey, labels: f.labels })),
      readErrors: readErrors.length, projectsTouched,
      message: `memory-vault: sync committed ${sha.slice(0, 12)} — ${projectsTouched.length} project(s), `
        + `+${added.length} ~${modified.length} -${removed.length} `
        + `(${flagged.length} flagged, ${readErrors.length} read error(s))`,
    };
  } catch (e) {
    // A throw is exactly as silent as a skip from the drift check's point of
    // view, so it leaves a trace too — and then propagates unchanged.
    writeStatusCache({ outcome: 'error', reason: String(e?.message || e).slice(0, 200) });
    throw e;
  } finally {
    releaseLock();
  }
}

// --- status cache ---------------------------------------------------------
// This file is the ONLY trace a sync leaves behind, and it used to be written
// exclusively AFTER the memory_vault gate inside sync(). So a sync that was
// turned away wrote NOTHING, and "the option never reached the scheduled
// context" looked exactly like "nobody has run a sync lately." The
// memory-vault-drift check could not tell the two apart and so could not
// report either one.
//
// v:2 records every ATTEMPT alongside the last successful RUN, and the two
// sets never overwrite each other:
//
//   lastSyncAt, lastCommitSha, committed, filesTracked, added, modified,
//   removed, flagged, readErrors, projectsTouched
//       Unchanged v:1 meaning — the last sync that actually ran, written with
//       exactly the fields v:1 wrote. A v:1 reader works against a v:2 file
//       verbatim, and a v:1 file read by v:2 code simply has no attempt
//       record yet.
//   lastAttemptAt, lastAttemptOutcome, lastAttemptReason, consecutiveSkips
//       EVERY call to sync(), including the ones that return before doing any
//       work at all: disabled, locked, aborted, thrown.
//
// The divergence between the two is the signal. Attempted a minute ago, last
// succeeded never (or long ago) is what an option that is not reaching the
// context that syncs actually looks like from the outside.
//
// This does not make a healthy backup noisy. A sync that runs writes outcome
// 'ran' and consecutiveSkips 0 every time, and the drift check stays silent
// on exactly that — silence remains the success case.
function readStatusCache() {
  try {
    const obj = JSON.parse(readFileSync(statusCacheFile(), 'utf8'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch { return null; } // absent or malformed: same as no history
}

// `run` carries the fields of a sync that actually did the work and REPLACES
// the previous run's fields wholesale, exactly as v:1 did. Omit it for an
// attempt that was turned away and the previous run's fields are carried
// forward untouched, so a skip can never erase the record of the last real
// backup.
function writeStatusCache({ outcome, reason = null, run = null, now = new Date().toISOString() }) {
  const prev = readStatusCache() || {};
  const {
    v: _v, lastAttemptAt: _at, lastAttemptOutcome: _oc,
    lastAttemptReason: _rs, consecutiveSkips: _cs, ...prevRun
  } = prev;
  const priorSkips = Number.isFinite(prev.consecutiveSkips) ? prev.consecutiveSkips : 0;
  const record = {
    v: STATUS_SCHEMA,
    ...(run || prevRun),
    lastAttemptAt: now,
    lastAttemptOutcome: outcome,
    lastAttemptReason: reason,
    consecutiveSkips: outcome === 'ran' ? 0 : priorSkips + 1,
  };
  try { writeFileSync(statusCacheFile(), JSON.stringify(record, null, 2)); } catch { /* best effort cache */ }
  return record;
}

// --- status ------------------------------------------------------------
export function status() {
  const dir = vaultDir();
  const enabled = opt('memory_vault', false);
  // The attempt record is read FIRST and reported on BOTH paths. A sync that
  // is turned away never creates the vault, so the uninitialized case is
  // precisely where "something tried and was refused" needs to be visible —
  // returning a bare {initialized:false} there is how the skip stayed silent.
  const cache = readStatusCache();
  const daysSince = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? +((Date.now() - t) / 86400000).toFixed(2) : null;
  };
  const attempt = {
    lastSyncAt: cache?.lastSyncAt || null,
    lastAttemptAt: cache?.lastAttemptAt || null,
    lastAttemptOutcome: cache?.lastAttemptOutcome || null,
    lastAttemptReason: cache?.lastAttemptReason || null,
    consecutiveSkips: Number.isFinite(cache?.consecutiveSkips) ? cache.consecutiveSkips : 0,
    runDaysAgo: daysSince(cache?.lastSyncAt),
    attemptDaysAgo: daysSince(cache?.lastAttemptAt),
  };
  if (!isOurVault(dir)) {
    return { enabled, initialized: false, dir, ...attempt };
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
  const ageMs = lastCommit ? Date.now() - Date.parse(lastCommit.date) : null;
  return {
    enabled, initialized: true, dir, dirty, lastCommit, fileCount, projectCount,
    ...attempt,
    byteExact: vaultIsByteExact(dir),
    staleDays: ageMs === null ? null : +(ageMs / 86400000).toFixed(2),
  };
}

// --- CLI ---------------------------------------------------------------
function printSync(r) {
  if (r.skipped) {
    console.log(r.message);
    if (r.consecutiveSkips > 1) {
      console.log(`  ${r.consecutiveSkips} consecutive sync attempts have now done no work `
        + '(recorded in state/memory-vault-status.json; the audit\'s memory-vault-drift check reads it)');
    }
    return;
  }
  if (r.aborted) { console.error(r.message); return; }
  console.log(r.message);
  if (r.flagged) {
    for (const f of r.flaggedFiles || []) console.log(`  flagged (excluded): ${f.file} [${f.labels.join(', ')}]`);
  }
}

// Every outcome except "already fine" is said out loud. A .gitattributes that
// could not be added is the difference between a backup that restores and one
// that restores with every line ending rewritten, so it is never silent.
function printGitattributes(outcome) {
  if (outcome === 'created' || outcome === 'present') return;
  if (outcome === 'backfilled') {
    console.log('  added .gitattributes (`* -text`) and committed it — this vault now stores and restores bytes verbatim');
  } else if (outcome === 'differs') {
    console.log('  NOTE: this vault has a .gitattributes that does NOT disable line-ending conversion. '
      + 'Left exactly as you wrote it — add `* -text` yourself if you want byte-exact restores.');
  } else if (outcome === 'blocked') {
    console.log('  NOTE: could not add .gitattributes — doing so would report tracked files as modified '
      + '(a line-ending renormalisation of content already committed). Nothing was changed. '
      + 'Commit or inspect the working tree first, then re-run init.');
  } else if (outcome === 'error') {
    console.log('  NOTE: could not add .gitattributes (git unavailable or the write failed). Nothing was changed.');
  }
}

// A sync that did no work is printed on BOTH the initialized and the
// uninitialized path, because "nothing here" plus "something tried and was
// refused" is the diagnosis; either half alone is not.
function printAttempt(r) {
  if (!r.lastAttemptAt) return;
  if (r.lastAttemptOutcome === 'ran') return; // healthy: stays quiet
  const why = r.lastAttemptReason ? ` (${r.lastAttemptReason})` : '';
  console.log(`  last attempt   : ${r.lastAttemptAt} — ${r.lastAttemptOutcome}${why}`);
  console.log(`  no-work runs   : ${r.consecutiveSkips} consecutive`);
  if (r.lastSyncAt) console.log(`  last real sync : ${r.lastSyncAt}`);
  else console.log('  last real sync : (never)');
}

function printStatus(r) {
  console.log(`memory-vault — ${r.dir}`);
  console.log(`  option enabled : ${r.enabled}`);
  console.log(`  initialized    : ${r.initialized}`);
  if (!r.initialized) { printAttempt(r); return; }
  printAttempt(r);
  console.log(`  tracked files  : ${r.fileCount} across ${r.projectCount} project(s)`);
  console.log(`  working tree   : ${r.dirty ? 'DIRTY (uncommitted changes present)' : 'clean'}`);
  console.log(`  byte-exact     : ${r.byteExact ? 'yes (.gitattributes disables line-ending conversion)'
    : 'NO — checkout may rewrite line endings; run: node memory-vault.mjs init'}`);
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
      else {
        console.log(r.created ? `memory-vault: initialized at ${r.dir}` : `memory-vault: already initialized at ${r.dir}`);
        printGitattributes(r.gitattributes);
      }
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
