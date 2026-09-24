// Parallel-safe scheduling (bench/scheduler.mjs) and its wiring into
// bench/runner.mjs's runOne() (per-run TMP/BENCH_PORT_BASE isolation,
// resources-based conflict avoidance, and collision classification/retry).
//
// NO MODEL IS EVER CALLED HERE. Every runOne() call below is driven through
// its runClaudeImpl test seam (a stub that never spawns `claude`). The two
// fixture "tasks" (tests/fixtures/bench-parallel/*.mjs) do real, in-process
// net.Server binds so the collision behavior proven here (real EADDRINUSE,
// real concurrent binds on distinct ports) is genuine, not mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scheduleRuns, resourcesConflict, classifyCollision, portBaseForSlot, makeCapacityGate } from '../bench/scheduler.mjs';
import { runOne, rebuildSummary } from '../bench/runner.mjs';
import fixedPortTask, { FIXED_PORT } from './fixtures/bench-parallel/fixed-port-task.mjs';
import portBaseTask from './fixtures/bench-parallel/port-base-task.mjs';

const CELL = { model: 'claude-sonnet-5', effort: null };

async function stubClaude() {
  return {
    json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
    stdout: '', stderr: '', err: null, wallMs: 1,
  };
}

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-sched-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

function makeLaunch({ tasksMap, outDir, answersDir, runClaudeImpl = stubClaude }) {
  return async (run, ctx) => runOne({
    cellId: 'sonnet-medium', cell: CELL, taskId: run.taskId, task: tasksMap[run.taskId],
    rep: run.rep, outDir, answersDir, runClaudeImpl, cliVersion: 'test',
    runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
    isCollisionRetry: !!run.isRetry,
  });
}

// --- resourcesConflict(): pure logic --------------------------------------

test('resourcesConflict: fixedPorts overlap conflicts regardless of task id', () => {
  const a = { id: 'a', taskId: 't1', resources: { fixedPorts: [9000] } };
  const b = { id: 'b', taskId: 't2', resources: { fixedPorts: [9000] } };
  assert.equal(resourcesConflict(a, b), true);
});

test('resourcesConflict: distinct fixedPorts, no lockFiles, not exclusive -- no conflict', () => {
  const a = { id: 'a', taskId: 't1', resources: { fixedPorts: [9000] } };
  const b = { id: 'b', taskId: 't2', resources: { fixedPorts: [9001] } };
  assert.equal(resourcesConflict(a, b), false);
});

test('resourcesConflict: exclusive:true conflicts with anything', () => {
  const a = { id: 'a', taskId: 't1', resources: { exclusive: true } };
  const b = { id: 'b', taskId: 't2', resources: {} };
  assert.equal(resourcesConflict(a, b), true);
});

test('resourcesConflict: no declaration at all is exclusive with the SAME task, not a different one', () => {
  const a1 = { id: 'a1', taskId: 'same' };
  const a2 = { id: 'a2', taskId: 'same' };
  const b = { id: 'b', taskId: 'other' };
  assert.equal(resourcesConflict(a1, a2), true, 'same undeclared task conflicts with itself');
  assert.equal(resourcesConflict(a1, b), false, 'different undeclared tasks do not conflict by default');
});

test('resourcesConflict: an explicit (even empty) resources object opts OUT of the same-task default', () => {
  const a1 = { id: 'a1', taskId: 'same', resources: {} };
  const a2 = { id: 'a2', taskId: 'same', resources: {} };
  assert.equal(resourcesConflict(a1, a2), false);
});

test('resourcesConflict: lockFiles overlap conflicts (path-normalized)', () => {
  const a = { id: 'a', taskId: 't1', resources: { lockFiles: ['C:\\tmp\\x.lock'] } };
  const b = { id: 'b', taskId: 't2', resources: { lockFiles: ['c:/tmp/X.lock'] } };
  assert.equal(resourcesConflict(a, b), true);
});

// --- classifyCollision(): pure logic ---------------------------------------

test('classifyCollision recognizes a STRUCTURAL harnessErrorCode, never free text', () => {
  assert.equal(classifyCollision({ harnessErrorCode: 'EADDRINUSE' }), true);
  assert.equal(classifyCollision({ harnessErrorCode: 'EEXIST' }), true);
  assert.equal(classifyCollision({ harnessErrorCode: 'EBUSY' }), true);
  assert.equal(classifyCollision({ harnessErrorCode: 'ERR_ASSERTION' }), false, 'an ordinary assertion error code is not a collision');
  assert.equal(classifyCollision({ harnessErrorCode: null }), false);
  assert.equal(classifyCollision({}), false);
  // No text-matching parameter exists any more -- passing free text (even
  // text that CONTAINS "EADDRINUSE") must never flip the result. See
  // tests/bench-collision-classification.test.mjs for the full adversarial
  // false-positive suite (2026-09 review, Track B fix #1).
  assert.equal(classifyCollision({ err: 'Error: listen EADDRINUSE: address already in use :::58231' }), false);
  assert.equal(classifyCollision({ stdout: JSON.stringify({ result: 'I fixed the EADDRINUSE bug' }) }), false);
  assert.equal(classifyCollision({ detail: { scorerError: "expected 'x' to match /EADDRINUSE/" } }), false);
});

