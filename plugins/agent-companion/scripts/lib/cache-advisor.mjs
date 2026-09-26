// cache-advisor — the break-even auto-compact window for each model, from the
// operator's own transcripts, plus where the prompt-cache money goes and what
// each subagent spawn costs cold. Read-only on transcripts and settings; the
// only file it writes is its own summary under the plugin's state directory
// (saveAdvisorSummary), for /ac recommend to quote. It never writes a Claude
// Code setting: the window is ADVICE.
//
// --- The setting ---------------------------------------------------------------
//
// Claude Code has ONE auto-compact window (autoCompactWindow in settings, the
// --autocompact flag, or CLAUDE_CODE_AUTO_COMPACT_WINDOW), 100K to 1M tokens,
// capped at each model's context window. Unset, a model compacts at its
// default threshold (config/compaction.json: about 967K on native-1M models,
// the 200K boundary on 200K models). So the advice has two parts: the
// per-model optimum, and the one value that is cheapest across the operator's
// actual model mix (the sum of every model's cost at that value).
//
// --- The economics (all costs in input-token equivalents x the model's input
// price; r = cache-read multiplier, w = cache-write multiplier for the TTL
// that applied, 1.25 for 5m or 2 for 1h) ------------------------------------------
//
// Every request re-reads the whole context from cache: cost C x r. A request
// sent after the cache expired (the reader's cause 'idle-expiry') rewrites it
// instead: C x w. New tokens are written once whatever the window, so the
// append cost is the same for every window and drops out of the comparison.
// A compaction costs:
//   - the summarisation call, which reads the context from the warm cache
//     (C x r) and writes the summary (postTokens output tokens, at the output
//     price), and
//   - the first request after it, which rewrites the part of the new context
//     the cache does not hold (firstRequestAfter.cacheWrite x (w - r); the
//     read part is already counted as that request's own read).
// After a compaction the context is the post-compaction working size P
// (firstRequestAfter.contextTokens, NOT postTokens, which is the summary
// alone).
//
// A larger window means fewer compactions but more tokens re-read on every
// request, and a bigger rewrite on every idle expiry. The advisor REPLAYS each
// transcript's real sequence of context growth (per request, within each
// compaction epoch) and real idle expiries under every candidate window, and
// sums the cost. Replaying keeps what an average would lose: most sessions
// end before they reach any window, and a compaction just before a session
// ends is money spent for nothing.
//
// Closed-form cross-check (the same model with steady growth g per request,
// idle-expiry rate lambda, mean write multiplier w; EOQ-shaped):
//   cost per request f(W) = R (P + W) / 2 + g (k0 + r W) / (W - P)
//   with R = r + lambda (w - r) and k0 = S x out/in + Pw x (w - r)
//   minimised at W* = P + sqrt(2 g (k0 + r P) / R).
//
// What is NOT priced: the detail compaction loses, and the minutes a
// compaction takes. The advisor never recommends a window that would compact
// more often than once every minTurnsPerCompaction turns (config), measured
// with each model's own requests per turn.
//
// --- Money ------------------------------------------------------------------
//
// Token costs come from config/model-pricing.json (price-derived). They are
// ANCHORED on the benchmark rows' cost_usd (Claude Code's own per-run cost
// figure, in bench results.jsonl): calibrate() prices each row's tokens both
// ways (all cache writes 5m, all 1h), keeps the assumption whose
// cost_usd / price-derived ratio is tighter, and scales every dollar figure by
// that model's median ratio (or the pooled one). Plan usage (subscription
// limits) is a dated secondary view with per-model weights in
// config/compaction.json planUsage.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCorpus, gapsOf, spawnBaselineOf, percentile } from './transcripts.mjs';
import { pricingTable, classifyPricing, priceUsage } from './pricing.mjs';
import { stateRoot, stateDir, claudeDir, dataDir } from '../../hooks/lib/context.mjs';

export const ADVISOR_SUMMARY_FILE = 'cache-advisor.json';
const MIN_PARAM_SAMPLES = 3;

// --- Config --------------------------------------------------------------------

let _cfg = null;
export function compactionConfig() {
  if (_cfg) return _cfg;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'compaction.json');
  let cfg = { models: {}, unknownModel: { contextWindow: 200000, defaultCompactAt: 200000 }, window: { min: 100000, max: 1000000, step: 25000 }, minTurnsPerCompaction: 10, planUsage: { weights: {} } };
  try { cfg = { ...cfg, ...JSON.parse(readFileSync(shipped, 'utf8')) }; } catch { /* use defaults */ }
  let local = null;
  try { local = JSON.parse(readFileSync(join(stateRoot(), 'compaction.json'), 'utf8')); } catch { /* none: expected */ }
  if (local) cfg = { ...cfg, ...local, models: { ...(cfg.models || {}), ...(local.models || {}) } };
  _cfg = cfg;
  return _cfg;
}
export function _resetCompactionConfigForTests() { _cfg = null; }

// { alias, contextWindow, defaultCompactAt, known }
export function windowSpecFor(model, cfg = compactionConfig()) {
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.models || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      return { alias, contextWindow: spec.contextWindow, defaultCompactAt: spec.defaultCompactAt ?? spec.contextWindow, known: true };
    }
  }
  const u = cfg.unknownModel || { contextWindow: 200000, defaultCompactAt: 200000 };
  return { alias: '', contextWindow: u.contextWindow, defaultCompactAt: u.defaultCompactAt ?? u.contextWindow, known: false };
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

