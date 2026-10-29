// Shared fixture helper for agent-companion's test suite.
//
// HARD RULE (see the plugin's HARD CONSTRAINTS): no test may touch the real
// ~/.claude. Every fixture sets AGENT_COMPANION_HOME_OVERRIDE and
// AGENT_COMPANION_STATE_DIR to a fresh temp directory and deletes
// CLAUDE_PLUGIN_DATA / CLAUDE_CONFIG_DIR unless the test sets them back
// deliberately. assertNotRealHome() below is the guard: it throws if a
// resolved path would land under the REAL os.homedir()/.claude, so a bug in a
// resolver fails LOUDLY in the test run rather than silently writing into the
// operator's real data.

// FIRST import, on purpose: it sandboxes the process's state paths and arms the
// real-home tripwire before any other module reads them (see isolate.mjs).
import { REAL_CLAUDE, REAL_CLAUDE_DIRS } from './isolate.mjs';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { REAL_CLAUDE_DIRS };

// os.tmpdir() spelled the way git and realpath spell it. On a hosted Windows
// runner tmpdir() returns the 8.3 short form (RUNNER~1 in the user profile)
// while git, realpath and process.cwd() return the long form, so a test that
// compares a path it built from tmpdir() with one a tool reported fails on a
// path that is the same.
export function realTmpdir() {
  try { return realpathSync.native(tmpdir()); } catch { return tmpdir(); }
}

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(TESTS_DIR, '..');

export function assertNotRealHome(p, label) {
  const norm = String(p || '').replace(/\\/g, '/');
  if (norm === REAL_CLAUDE || norm.startsWith(`${REAL_CLAUDE}/`)) {
    throw new Error(`test fixture guard: ${label} resolved under the REAL home (${p}) — refusing to continue`);
  }
}

const ENV_KEYS = ['AGENT_COMPANION_HOME_OVERRIDE', 'AGENT_COMPANION_STATE_DIR', 'AGENT_COMPANION_DESKTOP_DIR', 'AGENT_COMPANION_VAULT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR'];

// Fresh temp dir + the standard env overrides. Returns { dir, stateDir,
// cleanup() }. Call cleanup() in a `finally` (or node:test's `after`) —
// it restores whatever these env vars were before and removes the temp dir.
export function makeFixture() {
  const dir = mkdtempSync(join(realTmpdir(), `ac-test-${process.pid}-`)); // pid in the name: see sandbox-sweep.mjs
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  const stateDir = join(dir, '.claude', 'agent-companion');
  process.env.AGENT_COMPANION_HOME_OVERRIDE = dir;
  process.env.AGENT_COMPANION_STATE_DIR = stateDir;
  process.env.AGENT_COMPANION_DESKTOP_DIR = join(dir, 'desktop');
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_CONFIG_DIR;
  // An operator's own vault override must never steer a test's vault.
  delete process.env.AGENT_COMPANION_VAULT_DIR;

  assertNotRealHome(dir, 'AGENT_COMPANION_HOME_OVERRIDE');
  assertNotRealHome(stateDir, 'AGENT_COMPANION_STATE_DIR');

  function cleanup() {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }

  return { dir, stateDir, cleanup };
}

// Where a spawned hook or script runs when the test names no cwd: inside the active
// sandbox home (the fixture's, or the process sandbox's), never in the checkout.
// Some hooks walk UP from their cwd looking for .claude/settings*.json
// (hooks/bash-tail.mjs does, and stops only at the home override). From the
// checkout, which on a developer machine sits under the operator's real home,
// that walk reaches ~/.claude/settings.json and the hook's result then depends
// on the operator's own permission rules; CI, where the checkout is elsewhere,
// would not. Inside the sandbox the walk ends at the sandbox.
// Scripts have the same exposure: scripts/detect.mjs derives its dev roots from
// the cwd (the git main checkout's parent, then ~/dev), so from the checkout it
// reads the operator's real project folders. A test that needs the plugin root
// as its cwd says so with an explicit `cwd`.
function hookCwd(env) {
  return env.AGENT_COMPANION_HOME_OVERRIDE || process.env.AGENT_COMPANION_HOME_OVERRIDE || PLUGIN_ROOT;
}

// Run a hook (or any plugin script) as a child process with a JSON payload on
// stdin — the same shape the real harness uses. `env` is merged OVER the
// current process.env, so AGENT_COMPANION_* overrides set by makeFixture()
// carry through unless explicitly overridden here.
//
// `args` passes argv through to the script. Hooks that serve more than one
// event take the event name from argv rather than sniffing the payload (see
// hooks/standing-rules.mjs and hooks/subagent-brevity.mjs), so a test that
// cannot set argv cannot reach either of their branches.
export function runHook(hookRelPath, payload, { env = {}, cwd, timeout = 15000, args = [] } = {}) {
  const script = join(PLUGIN_ROOT, hookRelPath);
  const res = spawnSync(process.execPath, [script, ...args], {
    windowsHide: true,
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd || hookCwd(env),
    env: childEnv(env),
    timeout,
  });
  const out = (res.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { /* not JSON: leave null */ } }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json, error: res.error };
}

