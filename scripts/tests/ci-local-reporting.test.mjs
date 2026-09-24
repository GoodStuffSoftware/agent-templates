// Tests for how scripts/ci-local.mjs runs and reports node --test suites:
// todo wording, the isolated re-run of a failed file ("flaky on isolated
// re-run", blocking only under --ci-parity), and the concurrency cap.
//
// The runTestSuite() tests run REAL nested `node --test` processes over
// throwaway fixture files, through ci-local's real reporters; only the
// spawn is wrapped, to capture the output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  runTestSuite, readResults, formatCounts, formatSummaryLine, flakyBanner,
  resolveTestConcurrency, defaultTestConcurrency, CONCURRENCY_ENV, selectStaleTempDirs,
} from '../ci-local.mjs';

const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-reporting-'));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

// A nested node --test must not think it is a worker of this run.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NODE_TEST_')) env[k] = v;
  return env;
}

function capturingSpawn() {
  const calls = [];
  let out = '';
  const spawnNode = (args, cwd, env) => {
    const r = spawnSync(process.execPath, args, {
      cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000,
    });
    out += `${r.stdout || ''}${r.stderr || ''}`;
    calls.push(args);
    return { status: r.status === null ? 1 : r.status };
  };
  return { spawnNode, calls, output: () => out };
}

const PASSING = [
  "import test from 'node:test';",
  "test('fine', () => {});",
  '',
].join('\n');

const FAILING_TODO = [
  "import test from 'node:test';",
  "test('works', () => {});",
  "test('held work', { todo: 'held for a later release' }, () => { throw new Error('not yet'); });",
  "test('also skipped', { skip: true }, () => {});",
  '',
].join('\n');

// Fails the first time it runs (and leaves a marker), passes every time
// after: exactly a file that is "flaky on isolated re-run".
const FLAKY_ONCE = [
  "import test from 'node:test';",
  "import { existsSync, writeFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "const marker = fileURLToPath(new URL('./flaky.marker', import.meta.url));",
  "test('passes on the second run', () => {",
  '  if (!existsSync(marker)) { writeFileSync(marker, "1"); throw new Error("first run fails"); }',
  '});',
  '',
].join('\n');

const ALWAYS_FAILS = [
  "import test from 'node:test';",
  "test('broken', () => { throw new Error('always'); });",
  '',
].join('\n');

// ---------------------------------------------------------------------------
// todo wording
// ---------------------------------------------------------------------------

test('a failing todo is not a failure: exit 0, counted as todo, never listed under "failing tests"', () => {
  const dir = fixtureDir({ 'a.test.mjs': FAILING_TODO });
  const cap = capturingSpawn();
  const r = runTestSuite({
    files: ['a.test.mjs'], cwd: dir, env: childEnv(), concurrency: 2, spawnNode: cap.spawnNode, log: () => {},
  });
  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'pass');
  assert.equal(r.counts.todo, 1);
  assert.equal(r.counts.failed, 0);
  assert.equal(r.counts.skipped, 1);
  assert.equal(cap.calls.length, 1, 'a pass is never re-run');
  const out = cap.output();
  assert.doesNotMatch(out, /failing tests/i, 'no "failing tests" block when only a todo threw');
  assert.match(out, /todo tests \(1, not failures/);
  assert.match(out, /held work.*# held for a later release/);
  const line = formatSummaryLine({ name: 'scripts-tests', ...r });
  assert.equal(line, '  PASS   scripts-tests  (pass 1 · fail 0 · todo 1 · skipped 1)');
  assert.doesNotMatch(line, /failure/i);
});

test('a real failure next to a failing todo: only the real one is listed as failing', () => {
  const dir = fixtureDir({ 'a.test.mjs': FAILING_TODO, 'b.test.mjs': ALWAYS_FAILS });
  const cap = capturingSpawn();
  const r = runTestSuite({
    files: ['a.test.mjs', 'b.test.mjs'], cwd: dir, env: childEnv(), concurrency: 2, spawnNode: cap.spawnNode, log: () => {},
  });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.status, 1);
  assert.deepEqual(r.failedFiles, ['b.test.mjs'], 'only the file with a real failure is re-run and reported');
  const block = (cap.output().split(/failing tests:/)[1] || '').split('ℹ todo tests')[0];
  assert.match(block, /broken/);
  assert.doesNotMatch(block, /held work/);
});

