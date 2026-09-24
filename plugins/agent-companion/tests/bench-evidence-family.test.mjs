// Evidence-family classification (bench/evidence-family.mjs): real-world vs
// synthetic benchmark evidence must never be pooled -- in a summary, in the
// pre-run estimator, or in a routing/proposal comparison. See
// docs/BENCHMARK.md "Evidence families" for the full rationale (operator
// direction, 2026-09-24).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  rebuildSummary, buildFamilySummary, taskFamilyOf, relativeCostIndexOrNull, runOne,
  parseArgs, checkEvidenceFamilyOverridePreflight, withEvidenceFamilyOverride,
} from '../bench/runner.mjs';
import {
  FINE_FAMILIES, coarseOf, evidenceFamilyOf, assertComparableEvidence,
  matchLocalEvidenceFamilyMapping, compileTaskIdPattern,
} from '../bench/evidence-family.mjs';
import {
  mediansFor, estimateRun, roughGuessFallbackFor, loadLocalHistory, fineFamilyOfHistoryRow,
} from '../bench/estimate.mjs';

function writeRows(dir, rows) {
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function row(cell, task, rep, pass, extra = {}) {
  return {
    cell, task, rep, pass, is_error: false, auth_error: false, requested_model: 'claude-opus-5-5',
    cost_usd: 0.2, num_turns: 4, cache_read_tokens: 2000, input_tokens: 10, output_tokens: 50, ...extra,
  };
}

// --- Registry sanity ---------------------------------------------------

test('FINE_FAMILIES/coarseOf: every shipped fine label resolves to real or synthetic, never unknown', () => {
  for (const [fine, kind] of Object.entries(FINE_FAMILIES)) {
    assert.ok(kind === 'real' || kind === 'synthetic', `${fine} must be real or synthetic`);
    assert.equal(coarseOf(fine), kind);
  }
  assert.equal(coarseOf('not-a-real-label'), 'unknown');
});

test('assertComparableEvidence: refuses to compare across coarse families, and refuses synthetic-justified downgrades', () => {
  assert.doesNotThrow(() => assertComparableEvidence('easy-synthetic', 'hard-synthetic'));
  assert.doesNotThrow(() => assertComparableEvidence('real-bugfix', 'architecture'));
  assert.throws(() => assertComparableEvidence('real-bugfix', 'easy-synthetic'), /never pooled or compared directly/);
  assert.throws(() => assertComparableEvidence('bogus', 'real-bugfix'), /unclassified/);
  // An upgrade (forDowngrade not set) is fine on synthetic-only evidence...
  assert.doesNotThrow(() => assertComparableEvidence('easy-synthetic', 'easy-synthetic', { forDowngrade: false }));
  // ...but a downgrade never is (ADR 0003 "Decision rules" R3).
  assert.throws(
    () => assertComparableEvidence('easy-synthetic', 'easy-synthetic', { forDowngrade: true }),
    /can never justify a downgrade/,
  );
});

// --- Legacy-row classification -----------------------------------------

test('evidenceFamilyOf: legacy row (no evidence_family_fine) is classified by task id where unambiguous', () => {
  const hard = evidenceFamilyOf({ taskId: 'hard-verify', row: { task: 'hard-verify' }, taskFamilyOf });
  assert.deepEqual(hard, { fine: 'hard-synthetic', coarse: 'synthetic' });

  const real = evidenceFamilyOf({ taskId: 'real-capacity', row: { task: 'real-capacity' }, taskFamilyOf });
  assert.deepEqual(real, { fine: 'real-bugfix', coarse: 'real' });

  const easy = evidenceFamilyOf({ taskId: 'lookup', row: { task: 'lookup' }, taskFamilyOf });
  assert.deepEqual(easy, { fine: 'easy-synthetic', coarse: 'synthetic' });

  // A pack-shaped legacy row (task_pack_sha256 present, unrecognized id) --
  // taskFamilyOf() already treats this as "pack" -> real-bugfix/real.
  const pack = evidenceFamilyOf({
    taskId: 'some-mined-pack-id', row: { task: 'some-mined-pack-id', task_pack_sha256: 'abc123' }, taskFamilyOf,
  });
  assert.deepEqual(pack, { fine: 'real-bugfix', coarse: 'real' });
});

test('evidenceFamilyOf: an already-stamped row keeps its own value even if the registry would say otherwise', () => {
  const stamped = evidenceFamilyOf({
    taskId: 'lookup', row: { task: 'lookup', evidence_family_fine: 'real-bugfix', evidence_family: 'real' }, taskFamilyOf,
  });
  assert.deepEqual(stamped, { fine: 'real-bugfix', coarse: 'real' });
});

test('evidenceFamilyOf: a task pack manifest\'s evidenceFamily overrides the "pack" default', () => {
  const architecture = evidenceFamilyOf({
    taskId: 'my-arch-pack', task: { __isPackTask: true, family: 'pack', evidenceFamily: 'architecture' }, taskFamilyOf,
  });
  assert.deepEqual(architecture, { fine: 'architecture', coarse: 'real' });
});

// --- unknown is never pooled ---------------------------------------------

test('evidenceFamilyOf: a wholly unrecognized task id/no pack metadata is "unknown", never guessed into real or synthetic', () => {
  const unknown = evidenceFamilyOf({ taskId: 'totally-unrecognized-task-id', row: { task: 'totally-unrecognized-task-id' }, taskFamilyOf });
  assert.deepEqual(unknown, { fine: 'unknown', coarse: 'unknown' });
});

// --- FS3 (2026-09-24 family-split review, HIGH): evidenceFamily is --------
// --- validated, not silently accepted or silently downgraded --------------

test('FS3: evidenceFamilyOf throws for an unrecognized task.evidenceFamily (a configuration error, caught at load time)', () => {
  assert.throws(
    () => evidenceFamilyOf({ taskId: 'some-task', task: { evidenceFamily: 'not-a-real-label' }, taskFamilyOf }),
    /unknown evidence family "not-a-real-label"/,
  );
});

test('FS3: evidenceFamilyOf never throws for a legacy row\'s unrecognized evidence_family_fine -- classifies it unknown and flags it', () => {
  const result = evidenceFamilyOf({
    taskId: 'old-task', row: { task: 'old-task', evidence_family_fine: 'some-retired-label' }, taskFamilyOf,
  });
  assert.deepEqual(result, { fine: 'unknown', coarse: 'unknown', unrecognizedLegacyFine: 'some-retired-label' });
});

test('FS3: runOne() rejects an unknown task.evidenceFamily BEFORE spawning any model call', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs3-runone-'));
  const answersDir = join(outDir, 'answers');
  mkdirSync(answersDir, { recursive: true });
  let modelCalled = false;
  const runClaudeImpl = async () => {
    modelCalled = true;
    return { json: { result: 'done', is_error: false, modelUsage: {}, total_cost_usd: 0.001, num_turns: 1 }, stdout: '', stderr: '', err: null, wallMs: 1 };
  };
  const task = {
    maxBudgetUsd: 0.01,
    family: 'fixture',
    evidenceFamily: 'not-a-real-label',
    setup() { return {}; },
    prompt() { return 'fixture prompt -- must never be reached'; },
    async score() { return { pass: true, scope_ok: true, claim_honest: null, extra_files: [] }; },
  };
  try {
    await assert.rejects(
      runOne({
        cellId: 'sonnet-medium', cell: { model: 'claude-sonnet-5', effort: null }, taskId: 'bad-task', task, rep: 0,
        outDir, answersDir, runClaudeImpl,
      }),
      /unknown evidence family "not-a-real-label"/,
    );
    assert.equal(modelCalled, false, 'the model must never be spawned for a task with an invalid evidenceFamily');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- FS2 (2026-09-24 family-split review, CRITICAL): external harnesses ---
// --- (task.evidenceFamily, a CLI/env override, and a local mapping file) --

test('FS2: compileTaskIdPattern supports both a glob and a /regex/ literal', () => {
  assert.ok(compileTaskIdPattern('arch-*').test('arch-widget-project-2026'));
  assert.ok(!compileTaskIdPattern('arch-*').test('other-2026'));
  assert.ok(compileTaskIdPattern('/^dh\\d+-/i').test('dh290-listener-supervise'));
  assert.ok(!compileTaskIdPattern('/^dh\\d+-/i').test('sonnet-medium'));
});

test('FS2: matchLocalEvidenceFamilyMapping tries rules in order, first match wins, skips a malformed rule', () => {
  const mapping = {
    rules: [
      { taskIdPattern: 'not-a-field' }, // missing `family` -- skipped
      { taskIdPattern: 'arch-*', family: 'architecture' },
      { taskIdPattern: 'arch-*', family: 'mined' }, // never reached -- first match wins
    ],
  };
  assert.equal(matchLocalEvidenceFamilyMapping('arch-synthetic-pack-1', mapping), 'architecture');
  assert.equal(matchLocalEvidenceFamilyMapping('unrelated-task', mapping), null);
  assert.equal(matchLocalEvidenceFamilyMapping('anything', null), null);
});

test('FS2: evidenceFamilyOf precedence -- row field > task.evidenceFamily > local mapping > built-in registry > unknown', () => {
  const mapping = { rules: [{ taskIdPattern: 'arch-*', family: 'architecture' }] };
  // Local mapping applies when nothing more specific is present.
  const viaMapping = evidenceFamilyOf({ taskId: 'arch-synthetic-pack-1', taskFamilyOf, localMapping: mapping });
  assert.deepEqual(viaMapping, { fine: 'architecture', coarse: 'real' });
  // An already-stamped row wins over the mapping, even if the mapping would say otherwise.
  const viaRow = evidenceFamilyOf({
    taskId: 'arch-synthetic-pack-1', row: { evidence_family_fine: 'mined', evidence_family: 'real' }, taskFamilyOf, localMapping: mapping,
  });
  assert.equal(viaRow.fine, 'mined');
  // An explicit task.evidenceFamily wins over the mapping too.
  const viaTask = evidenceFamilyOf({
    taskId: 'arch-synthetic-pack-1', task: { evidenceFamily: 'real-bugfix' }, taskFamilyOf, localMapping: mapping,
  });
  assert.equal(viaTask.fine, 'real-bugfix');
  // No mapping match at all -> falls through to the built-in registry.
  const noMatch = evidenceFamilyOf({ taskId: 'lookup', taskFamilyOf, localMapping: mapping });
  assert.equal(noMatch.fine, 'easy-synthetic');
});

test('FS2: evidenceFamilyOf throws for a local mapping rule that names an unknown family', () => {
  const mapping = { rules: [{ taskIdPattern: 'arch-*', family: 'not-a-real-label' }] };
  assert.throws(
    () => evidenceFamilyOf({ taskId: 'arch-synthetic-pack-1', taskFamilyOf, localMapping: mapping }),
    /local evidence-family mapping declares unknown family/,
  );
});

test('FS2: checkEvidenceFamilyOverridePreflight validates against the known-label registry', () => {
  assert.equal(checkEvidenceFamilyOverridePreflight(null), null);
  assert.equal(checkEvidenceFamilyOverridePreflight('architecture'), 'architecture');
  assert.throws(() => checkEvidenceFamilyOverridePreflight('not-a-real-label'), /not a recognized fine label/);
});

test('FS2: withEvidenceFamilyOverride applies only when the task declares no evidenceFamily of its own', () => {
  assert.equal(withEvidenceFamilyOverride({ family: 'pack' }, 'architecture').evidenceFamily, 'architecture');
  assert.equal(withEvidenceFamilyOverride(null, 'architecture').evidenceFamily, 'architecture');
  const declared = { family: 'pack', evidenceFamily: 'real-bugfix' };
  assert.equal(withEvidenceFamilyOverride(declared, 'architecture'), declared, 'a task\'s own declaration must win, unchanged');
  assert.equal(withEvidenceFamilyOverride({ family: 'pack' }, null).evidenceFamily, undefined);
});

test('FS2: parseArgs reads --evidence-family, and falls back to AGENT_COMPANION_BENCH_EVIDENCE_FAMILY', () => {
  assert.equal(parseArgs(['--evidence-family', 'architecture']).evidenceFamily, 'architecture');
  const prev = process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY;
  try {
    process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY = 'mined';
    assert.equal(parseArgs([]).evidenceFamily, 'mined');
    // An explicit CLI flag wins over the env var.
    assert.equal(parseArgs(['--evidence-family', 'architecture']).evidenceFamily, 'architecture');
  } finally {
    if (prev === undefined) delete process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY;
    else process.env.AGENT_COMPANION_BENCH_EVIDENCE_FAMILY = prev;
  }
});

// REQUIRED PROOF: scratch copies of a real architecture-pack results dir
// classify as "architecture" once a local mapping file is placed in a
// SCRATCH state root. Synthetic ids only -- mirrors the shape of the
// operator's local architecture-pack harness (buildArchTask() sets no
// family at all, per FS2's own finding), never the real private task ids.
test('FS2 REQUIRED PROOF: a local mapping file in a scratch state root classifies unlabelled legacy rows as "architecture"', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs2-arch-'));
  const scratchStateRoot = mkdtempSync(join(tmpdir(), 'ac-bench-fs2-state-'));
  const prevStateDir = process.env.AGENT_COMPANION_STATE_DIR;
  try {
    // Rows with NO evidence_family_fine and a task_family this benchmark's
    // built-in registry cannot classify -- exactly what an external
    // architecture-pack harness that "sets no family at all" would produce.
    const rows = [
      { run_id: 'x1', cell: 'sonnet-medium', task: 'arch-synthetic-pack-1', task_family: 'other', pass: true, is_error: false, auth_error: false, requested_model: 'claude-sonnet-5', cost_usd: 0.4, num_turns: 6 },
      { run_id: 'x2', cell: 'sonnet-medium', task: 'arch-synthetic-pack-2', task_family: 'other', pass: false, is_error: false, auth_error: false, requested_model: 'claude-sonnet-5', cost_usd: 0.3, num_turns: 4 },
    ];
    writeRows(outDir, rows);

    mkdirSync(join(scratchStateRoot, 'config'), { recursive: true });
    writeFileSync(
      join(scratchStateRoot, 'config', 'evidence-families.json'),
      JSON.stringify({ rules: [{ taskIdPattern: 'arch-*', family: 'architecture' }] }),
    );
    process.env.AGENT_COMPANION_STATE_DIR = scratchStateRoot;

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const fam = JSON.parse(readFileSync(join(outDir, 'summary-by-family.json'), 'utf8'));

    for (const r of summary) {
      assert.equal(r.evidence_family_fine, 'architecture', `${r.task} must classify via the local mapping`);
      assert.equal(r.evidence_family, 'real');
    }
    assert.ok(fam.some((f) => f.evidence_family_fine === 'architecture'));
  } finally {
    if (prevStateDir === undefined) delete process.env.AGENT_COMPANION_STATE_DIR;
    else process.env.AGENT_COMPANION_STATE_DIR = prevStateDir;
    rmSync(outDir, { recursive: true, force: true });
    rmSync(scratchStateRoot, { recursive: true, force: true });
  }
});

// --- rebuildSummary: mixed run, per-family numbers equal the separately ---
// --- computed ones, and nothing is pooled ---------------------------------

test('rebuildSummary: a mixed real+synthetic+unknown run reports each family SEPARATELY, matching hand-computed stats', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-evidence-'));
  try {
    const rows = [
      // real: opus55-high on 4 real-* tasks, 3 pass.
      row('opus55-high', 'real-capacity', 1, true),
      row('opus55-high', 'real-secret-scan', 1, true),
      row('opus55-high', 'real-opt-fallback', 1, true),
      row('opus55-high', 'real-effort-note', 1, false),
      // synthetic: sonnet-medium on 4 easy/hard tasks, 2 pass.
      row('sonnet-medium', 'lookup', 1, true, { requested_model: 'claude-sonnet-5' }),
      row('sonnet-medium', 'verify', 1, true, { requested_model: 'claude-sonnet-5' }),
      row('sonnet-medium', 'hard-verify', 1, false, { requested_model: 'claude-sonnet-5' }),
      row('sonnet-medium', 'hard-procedure', 1, false, { requested_model: 'claude-sonnet-5' }),
      // unknown: an id this benchmark cannot classify at all.
      row('haiku', 'mystery-task-xyz', 1, true, { requested_model: 'claude-haiku-4-5' }),
    ];
    writeRows(outDir, rows);
    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const fam = JSON.parse(readFileSync(join(outDir, 'summary-by-family.json'), 'utf8'));

    // Every summary.json row's evidence_family/evidence_family_fine agrees
    // with evidenceFamilyOf() computed independently against the raw row.
    for (const r of summary) {
      const srcRows = rows.filter((raw) => raw.task === r.task && raw.cell === r.cell);
      const expected = evidenceFamilyOf({ taskId: r.task, row: srcRows[0], taskFamilyOf });
      assert.equal(r.evidence_family, expected.coarse, `${r.cell}/${r.task} evidence_family`);
      assert.equal(r.evidence_family_fine, expected.fine, `${r.cell}/${r.task} evidence_family_fine`);
    }

    // Hand-computed per-family totals from the RAW rows above.
    const realRows = rows.filter((r) => r.task.startsWith('real-'));
    const synthRows = rows.filter((r) => ['lookup', 'verify', 'hard-verify', 'hard-procedure'].includes(r.task));
    const unknownRows = rows.filter((r) => r.task === 'mystery-task-xyz');

    const famReal = fam.filter((f) => f.evidence_family === 'real');
    const famSynth = fam.filter((f) => f.evidence_family === 'synthetic');
    const famUnknown = fam.filter((f) => f.evidence_family === 'unknown');

    const sumRuns = (list) => list.reduce((s, f) => s + f.runs, 0);
    const sumPasses = (list) => list.reduce((s, f) => s + f.passes, 0);

    assert.equal(sumRuns(famReal), realRows.length);
    assert.equal(sumPasses(famReal), realRows.filter((r) => r.pass).length);
    assert.equal(sumRuns(famSynth), synthRows.length);
    assert.equal(sumPasses(famSynth), synthRows.filter((r) => r.pass).length);
    assert.equal(sumRuns(famUnknown), unknownRows.length);
    assert.equal(sumPasses(famUnknown), unknownRows.filter((r) => r.pass).length);

    // No cross-contamination: total runs across the three buckets equals
    // every row, and no bucket double-counts another's rows.
    assert.equal(sumRuns(famReal) + sumRuns(famSynth) + sumRuns(famUnknown), rows.length);

    // The markdown shows three clearly-headed, non-pooled sections.
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /## REAL-WORLD RESULTS/);
    assert.match(md, /## SYNTHETIC RESULTS/);
    assert.match(md, /## UNCLASSIFIED RESULTS \(evidence family unknown -- never pooled with real or synthetic\)/);
    assert.match(md, /### Real-world/);
    assert.match(md, /### Synthetic/);
    assert.match(md, /### Unclassified \(evidence family unknown -- never pooled\)/);

    // The real-world section's real-capacity row appears BEFORE the
    // synthetic section starts, and the synthetic section's lookup row
    // appears AFTER the real-world header -- i.e. they are in genuinely
    // separate blocks, not interleaved in one table.
    const realHeaderIdx = md.indexOf('## REAL-WORLD RESULTS');
    const synthHeaderIdx = md.indexOf('## SYNTHETIC RESULTS');
    const unknownHeaderIdx = md.indexOf('## UNCLASSIFIED RESULTS');
    const realRowIdx = md.indexOf('opus55-high | real-capacity');
    const synthRowIdx = md.indexOf('sonnet-medium | lookup');
    const unknownRowIdx = md.indexOf('haiku | mystery-task-xyz');
    assert.ok(realHeaderIdx < realRowIdx && realRowIdx < synthHeaderIdx, 'real row sits inside the real-world section only');
    assert.ok(synthHeaderIdx < synthRowIdx && synthRowIdx < unknownHeaderIdx, 'synthetic row sits inside the synthetic section only');
    assert.ok(unknownHeaderIdx < unknownRowIdx, 'unknown row sits inside the unclassified section only');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- FS1 (2026-09-24 family-split review, CRITICAL): the SAME (cell, task) --
// --- or (cell, built-in family) can carry two evidence families -----------

test('FS1: rebuildSummary never pools two rows sharing (cell, task) but different evidence_family_fine -- separate summary.json rows', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs1-'));
  try {
    // Synthetic ids only -- mirrors the reviewer's mixed-file repro: a
    // manifest.evidenceFamily correction made between two runs appended to
    // the same append-only results.jsonl, so the SAME (cell, task) key now
    // has two different fine labels across its rows.
    const rows = [
      row('sonnet-medium', 'pack-task-x', 0, true, {
        run_id: 'a1', task_family: 'pack', evidence_family: 'real', evidence_family_fine: 'real-bugfix', cost_usd: 1.0,
      }),
      row('sonnet-medium', 'pack-task-x', 0, false, {
        run_id: 'a2', task_family: 'pack', evidence_family: 'synthetic', evidence_family_fine: 'easy-synthetic', cost_usd: 0.05,
      }),
    ];
    writeRows(outDir, rows);
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));

    // Two SEPARATE rows for the one (cell, task) pair -- never pooled into one.
    const forTask = summary.filter((r) => r.cell === 'sonnet-medium' && r.task === 'pack-task-x');
    assert.equal(forTask.length, 2, 'must produce two separate rows, not one pooled row');
    const byFine = Object.fromEntries(forTask.map((r) => [r.evidence_family_fine, r]));
    assert.ok(byFine['real-bugfix'], 'real-bugfix row present');
    assert.ok(byFine['easy-synthetic'], 'easy-synthetic row present');
    // n must never merge the two rows' rep counts (1 each, not 2).
    assert.equal(byFine['real-bugfix'].n, 1);
    assert.equal(byFine['easy-synthetic'].n, 1);
    assert.equal(byFine['real-bugfix'].pass_rate, 1);
    assert.equal(byFine['easy-synthetic'].pass_rate, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('FS1: buildFamilySummary never pools two tasks sharing a built-in family but different evidence_family_fine', () => {
  // Case B (reviewer's repro): different tasks, same built-in family "pack",
  // one declares itself real-bugfix and the other easy-synthetic.
  const rows = [
    row('sonnet-medium', 'pack-task-real1', 0, true, { task_family: 'pack', evidence_family: 'real', evidence_family_fine: 'real-bugfix' }),
    row('sonnet-medium', 'pack-task-synth1', 0, false, { task_family: 'pack', evidence_family: 'synthetic', evidence_family_fine: 'easy-synthetic' }),
  ];
  const fam = buildFamilySummary(rows);
  const pack = fam.filter((f) => f.cell === 'sonnet-medium' && f.family === 'pack');
  assert.equal(pack.length, 2, 'must produce two separate family rollups, not one pooled row');
  const byFine = Object.fromEntries(pack.map((f) => [f.evidence_family_fine, f]));
  assert.equal(byFine['real-bugfix'].runs, 1);
  assert.equal(byFine['easy-synthetic'].runs, 1);
  assert.equal(byFine['real-bugfix'].passes, 1);
  assert.equal(byFine['easy-synthetic'].passes, 0);
});

// --- FS4 (2026-09-24 family-split review, HIGH): assertComparableEvidence --
// --- was shipped but never called -- relativeCostIndexOrNull() is the -----
// --- comparison helper that now enforces it in the summary path -----------

test('FS4: relativeCostIndexOrNull refuses to divide across evidence families', () => {
  assert.equal(relativeCostIndexOrNull(100, { fine: 'easy-synthetic', cost: 50 }, 'real-bugfix'), null);
  assert.equal(relativeCostIndexOrNull(100, undefined, 'real-bugfix'), null);
  assert.equal(relativeCostIndexOrNull(100, { fine: 'real-bugfix', cost: 50 }, 'real-bugfix'), 2);
});

test('FS4/FS10: rebuildSummary never lets a mismatched-family baseline leak into relative_cost_index -- each fine family gets its OWN deterministic baseline', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs4-'));
  try {
    // Both rows are cell "sonnet-medium" (the baseline cell) on the SAME
    // task id but different evidence families.
    //
    // FS10 fix (2026-09-24 round-2 family-split review): this test used to
    // assert "at most one of the two may compute a self-ratio", because the
    // OLD baseline map was keyed by task ONLY -- whichever fine-label group
    // rebuildSummary()'s Map-iteration order visited LAST silently
    // overwrote the other's baseline entry, so which family (if either)
    // got a real ratio was NONDETERMINISTIC. The baseline map is now keyed
    // by task + fine label, so BOTH families get their own deterministic
    // baseline entry -- sonnet-medium's real-bugfix group compares against
    // sonnet-medium's own real-bugfix baseline (itself, since it IS the
    // baseline cell) and its easy-synthetic group likewise against its own
    // easy-synthetic baseline. Both are therefore expected to be exactly
    // 1.0 (a cell's price-weighted tokens divided by its OWN median) --
    // this is MORE correct than the old "at most one, arbitrarily" behavior,
    // never a cross-family leak (see the dedicated FS10 test below for that).
    const rows = [
      row('sonnet-medium', 'pack-task-x', 0, true, {
        run_id: 'a1', task_family: 'pack', evidence_family: 'real', evidence_family_fine: 'real-bugfix', output_tokens: 5000,
      }),
      row('sonnet-medium', 'pack-task-x', 0, false, {
        run_id: 'a2', task_family: 'pack', evidence_family: 'synthetic', evidence_family_fine: 'easy-synthetic', output_tokens: 200,
      }),
    ];
    writeRows(outDir, rows);
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const forTask = summary.filter((r) => r.cell === 'sonnet-medium' && r.task === 'pack-task-x');
    assert.equal(forTask.length, 2);
    for (const r of forTask) {
      assert.equal(r.relative_cost_index, 1, `${r.evidence_family_fine}: sonnet-medium must self-ratio to exactly 1.0 against its own fine-family baseline`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// --- FS10 (2026-09-24 round-2 family-split review, HIGH): assertComparableEvidence --
// --- only refused a COARSE mismatch, so two FINE families sharing a coarse ----------
// --- kind (e.g. "architecture" and "real-bugfix", both "real") were ratioed --------
// --- against each other's baselines as if they were the same evidence --------------

test('FS10: relativeCostIndexOrNull refuses to divide two DIFFERENT fine families even when they share a coarse kind', () => {
  // Both "architecture" and "real-bugfix" are coarse "real" -- the pre-fix
  // assertComparableEvidence() coarse-only check let this through.
  assert.equal(relativeCostIndexOrNull(100, { fine: 'real-bugfix', cost: 50 }, 'architecture'), null);
  assert.equal(relativeCostIndexOrNull(100, { fine: 'architecture', cost: 50 }, 'real-bugfix'), null);
  // Same fine family still divides normally.
  assert.equal(relativeCostIndexOrNull(100, { fine: 'architecture', cost: 50 }, 'architecture'), 2);
});

test('FS10: rebuildSummary never ratios an architecture cell against a real-bugfix baseline for the SAME task id', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs10-'));
  try {
    // sonnet-medium (the baseline cell) has ONLY a real-bugfix row for this
    // task id. A DIFFERENT cell reports the SAME task id but declares itself
    // "architecture" (an external harness sharing an id with a built-in
    // one, or a manifest.evidenceFamily correction) -- its baseline lookup
    // must find NOTHING under its own fine label and get a null
    // relative_cost_index, never silently fall back to the real-bugfix
    // baseline that happens to share the task id.
    const rows = [
      row('sonnet-medium', 'shared-task-id', 0, true, {
        run_id: 'b1', task_family: 'pack', evidence_family: 'real', evidence_family_fine: 'real-bugfix', output_tokens: 5000,
      }),
      row('opus55-high', 'shared-task-id', 0, true, {
        run_id: 'b2', task_family: 'pack', evidence_family: 'real', evidence_family_fine: 'architecture', output_tokens: 8000,
      }),
    ];
    writeRows(outDir, rows);
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    const archRow = summary.find((r) => r.cell === 'opus55-high' && r.task === 'shared-task-id');
    assert.ok(archRow, 'the architecture row must still be reported');
    assert.equal(archRow.evidence_family_fine, 'architecture');
    assert.equal(archRow.relative_cost_index, null, 'must never ratio against the real-bugfix baseline for the same task id');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('buildFamilySummary: every returned row carries a coarse evidence_family consistent with its fine label', () => {
  const rows = [
    row('opus55-high', 'real-capacity', 1, true),
    row('sonnet-medium', 'lookup', 1, true, { requested_model: 'claude-sonnet-5' }),
  ];
  const fam = buildFamilySummary(rows);
  for (const f of fam) {
    assert.equal(coarseOf(f.evidence_family_fine), f.evidence_family);
  }
  assert.ok(fam.some((f) => f.evidence_family === 'real'));
  assert.ok(fam.some((f) => f.evidence_family === 'synthetic'));
});

// --- estimator: a real family with no real history is NEVER derived from --
// --- synthetic numbers, even when synthetic history exists -----------------

test('estimate.mjs: a REAL family with no real-world history/seed falls back to the REAL default, unaffected by present synthetic history', () => {
  const stubSeed = { families: { 'easy-synthetic': { cells: {} } }, weeklyPointAnchors: {} };
  const historyWithOnlySynthetic = {
    families: {
      'easy-synthetic': {
        cells: {
          'claude-sonnet-5|medium': {
            model: 'claude-sonnet-5', effort: 'medium', n: 20,
            medianDurationMs: 1, medianCostUsd: 0.001, medianInputTokens: 1,
            medianCacheReadTokens: 1, medianCacheCreationTokens: 1, medianOutputTokens: 1, medianNumTurns: 1,
          },
        },
      },
    },
  };

  const r = mediansFor({
    family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', seed: stubSeed, history: historyWithOnlySynthetic,
  });
  assert.equal(r.source, 'none', 'no real-bugfix data anywhere -- must not silently borrow the synthetic cell');
  assert.match(r.label, /no local real-world history, rough guess/);

  const realFallback = roughGuessFallbackFor('real-bugfix');
  const synthFallback = roughGuessFallbackFor('easy-synthetic');
  assert.notEqual(realFallback.medianCostUsd, synthFallback.medianCostUsd, 'real and synthetic fallbacks must be distinct numbers');
  // The synthetic history's absurdly cheap medianCostUsd (0.001) must never
  // leak into the real family's fallback.
  assert.notEqual(realFallback.medianCostUsd, 0.001);

  const est = estimateRun({
    plan: [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'real-bugfix', n: 1 }],
    concurrency: 1, seed: stubSeed, history: historyWithOnlySynthetic,
  });
  assert.equal(est.anyRoughGuess, true);
  assert.equal(est.perCell[0].costUsd, realFallback.medianCostUsd);
  assert.notEqual(est.perCell[0].costUsd, 0.001, 'the real cell\'s estimate must not be pulled from the synthetic history row');
});

test('estimate.mjs: a SYNTHETIC family with no history/seed falls back to the SYNTHETIC default, never the real one', () => {
  const stubSeed = { families: { 'real-bugfix': { cells: {} } }, weeklyPointAnchors: {} };
  const r = mediansFor({ family: 'hard-synthetic', model: 'claude-opus-5-5', effort: 'high', seed: stubSeed, history: { families: {} } });
  assert.equal(r.source, 'none');
  assert.match(r.label, /no local synthetic history, rough guess/);
  assert.doesNotMatch(r.label, /real-world/);
});

// --- FS5 (2026-09-24 family-split review, MED, pre-existing): local ---------
// --- history was keyed by the COARSE task_family, never matching the -------
// --- FINE-keyed lookups, so it was NEVER used ------------------------------

test('FS5: fineFamilyOfHistoryRow prefers an already-stamped fine label, else maps the coarse task_family', () => {
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'real', evidence_family_fine: 'real-bugfix' }), 'real-bugfix');
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'real' }), 'real-bugfix');
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'pack' }), 'real-bugfix');
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'easy' }), 'easy-synthetic');
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'hard' }), 'hard-synthetic');
  assert.equal(fineFamilyOfHistoryRow({ task_family: 'something-unregistered' }), 'unknown');
  assert.equal(fineFamilyOfHistoryRow({}), 'unknown');
});

