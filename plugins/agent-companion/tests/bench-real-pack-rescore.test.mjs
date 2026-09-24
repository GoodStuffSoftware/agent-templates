// Track B round 3 delta review, finding 4 (LOW, test gap): every other
// needs_rescore/rescoreOne() test (tests/bench-collision-rescore.test.mjs)
// exercises the solo-rescore machinery through plain, hand-written JS task
// objects -- never through the REAL manifest.json -> loadPack() ->
// buildTaskFromPack() -> scheduleRuns()/rescoreOne() pipeline an actual
// `--task-pack` invocation uses. This file closes that gap: a real pack
// (extracted via REAL `git show` from THIS repo's own checkout, same
// mechanism tests/bench-real-pack-resources.test.mjs already proves for
// `resources`) whose hidden test shells out to a real child process that
// binds a fixed port, in the FORMAT.md "catching" style (score() never
// throws) -- co-scheduled with a filler run so a genuine port collision
// happens while genuinely concurrent, triggering needs_rescore end to end.
//
// `HEAD` is used for BOTH parentRef and fixRef (not two distinct commits),
// exactly as tests/bench-real-pack-resources.test.mjs does: this test only
// proves the rescore PIPELINE survives a real pack intact, not fail-at-
// parent/pass-at-fix pack quality (bench-task-pack.test.mjs's committed
// example pack already covers that separately) -- and `HEAD` is the one ref
// guaranteed to resolve regardless of checkout depth (CI's actions/checkout
// runs a SHALLOW clone; an arbitrary older SHA is not guaranteed to be
// fetched, and this repo's own history is not a stable target to pin a test
// fixture to -- see FORMAT.md's re-verification note). Nothing here bakes a
// specific commit SHA into a committed file: parentRefB64/fixRefB64 are
// base64("HEAD"), resolved by `git show` at TEST RUN TIME, every run.
//
// NO MODEL IS EVER CALLED: runOne() is always driven through its
// runClaudeImpl test seam; rescoreOne() accepts no such parameter at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { PLUGIN_ROOT } from './helpers.mjs';
import { loadPack, buildTaskFromPack, encodeRef } from '../bench/task-packs/lib.mjs';
import { scheduleRuns } from '../bench/scheduler.mjs';
import { runOne, rescoreOne, rebuildSummary } from '../bench/runner.mjs';

const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const CELL = { model: 'claude-sonnet-5', effort: null };
const PACK_ID = 'bench-real-pack-rescore-fixture';
const FILLER_TASK_ID = 'unrelated-co-scheduled-filler';
const REAL_PACK_PORT = 58622;

// A hardcoded, non-BENCH_PORT_BASE-derived port -- mirrors
// tests/fixtures/bench-parallel/subprocess-collision-catching-task.mjs's own
// rationale: the genuine collision this test proves comes from something
// OUTSIDE the scheduler's own conflict graph (the test's own "holder"
// socket), not from two runs of this pack colliding with each other.
function makeRealPackDir() {
  const packDir = mkdtempSync(join(tmpdir(), 'ac-real-pack-rescore-fixture-'));
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
    id: PACK_ID,
    parentRefB64: encodeRef('HEAD'),
    fixRefB64: encodeRef('HEAD'),
    files: ['plugins/agent-companion/bench/scheduler.mjs'],
    maxBudgetUsd: 0.05,
    resources: { fixedPorts: [REAL_PACK_PORT] },
  }));
  writeFileSync(
    join(packDir, 'report.md'),
    'Plumbing-only fixture pack for a rescore-pipeline regression test. Not a real bug report.\n',
  );
  // FORMAT.md's "Hidden test contract" catching style: shell out, never
  // throw, turn a subprocess failure into a plain { pass: false, detail }.
  // The child script binds REAL_PACK_PORT in an actually separate process
  // (node -e, port read from an env var to sidestep -e's own argv parsing),
  // so a real OS-level EADDRINUSE is possible -- not a simulated one.
  const childScript = "const net=require('node:net');"
    + "const port=Number(process.env.AC_TEST_PORT);"
    + "const srv=net.createServer();"
    + "srv.on('error',(e)=>{process.stderr.write('bind failed: '+e.code);process.exit(1);});"
    + "srv.listen(port,'127.0.0.1',()=>srv.close(()=>process.exit(0)));";
  writeFileSync(join(packDir, 'hidden-test.mjs'), [
    "import { execFileSync } from 'node:child_process';",
    `const CHILD_SCRIPT = ${JSON.stringify(childScript)};`,
    'export default async function check() {',
    '  let output = ""; let status = 0;',
    '  try {',
    '    output = execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {',
    `      encoding: "utf8", windowsHide: true, env: { ...process.env, AC_TEST_PORT: "${REAL_PACK_PORT}" },`,
    '    });',
    '  } catch (e) {',
    '    status = typeof e.status === "number" ? e.status : 1;',
    '    output = (e.stdout || "") + (e.stderr || "");',
    '  }',
    '  const pass = status === 0;',
    '  return { pass, detail: pass ? "child bound the port fine" : `child exited ${status}: ${output.trim()}` };',
    '}',
    '',
  ].join('\n'));
  return packDir;
}

const filler = {
  maxBudgetUsd: 0.01, family: 'fixture', resources: {},
  setup() { return {}; },
  prompt() { return 'fixture: unrelated concurrent run'; },
  async score() {
    await new Promise((resolve2) => setTimeout(resolve2, 20));
    return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] };
  },
};

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-real-pack-rescore-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

