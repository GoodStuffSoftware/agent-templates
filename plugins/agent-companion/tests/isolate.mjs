// Test-process isolation: importing this module (directly, or through
// helpers.mjs) points every plugin state path at a private temp sandbox for the
// life of the process, and arms a tripwire on the operator's REAL ~/.claude.
//
// WHY. makeFixture() isolated only the tests that called it, and it restored the
// previous env on cleanup — which was "unset", i.e. the operator's real home.
// So a test that never called makeFixture (or ran after another test's
// cleanup) resolved AGENT_COMPANION_STATE_DIR to the real
// ~/.claude/agent-companion and read the operator's LIVE routing profile. On
// 2026-10-02 that profile held rows (rev 10) and about 13 routing tests failed
// on the operator's machine while CI, with no profile, passed. Isolation has to
// be the DEFAULT of the process, not something each test remembers to ask for.
//
// WHAT IT DOES.
//   1. Creates one sandbox directory per process and sets
//      AGENT_COMPANION_HOME_OVERRIDE, AGENT_COMPANION_STATE_DIR and
//      AGENT_COMPANION_DESKTOP_DIR inside it; clears CLAUDE_CONFIG_DIR,
//      CLAUDE_PLUGIN_DATA and AGENT_COMPANION_VAULT_DIR. Child processes a test
//      spawns inherit all of it (childEnv() merges over process.env).
//      makeFixture() still gives a test its own fresh directory; what it
//      restores afterwards is THIS sandbox, never the real home.
//   2. Arms a tripwire on node:fs: any call, in this process, whose path
//      resolves under the real Claude config root(s) THROWS (so the offending
//      test fails at the call) and is also recorded, and a root-level
//      after() hook fails the file if anything was recorded, even if the
//      plugin code swallowed the throw (most of it fails open by design).
//
// The tripwire is the in-process half. The child-process half is
// tests/audit-no-real-home.test.mjs (its own tracer) plus the inherited env.
// tests/isolation-guard.test.mjs asserts all of this, and that every test file
// imports this module one way or the other.

import fs, { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { after } from 'node:test';

const win = process.platform === 'win32';
const canon = (s) => {
  const n = String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return win ? n.toLowerCase() : n;
};

// The operator's REAL .claude root(s), captured at module load — before any
// env is changed here, and before makeFixture() deletes CLAUDE_CONFIG_DIR.
// context.mjs's claudeDir() resolves CLAUDE_CONFIG_DIR first and only then
// <homedir()>/.claude, so a resolver that skipped the override could land under
// either. resolve() first: CLAUDE_CONFIG_DIR may be relative or carry a
// trailing "/" or "/.".
export const REAL_CLAUDE = join(homedir(), '.claude').replace(/\\/g, '/');
export const REAL_CLAUDE_DIRS = Object.freeze([...new Set([
  REAL_CLAUDE,
  ...(process.env.CLAUDE_CONFIG_DIR ? [resolve(process.env.CLAUDE_CONFIG_DIR).replace(/\\/g, '/')] : []),
].filter(Boolean))]);

// A state dir the operator pointed at on purpose (outside the temp area) is
// real state too.
const originalStateDir = process.env.AGENT_COMPANION_STATE_DIR
  ? resolve(process.env.AGENT_COMPANION_STATE_DIR).replace(/\\/g, '/')
  : null;
const underTmp = (p) => canon(p).startsWith(canon(tmpdir()) + '/');
const lexicalRoots = [
  ...REAL_CLAUDE_DIRS,
  ...(originalStateDir && !underTmp(originalStateDir) ? [originalStateDir] : []),
];
// A symlink or junction into the real home, or its long-name spelling, is the
// same place: watch the canonical path too (resolved before anything is patched).
const canonicalRoots = [];
for (const r of lexicalRoots) {
  try { canonicalRoots.push(realpathSync(r).replace(/\\/g, '/')); } catch { /* does not exist: nothing to alias */ }
}
export const WATCHED_ROOTS = Object.freeze([...new Set([...lexicalRoots, ...canonicalRoots])]);

// --- the sandbox ------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), 'ac-suite-'));
export const SANDBOX_DIR = sandbox;
process.env.AGENT_COMPANION_HOME_OVERRIDE = sandbox;
process.env.AGENT_COMPANION_STATE_DIR = join(sandbox, '.claude', 'agent-companion');
process.env.AGENT_COMPANION_DESKTOP_DIR = join(sandbox, 'desktop');
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_COMPANION_VAULT_DIR;
process.on('exit', () => {
  try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
});

// --- the tripwire -----------------------------------------------------------

const violations = [];
export function realHomeViolations() { return violations.slice(); }
export function clearRealHomeViolations() { violations.length = 0; }

const toPath = (a) => {
  try {
    if (typeof a === 'string') return a;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(a)) return a.toString('utf8');
    if (a instanceof URL) return fileURLToPath(a);
  } catch { /* not path-like */ }
  return null;
};

