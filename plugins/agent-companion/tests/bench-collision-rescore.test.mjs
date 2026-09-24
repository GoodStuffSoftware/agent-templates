// Regression tests for the 2026-09 Track B delta review, round 2, finding 1
// (CONFIRMED HIGH): "collision detection is dead code for real packs". A
// real task pack's score() never throws -- its hidden test catches its own
// subprocess's failure and returns a plain `{ pass: false, detail }` even
// when that subprocess hit a genuine OS-level port collision (FORMAT.md's
// "Hidden test contract" -- the committed example pack's own hidden-test.mjs
// does exactly this). The OLD structural-`.code` classifyCollision() path
// (bench/scheduler.mjs) could never see this shape at all.
//
// The lead's design decision (implemented here, not re-litigated): a
// collision happens in the SCORING phase, and the model's sandbox work is
// already complete and isolated. So a run that FAILS while genuinely
// co-scheduled gets its SAME retained sandbox RE-SCORED SOLO -- never a
// model re-run -- and only the re-score's own outcome decides whether the
// original failure was a real one.
//
// tests/fixtures/bench-parallel/subprocess-collision-catching-task.mjs is
// the fixture: a hidden test that shells out (execFileSync) to a real child
// process (subprocess-bind-child.mjs) that binds a fixed port, in the exact
// "catch everything, never throw" style FORMAT.md documents. This whole
// suite fails against the round 2 base commit (score() never throws, so
// classifyCollision() -> `collision` never fires for this shape, and there
// was no other rescue mechanism at all -- a genuine collision counted as an
// ordinary task failure, uncorrected) and passes once bench/runner.mjs's
// `needsRescore`/`rescoreOne()` and bench/scheduler.mjs's needs_rescore-retry
// queuing exist.
//
// NO MODEL IS EVER CALLED. Every runOne() call below is driven through its
// runClaudeImpl test seam (a stub that never spawns `claude`); rescoreOne()
// accepts no such parameter at all -- it is structurally impossible for it
// to call the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scheduleRuns } from '../bench/scheduler.mjs';
import { runOne, rescoreOne, rebuildSummary } from '../bench/runner.mjs';
import subprocessTask, { SUBPROCESS_FIXED_PORT } from './fixtures/bench-parallel/subprocess-collision-catching-task.mjs';

const CELL = { model: 'claude-sonnet-5', effort: null };
const SUB_TASK_ID = 'subprocess-collision';
const OTHER_TASK_ID = 'unrelated-co-scheduled';

// An unrelated fixture with no resource overlap with subprocessTask, purely
// to give the subprocess-collision run genuine company at launch time --
// bench/runner.mjs's `wasCoScheduled` requires a NON-EMPTY
// co_scheduled_run_ids, which only happens when something else was already
// active when this run was admitted (bench/scheduler.mjs's scheduleRuns()).
const otherTask = {
  maxBudgetUsd: 0.01,
  family: 'fixture',
  resources: {},
  setup() { return {}; },
  prompt() { return 'fixture: unrelated concurrent run'; },
  async score() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] };
  },
};

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-rescore-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

// Mirrors scripts/benchmark.mjs's own launch() dispatch: a needs_rescore
// retry (run.isRescoreRetry, stamped by bench/scheduler.mjs) goes to
// rescoreOne() -- NEVER runOne() again, and never touches runClaudeImpl.
function makeLaunch({ tasksMap, outDir, answersDir, runClaudeImpl, onModelCall }) {
  return async (run, ctx) => {
    if (run.isRescoreRetry) {
      return rescoreOne({
        rescoreState: run.rescoreState, outDir, answersDir,
        slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
      });
    }
    if (onModelCall) onModelCall();
    return runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: run.taskId, task: tasksMap[run.taskId],
      rep: run.rep, outDir, answersDir, runClaudeImpl, cliVersion: 'test',
      runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
      isCollisionRetry: !!run.isRetry,
    });
  };
}

async function stubClaude() {
  return {
    json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
    stdout: '', stderr: '', err: null, wallMs: 1,
  };
}

function bindHolder(port) {
  const holder = net.createServer();
  return new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(port, '127.0.0.1', () => resolve(holder));
  });
}

function closeHolder(holder) {
  return new Promise((resolve) => holder.close(() => resolve()));
}

// Queue order matters: bench/scheduler.mjs's admission loop snapshots
// co_scheduled_run_ids at the moment EACH run is picked, one at a time --
// the FIRST admitted run of a pass always sees an empty `active` set. Put
// `otherTask` first so it is admitted first (co_scheduled_run_ids: []), and
// the subprocess-collision run second, so IT is the one that gets a
// non-empty co_scheduled_run_ids (genuinely "co-scheduled").
function buildRuns() {
  return [
    { id: 'other-r1', taskId: OTHER_TASK_ID, rep: 1, resources: otherTask.resources },
    { id: 'sub-r1', taskId: SUB_TASK_ID, rep: 1, resources: subprocessTask.resources },
  ];
}

// --- Scenario A: the re-score PASSES -- a genuine collision, corrected ----

