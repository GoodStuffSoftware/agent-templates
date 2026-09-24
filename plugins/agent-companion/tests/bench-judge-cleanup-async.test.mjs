// Regression test for the 2026-09 Track B round 4 review, finding 2 (MED):
// bench/judge.mjs's makeCliJudgeCaller() cleaned up each vote's per-call temp
// cwd through bench/tasks/common.mjs's SYNCHRONOUS rmrf(), which delegates
// its EPERM/EBUSY/ENOTEMPTY retry to fs.rmSync's own maxRetries/retryDelay --
// a blocking backoff wait that stalls the WHOLE event loop (and therefore
// every other concurrently scheduled run on Windows) for as long as the
// retry takes. bench/runner.mjs's runOne()/rescoreOne() already went through
// the ASYNC removeDirWithRetry() for exactly this reason
// (tests/bench-cleanup-retry.test.mjs); this was the one remaining
// synchronous cleanup call in the concurrent run path.
//
// The fix threads a `removeDirImpl` test seam through makeCliJudgeCaller()
// (same style as runOne()'s own `removeDirImpl`), defaulting to the real
// removeDirWithRetry(), and awaits it before resolving instead of calling
// the old rmrf() synchronously and ignoring the result.
//
// NO MODEL IS EVER CALLED. `getBin()` here points at `process.execPath`
// (plain node) with deliberately-invalid-JS `user` text so the "claude"
// child process fails fast with no valid JSON on stdout -- callJudgeViaCli
// only cares that a real child process ran and exited; it never asserts
// eligibility, votes, or a verdict here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeCliJudgeCaller } from '../bench/judge.mjs';
import { removeDirWithRetry } from '../bench/tasks/common.mjs';

// Deliberately unparsable as a `node -p <expr>` script -- guarantees the
// fake "claude" child process exits non-zero with no usable stdout, so
// every test here only has to reason about cleanup, never about a verdict.
const INVALID_JS_PROMPT = ') this is not valid javascript at all (((';

function getFakeClaudeBin() {
  return process.execPath;
}

test('makeCliJudgeCaller routes per-vote cleanup through the injected removeDirImpl, never the old synchronous rmrf, without blocking the event loop', async () => {
  const events = [];
  let seenDir = null;
  let tickPromise = null;
  const removeDirImpl = (dir) => {
    seenDir = dir;
    events.push('cleanup-start');
    // An UNRELATED timer, scheduled the MOMENT cleanup starts, to fire
    // strictly between cleanup-start and cleanup-end (5ms < the 30ms
    // cleanup wait below). If removeDirImpl's wait were ever blocking the
    // event loop (the bug: the old synchronous rmrf()/fs.rmSync retry),
    // this timer could only fire AFTER cleanup finished -- proving the
    // async seam is genuinely awaited (via .then()), not blocked on.
    tickPromise = new Promise((resolve) => setTimeout(() => { events.push('event-loop-tick'); resolve(); }, 5));
    return new Promise((resolve) => {
      setTimeout(() => {
        events.push('cleanup-end');
        resolve({ ok: true, code: null, attempts: 1 });
      }, 30);
    });
  };
  const caller = makeCliJudgeCaller(getFakeClaudeBin, { removeDirImpl });

  const resultPromise = caller({
    system: 'system prompt', user: INVALID_JS_PROMPT, model: 'claude-sonnet-5', effort: null, maxBudgetUsd: 0.01,
  });
  await resultPromise;
  await tickPromise;

  assert.ok(seenDir, 'removeDirImpl was called at all');
  assert.match(path.basename(seenDir), /^bench-judge-/, 'the temp cwd it was called with is the per-vote judge dir');

  const startIdx = events.indexOf('cleanup-start');
  const endIdx = events.indexOf('cleanup-end');
  const tickIdx = events.indexOf('event-loop-tick');
  assert.ok(startIdx !== -1 && endIdx !== -1, 'cleanup ran to completion');
  assert.ok(
    tickIdx > startIdx && tickIdx < endIdx,
    `an unrelated timer must fire WHILE cleanup's async wait is still pending (order was: ${events.join(', ')}) -- ` +
    'proving removeDirImpl is awaited asynchronously rather than blocking the event loop',
  );
});

test('makeCliJudgeCaller only resolves AFTER removeDirImpl settles', async () => {
  let cleanupSettled = false;
  const removeDirImpl = () => new Promise((resolve) => {
    setTimeout(() => { cleanupSettled = true; resolve({ ok: true, code: null, attempts: 1 }); }, 15);
  });
  const caller = makeCliJudgeCaller(getFakeClaudeBin, { removeDirImpl });

  await caller({ system: 's', user: INVALID_JS_PROMPT, model: 'claude-sonnet-5', effort: null, maxBudgetUsd: 0.01 });

  assert.equal(cleanupSettled, true, 'callJudgeViaCli must not resolve before its cleanup promise has settled');
});

test('makeCliJudgeCaller default (real removeDirWithRetry) actually removes the per-vote temp dir from disk, with no injected stub', async () => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bench-judge-')));
  const caller = makeCliJudgeCaller(getFakeClaudeBin); // no options -- exercises the real default
  await caller({ system: 's', user: INVALID_JS_PROMPT, model: 'claude-sonnet-5', effort: null, maxBudgetUsd: 0.01 });
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('bench-judge-') && !before.has(n));
  assert.deepEqual(after, [], 'the real removeDirWithRetry() must have removed the temp cwd it created -- no leaked dir');
});

test('removeDirWithRetry itself resolves the fake dir path with ok:true for a directory that genuinely exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-judge-direct-'));
  const result = await removeDirWithRetry(dir);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(dir), false);
});
