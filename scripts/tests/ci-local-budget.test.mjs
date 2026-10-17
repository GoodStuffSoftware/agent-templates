// scripts/ci-local.mjs on the shared CI budget: the heavy-lane list, the lease
// kind, and how the phases take, resize and release a lease. The budget is
// faked here (a stand-in lease), so nothing touches the real machine ledger and
// no test file is run; scripts/tests/ci-budget.test.mjs covers the real thing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readdirSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEAVY_TEST_FILES, isHeavyTestFile, splitHeavy, leaseKindFor, createBudgetSession,
  runBudgetedTests, mergeSuiteResults, SUITES,
} from '../ci-local.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A stand-in for a ci-budget lease. `grant` caps what a plain request gets.
function fakeBudget({ grant = Infinity, heavyGrant = Infinity } = {}) {
  const events = [];
  const lease = {
    id: 'fake', units: 0, heavy: 0, released: false,
    resize(spec, opts = {}) {
      events.push(['resize', { ...spec }, { ...opts }]);
      if (spec.units !== undefined) lease.units = Math.min(spec.units, grant);
      if (spec.heavy !== undefined) lease.heavy = Math.min(spec.heavy, heavyGrant);
      return { units: lease.units, heavy: lease.heavy };
    },
    release() { lease.released = true; events.push(['release']); },
  };
  const acquireLease = (opts) => {
    events.push(['acquire', { ...opts }]);
    lease.units = opts.kind === 'targeted' ? 1 : Math.min(opts.desired, grant);
    return lease;
  };
  return { events, lease, acquireLease };
}

const cfg = { heavyMax: 2 };

test('the heavy list names real test files, and the first entries are the ones the brief started with', () => {
  assert.deepEqual(HEAVY_TEST_FILES.slice(0, 3), ['memory-vault*', 'git-brief*', 'ci-local-parity']);
  const all = [];
  for (const dir of ['scripts/tests', 'plugins/agent-companion/tests']) {
    for (const f of readdirSync(join(REPO, dir))) if (f.endsWith('.test.mjs')) all.push(join(dir, f));
  }
  for (const p of HEAVY_TEST_FILES) {
    assert.ok(all.some((f) => isHeavyTestFile(f, [p])), `heavy pattern "${p}" matches no test file (renamed or removed?)`);
  }
});

test('isHeavyTestFile: matches the file name without .test.mjs, in any directory, with * wildcards', () => {
  assert.equal(isHeavyTestFile('plugins/agent-companion/tests/memory-vault-byte-exact.test.mjs'), true);
  assert.equal(isHeavyTestFile('plugins/agent-companion/tests/memory-vault.test.mjs'), true);
  assert.equal(isHeavyTestFile('plugins\\agent-companion\\tests\\git-brief.test.mjs'), true);
  assert.equal(isHeavyTestFile('scripts/tests/ci-local-parity.test.mjs'), true);
  assert.equal(isHeavyTestFile('scripts/tests/ci-local.test.mjs'), false);
  assert.equal(isHeavyTestFile('plugins/agent-companion/tests/not-git-brief.test.mjs'), false, 'anchored, not a substring');
  assert.equal(isHeavyTestFile('plugins/agent-companion/tests/memory-scope.test.mjs'), false);
  assert.equal(isHeavyTestFile('a.test.mjs', ['a.test*']), false, 'the suffix is stripped before matching');
  assert.equal(isHeavyTestFile('a.b.test.mjs', ['a.b']), true, 'a dot in a pattern is a dot, not a wildcard');
  assert.equal(isHeavyTestFile('axb.test.mjs', ['a.b']), false);
});

test('splitHeavy keeps the input order in both lanes', () => {
  const files = ['t/a.test.mjs', 't/git-brief.test.mjs', 't/b.test.mjs', 't/memory-vault-x.test.mjs'];
  assert.deepEqual(splitHeavy(files), { normal: ['t/a.test.mjs', 't/b.test.mjs'], heavy: ['t/git-brief.test.mjs', 't/memory-vault-x.test.mjs'] });
  assert.deepEqual(splitHeavy(files, []), { normal: files, heavy: [] });
});