test('a subprocess collision under real co-scheduling is re-scored alone and PASSES -- the original failure is superseded, never a model re-run', async () => {
  const { outDir, answersDir } = tmpOut();
  const tasksMap = { [OTHER_TASK_ID]: otherTask, [SUB_TASK_ID]: subprocessTask };
  const holder = await bindHolder(SUBPROCESS_FIXED_PORT);
  let modelCalls = 0;
  let releasedHolder = false;
  let sandboxExistedAtOriginalFinish = null;
  try {
    const launch = makeLaunch({ tasksMap, outDir, answersDir, runClaudeImpl: stubClaude, onModelCall: () => { modelCalls += 1; } });
    const rows = await scheduleRuns({
      runs: buildRuns(),
      concurrency: 2,
      launch,
      onEvent: async (e) => {
        if (e.type === 'finish' && e.row && e.row.needs_rescore && !releasedHolder) {
          // Prove the sandbox is genuinely RETAINED at this point (runOne()
          // deliberately skipped its own cleanup) -- before it is handed off
          // to the solo re-score.
          sandboxExistedAtOriginalFinish = existsSync(e.row.sandbox_cwd);
          releasedHolder = true;
          await closeHolder(holder);
        }
      },
    });

    const subOriginal = rows.find((r) => r.task === SUB_TASK_ID && !r.is_rescore_retry);
    const subRescore = rows.find((r) => r.is_rescore_retry);

    assert.ok(subOriginal, 'the original (failing) subprocess-collision row is recorded');
    assert.equal(subOriginal.pass, false, 'the real port collision made the hidden test fail, exactly as a genuine failure would');
    assert.equal(subOriginal.needs_rescore, true, 'it was co-scheduled and failed -- queued for a solo re-score');
    assert.equal(subOriginal.collision, false, 'the legacy structural-collision field never fires for this catching-style shape');
    assert.equal(subOriginal.concurrency, 2);
    assert.ok(subOriginal.co_scheduled_run_ids.length > 0, 'genuinely co-scheduled -- something else was active at launch');
    assert.equal(sandboxExistedAtOriginalFinish, true, 'the sandbox was retained (not deleted) right after the original run finished');

    assert.ok(subRescore, 'a solo re-score retry is recorded');
    assert.equal(subRescore.run_id, subOriginal.run_id + '::rescore');
    assert.equal(subRescore.rescore_of, subOriginal.run_id);
    assert.equal(subRescore.is_rescore_retry, true);
    assert.equal(subRescore.needs_rescore, false);
    assert.equal(subRescore.pass, true, 'running alone (the holder released), the same child now binds the port fine');
    assert.equal(subRescore.collision_rescored, true);
    assert.deepEqual(subRescore.detail.original_failure_detail, subOriginal.detail, 'the ORIGINAL failure detail is kept alongside the re-score');
    assert.equal(existsSync(subOriginal.sandbox_cwd), false, 'the retained sandbox is cleaned up once the re-score completes');

    // "never invokes the model stub": exactly 2 real runs happened (other +
    // the original subprocess-collision attempt) -- the re-score retry must
    // not add a 3rd model call.
    assert.equal(modelCalls, 2, 'the re-score never calls runClaudeImpl -- only the two original runs did');

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.cell === 'sonnet-medium' && s.task === SUB_TASK_ID);
    assert.ok(row, 'a summary row exists for the corrected (re-scored) run');
    assert.equal(row.n, 1, 'the original is excluded; only the re-score counts -- not double-counted');
    assert.equal(row.pass_rate, 1, 'pass rate reflects the corrected verdict');
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /RESCORED: 1 run\(s\)/);
    assert.doesNotMatch(md, /RE-SCORE CONFIRMED A REAL FAILURE/);
  } finally {
    await closeHolder(holder).catch(() => {});
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- Scenario B: the re-score FAILS TOO -- a real failure, still counted --

test('a subprocess failure that reproduces on its solo re-score is counted as a REAL failure, never lost, and the redundant retry is excluded', async () => {
  const { outDir, answersDir } = tmpOut();
  const tasksMap = { [OTHER_TASK_ID]: otherTask, [SUB_TASK_ID]: subprocessTask };
  // The holder is NEVER released in this scenario -- the port stays taken
  // for the whole test, so the automatic solo re-score fails exactly the
  // same way the original attempt did.
  const holder = await bindHolder(SUBPROCESS_FIXED_PORT);
  try {
    const launch = makeLaunch({ tasksMap, outDir, answersDir, runClaudeImpl: stubClaude });
    const rows = await scheduleRuns({ runs: buildRuns(), concurrency: 2, launch });

    const subOriginal = rows.find((r) => r.task === SUB_TASK_ID && !r.is_rescore_retry);
    const subRescore = rows.find((r) => r.is_rescore_retry);

    assert.equal(subOriginal.pass, false);
    assert.equal(subOriginal.needs_rescore, true);
    assert.ok(subRescore, 'the solo re-score retry still ran');
    assert.equal(subRescore.pass, false, 'running alone did not help -- the port really is unavailable');
    assert.equal(subRescore.collision_rescored, false);
    assert.equal(existsSync(subOriginal.sandbox_cwd), false, 'the sandbox is still cleaned up even when the re-score also fails');

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.cell === 'sonnet-medium' && s.task === SUB_TASK_ID);
    assert.ok(row, 'a summary row exists');
    assert.equal(row.n, 1, 'exactly one run counts -- the original failure, not the redundant re-score, and never both');
    assert.equal(row.pass_rate, 0, 'the real failure is never lost from pass-rate math');
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /RE-SCORE CONFIRMED A REAL FAILURE: 1 run\(s\)/);
    assert.doesNotMatch(md, /RESCORED: 1 run\(s\)/);
  } finally {
    await closeHolder(holder).catch(() => {});
    rmSync(outDir, { recursive: true, force: true });
  }
});

console.log('bench-collision-rescore.test.mjs: round 2 solo re-score regression tests defined');
