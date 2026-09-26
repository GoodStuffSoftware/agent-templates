// transcript-report — corpus-wide numbers from lib/transcripts.mjs, for a
// person to read (scripts/transcript-report.mjs) and for later consumers
// (the cache/compaction advisor, the calibrator) to build on.
//
// Every dollar figure here is PRICE-DERIVED: list price x tokens, from
// config/model-pricing.json through lib/pricing.mjs. It is labelled
// basis: 'price-derived' at every level it appears. A consumer that has a
// measured cost (bench results' cost_usd) passes its own `costOf` and its
// basis label replaces this one — that is the seam; nothing else changes.

import {
  scanCorpus, gapsOf, isResumeAfterIdle, spawnBaselineOf, percentile, emptyUsage, addUsage,
} from './transcripts.mjs';
import { priceUsage, PRICE_BASIS } from './pricing.mjs';

// Gap histogram buckets (upper bound exclusive). 5m and 60m are the
// two prompt-cache TTLs, so both are bucket edges.
export const GAP_BUCKETS = [
  { label: '<1m', toMs: 60 * 1000 },
  { label: '1-5m', toMs: 5 * 60 * 1000 },
  { label: '5-10m', toMs: 10 * 60 * 1000 },
  { label: '10-30m', toMs: 30 * 60 * 1000 },
  { label: '30-60m', toMs: 60 * 60 * 1000 },
  { label: '1-2h', toMs: 2 * 60 * 60 * 1000 },
  { label: '2-6h', toMs: 6 * 60 * 60 * 1000 },
  { label: '>=6h', toMs: Infinity },
];

