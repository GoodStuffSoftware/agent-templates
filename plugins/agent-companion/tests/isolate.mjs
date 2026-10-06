// Test-process isolation: importing this module (directly, or through
// helpers.mjs) points every plugin state path AND the operator's home directory
// at a private temp sandbox for the life of the process and of every child it
// spawns, and arms a tripwire on the operator's REAL ~/.claude in all of them.
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
// The first round of that fix covered what the plugin reads through
// AGENT_COMPANION_HOME_OVERRIDE. Several plugin files call os.homedir()
// directly and never consult the override (scripts/detect.mjs, the leak-scan
// and publication-sweep libraries, repo-discovery, version.mjs, the reinject
// shim, hooks/bash-tail.mjs), and so does git (~/.gitconfig). Those would have
// read the operator's real home from any child a test spawned. They are not
// refactored here; the harness closes the hole instead (step 2).
//
// WHAT IT DOES.
//   1. Creates one sandbox directory per process and sets
//      AGENT_COMPANION_HOME_OVERRIDE, AGENT_COMPANION_STATE_DIR and
//      AGENT_COMPANION_DESKTOP_DIR inside it; clears CLAUDE_CONFIG_DIR,
//      CLAUDE_PLUGIN_DATA and AGENT_COMPANION_VAULT_DIR. Child processes a test
//      spawns inherit all of it (childEnv() merges over process.env).
//      makeFixture() still gives a test its own fresh directory; what it
//      restores afterwards is THIS sandbox, never the real home.
//   2. Points what os.homedir() resolves to (USERPROFILE on Windows, HOME on
//      POSIX; both are set, plus HOMEDRIVE/HOMEPATH on Windows) at an EMPTY
//      directory inside the sandbox, and GIT_CONFIG_GLOBAL at a file there, so
//      a direct os.homedir() caller, git, and anything else that resolves "~"
//      sees an empty home, in this process and in every child. It is a separate
//      directory from the override's, on purpose: a caller that bypasses the
//      override then finds NOTHING (a test that needed fixture data fails and
//      names the bypass) instead of finding fixture data by luck.
//      Not touched: APPDATA, LOCALAPPDATA, XDG_*, TEMP/TMP, PATH. npm, git and
//      gh may keep their caches, credentials and executables there, and nothing
//      in the plugin reads them.
//   3. Arms a tripwire (tests/tripwire.mjs) on node:fs in this process: any
//      call whose path resolves under the real Claude config root(s), or the
//      real ~/.claude.json, THROWS (so the offending test fails at the call) and
//      is also recorded, and when the process exits it FAILS (exit code 1) if
//      anything was recorded, even if the plugin code swallowed the throw (most
//      of it fails open by design).
//   4. Arms the SAME tripwire in every node child, through NODE_OPTIONS
//      --import tests/child-guard.mjs. A child's violations go to a log in the
//      sandbox that the same exit handler reads, so a child that swallowed the
//      throw still fails the file that spawned it.
//   5. Removes the sandbox when the process exits, and at startup sweeps the
//      ones a killed run left behind (tests/sandbox-sweep.mjs).
//
// WHY THE FAILURE IS AN EXIT CODE, NOT A TEST HOOK. A root-level after() hook
// is attributed by node:test to THIS module (tests/isolate.mjs), not to the
// test file that did the touching. ci-local re-runs the file a failure names,
// so it re-ran isolate.mjs alone, which has no tests and passes, and classified
// the run FLAKY: non-blocking outside --ci-parity. A non-zero exit of the
// importing file's own process is attributed to that file, and the isolated
// re-run of that file fails again, so the outcome is FAIL in every mode.
//
// KNOWN LIMITS (what the child guard cannot see; none is reachable through the
// shared helpers, which merge over process.env).
//   - A child spawned with an explicit env that drops NODE_OPTIONS or the
//     AC_TEST_GUARD_* pair is not guarded. os.homedir() still lands in the
//     sandbox when HOME/USERPROFILE ride along; only an ABSOLUTE path into the
//     real home goes unwatched.
//   - A worker_threads Worker shares the parent's env but not its patched fs.
//     The plugin spawns none today.
//   - A non-node child (git, gh, ps, the claude binary, cmd.exe) cannot be
//     instrumented. git is pinned by HOME and GIT_CONFIG_GLOBAL; the rest are
//     covered only by the HOME/USERPROFILE pins.
//   - On POSIX, a child whose env drops HOME falls back to the passwd entry,
//     which is the real home. (On Windows the child keeps resolving the
//     parent's live USERPROFILE.) A runner's home is disposable in CI.
//   - audit-no-real-home.test.mjs replaces NODE_OPTIONS on purpose and brings
//     its own tracer.
//
// tests/audit-no-real-home.test.mjs is an independent tracer (its own preload)
// for the audit script. tests/isolation-guard.test.mjs asserts all of the above,
// and that every test file imports this module one way or the other.

