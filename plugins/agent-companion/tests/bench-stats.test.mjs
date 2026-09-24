// Small-sample statistics in the benchmark summary (bench/stats.mjs and
// bench/runner.mjs's rebuildSummary()): Wilson 95% intervals per cell x
// task-family, the "n too small to separate" flag, and pass@1 / pass@k
// labelling. Pure math against hand-written results.jsonl fixtures -- no
// process spawn, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  wilsonInterval, passAtK, intervalsOverlap, formatInterval, MIN_N_TO_SEPARATE,
} from '../bench/stats.mjs';
import { rebuildSummary, buildFamilySummary, taskFamilyOf } from '../bench/runner.mjs';

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('wilsonInterval matches reference values and stays inside [0, 1] at the edges', () => {
  const full = wilsonInterval(7, 7);
  assert.ok(close(full.low, 0.6457), `7/7 low ${full.low}`);
  assert.equal(full.high, 1);
  const five = wilsonInterval(5, 7);
  assert.ok(close(five.low, 0.3589), `5/7 low ${five.low}`);
  assert.ok(close(five.high, 0.9178), `5/7 high ${five.high}`);
  const zero = wilsonInterval(0, 3);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0.5, 'a 0/3 cell is still compatible with a >50% true rate');
  assert.equal(wilsonInterval(0, 0), null, 'no data is not an interval');
  assert.equal(wilsonInterval(4, 3), null);
});

test('the documented Opus 5.5 high 5/7 vs low 7/7 result cannot be separated at 95%', () => {
  // docs/BENCHMARK.md: this exact gap on real tasks turned out to be variance.
  assert.equal(intervalsOverlap(wilsonInterval(5, 7), wilsonInterval(7, 7)), true);
  assert.equal(intervalsOverlap(wilsonInterval(0, 20), wilsonInterval(20, 20)), false);
});

test('passAtK is the unbiased estimator (1 - C(n-c,k)/C(n,k))', () => {
  assert.ok(close(passAtK(3, 1, 1), 1 / 3));
  assert.equal(passAtK(3, 1, 3), 1, 'k = n: passed at least once');
  assert.equal(passAtK(3, 0, 3), 0);
  assert.ok(close(passAtK(5, 2, 2), 0.7), '1 - C(3,2)/C(5,2) = 0.7');
  assert.equal(passAtK(3, 3, 1), 1);
  assert.equal(passAtK(2, 1, 3), null, 'k > n is undefined, not zero');
});

test('formatInterval renders rounded percentages', () => {
  assert.equal(formatInterval({ low: 0.3589, high: 0.9178 }), '[36-92%]');
  assert.equal(formatInterval(null), 'n/a');
});

test('taskFamilyOf: built-in families, pack rows, explicit row field', () => {
  assert.equal(taskFamilyOf('lookup'), 'easy');
  assert.equal(taskFamilyOf('hard-verify'), 'hard');
  assert.equal(taskFamilyOf('real-capacity'), 'real');
  assert.equal(taskFamilyOf('some-pack', { row: { task_pack_sha256: 'x' } }), 'pack');
  assert.equal(taskFamilyOf('whatever', { row: { task_family: 'custom' } }), 'custom');
  assert.equal(taskFamilyOf('unknown-task'), 'other');
});