test('FS5: loadLocalHistory keys a real-world row by its FINE label, so mediansFor() actually finds it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-bench-fs5-hist-'));
  try {
    const dir = join(root, 'run1');
    mkdirSync(dir, { recursive: true });
    // Synthetic id, mirrors the reviewer's repro: a real-world row whose
    // COARSE task_family ("real") is what the pre-fix code keyed history
    // by, while every real lookup below asks mediansFor() for the FINE
    // label ("real-bugfix") instead.
    const histRow = {
      run_id: 'r1', cell: 'sonnet-medium', task: 'real-capacity',
      task_family: 'real', evidence_family: 'real', evidence_family_fine: 'real-bugfix',
      requested_model: 'claude-sonnet-5', requested_effort: 'medium',
      cost_usd: 9.99, duration_ms: 999999,
      input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, num_turns: 1,
    };
    writeFileSync(join(dir, 'results.jsonl'), JSON.stringify(histRow) + '\n');

    const history = loadLocalHistory({ resultsRoot: root });
    assert.ok(history.families['real-bugfix'], 'history must be keyed by the FINE label "real-bugfix"');
    assert.ok(!history.families.real, 'history must NOT be keyed by the coarse "real" label');

    const result = mediansFor({ family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', history });
    assert.equal(result.source, 'local-history', 'mediansFor() must actually find this machine\'s own local history');
    assert.equal(result.medians.medianCostUsd, 9.99);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- FS8 (2026-09-24 round-2 family-split review, CRITICAL): loadLocalHistory --
// --- must use the SAME classifier/precedence rebuildSummary() uses -- row --------
// --- field > task.evidenceFamily > local mapping file > built-in taskFamilyOf --
// --- (taskId) > unknown -- and "unknown" must never be pooled into a median ------

test('FS8: fineFamilyOfHistoryRow delegates to evidenceFamilyOf() (row field > local mapping > taskFamilyOf) when taskFamilyOf is injected', () => {
  const mapping = { rules: [{ taskIdPattern: 'arch-synth-*', family: 'architecture' }] };
  // A legacy row with no evidence_family_fine and a coarse task_family the
  // built-in registry cannot place ("other") -- exactly an external
  // harness's shape (FS2's own architecture-pack finding). Without
  // taskFamilyOf injected, the OLD fallback (pre-FS8 behavior) could only
  // ever say "unknown" here; WITH it injected, the local mapping resolves it.
  const row = { task: 'arch-synth-7', task_family: 'other' };
  assert.equal(fineFamilyOfHistoryRow(row), 'unknown', 'no taskFamilyOf injected -- legacy coarse fallback only');
  assert.equal(
    fineFamilyOfHistoryRow(row, { taskFamilyOf, localMapping: mapping }),
    'architecture',
    'taskFamilyOf injected -- full evidenceFamilyOf() resolution, local mapping applies',
  );
  // An already-stamped row still wins over everything, either way.
  const stamped = { task: 'arch-synth-7', task_family: 'other', evidence_family_fine: 'mined' };
  assert.equal(fineFamilyOfHistoryRow(stamped, { taskFamilyOf, localMapping: mapping }), 'mined');
});

test('FS8 REQUIRED PROOF: loadLocalHistory classifies real-bugfix and architecture via local-history with the mapping wired in, falls back to a labelled seed for architecture without it, and NEVER pools "unknown" into any median', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-bench-fs8-hist-'));
  try {
    const dir = join(root, 'run1');
    mkdirSync(dir, { recursive: true });
    const rows = [
      // "architecture"-shaped: an external harness's row, no evidence_family_fine,
      // task_family "other" (unclassifiable by the built-in registry) -- the
      // exact shape FS2/FS8 fix for. Synthetic id only.
      {
        run_id: 'h1', cell: 'sonnet-medium', task: 'arch-synth-1', task_family: 'other',
        requested_model: 'claude-sonnet-5', requested_effort: 'medium',
        cost_usd: 1.11, duration_ms: 11111,
        input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, num_turns: 1,
      },
      // "real-bugfix"-shaped: a shipped built-in task id, already classifiable
      // without any mapping at all.
      {
        run_id: 'h2', cell: 'sonnet-medium', task: 'real-capacity', task_family: 'real',
        requested_model: 'claude-sonnet-5', requested_effort: 'medium',
        cost_usd: 2.22, duration_ms: 22222,
        input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, num_turns: 1,
      },
      // Wholly unclassifiable, even with the mapping in place (matches none
      // of its rules) -- must NEVER be pooled anywhere, ever.
      {
        run_id: 'h3', cell: 'sonnet-medium', task: 'totally-unclassifiable-mystery-row', task_family: 'other',
        requested_model: 'claude-sonnet-5', requested_effort: 'medium',
        cost_usd: 999, duration_ms: 999999,
        input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, num_turns: 1,
      },
    ];
    writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const mapping = { rules: [{ taskIdPattern: 'arch-synth-*', family: 'architecture' }] };

    // WITH the mapping wired in (the real production shape post-FS9: caller
    // injects both taskFamilyOf and localMapping).
    const withMapping = loadLocalHistory({ resultsRoot: root, taskFamilyOf, localMapping: mapping });
    assert.ok(withMapping.families['architecture'], 'architecture must classify via the local mapping');
    assert.ok(withMapping.families['real-bugfix'], 'real-bugfix must classify via the built-in registry');
    assert.ok(!withMapping.families.unknown, 'the unknown bucket must not exist at all -- never pooled');
    const archResult = mediansFor({ family: 'architecture', model: 'claude-sonnet-5', effort: 'medium', history: withMapping });
    assert.equal(archResult.source, 'local-history');
    const realResult = mediansFor({ family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', history: withMapping });
    assert.equal(realResult.source, 'local-history');

    // WITHOUT the mapping: architecture's only row is now genuinely
    // unclassifiable -- excluded entirely (not pooled as "unknown"), so a
    // caller asking mediansFor() for "architecture" must fall through to the
    // SEED, clearly labelled as such -- never silently borrow "unknown"
    // numbers and never silently claim to be measured.
    const withoutMapping = loadLocalHistory({ resultsRoot: root, taskFamilyOf, localMapping: null });
    assert.ok(!withoutMapping.families['architecture'], 'architecture has no local history without the mapping');
    assert.ok(withoutMapping.families['real-bugfix'], 'real-bugfix is unaffected -- classifiable without any mapping');
    assert.ok(!withoutMapping.families.unknown, 'still never pooled as "unknown", mapping or not');
    const stubSeed = {
      families: {
        architecture: {
          cells: {
            'claude-sonnet-5|medium': {
              model: 'claude-sonnet-5', effort: 'medium', n: 3,
              medianDurationMs: 1, medianCostUsd: 0.5, medianInputTokens: 1,
              medianCacheReadTokens: 1, medianCacheCreationTokens: 1, medianOutputTokens: 1, medianNumTurns: 1,
            },
          },
        },
      },
    };
    const archFallback = mediansFor({
      family: 'architecture', model: 'claude-sonnet-5', effort: 'medium', seed: stubSeed, history: withoutMapping,
    });
    assert.equal(archFallback.source, 'seed', 'no local history for architecture -- must fall back to the labelled seed');
    assert.match(archFallback.label, /shipped seed/);

    // Even with NEITHER taskFamilyOf NOR localMapping injected at all (the
    // bare legacy-fallback path -- see fineFamilyOfHistoryRow()), the
    // unknown row must still never be pooled anywhere.
    const bareFallback = loadLocalHistory({ resultsRoot: root });
    assert.ok(!bareFallback.families.unknown, 'the bare fallback path must also never pool "unknown"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- FS8 tightening (lead direction): every PRODUCTION call site of --------
// --- loadLocalHistory()/evidenceFamilyOf() in scripts/ and bench/ must -------
// --- pass BOTH taskFamilyOf and localMapping, so the bare-fallback path -----
// --- (no taskFamilyOf/localMapping injected) is reachable only from tests --

// Exported so scripts/benchmark.mjs's own FS9 tightening (once
// --evidence-family/localMapping is wired into buildEstimatePlan() and
// loadLocalHistory() there too) can reuse the exact same scan instead of
// duplicating it.
export function assertEveryCallSitePassesFamilyDeps(file) {
  const src = readFileSync(file, 'utf8');
  let checked = 0;
  for (const fnName of ['loadLocalHistory', 'evidenceFamilyOf']) {
    // Matches `fnName(...)` call sites whose argument is a flat `{ ... }`
    // object literal (every production call site here is shaped this way --
    // no nested braces inside the argument object). The negative lookbehind
    // skips the function's own DEFINITION (`export function fnName({ ... })`).
    const callRe = new RegExp(`(?<!function )\\b${fnName}\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, 'g');
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = callRe.exec(src))) {
      const args = m[1];
      checked += 1;
      assert.ok(
        /\btaskFamilyOf\b/.test(args),
        `${file}: a ${fnName}() call site is missing taskFamilyOf -- found: ${m[0].slice(0, 120)}`,
      );
      assert.ok(
        /\blocalMapping\b/.test(args),
        `${file}: a ${fnName}() call site is missing localMapping -- found: ${m[0].slice(0, 120)}`,
      );
    }
  }
  return checked;
}

test('FS8: every production loadLocalHistory()/evidenceFamilyOf() call site in bench/runner.mjs and bench/estimate.mjs passes taskFamilyOf and localMapping', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let checked = 0;
  checked += assertEveryCallSitePassesFamilyDeps(join(here, '..', 'bench', 'runner.mjs'));
  checked += assertEveryCallSitePassesFamilyDeps(join(here, '..', 'bench', 'estimate.mjs'));
  // Sanity: this test must actually have found and checked call sites, or it
  // would pass vacuously and prove nothing. scripts/benchmark.mjs's own call
  // sites are covered by the FS9 test just below (they are fixed as part of
  // that commit, not this one).
  assert.ok(checked >= 4, `expected to find at least 4 production call sites, found ${checked}`);
});

test('FS9: every loadLocalHistory()/evidenceFamilyOf() call site in scripts/benchmark.mjs also passes taskFamilyOf and localMapping', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const checked = assertEveryCallSitePassesFamilyDeps(join(here, '..', 'scripts', 'benchmark.mjs'));
  assert.ok(checked >= 3, `expected to find at least 3 production call sites in scripts/benchmark.mjs, found ${checked}`);
});

// --- FS11 (2026-09-24 round-2 family-split review, MED): unrecognizedLegacyFine --
// --- was computed (FS3, round 1) but never surfaced anywhere a reader could see --

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => { captured += chunk; return original(chunk, ...rest); };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('FS11: rebuildSummary surfaces an unrecognized legacy evidence_family_fine as a summary.json field, a summary.md line, and a stderr warning', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs11-'));
  try {
    const rows = [
      // A row already on disk with a fine label this registry no longer
      // recognizes (retired/renamed) -- classifies "unknown" per FS3, and
      // now must ALSO be flagged, not silently swallowed.
      row('sonnet-medium', 'legacy-task-x', 0, true, {
        run_id: 'l1', evidence_family_fine: 'some-retired-label-a',
      }),
      row('sonnet-medium', 'legacy-task-x', 1, false, {
        run_id: 'l2', evidence_family_fine: 'some-retired-label-a',
      }),
      // A DIFFERENT retired label, different task -- both must be named.
      row('haiku', 'legacy-task-y', 0, true, {
        run_id: 'l3', evidence_family_fine: 'some-other-retired-label-b',
      }),
      // An ordinary, perfectly-classifiable row -- must be entirely
      // unaffected (null field, not swept up into the warning).
      row('sonnet-medium', 'lookup', 0, true, { run_id: 'l4', requested_model: 'claude-sonnet-5' }),
    ];
    writeRows(outDir, rows);

    const stderrOutput = captureStderr(() => rebuildSummary(outDir));

    // (a) stderr warning, once, naming both distinct retired labels.
    assert.match(stderrOutput, /WARNING:.*2 unrecognized legacy evidence_family_fine/);
    assert.match(stderrOutput, /some-retired-label-a/);
    assert.match(stderrOutput, /some-other-retired-label-b/);
    // Exactly one warning line for the whole run, not one per row/group.
    const warningLines = stderrOutput.split('\n').filter((l) => l.includes('WARNING:'));
    assert.equal(warningLines.length, 1);

    // (b) summary.json: a per-row field, summary.json stays a bare array.
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.ok(Array.isArray(summary), 'summary.json must remain a bare array');
    const legacyX = summary.find((r) => r.task === 'legacy-task-x');
    assert.deepEqual(legacyX.unrecognized_legacy_fines, ['some-retired-label-a']);
    assert.equal(legacyX.evidence_family_fine, 'unknown');
    const legacyY = summary.find((r) => r.task === 'legacy-task-y');
    assert.deepEqual(legacyY.unrecognized_legacy_fines, ['some-other-retired-label-b']);
    const ordinary = summary.find((r) => r.task === 'lookup');
    assert.equal(ordinary.unrecognized_legacy_fines, null, 'an ordinary, classifiable row must not be flagged');

    // (c) summary.md: one banner line naming both distinct retired labels.
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /LEGACY EVIDENCE FAMILY: 2 distinct evidence_family_fine value\(s\)/);
    assert.match(md, /some-retired-label-a/);
    assert.match(md, /some-other-retired-label-b/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// 0.29.1 fix e: rebuildSummary() runs after every completed run of a batch;
// the stderr warning is emitted once per process per label, while the
// summary.md banner and per-row field keep naming the label every time.
test('FS11: five rebuildSummary calls over the same legacy label warn on stderr exactly once', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs11-dedupe-'));
  try {
    writeRows(outDir, [
      row('sonnet-medium', 'legacy-task-z', 0, true, { run_id: 'd1', evidence_family_fine: 'fs11-dedupe-retired-label' }),
    ]);
    let stderrOutput = '';
    for (let i = 0; i < 5; i += 1) stderrOutput += captureStderr(() => rebuildSummary(outDir));
    const warningLines = stderrOutput.split('\n').filter((l) => l.includes('WARNING:') && l.includes('fs11-dedupe-retired-label'));
    assert.equal(warningLines.length, 1, stderrOutput);
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /LEGACY EVIDENCE FAMILY: 1 distinct .*fs11-dedupe-retired-label/, 'the banner is not deduped');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('FS11: no unrecognized legacy fine anywhere -> no warning, no banner, every row\'s field is null', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-fs11-clean-'));
  try {
    const rows = [row('sonnet-medium', 'lookup', 0, true, { requested_model: 'claude-sonnet-5' })];
    writeRows(outDir, rows);
    const stderrOutput = captureStderr(() => rebuildSummary(outDir));
    assert.doesNotMatch(stderrOutput, /WARNING:/);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    for (const r of summary) assert.equal(r.unrecognized_legacy_fines, null);
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /LEGACY EVIDENCE FAMILY/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('FS11: buildFamilySummary also surfaces unrecognized_legacy_fines per rollup row', () => {
  const rows = [
    row('sonnet-medium', 'legacy-task-x', 0, true, { evidence_family_fine: 'some-retired-label-a' }),
    row('sonnet-medium', 'lookup', 0, true, { requested_model: 'claude-sonnet-5' }),
  ];
  const fam = buildFamilySummary(rows);
  const unknownFam = fam.find((f) => f.evidence_family === 'unknown');
  assert.deepEqual(unknownFam.unrecognized_legacy_fines, ['some-retired-label-a']);
  const synthFam = fam.find((f) => f.evidence_family === 'synthetic');
  assert.equal(synthFam.unrecognized_legacy_fines, null);
});
