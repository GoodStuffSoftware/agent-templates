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
  realpathSync, statSync, lstatSync,
} from 'node:fs';
import { join, dirname, relative, sep, resolve, isAbsolute } from 'node:path';
import { gitIsolated, enclosingGitRepo, samePath } from './lib/git-env.mjs';
import { fileURLToPath } from 'node:url';
import {
  opt, stateRootPath, stateDir,
} from '../hooks/lib/context.mjs';
import { memoryRoot, discoverFiles } from '../hooks/lib/memory-index.mjs';

const MARKER_NAME = '.memory-vault.json';
const LOCK_STALE_MS = 120000;
const SCHEMA = 1;          // .memory-vault.json marker — do NOT bump with the status cache
const STATUS_SCHEMA = 2;   // memory-vault-status.json — see writeStatusCache()
const VAULT_USER_NAME = 'agent-companion memory-vault';
const VAULT_USER_EMAIL = 'memory-vault@agent-companion.local';
const INIT_SUBJECT = 'memory-vault: initialize';

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

// Path only — resolving it creates nothing, so ensureInit() can refuse a bad
// location before a single byte is written anywhere.
//
// AGENT_COMPANION_VAULT_DIR moves the vault ALONE: it names the vault
// directory itself (absolute; checkVaultLocation() refuses a relative one,
// which would resolve against whatever cwd a scheduled run happens to have).
// AGENT_COMPANION_STATE_DIR also moves the vault, but it moves every piece of
// agent-companion state with it — config (brevity toggles, standing rules),
// telemetry, dedup state — so it is the wrong knob for "the vault landed
// inside a repository".
export const VAULT_DIR_ENV = 'AGENT_COMPANION_VAULT_DIR';

export function vaultDir() {
  return process.env[VAULT_DIR_ENV] || join(stateRootPath(), 'memory-vault');
}

const RELOCATE_ADVICE = `Relocate the vault alone by setting ${VAULT_DIR_ENV} to an absolute path outside `
  + 'any git repository, then retry. (AGENT_COMPANION_STATE_DIR would move the vault too, but it moves ALL '
  + 'agent-companion state with it — config, brevity toggles, standing rules, telemetry.)';

function lockFile() {
  return join(stateDir(), 'memory-vault-sync.lock');
}

// stateDir() creates the state root (README.txt, state/) as a side effect, so
// it is only for WRITES. A read — `status`, or the drift check importing this
// module — resolves the same path without creating anything.
function statusCacheFile({ create = true } = {}) {
  return join(create ? stateDir() : join(stateRootPath(), 'state'), 'memory-vault-status.json');
}

// --- git, pinned to the vault ---------------------------------------------
// EVERY git call in this file goes through one of these two. Neither ever
// lets git discover a repository from the environment or the cwd:
//
//   - gitIsolated() strips GIT_DIR and the other repo-locating variables
//     (see lib/git-env.mjs for the incident this prevents). An inherited
//     absolute GIT_DIR made `git init <vault>` re-initialise the CALLER's
//     repository as bare and `git -C <vault> config user.*` write the vault
//     identity into that repository's shared .git/config. It also strips
//     inherited config injection (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/
//     KEY_n/VALUE_n, GIT_TEMPLATE_DIR): a parent's core.hooksPath ran the
//     parent's hooks inside the vault, and an include.path rewrote the vault
//     commits' author. This file never injects config that way itself, so
//     nothing it needs is lost (the leak-sweep canary, which does, keeps
//     using gitClean()).
//   - vaultGit() additionally names the vault's git dir and work tree
//     explicitly, so even a variable the strip list misses, or a vault whose
//     .git has gone missing (which would otherwise make git walk UP into
//     whatever repository encloses it), cannot redirect a write. And it
//     points core.hooksPath at a directory that does not exist, so no hook —
//     from global or system config, or from the vault's own .git/hooks — runs
//     on a vault commit.
function git(args, opts = {}) {
  return gitIsolated(args, opts);
}

// Relative hooksPath resolves against the vault's work tree. Never created:
// an absent hooks directory is an empty one.
const NO_HOOKS = '.git/agent-companion-no-hooks';

function vaultGitDir(dir) {
  return join(dir, '.git');
}

