// scripts/ci-local.mjs headroom for hooks: below-normal priority that the suite
// processes and their children inherit, and long passes run in slices that each
// re-sample the machine. The budget is faked for the slicing tests; the priority
// test runs a copy of ci-local over two tiny probe test files in a throwaway tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir, constants as osConstants, getPriority } from 'node:os';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBudgetSession, runBudgetedTests } from '../ci-local.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BELOW = osConstants.priority.PRIORITY_BELOW_NORMAL;

// A stand-in lease whose grant the test decides per request.
function fakeBudget(grantFor) {
  const events = [];
  let asks = 0;
  const lease = {
    units: 0, heavy: 0,
    resize(spec, opts = {}) {
      events.push(['resize', { ...spec }, { ...opts }]);
      if (spec.units) { lease.units = Math.min(spec.units, grantFor(asks)); asks += 1; }
      if (spec.heavy !== undefined && spec.units === 0) lease.heavy = spec.heavy;
      return { units: lease.units, heavy: lease.heavy };
    },
    release() {},
  };
  const acquireLease = (opts) => {
    events.push(['acquire', { ...opts }]);
    lease.units = Math.min(opts.desired, grantFor(asks));
    asks += 1;
    return lease;
  };
  return { events, acquireLease };
}

const names = (n) => Array.from({ length: n }, (_, i) => `t/f${i}.test.mjs`);
const pass = (a) => ({ status: 0, outcome: 'pass', counts: { passed: a.files.length, failed: 0 }, flakyFiles: [], failedFiles: [] });

test('slicing: each slice asks the budget again, and a slice is sliceFactor files per granted worker', () => {
  const grants = [4, 4, 1, 4]; // the machine got loaded for the third request
  const b = fakeBudget((i) => grants[Math.min(i, grants.length - 1)]);
  const s = createBudgetSession({ acquireLease: b.acquireLease, cfg: { heavyMax: 2, sliceFactor: 2 }, log: () => {} });
  const runs = [];
  const r = runBudgetedTests({
    files: names(22), cwd: '.', env: {}, ciParity: false, budget: s, concurrency: 4,
    run: (a) => { runs.push([a.files.length, a.concurrency]); return pass(a); }, log: () => {},
  });
  // grant 4 -> 8 files, grant 4 -> 8 files, grant 1 -> 2 files, grant 4 -> the last 4
  assert.deepEqual(runs, [[8, 4], [8, 4], [2, 1], [4, 4]]);
  assert.equal(r.counts.passed, 22, 'every file ran once and the counts add up');
  const resizes = b.events.filter((e) => e[0] === 'resize');
  assert.equal(resizes.length, 3, 'one acquire, then one resize per later slice');
  for (const e of resizes) assert.deepEqual(e[2], { resample: true }, 'a re-sample on each later slice');
});

test('slicing: a pass of up to one slice, or sliceFactor 0, is a single run', () => {
  for (const [factor, count] of [[2, 8], [2, 3], [0, 40], [undefined, 40]]) {
    const b = fakeBudget(() => 4);
    const s = createBudgetSession({ acquireLease: b.acquireLease, cfg: { heavyMax: 2, sliceFactor: factor }, log: () => {} });
    const runs = [];
    runBudgetedTests({
      files: names(count), cwd: '.', env: {}, ciParity: false, budget: s, concurrency: 4,
      run: (a) => { runs.push(a.files.length); return pass(a); }, log: () => {},
    });
    assert.deepEqual(runs, [count], `factor ${factor}, ${count} files`);
  }
});

test('slicing: a targeted session never slices, and the busy note is logged once per change', () => {
  const t = fakeBudget(() => 1);
  const ts = createBudgetSession({ kind: 'targeted', acquireLease: t.acquireLease, cfg: { heavyMax: 2, sliceFactor: 2 }, log: () => {} });
  assert.equal(ts.sliceFactor, 0);

  const b = fakeBudget(() => 2);
  const logs = [];
  const s = createBudgetSession({ acquireLease: b.acquireLease, cfg: { heavyMax: 2, sliceFactor: 1 }, log: (m) => logs.push(m) });
  runBudgetedTests({
    files: names(10), cwd: '.', env: {}, ciParity: false, budget: s, concurrency: 4,
    run: pass, log: () => {},
  });
  assert.equal(logs.filter((m) => /running with 2 of 4 test workers/.test(m)).length, 1, 'five slices, one line');
});

