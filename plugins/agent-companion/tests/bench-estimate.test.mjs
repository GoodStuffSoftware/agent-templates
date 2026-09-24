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

test('mediansFor: no data anywhere -> source "none", labelled "no local history, rough guess"', () => {
  const seed = loadSeed();
  const r = mediansFor({ family: 'real-bugfix', model: 'claude-made-up-9000', effort: 'medium', seed, history: { families: {} } });
  assert.equal(r.source, 'none');
  assert.match(r.label, /no local history, rough guess/);
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
    writeResultsFixture(join(root, 'pilot-2020-01-01'), [
      { task_family: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1000, cost_usd: 0.01, input_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, output_tokens: 1, terminal_reason: 'completed' },
      { task_family: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 999999, cost_usd: 99, terminal_reason: 'budget_exhausted' },
      { task_family: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1, cost_usd: 0, auth_error: true },
      { task_family: 'easy-synthetic', requested_model: 'claude-sonnet-5', requested_effort: 'medium', duration_ms: 1, cost_usd: 0, collision: true },
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