test('leaseKindFor: only single-script runs are targeted; anything with a test suite is a full run', () => {
  assert.equal(leaseKindFor(['leak-check']), 'targeted');
  assert.equal(leaseKindFor(['scripts-tests']), 'full');
  assert.equal(leaseKindFor(['leak-check', 'agent-companion-tests']), 'full');
  assert.equal(leaseKindFor(null), 'full', 'the default is all three suites');
  assert.ok(!SUITES['leak-check'].testDir);
});

test('a full session: acquire once with the wanted workers, resize between phases, release once', () => {
  const b = fakeBudget({ grant: 3 });
  const logs = [];
  const s = createBudgetSession({ acquireLease: b.acquireLease, cfg, log: (m) => logs.push(m), label: 'x', worktree: 'wt' });
  assert.equal(s.plain(8), 3, 'the grant is what node gets as --test-concurrency');
  assert.deepEqual(b.events[0], ['acquire', { kind: 'full', desired: 8, label: 'x', worktree: 'wt' }]);
  assert.deepEqual(logs, [], 'the first grant is announced by ci-budget itself, not twice');
  assert.equal(s.plain(8), 3);
  assert.deepEqual(b.events[1], ['resize', { units: 8, heavy: 0 }, { resample: true }]);
  assert.match(logs.join('\n'), /running with 3 of 8 test workers/);
  assert.equal(s.heavy(2), 2);
  assert.deepEqual(b.events[2], ['resize', { units: 0, heavy: 2 }, { wait: true }], 'the heavy lane waits for a slot');
  s.settle();
  assert.deepEqual(b.events[3], ['resize', { units: 1, heavy: 0 }, {}]);
  s.release();
  s.release();
  assert.equal(b.events.filter((e) => e[0] === 'release').length, 1, 'idempotent');
  assert.equal(b.lease.released, true);
});

test('a targeted session takes one express lease and never resizes', () => {
  const b = fakeBudget();
  const s = createBudgetSession({ kind: 'targeted', acquireLease: b.acquireLease, cfg, log: () => {} });
  assert.equal(s.plain(1), 1);
  assert.equal(s.plain(1), 1);
  assert.deepEqual(b.events.map((e) => e[0]), ['acquire']);
  assert.equal(b.events[0][1].kind, 'targeted');
  assert.equal('desired' in b.events[0][1], false);
});

test('runBudgetedTests: regular files with the granted workers, then the heavy files in their own pass', () => {
  const b = fakeBudget({ grant: 5, heavyGrant: 1 });
  const s = createBudgetSession({ acquireLease: b.acquireLease, cfg, log: () => {} });
  const runs = [];
  const run = (a) => {
    runs.push({ files: a.files, concurrency: a.concurrency });
    return { status: 0, outcome: 'pass', counts: { passed: a.files.length, failed: 0 }, flakyFiles: [], failedFiles: [] };
  };
  const logs = [];
  const files = ['t/a.test.mjs', 't/git-brief.test.mjs', 't/b.test.mjs', 't/memory-vault.test.mjs', 't/push-scan.test.mjs'];
  const r = runBudgetedTests({ files, cwd: '.', env: {}, ciParity: false, budget: s, concurrency: 8, run, log: (m) => logs.push(m) });
  assert.deepEqual(runs, [
    { files: ['t/a.test.mjs', 't/b.test.mjs'], concurrency: 5 },
    { files: ['t/git-brief.test.mjs', 't/memory-vault.test.mjs', 't/push-scan.test.mjs'], concurrency: 1 },
  ]);
  assert.deepEqual(r.counts, { passed: 5, failed: 0 });
  assert.equal(r.outcome, 'pass');
  assert.match(logs.join('\n'), /heavy lane: 3 git\/sh-heavy test file\(s\), 1 at a time/);
  const heavyCall = b.events.find((e) => e[0] === 'resize' && e[1].heavy > 0);
  assert.deepEqual(heavyCall[1], { units: 0, heavy: 2 }, 'asks for min(CI_LOCAL_HEAVY_MAX, heavy files, concurrency)');
  assert.equal(b.lease.heavy, 0, 'settled back after the heavy pass');
});

