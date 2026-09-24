// Regression tests for the 2026-09 adversarial review of Track B (bench
// parallel runner), fix #1 (HIGH): classifyCollision() must never read the
// model's own answer text, and a collision only counts as CONFIRMED when
// the automatic solo retry does NOT reproduce the same failure.
//
// Ported from the reviewer's scratch reproduction
// (scratch2-false-collision.test.mjs), with absolute worktree paths replaced
// by ordinary relative imports and the assertions updated to the FIXED
// (structural-signal-only) contract: these tests fail against the OLD
// text-regex classifyCollision() (it misclassified every case below as a
// collision) and pass against the new one.
//
// NO MODEL IS EVER CALLED. Every runOne() call below is driven through its
// runClaudeImpl test seam (a stub that never spawns `claude`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyCollision } from '../bench/scheduler.mjs';
import { runOne, rebuildSummary } from '../bench/runner.mjs';

const CELL = { model: 'claude-sonnet-5', effort: null };

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-false-collision-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

// --- A. Direct classifyCollision() probes: benign model/assertion text ----

test('classifyCollision: a model explaining ITS OWN fix mentions EADDRINUSE -- never a collision', () => {
  // A perfectly ordinary thing for a model doing a "fix the flaky server
  // test" task to say in its final answer -- describing what it did, not
  // reporting a live collision. Even handed the raw stdout under an
  // unrecognized key, classifyCollision() only ever looks at
  // `harnessErrorCode`, so this can never match.
  const benignAnswer = "I found the bug: the test suite intermittently failed with "
    + "'Error: listen EADDRINUSE: address already in use :::3000' because the previous "
    + "test's server was not closed before the next one started. I added server.close() "
    + "in an afterEach hook and all 12 tests now pass.";
  const stdout = JSON.stringify({ result: benignAnswer, is_error: false });
  assert.equal(
    classifyCollision({ stdout, harnessErrorCode: null }),
    false,
    'the model DESCRIBING an EADDRINUSE bug it fixed must never be classified as a live collision',
  );
});

test('classifyCollision: a hidden test\'s own assertion message quoting EADDRINUSE -- never a collision', () => {
  // A hidden-test scorer whose own assertion failure message quotes the
  // EXPECTED error string -- e.g. `assert.match(err.message, /EADDRINUSE/)`
  // failing because the actual message differed. Node stamps assertion
  // errors with code ERR_ASSERTION, never one of the OS collision codes.
  const detail = { scorerError: "AssertionError: expected 'Error: connection refused' to match /EADDRINUSE/", harnessErrorCode: 'ERR_ASSERTION' };
  assert.equal(
    classifyCollision({ detail, harnessErrorCode: detail.harnessErrorCode }),
    false,
    'a hidden-test assertion merely REFERENCING the string EADDRINUSE in its own failure message must never be a collision',
  );
});

test('classifyCollision: "lock" wording in ordinary prose -- never a collision', () => {
  const benignAnswer = 'Refactored the queue to use a lock; the lock is held only while the '
    + 'critical section runs, then released immediately.';
  const stdout = JSON.stringify({ result: benignAnswer });
  assert.equal(classifyCollision({ stdout, harnessErrorCode: null }), false);
});

// --- B. Full runOne() pipeline: a genuine FAILURE is counted, never hidden -