function bucketFor(gapMs) {
  for (const b of GAP_BUCKETS) if (gapMs < b.toMs) return b.label;
  return GAP_BUCKETS[GAP_BUCKETS.length - 1].label;
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const pct = (xs, p) => percentile(sorted(xs), p);

function defaultCostOf(usage, model) {
  const r = priceUsage(usage, model);
  return r ? { usd: r.usd, alias: r.alias, basis: r.basis } : null;
}

// buildTranscriptReport(opts) -> report object (see scripts/transcript-report.mjs
// for the fields as printed). Options:
//   root, days (30), now (Date), workflows (false), crossFileDedup (true),
//   maxFiles, maxBytes, maxMs, costOf(usage, model) -> { usd, alias, basis } | null
export async function buildTranscriptReport({
  root, days = 30, now = new Date(), workflows = false, crossFileDedup = true,
  maxFiles, maxBytes, maxMs = null, costOf = defaultCostOf,
} = {}) {
  const nowMs = now.getTime();
  const sinceMs = nowMs - days * 86400000;
  const inWindow = (ts) => Number.isFinite(ts) && ts >= sinceMs && ts <= nowMs;

  const perModel = new Map();
  const dedup = {
    reloggedLines: 0, duplicateUuidLines: 0, crossFileDuplicates: 0, syntheticLines: 0,
    unparseableLines: 0, truncatedTails: 0,
  };
  const files = { main: 0, subagent: 0, withRequests: 0 };
  const compaction = { count: 0, byTrigger: {}, byKind: {}, pre: [], post: [], firstAfter: [], requestsAfter: [] };
  const newBuckets = () => new Map(GAP_BUCKETS.map((b) => [b.label, {
    label: b.label, count: 0, hits: 0, rewrites: 0, rereadTokens: 0, rewriteTokens: 0, afterCompaction: 0,
    causes: { 'idle-expiry': 0, 'prefix-change': 0, compaction: 0 },
  }]));
  const gapBuckets = newBuckets();
  const byViaTtl = new Map(); // "via|ttl" -> { via, ttl, count, buckets }
  const resumeAfterIdle = { count: 0, hits: 0, rewrites: 0, causes: { 'idle-expiry': 0, 'prefix-change': 0, compaction: 0 }, byKindTtl: {} };
  // The resume guard's own evidence (deliverable 6): idle-expiry rewrites are
  // the ones caused by resuming past the cache TTL, never a prefix change or
  // a compaction (see gapsOf's `cause` in lib/transcripts.mjs). Accumulated
  // per model, since the write price and the 1h/5m split both vary by model;
  // priced below, same costOf() every other total in this report uses.
  const idleExpiryByModel = new Map(); // model -> { model, tokens, usage }
  const addGap = (buckets, g) => {
    const b = buckets.get(bucketFor(g.gapMs));
    b.count += 1;
    b.rereadTokens += g.rereadTokens;
    if (g.afterCompaction) b.afterCompaction += 1;
    if (g.outcome === 'hit') b.hits += 1;
    else { b.rewrites += 1; b.rewriteTokens += g.cacheWrite; b.causes[g.cause] = (b.causes[g.cause] || 0) + 1; }
  };
  const spawn = new Map();
  const peaks = [];
  const growth = [];
  let basis = null;

  const scan = await scanCorpus({
    root, sinceMs, maxFiles, maxBytes, maxMs, workflows, crossFileDedup,
    onFile: (res) => {
      const s = res.stats;
      dedup.reloggedLines += s.reloggedLines;
      dedup.duplicateUuidLines += s.duplicateUuidLines;
      dedup.crossFileDuplicates += s.crossFileDuplicates;
      dedup.syntheticLines += s.syntheticLines;
      dedup.unparseableLines += s.unparseable;
      if (s.truncatedTail) dedup.truncatedTails += 1;
      if (res.file.kind === 'main') files.main += 1; else if (res.file.kind === 'subagent') files.subagent += 1;

      const own = res.requests.filter((r) => !r.duplicate && inWindow(r.startTs));
      if (own.length) files.withRequests += 1;
      for (const r of own) {
        const key = r.model || '(no model)';
        if (!perModel.has(key)) {
          perModel.set(key, { model: key, alias: null, requests: 0, mainRequests: 0, subagentRequests: 0, usage: emptyUsage(), usd: 0, priced: false });
        }
        const row = perModel.get(key);
        row.requests += 1;
        if (r.kind === 'main') row.mainRequests += 1; else row.subagentRequests += 1;
        addUsage(row.usage, r.usage);
        const c = costOf(r.usage, r.model);
        if (c) {
          row.usd += c.usd;
          row.priced = true;
          row.alias = c.alias ?? row.alias;
          basis = basis || c.basis;
        }
      }

      // Context growth: peak per file, and per-request growth inside one
      // compaction epoch (a compaction resets context, so its drop is not
      // "growth").
      if (own.length) peaks.push(Math.max(...own.map((r) => r.contextTokens)));
      for (let i = 1; i < own.length; i++) {
        if (own[i].compactionsBefore === own[i - 1].compactionsBefore) growth.push(own[i].contextTokens - own[i - 1].contextTokens);
      }

      for (const c of res.compactions) {
        if (c.duplicate || !inWindow(c.ts)) continue;
        compaction.count += 1;
        const trig = c.trigger || '(unrecorded)';
        compaction.byTrigger[trig] = (compaction.byTrigger[trig] || 0) + 1;
        compaction.byKind[res.file.kind] = (compaction.byKind[res.file.kind] || 0) + 1;
        if (c.preTokens != null) compaction.pre.push(c.preTokens);
        if (c.postTokens != null) compaction.post.push(c.postTokens);
        if (c.firstRequestAfter) compaction.firstAfter.push(c.firstRequestAfter.contextTokens);
        compaction.requestsAfter.push(c.requestsAfter);
      }

      for (const g of gapsOf(res.requests)) {
        const r = res.requests[g.index];
        if (!inWindow(r.startTs)) continue;
        addGap(gapBuckets, g);
        const k = `${g.via}|${g.ttl}`;
        if (!byViaTtl.has(k)) byViaTtl.set(k, { via: g.via, ttl: g.ttl, count: 0, buckets: newBuckets() });
        const vt = byViaTtl.get(k);
        vt.count += 1;
        addGap(vt.buckets, g);
        if (isResumeAfterIdle(g)) {
          resumeAfterIdle.count += 1;
          if (g.outcome === 'hit') resumeAfterIdle.hits += 1;
          else {
            resumeAfterIdle.rewrites += 1;
            resumeAfterIdle.causes[g.cause] += 1;
            if (g.cause === 'idle-expiry') {
              const key = g.model || '(no model)';
              if (!idleExpiryByModel.has(key)) idleExpiryByModel.set(key, { model: key, tokens: 0, usage: emptyUsage() });
              const e = idleExpiryByModel.get(key);
              e.tokens += g.cacheWrite;
              e.usage.cacheWrite += g.cacheWrite;
              // The gap does not carry the request's own 1h/5m split, but
              // idle-expiry means the previous cache had already lapsed, so
              // this write went to the TTL bucket the gap itself resolved
              // (g.ttl) — the same assumption ttlSource:'default' already
              // makes for gaps with no earlier write to read the split from.
              if (g.ttl === '1h') e.usage.cacheWrite1h += g.cacheWrite; else e.usage.cacheWrite5m += g.cacheWrite;
            }
          }
          const kt = `${g.kind}|${g.ttl}`;
          resumeAfterIdle.byKindTtl[kt] = (resumeAfterIdle.byKindTtl[kt] || 0) + 1;
        }
      }

      const sb = spawnBaselineOf(res);
      if (sb && inWindow(sb.ts)) {
        const k = sb.agentType || '(unknown)';
        if (!spawn.has(k)) spawn.set(k, { agentType: k, count: 0, context: [], cacheWrite: [], cacheRead: [] });
        const e = spawn.get(k);
        e.count += 1;
        e.context.push(sb.contextTokens);
        e.cacheWrite.push(sb.cacheWrite);
        e.cacheRead.push(sb.cacheRead);
      }
    },
  });

  // Guard (a)'s own numbers: what idle-expiry resumes actually cost, over
  // the window. Priced the same way every other dollar figure in this report
  // is (costOf, price-derived); a model this report cannot price is counted
  // in idleExpiryUnpricedTokens rather than silently dropped from the total,
  // same pattern as totals.unpricedRequests below.
  let idleExpiryRewriteTokens = 0;
  let idleExpiryRewriteUsd = 0;
  let idleExpiryUnpricedTokens = 0;
  for (const e of idleExpiryByModel.values()) {
    idleExpiryRewriteTokens += e.tokens;
    const c = costOf(e.usage, e.model);
    if (c) idleExpiryRewriteUsd += c.usd;
    else idleExpiryUnpricedTokens += e.tokens;
  }
  resumeAfterIdle.idleExpiryRewriteTokens = idleExpiryRewriteTokens;
  resumeAfterIdle.idleExpiryRewriteUsd = idleExpiryRewriteUsd;
  resumeAfterIdle.idleExpiryUnpricedTokens = idleExpiryUnpricedTokens;

  const models = [...perModel.values()]
    .map((r) => ({ ...r, usd: r.priced ? r.usd : null }))
    .sort((a, b) => b.requests - a.requests);
  const totals = { requests: 0, usage: emptyUsage(), usd: 0, unpricedRequests: 0 };
  for (const r of models) {
    totals.requests += r.requests;
    addUsage(totals.usage, r.usage);
    if (r.usd == null) totals.unpricedRequests += r.requests; else totals.usd += r.usd;
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    costBasis: basis || PRICE_BASIS,
    options: { workflows, crossFileDedup },
    scan: {
      rootExists: scan.exists, filesFound: scan.filesFound, filesRead: scan.filesRead, filesSkipped: scan.filesSkipped,
      truncated: scan.truncated, crossFile: scan.crossFile,
      wallMs: scan.wallMs, mainFiles: files.main, subagentFiles: files.subagent, filesWithRequestsInWindow: files.withRequests,
    },
    dedup,
    totals,
    perModel: models,
    compactions: {
      count: compaction.count,
      byTrigger: compaction.byTrigger,
      byKind: compaction.byKind,
      preTokensP50: pct(compaction.pre, 50),
      postTokensP50: pct(compaction.post, 50),
      firstContextAfterP50: pct(compaction.firstAfter, 50),
      requestsAfterP50: pct(compaction.requestsAfter, 50),
    },
    // Every gap between consecutive requests, whatever connected them.
    interRequestGaps: [...gapBuckets.values()],
    // The same, split by what connected the two requests (via) and the cache
    // TTL that applied (ttl). Only via prompt/message after more than the TTL
    // is a resume after idle; see resumeAfterIdle.
    gapsByViaTtl: [...byViaTtl.values()]
      .map((e) => ({ via: e.via, ttl: e.ttl, count: e.count, buckets: [...e.buckets.values()].filter((b) => b.count) }))
      .sort((a, b) => b.count - a.count),
    // Gaps where a prompt or SendMessage picked the conversation up again
    // after longer than the TTL (lib/transcripts.mjs isResumeAfterIdle).
    // causes['idle-expiry'] is the count the resume guard uses.
    resumeAfterIdle,
    spawnBaseline: [...spawn.values()]
      .map((e) => ({
        agentType: e.agentType,
        count: e.count,
        contextP50: pct(e.context, 50),
        contextP90: pct(e.context, 90),
        cacheWriteP50: pct(e.cacheWrite, 50),
        cacheReadP50: pct(e.cacheRead, 50),
      }))
      .sort((a, b) => b.count - a.count),
    context: {
      filePeakP50: pct(peaks, 50),
      filePeakP90: pct(peaks, 90),
      growthPerRequestP50: pct(growth, 50),
      growthPerRequestMean: growth.length ? growth.reduce((a, b) => a + b, 0) / growth.length : null,
    },
  };
}
