// cache-ttl — would a 1-hour subagent prompt-cache TTL save or cost usage?
//
// This is a READ-ONLY analysis over the operator's own transcripts. It never
// writes a setting, never touches an agent definition, and never mutates
// anything under ~/.claude — the whole feature is a report.
//
// --- Why this exists -------------------------------------------------------
//
// By default, every subagent request writes its prompt cache with a 5-minute
// TTL (`subagentPromptCacheTtl` unset). A cache write costs 1.25x the base
// input price; a cache write under a 1-hour TTL costs 2x instead — MORE per
// write — but a 1h TTL keeps the cache warm through gaps that a 5m TTL would
// have let expire, turning what would have been a re-write into a cheap read
// (a read costs a small fraction of input price: `rm`, the read multiplier).
// So the question is empirical, not obvious: does a 1h TTL's extra write cost
// get paid back by the reads it converts, for THIS operator's actual gap
// distribution?
//
// --- The mechanics being modelled ------------------------------------------
//
// A gap between two requests in the SAME transcript file falls in one of
// three bands:
//   - under 5 minutes: the 5m cache is still warm either way. A 1h TTL
//     changes nothing here — this band is the sanity check that proves it.
//   - 5 to 60 minutes: the 5m cache has expired, so the request pays a fresh
//     write TODAY. Under a 1h TTL the cache would STILL be warm, so that
//     write becomes a read instead — this is the band where 1h can pay off.
//   - over 60 minutes: cold under EITHER TTL. A 1h TTL changes nothing here
//     either.
//
// So only the 5-60 minute band can move tokens from write to read, and the
// "converted tokens" calculation (convertedTokens, below) is the amount that
// moves for one such request: it can never exceed what the cache actually
// held from the previous request (prevPrefix) or what this request actually
// wrote (its own cache_write) — hence the clamp.
//
// --- Where this reads from --------------------------------------------------
//
// Main-session transcripts:   <projects-root>/<project>/<session>.jsonl
// Subagent transcripts:       <projects-root>/<project>/<session>/subagents/agent-<id>.jsonl
// Subagent sidecar metadata:  <projects-root>/<project>/<session>/subagents/agent-<id>.meta.json
//                              -> { agentType, model, requestShape }
//
// The financial analysis (per-model, per-agentType×model, policy comparison,
// verdict) is scoped to SUBAGENT requests only, because `subagentPromptCacheTtl`
// — the setting this check exists to inform — has no effect on the main
// conversation (which already gets a 1h TTL on a subscription plan within
// plan usage, 5m otherwise; see docs/en/prompt-caching). Main-session data is
// read separately, only for the confirmatory 5m/1h write split.
//
// --- What this analysis CANNOT see, and why the verdict is conservative ----
//
// `subagentPromptCacheTtl` also governs compaction, session-title generation,
// and workflow requests — none of which are ordinary subagent transcripts, so
// none of them are counted anywhere above. Those are overwhelmingly ONE-SHOT
// writes (a compaction summary or a title is generated once and never read
// back through the cache), which under a 1h TTL pay the full 2x write cost
// with essentially no compensating read to earn it back. This is a real cost
// the totals above do not include, in the direction that makes a 1h TTL look
// BETTER than it will actually be — so the verdict thresholds below are
// deliberately asymmetric (harder to recommend "set it" than to recommend
// "don't"), not symmetric around zero.

import { existsSync } from 'node:fs';
import { KNOWN_AGENT_TYPES } from '../../hooks/lib/context.mjs';
import {
  transcriptsRoot as sharedTranscriptsRoot, discoverTranscripts, readTranscript, resolveCrossFile, bandFor,
  percentile, SYNTHETIC_MODEL as SHARED_SYNTHETIC_MODEL, NO_META_AGENT_TYPE as SHARED_NO_META,
  gapsOf, isResumeAfterIdle,
} from './transcripts.mjs';
import { isBenchProject } from './cache-advisor.mjs';
import { pricingTable, classifyPricing, _resetPricingCacheForTests } from './pricing.mjs';

// Pricing moved to lib/pricing.mjs (shared with lib/transcripts.mjs's report);
// re-exported so this module's public API is unchanged.
export { pricingTable, classifyPricing, _resetPricingCacheForTests };

export const SYNTHETIC_MODEL = SHARED_SYNTHETIC_MODEL;
export const NO_META_AGENT_TYPE = SHARED_NO_META;