test('runOne+rebuildSummary: a real scoring FAILURE is counted even when the model\'s own answer text mentions EADDRINUSE', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const task = {
      maxBudgetUsd: 0.01, family: 'fixture', resources: {},
      setup() { return {}; },
      prompt() { return 'fix the flaky port-binding test'; },
      // A GENUINE failure: the model's patch did NOT actually fix anything.
      // This is a plain returned verdict, not a thrown error -- exactly what
      // an ordinary hidden-test failure looks like.
      async score() {
        return { pass: false, scope_ok: false, claim_honest: false, extra_files: [] };
      },
    };
    const benignAnswer = "Fixed it: the old code threw EADDRINUSE because the port was already bound; "
      + "I now check for that and retry on a new port.";
    const runClaudeImpl = async () => ({
      json: { result: benignAnswer, is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
      stdout: JSON.stringify({ result: benignAnswer }),
      stderr: '', err: null, wallMs: 5,
    });
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'flaky-fix', task, rep: 1,
      outDir, answersDir, runClaudeImpl, cliVersion: 'test',
    });
    assert.equal(row.pass, false, 'the scorer correctly says this run FAILED the task');
    assert.equal(
      row.collision, false,
      'FIXED: a genuine task failure must never be misclassified as `collision` just because the model\'s own '
      + 'final-answer text mentions EADDRINUSE -- classifyCollision() no longer reads that text at all.',
    );

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const summaryRow = summary.find((s) => s.cell === 'sonnet-medium' && s.task === 'flaky-fix');
    assert.ok(summaryRow, 'the failed run must produce a summary row, not vanish');
    assert.equal(summaryRow.n, 1, 'the failure counts toward n -- never silently excluded like a real collision');
    assert.equal(summaryRow.pass_rate, 0, 'pass rate correctly reflects the real 0/1 failure');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- C. Confirm-on-retry: a collision that reproduces solo is a real fail -

test('a structural collision that ALSO reproduces on its solo retry is reclassified as a REAL failure, never lost from pass-rate math', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    // A task whose score() ALWAYS throws the same structural OS-level error,
    // whether or not it is running alone -- simulating "not actually a
    // scheduling collision, the code is just broken this way every time".
    const alwaysCollidesTask = {
      maxBudgetUsd: 0.01, family: 'fixture', resources: { exclusive: true },
      setup() { return {}; },
      prompt() { return 'fixture: always throws EADDRINUSE'; },
      async score() {
        throw Object.assign(new Error('listen EADDRINUSE: address already in use :::9'), { code: 'EADDRINUSE' });
      },
    };
    const runClaudeImpl = async () => ({
      json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
      stdout: '', stderr: '', err: null, wallMs: 1,
    });

    const original = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'always-collides', task: alwaysCollidesTask, rep: 1,
      outDir, answersDir, runClaudeImpl, cliVersion: 'test',
      runId: 'ac-r1', slot: 0, concurrency: 1, coScheduledRunIds: [],
    });
    assert.equal(original.collision, true, 'the first attempt reports the structural collision signal');

    // The scheduler's own retry semantics (bench/scheduler.mjs) run this
    // SOLO with resources.exclusive forced true -- reproduced directly here
    // without re-driving the full scheduler, since this test is only about
    // rebuildSummary()'s confirm/unconfirm logic.
    const retry = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'always-collides', task: alwaysCollidesTask, rep: 1,
      outDir, answersDir, runClaudeImpl, cliVersion: 'test',
      runId: 'ac-r1::retry', slot: 0, concurrency: 1, coScheduledRunIds: [], isCollisionRetry: true,
    });
    assert.equal(retry.collision, true, 'the retry reproduces the SAME structural failure even running alone');

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.cell === 'sonnet-medium' && s.task === 'always-collides');
    assert.ok(row, 'a summary row must exist -- the reproduced failure is never silently dropped');
    assert.equal(row.n, 1, 'exactly the retry counts (the original stays excluded, still ambiguous)');
    assert.equal(row.pass_rate, 0, 'pass rate correctly reflects the real failure -- never lost as an excluded collision');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /SUSPECTED COLLISION, NOT CONFIRMED: 1 run\(s\)/, 'the original is labelled suspected-not-confirmed, distinct from a real excluded collision');
    assert.doesNotMatch(md, /COLLISION: 1 run\(s\)/, 'the reclassified retry must not also appear in the confirmed-collision count');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

console.log('bench-collision-classification.test.mjs: adversarial false-positive + confirm-on-retry regression tests defined');