test('runBudgetedTests: the heavy pass asks for no more than the test concurrency, and heavyMax 0 folds heavy files into the normal pass', () => {
  const b1 = fakeBudget();
  const s1 = createBudgetSession({ acquireLease: b1.acquireLease, cfg: { heavyMax: 4 }, log: () => {} });
  const run = (a) => ({ status: 0, outcome: 'pass', counts: null, flakyFiles: [], failedFiles: [], seen: a.concurrency });
  runBudgetedTests({ files: ['t/git-brief.test.mjs', 't/push-scan.test.mjs', 't/ci-local-parity.test.mjs'], cwd: '.', env: {}, ciParity: false, budget: s1, concurrency: 1, run, log: () => {} });
  assert.deepEqual(b1.events.find((e) => e[0] === 'resize' && e[1].heavy > 0)[1], { units: 0, heavy: 1 });

  const b2 = fakeBudget();
  const s2 = createBudgetSession({ acquireLease: b2.acquireLease, cfg: { heavyMax: 0 }, log: () => {} });
  const runs = [];
  runBudgetedTests({
    files: ['t/a.test.mjs', 't/git-brief.test.mjs'], cwd: '.', env: {}, ciParity: false, budget: s2, concurrency: 4,
    run: (a) => { runs.push(a.files); return { status: 0, outcome: 'pass', counts: null, flakyFiles: [], failedFiles: [] }; },
    log: () => {},
  });
  assert.deepEqual(runs, [['t/a.test.mjs', 't/git-brief.test.mjs']]);
});

test('a suite with only heavy files still takes a lease (heavy first) and runs once', () => {
  const b = fakeBudget();
  const s = createBudgetSession({ acquireLease: b.acquireLease, cfg, log: () => {} });
  const runs = [];
  runBudgetedTests({
    files: ['t/git-brief.test.mjs'], cwd: '.', env: {}, ciParity: false, budget: s, concurrency: 4,
    run: (a) => { runs.push(a.concurrency); return { status: 0, outcome: 'pass', counts: null, flakyFiles: [], failedFiles: [] }; },
    log: () => {},
  });
  assert.deepEqual(runs, [1]);
  assert.equal(b.events[0][0], 'acquire');
  assert.equal(b.events[0][1].desired, 1);
});

test('mergeSuiteResults: counts add up, files join, the worst outcome wins', () => {
  const pass = { status: 0, outcome: 'pass', counts: { passed: 3, failed: 0, todo: 1 }, flakyFiles: [], failedFiles: [] };
  const flaky = { status: 0, outcome: 'flaky', counts: { passed: 2, failed: 1 }, flakyFiles: ['a'], failedFiles: [] };
  const fail = { status: 1, outcome: 'fail', counts: { passed: 1, failed: 2 }, flakyFiles: [], failedFiles: ['b'] };
  assert.equal(mergeSuiteResults([pass]), pass);
  const m = mergeSuiteResults([pass, flaky]);
  assert.deepEqual([m.status, m.outcome, m.counts, m.flakyFiles], [0, 'flaky', { passed: 5, failed: 1, todo: 1 }, ['a']]);
  const m2 = mergeSuiteResults([flaky, fail]);
  assert.deepEqual([m2.status, m2.outcome, m2.failedFiles, m2.flakyFiles], [1, 'fail', ['b'], ['a']]);
  assert.equal(mergeSuiteResults([{ status: 0, outcome: 'pass', counts: null }, { status: 0, outcome: 'pass', counts: null }]).counts, null);
});

