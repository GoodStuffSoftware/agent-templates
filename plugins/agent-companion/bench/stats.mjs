// Small-sample statistics for the model x effort benchmark's summaries.
//
// Why this exists: a benchmark cell usually has 1-7 runs per task family.
// At that n, a raw pass rate reads as far more certain than it is -- a 5/7
// vs 7/7 difference between two adjacent effort levels (measured on Opus 5.5
// high vs low on real bug-fix tasks, 2026-09-23) turned out to be variance,
// not a capability gap. Every summary row therefore carries a 95% Wilson
// score interval, and a cell with too few runs to separate from its
// neighbours is flagged rather than left to read as a finding.
//
// Zero dependencies, pure functions, no I/O -- exercised directly by
// tests/bench-stats.test.mjs.

// Below this many runs in a cell x task-family group, the summary says
// "n too small to separate" instead of letting the pass rate stand alone.
// At n=4 the Wilson interval for 4/4 is still [0.51, 1.00] -- wide enough to
// overlap almost any other cell -- so 5 is the smallest n where the flag is
// worth dropping, and even then a CI overlap check is the real test.
export const MIN_N_TO_SEPARATE = 5;

// z for a two-sided 95% interval.
const Z95 = 1.959963984540054;

// Wilson score interval for k successes in n Bernoulli trials. Preferred over
// the normal ("Wald") interval because it stays inside [0, 1] and behaves at
// k = 0 and k = n, which is exactly where a saturated benchmark cell sits.
// Returns { low, high } or null when n is 0 (no data is not a [0, 1] interval).
export function wilsonInterval(k, n, z = Z95) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // The exact bounds at k = 0 / k = n are 0 / 1; snap them so float noise
  // (5e-17) never renders as a nonzero lower bound.
  return {
    low: k === 0 ? 0 : Math.max(0, centre - half),
    high: k === n ? 1 : Math.min(1, centre + half),
  };
}

// Unbiased pass@k estimator (Chen et al. 2021, the SWE-bench/HumanEval
// convention): the probability that at least one of k samples drawn without
// replacement from n attempts, c of which passed, is a pass.
//   pass@k = 1 - C(n - c, k) / C(n, k)
// Computed as a running product to avoid factorial overflow. Returns null for
// k > n or n = 0 (undefined, not zero).
export function passAtK(n, c, k) {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) return null;
  if (n <= 0 || k <= 0 || k > n || c < 0 || c > n) return null;
  if (n - c < k) return 1;
  let prodFail = 1;
  for (let i = n - c + 1; i <= n; i += 1) prodFail *= 1 - k / i;
  return 1 - prodFail;
}

// True when two cells' intervals overlap -- i.e. the data cannot tell them
// apart at 95%. Used by docs/reports; exported for tests and hand analysis.
export function intervalsOverlap(a, b) {
  if (!a || !b) return true;
  return a.low <= b.high && b.low <= a.high;
}

// Formats an interval as "[51-100%]" for summary.md.
export function formatInterval(ci) {
  if (!ci) return 'n/a';
  return `[${Math.round(ci.low * 100)}-${Math.round(ci.high * 100)}%]`;
}
