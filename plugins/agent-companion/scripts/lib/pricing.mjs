// Dollar pricing, read from config/model-pricing.json (data, not code).
//
// The one place this plugin turns token counts into dollars. cache-ttl.mjs
// re-exports pricingTable()/classifyPricing() from here so its public API is
// unchanged; lib/transcripts.mjs uses priceUsage() for its report. Every
// figure computed here is PRICE-DERIVED (list price x tokens), never a billed
// amount — results carry basis: 'price-derived' so a later consumer that has
// a measured cost (bench results' cost_usd) can tell the two apart and prefer
// the measured one.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRoot, modelTiers, classifyModel } from '../../hooks/lib/context.mjs';

export const PRICE_BASIS = 'price-derived';

let _pricing = null;
export function pricingTable() {
  if (_pricing) return _pricing;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'model-pricing.json');
  let cfg = { models: {}, defaultReadMultiplier: 0.1, writeMultiplier5m: 1.25, writeMultiplier1h: 2 };
  try { cfg = JSON.parse(readFileSync(shipped, 'utf8')); } catch { /* use defaults */ }
  // Same by-alias merge convention as hooks/lib/context.mjs's modelTiers()
  // override — one changed price does not require restating the table.
  let over = null;
  try { over = JSON.parse(readFileSync(join(stateRoot(), 'model-pricing.json'), 'utf8')); } catch { /* no override: expected */ }
  if (over) cfg = { ...cfg, ...over, models: { ...(cfg.models || {}), ...(over.models || {}) } };
  _pricing = cfg;
  return _pricing;
}

// Reset the cached table — test-only escape hatch, since pricingTable() caches
// at module scope and a test that writes an override needs the next call to
// see it rather than a stale in-process cache from an earlier test.
export function _resetPricingCacheForTests() { _pricing = null; }

// First match wins, in the order the table lists them — put a more specific
// pattern (opus-5-5) ahead of the pattern it would otherwise also match
// (opus-5), same convention as classifyModel() in hooks/lib/context.mjs.
export function classifyPricing(model, cfg = pricingTable()) {
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.models || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      return {
        alias,
        in: spec.in,
        out: spec.out,
        readMultiplier: spec.readMultiplier ?? cfg.defaultReadMultiplier ?? 0.1,
        known: true,
      };
    }
  }
  return { alias: '', in: null, out: null, readMultiplier: null, known: false };
}

// Price one usage record (the shape lib/transcripts.mjs emits: input, output,
// cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h). Cache writes are priced
// by TTL bucket at the table's writeMultiplier5m / writeMultiplier1h; a write
// the transcript did not split by bucket (flat cache_creation_input_tokens
// only) is priced as 5m, the default TTL. Returns null for a model the table
// does not price — there is no safe figure to guess, so unknown models are
// counted separately by the caller, never priced at a default.
export function priceUsage(usage, model, cfg = pricingTable()) {
  const cls = classifyPricing(model, cfg);
  if (!cls.known) return null;
  const inUsd = cls.in / 1e6;
  const outUsd = cls.out / 1e6;
  const w5 = cfg.writeMultiplier5m ?? 1.25;
  const w1 = cfg.writeMultiplier1h ?? 2;
  const split1h = usage.cacheWrite1h || 0;
  const split5m = Math.max(0, (usage.cacheWrite || 0) - split1h);
  const usd = (usage.input || 0) * inUsd
    + split5m * w5 * inUsd
    + split1h * w1 * inUsd
    + (usage.cacheRead || 0) * cls.readMultiplier * inUsd
    + (usage.output || 0) * outUsd;
  return { usd, alias: cls.alias, basis: PRICE_BASIS };
}

// Prices in the shape the replay needs, or null for an unpriced model.
export function priceSpecFor(model, cfg = pricingTable()) {
  const cls = classifyPricing(model, cfg);
  if (!cls.known) return null;
  return {
    alias: cls.alias,
    inUsd: cls.in / 1e6,
    outRatio: cls.out / cls.in,
    r: cls.readMultiplier,
    w5: cfg.writeMultiplier5m ?? 1.25,
    w1: cfg.writeMultiplier1h ?? 2,
  };
}

// Plan usage (subscription limits), priced the way bench/runner.mjs prices
// its plan_usage_index: every model's tokens at the BASELINE tier's price
// vector (the tier config/model-tiers.json planUsageMultipliers defines as
// 1.0, i.e. Sonnet), times the model's own tier multiplier from that table
// (opus 1.5 as of its date). Not a scalar on the model's API price: Opus 5.5
// input and output cost 2x Sonnet 5 but cache reads cost the same, so the
// API ratio depends on the token mix and a fixed weight is wrong for every
// mix but one. null when the model's tier has no measured multiplier (no
// plan figure, never a guessed 1.0) or the baseline tier is unpriced.
export function planPriceSpecFor(model, tiersCfg = modelTiers(), pricing = pricingTable()) {
  const mults = tiersCfg.planUsageMultipliers || {};
  const alias = classifyModel(model).alias;
  const own = mults[alias];
  if (!own || typeof own.multiplier !== 'number') return null;
  const baseAlias = Object.keys(mults).find((k) => mults[k]?.multiplier === 1);
  const baseModel = baseAlias && tiersCfg.tiers?.[baseAlias]?.resolvesTo?.modelId;
  const base = baseModel ? priceSpecFor(baseModel, pricing) : null;
  if (!base) return null;
  return { ...base, baseline: baseAlias, multiplier: own.multiplier };
}
