// Windows-safe sandbox/temp-dir cleanup (2026-09-24 finding): the operator's
// live benchmark round ran 3 reps of the same pack concurrently on Windows,
// and removing a finished run's sandbox directory threw EPERM -- a just-
// exited `claude` child process, an antivirus scanner, or Windows' own
// delayed directory-entry accounting can all hold a removal target busy for
// a few hundred ms after the process that used it has already resolved.
//
// bench/tasks/common.mjs's removeDirWithRetry() is the fix: bounded
// retry-with-backoff on EPERM/EBUSY/ENOTEMPTY, wired into bench/runner.mjs's
// runOne()/rescoreOne() through a `removeDirImpl` test seam (same style as
// runOne()'s own `runClaudeImpl`). A cleanup failure that survives every
// retry must NEVER change a run's pass/fail/collision/needs_rescore verdict
// -- only a `cleanup_error` field (the bare OS code, never a path) is
// recorded on the row, and rebuildSummary()/bench/estimate.mjs both ignore
// it for every stat they compute.
//
// NO MODEL IS EVER CALLED. Every runOne()/rescoreOne() call below is driven
// through runClaudeImpl/removeDirImpl stubs; removeDirWithRetry() itself is
// exercised directly with injected removeImpl/delayImpl seams for the
// lowest-level retry-loop tests, so nothing here waits on a real timer or
// touches a real transient OS failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { removeDirWithRetry } from '../bench/tasks/common.mjs';
import { runOne, rescoreOne, rebuildSummary } from '../bench/runner.mjs';

const CELL = { model: 'claude-sonnet-5', effort: null };

function makeTask(pass) {
  return {
    maxBudgetUsd: 0.01,
    family: 'fixture',
    setup() { return {}; },
    prompt() { return 'fixture prompt -- no model is ever really called'; },
    async score() {
      return { pass, scope_ok: true, claim_honest: null, extra_files: [] };
    },
  };
}

async function stubClaude() {
  return {
    json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 },
    stdout: '', stderr: '', err: null, wallMs: 1,
  };
}