function underWatched(arg) {
  const p = toPath(arg);
  if (p === null || p === '') return null;
  let abs;
  try { abs = canon(resolve(p)); } catch { return null; }
  for (const r of WATCHED_ROOTS) {
    const c = canon(r);
    if (abs === c || abs.startsWith(`${c}/`)) return abs;
  }
  return null;
}

// Path arguments by function: most take the path first; these take two paths.
const TWO_PATH = new Set(['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'rename', 'copyFile', 'cp', 'link', 'symlink']);
const FNS = [
  // reads
  'existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync', 'accessSync',
  'realpathSync', 'readlinkSync', 'opendirSync', 'createReadStream', 'readFile', 'readdir', 'stat',
  'lstat', 'open', 'access', 'realpath', 'readlink', 'opendir', 'exists', 'watch', 'watchFile', 'globSync', 'glob',
  'statfs', 'statfsSync', 'openAsBlob',
  // writes
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync',
  'copyFileSync', 'cpSync', 'truncateSync', 'utimesSync', 'chmodSync', 'symlinkSync', 'linkSync',
  'mkdtempSync', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink',
  'rename', 'copyFile', 'cp', 'truncate', 'utimes', 'chmod', 'symlink', 'link', 'mkdtemp',
  'chownSync', 'lchownSync', 'lutimesSync', 'lchmodSync', 'chown', 'lchown', 'lutimes', 'lchmod',
];

function patch(mod, name, label) {
  const orig = mod?.[name];
  if (typeof orig !== 'function' || orig.__acGuard) return;
  const wrapper = function (...args) {
    const hit = underWatched(args[0]) || (TWO_PATH.has(name) ? underWatched(args[1]) : null);
    if (hit) {
      const who = process.argv[1] ? `${basename(process.argv[1])}: ` : '';
      const msg = `test touched the REAL Claude home: ${who}${label}${name}(${hit}) — tests must stay inside their sandbox (see tests/isolate.mjs)`;
      violations.push(`${who}${label}${name} ${hit}`);
      throw new Error(msg);
    }
    return orig.apply(this, args);
  };
  wrapper.__acGuard = true;
  // Carry own properties across (exists.__promisify__ and the like); the
  // .native variants of realpath are functions of their own, so they are
  // wrapped, not copied.
  for (const k of Object.keys(orig)) {
    try { wrapper[k] = orig[k]; } catch { /* non-writable: skip */ }
  }
  if (typeof orig.native === 'function') patch(wrapper, 'native', `${label}${name}.`);
  try { mod[name] = wrapper; } catch { /* frozen: skip */ }
}

for (const name of FNS) patch(fs, name, 'fs.');
try { for (const name of FNS) patch(fs.promises, name, 'fs.promises.'); } catch { /* no promises API */ }
// Named imports of 'node:fs' in modules loaded from here on read the patched
// functions; sync the facade for any that were materialised before this ran.
try { syncBuiltinESMExports(); } catch { /* best effort */ }

// A file whose test touched the real home fails even if the plugin code
// caught the throw. Registered at the root of the importing test file.
after(() => {
  if (violations.length) {
    throw new Error(`this test file touched the real Claude home ${violations.length} time(s): ${[...new Set(violations)].slice(0, 5).join('; ')}`);
  }
});
