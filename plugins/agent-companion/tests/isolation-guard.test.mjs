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
import {
  readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  makeFixture, TESTS_DIR, PLUGIN_ROOT, REAL_CLAUDE_DIRS, childEnv,
} from './helpers.mjs';
import {
  SANDBOX_DIR, WATCHED_ROOTS, realHomeViolations, clearRealHomeViolations, childViolations, clearChildViolations,
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
  // READ probes first: if the tripwire is not armed they fail the test before
  // anything is written to the real home.
  assert.throws(() => existsSync(probe), /REAL Claude home/, 'a probe of the real routing profile must throw');
  assert.throws(() => readFileSync(probe), /REAL Claude home/);
  assert.throws(() => readdirSync(join(root, 'agent-companion')), /REAL Claude home/);
  // The write-side wrappers, probed with calls that create nothing even when
  // the tripwire is somehow off (removing a path that does not exist).
  const missing = join(root, 'agent-companion-guard-probe-does-not-exist');
  assert.throws(() => rmSync(missing, { force: true }), /REAL Claude home/);
  assert.throws(() => unlinkSync(missing), /REAL Claude home/);
  assert.equal(realHomeViolations().length, 5, 'each probe is recorded');
  clearRealHomeViolations();
});

test('the .native variants of realpath are wrapped too', () => {
  clearRealHomeViolations();
  assert.throws(() => realpathSync.native(join(REAL_CLAUDE_DIRS[0], 'x')), /REAL Claude home/);
  clearRealHomeViolations();
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

// --- the operator's home directory, in this process and in children ----------

const insideSandbox = (p) => under(p, SANDBOX_DIR);
const nodeChild = (script, extra = {}) => spawnSync(process.execPath, ['-e', script], {
  encoding: 'utf8', windowsHide: true, env: childEnv(extra),
});

test('os.homedir() resolves inside the sandbox, here and in a child', () => {
  assert.ok(insideSandbox(homedir()), `os.homedir() is ${homedir()}, outside ${SANDBOX_DIR}`);
  assert.ok(!underRealClaude(join(homedir(), '.claude')), 'the home is not the operator\'s');
  assert.equal(existsSync(join(homedir(), '.claude')), false, 'the sandbox home starts empty');
  const res = nodeChild('console.log(JSON.stringify([require("os").homedir(), process.env.HOME, process.env.USERPROFILE, process.env.GIT_CONFIG_GLOBAL]))');
  assert.equal(res.status, 0, res.stderr);
  const [home, HOME, USERPROFILE, gitGlobal] = JSON.parse(res.stdout);
  assert.ok(insideSandbox(home), `a child's os.homedir() is ${home}`);
  assert.ok(insideSandbox(HOME) && insideSandbox(USERPROFILE), 'HOME and USERPROFILE both point into the sandbox');
  assert.ok(insideSandbox(gitGlobal), 'git is told its global config lives in the sandbox');
  assert.notEqual(canon(home), canon(process.env.AGENT_COMPANION_HOME_OVERRIDE), 'the OS home is not the override: a caller that bypasses the override finds nothing');
});

test('a grandchild (node spawning node) is sandboxed and guarded too', () => {
  clearChildViolations();
  try {
    const target = join(REAL_CLAUDE_DIRS[0], 'settings.json');
    // The grandchild reads the real settings.json and swallows the throw, as
    // fail-open plugin code does; it reports its os.homedir() and whether the
    // read threw. Only the NODE_OPTIONS preload can make that read throw.
    const inner = `let threw = false; try { require("fs").readFileSync(${JSON.stringify(target)}); } catch (e) { threw = /REAL Claude home/.test(String(e.message)); } console.log(JSON.stringify([require("os").homedir(), threw]))`;
    const res = nodeChild(`const r = require("child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(inner)}], { encoding: "utf8" }); process.stdout.write(r.stdout)`);
    assert.equal(res.status, 0, res.stderr);
    const [home, threw] = JSON.parse(res.stdout);
    assert.ok(insideSandbox(home), `a grandchild's os.homedir() is ${home}`);
    assert.equal(threw, true, 'the grandchild read of the real settings.json must throw');
    const rows = childViolations();
    assert.equal(rows.length, 1, `one record from the grandchild in the log: ${JSON.stringify(rows)}`);
    assert.match(rows[0], /fs\.readFileSync .*settings\.json/);
  } finally {
    clearChildViolations(); // the exit handler would otherwise fail this file
  }
});

test('a child that touches the real Claude home is stopped, and the access is on record even when the child swallows the throw', () => {
  clearChildViolations();
  try {
    const target = join(REAL_CLAUDE_DIRS[0], 'settings.json');
    // The child catches the throw and exits 0, exactly as fail-open plugin code does.
    const res = nodeChild(`let threw = false; try { require("fs").readFileSync(${JSON.stringify(target)}); } catch (e) { threw = /REAL Claude home/.test(String(e.message)); } process.exit(threw ? 0 : 3)`);
    assert.equal(res.status, 0, `the child's read of the real settings.json must throw (exit ${res.status}): ${res.stderr}`);
    const rows = childViolations();
    assert.equal(rows.length, 1, `one record in the child log: ${JSON.stringify(rows)}`);
    assert.match(rows[0], /fs\.readFileSync .*settings\.json/);
    assert.equal(realHomeViolations().length, 0, 'the parent itself touched nothing');
  } finally {
    clearChildViolations(); // the exit handler would otherwise fail this file
  }
});

test('a child process arms nothing when the guard env is absent (the preload is inert on its own)', () => {
  const env = childEnv();
  delete env.AC_TEST_GUARD_ROOTS;
  delete env.AC_TEST_GUARD_LOG;
  const res = spawnSync(process.execPath, ['-e', 'console.log(String(require("fs").readFileSync.__acGuards))'], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'undefined');
});

// Git for Windows and git on POSIX both read ~/.gitconfig and
// $XDG_CONFIG_HOME/git/config. A test that makes a commit must get its identity
// from the test, not from whoever runs it.
const HAVE_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
test('git in a child sees an empty global config, not the operator\'s ~/.gitconfig', { skip: !HAVE_GIT && 'git is not installed' }, () => {
  const global = spawnSync('git', ['config', '--global', '--list', '--show-origin'], { encoding: 'utf8', windowsHide: true, env: childEnv() });
  assert.equal((global.stdout || '').trim(), '', `git's global config must be empty, got: ${global.stdout}`);
  assert.equal(global.status === 0 || global.status === 1, true, `git config --global --list exited ${global.status}: ${global.stderr}`);
  const ident = spawnSync('git', ['config', '--global', '--get', 'user.email'], { encoding: 'utf8', windowsHide: true, env: childEnv() });
  assert.equal((ident.stdout || '').trim(), '', 'the operator\'s git identity must not leak in');
});

// --- a violation fails the file that caused it ------------------------------
//
// A root after() hook was attributed by node:test to tests/isolate.mjs, whose
// isolated re-run (ci-local re-runs the file a failure names) passes: the run
// came out FLAKY, which does not block outside --ci-parity. isolate.mjs now
// fails the importing file's own process instead. These tests run a throwaway
// test file that swallows a real-home read.

// The throwaway file's "real home" is THIS process's sandbox home: isolate.mjs
// takes REAL_HOME from os.homedir() at load, which is the HOME this process
// exported. So nothing here touches the operator's actual home.
const probeRoot = join(SANDBOX_DIR, 'violation-probe');
const probeFile = join(probeRoot, 'swallow.test.mjs');
const probeTarget = join(homedir(), '.claude', 'settings.json');
function writeProbe() {
  mkdirSync(probeRoot, { recursive: true });
  writeFileSync(probeFile, [
    `import ${JSON.stringify(pathToFileURL(join(TESTS_DIR, 'isolate.mjs')).href)};`,
    "import test from 'node:test';",
    "import { statSync } from 'node:fs';",
    "test('reads the watched path and swallows the throw, like fail-open plugin code', () => {",
    '  try { statSync(process.env.PROBE_TARGET); } catch { /* swallowed */ }',
    '});',
    '',
  ].join('\n'));
}
// Inside a test file node sets NODE_TEST_CONTEXT, and a nested `node --test`
// then refuses to run files ("run() is being called recursively"): drop it.
const probeEnv = (target) => {
  const env = childEnv({ PROBE_TARGET: target });
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const nodeTest = (target) => spawnSync(process.execPath, ['--test', probeFile], {
  cwd: probeRoot, encoding: 'utf8', windowsHide: true, timeout: 120000, env: probeEnv(target),
});

test('a test file whose code swallowed a real-home read exits non-zero, and a re-run of that file fails again', () => {
  writeProbe();
  const harmless = nodeTest(join(SANDBOX_DIR, 'not-watched'));
  assert.equal(harmless.status, 0, `control: the same file without a violation passes: ${harmless.stdout}${harmless.stderr}`);
  for (const attempt of ['full run', 'isolated re-run']) {
    const res = nodeTest(probeTarget);
    assert.notEqual(res.status, 0, `${attempt}: the violation must fail the file: ${res.stdout}${res.stderr}`);
    assert.match(`${res.stdout}${res.stderr}`, /touched the real Claude home 1 time/, `${attempt}: the message names the access`);
  }
});

const CI_LOCAL = resolve(PLUGIN_ROOT, '..', '..', 'scripts', 'ci-local.mjs');
test('ci-local classifies that file as a FAIL, not as flaky', { skip: !existsSync(CI_LOCAL) && 'scripts/ci-local.mjs is not part of this tree' }, async () => {
  writeProbe();
  const { runTestSuite } = await import(pathToFileURL(CI_LOCAL).href);
  const spawnNode = (args, cwd, env) => {
    const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { status: r.status === null ? 1 : r.status };
  };
  const env = probeEnv(probeTarget);
  const logs = [];
  const result = runTestSuite({
    files: [probeFile], cwd: probeRoot, env, ciParity: false, concurrency: 1, log: (m) => logs.push(m), spawnNode,
  });
  assert.equal(result.outcome, 'fail', `outcome ${result.outcome}: ${JSON.stringify(result)} ${logs.join(' ')}`);
  assert.equal(result.status, 1);
  assert.deepEqual(result.flakyFiles, []);
  assert.deepEqual(result.failedFiles.map((f) => f.replace(/[\\]/g, '/')), ['swallow.test.mjs']);
});
