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

import {
  readFileSync, readdirSync, statSync, createReadStream, existsSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../../hooks/lib/context.mjs';
import { stateRoot } from '../../hooks/lib/context.mjs';

export const SYNTHETIC_MODEL = '<synthetic>';
const FIVE_MIN_MS = 5 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;

// --- Transcripts root, mirroring lib/coverage.mjs's own override convention -
export function transcriptsRoot(override) {
  return override || process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT || join(claudeDir(), 'projects');
}

// --- Pricing table (data, not code) ----------------------------------------

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

export function breakEvenSharePct(rm) {
  // 0.75 / (2 - rm), expressed as a percentage of write tokens.
  return (0.75 / (2 - rm)) * 100;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

export function percentiles(values, ps = [10, 50, 90]) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = {};
  for (const p of ps) out[`p${p}`] = percentile(sorted, p);
  return out;
}

function bandFor(gapMs) {
  if (gapMs < FIVE_MIN_MS) return 'lt5';
  if (gapMs <= SIXTY_MIN_MS) return '5to60';
  return 'gt60';
}

// --- File discovery ----------------------------------------------------------
//
// One project directory holds main-session .jsonl files directly, and one
// subdirectory per session id holding that session's subagent transcripts
// under subagents/agent-<id>.jsonl, each with a sibling
// agent-<id>.meta.json ({ agentType, model, requestShape }).
export function discoverFiles(root, { sinceMs = -Infinity, maxFiles = 20000, maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const main = [];
  const subagent = [];
  let truncated = false;
  let totalBytes = 0;
  let projDirs;
  try {
    projDirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { main, subagent, truncated };
  }

  const consider = (file, push, extra) => {
    let st;
    try { st = statSync(file); } catch { return; }
    if (st.mtimeMs < sinceMs) return; // file untouched since the window opened: cannot hold a newer request
    if (main.length + subagent.length >= maxFiles || totalBytes + st.size > maxBytes) { truncated = true; return; }
    totalBytes += st.size;
    push({ path: file, ...extra });
  };

  for (const proj of projDirs) {
    const projDir = join(root, proj.name);
    let entries;
    try { entries = readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        consider(join(projDir, e.name), main.push.bind(main), { project: proj.name });
        continue;
      }
      if (!e.isDirectory()) continue;
      const subDir = join(projDir, e.name, 'subagents');
      let subEntries;
      try { subEntries = readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
      for (const s of subEntries) {
        if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
        const metaPath = join(subDir, s.name.replace(/\.jsonl$/, '.meta.json'));
        let meta = {};
        try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* missing/unreadable sidecar: fail open to unknowns */ }
        consider(join(subDir, s.name), subagent.push.bind(subagent), {
          project: proj.name,
          agentType: meta.agentType || 'unknown',
          declaredModel: meta.model || null,
        });
      }
    }
  }
  return { main, subagent, truncated };
}

// --- Per-file request extraction --------------------------------------------
//
// Streams one transcript, grouping assistant lines by requestId (falling
// back to message.id) into REQUESTS, and returns them in file order with
// gap/band/cause/convertedTokens already computed against the PREVIOUS
// request in the same file (never across files — a gap only means something
// within one continuous transcript).
export async function parseFile(path, { kind, agentType = null } = {}) {
  let rl;
  try {
    rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  } catch {
    return [];
  }

  const requests = [];
  let lastUserRec = null; // { ts, hasToolResult, isMeta }
  let current = null; // in-progress request accumulator
  let prevFinalized = null; // previous FINALIZED request, for gap/cause/conv

  function finalizeCurrent() {
    if (!current) return;
    const ts = current.startTs;
    let gapMs = null;
    let band = null;
    let cause = null;
    let convertedTokens = 0;
    if (prevFinalized != null && Number.isFinite(ts) && Number.isFinite(prevFinalized.startTs)) {
      gapMs = ts - prevFinalized.startTs;
      band = bandFor(gapMs);
      if (band === '5to60') {
        const connUser = current.connectingUser;
        if (connUser?.hasToolResult) {
          cause = { type: 'long-tool-call', toolNames: [...prevFinalized.toolUseNames], waitMs: gapMs };
        } else if (prevFinalized.lastBlockType === 'text' && connUser?.isMeta) {
          cause = { type: 'resume-by-lead' };
        } else {
          cause = { type: 'unknown' };
        }
        const prevPrefix = prevFinalized.usage.input + prevFinalized.usage.write + prevFinalized.usage.read;
        convertedTokens = clamp(prevPrefix - current.usage.read, 0, current.usage.write);
      }
    }
    requests.push({
      ts, gapMs, band, cause, convertedTokens,
      model: current.model, kind, agentType,
      usage: { ...current.usage },
    });
    prevFinalized = {
      startTs: ts,
      usage: current.usage,
      toolUseNames: current.toolUseNames,
      lastBlockType: current.lastBlockType,
    };
    current = null;
  }

  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'user') {
      const content = rec.message?.content;
      const hasToolResult = Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
      lastUserRec = { ts: Date.parse(rec.timestamp), hasToolResult, isMeta: rec.isMeta === true };
      continue;
    }

    if (rec.type !== 'assistant') continue;
    const model = rec.message?.model;
    if (model === SYNTHETIC_MODEL) continue; // never counted, never starts/ends a request

    const key = rec.requestId || rec.message?.id;
    if (!key) continue;

    if (!current || current.id !== key) {
      finalizeCurrent();
      const startTs = lastUserRec ? lastUserRec.ts : Date.parse(rec.timestamp);
      current = {
        id: key,
        model,
        startTs,
        connectingUser: lastUserRec,
        usage: { input: 0, write: 0, write5m: 0, write1h: 0, read: 0, output: 0 },
        toolUseNames: new Set(),
        lastBlockType: null,
      };
    }

    const u = rec.message?.usage || {};
    const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const writeFlat = u.cache_creation_input_tokens;
    const write = typeof writeFlat === 'number' ? writeFlat : write5m + write1h;

    current.usage.input = Math.max(current.usage.input, u.input_tokens || 0);
    current.usage.write = Math.max(current.usage.write, write);
    current.usage.write5m = Math.max(current.usage.write5m, write5m);
    current.usage.write1h = Math.max(current.usage.write1h, write1h);
    current.usage.read = Math.max(current.usage.read, u.cache_read_input_tokens || 0);
    current.usage.output = Math.max(current.usage.output, u.output_tokens || 0);

    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.type === 'tool_use' && b.name) current.toolUseNames.add(b.name);
      if (content.length) current.lastBlockType = content[content.length - 1]?.type || current.lastBlockType;
    }
  }
  finalizeCurrent();
  return requests;
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

