// Cache-read tokens, turns, and the derived cost-driver stats
// (context re-reads, read share of cost) are HEADLINE columns in
// bench/runner.mjs's rebuildSummary() output -- see config/model-tiers.json's
// costDrivers and docs/BENCHMARK.md's reporting guidance: on this machine,
// cache reads (reads = context size x number of requests) are the largest
// real cost bucket, so turn count and context size are the actual spend
// levers, not output tokens. This file is the unit-level cousin of
// tests/bench-auth-error.test.mjs -- pure rebuildSummary() math against a
// hand-written results.jsonl fixture, no process spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rebuildSummary } from '../bench/runner.mjs';

test('rebuildSummary computes median_context_rereads and read_share_of_cost for a measured tier (sonnet)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-summary-cost-'));
  try {
    // sonnet's cacheHitPerMTok is 0.20 (config/model-tiers.json). One row:
    // 1,000,000 cache-read tokens over 10 turns -> 100,000 context_rereads.
    // Cache-read dollar cost = 1e6 * 0.20 / 1e6 = $0.20 of a $1.00 total ->
    // read_share_of_cost = 0.20.
    const rows = [
      {
        cell: 'sonnet-medium', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false,
        requested_model: 'claude-sonnet-5',
        cost_usd: 1.00, num_turns: 10, cache_read_tokens: 1000000, output_tokens: 500, input_tokens: 100,
      },
    ];
    writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary.length, 1);
    assert.equal(summary[0].median_context_rereads, 100000);
    assert.equal(summary[0].read_share_of_cost, 0.20);
    assert.equal(summary[0].median_cache_read_tokens, 1000000);
    assert.equal(summary[0].median_num_turns, 10);

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    // Headline columns sit next to pass_rate and cost_per_correct, not buried
    // after the token breakdown.
    const headerLine = md.split('\n').find((l) => l.startsWith('cell | task'));
    assert.ok(headerLine, 'expected a markdown header row starting with "cell | task"');
    const cols = headerLine.split(' | ').map((s) => s.trim());
    const idxPassRate = cols.indexOf('pass_rate');
    const idxCacheRead = cols.indexOf('med_cache_read_tok');
    const idxHitRate = cols.indexOf('hit_rate');
    const idxTurns = cols.indexOf('med_turns');
    const idxRereads = cols.indexOf('ctx_rereads');
    const idxReadShare = cols.indexOf('read_share_cost');
    const idxCostPerCorrect = cols.indexOf('cost_per_correct');
    for (const i of [idxCacheRead, idxHitRate, idxTurns, idxRereads, idxReadShare]) {
      assert.ok(i > idxPassRate, 'headline cost-driver column must come after pass_rate');
      assert.ok(i < idxCostPerCorrect, 'headline cost-driver column must come before cost_per_correct');
    }
    assert.ok(idxHitRate > idxCacheRead, 'hit_rate sits next to cache reads, per the brief');
    // 1,000,000 reads over a 1,000,100-token denominator (100 uncached input,
    // 0 writes) rounds to 100%.
    assert.match(md, /1000000 \| 100% \| 10 \| 100000 \| 20%/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: read_share_of_cost is null (n/a) for a tier with no measured cache-hit price', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-summary-cost-'));
  try {
    // mythos's resolvesTo.pricing is null (config/model-tiers.json: not
    // reachable on this account) -- read_share_of_cost must not guess a
    // number, but context_rereads only needs turns/cache_read_tokens and
    // should still compute.
    const rows = [
      {
        cell: 'mythos-medium', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false,
        requested_model: 'claude-mythos-1',
        cost_usd: 1.00, num_turns: 4, cache_read_tokens: 400000, output_tokens: 500, input_tokens: 100,
      },
    ];
    writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary[0].read_share_of_cost, null);
    assert.equal(summary[0].median_context_rereads, 100000);

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /100000 \| n\/a/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: context_rereads and read_share_of_cost are n/a when num_turns/cache_read_tokens are missing', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-summary-cost-'));
  try {
    const rows = [
      {
        cell: 'haiku', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false,
        requested_model: 'claude-haiku-4-5',
        cost_usd: 0.02, num_turns: null, cache_read_tokens: null, output_tokens: 120, input_tokens: 50,
      },
    ];
    writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    rebuildSummary(outDir);

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary[0].median_context_rereads, null);
    assert.equal(summary[0].read_share_of_cost, null);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