// --- Verdict thresholds (named constants, not magic numbers) ---------------
//
// SET_GLOBALLY_DELTA_PCT / DONT_SET_DELTA_PCT are deliberately NOT mirror
// images of each other in spirit even though they are the same magnitude:
// -1% is the bar to recommend the change, +1% is the bar to rule it out
// outright — the wide middle between them (and any tier disagreement) falls
// through to the per-agent-definition recommendation instead of a global
// call, because the helper-request cost above is real but unmeasured here.
export const SET_GLOBALLY_DELTA_PCT = -1.0;
export const DONT_SET_DELTA_PCT = 1.0;
export const MIN_TIER_SPEND_SHARE_PCT = 5; // a tier must carry this much of total $ spend to veto/confirm the global call
export const MIN_REQUESTS_FOR_AGENT_ROW = 500; // per-agent-definition recommendation floor
export const MIN_AGENT_SAVING_PCT = 1.0; // a candidate needs at least this much saving — a -0.24% "saving" is noise, not a reason to edit a definition

// --- Per-rung split: sample-size floor ---------------------------------------
//
// A per-rung verdict (see perRungOf) is only called PAYS / COSTS / NEUTRAL
// when the rung clears ALL of these in the window; below any of them it reads
// TOO LITTLE DATA, so a thin rung is never called PAYS. The gap floor applies
// to the view being judged (e.g. only the 5-60 min gaps connected by a
// SendMessage for the `message` view).
export const MIN_RUNG_FILES = 10;
export const MIN_RUNG_REQUESTS = MIN_REQUESTS_FOR_AGENT_ROW;
export const MIN_RUNG_VIEW_GAPS = 30;
export const TOO_LITTLE_DATA = 'TOO LITTLE DATA';
// The 5-60 min gaps split by what connected them (lib/transcripts.mjs viaOf):
// `message` = a worker you came back to with SendMessage, `prompt` = a person
// typed, `toolResult` = a slow tool call. `all` is every non-compaction gap.
export const RUNG_VIEWS = ['all', 'message', 'prompt', 'toolResult'];

// --- Experiment projects: excluded by default --------------------------------
//
// One rule: the cache advisor's isBenchProject() (the benchmark harness's
// temp-dir prefixes), widened to ANY project whose working directory sat in a
// temp dir (a "-Temp-" or "-tmp-" segment), which is where the TTL / variant
// experiments ran. Pass includeExperiments to count them.
export function isExperimentProject(name, opts) {
  const n = String(name || '');
  return isBenchProject(n, opts) || /-(?:temp|tmp)-/i.test(n);
}

// --- Transcripts root: one resolver, in lib/transcripts.mjs ----------------
export function transcriptsRoot(explicit) {
  return sharedTranscriptsRoot(explicit);
}

export function breakEvenSharePct(rm) {
  // 0.75 / (2 - rm), expressed as a percentage of write tokens.
  return (0.75 / (2 - rm)) * 100;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function percentiles(values, ps = [10, 50, 90]) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = {};
  for (const p of ps) out[`p${p}`] = percentile(sorted, p);
  return out;
}