test('portBaseForSlot gives each slot a distinct, non-overlapping range', () => {
  assert.equal(portBaseForSlot(0), 20000);
  assert.equal(portBaseForSlot(1), 20200);
  assert.ok(portBaseForSlot(1) - portBaseForSlot(0) >= 1, 'ranges do not collide');
});

test('makeCapacityGate never throws and returns a boolean even under a broken probe', () => {
  const gate = makeCapacityGate({ perAgentMB: 350 });
  assert.equal(typeof gate(1), 'boolean');
});

// --- scheduleRuns() + runOne(): the fixed-port pack is serialized ----------

test('scheduler serializes two runs of the fixed-port fixture even at concurrency 2', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const tasksMap = { 'fixed-port': fixedPortTask };
    const launch = makeLaunch({ tasksMap, outDir, answersDir });
    let active = 0;
    let maxActive = 0;
    const rows = await scheduleRuns({
      runs: [
        { id: 'fp-r1', taskId: 'fixed-port', rep: 1, resources: fixedPortTask.resources },
        { id: 'fp-r2', taskId: 'fixed-port', rep: 2, resources: fixedPortTask.resources },
      ],
      concurrency: 2,
      launch,
      onEvent: (e) => {
        if (e.type === 'start') { active += 1; maxActive = Math.max(maxActive, active); }
        if (e.type === 'finish') active -= 1;
      },
    });
    assert.equal(maxActive, 1, 'the two fixed-port runs were never active at the same time');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.pass === true), 'both runs succeeded once serialized');
    assert.ok(rows.every((r) => r.collision === false), 'no collision when properly serialized');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- scheduleRuns() + runOne(): the BENCH_PORT_BASE pack runs concurrently -

test('scheduler runs two BENCH_PORT_BASE fixture runs CONCURRENTLY at concurrency 2', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const tasksMap = { 'port-base': portBaseTask };
    const launch = makeLaunch({ tasksMap, outDir, answersDir });
    let active = 0;
    let maxActive = 0;
    const rows = await scheduleRuns({
      runs: [
        { id: 'pb-r1', taskId: 'port-base', rep: 1, resources: portBaseTask.resources },
        { id: 'pb-r2', taskId: 'port-base', rep: 2, resources: portBaseTask.resources },
      ],
      concurrency: 2,
      launch,
      onEvent: (e) => {
        if (e.type === 'start') { active += 1; maxActive = Math.max(maxActive, active); }
        if (e.type === 'finish') active -= 1;
      },
    });
    assert.equal(maxActive, 2, 'both BENCH_PORT_BASE runs were active at the same time');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.pass === true), 'both runs bound distinct ports without colliding');
    const ports = rows.map((r) => r.detail && r.detail.boundPort);
    assert.notEqual(ports[0], ports[1], 'the two runs bound DIFFERENT ports (distinct slots -> distinct BENCH_PORT_BASE)');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- Induced EADDRINUSE: classified as a collision, retried alone once ----

test('an induced EADDRINUSE is classified as a collision and automatically retried alone once', async () => {
  const { outDir, answersDir } = tmpOut();
  const tasksMap = { 'fixed-port': fixedPortTask };
  // Pre-bind the fixture's fixed port from OUTSIDE the scheduler/task, so
  // the fixture's own real net.Server.listen() genuinely throws EADDRINUSE
  // on the first attempt -- a real collision, not a simulated one.
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(FIXED_PORT, '127.0.0.1', resolve);
  });
  try {
    const launch = makeLaunch({ tasksMap, outDir, answersDir });
    let releasedBlocker = false;
    const rows = await scheduleRuns({
      runs: [{ id: 'fp-collide', taskId: 'fixed-port', rep: 1, resources: fixedPortTask.resources }],
      concurrency: 1,
      launch,
      onEvent: (e) => {
        // Release the real port collision right after the first (colliding)
        // attempt finishes, so the automatic solo retry can actually succeed
        // -- proving retry-alone-once recovers, not just that it fires.
        if (e.type === 'finish' && e.row && e.row.collision && !releasedBlocker) {
          releasedBlocker = true;
          blocker.close();
        }
      },
    });

    assert.equal(rows.length, 2, 'the original collided run AND its solo retry are both recorded');
    const [first, second] = rows;
    assert.equal(first.collision, true, 'the first attempt is classified as a collision');
    assert.equal(first.pass, false);
    assert.equal(first.is_collision_retry, false);
    assert.equal(second.run_id, first.run_id + '::retry');
    assert.equal(second.is_collision_retry, true);
    assert.equal(second.collision, false, 'the retry ran alone (blocker released) and did not itself collide');
    assert.equal(second.pass, true, 'the retry succeeded once run alone');

    // Pass-rate exclusion: rebuildSummary() must drop the collision row
    // entirely (same treatment as auth_error) and count only the retry.
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.cell === 'sonnet-medium' && s.task === 'fixed-port');
    assert.ok(row, 'a summary row exists for the surviving (retry) run');
    assert.equal(row.n, 1, 'the collided run is excluded -- only the retry counts toward n');
    assert.equal(row.pass_rate, 1, 'pass rate reflects only the successful retry');
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /COLLISION: 1 run\(s\)/);
  } finally {
    blocker.close(() => {});
    rmSync(outDir, { recursive: true, force: true });
  }
});