// RELATIVE --git-dir/--work-tree, resolved after `-C dir`: Git for Windows
// rejects an explicit absolute git dir far short of PATH_MAX with
// "'$GIT_DIR' too big", which an absolute path under a deep state root can
// reach. Relative to the vault they are always short, and still explicit.
// core.longpaths lets Git for Windows reach work-tree files
// (projects/<project>/memory/...) past 260 characters once the repository is
// found; it is ignored everywhere else.
//
// commit.gpgsign / tag.gpgsign are off for the same reason the hooks are: an
// operator's global signing setting has no business on a local backup, and a
// signer that is missing or locked made the initialize commit fail, leaving a
// vault that no later run could use (see finishInit()).
//
// core.fsmonitor=false: a global fsmonitor setting names a program (or starts
// a daemon) that git would run against the vault. The vault needs none.
function vaultGit(dir, args, opts = {}) {
  return gitIsolated([
    '-c', 'core.longpaths=true', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
    '-C', dir, '--git-dir=.git', '--work-tree=.', ...args,
  ], opts);
}

// Git for Windows finds a repository by checking <dir>\.git\objects against
// MAX_PATH (260, so 259 usable characters) BEFORE it reads any config, so
// core.longpaths cannot lift it: at a vault path longer than this, git sees
// no repository in the vault at all. Refused up front, before anything is
// written, rather than leaving a half-made vault that no later run can use.
const WIN_MAX_VAULT_PATH = 259 - '\\.git\\objects'.length; // 246

function vaultPathTooLong(dir) {
  return process.platform === 'win32' && resolve(dir).length > WIN_MAX_VAULT_PATH;
}

function tooLongMessage(dir) {
  return `refusing to initialize — the vault path is ${resolve(dir).length} characters (${dir}). `
    + `Git for Windows cannot find a repository whose path is longer than ${WIN_MAX_VAULT_PATH} characters, `
    + `whatever core.longpaths says. Nothing was written. Set ${VAULT_DIR_ENV} to a shorter absolute path `
    + 'outside any git repository, then retry.';
}

function isOurVault(dir) {
  return existsSync(join(dir, MARKER_NAME));
}

function realOrResolved(p) {
  try { return realpathSync.native(p); } catch { return p; }
}

// The vault's OWN git dir is <dir>/.git and git, discovering from <dir> with
// a clean env, agrees. Anything else — .git missing, a gitfile pointing
// elsewhere, discovery landing in an enclosing repository — throws before
// any write.
//
// "Agrees" is not enough on its own. Both sides of that comparison are
// realpath'd, so a <dir>/.git that is a symlink or a Windows junction to
// ANOTHER repository's .git resolves identically on both sides and passes —
// and every later add/commit lands in that repository. So <dir>/.git must
// also be a real directory (lstat: not a link, not a junction, not a
// gitfile), sitting exactly at <realpath(dir)>/.git once links are resolved.
function assertVaultGitDir(dir) {
  const expected = vaultGitDir(dir);
  let actual = '';
  try {
    actual = git(['-C', dir, 'rev-parse', '--absolute-git-dir'], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`refusing to write — ${dir} has no git repository of its own (${String(e?.message || e).split('\n')[0]})`);
  }
  if (!isDirPath(expected) || !samePath(realOrResolved(actual), realOrResolved(expected))) {
    throw new Error(
      `refusing to write — git resolves ${dir} to the repository at ${actual}, not to the vault's own `
      + `${expected}. Nothing was changed.`,
    );
  }
  if (!isRealDir(expected) || !samePath(realOrResolved(expected), join(realOrResolved(dir), '.git'))) {
    throw new Error(
      `refusing to write — ${expected} is not a real directory of the vault's own (it is a symlink or `
      + `junction, resolving to ${realOrResolved(expected)}). Nothing was changed.`,
    );
  }
}

// A marker file is only a claim — one dropped into any repository (or copied
// along with a directory) would otherwise hand that repository to sync. The
// vault this file creates is recognised by its HISTORY: every root commit is
// the initialize commit. A planted marker does not bring that along. It is
// checked read-only, before anything is written.
//
// The vault identity in the local config is NOT required. It is only the
// author name on commits, and an owner may change it, for example to put their
// own email on a vault they intend to push. Refusing such a vault turned a
// working backup into one that the refusal told its owner to delete. A
// changed identity is reported as a note, once per process, and the vault
// stays in use.
const QUIET = { stdio: ['ignore', 'pipe', 'ignore'] };
const identityNoted = new Set();

