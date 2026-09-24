// Regression + property coverage for the 2026-09 Track B round 4 review,
// finding 1 (MED-HIGH): the round-3 --resume dedup in rebuildSummary()
// (bench/runner.mjs) grouped rows by EXACT run_id string. A `::retry`/
// `::rescore` CHILD row's run_id is unique in the file (nothing else is ever
// literally "X::rescore"), so it formed its own singleton group and was
// NEVER dropped even when its PARENT original row lost to a fresh
// `--resume` attempt under the bare id `X` -- the orphaned child survived
// and double-counted one (cell, task, rep) slot.
//
// The fix (groupRunsByAttemptFamily(), exported from bench/runner.mjs)
// dedupes by ATTEMPT FAMILY instead: each appearance of a base original row
// starts a new family that owns every `::retry`/`::rescore` child that
// follows it in FILE ORDER, up to the next original of the same base id.
// The winning family is the latest one, except an abandoned family (a
// needs_rescore original whose own rescore never arrived) never beats a
// later family of any standing; when every family for a slot is abandoned,
// the last one still counts (fail open -- a failure already recorded is
// never silently dropped).
//
// Both tests below fail against the pre-fix commit (exact run_id dedup) and
// pass once the family grouping lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rebuildSummary, groupRunsByAttemptFamily } from '../bench/runner.mjs';

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-family-dedupe-'));
  mkdirSync(join(outDir, 'answers'));
  return outDir;
}

function baseRow(overrides) {
  return {
    ts: new Date().toISOString(), cell: 'sonnet-medium', task_family: 'pack', rep: 1,
    concurrency: 1, co_scheduled_run_ids: [], collision: false, is_collision_retry: false,
    needs_rescore: false, is_rescore_retry: false, requested_model: 'claude-sonnet-5', resolved_model: 'claude-sonnet-5',
    model_mismatch: false, requested_effort: null, pass: false, scope_ok: false, claim_honest: null, claim_text: null,
    extra_files: [], input_tokens: 10, cache_read_tokens: 100, cache_creation_tokens: 0, output_tokens: 50,
    cost_usd: 0.01, num_turns: 2, duration_ms: 500, is_error: false, auth_error: false, isolate_home: false,
    sandbox_cwd: 'C:\\fake\\sandbox', exec_err: null, detail: null,
    ...overrides,
  };
}

