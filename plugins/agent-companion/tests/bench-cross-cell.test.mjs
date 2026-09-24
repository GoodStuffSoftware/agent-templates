// Track B adversarial review, fix #2 (MED-HIGH): --concurrency used to bound
// EACH CELL separately (scripts/benchmark.mjs ran one bench/scheduler.mjs
// pool per cell, cells strictly one after another) even though the operator
// wants grid-wide parallelism across a multi-pack round. scripts/benchmark.mjs
// now flattens every requested cell into ONE global plan
// (buildGlobalRunPlan()) and drives it through a single scheduler pool
// (runGlobalPool()), so two DIFFERENT cells' runs can be active at once.
//
// This proves that by EXECUTION, not by reading the source: a stubbed, slow
// `runOneImpl` (runGlobalPool()'s injection point, exactly like runOne()'s
// own `runClaudeImpl` test seam used throughout tests/bench-scheduler.test.mjs)
// records which cell each concurrently-active run belongs to. NO MODEL IS
// EVER CALLED, and no real `claude` (or stand-in) binary is spawned at all --
// this exercises the REAL production plan-building and scheduling code
// (buildGlobalRunPlan, runGlobalPool, bench/scheduler.mjs's scheduleRuns())
// with only the leaf "spawn claude and wait" step replaced, the same way
// every other bench test in this suite avoids a real child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGlobalRunPlan, runGlobalPool } from '../scripts/benchmark.mjs';

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-cross-cell-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

// A trivial tasksMap: buildGlobalRunPlan() only reads `.resources` off it.
const tasksMap = {
  'task-a': { resources: {} },
  'task-b': { resources: {} },
};

test('buildGlobalRunPlan flattens EVERY requested cell x task x rep into one plan, in stable order', () => {
  const plan = buildGlobalRunPlan({ cellIds: ['haiku', 'sonnet-medium'], taskIds: ['task-a', 'task-b'], tasksMap, reps: 2 });
  assert.equal(plan.length, 8); // 2 cells x 2 tasks x 2 reps
  assert.ok(plan.some((r) => r.cellId === 'haiku'));
  assert.ok(plan.some((r) => r.cellId === 'sonnet-medium'));
  assert.deepEqual(plan.map((r) => r.id).slice(0, 2), ['haiku__task-a__rep1', 'haiku__task-a__rep2']);
});

test('CROSS-CELL OVERLAP: runGlobalPool() runs two DIFFERENT cells\' runs concurrently under one --concurrency budget', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const plan = buildGlobalRunPlan({ cellIds: ['haiku', 'sonnet-medium'], taskIds: ['task-a'], tasksMap, reps: 1 });
    assert.equal(plan.length, 2, 'one run per cell');
    assert.notEqual(plan[0].cellId, plan[1].cellId, 'sanity: the two runs really do belong to DIFFERENT cells');

    let maxActive = 0;
    const currentlyActiveCells = new Set();
    const activeCellsAtPeak = new Set();
    // A deliberately SLOW stub (bench/scheduler.mjs's admission loop must
    // genuinely hold both runs open at once for this to prove anything) --
    // never spawns a process, never calls a model.
    const slowStubRunOne = async ({ cellId }) => {
      currentlyActiveCells.add(cellId);
      if (currentlyActiveCells.size > maxActive) {
        maxActive = currentlyActiveCells.size;
        activeCellsAtPeak.clear();
        for (const c of currentlyActiveCells) activeCellsAtPeak.add(c);
      }
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      currentlyActiveCells.delete(cellId);
      return { run_id: `${cellId}-row`, cell: cellId, pass: true, collision: false };
    };

    const { rows, stopReason } = await runGlobalPool({
      plan, concurrency: 2, canAfford: () => true, outDir, answersDir, tasksMap,
      args: { maxBudgetUsd: null, isolateHome: false }, judgeOpt: null, runOneImpl: slowStubRunOne,
    });

    assert.equal(stopReason, null);
    assert.equal(rows.length, 2);
    assert.equal(maxActive, 2, 'both runs were active at the exact same time under one shared --concurrency budget');
    assert.equal(activeCellsAtPeak.size, 2, `the two SIMULTANEOUSLY active runs belonged to two DIFFERENT cells: saw ${[...activeCellsAtPeak].join(', ')}`);
    assert.ok(activeCellsAtPeak.has('haiku') && activeCellsAtPeak.has('sonnet-medium'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runGlobalPool() stops admitting new runs after an auth_error, but lets in-flight runs finish (partial results)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const plan = buildGlobalRunPlan({ cellIds: ['haiku', 'sonnet-medium', 'opus5-high'], taskIds: ['task-a'], tasksMap, reps: 1 });
    assert.equal(plan.length, 3);

    let started = 0;
    const runOneImpl = async ({ cellId }) => {
      started += 1;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      if (cellId === 'haiku') return { run_id: 'haiku-row', cell: cellId, pass: true, auth_error: true };
      return { run_id: `${cellId}-row`, cell: cellId, pass: true, auth_error: false };
    };

    const { rows, stopReason } = await runGlobalPool({
      plan, concurrency: 1, canAfford: () => true, outDir, answersDir, tasksMap,
      args: { maxBudgetUsd: null, isolateHome: false }, judgeOpt: null, runOneImpl,
    });

    assert.ok(stopReason && stopReason.type === 'auth_error', 'the auth_error must be surfaced as the stop reason');
    // concurrency 1 here means runs are admitted strictly one at a time, so
    // the auth_error on the FIRST run stops the second/third from ever
    // starting -- exactly the "no NEW run after the ceiling" contract.
    assert.equal(rows.length, 1, 'only the auth_error run itself was ever started');
    assert.equal(started, 1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
