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
// capped at each model's context window. A set window W does NOT compact at W:
// it compacts at min(W, context window) - min(max output, 20K) - 13K, i.e.
// W - 33K for every current model (Claude Code 2.1.280; real compactions at
// about 967K on 1M models and 167K-174K on 200K models agree). Unset, a model
// compacts at its default threshold (config/compaction.json: about 967K on
// native-1M models, about 167K on 200K models). So the advice has two parts:
// the per-model optimum, and the one value that is cheapest across the
// operator's actual model mix (the sum of every model's cost at that value).
// Every window in the output is the value to TYPE (the setting), and the
// compaction point it gives is printed beside it.
//
// What is in effect is resolved the way Claude Code resolves it
// (configuredWindow): the environment variable first, then settings (managed,
// local, project, user; a value that fails the settings schema — anything but
// an integer from 100000 to 1000000 — is dropped silently by Claude Code, and
// loudly here), then the model's default.
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
// (W here is the compaction point; the setting that gives it is W + reserve.)
//
// What is NOT priced: the detail compaction loses, and the minutes a
// compaction takes. The advisor never recommends a window that would compact
// more often than once every minTurnsPerCompaction turns (config), measured
// with each model's own requests per turn. For the one global value the floor
// binds the model MIX, and every model that would still compact more often
// than the floor at that value gets its own warning line.
//
// Rework (extra context growth in the 50 requests after a compaction over the
// 50 before) is priced; the whole evaluation is repeated with rework 0 and
// printed beside it, so the reader sees how far the answer leans on it.
//
// --- Money ------------------------------------------------------------------
//
// Every dollar is tokens x API LIST PRICE from config/model-pricing.json. On a
// subscription plan these dollars are notional; they rank windows, they are
// not a bill. calibrate() is a CHECK of the price table, not an anchor: it
// prices the benchmark rows' tokens and compares them with those rows'
// cost_usd, which is Claude Code's own figure computed from the same list
// prices, so a ratio of 1.000 only says the two price tables agree. Nothing is
// scaled by it; a ratio off by more than 2% is printed as a warning. Plan
// usage (subscription limits) is a dated secondary view with per-model
// weights in config/compaction.json planUsage.
//
// --- Real traffic only ------------------------------------------------------
//
// Benchmark runs (bench/runner.mjs, judge.mjs and rescore.mjs without
// isolate_home) write headless sessions under a project directory named after
// their mkdtemp working directory in the OS temp dir (bench-*, rescore-*).
// Those are synthetic tasks, and a headless run has no counted turn, which
// inflates requests per turn. isBenchProject() excludes them before reading;
// the report says how many were left out.

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanCorpus, gapsOf, spawnBaselineOf, percentile } from './transcripts.mjs';
import { pricingTable, classifyPricing, priceUsage } from './pricing.mjs';
import { stateRoot, stateDir, claudeDir, dataDir, writeJsonAtomic } from '../../hooks/lib/context.mjs';

export const ADVISOR_SUMMARY_FILE = 'cache-advisor.json';
const MIN_PARAM_SAMPLES = 3;

// --- Config --------------------------------------------------------------------

let _cfg = null;
export function compactionConfig() {
  if (_cfg) return _cfg;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'compaction.json');
  let cfg = {
    models: {}, unknownModel: { contextWindow: 200000, defaultCompactAt: 167000 }, compactReserve: { outputCap: 20000, buffer: 13000 },
    window: { min: 100000, max: 1000000, step: 25000 }, minTurnsPerCompaction: 10, planUsage: { weights: {} },
  };
  try { cfg = { ...cfg, ...JSON.parse(readFileSync(shipped, 'utf8')) }; } catch { /* use defaults */ }
  let local = null;
  try { local = JSON.parse(readFileSync(join(stateRoot(), 'compaction.json'), 'utf8')); } catch { /* none: expected */ }
  if (local) cfg = { ...cfg, ...local, models: { ...(cfg.models || {}), ...(local.models || {}) } };
  _cfg = cfg;
  return _cfg;
}
export function _resetCompactionConfigForTests() { _cfg = null; }

// How far below the set window a model compacts: min(maxOutput, outputCap) +
// buffer (33K for every current model).
function reserveOf(spec, cfg) {
  const r = cfg.compactReserve || { outputCap: 20000, buffer: 13000 };
  return Math.min(spec.maxOutput ?? Infinity, r.outputCap) + r.buffer;
}

// { alias, contextWindow, defaultCompactAt, reserve, known }
export function windowSpecFor(model, cfg = compactionConfig()) {
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.models || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      const reserve = reserveOf(spec, cfg);
      return { alias, contextWindow: spec.contextWindow, defaultCompactAt: spec.defaultCompactAt ?? spec.contextWindow - reserve, reserve, known: true };
    }
  }
  const u = cfg.unknownModel || { contextWindow: 200000 };
  const reserve = reserveOf(u, cfg);
  return { alias: '', contextWindow: u.contextWindow, defaultCompactAt: u.defaultCompactAt ?? u.contextWindow - reserve, reserve, known: false };
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

// --- The window in effect (read-only) ----------------------------------------------

export const WINDOW_MIN = 100000;
export const WINDOW_MAX = 1000000;

// "400k", "1M", 400000, "400000" -> tokens; anything else -> null. A bare
// number from 100 to 1000 means thousands, as /autocompact and the
// --autocompact flag read it. NOT how settings.json is read: see
// settingsWindowValid.
export function parseWindow(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >= 100 && v <= 1000 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2]) return Math.round(n * (/m/i.test(m[2]) ? 1e6 : 1e3));
  return n >= 100 && n <= 1000 ? n * 1000 : n;
}

// The settings schema Claude Code applies to autoCompactWindow (2.1.280:
// number().int().min(100000).max(1000000).optional().catch(undefined)). A value
// that fails it — the string "400k", a bare 400, 250000.5 — is replaced by
// undefined without a word, and the next source (or the default) applies.
export function settingsWindowValid(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= WINDOW_MIN && v <= WINDOW_MAX;
}

// Claude Code's integer parse of an environment value (2.1.280): trimmed;
// scientific notation ("5e5") and thousands separators ("500,000", "500_000")
// are read as whole numbers; anything else goes through parseInt, so "500k"
// reads as 500.
export function parseEnvInt(raw) {
  const s = String(raw).trim();
  if (s.length <= 32) {
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(s)) { const n = Number(s); return Number.isInteger(n) ? n : NaN; }
    if (/^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(s)) return parseInt(s.replace(/[_,\u00A0\u202F ]/g, ''), 10);
  }
  return parseInt(s, 10);
}

// CLAUDE_CODE_AUTO_COMPACT_WINDOW as Claude Code applies it: not a number or
// <= 0 is invalid and ignored (settings then apply); above 1M is capped at 1M;
// below 100K is raised to 100K (docs, env-vars: "a value like 500k reads as 500
// and clamps to the 100K minimum").
export function envWindow(raw) {
  const n = parseEnvInt(raw);
  if (Number.isNaN(n) || n <= 0) return { tokens: null, parsed: n, status: 'invalid' };
  const tokens = Math.max(WINDOW_MIN, Math.min(n, WINDOW_MAX));
  return { tokens, parsed: n, status: tokens === n ? 'valid' : 'clamped' };
}