import {
  mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { armTripwire, canon } from './tripwire.mjs';
import { sweepStaleSandboxes } from './sandbox-sweep.mjs';

const win = process.platform === 'win32';

// The operator's REAL home and .claude root(s), captured at module load —
// before any env is changed here, and before makeFixture() deletes
// CLAUDE_CONFIG_DIR. context.mjs's claudeDir() resolves CLAUDE_CONFIG_DIR first
// and only then <homedir()>/.claude, so a resolver that skipped the override
// could land under either. resolve() first: CLAUDE_CONFIG_DIR may be relative or
// carry a trailing "/" or "/.".
export const REAL_HOME = homedir();
export const REAL_CLAUDE = join(REAL_HOME, '.claude').replace(/\\/g, '/');
export const REAL_CLAUDE_DIRS = Object.freeze([...new Set([
  REAL_CLAUDE,
  ...(process.env.CLAUDE_CONFIG_DIR ? [resolve(process.env.CLAUDE_CONFIG_DIR).replace(/\\/g, '/')] : []),
].filter(Boolean))]);

// A state dir the operator pointed at on purpose (outside the temp area) is
// real state too. So is the Claude Code config file that sits next to ~/.claude.
const originalStateDir = process.env.AGENT_COMPANION_STATE_DIR
  ? resolve(process.env.AGENT_COMPANION_STATE_DIR).replace(/\\/g, '/')
  : null;
const underTmp = (p) => canon(p).startsWith(canon(tmpdir()) + '/');
const lexicalRoots = [
  ...REAL_CLAUDE_DIRS,
  join(REAL_HOME, '.claude.json').replace(/\\/g, '/'),
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

// The pid in the name lets a later run tell a live sandbox from one a killed
// run left behind (tests/sandbox-sweep.mjs).
sweepStaleSandboxes();
const sandbox = mkdtempSync(join(tmpdir(), `ac-suite-${process.pid}-`));
export const SANDBOX_DIR = sandbox;
process.env.AGENT_COMPANION_HOME_OVERRIDE = sandbox;
process.env.AGENT_COMPANION_STATE_DIR = join(sandbox, '.claude', 'agent-companion');
process.env.AGENT_COMPANION_DESKTOP_DIR = join(sandbox, 'desktop');
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_COMPANION_VAULT_DIR;

// What os.homedir() (and git's "~") resolve to: an empty directory, in this
// process and in every child.
export const SANDBOX_OS_HOME = join(sandbox, 'home');
mkdirSync(SANDBOX_OS_HOME, { recursive: true });
process.env.HOME = SANDBOX_OS_HOME;
process.env.USERPROFILE = SANDBOX_OS_HOME;
if (win) {
  const m = /^([A-Za-z]:)(.*)$/.exec(SANDBOX_OS_HOME);
  if (m) { process.env.HOMEDRIVE = m[1]; process.env.HOMEPATH = m[2]; }
}
// git also reads $XDG_CONFIG_HOME/git/config; naming the global file outright
// makes git ignore both that and ~/.gitconfig (git 2.32+; HOME covers older).
process.env.GIT_CONFIG_GLOBAL = join(SANDBOX_OS_HOME, '.gitconfig');
// An empty file, not a missing one: `git config --global --list` exits 128 on a missing file.
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

// --- the tripwire, in this process -------------------------------------------

const violations = [];
export function realHomeViolations() { return violations.slice(); }
export function clearRealHomeViolations() { violations.length = 0; }

armTripwire({
  roots: WATCHED_ROOTS,
  token: 'process',
  onViolation: (record) => { violations.push(record); },
});

// --- the same tripwire in every child process ---------------------------------
// Every node process a test spawns arms tests/child-guard.mjs (NODE_OPTIONS
// --import). It throws on a real-home access and appends to this log, which
// the root-level after() below reads.

export const CHILD_VIOLATION_LOG = join(sandbox, 'child-violations.log');
writeFileSync(CHILD_VIOLATION_LOG, '');
process.env.AC_TEST_GUARD_ROOTS = JSON.stringify(WATCHED_ROOTS);
process.env.AC_TEST_GUARD_LOG = CHILD_VIOLATION_LOG;
const childGuardImport = `--import "${pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'child-guard.mjs')).href}"`;
const priorNodeOptions = process.env.NODE_OPTIONS || '';
if (!priorNodeOptions.includes(childGuardImport)) {
  process.env.NODE_OPTIONS = `${priorNodeOptions} ${childGuardImport}`.trim();
}

export function childViolations() {
  try { return readFileSync(CHILD_VIOLATION_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
export function clearChildViolations() {
  try { writeFileSync(CHILD_VIOLATION_LOG, ''); } catch { /* best effort */ }
}

// A file whose test touched the real home fails even if the plugin code caught
// the throw. Runs when THIS process exits (the importing test file's own
// process), after every test; it reads the child log, then removes the sandbox
// the log lives in. process.exitCode = 1 is what makes node:test, and ci-local's
// isolated re-run of the file, report the file itself as failed (see the header).
process.on('exit', () => {
  try {
    const fromChildren = childViolations();
    if (violations.length || fromChildren.length) {
      const all = [...violations, ...fromChildren.map((l) => `child ${l}`)];
      console.error(`this test file touched the real Claude home ${all.length} time(s) (${violations.length} in-process, ${fromChildren.length} in child processes): ${[...new Set(all)].slice(0, 5).join('; ')}`);
      if (!process.exitCode) process.exitCode = 1;
    }
  } catch { /* reporting must not mask the run's own result */ }
  try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
});
