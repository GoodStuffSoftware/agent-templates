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

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(TESTS_DIR, '..');

const REAL_CLAUDE = join(homedir(), '.claude').replace(/\\/g, '/');

export function assertNotRealHome(p, label) {
  const norm = String(p || '').replace(/\\/g, '/');
  if (norm === REAL_CLAUDE || norm.startsWith(`${REAL_CLAUDE}/`)) {
    throw new Error(`test fixture guard: ${label} resolved under the REAL home (${p}) — refusing to continue`);
  }
}

// The operator's REAL .claude root(s), captured AT MODULE LOAD — i.e. before
// makeFixture() deletes CLAUDE_CONFIG_DIR from process.env. context.mjs's
// claudeDir() resolves CLAUDE_CONFIG_DIR first and only then falls back to
// <homedir()>/.claude, so a resolver that skipped the override could land under
// EITHER, and a leak detector has to watch both. assertNotRealHome() above
// deliberately keeps checking <homedir()>/.claude only, so its behaviour for
// its existing callers is unchanged.
// resolve() first: CLAUDE_CONFIG_DIR may be relative, or carry a trailing "/"
// or "/.". A relative root left as-is would match nearly every fixture path and
// turn the leak detector into a blanket failure.
export const REAL_CLAUDE_DIRS = Object.freeze([...new Set([
  REAL_CLAUDE,
  ...(process.env.CLAUDE_CONFIG_DIR
    ? [resolve(process.env.CLAUDE_CONFIG_DIR).replace(/\\/g, '/')]
    : []),
].filter(Boolean))]);

const ENV_KEYS = ['AGENT_COMPANION_HOME_OVERRIDE', 'AGENT_COMPANION_STATE_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR'];

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
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_CONFIG_DIR;

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
    cwd: cwd || PLUGIN_ROOT,
    env: { ...process.env, ...env },
    timeout,
  });
  const out = (res.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { /* not JSON: leave null */ } }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json, error: res.error };
}

// Run any plugin script (not just a hook) as a child process with CLI args,
// no stdin payload. Same shape as runHook but for scripts that take argv
// instead of a JSON payload on stdin (e.g. memory-vault.mjs, memory-doctor.mjs).
export function runScript(scriptRelPath, args = [], { env = {}, cwd, timeout = 15000 } = {}) {
  const script = join(PLUGIN_ROOT, scriptRelPath);
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: cwd || PLUGIN_ROOT,
    env: { ...process.env, ...env },
    timeout,
    windowsHide: true,
  });
  const out = (res.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { /* not JSON: leave null */ } }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json, error: res.error };
}

export function readJsonl(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