// Where Claude Code reads managed-settings.json (2.1.280). MDM, registry and
// server-managed policy are not read here.
export function managedSettingsPath(plat = platform()) {
  if (plat === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (plat === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// The window in effect, resolved in Claude Code's order:
//   1. CLAUDE_CODE_AUTO_COMPACT_WINDOW (parsed and clamped as envWindow says;
//      an invalid value is ignored);
//   2. the --autocompact flag — per process, so a running session's flag cannot
//      be seen from here; used only when the caller passes `flag`;
//   3. settings, highest precedence first: managed, local project, shared
//      project (only when projectDir is given: project settings differ per
//      project), user. A value failing the schema is skipped, as Claude Code
//      skips it, and listed in `ignored` so the report can say so loudly;
//   4. otherwise null: each model's default.
// Returns { tokens, raw, source, ignored: [{ source, raw, reason }], notes: [],
// autoCompactDisabled: null | where }. Never writes anything.
export function configuredWindow({
  env = process.env, settingsPath = join(claudeDir(), 'settings.json'), projectDir = null,
  managedPath = managedSettingsPath(), flag,
} = {}) {
  const ignored = [];
  const notes = [];
  let result = null;
  const ev = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if (ev != null && ev !== '') {
    const e = envWindow(ev);
    if (e.status === 'invalid') ignored.push({ source: 'env CLAUDE_CODE_AUTO_COMPACT_WINDOW', raw: ev, reason: 'it is not a positive whole number' });
    else {
      if (e.status === 'clamped') notes.push(`CLAUDE_CODE_AUTO_COMPACT_WINDOW="${ev}" reads as ${e.parsed} and is clamped to ${e.tokens}`);
      result = { tokens: e.tokens, raw: ev, source: 'env CLAUDE_CODE_AUTO_COMPACT_WINDOW' };
    }
  }
  if (!result && flag != null) {
    const t = String(flag).trim().toLowerCase() === 'auto' ? 'auto' : parseWindow(flag);
    if (t === 'auto') result = { tokens: null, raw: flag, source: '--autocompact auto' };
    else if (t != null && t >= WINDOW_MIN && t <= WINDOW_MAX) result = { tokens: Math.round(t), raw: flag, source: '--autocompact flag' };
    else ignored.push({ source: '--autocompact flag', raw: flag, reason: 'it must be auto or 100k-1M' });
  }
  const files = [['managed settings', managedPath]];
  if (projectDir) {
    files.push(['local project settings', join(projectDir, '.claude', 'settings.local.json')]);
    files.push(['project settings', join(projectDir, '.claude', 'settings.json')]);
  }
  files.push(['user settings', settingsPath]);
  let disabled = null;
  let enabledDecided = false;
  for (const [source, path] of files) {
    if (!path) continue;
    let s;
    try { s = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; } // absent or unreadable: nothing set there
    if (!s || typeof s !== 'object') continue;
    if (!enabledDecided && typeof s.autoCompactEnabled === 'boolean') {
      enabledDecided = true;
      if (s.autoCompactEnabled === false) disabled = `${source} autoCompactEnabled false`;
    }
    if (s.autoCompactWindow == null) continue;
    if (!settingsWindowValid(s.autoCompactWindow)) {
      ignored.push({ source: `${source} autoCompactWindow`, raw: s.autoCompactWindow, reason: 'it must be an integer from 100000 to 1000000' });
      continue;
    }
    if (!result) result = { tokens: s.autoCompactWindow, raw: s.autoCompactWindow, source: `${source} autoCompactWindow` };
  }
  for (const k of ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT']) {
    const v = env[k];
    if (v && !/^(0|false|no|off)$/i.test(String(v).trim())) disabled = disabled || `env ${k}`;
  }
  return { ...(result || { tokens: null, raw: null, source: 'unset' }), ignored, notes, autoCompactDisabled: disabled };
}

// One loud line per value Claude Code ignores, saying what applies instead.
export function ignoredWindowLines(configured) {
  const instead = configured?.tokens
    ? `${Math.round(configured.tokens / 1000)}K from ${configured.source} applies`
    : "each model's default applies (about 967K on 1M models)";
  return (configured?.ignored || []).map((i) => `your ${i.source} ${JSON.stringify(i.raw)} is IGNORED by Claude Code: ${i.reason}; ${instead}`);
}

// --- Price-table check: bench cost_usd vs list price ---------------------------------

const median = (xs) => percentile([...xs].sort((a, b) => a - b), 50);

// A CHECK, not an anchor (see the header): cost_usd is Claude Code's own
// figure from the same list prices, so a ratio near 1 says the price tables
// agree and nothing more. Nothing is scaled by it.
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

export const MONEY_BASIS = 'API list price';
export const PRICE_CHECK_TOLERANCE = 0.02;

// How a model's list-price dollars were checked: { basis, check, agrees }.
// agrees is null with too few rows, else whether the median ratio is within
// PRICE_CHECK_TOLERANCE of 1.
export function priceCheckFor(model, cal, minRows = 5) {
  const pm = cal?.perModel?.[model];
  const pick = pm && pm.n >= minRows && Number.isFinite(pm.ratio) ? { ...pm, scope: 'this model' }
    : cal?.pooled?.n >= minRows && Number.isFinite(cal.pooled.ratio) ? { ...cal.pooled, scope: 'pooled' } : null;
  if (!pick) return { basis: MONEY_BASIS, check: 'price table not checked (no bench cost_usd rows)', agrees: null };
  const agrees = Math.abs(pick.ratio - 1) <= PRICE_CHECK_TOLERANCE;
  return {
    basis: MONEY_BASIS,
    check: `Claude Code's cost_usd / list price = ${pick.ratio.toFixed(3)} (${pick.scope}, n=${pick.n})${agrees ? ': the price tables agree' : ': the price table DISAGREES with Claude Code'}`,
    agrees,
  };
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
    observedUnits: 0,
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
export function foldTranscript(res, { models, spawns, inWindow = () => true, reworkRequests = 50 }) {
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
    // What the replay's cost model says this request actually cost, for the
    // fit check: its real context read, or rewritten when the cache expired.
    if (price) mi.observedUnits += r.contextTokens * (idle ? (ttl1h ? price.w1 : price.w5) : price.r);
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

  // Rework: how much more the context grows in the first reworkRequests
  // requests after a compaction than over the same number of requests just
  // before it, in the same transcript (the model re-reads what the summary
  // dropped). Null when either side is too short.
  const own = res.requests.filter((q) => !q.duplicate);
  const epochOf = (n) => own.filter((q) => q.compactionsBefore === n);
  res.compactions.forEach((c, ci) => {
    if (c.duplicate || !inWindow(c.ts)) return;
    const model = c.firstRequestAfter?.model || null;
    if (!model) return;
    const before = epochOf(ci);
    const after = epochOf(ci + 1);
    const K = reworkRequests;
    const last = before.length - 1;
    const reworkTokens = before.length > K && after.length > K
      ? (after[K].contextTokens - after[0].contextTokens) - (before[last].contextTokens - before[last - K].contextTokens)
      : null;
    get(model).compactions.push({
      kind,
      trigger: c.trigger,
      preTokens: c.preTokens,
      postTokens: c.postTokens,
      firstAfterContext: c.firstRequestAfter.contextTokens,
      firstAfterWrite: c.firstRequestAfter.cacheWrite,
      requestsAfter: c.requestsAfter,
      reworkTokens,
      session: `${res.file.project || ''}/${res.file.sessionId || res.file.path}`,
    });
  });

  const sb = spawnBaselineOf(res);
  if (sb && inWindow(sb.ts)) spawns.push(sb);
}

// A project directory is Claude Code's sanitised working directory (every
// character outside [A-Za-z0-9] becomes '-'). The benchmark harness runs its
// headless sessions in mkdtemp directories directly under the OS temp dir:
// bench/runner.mjs "bench-<cell>-<task>-" and "bench-tmp-", bench/judge.mjs
// "bench-judge-", bench/rescore.mjs "rescore-<task>-" (a test pins these
// prefixes to the harness source). A project is a bench project when it is
// this machine's temp dir followed by one of those prefixes, or — for a corpus
// copied from another machine — any temp-like segment (Temp, tmp) followed by
// one.
export const BENCH_DIR_PREFIXES = ['bench-', 'rescore-'];
const sanitiseDir = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');
export function isBenchProject(name, { tmp = tmpdir() } = {}) {
  const n = String(name || '');
  const t = sanitiseDir(tmp);
  if (t && BENCH_DIR_PREFIXES.some((p) => n.toLowerCase().startsWith(`${t}-${p}`.toLowerCase()))) return true;
  return new RegExp(`-(?:temp|tmp)-(?:${BENCH_DIR_PREFIXES.map((p) => p.replace('-', '')).join('|')})-`, 'i').test(n);
}

// Scans the corpus and folds every transcript. Returns { models, spawns, scan,
// windowDays, sinceMs, nowMs, excludedBenchProjects, oldestReadMtimeMs }.
// Bench projects are excluded unless includeBench is set. oldestReadMtimeMs is
// the modification time of the oldest file read: when a time budget cut the
// scan short (newest first), traffic after it is complete and traffic before
// it is only partly read.
export async function collectAdvisorInputs({
  root, days = 30, now = new Date(), maxMs = null, workflows = false, crossFileDedup = true, includeBench = false,
} = {}) {
  const nowMs = now.getTime();
  const sinceMs = nowMs - days * 86400000;
  const inWindow = (ts) => Number.isFinite(ts) && ts >= sinceMs && ts <= nowMs;
  const models = new Map();
  const spawns = [];
  const excluded = new Set();
  let oldestReadMtimeMs = null;
  const project = includeBench ? null : (name) => {
    if (!isBenchProject(name)) return true;
    excluded.add(name);
    return false;
  };
  const scan = await scanCorpus({
    root, sinceMs, maxMs, workflows, crossFileDedup, project,
    onFile: (res, entry) => {
      if (entry && Number.isFinite(entry.mtimeMs) && (oldestReadMtimeMs == null || entry.mtimeMs < oldestReadMtimeMs)) oldestReadMtimeMs = entry.mtimeMs;
      foldTranscript(res, { models, spawns, inWindow });
    },
  });
  return { models, spawns, scan, windowDays: days, sinceMs, nowMs, excludedBenchProjects: excluded.size, oldestReadMtimeMs };
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
  // Rework is sparse (it needs long epochs on both sides of a compaction), so
  // it is pooled over every compaction of every model.
  const rwc = everyone.filter((c) => Number.isFinite(c.reworkTokens));
  const rw = rwc.map((c) => c.reworkTokens);
  const rework = rw.length >= MIN_PARAM_SAMPLES ? Math.max(0, median(rw)) : 0;
  const reworkSessions = new Set(rwc.map((c) => c.session ?? null)).size;
  for (const [list, source] of tiers) {
    if (list.length >= MIN_PARAM_SAMPLES) {
      return {
        P: median(list.map((c) => c.firstAfterContext)),
        Pw: median(list.map((c) => c.firstAfterWrite || 0)),
        S: median(list.map((c) => c.postTokens || 0)),
        rework,
        reworkSamples: rw.length,
        reworkSessions,
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
export function replayTrack(track, T, { P, Pw, S, r, w5, w1, outRatio, rework = 0 }) {
  let C = track.start;
  let cost = 0;
  let compactions = 0;
  const n = track.inc.length;
  for (let i = 0; i < n; i++) {
    if (i > 0) C = Math.max(0, C + track.inc[i]);
    const w = track.ttl1h[i] ? w1 : w5;
    if (C >= T) {
      compactions += 1;
      cost += C * r + S * outRatio + Pw * (w - r) + rework * w;
      C = P + rework;
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

// With rework, the context after a compaction is P + rework and the rework is
// written once per compaction, so P becomes P + rework and k0 gains rework x w.
export function closedFormWindow({ P, Pw, S, r, wMean, outRatio, g, lambda, rework = 0 }) {
  if (!(g > 0) || !(r > 0)) return null;
  const R = r + lambda * (wMean - r);
  const P1 = P + rework;
  const k0 = S * outRatio + Pw * (wMean - r) + rework * wMean;
  return P1 + Math.sqrt((2 * g * (k0 + r * P1)) / R);
}

// The window SETTINGS a model can be given: the grid from 100K up to its
// context window (a larger setting is capped there and behaves the same).
export function candidateWindows(spec, cfg = compactionConfig()) {
  const { min, max, step } = cfg.window;
  const top = Math.min(max, spec.contextWindow);
  const out = [];
  for (let w = min; w <= top; w += step) out.push(w);
  if (!out.includes(top)) out.push(top);
  return out;
}

// Where a model compacts for a window SETTING: min(setting, context window)
// minus the reserve, min(max output, 20K) + 13K = 33K for current models
// (config/compaction.json compactReserve). null = unset: the model's default.
export const thresholdFor = (window, spec) => (window == null
  ? spec.defaultCompactAt
  : Math.min(window, spec.contextWindow) - (spec.reserve ?? 33000));

export const DEFAULT_MIN_REQUESTS = 1000;
export const DEFAULT_MIN_TRACKS_REACHING = 5;

// Evaluates one model. opts: { cfg, calibration, configured (tokens|null),
// minRequests, minTracksReaching, minTurnsPerCompaction, requestsPerTurnPooled,
// reworkFixed (a number used in place of the measured rework; the rework-off view
// passes 0) }. Every `window` in the result is a SETTING; `threshold` is where
// that setting compacts.
export function evaluateModel(mi, allInputs, opts = {}) {
  const cfg = opts.cfg || compactionConfig();
  const minRequests = opts.minRequests ?? DEFAULT_MIN_REQUESTS;
  const minTracksReaching = opts.minTracksReaching ?? DEFAULT_MIN_TRACKS_REACHING;
  const minTurns = opts.minTurnsPerCompaction ?? cfg.minTurnsPerCompaction ?? 10;
  const reworkFixed = opts.reworkFixed ?? null;
  const spec = windowSpecFor(mi.model, cfg);
  const price = priceSpecFor(mi.model);
  const check = priceCheckFor(mi.model, opts.calibration);
  const base = {
    model: mi.model,
    alias: price?.alias || spec.alias || null,
    contextWindow: spec.contextWindow,
    defaultCompactAt: spec.defaultCompactAt,
    reserve: spec.reserve,
    requests: mi.requests,
    mainRequests: mi.mainRequests,
    subagentRequests: mi.subagentRequests,
    tracks: mi.tracks.length,
    compactionsObserved: mi.compactions.length,
    autoCompactionPreTokens: mi.compactions.filter((c) => c.trigger === 'auto' && c.preTokens != null).map((c) => c.preTokens),
    moneyBasis: check.basis,
    priceCheck: check.check,
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

  const reworkOf = (p) => (reworkFixed != null ? reworkFixed : p.rework);
  const pOf = (kind) => ({ ...params[kind], rework: reworkOf(params[kind]), r: price.r, w5: price.w5, w1: price.w1, outRatio: price.outRatio });
  // A threshold at or below the post-compaction size would compact on every request.
  const maxP = Math.max(...Object.values(params).map((p) => p.P + reworkOf(p)));
  const usdOf = (units) => units * price.inUsd; // API list price
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
    return { usd: usdOf(units), compactions, stepsInCompacting, requestsPerCompaction };
  };

  const curve = [];
  for (const W of candidateWindows(spec, cfg)) {
    const T = thresholdFor(W, spec);
    if (T <= maxP) { curve.push({ window: W, threshold: T, feasible: false }); continue; }
    const x = replayAt(T);
    const turnsPerCompaction = x.requestsPerCompaction != null && requestsPerTurn ? x.requestsPerCompaction / requestsPerTurn : null;
    const allowed = x.requestsPerCompaction == null || minRequestsPerCompaction == null || x.requestsPerCompaction >= minRequestsPerCompaction;
    curve.push({
      window: W, threshold: T, feasible: true, usd: x.usd, compactions: x.compactions,
      stepsInCompacting: x.stepsInCompacting, requestsPerCompaction: x.requestsPerCompaction, turnsPerCompaction, allowed,
    });
  }

  // Fit: the replay at the threshold this model actually compacted at (the
  // median auto-compaction size, else its default) against what the same cost
  // model says the recorded requests and compactions cost. Near 1 means the
  // replay reproduces the real history before it is asked about other windows.
  const autoPre = base.autoCompactionPreTokens;
  const fitT = autoPre.length ? Math.min(median(autoPre), spec.defaultCompactAt) : spec.defaultCompactAt;
  let observedUnits = mi.observedUnits;
  for (const c of mi.compactions) {
    if (!Number.isFinite(c.preTokens)) continue;
    const w = c.kind === 'main' ? price.w1 : price.w5;
    observedUnits += c.preTokens * price.r + (c.postTokens || 0) * price.outRatio + (c.firstAfterWrite || 0) * (w - price.r);
  }
  const fitReplay = fitT > maxP ? replayAt(fitT) : null;
  const fit = fitReplay ? {
    threshold: fitT,
    replayUsd: fitReplay.usd,
    observedUsd: usdOf(observedUnits),
    ratio: observedUnits ? fitReplay.usd / usdOf(observedUnits) : null,
    replayCompactions: fitReplay.compactions,
    observedCompactions: mi.compactions.length,
  } : null;
  const feasible = curve.filter((c) => c.feasible);
  const allowed = feasible.filter((c) => c.allowed);
  const best = (list) => list.reduce((a, b) => (b.usd < a.usd ? b : a), list[0]);
  const optimum = allowed.length ? best(allowed) : null;
  const unconstrained = feasible.length ? best(feasible) : null;
  // Unset: each model's own default threshold, replayed directly.
  const atDefault = spec.defaultCompactAt > maxP ? { window: null, threshold: spec.defaultCompactAt, ...replayAt(spec.defaultCompactAt) } : null;
  const configuredT = opts.configured ? thresholdFor(opts.configured, spec) : null;
  const atConfigured = configuredT ? (configuredT > maxP ? { window: opts.configured, threshold: configuredT, ...replayAt(configuredT) } : null) : null;
  const band = (pct) => {
    if (!optimum) return null;
    const inside = allowed.filter((c) => c.usd <= optimum.usd * (1 + pct / 100)).map((c) => c.window);
    return [Math.min(...inside), Math.max(...inside)];
  };

  // Sensitivity: the whole evaluation again with no rework term (rework is
  // the least certain parameter), over its own feasible and allowed windows.
  const nr = reworkFixed == null ? evaluateModel(mi, allInputs, { ...opts, reworkFixed: 0 }) : null;

  // Closed-form cross-check, with the main-kind parameters when there are any.
  const pk = params.main || Object.values(params)[0];
  const steps = mi.tracks.reduce((a, t) => a + t.inc.length, 0);
  const lambda = steps ? mi.idleExpiries / steps : 0;
  const wMean = steps ? (mi.ttl1hSteps * price.w1 + (steps - mi.ttl1hSteps) * price.w5) / steps : price.w5;
  const g = mi.growth.n ? mi.growth.sum / mi.growth.n : 0;
  const closedFormThreshold = closedFormWindow({
    P: pk.P, Pw: pk.Pw, S: pk.S, rework: reworkOf(pk), r: price.r, wMean, outRatio: price.outRatio, g, lambda,
  });

  const cacheUsd = mi.money.read + mi.money.write5m + mi.money.write1h;
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
      reworkUsed: reworkOf(pk),
    },
    curve,
    optimum: optimum && { window: optimum.window, threshold: optimum.threshold, usd: optimum.usd, compactions: optimum.compactions, turnsPerCompaction: optimum.turnsPerCompaction },
    unconstrainedOptimum: unconstrained && { window: unconstrained.window, threshold: unconstrained.threshold, usd: unconstrained.usd, compactions: unconstrained.compactions, turnsPerCompaction: unconstrained.turnsPerCompaction },
    band1: band(1),
    band5: band(5),
    atDefault: atDefault && { window: null, threshold: atDefault.threshold, usd: atDefault.usd, compactions: atDefault.compactions },
    atConfigured: atConfigured && { window: atConfigured.window, threshold: atConfigured.threshold, usd: atConfigured.usd, compactions: atConfigured.compactions },
    savingVsDefault: saving(atDefault),
    savingVsConfigured: saving(atConfigured),
    // The closed form gives a compaction point; the setting that gives it is
    // that plus the reserve.
    closedFormThreshold,
    closedFormWindow: closedFormThreshold == null ? null : closedFormThreshold + spec.reserve,
    noRework: nr && {
      status: nr.status,
      window: nr.optimum?.window ?? null,
      band1: nr.band1 ?? null,
      band5: nr.band5 ?? null,
      curve: nr.curve || null,
    },
    noReworkOptimum: nr?.optimum?.window ?? null,
    fit,
    cacheUsd,
  };
}

// The one setting across the model mix: for each window on the common grid,
// the sum of every evaluated model's replayed cost at that window (a model
// whose context window is smaller runs at its own cap). Every model with a
// replayed curve votes ('ok' or 'no-allowed-window'); a model with too little
// data does not. The turn floor applies to the mix as a whole — requests
// between compactions over every voter, in turns at the pooled requests per
// turn — so one thin model cannot veto a window on its own; each voter's own
// turns per compaction at the chosen value is reported beside it, and every
// model that would compact more often than the floor there is listed in
// optimum.belowFloor (the floor binds the mix, so the report must say which
// models it does not protect).
// weights (alias -> factor) gives the plan-usage view; noRework uses each
// model's rework-off curve.
export function combineModels(evaluated, {
  cfg = compactionConfig(), weights = null, requestsPerTurn = null, minTurnsPerCompaction, noRework = false,
} = {}) {
  const minTurns = minTurnsPerCompaction ?? cfg.minTurnsPerCompaction ?? 10;
  const curveOf = (e) => (noRework ? e.noRework?.curve : e.curve);
  const statusOf = (e) => (noRework ? e.noRework?.status : e.status);
  const voters = evaluated.filter((e) => (statusOf(e) === 'ok' || statusOf(e) === 'no-allowed-window') && curveOf(e));
  if (!voters.length) return null;
  const { min, max, step } = cfg.window;
  const grid = [];
  for (let w = min; w <= max; w += step) grid.push(w);
  // A setting above a model's context window is capped there.
  const costAt = (e, W) => curveOf(e).find((c) => c.window === Math.min(W, e.contextWindow) && c.feasible) || null;
  const rows = [];
  for (const W of grid) {
    let usd = 0;
    let ok = true;
    let compactions = 0;
    let steps = 0;
    const perModel = {};
    for (const e of voters) {
      const pt = costAt(e, W);
      if (!pt) { ok = false; break; }
      const wt = weights ? (weights[e.alias] ?? 1) : 1;
      usd += pt.usd * wt;
      compactions += pt.compactions;
      steps += pt.stepsInCompacting || 0;
      perModel[e.model] = pt.turnsPerCompaction ?? null;
    }
    if (!ok) continue;
    const turnsPerCompaction = compactions && requestsPerTurn ? steps / compactions / requestsPerTurn : null;
    const allowed = turnsPerCompaction == null || turnsPerCompaction >= minTurns;
    rows.push({ window: W, usd, compactions, turnsPerCompaction, allowed, perModelTurnsPerCompaction: perModel });
  }
  const allowedRows = rows.filter((r) => r.allowed);
  if (!allowedRows.length) return { voters: voters.map((e) => e.model), optimum: null, rows };
  const opt = allowedRows.reduce((a, b) => (b.usd < a.usd ? b : a), allowedRows[0]);
  const band = (pct) => {
    const inside = allowedRows.filter((r) => r.usd <= opt.usd * (1 + pct / 100)).map((r) => r.window);
    return [Math.min(...inside), Math.max(...inside)];
  };
  // atCap: the setting is at or above this model's context window, so it
  // already compacts as late as it can; no value of the setting helps it.
  const belowFloor = Object.entries(opt.perModelTurnsPerCompaction)
    .filter(([, t]) => t != null && t < minTurns)
    .map(([model, t]) => ({ model, turnsPerCompaction: t, atCap: opt.window >= (voters.find((e) => e.model === model)?.contextWindow ?? Infinity) }));
  return {
    voters: voters.map((e) => e.model),
    optimum: {
      window: opt.window, usd: opt.usd, compactions: opt.compactions, turnsPerCompaction: opt.turnsPerCompaction,
      perModelTurnsPerCompaction: opt.perModelTurnsPerCompaction,
      belowFloor,
    },
    band1: band(1),
    band5: band(5),
    rows,
  };
}

// --- Spawn overhead and where the money goes ----------------------------------------------

export function spawnOverhead(spawns, { days } = {}) {
  const by = new Map();
  for (const s of spawns) {
    const k = s.agentType || '(unknown)';
    if (!by.has(k)) by.set(k, { agentType: k, count: 0, usd: [], context: [], models: {} });
    const e = by.get(k);
    const p = priceUsage({ input: s.input, output: 0, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, cacheWrite1h: s.cacheWrite1h }, s.model);
    e.count += 1;
    e.context.push(s.contextTokens);
    e.models[s.model || '(no model)'] = (e.models[s.model || '(no model)'] || 0) + 1;
    if (p) e.usd.push(p.usd);
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

export function whereMoneyGoes(mi) {
  const f = 1; // API list price, unscaled
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

// The two forms to type for a window setting: the settings.json integer and
// the /autocompact command (applies at once in that session).
export function settingForms(window) {
  if (!window) return null;
  return { settingsValue: Math.round(window), command: `/autocompact ${Math.round(window / 1000)}k` };
}

// What the numbers cover. A time-budgeted read goes newest file first, so
// traffic newer than the oldest file read is complete and older traffic is
// only partly read (and the model mix leans to recent work).
export function coverageOf(inputs) {
  const s = inputs.scan || {};
  const truncated = !!s.truncated;
  const oldest = inputs.oldestReadMtimeMs;
  const completeDays = truncated
    ? (Number.isFinite(oldest) ? Math.max(0, Math.min(inputs.windowDays, (inputs.nowMs - oldest) / 86400000)) : 0)
    : inputs.windowDays;
  return { truncated, filesRead: s.filesRead ?? null, filesFound: s.filesFound ?? null, windowDays: inputs.windowDays, completeDays };
}

// "over 30d", or for a partial read what it actually covers.
export function spanPhrase(cov) {
  if (!cov?.truncated) return `over ${cov?.windowDays}d`;
  return `over the transcripts read (PARTIAL: ${cov.filesRead} of ${cov.filesFound} files, complete only for the newest ${cov.completeDays.toFixed(1)}d)`;
}

export function adviseFromInputs(inputs, {
  cfg = compactionConfig(), calibration = { pooled: { n: 0 }, perModel: {} },
  configured = { tokens: null, source: 'unset', ignored: [], notes: [], autoCompactDisabled: null },
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
  const combineOpts = { cfg, requestsPerTurn: requestsPerTurnPooled, minTurnsPerCompaction };
  const global = combineModels(evaluated, combineOpts);
  const globalNoRework = combineModels(evaluated, { ...combineOpts, noRework: true });
  const planWeights = cfg.planUsage?.weights || null;
  const globalPlan = planWeights && Object.keys(planWeights).length ? combineModels(evaluated, { ...combineOpts, weights: planWeights }) : null;
  // A reference point summed over the global voters, or null if any voter lacks it.
  const sumOver = (pick) => {
    if (!global) return null;
    let usd = 0;
    for (const e of evaluated.filter((x) => global.voters.includes(x.model))) {
      const p = pick(e);
      if (!p) return null;
      usd += p.usd;
    }
    return usd;
  };
  const configuredUsd = configured.tokens ? sumOver((e) => e.atConfigured) : null;
  const defaultUsd = sumOver((e) => e.atDefault);
  const coverage = coverageOf(inputs);
  const pooledCheck = priceCheckFor(null, calibration);
  return {
    generatedAt: new Date(inputs.nowMs).toISOString(),
    windowDays: inputs.windowDays,
    scan: inputs.scan && {
      filesFound: inputs.scan.filesFound, filesRead: inputs.scan.filesRead, filesSkipped: inputs.scan.filesSkipped,
      truncated: inputs.scan.truncated, wallMs: inputs.scan.wallMs, rootExists: inputs.scan.exists,
      excludedBenchProjects: inputs.excludedBenchProjects ?? 0,
    },
    coverage,
    configured,
    moneyBasis: MONEY_BASIS,
    priceCheck: pooledCheck,
    calibration,
    requestsPerTurnPooled,
    minTurnsPerCompaction: minTurnsPerCompaction ?? cfg.minTurnsPerCompaction,
    models: evaluated,
    global: global && {
      ...global,
      toType: global.optimum ? settingForms(global.optimum.window) : null,
      configured: configured.tokens && configuredUsd != null ? { window: configured.tokens, usd: configuredUsd } : null,
      atDefault: defaultUsd != null ? { usd: defaultUsd } : null,
      noRework: globalNoRework && { optimum: globalNoRework.optimum && { window: globalNoRework.optimum.window, belowFloor: globalNoRework.optimum.belowFloor }, band1: globalNoRework.band1 ?? null, band5: globalNoRework.band5 ?? null },
    },
    globalPlanUsage: globalPlan && { asOf: cfg.planUsage.asOf, weights: planWeights, optimum: globalPlan.optimum, band5: globalPlan.band5 },
    moneyByModel: [...models.values()].filter((m) => priceSpecFor(m.model)).sort((a, b) => b.requests - a.requests).map((m) => whereMoneyGoes(m)),
    spawnOverhead: spawnOverhead(inputs.spawns, { days: inputs.windowDays }),
  };
}

export async function runCacheAdvisor({
  root, days = 30, now = new Date(), maxMs = null, workflows = false, resultsRoot, env, settingsPath, projectDir, managedPath,
  minRequests, minTracksReaching, minTurnsPerCompaction, includeBench = false,
} = {}) {
  const inputs = await collectAdvisorInputs({ root, days, now, maxMs, workflows, includeBench });
  const calibration = calibrate(resultsRoot ? { resultsRoot } : {});
  const configured = configuredWindow({
    ...(env ? { env } : {}), ...(settingsPath ? { settingsPath } : {}), ...(projectDir ? { projectDir } : {}), ...(managedPath !== undefined ? { managedPath } : {}),
  });
  return adviseFromInputs(inputs, { calibration, configured, minRequests, minTracksReaching, minTurnsPerCompaction });
}

// --- The saved summary (numbers and model ids only) -----------------------------------------

export function summaryOf(advice) {
  const cov = advice.coverage || { truncated: !!advice.scan?.truncated };
  return {
    generatedAt: advice.generatedAt,
    windowDays: advice.windowDays,
    truncated: !!cov.truncated,
    filesRead: cov.filesRead ?? advice.scan?.filesRead ?? null,
    filesFound: cov.filesFound ?? advice.scan?.filesFound ?? null,
    completeDays: cov.completeDays ?? null,
    configured: advice.configured?.tokens ?? null,
    configuredIgnored: (advice.configured?.ignored || []).length,
    global: advice.global?.optimum ? {
      window: advice.global.optimum.window,
      band5: advice.global.band5,
      belowFloor: (advice.global.optimum.belowFloor || []).map((b) => ({ model: b.model, turnsPerCompaction: b.turnsPerCompaction })),
    } : null,
    models: Object.fromEntries(advice.models.map((e) => [e.model, {
      status: e.status,
      window: e.optimum?.window ?? null,
      band5: e.band5 ?? null,
      requests: e.requests,
    }])),
  };
}

// Writes the summary unless it is a partial read and a full-read summary is
// already saved: a time-budgeted audit run must not replace what a full run
// found. Returns the path written, or null when the full summary was kept.
export function saveAdvisorSummary(advice, dir = stateDir()) {
  const path = join(dir, ADVISOR_SUMMARY_FILE);
  const s = summaryOf(advice);
  if (s.truncated) {
    const prev = loadAdvisorSummary(dir);
    if (prev && !prev.truncated) return null;
  }
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
  try { appendAdvisorHistory(s, dir); } catch { /* history is advisory: never fails the save */ }
  return path;
}

// --- Recommendation history (drift signal) ---------------------------------------------
// Numbers only: date, recommended global window, its band, model-mix shares
// (model ids only) and days covered. Never paths, project names or session ids.
// `anchor` is the baseline the scout's compact_window_drift signal compares
// against: the first full entry, reset to the newest entry each time the
// signal fires, so slow cumulative drift fires once per material move.
export const ADVISOR_HISTORY_FILE = 'cache-advisor-history.json';
export const ADVISOR_HISTORY_MAX = 90;

export function historyEntryOf(s) {
  if (!s || s.truncated || !(Number(s.global?.window) > 0)) return null;
  const models = Object.entries(s.models || {});
  const total = models.reduce((n, [, m]) => n + (Number(m?.requests) || 0), 0);
  return {
    date: s.generatedAt ?? null,
    window: Number(s.global.window),
    band5: s.global.band5 ?? null,
    mix: total > 0
      ? Object.fromEntries(models.map(([id, m]) => [id, Math.round(((Number(m?.requests) || 0) / total) * 1000) / 1000]))
      : {},
    days: s.completeDays ?? s.windowDays ?? null,
  };
}

// The history lives in two copies written atomically: the file and a `.bak`
// mirror. A copy that fails to parse is renamed aside (`.corrupt-<ms>`) with a
// one-line warning instead of being overwritten, and the other copy is used. A
// main file whose entries are a strict prefix of the mirror's lost an update
// (a writer persisted a stale read), so the mirror's entries win and the main
// file's anchor is kept.
const readHistoryCopy = (file) => {
  if (!existsSync(file)) return null;
  let h;
  try { h = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e instanceof SyntaxError) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try { renameSync(file, aside); process.stderr.write(`agent-companion: unreadable ${file} kept as ${aside}; using the other copy or starting fresh\n`); } catch { /* leave it in place */ }
    }
    return null;
  }
  return h && Array.isArray(h.entries) ? h : null;
};

export function loadAdvisorHistory(dir = stateDir()) {
  try {
    const file = join(dir, ADVISOR_HISTORY_FILE);
    const m = readHistoryCopy(file);
    const b = readHistoryCopy(`${file}.bak`);
    if (!m) return b;
    if (b && b.entries.length > m.entries.length
      && JSON.stringify(b.entries.slice(0, m.entries.length)) === JSON.stringify(m.entries)) {
      return { ...m, entries: b.entries };
    }
    return m;
  } catch { return null; }
}

function writeAdvisorHistory(h, dir) {
  const file = join(dir, ADVISOR_HISTORY_FILE);
  writeJsonAtomic(file, h);
  writeJsonAtomic(`${file}.bak`, h);
}

// Appends a FULL-read entry; a partial read never touches the history.
export function appendAdvisorHistory(summary, dir = stateDir()) {
  const e = historyEntryOf(summary);
  if (!e) return null;
  const h = loadAdvisorHistory(dir) || { anchor: null, entries: [] };
  h.entries.push(e);
  if (h.entries.length > ADVISOR_HISTORY_MAX) h.entries = h.entries.slice(-ADVISOR_HISTORY_MAX);
  if (!(Number(h.anchor?.window) > 0)) h.anchor = e;
  writeAdvisorHistory(h, dir);
  return e;
}

// Compares the newest full entry with the anchor. Null (no signal) on
// missing/corrupt history, fewer than two entries, a non-finite window, or a
// move within the threshold. On a fire the anchor moves to the newest entry
// (persisted unless `persist` is false): the history is re-read just before
// the write and only `anchor` changes, so a concurrent append is kept.
// Returns { from, to, pct, entry }.
export function checkWindowDrift(dir = stateDir(), { thresholdPct = 20, persist = true } = {}) {
  const h = loadAdvisorHistory(dir);
  if (!h || h.entries.length < 2) return null;
  const newest = h.entries[h.entries.length - 1];
  const from = Number(h.anchor?.window);
  const to = Number(newest?.window);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(from > 0) || !(to > 0)) return null;
  const thr = Number(thresholdPct);
  const limit = Number.isFinite(thr) && thr >= 0 ? thr : 20;
  const pct = (Math.abs(to - from) / from) * 100;
  if (!Number.isFinite(pct) || !(pct > limit)) return null;
  if (persist) {
    try {
      const fresh = loadAdvisorHistory(dir) || h;
      fresh.anchor = newest;
      writeAdvisorHistory(fresh, dir);
    } catch { /* unwritable: the signal still fires this run */ }
  }
  return { from, to, pct: Math.round(pct * 10) / 10, entry: newest };
}

export function loadAdvisorSummary(dir = stateDir()) {
  try { return JSON.parse(readFileSync(join(dir, ADVISOR_SUMMARY_FILE), 'utf8')); } catch { return null; }
}

// The summary's line for a routing alias (opus, sonnet, haiku, fable). With a
// modelId (the id the alias resolves to, config/model-tiers.json) that id is
// matched exactly (or with a date suffix) first, so "opus" quotes Opus 5.5 and
// not the busier Opus 5; otherwise the busiest id containing the alias.
export function windowHintFor(summary, alias, { modelId = null } = {}) {
  if (!summary || !alias) return null;
  const usable = Object.entries(summary.models || {}).filter(([, m]) => m.status === 'ok' && m.window);
  const byRequests = (a, b) => (b[1].requests || 0) - (a[1].requests || 0);
  const exact = modelId ? usable.filter(([id]) => id === modelId || new RegExp(`^${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(id)).sort(byRequests) : [];
  const cands = exact.length ? exact : (modelId ? [] : usable.filter(([id]) => id.toLowerCase().includes(String(alias).toLowerCase())).sort(byRequests));
  const global = summary.global?.window || null;
  if (!cands.length && !global) return null;
  const [id, m] = cands[0] || [modelId, null];
  return {
    model: id,
    window: m?.window ?? null,
    band5: m?.band5 ?? null,
    global,
    configured: summary.configured,
    configuredIgnored: summary.configuredIgnored || 0,
    generatedAt: summary.generatedAt,
    windowDays: summary.windowDays,
    truncated: !!summary.truncated,
    filesRead: summary.filesRead ?? null,
    filesFound: summary.filesFound ?? null,
  };
}

// --- The human report (the CLI prints it; the audit check reuses parts) --------------------

export function formatAdvice(a, { curve = false } = {}) {
  const out = [];
  const K = (x) => (x == null ? 'n/a' : `${Math.round(x / 1000)}K`);
  const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(2)}`);
  const pct = (x) => (x == null ? 'n/a' : `${x.toFixed(1)}%`);
  const R = windowSpecFor('').reserve; // how far below a set window it compacts (33K today)
  const turnsTxt = (t) => (t == null ? 'n/a' : t.toFixed(0));
  const s = a.scan || {};
  const cov = a.coverage || { truncated: !!s.truncated, windowDays: a.windowDays, filesRead: s.filesRead, filesFound: s.filesFound, completeDays: 0 };
  const span = spanPhrase(cov);
  out.push(`cache-advisor — last ${a.windowDays}d (${a.generatedAt})`);
  out.push(`files: ${s.filesRead} read of ${s.filesFound}, ${((s.wallMs || 0) / 1000).toFixed(1)}s; `
    + `${s.excludedBenchProjects || 0} benchmark project dir(s) excluded (synthetic runs are never pooled with your traffic)`);
  if (cov.truncated) {
    out.push(`PARTIAL READ: the time budget stopped after ${cov.filesRead} of ${cov.filesFound} files, newest first. Traffic is complete only for the newest ${cov.completeDays.toFixed(1)}d; `
      + `older traffic is partly read, so the model mix leans to recent work. Run without --max-ms for the full ${a.windowDays}d.`);
  }
  const cal = a.calibration;
  out.push(`money: $ at API list price (config/model-pricing.json); on a subscription plan these dollars are notional — they rank windows, they are not a bill.`);
  out.push(cal?.pooled?.n
    ? `  price-table check: Claude Code's own cost_usd / list price on ${cal.pooled.n} bench rows = ${cal.pooled.ratio.toFixed(3)} (p10 ${cal.pooled.p10.toFixed(3)}, p90 ${cal.pooled.p90.toFixed(3)})`
      + `${a.priceCheck?.agrees === false ? ' — the price table DISAGREES with Claude Code; fix config/model-pricing.json before trusting the dollars' : ': the tables agree (a check of the table, not a measurement of spend)'}`
    : '  price table not checked (no bench cost_usd rows)');
  const c = a.configured || { tokens: null, source: 'unset' };
  out.push(c.tokens
    ? `window in effect: ${K(c.tokens)} (${c.source}) — compacts at about ${K(c.tokens - R)} on 1M models, ${K(Math.min(c.tokens, 200000) - R)} on 200K models`
    : "window in effect: unset — each model's default (compacts at about 967K on 1M models, 167K on 200K models)");
  out.push('  (read: the environment variable and the managed and user settings files; a running session\'s --autocompact flag cannot be seen from here)');
  for (const line of ignoredWindowLines(c)) out.push(`  WARNING: ${line}`);
  for (const n of c.notes || []) out.push(`  note: ${n}`);
  if (c.autoCompactDisabled) out.push(`  WARNING: auto-compact is disabled (${c.autoCompactDisabled}); no window applies until it is enabled`);
  out.push('');

  out.push('-- auto-compact window per model (the setting to type; replayed on your transcripts) --');
  for (const e of a.models) {
    if (e.status !== 'ok') {
      out.push(`  ${e.model.padEnd(28)} ${e.status}: ${e.reason || ''} (${e.requests} requests)`);
      continue;
    }
    const pad = ''.padEnd(28);
    out.push(`  ${e.model.padEnd(28)} optimum ${K(e.optimum.window)} (compacts at ${K(e.optimum.threshold)})  within 1%: ${K(e.band1[0])}-${K(e.band1[1])}  within 5%: ${K(e.band5[0])}-${K(e.band5[1])}  `
      + `closed form ${K(e.closedFormWindow)}  (${e.requests} requests, ${e.tracksReaching} sessions past ${K(100000)})`);
    const d = e.savingVsDefault;
    const cf = e.savingVsConfigured;
    out.push(`  ${pad} vs unset (compacts at ${K(e.defaultCompactAt)}): saves ${usd(d?.usd)} (${pct(d?.pctOfCacheSpend)} of its cache spend)`
      + `${cf ? `; vs your ${K(c.tokens)}: saves ${usd(cf.usd)} (${pct(cf.pctOfCacheSpend)})` : ''}`
      + `; compactions at optimum ${e.optimum.compactions}, about every ${turnsTxt(e.optimum.turnsPerCompaction)} turns`);
    if (e.unconstrainedOptimum && e.unconstrainedOptimum.window !== e.optimum.window) {
      out.push(`  ${pad} (cheapest ignoring the ${a.minTurnsPerCompaction}-turn floor: ${K(e.unconstrainedOptimum.window)}, about every ${turnsTxt(e.unconstrainedOptimum.turnsPerCompaction)} turns)`);
    }
    if (e.noRework) {
      out.push(`  ${pad} rework off: ${e.noRework.window ? `optimum ${K(e.noRework.window)}, within 5%: ${K(e.noRework.band5[0])}-${K(e.noRework.band5[1])}` : e.noRework.status}`);
    }
    const pk = e.params.byKind.main || Object.values(e.params.byKind)[0];
    out.push(`  ${pad} inputs: after-compaction size ${K(pk.P)} (${pk.source}, n=${pk.n}), rework ${K(pk.rework)} (n=${pk.reworkSamples} from ${pk.reworkSessions ?? 'n/a'} sessions), `
      + `growth ${Math.round(e.params.growthPerRequestMean)}/request, ${e.params.requestsPerTurn == null ? 'n/a' : e.params.requestsPerTurn.toFixed(1)} requests/turn`
      + `${e.fit ? `; fit at ${K(e.fit.threshold)}: replay/recorded ${e.fit.ratio.toFixed(3)}` : ''}`);
    if (curve) {
      for (const p of e.curve.filter((x) => x.feasible)) {
        out.push(`      ${K(p.window).padStart(6)} (at ${K(p.threshold).padStart(5)}) ${usd(p.usd).padStart(12)} compactions ${String(p.compactions).padStart(4)}${p.allowed ? '' : '  (below the turn floor)'}`);
      }
    }
  }
  out.push('');
  if (a.global?.optimum) {
    const g = a.global;
    const W = g.optimum.window;
    const forms = g.toType || settingForms(W);
    out.push(`-- one setting for your model mix (autoCompactWindow is global) --`);
    out.push(`  cheapest: ${K(W)} (compacts at about ${K(W - R)} on 1M models, ${K(Math.min(W, 200000) - R)} on 200K models)  `
      + `within 1%: ${K(g.band1[0])}-${K(g.band1[1])}  within 5%: ${K(g.band5[0])}-${K(g.band5[1])}  (voters: ${g.voters.join(', ')})`);
    out.push(`  TO APPLY, type one of: ${forms.command}   (in a session: applies at once, and saves it to your user settings)`);
    out.push(`                     or: "autoCompactWindow": ${forms.settingsValue}   (settings.json: an INTEGER — a string like "${Math.round(W / 1000)}k" is silently ignored; read when a session starts)`);
    const tpc = g.optimum.perModelTurnsPerCompaction || {};
    out.push(`  at ${K(W)}: a compaction about every ${turnsTxt(g.optimum.turnsPerCompaction)} turns overall; per model `
      + Object.entries(tpc).map(([m, t]) => `${m} ${t == null ? 'none' : t.toFixed(0)}`).join(', '));
    for (const b of g.optimum.belowFloor || []) {
      out.push(`  WARNING: at ${K(W)}, ${b.model} would compact about every ${b.turnsPerCompaction.toFixed(1)} turns — more often than the ${a.minTurnsPerCompaction}-turn floor, which binds the mix as a whole, not each model`
        + `${b.atCap ? ' (it is at its context-window cap already: no value of the setting makes it compact less often)' : ''}`);
    }
    if (g.noRework?.optimum) {
      out.push(`  rework off: cheapest ${K(g.noRework.optimum.window)}, within 5%: ${K(g.noRework.band5[0])}-${K(g.noRework.band5[1])} `
        + '(the rework term is measured extra growth after a compaction; this shows how far the answer leans on it)');
    }
    if (g.configured) out.push(`  at your ${K(g.configured.window)}: ${usd(g.configured.usd - g.optimum.usd)} more than the cheapest ${span}`);
    if (g.atDefault) out.push(`  unset (each model's default): ${usd(g.atDefault.usd - g.optimum.usd)} more than the cheapest ${span}`);
    if (a.globalPlanUsage?.optimum) out.push(`  plan-usage view (weights as of ${a.globalPlanUsage.asOf}, may be introductory): cheapest ${K(a.globalPlanUsage.optimum.window)}, within 5%: ${K(a.globalPlanUsage.band5[0])}-${K(a.globalPlanUsage.band5[1])}`);
  } else {
    out.push('-- one setting for your model mix -- no model had enough data to vote');
  }
  out.push('');

  out.push(`-- where the cache money goes (per model, API list price, ${span}) --`);
  for (const m of a.moneyByModel) {
    if (!m.cacheUsd) continue;
    out.push(`  ${m.model.padEnd(28)} cache ${usd(m.cacheUsd).padStart(11)}: reads ${pct(m.pct.read)}, 5m writes ${pct(m.pct.write5m)}, 1h writes ${pct(m.pct.write1h)}; `
      + `rewrites by cause (also share of cache spend): idle expiry ${pct(m.pct.idleExpiryRewrite)}, compaction ${pct(m.pct.compactionRewrite)}, prefix change ${pct(m.pct.prefixChangeRewrite)}`);
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