test('formatCounts: exact words pass / fail / todo / skipped, cancelled only when non-zero', () => {
  assert.equal(formatCounts({ passed: 5, failed: 0, todo: 2, skipped: 1, cancelled: 0 }), 'pass 5 · fail 0 · todo 2 · skipped 1');
  assert.equal(formatCounts({ passed: 5, failed: 1, todo: 0, skipped: 0, cancelled: 2 }), 'pass 5 · fail 1 · todo 0 · skipped 0 · cancelled 2');
  assert.equal(formatCounts(null), '');
});

test('readResults: run-wide counts come from the file-less summary; todo failures are never in failedFiles', () => {
  const text = [
    JSON.stringify({ type: 'summary', file: '/x/a.test.mjs', counts: { passed: 1 } }),
    JSON.stringify({ type: 'fail', file: '/x/b.test.mjs', name: 'b' }),
    JSON.stringify({ type: 'fail', file: '/x/b.test.mjs', name: 'b2' }),
    'not json',
    JSON.stringify({ type: 'summary', file: null, counts: { passed: 3, failed: 1 } }),
  ].join('\n');
  const r = readResults(text);
  assert.deepEqual(r.counts, { passed: 3, failed: 1 });
  assert.deepEqual(r.failedFiles, ['/x/b.test.mjs']);
});

// ---------------------------------------------------------------------------
// flaky on isolated re-run
// ---------------------------------------------------------------------------

test('flaky on isolated re-run, local: reported as FLAKY with the file named, does NOT block (status 0)', () => {
  const dir = fixtureDir({ 'ok.test.mjs': PASSING, 'flaky.test.mjs': FLAKY_ONCE });
  const cap = capturingSpawn();
  const logs = [];
  const r = runTestSuite({
    files: ['flaky.test.mjs', 'ok.test.mjs'], cwd: dir, env: childEnv(), concurrency: 2, spawnNode: cap.spawnNode, log: (m) => logs.push(m),
  });
  assert.equal(r.outcome, 'flaky');
  assert.equal(r.status, 0);
  assert.deepEqual(r.flakyFiles, ['flaky.test.mjs']);
  assert.deepEqual(r.failedFiles, []);
  assert.equal(cap.calls.length, 2, 'one full run, then exactly one isolated re-run');
  assert.deepEqual(cap.calls[1].filter((a) => a.endsWith('.test.mjs')).map((a) => a.replace(/^.*[\\/]/, '')), ['flaky.test.mjs'], 'the re-run is that file alone');
  assert.ok(logs.some((l) => /flaky\.test\.mjs failed in the full run — re-running it ONCE on its own/.test(l)));
  const line = formatSummaryLine({ name: 'agent-companion-tests', ...r }, false);
  assert.match(line, /^ {2}FLAKY {2}agent-companion-tests .* — flaky on isolated re-run: flaky\.test\.mjs \(not blocking; --ci-parity would block\)$/);
  const banner = flakyBanner([{ name: 'agent-companion-tests', ...r }], false);
  assert.match(banner, /!!! ci-local: FLAKY/);
  assert.match(banner, /flaky\.test\.mjs/);
  assert.match(banner, /Not blocking this run/);
});

test('flaky on isolated re-run, --ci-parity: the same outcome counts as a failure (status 1)', () => {
  const dir = fixtureDir({ 'flaky.test.mjs': FLAKY_ONCE });
  const cap = capturingSpawn();
  const r = runTestSuite({
    files: ['flaky.test.mjs'], cwd: dir, env: childEnv(), ciParity: true, concurrency: 2, spawnNode: cap.spawnNode, log: () => {},
  });
  assert.equal(r.outcome, 'flaky');
  assert.equal(r.status, 1);
  assert.deepEqual(r.flakyFiles, ['flaky.test.mjs']);
  assert.match(formatSummaryLine({ name: 's', ...r }, true), /flaky on isolated re-run: flaky\.test\.mjs \(--ci-parity: counts as a failure\)$/);
  assert.match(flakyBanner([{ name: 's', ...r }], true), /--ci-parity treats this as a failure/);
});