function vaultEmail(dir) {
  try { return vaultGit(dir, ['config', '--file', '.git/config', '--get', 'user.email'], QUIET).trim(); } catch { return ''; }
}

function rootSubjects(dir) {
  try {
    return vaultGit(dir, ['log', '--max-parents=0', '--format=%s', 'HEAD'], QUIET)
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; } // no commits
}

function assertVaultIdentity(dir) {
  const email = vaultEmail(dir);
  const roots = rootSubjects(dir);
  const rootsOk = roots.length > 0 && roots.every((s) => s === INIT_SUBJECT);
  if (!rootsOk) {
    throw new Error(
      `refusing to write — ${dir} carries a memory-vault marker but is not a vault this plugin created `
      + `(its history ${roots.length ? 'is not' : 'has no commits, so it is not'} rooted in "${INIT_SUBJECT}"). `
      + `Nothing was changed. ${keepOrClearAdvice(dir, { marker: true })}`,
    );
  }
  if (email !== VAULT_USER_EMAIL && !identityNoted.has(resolve(dir))) {
    identityNoted.add(resolve(dir));
    process.stderr.write(
      `memory-vault: note — ${dir} is a vault this plugin created, but its local user.email is `
      + `${email ? `"${email}"` : 'unset'} rather than ${VAULT_USER_EMAIL}. The vault is still used; its `
      + 'new commits carry the identity its config now names.\n',
    );
  }
}

