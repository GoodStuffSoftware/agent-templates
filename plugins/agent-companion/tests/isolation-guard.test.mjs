// The test suite must never read or write the operator's real Claude home.
//
// The bug this guards (card "Isolate agent-companion tests from the operator's
// real routing profile"): tests that skipped makeFixture() resolved
// AGENT_COMPANION_STATE_DIR to the real ~/.claude/agent-companion, read the
// operator's LIVE routing profile (rev 10, with rows), and about 13 routing
// tests failed on that machine while CI passed. Isolation is now the default of
// every test process (tests/isolate.mjs); this file proves it, and fails the
// suite if a test file stops opting in or the tripwire stops firing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  makeFixture, TESTS_DIR, PLUGIN_ROOT, REAL_CLAUDE_DIRS, childEnv,
} from './helpers.mjs';
import {
  SANDBOX_DIR, WATCHED_ROOTS, realHomeViolations, clearRealHomeViolations,
} from './isolate.mjs';

const canon = (s) => {
  const n = String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const under = (child, parent) => canon(child) === canon(parent) || canon(child).startsWith(`${canon(parent)}/`);
const underRealClaude = (p) => REAL_CLAUDE_DIRS.some((r) => under(p, r));

// --- every test file opts in ------------------------------------------------

// The module specifiers of a file's import statements, in source order. A
// regex over the statements is enough: this suite writes plain top-level ESM.
function importSpecifiers(src) {
  const out = [];
  const re = /^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

test('every test file imports the isolation module before any plugin code', () => {
  const offenders = [];
  for (const f of readdirSync(TESTS_DIR).filter((x) => x.endsWith('.test.mjs')).sort()) {
    const specs = importSpecifiers(readFileSync(join(TESTS_DIR, f), 'utf8'));
    const optIn = (s) => s === './helpers.mjs' || s === './isolate.mjs';
    const firstOptIn = specs.findIndex(optIn);
    // Anything relative that is not the opt-in itself is code that may read
    // state at load time (a plugin module, a fixture).
    const firstCode = specs.findIndex((s) => /^\.\.?\//.test(s) && !optIn(s));
    if (firstOptIn === -1) offenders.push(`${f}: imports neither ./helpers.mjs nor ./isolate.mjs`);
    else if (firstCode !== -1 && firstCode < firstOptIn) offenders.push(`${f}: imports ${specs[firstCode]} before ${specs[firstOptIn]}`);
  }
  assert.deepEqual(offenders, [], 'add `import \'./isolate.mjs\';` as the FIRST relative import (or import ./helpers.mjs first)');
});

// --- the process is sandboxed -----------------------------------------------

test('the process state paths point into the sandbox, never the real home', () => {
  const needed = ['AGENT_COMPANION_HOME_OVERRIDE', 'AGENT_COMPANION_STATE_DIR', 'AGENT_COMPANION_DESKTOP_DIR'];
  for (const k of needed) {
    const v = process.env[k];
    assert.ok(v, `${k} must be set in every test process`);
    assert.ok(!underRealClaude(v), `${k} resolves under the real Claude home`);
    assert.ok(under(v, tmpdir()), `${k} must live in the temp dir`);
  }
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'CLAUDE_CONFIG_DIR would redirect claudeDir() to a real directory');
  assert.equal(process.env.CLAUDE_PLUGIN_DATA, undefined);
  assert.ok(under(process.env.AGENT_COMPANION_STATE_DIR, SANDBOX_DIR));
});

test('the plugin resolves its state root and routing profile inside the sandbox', async () => {
  const ctx = await import(new URL('../hooks/lib/context.mjs', import.meta.url));
  assert.ok(under(ctx.stateRootPath(), SANDBOX_DIR), `state root is ${ctx.stateRootPath()}`);
  assert.ok(!underRealClaude(ctx.claudeDir()), 'claudeDir() must not be the real one');
  const store = await import(new URL('../scripts/lib/routing-profile-store.mjs', import.meta.url));
  const { profile } = store.profileFiles();
  assert.ok(under(profile, SANDBOX_DIR), `routing profile path is ${profile}`);
  assert.ok(!underRealClaude(profile));
});

test('makeFixture().cleanup() hands the sandbox back, not the real home', () => {
  const before = { ...process.env };
  const fx = makeFixture();
  assert.notEqual(process.env.AGENT_COMPANION_STATE_DIR, before.AGENT_COMPANION_STATE_DIR);
  fx.cleanup();
  for (const k of ['AGENT_COMPANION_HOME_OVERRIDE', 'AGENT_COMPANION_STATE_DIR', 'AGENT_COMPANION_DESKTOP_DIR']) {
    assert.equal(process.env[k], before[k], `${k} must be restored to the sandbox value`);
    assert.ok(process.env[k], `${k} must not become unset (unset means the real home)`);
  }
});

test('a child process spawned with the default env inherits the sandbox', () => {
  const probe = 'console.log(JSON.stringify([process.env.AGENT_COMPANION_STATE_DIR, process.env.AGENT_COMPANION_HOME_OVERRIDE]))';
  const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true, env: childEnv() });
  const [state, home] = JSON.parse(res.stdout);
  assert.equal(state, process.env.AGENT_COMPANION_STATE_DIR);
  assert.equal(home, process.env.AGENT_COMPANION_HOME_OVERRIDE);
});

// --- the tripwire -----------------------------------------------------------

test('the tripwire throws and records on any access under the real Claude home', () => {
  clearRealHomeViolations();
  const root = REAL_CLAUDE_DIRS[0];
  const probe = join(root, 'agent-companion', 'config', 'routing-profile.json');
  const writeProbe = join(root, 'agent-companion-guard-probe');
  assert.throws(() => existsSync(probe), /REAL Claude home/, 'a probe of the real routing profile must throw');
  assert.throws(() => readFileSync(probe), /REAL Claude home/);
  assert.throws(() => readdirSync(join(root, 'agent-companion')), /REAL Claude home/);
  assert.throws(() => mkdirSync(writeProbe, { recursive: true }), /REAL Claude home/);
  assert.equal(realHomeViolations().length, 4, 'each probe is recorded');
  clearRealHomeViolations();
  // The write was refused BEFORE it happened: ask a child (no tripwire) whether
  // the directory exists.
  const res = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("node:fs").existsSync(process.argv[1])))', writeProbe], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(res.stdout, 'false', 'the refused mkdir must not have created anything');
});

test('the tripwire leaves temp paths and a relative path alone', () => {
  clearRealHomeViolations();
  const d = mkdtempSync(join(tmpdir(), 'ac-guard-ok-'));
  try {
    mkdirSync(join(d, 'x'), { recursive: true });
    assert.equal(existsSync(join(d, 'x')), true);
    assert.equal(existsSync(resolve(PLUGIN_ROOT, 'scripts')), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.deepEqual(realHomeViolations(), []);
});

test('watched roots cover the real Claude home', () => {
  for (const r of REAL_CLAUDE_DIRS) assert.ok(WATCHED_ROOTS.includes(r), `${r} is not watched`);
});