// --- The configured window (read-only) ---------------------------------------------

// "400k", "1M", 400000, "400000" -> tokens; anything else -> null. A bare
// number from 100 to 1000 means thousands, as the /autocompact command reads it.
export function parseWindow(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >= 100 && v <= 1000 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2]) return Math.round(n * (/m/i.test(m[2]) ? 1e6 : 1e3));
  return n >= 100 && n <= 1000 ? n * 1000 : n;
}

// What the operator has set, from the environment variable (plain integer only,
// as documented) or the user settings file. Never writes either.
export function configuredWindow({ env = process.env, settingsPath = join(claudeDir(), 'settings.json') } = {}) {
  const ev = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (ev != null && ev !== '') {
    const n = /^\d+$/.test(String(ev).trim()) ? Number(ev) : null;
    return { tokens: n, raw: ev, source: 'env CLAUDE_CODE_AUTO_COMPACT_WINDOW' };
  }
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (s && s.autoCompactWindow != null) return { tokens: parseWindow(s.autoCompactWindow), raw: s.autoCompactWindow, source: 'user settings autoCompactWindow' };
  } catch { /* no settings or unreadable: unset */ }
  return { tokens: null, raw: null, source: 'unset' };
}

// --- Money anchor: bench cost_usd vs price-derived -----------------------------------

const median = (xs) => percentile([...xs].sort((a, b) => a - b), 50);

