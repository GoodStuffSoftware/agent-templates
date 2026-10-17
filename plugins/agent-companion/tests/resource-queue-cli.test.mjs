// scripts/resource-queue.mjs as a real process: `run` (exit-code passthrough, quoting as exact argv
// and as one shell string through Git Bash, the nested-run token, RESOURCE_QUEUE=0 and
// CI_LOCAL_LOCK=0, the bounded wait) and `status --json`. Every process gets its own ledger,
// legacy lock dir and claude dir under the temp dir; nothing touches the real ones. The children
// are short node/bash one-liners and never open a window (windowsHide on every spawn).

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireResources } from '../scripts/ci-budget.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'resource-queue.mjs');
const NODE = process.execPath;
const fwd = (p) => p.replace(/\\/g, '/');

// Git Bash for the single-string tests: the configured one, else the usual install, else sh on POSIX.
function findBash() {
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured && existsSync(configured)) return configured;
  if (process.platform !== 'win32') return '/bin/sh';
  for (const p of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']) if (existsSync(p)) return p;
  return null;
}
const BASH = findBash();

function box() {
  const root = mkdtempSync(join(tmpdir(), 'rq cli ')); // a space on purpose
  const b = {
    root, ledger: join(root, 'ledger'), legacy: join(root, 'legacy'), cfg: join(root, 'cfg'),
    env: {},
  };
  b.env = {
    ...process.env,
    CI_BUDGET_DIR: b.ledger, CI_LOCAL_LOCK_DIR: b.legacy, CLAUDE_CONFIG_DIR: b.cfg,
    CI_LOCAL_BUDGET_POLL_MS: '100', CI_LOCAL_BUDGET: '16',
  };
  for (const k of ['RESOURCE_QUEUE', 'CI_LOCAL_LOCK', 'AC_RESOURCE_LEASE', 'AC_RESOURCE_RULES', 'CI_BUDGET_RESOURCES']) delete b.env[k];
  if (BASH) b.env.CLAUDE_CODE_GIT_BASH_PATH = BASH;
  b.run = (args, extraEnv = {}, opts = {}) => spawnSync(NODE, [CLI, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...b.env, ...extraEnv }, timeout: 60_000, ...opts,
  });
  b.script = (name, body) => { const f = join(root, name); writeFileSync(f, body); return f; };
  b.done = () => rmSync(root, { recursive: true, force: true });
  return b;
}

// ---------------------------------------------------------------- exit codes

test('run: the exit code of the command is the exit code of the run, and output passes through', () => {
  const b = box();
  try {
    for (const code of [0, 1, 7, 42, 255]) {
      const r = b.run(['run', '--resource', 'box:1', '--', NODE, '-e', `console.log('out-${code}'); console.error('err-${code}'); process.exit(${code})`]);
      assert.equal(r.status, code, `exit ${code}`);
      assert.equal(r.stdout.trim(), `out-${code}`);
      assert.match(r.stderr, new RegExp(`err-${code}`));
    }
    assert.deepEqual(readdirSync(b.ledger).filter((n) => /^(lease|ticket)-/.test(n)), [], 'every lease is released on exit');
  } finally { b.done(); }
});

test('run: a command that cannot start is 127 with one line, and the lease is released', () => {
  const b = box();
  try {
    const r = b.run(['run', '--resource', 'box:1', '--', 'definitely-not-a-command-rq']);
    assert.equal(r.status, 127);
    assert.match(r.stderr, /cannot start "definitely-not-a-command-rq": command not found/);
    assert.deepEqual(readdirSync(b.ledger).filter((n) => /^(lease|ticket)-/.test(n)), []);
  } finally { b.done(); }
});

test('run: usage errors are exit 2 and never start the command', () => {
  const b = box();
  try {
    for (const args of [[], ['run'], ['run', '--resource', 'box:1'], ['run', '--resource', 'box:1', '--'], ['run', '--', 'x'], ['run', '--bogus', '--', 'x'], ['frobnicate'], ['run', '--class', 'nope', '--', 'x'], ['run', '--resource', 'a b', '--', 'x']]) {
      const r = b.run(args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /usage:/);
    }
  } finally { b.done(); }
});

// ---------------------------------------------------------------- quoting