// --- File discovery ----------------------------------------------------------
//
// Main-session files and ordinary subagent transcripts, in the shared
// reader's walk order. Workflow agents (subagents/workflows/<wf>/) are left
// out, as they always were here.
export function discoverFiles(root, { sinceMs = -Infinity, maxFiles = 20000, maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const { files, truncated } = discoverTranscripts(root, { sinceMs, maxFiles, maxBytes });
  const main = [];
  const subagent = [];
  for (const f of files) {
    if (f.kind === 'main') main.push({ path: f.path, project: f.project, mtimeMs: f.mtimeMs });
    else if (f.kind === 'subagent') {
      subagent.push({ path: f.path, project: f.project, agentType: f.agentType, declaredModel: f.declaredModel, mtimeMs: f.mtimeMs });
    }
  }
  return { main, subagent, truncated };
}

// --- Per-file request extraction --------------------------------------------
//
// Requests come from lib/transcripts.mjs (its header states the dedup rules:
// usage is the field-wise max over a request's lines, grouping is file-wide,
// re-logged lines and cross-file copies are not new requests). This adds the
// cache-TTL view: gap/band/cause/convertedTokens against the PREVIOUS request
// in the same file (never across files — a gap only means something within
// one continuous transcript). `ts` is the request's start (the user record
// that led to it).
//
// `seen` (optional) is a Set shared across files; a request another file
// already claimed comes back with duplicate: true and must be left out of
// every total. It is still returned, and still counts as the previous request
// for the gap of the one after it. computeCacheTtl() does not use `seen`: it
// reads every file first and resolves copies with resolveCrossFile(), which
// picks the original file and takes the max over copies.
export async function parseFile(path, { kind, agentType = null, seen = null } = {}) {
  let result;
  try {
    result = await readTranscript(path, { kind, agentType, seen });
  } catch {
    return [];
  }
  return ttlRowsOf(result, { kind, agentType });
}

// The cache-TTL rows for one readTranscript() result.
export function ttlRowsOf(result, { kind, agentType = null } = {}) {
  const out = [];
  let prev = null;
  for (const r of result.requests) {
    const ts = r.startTs;
    let gapMs = null;
    let band = null;
    let cause = null;
    let convertedTokens = 0;
    if (prev != null && Number.isFinite(ts) && Number.isFinite(prev.startTs)) {
      gapMs = ts - prev.startTs;
      band = bandFor(gapMs);
      const connUser = r.connectingUser;
      if (connUser?.isCompaction) {
        // Compaction forces a fresh write no matter what the TTL is set to —
        // the OLD cache is discarded along with the summarised context, not
        // merely expired, so there is nothing a longer TTL could have kept
        // warm. Checked FIRST (compaction outranks every other cause), and
        // convertedTokens stays 0 in EVERY band, including 5-60, where the
        // ordinary clamp formula would otherwise credit the 1h TTL with
        // "saving" a write that was never avoidable in the first place.
        cause = { type: 'compaction' };
      } else if (band === '5to60') {
        if (connUser?.hasToolResult) {
          cause = { type: 'long-tool-call', toolNames: [...prev.toolUseNames], waitMs: gapMs };
        } else if (prev.lastBlockType === 'text' && connUser?.isMeta) {
          cause = { type: 'resume-by-lead' };
        } else {
          cause = { type: 'unknown' };
        }
        const prevPrefix = prev.usage.input + prev.usage.cacheWrite + prev.usage.cacheRead;
        convertedTokens = clamp(prevPrefix - r.usage.cacheRead, 0, r.usage.cacheWrite);
      }
    }
    out.push({
      ts, gapMs, band, cause, convertedTokens,
      model: r.model, kind, agentType,
      duplicate: r.duplicate,
      usage: {
        input: r.usage.input,
        write: r.usage.cacheWrite,
        write5m: r.usage.cacheWrite5m,
        write1h: r.usage.cacheWrite1h,
        read: r.usage.cacheRead,
        output: r.usage.output,
      },
    });
    prev = r;
  }
  return out;
}

// --- Cost math ---------------------------------------------------------------
//
// Cost today   = I·in + W·1.25·in + R·rm·in + O·out
// Cost with 1h = I·in + (W-conv)·2·in + (R+conv)·rm·in + O·out
// All in $ per token, in/out are $/MTok divided by 1e6 by the caller.
export function costToday({ input, write, read, output }, price) {
  const inUsd = price.in / 1e6;
  const outUsd = price.out / 1e6;
  return input * inUsd + write * 1.25 * inUsd + read * price.readMultiplier * inUsd + output * outUsd;
}

export function costWith1h({ input, write, read, output, conv }, price) {
  const inUsd = price.in / 1e6;
  const outUsd = price.out / 1e6;
  return input * inUsd + (write - conv) * 2 * inUsd + (read + conv) * price.readMultiplier * inUsd + output * outUsd;
}

// --- Aggregation --------------------------------------------------------------

function emptyAgg() {
  return {
    requests: 0, band560: 0, input: 0, write: 0, write5m: 0, write1h: 0, read: 0, output: 0, conv: 0,
  };
}

function addRequestToAgg(agg, r) {
  agg.requests += 1;
  if (r.band === '5to60') agg.band560 += 1;
  agg.input += r.usage.input;
  agg.write += r.usage.write;
  agg.write5m += r.usage.write5m;
  agg.write1h += r.usage.write1h;
  agg.read += r.usage.read;
  agg.output += r.usage.output;
  agg.conv += r.convertedTokens;
}

function rowFromAgg(label, agg, price) {
  const today = costToday(agg, price);
  const with1h = costWith1h({ ...agg, conv: agg.conv }, price);
  const deltaPct = today > 0 ? ((with1h - today) / today) * 100 : 0;
  const breakEven = breakEvenSharePct(price.readMultiplier);
  const observedPct = agg.write > 0 ? (agg.conv / agg.write) * 100 : 0;
  return {
    label,
    requests: agg.requests,
    band560Requests: agg.band560,
    writeMTok: agg.write / 1e6,
    convMTok: agg.conv / 1e6,
    convOverWritePct: observedPct,
    breakEvenPct: breakEven,
    costToday: today,
    cost1h: with1h,
    deltaPct,
  };
}

// --- Verdict -----------------------------------------------------------
//
// A pure function over already-aggregated rows (not transcripts), so it is
// directly testable with hand-built inputs instead of needing a synthetic
// transcript for every branch.
//
// Decision order (see the module header for why this is asymmetric, not a
// symmetric ±X% band):
//   1. global delta <= SET_GLOBALLY_DELTA_PCT AND no tier carrying >=
//      MIN_TIER_SPEND_SHARE_PCT of spend has a POSITIVE delta -> set it
//      globally. The spend-share guard exists because a global average can
//      be dragged negative by a small, cheap tier while the tier that
//      actually carries the operator's spend goes the other way.
//   2. global delta >= DONT_SET_DELTA_PCT AND the opus/fable-only policy is
//      also non-negative -> don't set it, full stop. Checking the
//      opus/fable-only policy too means a global "don't" is not reversed by
//      a premium-tier-only pocket of savings that a per-agent override
//      could still capture.
//   3. otherwise (tiers disagree, or |global| is inside the dead zone) ->
//      recommend `experimental: { cacheTtl: "1h" }` on specific NAMED agent
//      definitions: delta at or past -MIN_AGENT_SAVING_PCT (a -0.24% "saving"
//      is noise, not a reason to edit a definition), at least
//      MIN_REQUESTS_FOR_AGENT_ROW requests (a small sample is not worth a
//      standing config change), and an agentType that actually HAS an
//      editable frontmatter file — a harness built-in (general-purpose,
//      Explore, ...) or a subagent with no sidecar metadata at all
//      (NO_META_AGENT_TYPE) cannot be pointed at a definition to edit, so
//      both are excluded regardless of their delta.
export function computeVerdict({
  perModel, perAgentModel, totals, policy, excludedAgentTypes = KNOWN_AGENT_TYPES,
}) {
  const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

  if (!perModel.length) {
    return { text: 'no priced subagent requests in the window — nothing to recommend', breakEvenByTier: [] };
  }

  const totalSpend = totals.costToday;
  const breakEvenByTier = perModel.map((r) => ({
    alias: r.label,
    observedPct: r.convOverWritePct,
    breakEvenPct: r.breakEvenPct,
    spendSharePct: totalSpend > 0 ? (r.costToday / totalSpend) * 100 : 0,
    deltaPct: r.deltaPct,
  }));

  const bigTiersPositive = breakEvenByTier.filter(
    (r) => r.spendSharePct >= MIN_TIER_SPEND_SHARE_PCT && r.deltaPct > 0,
  );

  let text;
  if (totals.deltaPct <= SET_GLOBALLY_DELTA_PCT && bigTiersPositive.length === 0) {
    text = `set subagentPromptCacheTtl to "1h" globally — observed delta ${fmtPct(totals.deltaPct)}, `
      + `no tier at >=${MIN_TIER_SPEND_SHARE_PCT}% of spend shows a positive delta`;
  } else if (totals.deltaPct >= DONT_SET_DELTA_PCT && policy.opusFableOnlyDeltaPct >= 0) {
    text = `don't set subagentPromptCacheTtl — observed delta ${fmtPct(totals.deltaPct)}, `
      + `and the opus/fable-only policy is also non-negative (${fmtPct(policy.opusFableOnlyDeltaPct)})`;
  } else {
    const candidates = perAgentModel.filter((r) => {
      if (r.deltaPct > -MIN_AGENT_SAVING_PCT) return false; // e.g. -0.24% is noise, not a saving worth a standing config edit
      if (r.requests < MIN_REQUESTS_FOR_AGENT_ROW) return false;
      const agentType = r.label.split(' → ')[0];
      if (agentType === NO_META_AGENT_TYPE || excludedAgentTypes.has(agentType)) return false;
      return true;
    });
    if (!candidates.length) {
      text = `don't set subagentPromptCacheTtl globally (delta ${fmtPct(totals.deltaPct)}) — no named agent definition `
        + `clears ${MIN_REQUESTS_FOR_AGENT_ROW} requests with a negative delta to warrant a per-agent override`;
    } else {
      text = `don't set subagentPromptCacheTtl globally (delta ${fmtPct(totals.deltaPct)}) — set `
        + 'experimental: { cacheTtl: "1h" } on: '
        + candidates.map((r) => `${r.label} (${fmtPct(r.deltaPct)}, today $${r.costToday.toFixed(2)} -> 1h $${r.cost1h.toFixed(2)})`).join('; ');
    }
  }
  return { text, breakEvenByTier };
}

// --- Per-rung split -------------------------------------------------------------
//
// perRungOf(files, ...) takes the loaded subagent transcripts (readTranscript
// results with their agentType) and returns one row per agentType ("rung"),
// sorted by name, with:
//   sample        files / requests / gaps (all) / gaps5to60 (all non-compaction)
//   gaps5to60ByVia  the 5-60 min gaps counted by what connected them
//   resumeRewrites  resume-after-idle gaps (lib/transcripts.mjs
//                   isResumeAfterIdle) that cost a rewrite (cause idle-expiry)
//   views[view]   for each RUNG_VIEWS entry: the 5-60 gaps in that view, the
//                 tokens a 1h TTL would convert, today's cost, cost with a 1h
//                 TTL when ONLY that view's gaps are converted (every write
//                 still pays the 2x 1h rate), net saving (today - 1h, positive
//                 = saves), delta %, and a verdict: PAYS / NEUTRAL / COSTS or
//                 TOO LITTLE DATA below the MIN_RUNG_* floor.
// Requests outside [windowStartMs, nowMs], cross-file duplicates and
// unpriced models are left out, as in the totals.
export function rungVerdict({ files, requests, viewGaps, deltaPct }) {
  if (files < MIN_RUNG_FILES || requests < MIN_RUNG_REQUESTS || viewGaps < MIN_RUNG_VIEW_GAPS) return TOO_LITTLE_DATA;
  if (deltaPct <= -MIN_AGENT_SAVING_PCT) return 'PAYS';
  if (deltaPct >= DONT_SET_DELTA_PCT) return 'COSTS';
  return 'NEUTRAL';
}

export function perRungOf(files, { windowStartMs = -Infinity, nowMs = Infinity, price = pricingTable() } = {}) {
  const rungs = new Map();
  const rungOf = (k) => {
    if (!rungs.has(k)) {
      rungs.set(k, {
        files: 0, requests: 0, gaps: 0, gaps5to60: 0, resumeRewrites: 0,
        byVia: {}, byAlias: new Map(), viewGaps: Object.fromEntries(RUNG_VIEWS.map((v) => [v, 0])),
      });
    }
    return rungs.get(k);
  };
  for (const { result, agentType } of files) {
    const R = rungOf(agentType || NO_META_AGENT_TYPE);
    const rows = ttlRowsOf(result, { kind: 'subagent', agentType });
    const gapByIndex = new Map(gapsOf(result.requests).map((g) => [g.index, g]));
    let counted = false;
    result.requests.forEach((req, i) => {
      const r = rows[i];
      if (!Number.isFinite(r.ts) || r.ts < windowStartMs || r.ts > nowMs || r.duplicate) return;
      const cls = classifyPricing(r.model, price);
      if (!cls.known) return;
      counted = true;
      R.requests += 1;
      if (!R.byAlias.has(cls.alias)) R.byAlias.set(cls.alias, { agg: emptyAgg(), conv: Object.fromEntries(RUNG_VIEWS.map((v) => [v, 0])) });
      const A = R.byAlias.get(cls.alias);
      addRequestToAgg(A.agg, r);
      const g = gapByIndex.get(req.index);
      if (!g) return;
      R.gaps += 1;
      if (g.cause === 'idle-expiry' && isResumeAfterIdle(g)) R.resumeRewrites += 1;
      if (g.band !== '5to60' || g.afterCompaction || g.via === 'compaction') return;
      R.gaps5to60 += 1;
      R.byVia[g.via] = (R.byVia[g.via] || 0) + 1;
      for (const v of RUNG_VIEWS) {
        if (v !== 'all' && v !== g.via) continue;
        R.viewGaps[v] += 1;
        A.conv[v] += r.convertedTokens;
      }
    });
    if (counted) R.files += 1;
  }
  const round = (n, d = 4) => Number(n.toFixed(d));
  const out = [];
  for (const key of [...rungs.keys()].sort()) {
    const R = rungs.get(key);
    const views = {};
    for (const v of RUNG_VIEWS) {
      let today = 0; let with1h = 0; let conv = 0;
      for (const [alias, A] of R.byAlias) {
        const spec = price.models[alias] || {};
        const p = { in: spec.in ?? 0, out: spec.out ?? 0, readMultiplier: spec.readMultiplier ?? price.defaultReadMultiplier };
        today += costToday(A.agg, p);
        with1h += costWith1h({ ...A.agg, conv: A.conv[v] }, p);
        conv += A.conv[v];
      }
      const deltaPct = today > 0 ? ((with1h - today) / today) * 100 : 0;
      views[v] = {
        gaps5to60: R.viewGaps[v],
        convMTok: round(conv / 1e6, 6),
        costToday: round(today),
        cost1h: round(with1h),
        netSavingUsd: round(today - with1h),
        deltaPct: round(deltaPct),
        verdict: rungVerdict({ files: R.files, requests: R.requests, viewGaps: R.viewGaps[v], deltaPct }),
      };
    }
    const byVia = {};
    for (const k of Object.keys(R.byVia).sort()) byVia[k] = R.byVia[k];
    out.push({
      rung: key,
      models: [...R.byAlias.keys()].sort(),
      sample: { files: R.files, requests: R.requests, gaps: R.gaps, gaps5to60: R.gaps5to60 },
      gaps5to60ByVia: byVia,
      resumeRewrites: R.resumeRewrites,
      views,
    });
  }
  return out;
}

export async function computeCacheTtl({
  days = 30,
  now = new Date(),
  transcriptsRoot: root,
  maxFiles = 20000,
  maxBytes = 4 * 1024 * 1024 * 1024,
  crossFileDedup = true,
  includeExperiments = false,
} = {}) {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - days * 86400000;
  const rootDir = root || transcriptsRoot();
  const price = pricingTable();

  const discovered = existsSync(rootDir)
    ? discoverFiles(rootDir, { sinceMs: windowStartMs, maxFiles, maxBytes })
    : { main: [], subagent: [], truncated: false };
  const { truncated } = discovered;
  const excludedProjects = new Set();
  const keep = (f) => {
    if (includeExperiments || !isExperimentProject(f.project)) return true;
    excludedProjects.add(f.project);
    return false;
  };
  const main = discovered.main.filter(keep);
  const subagent = discovered.subagent.filter(keep);

  // --- Subagent requests: the financial analysis --------------------------
  const perModel = new Map(); // alias -> agg
  const perAgentModel = new Map(); // "agentType→alias" -> agg
  const unknownModels = new Map(); // raw model string -> count
  const bandCounts = { lt5: 0, '5to60': 0, gt60: 0, none: 0 };
  const sanity = {
    lt5: { readSum: 0, prefixSum: 0 },
    '5to60': { readSum: 0, prefixSum: 0 },
  };
  const causeCounts = { 'long-tool-call': 0, 'resume-by-lead': 0, unknown: 0, compaction: 0 };
  const toolWaits = [];
  const toolNameCounts = new Map();
  let subagentWrite1hTotal = 0;
  let subagentRequestsScanned = 0;
  // A resumed or forked transcript carries copies of requests another file
  // already holds (lib/transcripts.mjs, rule D4). Summing per file counted
  // each copy again. Every file is read first, then the copies are resolved
  // across all of them: one request per id, owned by the original file, with
  // the max usage over its copies.
  let crossFileDuplicatesSkipped = 0;
  const loaded = [];
  const load = async (f, kind, agentType) => {
    try {
      loaded.push({ result: await readTranscript(f.path, { kind, agentType }), mtimeMs: f.mtimeMs, kind, agentType });
    } catch { /* unreadable: skip */ }
  };
  for (const f of subagent) await load(f, 'subagent', f.agentType);
  for (const f of main) await load(f, 'main', null);
  const crossFile = crossFileDedup ? resolveCrossFile(loaded) : null;
  const rowsOf = (kind) => loaded.filter((l) => l.kind === kind).map((l) => ttlRowsOf(l.result, { kind, agentType: l.agentType }));

  for (const reqs of rowsOf('subagent')) {
    for (const r of reqs) {
      if (!Number.isFinite(r.ts) || r.ts < windowStartMs || r.ts > nowMs) continue;
      if (r.duplicate) { crossFileDuplicatesSkipped += 1; continue; }
      subagentRequestsScanned += 1;

      const cls = classifyPricing(r.model, price);
      if (!cls.known) {
        unknownModels.set(r.model || '(no model)', (unknownModels.get(r.model || '(no model)') || 0) + 1);
        continue; // excluded from every cost total, per spec
      }

      if (r.band) bandCounts[r.band] += 1; else bandCounts.none += 1;
      subagentWrite1hTotal += r.usage.write1h;

      if (r.band === 'lt5' || r.band === '5to60') {
        // The cliff this proves: under a live 5m cache (lt5) a request should
        // come back almost entirely as a READ against the existing cache
        // (read / (read+write) ~= 100%); once the 5m cache has expired
        // (5to60) it should come back almost entirely as a fresh WRITE
        // (~0%). read+write together stand in for "the prefix this request
        // needed", which is exactly what the ratio is checking.
        sanity[r.band].readSum += r.usage.read;
        sanity[r.band].prefixSum += r.usage.read + r.usage.write;
      }

      // Compaction is counted regardless of band — it can land in any of the
      // three, and forces a fresh write in all of them (convertedTokens is
      // already forced to 0 in parseFile). The other causes are meaningful
      // only inside the 5-60min band, where a rewrite is genuinely a TTL
      // question rather than a cold-start or a compaction-forced one.
      if (r.cause?.type === 'compaction') {
        causeCounts.compaction += 1;
      } else if (r.band === '5to60' && r.cause) {
        causeCounts[r.cause.type] = (causeCounts[r.cause.type] || 0) + 1;
        if (r.cause.type === 'long-tool-call') {
          toolWaits.push(r.cause.waitMs);
          for (const t of r.cause.toolNames) toolNameCounts.set(t, (toolNameCounts.get(t) || 0) + 1);
        }
      }

      if (!perModel.has(cls.alias)) perModel.set(cls.alias, emptyAgg());
      addRequestToAgg(perModel.get(cls.alias), r);

      const amKey = `${r.agentType || NO_META_AGENT_TYPE} → ${cls.alias}`;
      if (!perAgentModel.has(amKey)) perAgentModel.set(amKey, emptyAgg());
      addRequestToAgg(perAgentModel.get(amKey), r);
    }
  }

  // --- Main-session requests: confirmatory write-split only ---------------
  let mainWrite5m = 0;
  let mainWrite1h = 0;
  let mainRequestsScanned = 0;
  for (const reqs of rowsOf('main')) {
    for (const r of reqs) {
      if (!Number.isFinite(r.ts) || r.ts < windowStartMs || r.ts > nowMs) continue;
      if (r.duplicate) { crossFileDuplicatesSkipped += 1; continue; }
      mainRequestsScanned += 1;
      mainWrite5m += r.usage.write5m;
      mainWrite1h += r.usage.write1h;
    }
  }

  // --- Roll up model rows ---------------------------------------------------
  const perModelRows = [...perModel.entries()].map(([alias, agg]) => {
    const spec = price.models[alias] || {};
    const p = { in: spec.in ?? 0, out: spec.out ?? 0, readMultiplier: spec.readMultiplier ?? price.defaultReadMultiplier };
    return rowFromAgg(alias, agg, p);
  });
  const perAgentModelRows = [...perAgentModel.entries()].map(([key, agg]) => {
    const alias = key.split(' → ')[1];
    const spec = price.models[alias] || {};
    return rowFromAgg(key, agg, { in: spec.in ?? 0, out: spec.out ?? 0, readMultiplier: spec.readMultiplier ?? price.defaultReadMultiplier });
  });

  // --- Totals -----------------------------------------------------------
  const grand = emptyAgg();
  for (const agg of perModel.values()) {
    grand.requests += agg.requests; grand.band560 += agg.band560;
    grand.input += agg.input; grand.write += agg.write; grand.read += agg.read; grand.output += agg.output; grand.conv += agg.conv;
  }
  let costTodayTotal = 0;
  let cost1hTotal = 0;
  let costOpusFableOnly = 0;
  for (const [alias, agg] of perModel.entries()) {
    const spec = price.models[alias] || {};
    const p = { in: spec.in ?? 0, out: spec.out ?? 0, readMultiplier: spec.readMultiplier ?? price.defaultReadMultiplier };
    const t = costToday(agg, p);
    const w = costWith1h(agg, p);
    costTodayTotal += t;
    cost1hTotal += w;
    const isPremiumTier = /^(opus|fable)/.test(alias);
    costOpusFableOnly += isPremiumTier ? w : t;
  }
  const globalDeltaPct = costTodayTotal > 0 ? ((cost1hTotal - costTodayTotal) / costTodayTotal) * 100 : 0;
  const opusFableDeltaPct = costTodayTotal > 0 ? ((costOpusFableOnly - costTodayTotal) / costTodayTotal) * 100 : 0;

  // --- Sanity check: observed read/prefix ratio per band ------------------
  const sanityOut = {};
  for (const band of ['lt5', '5to60']) {
    const s = sanity[band];
    sanityOut[band] = s.prefixSum > 0 ? (s.readSum / s.prefixSum) * 100 : null;
  }

  // --- Tool-wait percentiles ------------------------------------------------
  const toolWaitPct = percentiles(toolWaits, [10, 50, 90]);
  const topTools = [...toolNameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // --- Verdict ----------------------------------------------------------
  const { text: verdict, breakEvenByTier } = computeVerdict({
    perModel: perModelRows,
    perAgentModel: perAgentModelRows,
    totals: { costToday: costTodayTotal, deltaPct: globalDeltaPct },
    policy: { opusFableOnlyDeltaPct: opusFableDeltaPct },
  });

  return {
    windowDays: days,
    generatedAt: new Date(nowMs).toISOString(),
    filesScanned: { main: main.length, subagent: subagent.length },
    truncated,
    subagentRequestsScanned,
    mainRequestsScanned,
    crossFileDuplicatesSkipped,
    // ids in more than one file, and how many of them the max-over-copies
    // rule changed against keeping the first copy in path order (all-time
    // counts over the files read, not limited to the window).
    crossFile,
    totals: {
      requests: grand.requests,
      band560Requests: grand.band560,
      writeMTok: grand.write / 1e6,
      convMTok: grand.conv / 1e6,
      convOverWritePct: grand.write > 0 ? (grand.conv / grand.write) * 100 : 0,
      costToday: costTodayTotal,
      cost1h: cost1hTotal,
      deltaPct: globalDeltaPct,
    },
    bands: {
      lt5: { count: bandCounts.lt5 },
      '5to60': { count: bandCounts['5to60'] },
      gt60: { count: bandCounts.gt60 },
      firstInFile: bandCounts.none,
    },
    sanity: sanityOut,
    causes: {
      counts: causeCounts,
      toolWaitMsP10: toolWaitPct.p10,
      toolWaitMsP50: toolWaitPct.p50,
      toolWaitMsP90: toolWaitPct.p90,
      topTools,
    },
    perModel: perModelRows,
    perAgentModel: perAgentModelRows,
    unknownModels: [...unknownModels.entries()].map(([model, count]) => ({ model, count })),
    mainSession: {
      requestsScanned: mainRequestsScanned,
      write5mMTok: mainWrite5m / 1e6,
      write1hMTok: mainWrite1h / 1e6,
      write1hSharePct: (mainWrite5m + mainWrite1h) > 0 ? (mainWrite1h / (mainWrite5m + mainWrite1h)) * 100 : null,
    },
    subagentsAlreadyWriting1h: subagentWrite1hTotal > 0,
    subagentWrite1hMTok: subagentWrite1hTotal / 1e6,
    experimentProjects: { included: includeExperiments, excludedProjects: excludedProjects.size },
    rungFloor: { files: MIN_RUNG_FILES, requests: MIN_RUNG_REQUESTS, viewGaps5to60: MIN_RUNG_VIEW_GAPS },
    perRung: perRungOf(loaded.filter((l) => l.kind === 'subagent'), { windowStartMs, nowMs, price }),
    policy: {
      allFiveMin: costTodayTotal,
      allOneHour: cost1hTotal,
      oneHourOpusFableOnly: costOpusFableOnly,
      allOneHourDeltaPct: globalDeltaPct,
      opusFableOnlyDeltaPct: opusFableDeltaPct,
    },
    breakEvenByTier,
    verdict,
  };
}