// Reads every <resultsRoot>/*/results.jsonl (the rows bench/estimate.mjs reads)
// and returns { assumption, pooled:{n,ratio,p10,p90}, perModel:{model:{n,ratio}} }.
// Rows without a positive cost_usd, auth errors, rescore retries (their cost is
// copied from the original row) and unpriced models are skipped.
export function calibrate({ resultsRoot = join(dataDir(), 'benchmarks'), rows = null } = {}) {
  const all = rows || readBenchRows(resultsRoot);
  const ways = { '5m': { pooled: [], per: new Map() }, '1h': { pooled: [], per: new Map() } };
  for (const r of all) {
    if (typeof r.cost_usd !== 'number' || !(r.cost_usd > 0) || r.is_rescore_retry || r.auth_error) continue;
    const model = r.resolved_model || r.requested_model;
    const u = { input: r.input_tokens || 0, output: r.output_tokens || 0, cacheRead: r.cache_read_tokens || 0, cacheWrite: r.cache_creation_tokens || 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    for (const [way, uu] of [['5m', u], ['1h', { ...u, cacheWrite1h: u.cacheWrite }]]) {
      const p = priceUsage(uu, model);
      if (!p || !(p.usd > 0)) continue;
      const ratio = r.cost_usd / p.usd;
      ways[way].pooled.push(ratio);
      if (!ways[way].per.has(model)) ways[way].per.set(model, []);
      ways[way].per.get(model).push(ratio);
    }
  }
  const spread = (xs) => {
    if (xs.length < 2) return Infinity;
    const med = median(xs);
    return median(xs.map((x) => Math.abs(x - med)));
  };
  const n = ways['1h'].pooled.length;
  if (!n) return { assumption: null, pooled: { n: 0, ratio: null }, perModel: {}, source: 'no bench rows with cost_usd' };
  const assumption = spread(ways['1h'].pooled) <= spread(ways['5m'].pooled) ? '1h' : '5m';
  const w = ways[assumption];
  const sorted = [...w.pooled].sort((a, b) => a - b);
  const perModel = {};
  for (const [model, xs] of w.per) perModel[model] = { n: xs.length, ratio: median(xs) };
  return {
    assumption,
    pooled: { n: sorted.length, ratio: median(sorted), p10: percentile(sorted, 10), p90: percentile(sorted, 90) },
    perModel,
    source: 'bench results.jsonl cost_usd',
  };
}

function readBenchRows(root) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let text;
    try { text = readFileSync(join(root, d.name, 'results.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip a bad row */ }
    }
  }
  return out;
}

// The factor a model's price-derived dollars are scaled by, and where it came from.
export function anchorFor(model, cal, minRows = 5) {
  const pm = cal?.perModel?.[model];
  if (pm && pm.n >= minRows && Number.isFinite(pm.ratio)) return { factor: pm.ratio, basis: `cost_usd-anchored (this model, n=${pm.n})` };
  if (cal?.pooled?.n >= minRows && Number.isFinite(cal.pooled.ratio)) return { factor: cal.pooled.ratio, basis: `cost_usd-anchored (pooled, n=${cal.pooled.n})` };
  return { factor: 1, basis: 'price-derived (no cost_usd rows to anchor on)' };
}

// --- Collection: transcripts -> per-model inputs --------------------------------------
//
// A track is one run of requests on one model inside one transcript (a /model
// switch mid-session starts a new track with the context it had). steps:
//   inc[i]   context growth since the previous request of the same compaction
//            epoch (0 for the first request, and for the first request after a
//            real compaction, whose growth the replay cannot know)
//   idle[i]  1 when that request rewrote an expired cache (cause 'idle-expiry')
//   ttl1h[i] 1 when the cache TTL that applied was 1h
export function emptyModelInput(model) {
  return {
    model,
    requests: 0, mainRequests: 0, subagentRequests: 0,
    mainTurns: 0,
    tracks: [],
    compactions: [],
    growth: { sum: 0, n: 0 },
    idleExpiries: 0,
    ttl1hSteps: 0,
    money: { input: 0, output: 0, read: 0, write5m: 0, write1h: 0, rewrite: { 'idle-expiry': 0, compaction: 0, 'prefix-change': 0 } },
  };
}

function moneyOf(usage, price) {
  const w1 = usage.cacheWrite1h || 0;
  const w5 = Math.max(0, (usage.cacheWrite || 0) - w1);
  return {
    input: (usage.input || 0) * price.inUsd,
    output: (usage.output || 0) * price.inUsd * price.outRatio,
    read: (usage.cacheRead || 0) * price.r * price.inUsd,
    write5m: w5 * price.w5 * price.inUsd,
    write1h: w1 * price.w1 * price.inUsd,
  };
}

// Folds one readTranscript() result into `models` (Map model -> input) and
// `spawns` (array). inWindow(ts) limits what counts.
export function foldTranscript(res, { models, spawns, inWindow = () => true }) {
  const kind = res.file.kind === 'main' ? 'main' : 'subagent';
  const gapByIndex = new Map(gapsOf(res.requests).map((g) => [g.index, g]));
  const get = (m) => { if (!models.has(m)) models.set(m, emptyModelInput(m)); return models.get(m); };

  let track = null;
  let prev = null;
  for (const r of res.requests) {
    if (r.duplicate || !inWindow(r.startTs)) continue;
    const model = r.model || '(no model)';
    const mi = get(model);
    const g = gapByIndex.get(r.index) || null;
    mi.requests += 1;
    if (kind === 'main') {
      mi.mainRequests += 1;
      if (g && (g.via === 'prompt' || g.via === 'message')) mi.mainTurns += 1;
    } else mi.subagentRequests += 1;

    const price = priceSpecFor(model);
    if (price) {
      const mo = moneyOf(r.usage, price);
      for (const k of ['input', 'output', 'read', 'write5m', 'write1h']) mi.money[k] += mo[k];
      if (g && g.outcome === 'rewrite' && g.cause) {
        mi.money.rewrite[g.cause] += (g.cacheWrite || 0) * (g.ttl === '1h' ? price.w1 : price.w5) * price.inUsd;
      }
    }

    const ttl1h = g ? (g.ttl === '1h' ? 1 : 0) : (kind === 'main' ? 1 : 0);
    const idle = g && g.cause === 'idle-expiry' ? 1 : 0;
    if (idle) mi.idleExpiries += 1;
    if (ttl1h) mi.ttl1hSteps += 1;
    if (!track || track.model !== model) {
      track = { model, kind, start: r.contextTokens, inc: [0], idle: [idle], ttl1h: [ttl1h] };
      mi.tracks.push(track);
    } else {
      const sameEpoch = prev && r.compactionsBefore === prev.compactionsBefore;
      const inc = sameEpoch ? r.contextTokens - prev.contextTokens : 0;
      if (sameEpoch) { mi.growth.sum += inc; mi.growth.n += 1; }
      track.inc.push(inc);
      track.idle.push(idle);
      track.ttl1h.push(ttl1h);
    }
    prev = r;
  }

  for (const c of res.compactions) {
    if (c.duplicate || !inWindow(c.ts)) continue;
    const model = c.firstRequestAfter?.model || null;
    if (!model) continue;
    get(model).compactions.push({
      kind,
      trigger: c.trigger,
      preTokens: c.preTokens,
      postTokens: c.postTokens,
      firstAfterContext: c.firstRequestAfter.contextTokens,
      firstAfterWrite: c.firstRequestAfter.cacheWrite,
      requestsAfter: c.requestsAfter,
    });
  }

  const sb = spawnBaselineOf(res);
  if (sb && inWindow(sb.ts)) spawns.push(sb);
}

// Scans the corpus and folds every transcript. Returns { models, spawns, scan,
// windowDays, sinceMs, nowMs }.
export async function collectAdvisorInputs({
  root, days = 30, now = new Date(), maxMs = null, workflows = false, crossFileDedup = true,
} = {}) {
  const nowMs = now.getTime();
  const sinceMs = nowMs - days * 86400000;
  const inWindow = (ts) => Number.isFinite(ts) && ts >= sinceMs && ts <= nowMs;
  const models = new Map();
  const spawns = [];
  const scan = await scanCorpus({
    root, sinceMs, maxMs, workflows, crossFileDedup,
    onFile: (res) => foldTranscript(res, { models, spawns, inWindow }),
  });
  return { models, spawns, scan, windowDays: days, sinceMs, nowMs };
}

// --- Parameters of the post-compaction state --------------------------------------------

// P (working size after a compaction), Pw (what its first request rewrote) and
// S (summary size, the compaction call's output), as medians over this
// model's compactions of this kind, falling back to this model's compactions
// of any kind, then every model's of this kind, then every model's. Returns
// null when fewer than MIN_PARAM_SAMPLES exist anywhere.
export function postCompactionParams(model, kind, allInputs) {
  const pick = (list) => list.filter((c) => Number.isFinite(c.firstAfterContext) && c.firstAfterContext > 0);
  const own = pick(allInputs.get(model)?.compactions || []);
  const everyone = pick([...allInputs.values()].flatMap((m) => m.compactions));
  const tiers = [
    [own.filter((c) => c.kind === kind), 'this model, this kind'],
    [own, 'this model'],
    [everyone.filter((c) => c.kind === kind), 'all models, this kind'],
    [everyone, 'all models'],
  ];
  for (const [list, source] of tiers) {
    if (list.length >= MIN_PARAM_SAMPLES) {
      return {
        P: median(list.map((c) => c.firstAfterContext)),
        Pw: median(list.map((c) => c.firstAfterWrite || 0)),
        S: median(list.map((c) => c.postTokens || 0)),
        n: list.length,
        source,
      };
    }
  }
  return null;
}

// --- The replay -------------------------------------------------------------------------

// Replays one track with compaction at threshold T. Costs are in input-token
// equivalents (multiply by the input price for dollars). Returns
// { cost, compactions, steps }.
export function replayTrack(track, T, { P, Pw, S, r, w5, w1, outRatio }) {
  let C = track.start;
  let cost = 0;
  let compactions = 0;
  const n = track.inc.length;
  for (let i = 0; i < n; i++) {
    if (i > 0) C = Math.max(0, C + track.inc[i]);
    const w = track.ttl1h[i] ? w1 : w5;
    if (C >= T) {
      compactions += 1;
      cost += C * r + S * outRatio + Pw * (w - r);
      C = P;
    }
    cost += C * (track.idle[i] ? w : r);
  }
  return { cost, compactions, steps: n };
}

// Peak context a track would reach if it never compacted.
export function uncompactedPeak(track) {
  let C = track.start;
  let peak = C;
  for (let i = 1; i < track.inc.length; i++) { C = Math.max(0, C + track.inc[i]); if (C > peak) peak = C; }
  return peak;
}

export function closedFormWindow({ P, Pw, S, r, wMean, outRatio, g, lambda }) {
  if (!(g > 0) || !(r > 0)) return null;
  const R = r + lambda * (wMean - r);
  const k0 = S * outRatio + Pw * (wMean - r);
  return P + Math.sqrt((2 * g * (k0 + r * P)) / R);
}

export function candidateWindows(spec, cfg = compactionConfig()) {
  const { min, max, step } = cfg.window;
  const top = Math.min(max, spec.contextWindow);
  const out = [];
  for (let w = min; w <= top; w += step) out.push(w);
  if (!out.includes(spec.defaultCompactAt) && spec.defaultCompactAt <= top) out.push(spec.defaultCompactAt);
  return out.sort((a, b) => a - b);
}

// The threshold a window setting gives this model: capped at its context
// window, and a window at or above its tuned default behaves as the default.
export const thresholdFor = (window, spec) => Math.min(window, spec.contextWindow, spec.defaultCompactAt);

// Evaluates one model. opts: { cfg, calibration, configured (tokens|null),
// minRequests (500), minTracksReaching (3), requestsPerTurnPooled }.
export function evaluateModel(mi, allInputs, opts = {}) {
  const cfg = opts.cfg || compactionConfig();
  const minRequests = opts.minRequests ?? 500;
  const minTracksReaching = opts.minTracksReaching ?? 3;
  const minTurns = opts.minTurnsPerCompaction ?? cfg.minTurnsPerCompaction ?? 10;
  const spec = windowSpecFor(mi.model, cfg);
  const price = priceSpecFor(mi.model);
  const anchor = anchorFor(mi.model, opts.calibration);
  const base = {
    model: mi.model,
    alias: price?.alias || spec.alias || null,
    contextWindow: spec.contextWindow,
    defaultCompactAt: spec.defaultCompactAt,
    requests: mi.requests,
    mainRequests: mi.mainRequests,
    subagentRequests: mi.subagentRequests,
    tracks: mi.tracks.length,
    compactionsObserved: mi.compactions.length,
    autoCompactionPreTokens: mi.compactions.filter((c) => c.trigger === 'auto' && c.preTokens != null).map((c) => c.preTokens),
    moneyBasis: anchor.basis,
    anchorFactor: anchor.factor,
  };
  const minWin = cfg.window.min;
  const peaks = mi.tracks.map(uncompactedPeak);
  base.tracksReaching = peaks.filter((p) => p >= minWin).length;
  base.uncompactedPeakP90 = percentile([...peaks].sort((a, b) => a - b), 90);

  if (!price) return { ...base, status: 'unpriced', reason: 'no price in config/model-pricing.json' };
  if (mi.requests < minRequests) return { ...base, status: 'insufficient-data', reason: `${mi.requests} requests (< ${minRequests})` };
  if (base.tracksReaching === 0) {
    return { ...base, status: 'window-insensitive', reason: `no session grew past ${Math.round(minWin / 1000)}K, so no window setting changes its cost` };
  }
  if (base.tracksReaching < minTracksReaching) {
    return { ...base, status: 'insufficient-data', reason: `only ${base.tracksReaching} session(s) grew past ${Math.round(minWin / 1000)}K (< ${minTracksReaching})` };
  }
  const params = {};
  for (const kind of new Set(mi.tracks.map((t) => t.kind))) {
    const p = postCompactionParams(mi.model, kind, allInputs);
    if (!p) return { ...base, status: 'insufficient-data', reason: `fewer than ${MIN_PARAM_SAMPLES} compactions anywhere to measure the post-compaction size` };
    params[kind] = p;
  }
  const requestsPerTurn = mi.mainTurns >= 10 ? mi.mainRequests / mi.mainTurns : (opts.requestsPerTurnPooled || null);
  const minRequestsPerCompaction = requestsPerTurn ? minTurns * requestsPerTurn : null;

  const pOf = (kind) => ({ ...params[kind], r: price.r, w5: price.w5, w1: price.w1, outRatio: price.outRatio });
  const maxP = Math.max(...Object.values(params).map((p) => p.P));
  const usdOf = (units) => units * price.inUsd * anchor.factor;
  const replayAt = (T) => {
    let units = 0;
    let compactions = 0;
    let stepsInCompacting = 0;
    for (const t of mi.tracks) {
      const x = replayTrack(t, T, pOf(t.kind));
      units += x.cost;
      compactions += x.compactions;
      if (x.compactions) stepsInCompacting += x.steps;
    }
    const requestsPerCompaction = compactions ? stepsInCompacting / compactions : null;
    return { usd: usdOf(units), compactions, requestsPerCompaction };
  };

  const curve = [];
  for (const W of candidateWindows(spec, cfg)) {
    const T = thresholdFor(W, spec);
    if (T <= maxP) { curve.push({ window: W, threshold: T, feasible: false }); continue; }
    const x = replayAt(T);
    const turnsPerCompaction = x.requestsPerCompaction != null && requestsPerTurn ? x.requestsPerCompaction / requestsPerTurn : null;
    const allowed = x.requestsPerCompaction == null || minRequestsPerCompaction == null || x.requestsPerCompaction >= minRequestsPerCompaction;
    curve.push({ window: W, threshold: T, feasible: true, usd: x.usd, compactions: x.compactions, requestsPerCompaction: x.requestsPerCompaction, turnsPerCompaction, allowed });
  }
  const feasible = curve.filter((c) => c.feasible);
  const allowed = feasible.filter((c) => c.allowed);
  const best = (list) => list.reduce((a, b) => (b.usd < a.usd ? b : a), list[0]);
  const optimum = allowed.length ? best(allowed) : null;
  const unconstrained = feasible.length ? best(feasible) : null;
  const atDefault = feasible.find((c) => c.threshold === spec.defaultCompactAt) || null;
  const configuredT = opts.configured ? thresholdFor(opts.configured, spec) : null;
  const atConfigured = configuredT ? (configuredT > maxP ? { window: opts.configured, threshold: configuredT, ...replayAt(configuredT) } : null) : null;
  const band = (pct) => {
    if (!optimum) return null;
    const inside = allowed.filter((c) => c.usd <= optimum.usd * (1 + pct / 100)).map((c) => c.window);
    return [Math.min(...inside), Math.max(...inside)];
  };

  // Closed-form cross-check, with the main-kind parameters when there are any.
  const pk = params.main || Object.values(params)[0];
  const steps = mi.tracks.reduce((a, t) => a + t.inc.length, 0);
  const lambda = steps ? mi.idleExpiries / steps : 0;
  const wMean = steps ? (mi.ttl1hSteps * price.w1 + (steps - mi.ttl1hSteps) * price.w5) / steps : price.w5;
  const g = mi.growth.n ? mi.growth.sum / mi.growth.n : 0;
  const closedForm = closedFormWindow({ P: pk.P, Pw: pk.Pw, S: pk.S, r: price.r, wMean, outRatio: price.outRatio, g, lambda });

  const cacheUsd = (mi.money.read + mi.money.write5m + mi.money.write1h) * anchor.factor;
  const saving = (ref) => (ref && optimum ? { usd: ref.usd - optimum.usd, pctOfWindowCost: ref.usd ? ((ref.usd - optimum.usd) / ref.usd) * 100 : null, pctOfCacheSpend: cacheUsd ? ((ref.usd - optimum.usd) / cacheUsd) * 100 : null } : null);

  return {
    ...base,
    status: optimum ? 'ok' : 'no-allowed-window',
    reason: optimum ? null : `every feasible window compacts more often than once per ${minTurns} turns`,
    params: {
      byKind: params,
      growthPerRequestMean: g,
      idleExpiryRate: lambda,
      writeMultiplierMean: wMean,
      requestsPerTurn,
      minRequestsPerCompaction,
      readMultiplier: price.r,
    },
    curve,
    optimum: optimum && { window: optimum.window, usd: optimum.usd, compactions: optimum.compactions, turnsPerCompaction: optimum.turnsPerCompaction },
    unconstrainedOptimum: unconstrained && { window: unconstrained.window, usd: unconstrained.usd, compactions: unconstrained.compactions, turnsPerCompaction: unconstrained.turnsPerCompaction },
    band1: band(1),
    band5: band(5),
    atDefault: atDefault && { window: atDefault.window, usd: atDefault.usd, compactions: atDefault.compactions },
    atConfigured: atConfigured && { window: atConfigured.window, usd: atConfigured.usd, compactions: atConfigured.compactions },
    savingVsDefault: saving(atDefault),
    savingVsConfigured: saving(atConfigured),
    closedFormWindow: closedForm,
    cacheUsd,
  };
}

// The one setting across the model mix: for each window on the common grid,
// the sum of every evaluated model's replayed cost at that window (a model
// whose context window is smaller runs at its own cap). Models that are not
// 'ok' do not vote. weights (alias -> factor) gives the plan-usage view.
export function combineModels(evaluated, { cfg = compactionConfig(), weights = null } = {}) {
  const voters = evaluated.filter((e) => e.status === 'ok');
  if (!voters.length) return null;
  const { min, max, step } = cfg.window;
  const grid = [];
  for (let w = min; w <= max; w += step) grid.push(w);
  const costAt = (e, W) => {
    const T = thresholdFor(W, { contextWindow: e.contextWindow, defaultCompactAt: e.defaultCompactAt });
    const pt = e.curve.find((c) => c.threshold === T && c.feasible);
    return pt || null;
  };
  const rows = [];
  for (const W of grid) {
    let usd = 0;
    let ok = true;
    let allowed = true;
    for (const e of voters) {
      const pt = costAt(e, W);
      if (!pt) { ok = false; break; }
      const wt = weights ? (weights[e.alias] ?? 1) : 1;
      usd += pt.usd * wt;
      if (!pt.allowed) allowed = false;
    }
    if (ok) rows.push({ window: W, usd, allowed });
  }
  const allowedRows = rows.filter((r) => r.allowed);
  if (!allowedRows.length) return { voters: voters.map((e) => e.model), optimum: null, rows };
  const opt = allowedRows.reduce((a, b) => (b.usd < a.usd ? b : a), allowedRows[0]);
  const band = (pct) => {
    const inside = allowedRows.filter((r) => r.usd <= opt.usd * (1 + pct / 100)).map((r) => r.window);
    return [Math.min(...inside), Math.max(...inside)];
  };
  const top = rows[rows.length - 1];
  return {
    voters: voters.map((e) => e.model),
    optimum: { window: opt.window, usd: opt.usd },
    band1: band(1),
    band5: band(5),
    atMax: top ? { window: top.window, usd: top.usd } : null,
    rows,
  };
}

// --- Spawn overhead and where the money goes ----------------------------------------------

export function spawnOverhead(spawns, { days, calibration } = {}) {
  const by = new Map();
  for (const s of spawns) {
    const k = s.agentType || '(unknown)';
    if (!by.has(k)) by.set(k, { agentType: k, count: 0, usd: [], context: [], models: {} });
    const e = by.get(k);
    const p = priceUsage({ input: s.input, output: 0, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, cacheWrite1h: s.cacheWrite1h }, s.model);
    e.count += 1;
    e.context.push(s.contextTokens);
    e.models[s.model || '(no model)'] = (e.models[s.model || '(no model)'] || 0) + 1;
    if (p) e.usd.push(p.usd * anchorFor(s.model, calibration).factor);
  }
  const rows = [...by.values()].map((e) => {
    const usd = [...e.usd].sort((a, b) => a - b);
    const ctx = [...e.context].sort((a, b) => a - b);
    const total = usd.reduce((a, b) => a + b, 0);
    return {
      agentType: e.agentType,
      count: e.count,
      perDay: days ? e.count / days : null,
      contextP50: percentile(ctx, 50),
      contextP90: percentile(ctx, 90),
      usdP50: percentile(usd, 50),
      usdP90: percentile(usd, 90),
      usdPerDay: days ? total / days : null,
      unpriced: e.count - e.usd.length,
      models: e.models,
    };
  }).sort((a, b) => (b.usdPerDay || 0) - (a.usdPerDay || 0));
  const allCtx = spawns.map((s) => s.contextTokens).sort((a, b) => a - b);
  const totalPerDay = rows.reduce((a, r) => a + (r.usdPerDay || 0), 0);
  return { rows, spawns: spawns.length, perDay: days ? spawns.length / days : null, contextP50: percentile(allCtx, 50), contextP90: percentile(allCtx, 90), usdPerDay: totalPerDay };
}

export function whereMoneyGoes(mi, calibration) {
  const f = anchorFor(mi.model, calibration).factor;
  const m = mi.money;
  const cache = (m.read + m.write5m + m.write1h) * f;
  const pct = (x) => (cache ? (x * f * 100) / cache : null);
  return {
    model: mi.model,
    cacheUsd: cache,
    readUsd: m.read * f,
    write5mUsd: m.write5m * f,
    write1hUsd: m.write1h * f,
    idleExpiryRewriteUsd: m.rewrite['idle-expiry'] * f,
    compactionRewriteUsd: m.rewrite.compaction * f,
    prefixChangeRewriteUsd: m.rewrite['prefix-change'] * f,
    pct: {
      read: pct(m.read), write5m: pct(m.write5m), write1h: pct(m.write1h),
      idleExpiryRewrite: pct(m.rewrite['idle-expiry']), compactionRewrite: pct(m.rewrite.compaction), prefixChangeRewrite: pct(m.rewrite['prefix-change']),
    },
    uncachedInputUsd: m.input * f,
    outputUsd: m.output * f,
  };
}

// --- The whole advice --------------------------------------------------------------------

export function adviseFromInputs(inputs, {
  cfg = compactionConfig(), calibration = { pooled: { n: 0 }, perModel: {} }, configured = { tokens: null, source: 'unset' },
  minRequests, minTracksReaching, minTurnsPerCompaction,
} = {}) {
  const models = inputs.models;
  let turns = 0;
  let mainReq = 0;
  for (const m of models.values()) { turns += m.mainTurns; mainReq += m.mainRequests; }
  const requestsPerTurnPooled = turns >= 10 ? mainReq / turns : null;
  const evaluated = [...models.values()]
    .filter((m) => m.model !== '(no model)')
    .sort((a, b) => b.requests - a.requests)
    .map((m) => evaluateModel(m, models, {
      cfg, calibration, configured: configured.tokens, requestsPerTurnPooled, minRequests, minTracksReaching, minTurnsPerCompaction,
    }));
  const global = combineModels(evaluated, { cfg });
  const planWeights = cfg.planUsage?.weights || null;
  const globalPlan = planWeights && Object.keys(planWeights).length ? combineModels(evaluated, { cfg, weights: planWeights }) : null;
  const configuredGlobal = global && configured.tokens
    ? (() => {
      let usd = 0;
      for (const e of evaluated.filter((x) => x.status === 'ok')) {
        const T = thresholdFor(configured.tokens, e);
        const pt = e.curve.find((c) => c.threshold === T && c.feasible);
        if (!pt) return null;
        usd += pt.usd;
      }
      return { window: configured.tokens, usd };
    })()
    : null;
  return {
    generatedAt: new Date(inputs.nowMs).toISOString(),
    windowDays: inputs.windowDays,
    scan: inputs.scan && {
      filesFound: inputs.scan.filesFound, filesRead: inputs.scan.filesRead, filesSkipped: inputs.scan.filesSkipped,
      truncated: inputs.scan.truncated, wallMs: inputs.scan.wallMs, rootExists: inputs.scan.exists,
    },
    configured,
    calibration,
    requestsPerTurnPooled,
    minTurnsPerCompaction: minTurnsPerCompaction ?? cfg.minTurnsPerCompaction,
    models: evaluated,
    global: global && { ...global, configured: configuredGlobal },
    globalPlanUsage: globalPlan && { asOf: cfg.planUsage.asOf, weights: planWeights, optimum: globalPlan.optimum, band5: globalPlan.band5 },
    moneyByModel: [...models.values()].filter((m) => priceSpecFor(m.model)).sort((a, b) => b.requests - a.requests).map((m) => whereMoneyGoes(m, calibration)),
    spawnOverhead: spawnOverhead(inputs.spawns, { days: inputs.windowDays, calibration }),
  };
}

export async function runCacheAdvisor({
  root, days = 30, now = new Date(), maxMs = null, workflows = false, resultsRoot, env, settingsPath,
  minRequests, minTracksReaching, minTurnsPerCompaction,
} = {}) {
  const inputs = await collectAdvisorInputs({ root, days, now, maxMs, workflows });
  const calibration = calibrate(resultsRoot ? { resultsRoot } : {});
  const configured = configuredWindow({ ...(env ? { env } : {}), ...(settingsPath ? { settingsPath } : {}) });
  return adviseFromInputs(inputs, { calibration, configured, minRequests, minTracksReaching, minTurnsPerCompaction });
}

// --- The saved summary (numbers and model ids only) -----------------------------------------

export function summaryOf(advice) {
  return {
    generatedAt: advice.generatedAt,
    windowDays: advice.windowDays,
    truncated: !!advice.scan?.truncated,
    configured: advice.configured?.tokens ?? null,
    global: advice.global?.optimum ? { window: advice.global.optimum.window, band5: advice.global.band5 } : null,
    models: Object.fromEntries(advice.models.map((e) => [e.model, {
      status: e.status,
      window: e.optimum?.window ?? null,
      band5: e.band5 ?? null,
      requests: e.requests,
    }])),
  };
}

export function saveAdvisorSummary(advice, dir = stateDir()) {
  const path = join(dir, ADVISOR_SUMMARY_FILE);
  writeFileSync(path, `${JSON.stringify(summaryOf(advice), null, 2)}\n`);
  return path;
}

export function loadAdvisorSummary(dir = stateDir()) {
  try { return JSON.parse(readFileSync(join(dir, ADVISOR_SUMMARY_FILE), 'utf8')); } catch { return null; }
}

// The summary's line for a routing alias (opus, sonnet, haiku, fable): the
// busiest model id containing that alias that has a recommendation.
export function windowHintFor(summary, alias) {
  if (!summary || !alias) return null;
  const cands = Object.entries(summary.models || {})
    .filter(([id, m]) => id.toLowerCase().includes(String(alias).toLowerCase()) && m.status === 'ok' && m.window)
    .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0));
  const global = summary.global?.window || null;
  if (!cands.length && !global) return null;
  const [id, m] = cands[0] || [null, null];
  return { model: id, window: m?.window ?? null, band5: m?.band5 ?? null, global, configured: summary.configured, generatedAt: summary.generatedAt };
}