export async function computeCacheTtl({
  days = 30,
  now = new Date(),
  transcriptsRoot: root,
  maxFiles = 20000,
  maxBytes = 4 * 1024 * 1024 * 1024,
} = {}) {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - days * 86400000;
  const rootDir = root || transcriptsRoot();
  const price = pricingTable();

  const { main, subagent, truncated } = existsSync(rootDir)
    ? discoverFiles(rootDir, { sinceMs: windowStartMs, maxFiles, maxBytes })
    : { main: [], subagent: [], truncated: false };

  // --- Subagent requests: the financial analysis --------------------------
  const perModel = new Map(); // alias -> agg
  const perAgentModel = new Map(); // "agentType→alias" -> agg
  const unknownModels = new Map(); // raw model string -> count
  const bandCounts = { lt5: 0, '5to60': 0, gt60: 0, none: 0 };
  const sanity = {
    lt5: { readSum: 0, prefixSum: 0 },
    '5to60': { readSum: 0, prefixSum: 0 },
  };
  const causeCounts = { 'long-tool-call': 0, 'resume-by-lead': 0, unknown: 0 };
  const toolWaits = [];
  const toolNameCounts = new Map();
  let subagentWrite1hTotal = 0;
  let subagentRequestsScanned = 0;

  for (const f of subagent) {
    let reqs;
    try { reqs = await parseFile(f.path, { kind: 'subagent', agentType: f.agentType }); } catch { continue; }
    for (const r of reqs) {
      if (!Number.isFinite(r.ts) || r.ts < windowStartMs || r.ts > nowMs) continue;
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

      if (r.band === '5to60' && r.cause) {
        causeCounts[r.cause.type] = (causeCounts[r.cause.type] || 0) + 1;
        if (r.cause.type === 'long-tool-call') {
          toolWaits.push(r.cause.waitMs);
          for (const t of r.cause.toolNames) toolNameCounts.set(t, (toolNameCounts.get(t) || 0) + 1);
        }
      }

      if (!perModel.has(cls.alias)) perModel.set(cls.alias, emptyAgg());
      addRequestToAgg(perModel.get(cls.alias), r);

      const amKey = `${r.agentType || 'unknown'} → ${cls.alias}`;
      if (!perAgentModel.has(amKey)) perAgentModel.set(amKey, emptyAgg());
      addRequestToAgg(perAgentModel.get(amKey), r);
    }
  }

  // --- Main-session requests: confirmatory write-split only ---------------
  let mainWrite5m = 0;
  let mainWrite1h = 0;
  let mainRequestsScanned = 0;
  for (const f of main) {
    let reqs;
    try { reqs = await parseFile(f.path, { kind: 'main', agentType: null }); } catch { continue; }
    for (const r of reqs) {
      if (!Number.isFinite(r.ts) || r.ts < windowStartMs || r.ts > nowMs) continue;
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

  // --- Verdict --------------------------------------------------------------
  const negativeDeltaAgentModels = perAgentModelRows.filter((r) => r.deltaPct < 0 && r.requests > 0);
  let verdict;
  if (perModel.size === 0) {
    verdict = 'no priced subagent requests in the window — nothing to recommend';
  } else if (globalDeltaPct < -0.05) {
    verdict = `set subagentPromptCacheTtl to "1h" globally — observed delta ${globalDeltaPct.toFixed(2)}%`;
  } else if (globalDeltaPct > 0.05) {
    verdict = `leave subagentPromptCacheTtl at its default (5m) — observed delta ${globalDeltaPct.toFixed(2)}%`;
  } else if (negativeDeltaAgentModels.length) {
    verdict = `global delta is roughly neutral (${globalDeltaPct.toFixed(2)}%) — set experimental.cacheTtl: "1h" only on the `
      + `${negativeDeltaAgentModels.length} agent definition(s) whose own delta is negative: `
      + `${negativeDeltaAgentModels.slice(0, 6).map((r) => r.label).join(', ')}${negativeDeltaAgentModels.length > 6 ? ', ...' : ''}`;
  } else {
    verdict = `global delta is roughly neutral (${globalDeltaPct.toFixed(2)}%) and no agent×model combination shows a negative delta — no change recommended`;
  }

  return {
    windowDays: days,
    generatedAt: new Date(nowMs).toISOString(),
    filesScanned: { main: main.length, subagent: subagent.length },
    truncated,
    subagentRequestsScanned,
    mainRequestsScanned,
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
    policy: {
      allFiveMin: costTodayTotal,
      allOneHour: cost1hTotal,
      oneHourOpusFableOnly: costOpusFableOnly,
      allOneHourDeltaPct: globalDeltaPct,
      opusFableOnlyDeltaPct: opusFableDeltaPct,
    },
    verdict,
  };
}