// End to end: a copy of ci-local in a throwaway tree, against a real ledger in a
// temp dir. Two tiny test files record what the ledger said while they ran.
test('a real run: the regular pass holds plain workers, the heavy pass holds heavy ones, and nothing is left behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-local-budget-e2e-'));
  try {
    const tree = join(root, 'tree');
    const ledger = join(root, 'ledger');
    const oldLocks = join(root, 'old-locks');
    const observe = join(root, 'observed.jsonl');
    for (const d of ['scripts/tests', 'scripts/ci-reporters', '.github/workflows']) mkdirSync(join(tree, d), { recursive: true });
    mkdirSync(oldLocks);
    writeFileSync(join(tree, 'scripts', 'ci-local.mjs'), readFileSync(join(REPO, 'scripts', 'ci-local.mjs')));
    mkdirSync(join(tree, 'plugins', 'agent-companion', 'scripts'), { recursive: true });
    for (const rel of [['scripts', 'ci-budget.mjs'], ['scripts', 'lib', 'resource-rules.mjs'], ['config', 'resource-rules.json']]) {
      mkdirSync(dirname(join(tree, 'plugins', 'agent-companion', ...rel)), { recursive: true });
      writeFileSync(join(tree, 'plugins', 'agent-companion', ...rel), readFileSync(join(REPO, 'plugins', 'agent-companion', ...rel)));
    }
    for (const f of ['human.mjs', 'results.mjs']) {
      writeFileSync(join(tree, 'scripts', 'ci-reporters', f), readFileSync(join(REPO, 'scripts', 'ci-reporters', f)));
    }
    const probe = (name) => [
      "import test from 'node:test';",
      "import { readdirSync, readFileSync, appendFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `test('${name}', () => {`,
      '  const dir = process.env.CI_BUDGET_DIR;',
      "  const leases = readdirSync(dir).filter((n) => /^lease-.*\\.json$/.test(n))",
      "    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));",
      `  appendFileSync(process.env.CI_LOCAL_OBSERVE, JSON.stringify({ file: '${name}', leases: leases.map((l) => ({ kind: l.kind, units: l.units, heavy: l.heavy })) }) + '\\n');`,
      '});',
      '',
    ].join('\n');
    writeFileSync(join(tree, 'scripts', 'tests', 'plain-one.test.mjs'), probe('plain-one'));
    writeFileSync(join(tree, 'scripts', 'tests', 'git-brief.test.mjs'), probe('git-brief')); // on the heavy list
    const childEnv = { ...process.env }; // NODE_TEST_CONTEXT would make the nested `node --test` skip its files
    delete childEnv.NODE_TEST_CONTEXT;
    const res = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [join(tree, 'scripts', 'ci-local.mjs'), '--suite', 'scripts-tests'], {
        cwd: tree,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...childEnv,
          CI_BUDGET_DIR: ledger,
          CI_LOCAL_BUDGET: '64',
          CI_LOCAL_TEST_CONCURRENCY: '3',
          CI_LOCAL_LOCK_DIR: oldLocks,
          CI_LOCAL_OBSERVE: observe,
          CI_LOCAL_LOCK: '',
          CI_LOCAL_RESERVE: '0', // a busy test machine must not throttle the probe
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
    assert.match(res.out, /heavy lane: 1 git\/sh-heavy test file\(s\), 1 at a time/);
    assert.ok(existsSync(observe), `the probe tests never ran:\n${res.out}`);
    const seen = Object.fromEntries(readFileSync(observe, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((o) => [o.file, o.leases]));
    assert.deepEqual(seen['plain-one'], [{ kind: 'full', units: 3, heavy: 0 }]);
    assert.deepEqual(seen['git-brief'], [{ kind: 'full', units: 0, heavy: 1 }]);
    assert.deepEqual(readdirSync(ledger).filter((n) => /^(lease|ticket)-/.test(n)), [], 'released at the end');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
