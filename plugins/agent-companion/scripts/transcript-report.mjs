#!/usr/bin/env node
// transcript-report.mjs — what the transcripts say about tokens, cache,
// compaction, resume gaps and spawn cost, read through the shared reader
// (scripts/lib/transcripts.mjs). Read-only; no network, no model calls.
//
// Usage:
//   node transcript-report.mjs                    # last 30 days, human report
//   node transcript-report.mjs --days 7 --json    # machine-readable
//   node transcript-report.mjs --root <dir>       # a different transcripts root
//   node transcript-report.mjs --workflows        # include workflow agents
//   node transcript-report.mjs --no-cross-file-dedup   # count copied requests again (for comparison)
//   node transcript-report.mjs --max-ms 20000     # stop reading after a time budget (newest files first)
//
// Dollar figures are price-derived (list price x tokens), not billed amounts.

import { buildTranscriptReport } from './lib/transcript-report.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

const report = await buildTranscriptReport({
  root: val('--root'),
  days: Number(val('--days')) || 30,
  workflows: has('--workflows'),
  crossFileDedup: !has('--no-cross-file-dedup'),
  maxMs: val('--max-ms') ? Number(val('--max-ms')) : null,
});

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const n = (x) => (x == null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const m = (x) => `${(x / 1e6).toFixed(2)}M`;
const usd = (x) => (x == null ? 'unpriced' : `$${x.toFixed(2)}`);

const s = report.scan;
console.log(`transcript-report — last ${report.windowDays}d (${report.generatedAt})`);
if (!s.rootExists) console.log('transcripts root not found — nothing to report');
console.log(`files: ${s.filesRead} read of ${s.filesFound} found (${s.mainFiles} main, ${s.subagentFiles} subagent), `
  + `${s.filesWithRequestsInWindow} with requests in window, ${(s.wallMs / 1000).toFixed(1)}s`
  + `${s.truncated ? ` — TRUNCATED (${s.filesSkipped} files skipped; newest were read first)` : ''}`);
if (s.crossFile) {
  console.log(`cross-file: ${n(s.crossFile.ids)} request ids in more than one file; max over copies changed ${n(s.crossFile.idsMaxDiffers)}, `
    + `original file is not the first in path order for ${n(s.crossFile.ownerNotPathFirst)}`);
}
const d = report.dedup;
console.log(`dedup: ${n(d.reloggedLines)} re-logged lines, ${n(d.duplicateUuidLines)} duplicate-uuid lines, `
  + `${n(d.crossFileDuplicates)} cross-file copies${report.options.crossFileDedup ? ' (not counted)' : ' (dedup off)'}, `
  + `${n(d.unparseableLines)} unparseable lines, ${d.truncatedTails} truncated tails`);
console.log('');

console.log(`-- per model (costs are ${report.costBasis}) --`);
for (const r of report.perModel) {
  console.log(`  ${String(r.model).padEnd(30)} req=${String(r.requests).padEnd(7)} main=${String(r.mainRequests).padEnd(6)} sub=${String(r.subagentRequests).padEnd(6)} `
    + `in=${m(r.usage.input).padEnd(8)} out=${m(r.usage.output).padEnd(8)} read=${m(r.usage.cacheRead).padEnd(9)} `
    + `write=${m(r.usage.cacheWrite).padEnd(8)} (1h ${m(r.usage.cacheWrite1h)}) ${usd(r.usd)}`);
}
const t = report.totals;
console.log(`  ${'TOTAL'.padEnd(30)} req=${String(t.requests).padEnd(7)} ${usd(t.usd)}${t.unpricedRequests ? ` (+${t.unpricedRequests} unpriced requests)` : ''}`);
console.log('');

const c = report.compactions;
console.log('-- compactions --');
console.log(`  count ${c.count}  by trigger ${JSON.stringify(c.byTrigger)}  by kind ${JSON.stringify(c.byKind)}`);
console.log(`  pre p50 ${n(c.preTokensP50)}  post p50 ${n(c.postTokensP50)}  first context after p50 ${n(c.firstContextAfterP50)}  requests after p50 ${n(c.requestsAfterP50)}`);
console.log('');

const gapLine = (b, indent) => `${indent}${b.label.padEnd(7)} ${String(b.count).padEnd(8)} hit ${String(b.hits).padEnd(8)} rewrite ${String(b.rewrites).padEnd(6)} `
  + `(idle ${b.causes['idle-expiry']}, prefix ${b.causes['prefix-change']}, compaction ${b.causes.compaction}) rewritten ${m(b.rewriteTokens)}`;
console.log('-- gaps between requests (start to start, same transcript) --');
for (const b of report.interRequestGaps) if (b.count) console.log(gapLine(b, '  '));
console.log('  by what connected them (via) and the cache TTL that applied:');
for (const e of report.gapsByViaTtl) {
  console.log(`    via ${e.via} / ttl ${e.ttl}: ${e.count}`);
  for (const b of e.buckets) console.log(gapLine(b, '      '));
}
const ra = report.resumeAfterIdle;
console.log(`  resumed after idle (prompt or message, gap > TTL): ${ra.count}, hit ${ra.hits}, rewrite ${ra.rewrites} `
  + `(idle-expiry ${ra.causes['idle-expiry']}) ${JSON.stringify(ra.byKindTtl)}`);
console.log('');

console.log('-- spawn baseline (first request of each subagent) --');
for (const e of report.spawnBaseline.slice(0, 15)) {
  console.log(`  ${e.agentType.padEnd(30)} n=${String(e.count).padEnd(5)} context p50 ${n(e.contextP50).padEnd(8)} p90 ${n(e.contextP90).padEnd(8)} write p50 ${n(e.cacheWriteP50)}`);
}
if (report.spawnBaseline.length > 15) console.log(`  … ${report.spawnBaseline.length - 15} more (--json for all)`);
console.log('');

const x = report.context;
console.log(`-- context -- file peak p50 ${n(x.filePeakP50)} p90 ${n(x.filePeakP90)}; growth per request p50 ${n(x.growthPerRequestP50)} mean ${n(x.growthPerRequestMean)}`);
