// Regression test for the 2026-09 Track B round 3 delta review, finding 3
// (LOW/MED): "--resume after an interrupted cell can double-count a
// (cell, task, rep) slot: the same deterministic run_id is appended twice
// and rebuildSummary never dedupes by run_id."
//
// scripts/benchmark.mjs's --resume only skips a cell whose own
// .batch-state.json marks it fully COMPLETE. A cell interrupted (auth_error,
// a judge refusal, a weekly ceiling, ...) while a needs_rescore retry was
// still QUEUED but never ADMITTED is not marked complete, so a later
// --resume re-runs that WHOLE cell from scratch at the SAME --rep-start.
// run_id is deterministic (`${cellId}__${taskId}__rep${rep}`), and
// results.jsonl is append-only -- so the abandoned needs_rescore row from
// attempt 1 and the fresh row from the resumed attempt 2 land in the SAME
// file under the exact SAME run_id.
//
// This test builds that results.jsonl by hand (no scheduler/model involved
// -- rebuildSummary() only ever reads the file) and asserts the ONE
// (cell, task, rep) slot is counted ONCE, the winning (fresh, complete) row
// is the one that survives, and summary.md calls out the superseded row by
// name. Fails against the pre-fix rebuildSummary() (n === 2) and passes
// once it dedupes by run_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rebuildSummary } from '../bench/runner.mjs';

const RUN_ID = 'sonnet-medium__adv-round3__rep1';

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-resume-dup-'));
  mkdirSync(join(outDir, 'answers'));
  return outDir;
}

// Attempt 1: genuinely co-scheduled, failed, queued for a solo re-score, but
// the batch stopped (e.g. an auth_error on a sibling run) before the
// re-score retry was ever admitted -- an ABANDONED needs_rescore row with no
// `::rescore` counterpart anywhere in the file.
function abandonedOriginal() {
  return {
    ts: new Date().toISOString(), run_id: RUN_ID, cell: 'sonnet-medium', task: 'adv-round3', task_family: 'pack', rep: 1,
    concurrency: 2, co_scheduled_run_ids: ['other-1'], collision: false, is_collision_retry: false,
    needs_rescore: true, is_rescore_retry: false, requested_model: 'claude-sonnet-5', resolved_model: 'claude-sonnet-5',
    model_mismatch: false, requested_effort: null, pass: false, scope_ok: false, claim_honest: null, claim_text: null,
    extra_files: [], input_tokens: 10, cache_read_tokens: 100, cache_creation_tokens: 0, output_tokens: 50,
    cost_usd: 0.01, num_turns: 2, duration_ms: 500, is_error: false, auth_error: false, isolate_home: false,
    sandbox_cwd: 'C:\\fake\\abandoned-sandbox-attempt1', exec_err: null, detail: { attempt: 1 },
  };
}

test('rebuildSummary dedupes a --resume-duplicated run_id: the fresh attempt wins, the abandoned one is superseded, n stays 1', () => {
  const outDir = tmpOut();
  try {
    const attempt1 = abandonedOriginal();
    // Attempt 2, after --resume re-ran the whole cell from scratch (attempt
    // 1's cell was never marked complete): the SAME run_id, a clean solo
    // pass this time.
    const attempt2 = {
      ...attempt1,
      ts: new Date().toISOString(), concurrency: 1, co_scheduled_run_ids: [], needs_rescore: false,
      pass: true, scope_ok: true, sandbox_cwd: 'C:\\fake\\resumed-sandbox-attempt2', detail: { attempt: 2 },
    };
    writeFileSync(join(outDir, 'results.jsonl'), [attempt1, attempt2].map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === 'adv-round3');
    assert.ok(row, 'a summary row exists for the deduped slot');
    assert.equal(row.n, 1, 'the (cell, task, rep) slot was attempted twice due to --resume, but must count ONCE');
    assert.equal(row.pass_rate, 1, 'the winning row is the fresh, passing attempt -- not the abandoned failure');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /RESUME DUPLICATE: 1 row\(s\)/, 'summary.md must call out exactly one superseded row');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary keeps the ORIGINAL failure when every duplicate attempt was abandoned (no complete row exists at all)', () => {
  const outDir = tmpOut();
  try {
    const attempt1 = abandonedOriginal();
    // Attempt 2 is ALSO abandoned (a second interrupted resume) -- neither
    // row is "complete", so the LAST one in file order wins, and it is
    // still reported as a real failure (fail-open), never silently dropped.
    const attempt2 = {
      ...attempt1,
      ts: new Date().toISOString(), sandbox_cwd: 'C:\\fake\\abandoned-sandbox-attempt2', detail: { attempt: 2 },
    };
    writeFileSync(join(outDir, 'results.jsonl'), [attempt1, attempt2].map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === 'adv-round3');
    assert.ok(row, 'a summary row exists even though every attempt was abandoned');
    assert.equal(row.n, 1, 'still counted exactly once, never doubled');
    assert.equal(row.pass_rate, 0, 'the failure is never silently dropped -- fail open');

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /RESUME DUPLICATE: 1 row\(s\)/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary leaves a run_id with only one row completely alone (no false-positive superseding)', () => {
  const outDir = tmpOut();
  try {
    const single = { ...abandonedOriginal(), needs_rescore: false, pass: true, scope_ok: true };
    writeFileSync(join(outDir, 'results.jsonl'), JSON.stringify(single) + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const row = summary.find((s) => s.task === 'adv-round3');
    assert.equal(row.n, 1);
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /RESUME DUPLICATE/, 'no banner when nothing was actually duplicated');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
