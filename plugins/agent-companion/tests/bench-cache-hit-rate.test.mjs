// Cache hit rate column (2026-09-23, cache-read-weight-2026-09-23 experiment)
// -- reads / (reads + writes + uncached input), a headline column next to
// cache reads and turns in bench/runner.mjs's rebuildSummary() output, plus
// a flag on any cell whose median hit rate falls below 0.85. The threshold
// exists because separate `claude -p` processes (including --resume) do NOT
// reliably share prompt cache even with byte-identical content -- a low
// hit rate on a benchmark cell is usually the HARNESS breaking caching for
// that run, not the model or task being unusual. See docs/BENCHMARK.md
// "Caching" and config/model-tiers.json's costDrivers.planUsageWeighting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rebuildSummary, cacheHitRate } from '../bench/runner.mjs';

test('cacheHitRate: reads / (reads + writes + uncached input)', () => {
  assert.equal(cacheHitRate({ cache_read_tokens: 900, cache_creation_tokens: 50, input_tokens: 50 }), 0.9);
  // Missing writes/input default to 0, not null -- a missing WRITE count is
  // not the same uncertainty as a missing READ count.
  assert.equal(cacheHitRate({ cache_read_tokens: 100 }), 1);
  assert.equal(cacheHitRate({ cache_read_tokens: null, cache_creation_tokens: 10, input_tokens: 10 }), null);
  assert.equal(cacheHitRate({ cache_read_tokens: 0, cache_creation_tokens: 0, input_tokens: 0 }), null);
});

function outDirFor(rows) {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-hit-rate-'));
  writeFileSync(join(outDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return outDir;
}

test('rebuildSummary: healthy cache hit rate is not flagged', () => {
  const outDir = outDirFor([
    {
      cell: 'sonnet-medium', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false,
      requested_model: 'claude-sonnet-5',
      cost_usd: 1.00, num_turns: 10, cache_read_tokens: 930000, cache_creation_tokens: 20000, input_tokens: 50000,
      output_tokens: 500,
    },
  ]);
  try {
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary[0].cache_hit_rate, 0.93);
    assert.equal(summary[0].cache_anomaly, false);

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /930000 \| 93% \| 10/);
    assert.doesNotMatch(md, /CACHE ANOMALY/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: a cell under 0.85 hit rate is flagged "cache anomaly: check harness"', () => {
  const outDir = outDirFor([
    {
      cell: 'opus55-real', task: 'debug', rep: 1, pass: true, is_error: false, auth_error: false,
      requested_model: 'claude-opus-5-5',
      cost_usd: 2.00, num_turns: 6, cache_read_tokens: 200000, cache_creation_tokens: 300000, input_tokens: 20000,
      output_tokens: 800,
    },
  ]);
  try {
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    // 200000 / (200000 + 300000 + 20000) = 0.3846...
    assert.ok(summary[0].cache_hit_rate < 0.85);
    assert.equal(summary[0].cache_anomaly, true);

    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /cache anomaly: check harness/);
    assert.match(md, /opus55-real \/ debug: 38%/);
    // The flagged row itself also carries a visible marker.
    assert.match(md, /38% ⚠/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('rebuildSummary: hit rate is n/a when cache_read_tokens is missing, not flagged', () => {
  const outDir = outDirFor([
    {
      cell: 'haiku', task: 'lookup', rep: 1, pass: true, is_error: false, auth_error: false,
      requested_model: 'claude-haiku-4-5',
      cost_usd: 0.02, num_turns: null, cache_read_tokens: null, output_tokens: 120, input_tokens: 50,
    },
  ]);
  try {
    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    assert.equal(summary[0].cache_hit_rate, null);
    assert.equal(summary[0].cache_anomaly, false);
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /CACHE ANOMALY/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