test('regression (round 4 finding 1): an orphaned ::retry from a superseded attempt is dropped along with its parent', () => {
  const outDir = tmpOut();
  try {
    const RUN_ID = 'sonnet-medium__orphan-retry__rep1';
    // Attempt 1: a structural collision, automatically retried solo -- the
    // retry completes and PASSES, but the whole CELL still isn't marked
    // complete (an unrelated sibling run's auth_error aborts the batch), so
    // --resume reruns this exact rep from scratch under the SAME run_id.
    const attempt1Original = baseRow({ run_id: RUN_ID, task: 'orphan-retry', collision: true, pass: false, detail: { attempt: 1 } });
    const attempt1Retry = baseRow({
      run_id: RUN_ID + '::retry', task: 'orphan-retry', is_collision_retry: true, collision: false, pass: true,
      detail: { attempt: 1, retry: true },
    });
    // Attempt 2: the fresh --resume rerun. Clean, no collision this time,
    // and it fails on its own merits.
    const attempt2 = baseRow({ run_id: RUN_ID, task: 'orphan-retry', pass: false, detail: { attempt: 2 } });
    writeFileSync(
      join(outDir, 'results.jsonl'),
      [attempt1Original, attempt1Retry, attempt2].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === 'orphan-retry');
    assert.ok(row, 'a summary row exists for the slot');
    assert.equal(row.n, 1, 'the orphaned ::retry from the superseded attempt 1 must not survive as an extra counted row');
    assert.equal(row.pass_rate, 0, 'only attempt 2 (the fresh resume, which failed on its own) should count');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /RESUME DUPLICATE: 2 row\(s\)/, 'both of attempt 1\'s rows (original + orphaned retry) are reported as superseded');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('regression: a needs_rescore original whose rescore already PASSED still loses to a later fresh --resume attempt', () => {
  // This is the exact shape of the round-3 repro
  // (repro-orphan-child-double-count.mjs): attempt 1's rescore is not
  // abandoned at all -- it was admitted and passed -- but the cell was
  // still resumed (a DIFFERENT rep's auth_error aborted the batch before
  // the cell was marked complete), so attempt 2 must still win.
  const outDir = tmpOut();
  try {
    const RUN_ID = 'sonnet-medium__resumed-after-rescore__rep1';
    const attempt1Original = baseRow({ run_id: RUN_ID, task: 'resumed-after-rescore', needs_rescore: true, pass: false, detail: { attempt: 1 } });
    const attempt1Rescore = baseRow({
      run_id: RUN_ID + '::rescore', task: 'resumed-after-rescore', is_rescore_retry: true, needs_rescore: false, pass: true,
      detail: { rescore: null, original_failure_detail: { attempt: 1 } },
    });
    const attempt2 = baseRow({ run_id: RUN_ID, task: 'resumed-after-rescore', pass: true, detail: { attempt: 2 } });
    writeFileSync(
      join(outDir, 'results.jsonl'),
      [attempt1Original, attempt1Rescore, attempt2].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === 'resumed-after-rescore');
    assert.ok(row);
    assert.equal(row.n, 1, 'attempt 1 (original + its passing rescore) must be dropped wholesale once attempt 2 exists');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- Property test -----------------------------------------------------
//
// Deterministic seeded PRNG (mulberry32) so a failure is reproducible from
// the printed seed alone -- no external RNG dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260924;
const NUM_SEQUENCES = 300;
const MAX_REPS_PER_SEQUENCE = 4;
const MAX_ATTEMPTS_PER_REP = 3;

// One rep's full on-disk history: 1..MAX_ATTEMPTS_PER_REP attempts under the
// SAME deterministic base run_id (simulating one or more --resume cycles),
// each attempt independently shaped as:
//   - "plain"   : a single complete row, pass/fail random. Not abandoned.
//   - "rescued" : needs_rescore original (pass:false, matching the real
//                 system's invariant that needs_rescore only ever marks a
//                 FAILING co-scheduled run) + an ADMITTED ::rescore child,
//                 pass/fail random. Not abandoned; the rescue-exclude logic
//                 (unchanged by this fix) makes the family's EFFECTIVE pass
//                 equal to the rescore's own pass.
//   - "abandoned": needs_rescore original (pass:false), no rescore ever
//                 admitted (an auth_error/judge-refusal interrupted the
//                 cell first). Abandoned; effective pass is the original's
//                 own (always false).
// Returns { rows, effectivePass, abandoned } for the WINNING attempt,
// computed by an independent reference reducer (not the code under test),
// plus the full flat row list in file order for this rep.
function makeRepChain(rng, cell, task, rep) {
  const runId = `${cell}__${task}__rep${rep}`;
  const numAttempts = 1 + Math.floor(rng() * MAX_ATTEMPTS_PER_REP);
  const rows = [];
  const attempts = []; // { abandoned, effectivePass }
  for (let a = 0; a < numAttempts; a += 1) {
    const shapeRoll = rng();
    if (shapeRoll < 0.5) {
      // plain
      const pass = rng() < 0.5;
      rows.push(baseRow({ run_id: runId, cell, task, rep, pass, detail: { attempt: a, shape: 'plain' } }));
      attempts.push({ abandoned: false, effectivePass: pass });
    } else if (shapeRoll < 0.8) {
      // rescued: admitted rescore
      rows.push(baseRow({ run_id: runId, cell, task, rep, needs_rescore: true, pass: false, detail: { attempt: a, shape: 'rescued-original' } }));
      const rescorePass = rng() < 0.5;
      rows.push(baseRow({
        run_id: runId + '::rescore', cell, task, rep, is_rescore_retry: true, needs_rescore: false, pass: rescorePass,
        detail: { attempt: a, shape: 'rescued-rescore' },
      }));
      attempts.push({ abandoned: false, effectivePass: rescorePass });
    } else {
      // abandoned: needs_rescore with no admitted rescore
      rows.push(baseRow({ run_id: runId, cell, task, rep, needs_rescore: true, pass: false, detail: { attempt: a, shape: 'abandoned' } }));
      attempts.push({ abandoned: true, effectivePass: false });
    }
  }

  // Independent reference reducer, mirroring the spec in prose (NOT the
  // implementation under test): a non-abandoned attempt always beats an
  // abandoned one regardless of order; among attempts of the same standing,
  // the later one wins.
  let winner = attempts[0];
  for (let i = 1; i < attempts.length; i += 1) {
    const candidate = attempts[i];
    if (winner.abandoned && !candidate.abandoned) { winner = candidate; continue; }
    if (!winner.abandoned && candidate.abandoned) continue;
    winner = candidate;
  }

  return { rows, expectedPass: winner.effectivePass };
}

// Riffle-merges several ordered row streams (one per rep) into a single
// file-order sequence, preserving each stream's own internal order while
// randomizing the interleaving between streams -- exactly how concurrent
// scheduling actually interleaves unrelated reps' rows in a real
// results.jsonl, and the exact condition that makes file-position-based
// family boundaries (not run_id string matching) necessary.
function riffle(rng, streams) {
  const queues = streams.map((s) => [...s]);
  const out = [];
  while (queues.some((q) => q.length > 0)) {
    const nonEmpty = queues.map((q, i) => i).filter((i) => queues[i].length > 0);
    const pick = nonEmpty[Math.floor(rng() * nonEmpty.length)];
    out.push(queues[pick].shift());
  }
  return out;
}

test(`property: n per (cell, task) always equals the number of distinct reps attempted (seed=${SEED}, sequences=${NUM_SEQUENCES}, maxReps=${MAX_REPS_PER_SEQUENCE}, maxAttemptsPerRep=${MAX_ATTEMPTS_PER_REP})`, () => {
  const rng = mulberry32(SEED);
  let totalOperations = 0;
  const outDir = tmpOut();
  try {
    for (let seq = 0; seq < NUM_SEQUENCES; seq += 1) {
      const cell = 'sonnet-medium';
      const task = `prop-task-${seq}`;
      const numReps = 1 + Math.floor(rng() * MAX_REPS_PER_SEQUENCE);
      const repStreams = [];
      let expectedPassCount = 0;
      for (let rep = 1; rep <= numReps; rep += 1) {
        const { rows, expectedPass } = makeRepChain(rng, cell, task, rep);
        totalOperations += rows.length;
        repStreams.push(rows);
        if (expectedPass) expectedPassCount += 1;
      }
      const interleaved = riffle(rng, repStreams);

      writeFileSync(join(outDir, 'results.jsonl'), interleaved.map((r) => JSON.stringify(r)).join('\n') + '\n');
      rebuildSummary(outDir);

      const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
      const row = summary.find((s) => s.task === task);
      assert.ok(row, `sequence ${seq}: a summary row exists`);
      assert.equal(row.n, numReps, `sequence ${seq}: n must equal the ${numReps} distinct rep(s) attempted, regardless of retries/rescores/interrupts/resumes within each rep`);
      const actualPassCount = Math.round(row.pass_rate * row.n);
      assert.equal(actualPassCount, expectedPassCount, `sequence ${seq}: the winning attempt's effective pass/fail per rep must match the independent reference reducer`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  // Sanity: the property actually exercised a meaningful number of rows,
  // not a degenerate all-single-attempt run.
  assert.ok(totalOperations > NUM_SEQUENCES * 2, `expected a healthy mix of multi-row attempts; only saw ${totalOperations} total rows across ${NUM_SEQUENCES} sequences`);
});

test('groupRunsByAttemptFamily: rows without a run_id are left alone, never merged', () => {
  const a = baseRow({ run_id: undefined, task: 'no-id' });
  delete a.run_id;
  const b = baseRow({ run_id: undefined, task: 'no-id' });
  delete b.run_id;
  const { winners, supersededRows } = groupRunsByAttemptFamily([a, b]);
  assert.equal(winners.size, 2, 'both run_id-less rows survive as their own singleton families');
  assert.equal(supersededRows.length, 0);
});