// --- refusal advice: never "delete" a directory that holds history ---------
// A refusal is read by a person or an agent, and both follow its advice. So a
// refusal suggests deleting a directory ONLY when doing so cannot lose
// anything: the directory's own .git (a real directory, not a link) has no
// commits reachable from any ref or reflog, AND the directory holds nothing
// besides that .git and the marker. For anything else, including history that
// cannot be read, the advice is to move the directory aside by renaming it,
// which keeps everything.
function reachableCommits(dir) {
  if (!isRealDir(vaultGitDir(dir))) return null;
  try {
    const n = Number(vaultGit(dir, ['rev-list', '--all', '--reflog', '--count'], QUIET).trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function keepOrClearAdvice(dir, { marker = false } = {}) {
  const extra = existsSync(dir) ? readdirSync(dir).filter((n) => n !== '.git' && n !== MARKER_NAME) : [];
  const commits = reachableCommits(dir);
  if (commits === 0 && extra.length === 0) {
    return `It holds no commits and no files besides its empty .git${marker ? ` and ${MARKER_NAME}` : ''}, so `
      + `deleting ${dir} and retrying loses nothing. ${RELOCATE_ADVICE}`;
  }
  const holds = [
    commits === null ? 'a git history that could not be read' : commits > 0 ? `${commits} commit(s)` : '',
    extra.length ? `files (${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', ...' : ''})` : '',
  ].filter(Boolean).join(' and ');
  const markerStep = marker
    ? `If this is your own repository, the ${MARKER_NAME} file in it is stray: move that one file out of `
      + 'the repository and keep everything else. '
    : '';
  return `KEEP this directory — it holds ${holds}. ${markerStep}To give the vault a fresh start here, move the `
    + `directory aside by renaming it (for example to ${dir}.moved-aside) and retry. ${RELOCATE_ADVICE}`;
}

// A directory entry that is itself a directory — not a symlink or junction to
// one. Node's lstat reports a Windows junction as a symbolic link.
function isRealDir(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch { return false; }
}

function isDirPath(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
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
  for (const e of vaultGit(dir, ['ls-files', '-s', '-z']).split('\0')) {
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
  const hashes = vaultGit(dir, ['hash-object', '--no-filters', '--stdin-paths'],
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
    vaultGit(dir, ['add', '--', GITATTRIBUTES_NAME]);
    vaultGit(dir, ['commit', '-q', '-F', '-'], { input: GITATTRIBUTES_COMMIT_MSG });
    return 'backfilled';
  } catch {
    // Only remove what we wrote, and only if it never got committed.
    try {
      const tracked = vaultGit(dir, ['ls-files', '--', GITATTRIBUTES_NAME]).trim();
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
//
// A NEW vault is also refused, with nothing written at all (not even the
// vault directory), when its location is, or is inside, any existing git
// repository — its work tree or its git dir. A vault this file created
// itself (marker present AND git resolves the dir to its own .git) is exempt,
// so a vault that already works keeps working. Every refusal happens before
// the first mkdir.
//
// The checks live in checkVaultLocation(), which is READ-ONLY, so sync() can
// run the same checks before it writes its lock or status file: a refusal
// that says "Nothing was written" has to be true on every entry point.
export function ensureInit() {
  const dir = vaultDir();
  const state = checkVaultLocation(dir);
  if (state === 'existing') {
    return { created: false, dir, gitattributes: backfillGitattributes(dir) };
  }
  if (state === 'resume') return finishInit(dir);
  return createVault(dir);
}

// 'existing' — a vault this file created, safe to write.
// 'resume'   — a vault this file started but whose initialize commit never
//              landed (marker + vault identity, zero commits). finishInit()
//              completes it.
// 'new'      — nothing there (or an empty dir) outside any repository.
// Anything else throws, having written nothing anywhere.
export function checkVaultLocation(dir = vaultDir()) {
  if (process.env[VAULT_DIR_ENV] && !isAbsolute(process.env[VAULT_DIR_ENV])) {
    throw new Error(
      `refusing to initialize — ${VAULT_DIR_ENV} is "${process.env[VAULT_DIR_ENV]}", a relative path, which `
      + 'would resolve against whatever directory the sync happens to run from. Nothing was written. Set it '
      + 'to an absolute path outside any git repository, then retry.',
    );
  }
  if (vaultPathTooLong(dir)) throw new Error(tooLongMessage(dir));
  if (isOurVault(dir)) {
    assertVaultGitDir(dir);
    if (isUnfinishedVault(dir)) return 'resume';
    assertVaultIdentity(dir);
    return 'existing';
  }

  // A repository of its own but no marker: an initialization that stopped
  // part-way, or a repository that was never a vault. Said as exactly that —
  // the enclosing-repository check below would otherwise report the vault
  // directory as "inside an existing git repository", which sends the
  // operator looking for a repository that is not there.
  if (existsSync(vaultGitDir(dir))) {
    throw new Error(
      `refusing to initialize — ${dir} already holds a git repository but no memory-vault marker `
      + `(${MARKER_NAME}). Either an earlier initialization stopped part-way or this repository is not a `
      + `memory vault. Nothing was written. ${keepOrClearAdvice(dir)}`,
    );
  }

  const enclosing = enclosingGitRepo(dir);
  if (enclosing) {
    throw new Error(
      `refusing to initialize — ${dir} is inside an existing git repository `
      + `(${enclosing.kind === 'git-dir' ? 'its git dir' : 'its work tree'} at ${enclosing.root}). `
      + 'The memory vault must be a repository of its own, never nested in another. Nothing was '
      + `written. ${RELOCATE_ADVICE}`,
    );
  }

  const entries = existsSync(dir) ? readdirSync(dir) : [];
  if (entries.length > 0) {
    const sample = entries.slice(0, 5).join(', ') + (entries.length > 5 ? ', ...' : '');
    throw new Error(
      `refusing to initialize — ${dir} already exists and is not an agent-companion `
      + `memory vault (found: ${sample}). Nothing was written. Keep what is there: move it aside by `
      + `renaming it (for example to ${dir}.moved-aside) and retry, or `
      + `${RELOCATE_ADVICE.charAt(0).toLowerCase()}${RELOCATE_ADVICE.slice(1)}`,
    );
  }
  return 'new';
}

function createVault(dir) {
  mkdirSync(dir, { recursive: true });
  // --template= (empty): no template directory at all, so neither an
  // operator's init.templateDir nor git's sample hooks seed the vault's .git.
  // `git init` runs hooks too: creating HEAD fires reference-transaction, from
  // the operator's global core.hooksPath. So init gets the same no-hooks
  // override as every other vault call. It is absolute here because init runs
  // before there is a vault work tree to resolve a relative path against.
  git([
    '-c', 'core.longpaths=true', '-c', `core.hooksPath=${join(dir, NO_HOOKS)}`, '-c', 'core.fsmonitor=false',
    'init', '-q', '--template=', '-b', 'main', dir,
  ]);
  // Proven BEFORE the first config write: the repository git just made is
  // this directory's own. If it is not, stop here with only an empty repo
  // created inside the vault dir, never a write anywhere else.
  assertVaultGitDir(dir);
  // --file, not an ambient lookup: the identity can only ever land in the
  // vault's own config file. RELATIVE to the vault (after -C): an absolute
  // --file makes Git for Windows build <vault>\.git\config.lock as a full
  // path, which passes 260 characters for vaults of 243 characters and up
  // and fails, leaving a vault with a repository and no marker.
  vaultGit(dir, ['config', '--file', '.git/config', 'user.name', VAULT_USER_NAME]);
  vaultGit(dir, ['config', '--file', '.git/config', 'user.email', VAULT_USER_EMAIL]);
  mkdirSync(join(dir, 'projects'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), VAULT_README);
  // Written BEFORE the first commit, so a new vault has never once stored a
  // file through a line-ending conversion.
  writeFileSync(join(dir, GITATTRIBUTES_NAME), GITATTRIBUTES);
  writeFileSync(
    join(dir, MARKER_NAME),
    JSON.stringify({ kind: 'agent-companion-memory-vault', schema: SCHEMA, createdAt: new Date().toISOString() }, null, 2) + '\n',
  );
  vaultGit(dir, ['add', '-A']);
  vaultGit(dir, ['commit', '-q', '-m', INIT_MESSAGE]);
  return { created: true, dir, gitattributes: 'created' };
}

const INIT_MESSAGE = `${INIT_SUBJECT}\n\nLocal git history for the Claude Code memory corpus. See README.md.`;

// createVault() writes the marker BEFORE the initialize commit, so a commit
// that fails (a global commit.gpgsign with no working signer was the case
// found) leaves the marker, the vault identity and zero commits. That vault
// used to be refused on every later run, because it has no initialize root
// commit. It is ours: the marker and the vault identity in its own config
// say so, and with no commits there is no history anyone else could own. So
// the initialization is finished instead.
function isUnfinishedVault(dir) {
  return vaultEmail(dir) === VAULT_USER_EMAIL && reachableCommits(dir) === 0;
}

const INIT_FILES = ['README.md', GITATTRIBUTES_NAME, MARKER_NAME];

function finishInit(dir) {
  mkdirSync(join(dir, 'projects'), { recursive: true });
  if (!existsSync(join(dir, 'README.md'))) writeFileSync(join(dir, 'README.md'), VAULT_README);
  const gaExisted = existsSync(join(dir, GITATTRIBUTES_NAME));
  if (!gaExisted) writeFileSync(join(dir, GITATTRIBUTES_NAME), GITATTRIBUTES);
  vaultGit(dir, ['add', '--', ...INIT_FILES]);
  // Only the initialize files, whatever else is staged: `commit -- <paths>`.
  vaultGit(dir, ['commit', '-q', '-m', INIT_MESSAGE, '--', ...INIT_FILES]);
  return {
    created: true, resumed: true, dir,
    gitattributes: !gaExisted || vaultIsByteExact(dir) ? 'created' : 'differs',
  };
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

  // Before the lock and the status file — both are writes, under the state
  // root. A location the vault must never use is refused with nothing
  // written; ensureInit() below repeats the check under the lock.
  checkVaultLocation();

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

    vaultGit(dir, ['add', '-A', '--', 'projects']);
    const staged = vaultGit(dir, ['diff', '--cached', '--name-status']).trim();

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
    vaultGit(dir, ['commit', '-q', '-F', '-'], { input: msg });
    const sha = vaultGit(dir, ['rev-parse', 'HEAD']).trim();

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
    const obj = JSON.parse(readFileSync(statusCacheFile({ create: false }), 'utf8'));
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
  try { dirty = vaultGit(dir, ['status', '--porcelain']).trim().length > 0; } catch { /* unknown */ }
  try {
    const raw = vaultGit(dir, ['log', '-1', '--format=%H%x1f%cI%x1f%s']).trim();
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
        console.log(r.resumed ? `memory-vault: finished an interrupted initialization at ${r.dir}`
          : r.created ? `memory-vault: initialized at ${r.dir}` : `memory-vault: already initialized at ${r.dir}`);
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
