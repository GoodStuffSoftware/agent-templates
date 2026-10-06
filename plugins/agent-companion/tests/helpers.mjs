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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { REAL_CLAUDE_DIRS };

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
  const dir = mkdtempSync(join(tmpdir(), 'ac-test-'));
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

// Where a spawned hook runs when the test names no cwd: inside the active
// sandbox home (the fixture's, or the process sandbox's), never in the checkout.
// Some hooks walk UP from their cwd looking for .claude/settings*.json
// (hooks/bash-tail.mjs does, and stops only at the home override). From the
// checkout, which on a developer machine sits under the operator's real home,
// that walk reaches ~/.claude/settings.json and the hook's result then depends
// on the operator's own permission rules; CI, where the checkout is elsewhere,
// would not. Inside the sandbox the walk ends at the sandbox.
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
  return { ...base, ...env };
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
    cwd: cwd || PLUGIN_ROOT,
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
