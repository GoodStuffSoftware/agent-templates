// Plan usage in the compaction advisor: each model's tokens priced at the
// baseline (Sonnet) price vector, times config/model-tiers.json
// planUsageMultipliers — the bench/runner.mjs plan_usage_index method — not
// a scalar on the model's own API price. Opus 5.5 cache reads cost the same
// as Sonnet 5's while its input/output cost 2x, so the Opus:Sonnet plan ratio
// (1.5) sits ABOVE the API ratio for a cache-read-heavy mix and BELOW it for
// an output-heavy mix. The old scalar (0.75 x API) got the read-heavy case
// backwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';
import {
  planPriceSpecFor, priceSpecFor, evaluateModel, combineModels, emptyModelInput,
} from '../scripts/lib/cache-advisor.mjs';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';

// The replay's own unit arithmetic: in + read*r + write*w5 + out*outRatio, x in$/token.
const cost = (mix, spec, mult = 1) => (mix.input + mix.cacheRead * spec.r + mix.cacheWrite * spec.w5 + mix.output * spec.outRatio) * spec.inUsd * mult;
const apiRatio = (mix) => cost(mix, priceSpecFor(OPUS)) / cost(mix, priceSpecFor(SONNET));
const planRatio = (mix) => {
  const o = planPriceSpecFor(OPUS);
  const s = planPriceSpecFor(SONNET);
  return cost(mix, o, o.multiplier) / cost(mix, s, s.multiplier);
};

test('planPriceSpecFor: Sonnet price vector, tier multiplier; no multiplier -> null', () => {
  const o = planPriceSpecFor(OPUS);
  const s = planPriceSpecFor(SONNET);
  assert.equal(o.baseline, 'sonnet');
  assert.equal(o.multiplier, 1.5);
  assert.equal(s.multiplier, 1);
  assert.equal(o.inUsd, priceSpecFor(SONNET).inUsd, 'opus tokens are priced at sonnet rates');
  assert.equal(o.r, priceSpecFor(SONNET).r);
  assert.equal(planPriceSpecFor('claude-haiku-4-5'), null, 'unmeasured tier: no plan figure, never a guessed 1.0');
});

test('cache-read-heavy mix: plan ratio is ABOVE the API ratio', () => {
  const mix = { input: 1000, cacheRead: 5_000_000, cacheWrite: 20_000, output: 2000 };
  const api = apiRatio(mix);
  const plan = planRatio(mix);
  assert.ok(api < 1.2, `reads cost the same on both, so API ratio is near 1 (got ${api})`);
  assert.ok(Math.abs(plan - 1.5) < 1e-9, `plan ratio is the multiplier on identical Sonnet-priced tokens (got ${plan})`);
  assert.ok(plan > api);
  assert.ok(0.75 * api < api, 'the old 0.75 scalar would have put Opus plan usage BELOW its API ratio here — backwards');
});

test('output-heavy mix: plan ratio is BELOW the API ratio', () => {
  const mix = { input: 10_000, cacheRead: 10_000, cacheWrite: 0, output: 500_000 };
  const api = apiRatio(mix);
  const plan = planRatio(mix);
  assert.ok(api > 1.9, `output costs 2x on Opus (got ${api})`);
  assert.ok(Math.abs(plan - 1.5) < 1e-9);
  assert.ok(plan < api);
});

function track(n = 400, start = 60000, g = 2000) {
  const inc = [0, ...Array.from({ length: n - 1 }, () => g)];
  return { kind: 'main', start, inc, idle: inc.map(() => 0), ttl1h: inc.map(() => 1) };
}
function input(model) {
  const mi = emptyModelInput(model);
  mi.tracks = Array.from({ length: 6 }, () => ({ ...track(), model }));
  for (const t of mi.tracks) {
    mi.requests += t.inc.length; mi.mainRequests += t.inc.length;
    for (let i = 1; i < t.inc.length; i++) { mi.growth.sum += t.inc[i]; mi.growth.n += 1; }
  }
  mi.compactions = Array.from({ length: 3 }, () => ({
    kind: 'main', trigger: 'auto', preTokens: 967000, postTokens: 20000, firstAfterContext: 60000, firstAfterWrite: 40000, requestsAfter: 100, reworkTokens: null,
  }));
  return mi;
}

test('the replay carries planUsd per window; a read-only window gives Opus plan = 1.5x Sonnet-priced; unmeasured tiers do not vote', () => {
  const fx = makeFixture();
  try {
    const o = input(OPUS);
    const s = input(SONNET);
    const h = input('claude-haiku-4-5');
    const all = new Map([[o.model, o], [s.model, s], [h.model, h]]);
    const eo = evaluateModel(o, all, { minRequests: 100, minTracksReaching: 1 });
    const es = evaluateModel(s, all, { minRequests: 100, minTracksReaching: 1 });
    const eh = evaluateModel(h, all, { minRequests: 100, minTracksReaching: 1 });
    // At 1M no track reaches the threshold: every unit is a cache read.
    const at = (e, W) => e.curve.find((c) => c.window === W && c.feasible);
    const po = at(eo, 1000000);
    const ps = at(es, 1000000);
    assert.ok(Math.abs(ps.planUsd - ps.usd) < 1e-9, 'sonnet: plan = API');
    assert.ok(Math.abs(po.planUsd / ps.usd - 1.5) < 1e-9, 'opus plan = 1.5 x the same tokens at sonnet prices');
    assert.ok(Math.abs(po.planUsd / po.usd - 1.5) < 1e-9, 'reads priced the same: opus plan/API = 1.5, where the old scalar said 0.75');
    const hPoint = eh.curve.find((c) => c.feasible);
    assert.equal(eh.status, 'ok');
    assert.equal(hPoint.planUsd, null);
    const g = combineModels([eo, es, eh], { plan: true });
    assert.ok(!g.voters.includes('claude-haiku-4-5'));
    assert.deepEqual(g.excluded, ['claude-haiku-4-5']);
  } finally { fx.cleanup(); }
});
