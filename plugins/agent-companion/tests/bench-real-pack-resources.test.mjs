// Track B adversarial review, fix #5 (test gap): every other `resources`
// test (tests/bench-scheduler.test.mjs, tests/bench-collision-classification
// .test.mjs) exercises bench/scheduler.mjs's conflict/collision logic
// through plain, hand-written JS task modules
// (tests/fixtures/bench-parallel/*.mjs) -- never through the REAL
// manifest.json -> loadPack() -> buildTaskFromPack() -> scheduleRuns()
// pipeline an actual `--task-pack` invocation uses. This file closes that
// gap: a real pack directory (manifest.json declaring
// `resources.fixedPorts`, report.md, hidden-test.mjs), extracted via REAL
// `git show` from THIS repo's own checkout (`--pack-repo`), scheduled
// alongside another run declaring the SAME fixed port via a plain fixture --
// proving the manifest's `resources` field genuinely reaches
// resourcesConflict() end to end, not just via the shortcut fixtures.
//
// `HEAD` is used for BOTH parentRef and fixRef (not two distinct commits):
// this test only proves the RESOURCES field survives the pipeline intact,
// not fail-at-parent/pass-at-fix pack quality (bench-task-pack.test.mjs's
// committed example pack already covers that separately) -- and `HEAD` is
// the one ref guaranteed to resolve regardless of checkout depth (CI's
// actions/checkout runs a SHALLOW clone; an arbitrary older SHA or `HEAD^`
// is not guaranteed to be fetched).
//
// NO MODEL IS EVER CALLED: runOne() is always driven through its
// runClaudeImpl test seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PLUGIN_ROOT } from './helpers.mjs';
import { loadPack, buildTaskFromPack, encodeRef } from '../bench/task-packs/lib.mjs';
import { scheduleRuns, resourcesConflict } from '../bench/scheduler.mjs';
import { runOne } from '../bench/runner.mjs';

const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const CELL = { model: 'claude-sonnet-5', effort: null };
const FIXED_PORT = 58999;

async function stubClaude() {
  return {
    json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
    stdout: '', stderr: '', err: null, wallMs: 1,
  };
}

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-real-pack-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

function makeRealPackDir() {
  const packDir = mkdtempSync(join(tmpdir(), 'ac-real-pack-fixture-'));
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
    id: 'bench-real-pack-resources-fixture',
    parentRefB64: encodeRef('HEAD'),
    fixRefB64: encodeRef('HEAD'),
    files: ['plugins/agent-companion/bench/scheduler.mjs'],
    maxBudgetUsd: 0.05,
    resources: { fixedPorts: [FIXED_PORT] },
  }));
  writeFileSync(join(packDir, 'report.md'), 'Plumbing-only fixture pack for a resources-field regression test. Not a real bug report.\n');
  writeFileSync(join(packDir, 'hidden-test.mjs'), 'export default async function check() { return { pass: true, detail: "plumbing test only" }; }\n');
  return packDir;
}

test('a real manifest.json\'s resources.fixedPorts survives loadPack() + buildTaskFromPack() intact', () => {
  const packDir = makeRealPackDir();
  try {
    const pack = loadPack(packDir);
    assert.deepEqual(pack.resources, { fixedPorts: [FIXED_PORT] }, 'loadPack() preserves the manifest resources field verbatim');
    const task = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
    assert.deepEqual(task.resources, { fixedPorts: [FIXED_PORT] }, 'buildTaskFromPack() wires manifest.resources onto the runnable task unchanged');
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

test('a REAL git-backed pack run and a plain fixture declaring the SAME fixedPort are never co-scheduled', async () => {
  const packDir = makeRealPackDir();
  const { outDir, answersDir } = tmpOut();
  try {
    const pack = loadPack(packDir);
    const packTask = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
    assert.equal(resourcesConflict(
      { id: 'a', taskId: 'pack', resources: packTask.resources },
      { id: 'b', taskId: 'other', resources: { fixedPorts: [FIXED_PORT] } },
    ), true, 'sanity: the extracted task\'s resources really do conflict on the declared port');

    const otherFixedPortTask = {
      maxBudgetUsd: 0.01, family: 'fixture', resources: { fixedPorts: [FIXED_PORT] },
      setup() { return {}; },
      prompt() { return 'fixture: declares the SAME fixed port as the real pack'; },
      async score() { return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] }; },
    };

    const tasksMap = { 'real-pack-fixture': packTask, 'other-fixed-port': otherFixedPortTask };
    const launch = async (run, ctx) => runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: run.taskId, task: tasksMap[run.taskId],
      rep: run.rep, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
    });

    let active = 0;
    let maxActive = 0;
    const rows = await scheduleRuns({
      runs: [
        { id: 'real-pack-r1', taskId: 'real-pack-fixture', rep: 1, resources: packTask.resources },
        { id: 'other-r1', taskId: 'other-fixed-port', rep: 1, resources: otherFixedPortTask.resources },
      ],
      concurrency: 2,
      launch,
      onEvent: (e) => {
        if (e.type === 'start') { active += 1; maxActive = Math.max(maxActive, active); }
        if (e.type === 'finish') active -= 1;
      },
    });
    assert.equal(rows.length, 2);
    assert.equal(maxActive, 1, 'the real git-backed pack and the plain fixture sharing fixedPorts:[58999] were correctly serialized, never co-active');
    assert.ok(rows.every((r) => r.pass === true), 'both runs completed (the real git extraction for the pack actually ran)');
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a real pack declaring a DIFFERENT fixed port than another run is scheduled concurrently, not serialized', async () => {
  const packDir = makeRealPackDir(); // declares FIXED_PORT (58999)
  const { outDir, answersDir } = tmpOut();
  try {
    const pack = loadPack(packDir);
    const packTask = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
    const distinctPortTask = {
      maxBudgetUsd: 0.01, family: 'fixture', resources: { fixedPorts: [FIXED_PORT + 1] },
      setup() { return {}; },
      prompt() { return 'fixture: declares a DIFFERENT fixed port'; },
      async score() { return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] }; },
    };
    const tasksMap = { 'real-pack-fixture': packTask, 'distinct-fixed-port': distinctPortTask };
    const launch = async (run, ctx) => runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: run.taskId, task: tasksMap[run.taskId],
      rep: run.rep, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      runId: run.id, slot: ctx.slot, concurrency: ctx.concurrency, coScheduledRunIds: ctx.coScheduledRunIds,
    });
    let active = 0;
    let maxActive = 0;
    const rows = await scheduleRuns({
      runs: [
        { id: 'real-pack-r1', taskId: 'real-pack-fixture', rep: 1, resources: packTask.resources },
        { id: 'distinct-r1', taskId: 'distinct-fixed-port', rep: 1, resources: distinctPortTask.resources },
      ],
      concurrency: 2,
      launch,
      onEvent: (e) => {
        if (e.type === 'start') { active += 1; maxActive = Math.max(maxActive, active); }
        if (e.type === 'finish') active -= 1;
      },
    });
    assert.equal(rows.length, 2);
    assert.equal(maxActive, 2, 'distinct declared ports never conflict -- both were active at once');
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