function tmpOut() {
  const outDir = fs.mkdtempSync(join(tmpdir(), 'ac-bench-cleanup-'));
  fs.mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

// A `removeImpl` seam (for removeDirWithRetry() directly, or plumbed through
// runOne()'s `removeDirImpl` as `(dir) => removeDirWithRetry(dir, { removeImpl,
// delayImpl })`) that throws a synthetic error with the given `code` for the
// first `failCount` calls to the SAME path, then genuinely removes it via the
// real fs.rmSync -- so a test can prove the retry loop both fires AND, once
// it succeeds, leaves the real filesystem in the expected state.
function makeFlakyRemove(failCount, code = 'EPERM') {
  const attemptsByPath = new Map();
  return (dir) => {
    const n = (attemptsByPath.get(dir) || 0) + 1;
    attemptsByPath.set(dir, n);
    if (n <= failCount) {
      const err = new Error(`synthetic ${code} on attempt ${n}`);
      err.code = code;
      throw err;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

// A `removeImpl` that always throws the given code -- never actually
// touches the filesystem, so the caller must clean up manually.
function makeAlwaysFailingRemove(code = 'EPERM') {
  return () => {
    const err = new Error(`synthetic ${code}, never recovers`);
    err.code = code;
    throw err;
  };
}

// No-op delay -- keeps every test here instant regardless of retryDelayMs.
async function noDelay() {}

// --- removeDirWithRetry(): the retry loop itself, in isolation --------------

test('removeDirWithRetry: fails twice (EBUSY) then succeeds -- retries and reports a clean result', async () => {
  const delays = [];
  const remove = makeFlakyRemove(2, 'EBUSY');
  const dir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-unit-'));
  try {
    const result = await removeDirWithRetry(dir, {
      removeImpl: remove,
      delayImpl: async (ms) => { delays.push(ms); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
    assert.equal(result.attempts, 3, '2 failures + 1 success = 3 attempts');
    assert.equal(delays.length, 2, 'backed off exactly twice, once per failure');
    assert.ok(delays[1] > delays[0], 'linear backoff -- each wait longer than the last');
    assert.equal(fs.existsSync(dir), false, 'the directory is genuinely gone once the retry succeeds');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

test('removeDirWithRetry: always fails (EPERM) -- exhausts retries, reports ok:false with the code, never throws', async () => {
  const delays = [];
  const dir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-unit-'));
  try {
    const result = await removeDirWithRetry(dir, {
      maxRetries: 3,
      removeImpl: makeAlwaysFailingRemove('EPERM'),
      delayImpl: async (ms) => { delays.push(ms); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EPERM');
    assert.equal(result.attempts, 4, '1 initial attempt + 3 retries');
    assert.equal(delays.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeDirWithRetry: a non-retryable code fails fast -- no delay, no extra attempts', async () => {
  const delays = [];
  const dir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-unit-'));
  try {
    const result = await removeDirWithRetry(dir, {
      removeImpl: makeAlwaysFailingRemove('EACCES'),
      delayImpl: async (ms) => { delays.push(ms); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EACCES');
    assert.equal(result.attempts, 1, 'fails fast -- no retry for a code outside EPERM/EBUSY/ENOTEMPTY');
    assert.equal(delays.length, 0, 'never backs off for a non-retryable code');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeDirWithRetry: ENOTEMPTY is retried too', async () => {
  const remove = makeFlakyRemove(1, 'ENOTEMPTY');
  const dir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-unit-'));
  try {
    const result = await removeDirWithRetry(dir, { removeImpl: remove, delayImpl: noDelay });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// --- runOne(): the retry loop wired all the way through to a real row ------

test('runOne(): a cleanup that fails twice then succeeds retries and gives a clean row (cleanup_error null, sandbox really gone)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'fixture-pass', task: makeTask(true),
      rep: 1, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      removeDirImpl: (dir) => removeDirWithRetry(dir, { removeImpl: makeFlakyRemove(2), delayImpl: noDelay }),
    });
    assert.equal(row.pass, true, 'the real task outcome is unaffected by the transient cleanup failures');
    assert.equal(row.cleanup_error, null, 'once the retry succeeds, no cleanup_error is recorded');
    assert.equal(fs.existsSync(row.sandbox_cwd), false, 'the sandbox really is removed once retrying succeeds');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runOne(): a cleanup that always fails never changes the row\'s real pass/fail, and records cleanup_error (code only)', async () => {
  const { outDir, answersDir } = tmpOut();
  const leaked = [];
  const alwaysFailRemove = async (dir) => { leaked.push(dir); return { ok: false, code: 'EPERM', attempts: 5 }; };
  try {
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'fixture-fail', task: makeTask(false),
      rep: 1, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      removeDirImpl: alwaysFailRemove,
    });
    assert.equal(row.pass, false, 'the real (failing) task verdict is preserved -- cleanup failure never flips it');
    assert.equal(row.collision, false, 'a cleanup failure is not a collision');
    assert.equal(row.needs_rescore, false, 'a cleanup failure is not a needs_rescore condition');
    assert.equal(row.cleanup_error, 'EPERM');
    assert.ok(row.sandbox_cwd, 'sandbox_cwd is still a normal row field');
    assert.ok(fs.existsSync(row.sandbox_cwd), 'the sandbox really is left behind (leaked) when cleanup never succeeds');
  } finally {
    for (const d of leaked) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort in test cleanup */ } }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runOne(): a passing task with a cleanup that always fails also keeps pass:true and still records cleanup_error', async () => {
  const { outDir, answersDir } = tmpOut();
  const leaked = [];
  const alwaysFailRemove = async (dir) => { leaked.push(dir); return { ok: false, code: 'EBUSY', attempts: 5 }; };
  try {
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELL, taskId: 'fixture-pass', task: makeTask(true),
      rep: 1, outDir, answersDir, runClaudeImpl: stubClaude, cliVersion: 'test',
      removeDirImpl: alwaysFailRemove,
    });
    assert.equal(row.pass, true);
    assert.equal(row.cleanup_error, 'EBUSY');
  } finally {
    for (const d of leaked) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort in test cleanup */ } }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// --- rescoreOne(): the same contract on the solo-rescore path ---------------

test('rescoreOne(): a cleanup that always fails keeps the rescore\'s real verdict and records cleanup_error', async () => {
  const { outDir, answersDir } = tmpOut();
  const sandboxDir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-rescore-sandbox-'));
  const runTmpDir = fs.mkdtempSync(join(tmpdir(), 'ac-cleanup-rescore-tmp-'));
  const leaked = [];
  const alwaysFailRemove = async (dir) => { leaked.push(dir); return { ok: false, code: 'ENOTEMPTY', attempts: 5 }; };
  try {
    const originalRow = {
      run_id: 'sonnet-medium__fixture__rep1', cell: 'sonnet-medium', task: 'fixture-pass', rep: 1,
      pass: false, needs_rescore: true, detail: { scorerError: 'original attempt failed while co-scheduled' },
    };
    const rescoreState = { originalRow, sandboxDir, runTmpDir, task: makeTask(true), meta: {}, answerText: 'done' };
    const row = await rescoreOne({
      rescoreState, outDir, answersDir, removeDirImpl: alwaysFailRemove,
    });
    assert.equal(row.pass, true, 'the rescore\'s real verdict (the task passes when scored alone) is preserved');
    assert.equal(row.collision_rescored, true);
    assert.equal(row.cleanup_error, 'ENOTEMPTY');
  } finally {
    for (const d of leaked) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort in test cleanup */ } }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// --- rebuildSummary(): cleanup_error is cosmetic -- never excluded from ----
// --- pass-rate math, but counted and called out in summary.md --------------

test('rebuildSummary: rows with cleanup_error still count normally toward pass_rate, and summary.md flags the leak count', () => {
  const outDir = fs.mkdtempSync(join(tmpdir(), 'ac-bench-summary-cleanup-'));
  try {
    const rows = [
      { cell: 'haiku', task: 'lookup', rep: 1, pass: true, is_error: false, cost_usd: 0.02, output_tokens: 120, num_turns: 3, cleanup_error: 'EPERM' },
      { cell: 'haiku', task: 'lookup', rep: 2, pass: false, is_error: false, cost_usd: 0.02, output_tokens: 90, num_turns: 4 },
    ];
    fs.writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(fs.readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary[0].n, 2, 'both rows count -- cleanup_error never excludes a row');
    assert.equal(summary[0].pass_rate, 0.5, 'pass_rate reflects both real verdicts, unaffected by cleanup_error');

    const md = fs.readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /CLEANUP: 1 run\(s\) left a leaked sandbox\/temp dir/);
    assert.match(md, /never changes any run's pass\/fail/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: no CLEANUP note at all when no row has cleanup_error', () => {
  const outDir = fs.mkdtempSync(join(tmpdir(), 'ac-bench-summary-cleanup-'));
  try {
    const rows = [
      { cell: 'haiku', task: 'lookup', rep: 1, pass: true, is_error: false, cost_usd: 0.02, output_tokens: 120, num_turns: 3 },
    ];
    fs.writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    rebuildSummary(outDir);
    const md = fs.readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /CLEANUP:/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

console.log('bench-cleanup-retry.test.mjs: Windows-safe sandbox cleanup regression tests defined');