test('a file that fails again on its isolated re-run is a plain FAIL, re-run exactly once', () => {
  const dir = fixtureDir({ 'broken.test.mjs': ALWAYS_FAILS, 'ok.test.mjs': PASSING });
  const cap = capturingSpawn();
  const r = runTestSuite({
    files: ['broken.test.mjs', 'ok.test.mjs'], cwd: dir, env: childEnv(), concurrency: 2, spawnNode: cap.spawnNode, log: () => {},
  });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.status, 1);
  assert.deepEqual(r.failedFiles, ['broken.test.mjs']);
  assert.deepEqual(r.flakyFiles, []);
  assert.equal(cap.calls.length, 2);
  assert.match(formatSummaryLine({ name: 's', ...r }), /^ {2}FAIL {3}s .* — failed again on isolated re-run: broken\.test\.mjs$/);
  assert.equal(flakyBanner([{ name: 's', ...r }]), null);
});

test('a non-zero exit with no attributable failed file is a FAIL with nothing re-run', () => {
  const r = runTestSuite({
    files: ['x.test.mjs'], cwd: tmpdir(), env: childEnv(), concurrency: 1, log: () => {},
    spawnNode: () => ({ status: 1 }),
  });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.status, 1);
});

test('the full run passes --test-concurrency; the isolated re-run uses 1', () => {
  const dir = fixtureDir({ 'flaky.test.mjs': FLAKY_ONCE });
  const cap = capturingSpawn();
  runTestSuite({
    files: ['flaky.test.mjs'], cwd: dir, env: childEnv(), concurrency: 3, spawnNode: cap.spawnNode, log: () => {},
  });
  assert.ok(cap.calls[0].includes('--test-concurrency=3'));
  assert.ok(cap.calls[1].includes('--test-concurrency=1'));
  assert.ok(existsSync(join(dir, 'flaky.marker')));
});

// ---------------------------------------------------------------------------
// concurrency cap
// ---------------------------------------------------------------------------

test('defaultTestConcurrency: half the CPUs, clamped to 1..8', () => {
  assert.equal(defaultTestConcurrency(1), 1);
  assert.equal(defaultTestConcurrency(2), 1);
  assert.equal(defaultTestConcurrency(4), 2);
  assert.equal(defaultTestConcurrency(12), 6);
  assert.equal(defaultTestConcurrency(32), 8);
  assert.equal(defaultTestConcurrency(128), 8);
  assert.equal(defaultTestConcurrency(Number.NaN), 1);
});

test('resolveTestConcurrency: the env var overrides; a bad value warns and falls back', () => {
  assert.deepEqual(resolveTestConcurrency({}, 32), { value: 8, source: 'default' });
  assert.deepEqual(resolveTestConcurrency({ [CONCURRENCY_ENV]: '3' }, 32), { value: 3, source: 'env' });
  assert.deepEqual(resolveTestConcurrency({ [CONCURRENCY_ENV]: '20' }, 4), { value: 20, source: 'env' }, 'an explicit value is not clamped');
  assert.deepEqual(resolveTestConcurrency({ [CONCURRENCY_ENV]: '' }, 4), { value: 2, source: 'default' });
  for (const bad of ['0', '-2', '1.5', 'lots']) {
    const r = resolveTestConcurrency({ [CONCURRENCY_ENV]: bad }, 8);
    assert.equal(r.value, 4);
    assert.equal(r.source, 'default');
    assert.match(r.warning, new RegExp(`ignoring ${CONCURRENCY_ENV}`));
  }
});

test('selectStaleTempDirs: a leftover ci-local-results-<pid>- dir is swept like the others', () => {
  const stale = selectStaleTempDirs(['ci-local-results-4242-abc', 'ci-local-other-4242-x'], {
    now: 10_000, maxAgeMs: 1, getMtimeMs: () => 0, isPidAlive: () => false,
  });
  assert.deepEqual(stale, ['ci-local-results-4242-abc']);
});