function writeRows(dir, rows) {
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function row(cell, task, rep, pass, extra = {}) {
  return {
    cell, task, rep, pass, is_error: false, auth_error: false, requested_model: 'claude-sonnet-5',
    cost_usd: 0.1, num_turns: 3, cache_read_tokens: 1000, input_tokens: 10, output_tokens: 10, ...extra,
  };
}

test('rebuildSummary: per-task rows carry pass@1, a Wilson CI, pass@k and n_too_small', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-stats-'));
  try {
    writeRows(outDir, [
      row('sonnet-medium', 'lookup', 1, true),
      row('sonnet-medium', 'lookup', 2, false),
      row('sonnet-medium', 'lookup', 3, true),
    ]);
    rebuildSummary(outDir);
    const [s] = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.ok(close(s.pass_at_1, 2 / 3));
    assert.equal(s.pass_rate, s.pass_at_1, 'pass_rate kept for back-compat, identical to pass@1');
    assert.equal(s.k, 3);
    assert.equal(s.pass_at_k, 1);
    assert.ok(s.pass_ci95_low > 0 && s.pass_ci95_high < 1);
    assert.equal(s.n_too_small, true);
    assert.equal(s.task_family, 'easy');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    const header = md.split('\n').find((l) => l.startsWith('cell | task'));
    const cols = header.split(' | ');
    assert.deepEqual(cols.slice(0, 6), ['cell', 'task', 'n', 'pass@1', '95% CI', 'pass@k']);
    assert.ok(!cols.includes('pass_rate'), 'the markdown column is labelled pass@1 now');
    assert.match(md, /pass@1 = mean single-trial pass rate/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: cell x family rollup with Wilson CI and the "n too small to separate" flag', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-stats-'));
  try {
    const rows = [];
    // opus55-high: 7 real tasks x 1 rep, 5 pass. opus55-low: 7/7.
    const realTasks = ['real-capacity', 'real-secret-scan', 'real-opt-fallback', 'real-effort-note',
      'real-publication-sweep', 'real-misleading-report', 'real-contradictory-spec'];
    realTasks.forEach((t, i) => rows.push(row('opus55-high', t, 1, i < 5, { requested_model: 'claude-opus-5-5' })));
    realTasks.forEach((t) => rows.push(row('opus55-low', t, 1, true, { requested_model: 'claude-opus-5-5' })));
    // sonnet-medium on 2 easy tasks x 2 reps = 4 runs -> n too small.
    for (const t of ['lookup', 'verify']) for (const r of [1, 2]) rows.push(row('sonnet-medium', t, r, true));
    writeRows(outDir, rows);
    rebuildSummary(outDir);

    const fam = JSON.parse(readFileSync(join(outDir, 'summary-by-family.json'), 'utf8'));
    const high = fam.find((f) => f.cell === 'opus55-high' && f.family === 'real');
    const low = fam.find((f) => f.cell === 'opus55-low' && f.family === 'real');
    const easy = fam.find((f) => f.cell === 'sonnet-medium' && f.family === 'easy');
    assert.equal(high.runs, 7);
    assert.equal(high.passes, 5);
    assert.ok(close(high.pass_at_1, 5 / 7));
    assert.equal(high.n_too_small, false, '7 runs clears the n < 5 flag');
    assert.ok(high.pass_ci95_high >= low.pass_ci95_low, 'the two intervals overlap: not separable');
    assert.equal(easy.runs, 4);
    assert.equal(easy.n_too_small, true);
    assert.equal(easy.k, 2);
    assert.equal(easy.pass_at_k, 1);

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /## By task family \(cell x family\)/);
    assert.match(md, /easy \| sonnet-medium \| 2 \| 4 \| 4 \| 100% \| \[\d+-100%\] \| 100% \(k=2\) \| n too small to separate/);
    assert.match(md, /real \| opus55-high \| 7 \| 7 \| 5 \| 71% \| \[36-92%\]/);
    assert.equal(MIN_N_TO_SEPARATE, 5);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('buildFamilySummary excludes nothing itself; rebuildSummary feeds it non-auth rows only', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-stats-'));
  try {
    writeRows(outDir, [
      row('sonnet-medium', 'lookup', 1, true),
      { ...row('sonnet-medium', 'lookup', 2, false), auth_error: true },
    ]);
    rebuildSummary(outDir);
    const fam = JSON.parse(readFileSync(join(outDir, 'summary-by-family.json'), 'utf8'));
    assert.equal(fam[0].runs, 1, 'the auth_error row never reached the model and is excluded');
    assert.ok(existsSync(join(outDir, 'summary.json')));
    assert.equal(buildFamilySummary([]).length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