// The runner's own env, minus what Claude Code sets per session: a suite run
// from inside a session inherits CLAUDE_CODE_SESSION_ATTENDED ("1" attended,
// "0" under `claude -p`), which would decide the delegation guard's scope
// for every test. A test that needs it passes it in `env`.
export function childEnv(env = {}) {
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ATTENDED;
  // The entrypoint and the CLI path say whether the harness backgrounds the main conversation's subagents
  // itself (desktop and VS Code from 2.1.302; hooks/lib/harness-bg.mjs), which switches the foreground fix
  // off: a suite run from a desktop session must not decide that for every test.
  delete base.CLAUDE_CODE_ENTRYPOINT;
  delete base.CLAUDE_CODE_EXECPATH;
  // A cloud session sets CLAUDE_CODE_REMOTE=true, which switches the resource gate and the machine-local
  // session lines off: a suite run from one must not do that to every test (tests set it when they mean it).
  delete base.CLAUDE_CODE_REMOTE;
  // type_line_required defaults to deny in the plugin; most spawn-guard tests
  // spawn ladder rungs without a TYPE: line and are not about that rule, so
  // children run with it off unless a test sets it (tests/type-required.test.mjs).
  // resource_gate defaults to deny: a hook test that runs `npm test` through
  // bash-tail is not about the gate, so children run with it off unless a test
  // sets it (tests/resource-gate*.test.mjs).
  // The shared-resources session line reads the machine-wide ledger: a suite run
  // under ci-local (which holds a lease there) would see it in every hook that adds
  // context. Children get an empty ledger of their own unless a test passes CI_BUDGET_DIR.
  return { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: 'off', CLAUDE_PLUGIN_OPTION_RESOURCE_GATE: 'off', ...base, CI_BUDGET_DIR: emptyLedger(), ...env };
}

let emptyLedgerDir = null;
function emptyLedger() {
  if (!emptyLedgerDir) {
    emptyLedgerDir = mkdtempSync(join(tmpdir(), 'ac-test-ledger-'));
    process.on('exit', () => { try { rmSync(emptyLedgerDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return emptyLedgerDir;
}

// What a PreToolUse hook's stdout decided: its permissionDecision ('deny',
// 'ask', 'allow') when it set one; 'proceed' when it printed JSON with NO
// decision (the call goes on through the normal permission flow — the shape
// every advisory and let-through path uses, since "allow" would also skip the
// permission prompt); null when it printed nothing.
export function decisionOf(json) {
  if (!json) return null;
  return json.hookSpecificOutput?.permissionDecision ?? 'proceed';
}

// A hang guard for a child that runs a CHAIN of git processes (a first
// memory-vault sync starts about 13 of them in series, plus its own node).
// Measured on the Windows dev box, 2026-09-25:
//   - alone: about 1.3 s for a first sync;
//   - in a passing full-suite run (node --test's default concurrency, one
//     test file per core): about 3 s, the whole 4-sync test 6.4 s;
//   - in the failing gate runs: the same sync passed 15 s. Every git-heavy
//     test in the suite was 4-5x slower in the same window (memory-scope's
//     worktree test 13 s against 2.9 s), so git process creation was taking
//     over 1 s per process. Injecting 1.3 s of latency before each git call
//     reproduces those failures exactly (empty stderr, no status file, 15.0 s).
// So 15 s was a hang guard sized for one fast process, and it killed a
// sync that was only slow. This budget is about 8x the worst observed
// in-suite duration. It exists to catch a sync that HANGS; a result from a
// killed child is reported as a timeout (timedOut, below), never as a sync
// outcome.
export const GIT_CHAIN_TIMEOUT_MS = 120000;

// Run any plugin script (not just a hook) as a child process with CLI args,
// no stdin payload. Same shape as runHook but for scripts that take argv
// instead of a JSON payload on stdin (e.g. memory-vault.mjs, memory-doctor.mjs).
// `timedOut` is true when the child was killed by `timeout`: its stdout and
// exit status are then not the script's answer.
export function runScript(scriptRelPath, args = [], { env = {}, cwd, timeout = 15000 } = {}) {
  const script = join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: cwd || hookCwd(env),
    env: childEnv(env),
    timeout,
    windowsHide: true,
  });
  const out = (res.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { /* not JSON: leave null */ } }
  const timedOut = res.error?.code === 'ETIMEDOUT';
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json, error: res.error, timedOut };
}

export function readJsonl(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