// End to end: a copy of ci-local in a throwaway tree runs one probe test file that
// reports its own priority and that of a grandchild started through sh, as a lane
// does. The suite process, node --test and the test file are three levels below ci-local.
test('the suite processes and their children inherit the below-normal priority set at the entry point', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-priority-e2e-'));
  try {
    const tree = join(root, 'tree');
    const observe = join(root, 'observed.json');
    for (const d of ['scripts/tests', 'scripts/ci-reporters', '.github/workflows']) mkdirSync(join(tree, d), { recursive: true });
    mkdirSync(join(root, 'old-locks'));
    writeFileSync(join(tree, 'scripts', 'ci-local.mjs'), readFileSync(join(REPO, 'scripts', 'ci-local.mjs')));
    mkdirSync(join(tree, 'plugins', 'agent-companion', 'scripts'), { recursive: true });
    for (const rel of [['scripts', 'ci-budget.mjs'], ['scripts', 'lib', 'resource-rules.mjs'], ['config', 'resource-rules.json']]) {
      mkdirSync(dirname(join(tree, 'plugins', 'agent-companion', ...rel)), { recursive: true });
      writeFileSync(join(tree, 'plugins', 'agent-companion', ...rel), readFileSync(join(REPO, 'plugins', 'agent-companion', ...rel)));
    }
    for (const f of ['human.mjs', 'results.mjs']) {
      writeFileSync(join(tree, 'scripts', 'ci-reporters', f), readFileSync(join(REPO, 'scripts', 'ci-reporters', f)));
    }
    writeFileSync(join(tree, 'scripts', 'tests', 'probe.test.mjs'), [
      "import test from 'node:test';",
      "import os from 'node:os';",
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "test('probe', () => {",
      "  const sh = spawnSync('sh', ['-c', '\"$0\" -e \"console.log(require(\\'os\\').getPriority(0))\"', process.execPath],",
      "    { encoding: 'utf8', windowsHide: true });",
      "  const viaSh = sh.status === 0 ? Number(String(sh.stdout).trim()) : null;",
      "  writeFileSync(process.env.CI_LOCAL_OBSERVE, JSON.stringify({ self: os.getPriority(0), viaSh }));",
      '});',
      '',
    ].join('\n'));
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT; // would make the nested `node --test` skip its files
    const res = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [join(tree, 'scripts', 'ci-local.mjs'), '--suite', 'scripts-tests'], {
        cwd: tree,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...childEnv,
          CI_BUDGET_DIR: join(root, 'ledger'),
          CI_LOCAL_LOCK_DIR: join(root, 'old-locks'),
          CI_LOCAL_OBSERVE: observe,
          CI_LOCAL_LOCK: '',
          CI_LOCAL_RESERVE: '0',
          CI_LOCAL_LOAD_PCT: '100',
        },
      });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { c.kill(); reject(new Error(`ci-local hung:\n${out}`)); }, 90_000);
      c.on('error', reject);
      c.on('exit', (status) => { clearTimeout(timer); resolve({ status, out }); });
    });
    assert.equal(res.status, 0, res.out);
    assert.ok(existsSync(observe), `the probe never ran:\n${res.out}`);
    const seen = JSON.parse(readFileSync(observe, 'utf8'));
    const expected = Math.max(getPriority(0), BELOW); // a parent that is already nicer stays as nice
    assert.equal(seen.self, expected, 'the test file process runs below normal');
    if (seen.viaSh === null) return; // no sh on this machine: the node child above is the check
    assert.equal(seen.viaSh, expected, 'a process started through sh inherits it too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
