// Pre-run cost/time estimator (bench/estimate.mjs) and its confirmation
// gate. Pure math against the shipped seed and hand-written local-history
// fixtures -- no model call, no real results.jsonl scan of this machine's
// actual (potentially huge) history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadSeed, loadLocalHistory, mediansFor, pointsPerRun, estimateRun,
  shouldConfirm, suggestCheaperCellSet, formatEstimate,
  loadLocalJudgeVoteHistory, judgeVoteCostFor, judgePriceRatioToFable,
} from '../bench/estimate.mjs';

test('loadSeed: shipped seed has the four generic family labels and only numbers/model-ids inside', () => {
  const seed = loadSeed();
  for (const fam of ['easy-synthetic', 'hard-synthetic', 'real-bugfix', 'architecture']) {
    assert.ok(seed.families[fam], `seed is missing family "${fam}"`);
    assert.ok(Object.keys(seed.families[fam].cells).length > 0, `family "${fam}" has no cells`);
  }
  assert.ok(seed.weeklyPointAnchors['easy-synthetic']);
  assert.ok(seed.planWeightMultipliers.opus.confirmed === false, 'the opus plan-weight figure must be marked unconfirmed');
  // No paths, no pack/repo/project-looking tokens -- a light grep of the
  // serialized seed for path separators or drive letters.
  const json = JSON.stringify(seed);
  assert.doesNotMatch(json, /[A-Za-z]:\\|\/home\/|\/Users\//, 'seed must contain no filesystem paths');
});

test('mediansFor: prefers LOCAL HISTORY over the seed when both have data for a cell', () => {
  const seed = loadSeed();
  const history = {
    families: {
      'real-bugfix': {
        cells: {
          'claude-sonnet-5|medium': {
            model: 'claude-sonnet-5', effort: 'medium', n: 9,
            medianDurationMs: 1, medianCostUsd: 0.001, medianInputTokens: 1,
            medianCacheReadTokens: 1, medianCacheCreationTokens: 1, medianOutputTokens: 1, medianNumTurns: 1,
          },
        },
      },
    },
  };
  const r = mediansFor({ family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', seed, history });
  assert.equal(r.source, 'local-history');
  assert.equal(r.medians.n, 9);
});

test('mediansFor: falls back to the seed when local history has nothing for that cell', () => {
  const seed = loadSeed();
  const r = mediansFor({ family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', seed, history: { families: {} } });
  assert.equal(r.source, 'seed');
  assert.ok(r.n > 0);
});

test('mediansFor: no data anywhere for a REAL family -> source "none", labelled "no local real-world history"', () => {
  const seed = loadSeed();
  const r = mediansFor({ family: 'real-bugfix', model: 'claude-made-up-9000', effort: 'medium', seed, history: { families: {} } });
  assert.equal(r.source, 'none');
  // Real and synthetic evidence are never pooled, including at the
  // rough-guess label -- see bench/evidence-family.mjs.
  assert.match(r.label, /no local real-world history, rough guess/);
});

test('mediansFor: no data anywhere for a SYNTHETIC family -> labelled "no local synthetic history", never "real-world"', () => {
  const seed = loadSeed();
  const r = mediansFor({ family: 'easy-synthetic', model: 'claude-made-up-9000', effort: 'medium', seed, history: { families: {} } });
  assert.equal(r.source, 'none');
  assert.match(r.label, /no local synthetic history, rough guess/);
  assert.doesNotMatch(r.label, /real-world/);
});

test('pointsPerRun: real-bugfix sonnet/medium cell is close to the 4pts/35runs anchor (cost ratio ~1x, it IS the baseline)', () => {
  const seed = loadSeed();
  const p = pointsPerRun({ family: 'real-bugfix', model: 'claude-sonnet-5', effort: 'medium', seed });
  const anchorRate = seed.weeklyPointAnchors['real-bugfix'].points / seed.weeklyPointAnchors['real-bugfix'].runs;
  assert.ok(Math.abs(p.high - anchorRate) < 1e-6, 'sonnet/medium IS the cost baseline, so its ratio is 1x');
  assert.ok(p.low < p.high, 'low end is the conservative (lower) bound');
});

test('pointsPerRun: an opus cell states the 1.5x tooltip is UNCONFIRMED and unused', () => {
  const seed = loadSeed();
  const p = pointsPerRun({ family: 'real-bugfix', model: 'claude-opus-5-5', effort: 'high', seed });
  assert.match(p.note, /UNCONFIRMED/);
  assert.match(p.note, /measured \$ cost ratio/);
});

test('pointsPerRun: a family with no anchor at all returns null bounds, not a guess', () => {
  const seed = loadSeed();
  const p = pointsPerRun({ family: 'nonexistent-family', model: 'claude-sonnet-5', effort: 'medium', seed });
  assert.equal(p.low, null);
  assert.equal(p.high, null);
  assert.equal(p.basis, 'no-anchor');
});

test('estimateRun: aggregates tokens/cost/points across a mixed plan, and flags a fable cell', () => {
  const seed = loadSeed();
  const plan = [
    { cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'real-bugfix', n: 2 },
    { cellId: 'fable51-high', model: 'claude-fable-5-1', effort: 'high', family: 'real-bugfix', n: 1 },
  ];
  const est = estimateRun({ plan, concurrency: 1, seed });
  assert.equal(est.totalRuns, 3);
  assert.equal(est.hasFableCell, true);
  assert.ok(est.apiCostUsd > 0);
  assert.ok(est.tokensByClass.cacheRead > 0);
  assert.ok(est.weeklyPoints.high > est.weeklyPoints.low);
  assert.equal(est.perCell.length, 2);
});

test('estimateRun: --concurrency > 1 wall time is LESS than sequential, with the overhead factor noted', () => {
  const seed = loadSeed();
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'easy-synthetic', n: 4 }];
  const seq = estimateRun({ plan, concurrency: 1, seed });
  const par = estimateRun({ plan, concurrency: 4, seed });
  assert.equal(seq.wallTimeMs, seq.wallTimeMsSequential);
  assert.ok(par.wallTimeMs < seq.wallTimeMs, 'parallel wall time is lower than fully sequential');
  assert.ok(par.wallTimeMs > seq.wallTimeMs / 4, 'but not a naive /concurrency divide -- overhead is applied');
});

test('estimateRun: an unknown model/family combo is flagged anyRoughGuess, never silently treated as measured', () => {
  const seed = loadSeed();
  const plan = [{ cellId: 'x', model: 'claude-nonexistent', effort: 'high', family: 'real-bugfix', n: 1 }];
  const est = estimateRun({ plan, concurrency: 1, seed, history: { families: {} } });
  assert.equal(est.anyRoughGuess, true);
});

test('shouldConfirm: triggers above the points threshold, for any fable cell, and at the weekly ceiling', () => {
  const est = { weeklyPoints: { low: 0.5, high: 1.5 }, hasFableCell: false };
  assert.equal(shouldConfirm(est, { confirmAbovePoints: 2 }).required, false);
  assert.equal(shouldConfirm(est, { confirmAbovePoints: 1 }).required, true);
  assert.equal(shouldConfirm({ ...est, hasFableCell: true }, { confirmAbovePoints: 99 }).required, true);
  const nearCeiling = shouldConfirm(est, { confirmAbovePoints: 99, weeklyCeilingPct: 80, currentWeeklyPct: 79 });
  assert.equal(nearCeiling.required, true);
  assert.match(nearCeiling.reasons[0], /ceiling/);
});

test('suggestCheaperCellSet: drops fable cells first and lists what remains', () => {
  const est = {
    perCell: [
      { cellId: 'sonnet-medium', pointsHigh: 0.3, isFable: false },
      { cellId: 'fable51-high', pointsHigh: 2.0, isFable: true },
      { cellId: 'opus55-high', pointsHigh: 0.6, isFable: false },
    ],
  };
  const { cells, dropped } = suggestCheaperCellSet(est, { dropFable: true });
  assert.deepEqual(dropped, ['fable51-high']);
  assert.deepEqual(cells.sort(), ['opus55-high', 'sonnet-medium']);
});

test('estimateRun: fiveHourPoints is unknown (null bounds) when the seed ships no fiveHourPointAnchors -- never copied from weekly', () => {
  const seed = loadSeed();
  assert.equal(seed.fiveHourPointAnchors, undefined, 'the shipped seed has no measured 5-hour anchor yet');
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'real-bugfix', n: 3 }];
  const est = estimateRun({ plan, concurrency: 1, seed });
  assert.ok(est.weeklyPoints.high > 0, 'weekly points ARE measured for this cell (sanity check)');
  assert.equal(est.fiveHourPoints.low, null, 'fiveHourPoints must be unknown, not silently equal to the weekly figure');
  assert.equal(est.fiveHourPoints.high, null);
  assert.match(est.fiveHourPoints.derivedFrom, /unknown/);
  const text = formatEstimate(est);
  assert.match(text, /5-hour-window points: unknown/);
});

test('estimateRun: fiveHourPoints IS populated (and distinct math from weekly) once a fiveHourPointAnchors entry is configured', () => {
  const seed = { ...loadSeed(), fiveHourPointAnchors: { 'real-bugfix': { runs: 10, points: 1, note: 'test-only measured anchor' } } };
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'real-bugfix', n: 3 }];
  const est = estimateRun({ plan, concurrency: 1, seed });
  assert.notEqual(est.fiveHourPoints.low, null, 'a configured 5-hour anchor must populate real numbers');
  assert.notEqual(est.fiveHourPoints.high, null);
  assert.match(est.fiveHourPoints.derivedFrom, /measured 5-hour anchor/);
  const text = formatEstimate(est);
  assert.match(text, /5-hour-window points: [\d.]/);
});