async function stubClaude() {
  return {
    json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
    stdout: '', stderr: '', err: null, wallMs: 1,
  };
}

function bindHolder(port) {
  const holder = net.createServer();
  return new Promise((res, rej) => {
    holder.once('error', rej);
    holder.listen(port, '127.0.0.1', () => res(holder));
  });
}
function closeHolder(holder) { return new Promise((res) => holder.close(() => res())); }

// Queue order matters (see tests/bench-collision-rescore.test.mjs's own
// note): put the filler first so it is admitted first (co_scheduled_run_ids
// empty), and the real pack second, so IT is the one genuinely co-scheduled.
function buildRuns(packTask) {
  return [
    { id: 'filler-1', taskId: FILLER_TASK_ID, rep: 1, resources: filler.resources },
    { id: 'pack-1', taskId: PACK_ID, rep: 1, resources: packTask.resources },
  ];
}

function makeLaunch({ tasksMap, outDir, answersDir, onModelCall }) {
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
      rep: run.rep, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
      isCollisionRetry: !!run.isRetry,
    });
  };
}

test('a real git-backed pack\'s resources.fixedPorts survives loadPack() + buildTaskFromPack() intact (sanity)', () => {
  const packDir = makeRealPackDir();
  try {
    const pack = loadPack(packDir);
    assert.equal(pack.id, PACK_ID);
    assert.equal(pack.parentRef, 'HEAD');
    assert.equal(pack.fixRef, 'HEAD');
    assert.deepEqual(pack.resources, { fixedPorts: [REAL_PACK_PORT] });
    const task = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
    assert.equal(task.__isPackTask, true);
    assert.deepEqual(task.resources, { fixedPorts: [REAL_PACK_PORT] });
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

test('a REAL git-backed pack, genuinely co-scheduled, gets needs_rescore -> solo re-score -> PASSES (never a model re-run)', async () => {
  const packDir = makeRealPackDir();
  const { outDir, answersDir } = tmpOut();
  const pack = loadPack(packDir);
  const packTask = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
  const tasksMap = { [FILLER_TASK_ID]: filler, [PACK_ID]: packTask };
  const holder = await bindHolder(REAL_PACK_PORT);
  let modelCalls = 0;
  let released = false;
  try {
    const launch = makeLaunch({ tasksMap, outDir, answersDir, onModelCall: () => { modelCalls += 1; } });
    const rows = await scheduleRuns({
      runs: buildRuns(packTask),
      concurrency: 2,
      launch,
      onEvent: async (e) => {
        if (e.type === 'finish' && e.row && e.row.needs_rescore && !released) {
          released = true;
          await closeHolder(holder);
        }
      },
    });

    const original = rows.find((r) => r.task === PACK_ID && !r.is_rescore_retry);
    const rescore = rows.find((r) => r.is_rescore_retry);

    assert.ok(original, 'the real pack\'s original run is recorded');
    assert.equal(original.pass, false, 'the real port collision made the real hidden test fail');
    assert.equal(original.needs_rescore, true, 'genuinely co-scheduled and failed -- queued for a solo re-score');
    assert.ok(original.co_scheduled_run_ids.length > 0, 'genuinely co-scheduled');

    assert.ok(rescore, 'a solo re-score retry ran for the real pack');
    assert.equal(rescore.pass, true, 'running alone, the same child now binds the port fine');
    assert.equal(rescore.collision_rescored, true);
    assert.equal(existsSync(original.sandbox_cwd), false, 'the retained real-pack sandbox is cleaned up after re-scoring');
    assert.equal(modelCalls, 2, 'the re-score never invokes the model stub -- only the two original runs did');

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === PACK_ID);
    assert.ok(row, 'a summary row exists for the real pack');
    assert.equal(row.n, 1, 'the original is excluded; only the re-score counts');
    assert.equal(row.pass_rate, 1);
  } finally {
    await closeHolder(holder).catch(() => {});
    rmSync(packDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a REAL git-backed pack that fails its solo re-score too is counted as a REAL failure, exactly once', async () => {
  const packDir = makeRealPackDir();
  const { outDir, answersDir } = tmpOut();
  const pack = loadPack(packDir);
  const packTask = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
  const tasksMap = { [FILLER_TASK_ID]: filler, [PACK_ID]: packTask };
  // The holder is NEVER released -- the port stays taken for the whole test,
  // so the automatic solo re-score fails exactly the same way the original
  // attempt did.
  const holder = await bindHolder(REAL_PACK_PORT);
  try {
    const launch = makeLaunch({ tasksMap, outDir, answersDir });
    const rows = await scheduleRuns({ runs: buildRuns(packTask), concurrency: 2, launch });

    const original = rows.find((r) => r.task === PACK_ID && !r.is_rescore_retry);
    const rescore = rows.find((r) => r.is_rescore_retry);

    assert.equal(original.needs_rescore, true);
    assert.equal(original.pass, false);
    assert.ok(rescore, 'the solo re-score retry still ran');
    assert.equal(rescore.pass, false, 'running alone did not help -- the port really is unavailable');
    assert.equal(rescore.collision_rescored, false);

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === PACK_ID);
    assert.ok(row);
    assert.equal(row.n, 1, 'exactly one run counts -- the original failure, never the redundant re-score, never both');
    assert.equal(row.pass_rate, 0, 'the real failure is never lost from pass-rate math');
  } finally {
    await closeHolder(holder).catch(() => {});
    rmSync(packDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
