// usage/stats.mjs: the statistics of the daily usage analysis (design section 3.4: "statistics:
// Wilson intervals, bootstrap, medians" are code, never config). Pure functions, no I/O.
//
// A "part" is one resampling unit, normally one session's contribution to a day:
//   { id, num, den, value? }     value, when present, is the part's own figure (median and p90 pools)
// A pool rule turns a list of parts into one figure:
//   ratio    sum(num) / sum(den) * scale
//   sum      sum(num) / sum(den) * scale  (den counts the days a total spans, so this is a per-day mean)
//   median   median of the parts' values (value, else num/den*scale)
//   p90      90th percentile of the same values

import { createHash } from 'node:crypto';

export const WILSON_Z = 1.959964; // two-sided 95%
export const BOOTSTRAP_ITERATIONS = 1000;
export const BOOTSTRAP_CI = [0.025, 0.975];

/** Wilson score interval for k successes of n. Returns { p, lo, hi, n } or null when n is not positive. */
export function wilson(k, n, z = WILSON_Z) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
}

/** Linear-interpolated quantile of an ascending-sorted array; null when empty. */
export function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const asc = (a, b) => a - b;
export function median(values) { return quantileSorted(values.slice().sort(asc), 0.5); }
export function p90(values) { return quantileSorted(values.slice().sort(asc), 0.9); }

/** First 32 bits of sha256(text): the seed of the bootstrap. */
export function hashSeed(text) {
  return createHash('sha256').update(String(text)).digest().readUInt32BE(0);
}

/** The bootstrap seed is fixed by the day and the scenario id (design section 3.2). */
export function seedFor(day, scenarioId) { return hashSeed(`${day}|${scenarioId}`); }

/** mulberry32: a small seeded generator; returns a function giving floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const partValue = (p, scale) => (Number.isFinite(p.value) ? p.value : p.den > 0 ? (p.num / p.den) * scale : null);

/** One figure from a list of parts under a pool rule; null when there is nothing to divide by. */
export function poolParts(parts, pool = 'ratio', scale = 1) {
  if (!parts.length) return null;
  if (pool === 'median' || pool === 'p90') {
    const v = parts.map((p) => partValue(p, scale)).filter((x) => Number.isFinite(x));
    if (!v.length) return null;
    return pool === 'median' ? median(v) : p90(v);
  }
  let n = 0; let d = 0;
  for (const p of parts) { n += p.num; d += p.den; }
  return d > 0 ? (n / d) * scale : null;
}

/**
 * Seeded bootstrap over parts (sessions) of the difference cur - base of the pooled figure.
 * Each side is resampled with replacement, independently, `iterations` times from one generator
 * seeded with `seed`, so the same input and seed always give the same interval.
 * Returns { lo, hi, mean, iterations, used, seed } or null when either side has no parts.
 */
export function bootstrapDiff({ cur, base, pool = 'ratio', scale = 1, seed, iterations = BOOTSTRAP_ITERATIONS, ci = BOOTSTRAP_CI }) {
  if (!cur.length || !base.length) return null;
  const rnd = mulberry32(seed);
  const draw = (parts) => {
    const out = new Array(parts.length);
    for (let i = 0; i < parts.length; i += 1) out[i] = parts[Math.floor(rnd() * parts.length)];
    return out;
  };
  const diffs = [];
  for (let i = 0; i < iterations; i += 1) {
    const c = poolParts(draw(cur), pool, scale);
    const b = poolParts(draw(base), pool, scale);
    if (c !== null && b !== null) diffs.push(c - b);
  }
  if (!diffs.length) return null;
  diffs.sort(asc);
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  return { lo: quantileSorted(diffs, ci[0]), hi: quantileSorted(diffs, ci[1]), mean, iterations, used: diffs.length, seed: seed >>> 0 };
}