test('formatEstimate: shows "unknown" for weekly % when currentWeeklyPct is not supplied', () => {
  const seed = loadSeed();
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'real-bugfix', n: 1 }];
  const est = estimateRun({ plan, concurrency: 1, seed });
  const text = formatEstimate(est);
  assert.match(text, /current weekly usage: unknown/);
  assert.match(text, /projected after this run: unknown/);
});

test('formatEstimate: prints a per-cell breakdown line and a CONFIRMATION REQUIRED block when gated', () => {
  const seed = loadSeed();
  const plan = [{ cellId: 'fable51-high', model: 'claude-fable-5-1', effort: 'high', family: 'real-bugfix', n: 1 }];
  const est = estimateRun({ plan, concurrency: 1, seed });
  const text = formatEstimate(est, { confirmAbovePoints: 2 });
  assert.match(text, /per-cell breakdown/);
  assert.match(text, /CONFIRMATION REQUIRED/);
  assert.match(text, /Fable cell/);
});

// --- loadLocalHistory(): scans real results.jsonl fixtures, excludes the
// right rows -----------------------------------------------------------

function writeResultsFixture(dir, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('loadLocalHistory excludes budget_exhausted, auth_error and collision rows from the medians', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-bench-est-hist-'));
  try {
    // FS5 fix (2026-09-24 family-split review): loadLocalHistory() now keys
    // its `families` map by the FINE evidence-family label (see
    // fineFamilyOfHistoryRow() in bench/estimate.mjs), not the coarse
    // built-in task_family -- a real row always carries BOTH fields (see
    // bench/runner.mjs's runOne()), so the fixture below does too.
    writeResultsFixture(join(root, 'pilot-2020-01-01'), [
      { task_family: 'easy', evidence_family_fine: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1000, cost_usd: 0.01, input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, terminal_reason: 'completed' },
      { task_family: 'easy', evidence_family_fine: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 999999, cost_usd: 99, terminal_reason: 'budget_exhausted' },
      { task_family: 'easy', evidence_family_fine: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1, cost_usd: 0, auth_error: true },
      { task_family: 'easy', evidence_family_fine: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1, cost_usd: 0, collision: true },
    ]);
    const hist = loadLocalHistory({ resultsRoot: root });
    const cell = hist.families['easy-synthetic'].cells['claude-sonnet-5|medium'];
    assert.equal(cell.n, 1, 'only the one genuinely completed row counts');
    assert.equal(cell.medianDurationMs, 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadLocalHistory on a nonexistent root returns empty families, never throws', () => {
  const hist = loadLocalHistory({ resultsRoot: join(tmpdir(), 'ac-bench-est-does-not-exist-' + Date.now()) });
  assert.deepEqual(hist.families, {});
});

// --- FS6 (2026-09-24 family-split review): the estimator's $ and weekly ---
// --- points come from cost_usd (Claude Code-reported), never price x -----
// --- tokens. REQUIRED PROOF: the estimator's $ comes from cost_usd. ------
//
// Already true of the current code (loadLocalHistory()'s medianCostUsd is
// `median(rows.map((r) => r.cost_usd))`, and estimateRun()'s apiCostUsd sums
// medianCostUsd directly) -- this test LOCKS that invariant so a future
// change cannot silently reintroduce a price x tokens dollar figure without
// a red test here. A row's OUTPUT_TOKENS is set deliberately huge relative
// to its cost_usd; if the $ figure were ever derived from tokens x price
// instead, it would come out far larger than the tiny cost_usd below.
test('FS6: the estimator\'s $ comes from cost_usd, never price x tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-bench-est-fs6-'));
  try {
    writeResultsFixture(join(root, 'pilot-2020-01-01'), [
      {
        task_family: 'real', evidence_family_fine: 'real-bugfix', requested_model: 'claude-opus-5-5', requested_effort: 'high',
        duration_ms: 5000, cost_usd: 0.42, input_tokens: 10, cache_read_tokens: 500000, cache_creation_tokens: 50000, output_tokens: 90000,
      },
    ]);
    const history = loadLocalHistory({ resultsRoot: root });
    const cell = history.families['real-bugfix'].cells['claude-opus-5-5|high'];
    assert.equal(cell.medianCostUsd, 0.42, 'medianCostUsd must equal the row\'s reported cost_usd exactly');

    const est = estimateRun({
      plan: [{ cellId: 'opus55-high', model: 'claude-opus-5-5', effort: 'high', family: 'real-bugfix', n: 1 }],
      concurrency: 1, seed: { families: {}, weeklyPointAnchors: {} }, history,
    });
    assert.equal(est.apiCostUsd, 0.42, 'estimateRun()\'s apiCostUsd must equal cost_usd, not a price x tokens figure');
    assert.equal(est.perCell[0].costUsd, 0.42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Judge-vote cost (operator direction, 2026-09-24): the pre-run ---------
// --- estimate previously counted ZERO judge cost at all -- a rubric judge --
// --- casts real, separately-billed votes, measured on real architecture ---
// --- packs at ~$0.81/vote at fable/high (n~=21 judged answers, ~$54 total) -

test('judgePriceRatioToFable: 1x for a fable model, and a cheaper tier scales down proportionally', () => {
  assert.equal(judgePriceRatioToFable('claude-fable-5-1'), 1);
  const sonnetRatio = judgePriceRatioToFable('claude-sonnet-5');
  assert.ok(sonnetRatio > 0 && sonnetRatio < 1, `sonnet must be cheaper than fable, got ${sonnetRatio}`);
  const opusRatio = judgePriceRatioToFable('claude-opus-5-5');
  assert.ok(opusRatio > sonnetRatio && opusRatio < 1, 'opus sits between sonnet and fable in price');
  // An unreadable/unknown model never throws and never scales -- fails open
  // to 1x (the seed's own already-measured number, unscaled).
  assert.equal(judgePriceRatioToFable('not-a-real-model-id'), 1);
});

test('loadLocalJudgeVoteHistory: keys by (judge_model, judge_effort), medians the PER-VOTE cost, and ignores rows with no judge data', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-bench-est-judgevote-'));
  try {
    writeResultsFixture(join(root, 'pilot-2020-01-01'), [
      // judge_cost_usd is the TOTAL for judge_votes votes -- 3 votes at
      // $0.90 total = $0.30/vote.
      { judge_model: 'claude-fable-5-1', judge_effort: 'high', judge_cost_usd: 0.90, judge_votes: 3 },
      { judge_model: 'claude-fable-5-1', judge_effort: 'high', judge_cost_usd: 1.20, judge_votes: 3 },
      // A different judge tier gets its own bucket.
      { judge_model: 'claude-sonnet-5', judge_effort: 'medium', judge_cost_usd: 0.30, judge_votes: 3 },
      // No judge fields at all -- an ordinary writer row, never counted.
      { requested_model: 'claude-sonnet-5', requested_effort: 'medium', cost_usd: 0.05 },
      // judge_votes present but zero -- never divides by zero, never counted.
      { judge_model: 'claude-fable-5-1', judge_effort: 'high', judge_cost_usd: 0.5, judge_votes: 0 },
    ]);
    const hist = loadLocalJudgeVoteHistory({ resultsRoot: root });
    assert.ok(hist['claude-fable-5-1|high'], 'must have a bucket for the judge model/effort actually seen');
    assert.equal(hist['claude-fable-5-1|high'].n, 2);
    // median(0.90/3, 1.20/3) = median(0.30, 0.40) = 0.35.
    assert.equal(hist['claude-fable-5-1|high'].medianCostUsdPerVote, 0.35);
    assert.equal(hist['claude-sonnet-5|medium'].n, 1);
    assert.ok(
      Math.abs(hist['claude-sonnet-5|medium'].medianCostUsdPerVote - 0.10) < 1e-9,
      `expected ~0.10, got ${hist['claude-sonnet-5|medium'].medianCostUsdPerVote}`,
    );
    assert.equal(Object.keys(hist).length, 2, 'no bucket for rows with no usable judge data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadLocalJudgeVoteHistory on a nonexistent root returns {}, never throws', () => {
  const hist = loadLocalJudgeVoteHistory({ resultsRoot: join(tmpdir(), 'ac-bench-est-judgevote-missing-' + Date.now()) });
  assert.deepEqual(hist, {});
});

test('judgeVoteCostFor: prefers LOCAL HISTORY over the seed anchor when this machine has judge-vote data', () => {
  const history = { 'claude-fable-5-1|high': { medianCostUsdPerVote: 1.23, n: 6 } };
  const r = judgeVoteCostFor({ model: 'claude-fable-5-1', effort: 'high', history });
  assert.equal(r.source, 'local-history');
  assert.equal(r.costUsdPerVote, 1.23);
  assert.equal(r.n, 6);
});

test('judgeVoteCostFor: falls back to the seed anchor (measured 2026-09-24, ~$0.81/vote at fable/high), labelled as such', () => {
  const r = judgeVoteCostFor({ model: 'claude-fable-5-1', effort: 'high', history: {} });
  assert.equal(r.source, 'seed');
  assert.equal(r.costUsdPerVote, 0.81);
  assert.match(r.label, /measured 2026-09-24/);
  assert.match(r.label, /21 votes/);
});

test('judgeVoteCostFor: scales the seed anchor by relative model price for a DIFFERENT judge tier, and says so', () => {
  const r = judgeVoteCostFor({ model: 'claude-sonnet-5', effort: 'medium', history: {} });
  assert.equal(r.source, 'seed');
  assert.ok(r.costUsdPerVote > 0 && r.costUsdPerVote < 0.81, `sonnet must scale below the fable anchor, got ${r.costUsdPerVote}`);
  assert.match(r.label, /scaled .*x for this tier/);
});

test('judgeVoteCostFor: no local history and a seed with no judgeVoteAnchor -> "none", never a guessed number', () => {
  const r = judgeVoteCostFor({ model: 'claude-fable-5-1', effort: 'high', seed: { families: {} }, history: {} });
  assert.equal(r.source, 'none');
  assert.equal(r.costUsdPerVote, null);
});

test('estimateRun(): with a judgeVotePlan, judge cost is added to apiCostUsd AND reported separately; without one, judgeVote is null (unchanged)', () => {
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'easy-synthetic', n: 1 }];
  const noJudge = estimateRun({ plan, concurrency: 1, seed: loadSeed(), history: { families: {} } });
  assert.equal(noJudge.judgeVote, null);

  const withJudge = estimateRun({
    plan, concurrency: 1, seed: loadSeed(), history: { families: {} },
    judgeVotePlan: { model: 'claude-fable-5-1', effort: 'high', votes: 9, history: {} },
  });
  assert.ok(withJudge.judgeVote, 'judgeVote must be reported when a judgeVotePlan is given');
  assert.equal(withJudge.judgeVote.votes, 9);
  assert.equal(withJudge.judgeVote.costUsdPerVote, 0.81);
  assert.equal(withJudge.judgeVote.totalCostUsd, 0.81 * 9);
  assert.equal(
    withJudge.apiCostUsd, noJudge.apiCostUsd + 0.81 * 9,
    'judge-vote cost must be added on top of the writer cells\' own apiCostUsd, not replace it',
  );
});

test('estimateRun(): a judgeVotePlan with zero votes contributes no judge cost (an unjudged/ineligible plan)', () => {
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'easy-synthetic', n: 1 }];
  const est = estimateRun({
    plan, concurrency: 1, seed: loadSeed(), history: { families: {} },
    judgeVotePlan: { model: 'claude-fable-5-1', effort: 'high', votes: 0, history: {} },
  });
  assert.equal(est.judgeVote, null);
});

test('formatEstimate(): prints a judge-votes line only when judgeVote is present', () => {
  const plan = [{ cellId: 'sonnet-medium', model: 'claude-sonnet-5', effort: 'medium', family: 'easy-synthetic', n: 1 }];
  const noJudge = estimateRun({ plan, concurrency: 1, seed: loadSeed(), history: { families: {} } });
  assert.doesNotMatch(formatEstimate(noJudge), /judge votes:/);

  const withJudge = estimateRun({
    plan, concurrency: 1, seed: loadSeed(), history: { families: {} },
    judgeVotePlan: { model: 'claude-fable-5-1', effort: 'high', votes: 9, history: {} },
  });
  const text = formatEstimate(withJudge);
  assert.match(text, /judge votes:\s+9 vote\(s\) x \$0\.810\/vote = ~\$7\.29/);
  assert.match(text, /measured 2026-09-24/);
});
