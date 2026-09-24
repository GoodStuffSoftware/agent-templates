// bench/runner.mjs's direct CLI (parseArgs()) refuses --concurrency (and its
// scripts/benchmark.mjs-only siblings) with a message pointing at
// scripts/benchmark.mjs, rather than silently running everything sequentially
// with no RAM gate and no pre-run cost estimate.
//
// Track B adversarial review, fix #3: this direct CLI has no scheduler, no
// capacity gate, and no cost estimate/confirmation gate wired up at all --
// the chosen fix is to REFUSE these args explicitly (not to route them
// through the scheduler here too), documented in parseArgs()'s own
// REFUSED_ARGS comment. See docs/BENCHMARK.md "Parallel runs".
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../bench/runner.mjs';

test('parseArgs refuses --concurrency with a message pointing at scripts/benchmark.mjs', () => {
  assert.throws(
    () => parseArgs(['--cells', 'haiku', '--concurrency', '4']),
    /scripts\/benchmark\.mjs/,
  );
  assert.throws(
    () => parseArgs(['--concurrency', '4']),
    /does not support --concurrency/,
  );
});

test('parseArgs still accepts every arg this direct CLI DOES support, unaffected by the refusal list', () => {
  const out = parseArgs(['--cells', 'haiku,sonnet-medium', '--tasks', 'lookup', '--reps', '2', '--rep-start', '3', '--out', '/tmp/x', '--max-budget-usd', '1.5', '--isolate-home']);
  assert.equal(out.cells, 'haiku,sonnet-medium');
  assert.equal(out.tasks, 'lookup');
  assert.equal(out.reps, 2);
  assert.equal(out.repStart, 3);
  assert.equal(out.out, '/tmp/x');
  assert.equal(out.maxBudgetUsd, 1.5);
  assert.equal(out.isolateHome, true);
});

test('parseArgs refuses every scripts/benchmark.mjs-only flag, not just --concurrency', () => {
  for (const flag of ['--per-agent-mb', '--weekly-usage-pct', '--weekly-ceiling-pct', '--confirm-above-points']) {
    assert.throws(() => parseArgs([flag, '1']), /scripts\/benchmark\.mjs/, `expected ${flag} to be refused`);
  }
  assert.throws(() => parseArgs(['--confirm']), /scripts\/benchmark\.mjs/);
});

test('an unrelated unknown arg still gets the original generic message, not the scripts/benchmark.mjs pointer', () => {
  assert.throws(() => parseArgs(['--totally-made-up']), /^Error: unknown arg: --totally-made-up$/);
});