// --- The human report (the CLI prints it; the audit check reuses parts) --------------------

export function formatAdvice(a, { curve = false } = {}) {
  const out = [];
  const K = (x) => (x == null ? 'n/a' : `${Math.round(x / 1000)}K`);
  const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(2)}`);
  const pct = (x) => (x == null ? 'n/a' : `${x.toFixed(1)}%`);
  const s = a.scan || {};
  out.push(`cache-advisor — last ${a.windowDays}d (${a.generatedAt})`);
  out.push(`files: ${s.filesRead} read of ${s.filesFound}${s.truncated ? ` — TRUNCATED by the time budget (${s.filesSkipped} older files skipped)` : ''}, ${((s.wallMs || 0) / 1000).toFixed(1)}s`);
  const cal = a.calibration;
  out.push(cal?.pooled?.n
    ? `money: price table checked against bench cost_usd (n=${cal.pooled.n}, writes priced ${cal.assumption}): median ratio ${cal.pooled.ratio.toFixed(3)} (p10 ${cal.pooled.p10.toFixed(3)}, p90 ${cal.pooled.p90.toFixed(3)})`
    : 'money: price-derived only (no bench cost_usd rows to check against)');
  out.push(`configured window: ${a.configured.tokens ? K(a.configured.tokens) : 'unset'} (${a.configured.source})`);
  out.push('');

  out.push('-- auto-compact window per model (replayed on your transcripts) --');
  for (const e of a.models) {
    if (e.status !== 'ok') {
      out.push(`  ${e.model.padEnd(28)} ${e.status}: ${e.reason || ''} (${e.requests} requests)`);
      continue;
    }
    out.push(`  ${e.model.padEnd(28)} optimum ${K(e.optimum.window)}  within 1%: ${K(e.band1[0])}-${K(e.band1[1])}  within 5%: ${K(e.band5[0])}-${K(e.band5[1])}  `
      + `closed form ${K(e.closedFormWindow)}  (${e.requests} requests, ${e.tracksReaching} sessions past ${K(100000)})`);
    const d = e.savingVsDefault;
    const c = e.savingVsConfigured;
    out.push(`  ${''.padEnd(28)} vs default ${K(e.defaultCompactAt)}: saves ${usd(d?.usd)} (${pct(d?.pctOfCacheSpend)} of its cache spend)`
      + `${c ? `; vs configured ${K(a.configured.tokens)}: saves ${usd(c.usd)} (${pct(c.pctOfCacheSpend)})` : ''}`
      + `; compactions at optimum ${e.optimum.compactions}, about every ${e.optimum.turnsPerCompaction == null ? 'n/a' : e.optimum.turnsPerCompaction.toFixed(0)} turns`);
    if (e.unconstrainedOptimum && e.unconstrainedOptimum.window !== e.optimum.window) {
      out.push(`  ${''.padEnd(28)} (cheapest ignoring the ${a.minTurnsPerCompaction}-turn floor: ${K(e.unconstrainedOptimum.window)}, about every ${e.unconstrainedOptimum.turnsPerCompaction?.toFixed(0)} turns)`);
    }
    if (curve) {
      for (const p of e.curve.filter((x) => x.feasible)) {
        out.push(`      ${K(p.window).padStart(6)} ${usd(p.usd).padStart(12)} compactions ${String(p.compactions).padStart(4)}${p.allowed ? '' : '  (below the turn floor)'}`);
      }
    }
  }
  out.push('');
  if (a.global?.optimum) {
    const g = a.global;
    out.push(`-- one setting for your model mix (autoCompactWindow is global) --`);
    out.push(`  cheapest: ${K(g.optimum.window)}  within 1%: ${K(g.band1[0])}-${K(g.band1[1])}  within 5%: ${K(g.band5[0])}-${K(g.band5[1])}  (voters: ${g.voters.join(', ')})`);
    if (g.configured) out.push(`  at configured ${K(g.configured.window)}: ${usd(g.configured.usd - g.optimum.usd)} more than the cheapest over ${a.windowDays}d`);
    if (g.atMax) out.push(`  at ${K(g.atMax.window)} (each model's default): ${usd(g.atMax.usd - g.optimum.usd)} more than the cheapest over ${a.windowDays}d`);
    if (a.globalPlanUsage?.optimum) out.push(`  plan-usage view (weights as of ${a.globalPlanUsage.asOf}, may be introductory): cheapest ${K(a.globalPlanUsage.optimum.window)}, within 5%: ${K(a.globalPlanUsage.band5[0])}-${K(a.globalPlanUsage.band5[1])}`);
    out.push(`  advice only — to apply it, run /autocompact ${Math.round(g.optimum.window / 1000)}k in Claude Code`);
  } else {
    out.push('-- one setting for your model mix -- no model had enough data to vote');
  }
  out.push('');

  out.push('-- where the cache money goes (per model) --');
  for (const m of a.moneyByModel) {
    if (!m.cacheUsd) continue;
    out.push(`  ${m.model.padEnd(28)} cache ${usd(m.cacheUsd).padStart(11)}: reads ${pct(m.pct.read)}, 5m writes ${pct(m.pct.write5m)}, 1h writes ${pct(m.pct.write1h)}; `
      + `of the writes, idle-expiry rewrites ${pct(m.pct.idleExpiryRewrite)}, compaction rewrites ${pct(m.pct.compactionRewrite)}, prefix-change rewrites ${pct(m.pct.prefixChangeRewrite)}`);
  }
  out.push('');

  const so = a.spawnOverhead;
  out.push(`-- spawn overhead (first request of each subagent, cold) -- ${so.spawns} spawns, ${so.perDay?.toFixed(1)}/day, context p50 ${K(so.contextP50)} p90 ${K(so.contextP90)}, ${usd(so.usdPerDay)}/day`);
  for (const r of so.rows.slice(0, 15)) {
    out.push(`  ${r.agentType.padEnd(36)} n=${String(r.count).padEnd(5)} ${r.perDay.toFixed(1).padStart(6)}/day  context p50 ${K(r.contextP50).padStart(5)} p90 ${K(r.contextP90).padStart(5)}  `
      + `cost p50 ${usd(r.usdP50)} p90 ${usd(r.usdP90)}  ${usd(r.usdPerDay)}/day`);
  }
  if (so.rows.length > 15) out.push(`  … ${so.rows.length - 15} more (--json for all)`);
  out.push('');
  out.push('Not priced: the detail a compaction loses and the minutes it takes. Numbers are advice; nothing was changed.');
  return out;
}