test('run: several arguments after -- reach the program as an exact argv (no shell, quoting kept)', () => {
  const b = box();
  try {
    const dump = b.script('argv-dump.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const args = ['a b', 'c"d', "e'f", '$HOME', 'x && y', '', '*', 'pipe|char', 'semi;colon', '--flag=1 2', '(paren)', 'C:\\dir with space\\', '日本語'];
    const r = b.run(['run', '--resource', 'box:1', '--', NODE, dump, ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
  } finally { b.done(); }
});

test('run: one argument with shell syntax runs through Git Bash: pipes, quotes, && and spaces survive', { skip: BASH ? false : 'no bash available' }, () => {
  const b = box();
  try {
    let r = b.run(['run', '--resource', 'box:1', '--', 'echo "a && b" | cat; exit 7']);
    assert.equal(r.status, 7, r.stderr);
    assert.equal(r.stdout.trim(), 'a && b');

    writeFileSync(join(b.root, 'marker.txt'), 'found-it\n');
    r = b.run(['run', '--resource', 'box:1', '--', `cd "${fwd(b.root)}" && cat marker.txt && echo 'single quoted $NOT_EXPANDED' && echo "double $ZZ_RQ"`], { ZZ_RQ: 'expanded' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['found-it', 'single quoted $NOT_EXPANDED', 'double expanded']);

    r = b.run(['run', '--resource', 'box:1', '--', 'false || echo recovered; test -n "$AC_RESOURCE_LEASE" && echo token-set']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['recovered', 'token-set'], 'the shell sees the nested-run token');

    r = b.run(['run', '--resource', 'box:1', '--', 'exit 3']);
    assert.equal(r.status, 3, 'a bare exit in the shell string is the run exit code');
  } finally { b.done(); }
});

// ---------------------------------------------------------------- nested run token

test('run: the child gets a token naming a live lease, and a nested run for the same resources does not queue behind its parent', () => {
  const b = box();
  try {
    const nested = b.script('nested.mjs', `
      import { spawnSync, execFileSync } from 'node:child_process';
      import { readdirSync } from 'node:fs';
      const token = process.env.AC_RESOURCE_LEASE;
      const live = readdirSync(process.env.CI_BUDGET_DIR).includes('lease-' + token + '.json');
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'run', '--resource', 'app-e2e', '--max-wait', '30', '--', process.execPath, '-e', 'console.log("inner ran")'], { encoding: 'utf8', windowsHide: true, env: process.env });
      console.log(JSON.stringify({ token, live, status: r.status, out: r.stdout.trim(), err: r.stderr.trim(), ms: Date.now() - t0 }));
    `);
    const r = b.run(['run', '--resource', 'box:2', '--resource', 'app-e2e', '--', NODE, nested]);
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.match(got.token, /^[0-9a-f]{12}$/);
    assert.equal(got.live, true, 'the token is the id of a lease file that exists while the child runs');
    assert.equal(got.status, 0);
    assert.equal(got.out, 'inner ran');
    assert.match(got.err, /already held by this process tree/);
    assert.ok(got.ms < 25_000, `the inner run did not wait (${got.ms} ms)`);
  } finally { b.done(); }
});

test('run: without the token the same nested run queues behind its parent (control for the test above)', () => {
  const b = box();
  try {
    const nested = b.script('nested-no-token.mjs', `
      import { spawnSync } from 'node:child_process';
      const env = { ...process.env }; delete env.AC_RESOURCE_LEASE;
      const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'run', '--resource', 'app-e2e', '--max-wait', '1', '--', process.execPath, '-e', 'console.log("inner ran")'], { encoding: 'utf8', windowsHide: true, env });
      console.log(JSON.stringify({ status: r.status, err: r.stderr.trim() }));
    `);
    const r = b.run(['run', '--resource', 'app-e2e', '--', NODE, nested]);
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.match(got.err, /waiting, position 1/);
    assert.match(got.err, /running over budget/);
  } finally { b.done(); }
});

test('run: a nested run asking for more than its parent holds queues for the rest only', () => {
  const b = box();
  try {
    const nested = b.script('nested-part.mjs', `
      import { spawnSync } from 'node:child_process';
      const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'run', '--resource', 'box:1', '--resource', 'pool:1', '--max-wait', '30', '--', process.execPath, '-e', 'console.log("ok")'], { encoding: 'utf8', windowsHide: true, env: process.env });
      console.log(JSON.stringify({ status: r.status, err: r.stderr.trim() }));
    `);
    const r = b.run(['run', '--resource', 'box:4', '--', NODE, nested]);
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.equal(got.status, 0);
    assert.match(got.err, /part of the request is already held.*queueing only for pool:1/);
  } finally { b.done(); }
});

// ---------------------------------------------------------------- opt-outs

test('RESOURCE_QUEUE=0 and CI_LOCAL_LOCK=0 run the command at once: no lease, no token, whatever is held', async () => {
  const b = box();
  const holder = await acquireResources({
    dir: b.ledger, env: b.env, legacyDir: b.legacy, resources: { 'app-e2e': 1 }, label: 'blocker', heartbeat: 'off', registerExit: false, log: () => {},
  });
  try {
    const probe = ['run', '--resource', 'app-e2e', '--resource', 'box:4', '--', NODE, '-e', 'console.log(process.env.AC_RESOURCE_LEASE ?? "no-token"); process.exit(3)'];
    for (const optOut of [{ RESOURCE_QUEUE: '0' }, { CI_LOCAL_LOCK: '0' }]) {
      const t0 = Date.now();
      const r = b.run(probe, optOut);
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.stdout.trim(), 'no-token', `${Object.keys(optOut)[0]}=0 hands out no token`);
      assert.ok(Date.now() - t0 < 20_000, 'did not wait for the holder');
      assert.doesNotMatch(r.stderr, /waiting/);
      assert.equal(readdirSync(b.ledger).filter((n) => /^lease-.*\.json$/.test(n)).length, 1, 'only the blocker has a lease');
      assert.equal(readdirSync(b.ledger).filter((n) => /^ticket-/.test(n)).length, 0);
    }
    // Control: the same request without the opt-out does wait on the holder.
    const waited = b.run(['run', '--resource', 'app-e2e', '--max-wait', '1', '--', NODE, '-e', 'console.log("went")']);
    assert.equal(waited.status, 0);
    assert.match(waited.stderr, /waiting, position 1.*app-e2e 1\/1 held by pid/);
    assert.match(waited.stderr, /running over budget/);
  } finally {
    holder.release();
    b.done();
  }
});

test('run: a value other than 0 in RESOURCE_QUEUE does not opt out', async () => {
  const b = box();
  const holder = await acquireResources({
    dir: b.ledger, env: b.env, legacyDir: b.legacy, resources: { 'app-e2e': 1 }, heartbeat: 'off', registerExit: false, log: () => {},
  });
  try {
    const r = b.run(['run', '--resource', 'app-e2e', '--max-wait', '1', '--', NODE, '-e', 'process.exit(0)'], { RESOURCE_QUEUE: '1' });
    assert.match(r.stderr, /waiting/);
  } finally { holder.release(); b.done(); }
});

// ---------------------------------------------------------------- status

test('status --json prints the schema-v1 object of the ledger; --resource filters; text form is the default', async () => {
  const b = box();
  const holder = await acquireResources({
    dir: b.ledger, env: b.env, legacyDir: b.legacy, box: 3, resources: { 'app-e2e': 1 }, label: 'cli-holder', heartbeat: 'off', registerExit: false, log: () => {},
  });
  try {
    const r = b.run(['status', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(r.stdout);
    assert.equal(st.schema, 'resource-queue-status');
    assert.equal(st.schemaVersion, 1);
    assert.equal(st.ok, true);
    assert.equal(st.dir, b.ledger);
    assert.equal(st.machine.busyCores, null, 'no cpu sample unless --sample');
    const names = st.resources.map((x) => x.name);
    assert.ok(names.includes('box') && names.includes('app-e2e'));
    assert.equal(st.resources.find((x) => x.name === 'app-e2e').holders[0].label, 'cli-holder');
    assert.equal(st.resources.find((x) => x.name === 'box').held, 3);

    const only = JSON.parse(b.run(['status', '--json', '--resource', 'app-e2e']).stdout);
    assert.deepEqual(only.resources.map((x) => x.name), ['app-e2e']);

    const sampled = JSON.parse(b.run(['status', '--json', '--sample']).stdout);
    assert.equal(typeof sampled.machine.busyCores, 'number');

    const text = b.run(['status']);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Resource queue \(ledger /);
    assert.match(text.stdout, /app-e2e: 1\/1 held, 0 free/);
    assert.match(text.stdout, /\[cli-holder\]/);
    assert.equal(b.run(['status', '--nonsense']).status, 2);
  } finally { holder.release(); b.done(); }
});

test('status on an empty or missing ledger is ok and has the same shape; sweep says there is nothing to clear', () => {
  const b = box();
  try {
    const st = JSON.parse(b.run(['status', '--json']).stdout);
    assert.equal(st.ok, true);
    assert.equal(st.resources[0].name, 'box');
    assert.deepEqual(st.queue, []);
    assert.deepEqual(st.recentClears, []);
    const sweep = b.run(['sweep']);
    assert.equal(sweep.status, 0);
    assert.equal(sweep.stdout.trim(), 'nothing to clear');
  } finally { b.done(); }
});

test('install-launcher writes the stable path under the claude dir', () => {
  const b = box();
  try {
    const r = b.run(['install-launcher']);
    assert.equal(r.status, 0, r.stderr);
    const path = join(b.cfg, 'agent-companion', 'bin', 'resource-queue.mjs');
    assert.ok(existsSync(path));
    assert.match(r.stdout, /resource-queue\.mjs: written/);
    assert.match(b.run(['install-launcher']).stdout, /: current/);
  } finally { b.done(); }
});
