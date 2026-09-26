#!/usr/bin/env node
// cache-ttl.mjs — would a 1-hour subagent prompt-cache TTL save or cost usage,
// for THIS operator, measured against their own transcripts?
//
// Read-only. Never writes a setting, an agent definition, or anything under
// ~/.claude — the whole feature is a report. See scripts/lib/cache-ttl.mjs
// for the method (gap bands, conversion clamp, cost formulas) and why it is
// scoped to subagent requests for the financial analysis.
//
// Usage:
//   node cache-ttl.mjs                  # last 30 days, human report
//   node cache-ttl.mjs --days 60        # a different window
//   node cache-ttl.mjs --json           # machine-readable (perRung is sorted and
//                                       # rounded so two dates' outputs diff cleanly)
//   node cache-ttl.mjs --include-experiments   # also count bench / temp-dir projects
//
// Also registered in audit.mjs as `--only cache-ttl` (see scripts/checks.mjs).

import { computeCacheTtl, transcriptsRoot } from './lib/cache-ttl.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

const days = Number(val('--days')) || 30;
const asJson = has('--json');

const includeExperiments = has('--include-experiments');

const result = await computeCacheTtl({ days, transcriptsRoot: transcriptsRoot(), includeExperiments });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const fmtUsd = (n) => `$${n.toFixed(2)}`;
const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtMTok = (n) => `${n.toFixed(3)} MTok`;
const fmtMs = (ms) => (ms == null ? 'n/a' : ms < 60000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60000).toFixed(1)}m`);

console.log(`cache-ttl — subagent prompt-cache TTL analysis (last ${result.windowDays}d)`);
console.log(`generated: ${result.generatedAt}`);
console.log(`experiment projects: ${result.experimentProjects.included ? 'INCLUDED (--include-experiments)' : `${result.experimentProjects.excludedProjects} excluded (bench / system-temp-dir projects; --include-experiments counts them)`}`);
console.log(`files scanned:${result.filesScanned.main} main, ${result.filesScanned.subagent} subagent${result.truncated ? ' (TRUNCATED by file/byte cap)' : ''}`);
console.log(`subagent requests in window: ${result.subagentRequestsScanned}  |  main-session requests in window: ${result.mainRequestsScanned}`);
console.log('');

console.log('-- totals (subagent requests, priced models only) --');
console.log(`  requests            : ${result.totals.requests}`);
console.log(`  5-60min band        : ${result.totals.band560Requests}`);
console.log(`  write               : ${fmtMTok(result.totals.writeMTok)}`);
console.log(`  converted (5-60)    : ${fmtMTok(result.totals.convMTok)}  (${result.totals.convOverWritePct.toFixed(1)}% of write)`);
console.log(`  cost today (5m)     : ${fmtUsd(result.totals.costToday)}`);
console.log(`  cost with 1h        : ${fmtUsd(result.totals.cost1h)}`);
console.log(`  delta               : ${fmtPct(result.totals.deltaPct)}`);
console.log('');

console.log('-- gap bands --');
console.log(`  under 5min          : ${result.bands.lt5.count}`);
console.log(`  5-60min             : ${result.bands['5to60'].count}`);
console.log(`  over 60min          : ${result.bands.gt60.count}`);
console.log(`  first-in-file (n/a) : ${result.bands.firstInFile}`);
console.log('');

console.log('-- sanity check (observed cache_read / (read+write), by band) --');
console.log(`  under 5min  (~100% expected) : ${result.sanity.lt5 == null ? 'n/a' : result.sanity.lt5.toFixed(1) + '%'}`);
console.log(`  5-60min     (~0% expected)   : ${result.sanity['5to60'] == null ? 'n/a' : result.sanity['5to60'].toFixed(1) + '%'}`);
console.log('');

console.log('-- 5-60min gap causes --');
console.log(`  long tool call      : ${result.causes.counts['long-tool-call'] || 0}`);
console.log(`  resume by lead      : ${result.causes.counts['resume-by-lead'] || 0}`);
console.log(`  unknown             : ${result.causes.counts.unknown || 0}`);
console.log(`  compaction (any band, conv forced to 0) : ${result.causes.counts.compaction || 0}`);
console.log(`  tool wait p10/p50/p90: ${fmtMs(result.causes.toolWaitMsP10)} / ${fmtMs(result.causes.toolWaitMsP50)} / ${fmtMs(result.causes.toolWaitMsP90)}`);
if (result.causes.topTools.length) {
  console.log(`  top tools waited on : ${result.causes.topTools.map(([t, c]) => `${t}(${c})`).join(', ')}`);
}
console.log('');

console.log('-- per model --');
for (const r of result.perModel) {
  console.log(`  ${r.label.padEnd(12)} req=${String(r.requests).padEnd(6)} 5-60=${String(r.band560Requests).padEnd(5)} `
    + `write=${r.writeMTok.toFixed(3).padEnd(8)} conv/W=${r.convOverWritePct.toFixed(1).padEnd(5)}% `
    + `breakeven=${r.breakEvenPct.toFixed(1).padEnd(5)}% today=${fmtUsd(r.costToday).padEnd(10)} `
    + `1h=${fmtUsd(r.cost1h).padEnd(10)} delta=${fmtPct(r.deltaPct)}`);
}
console.log('');

console.log('-- per agentType x model --');
for (const r of result.perAgentModel) {
  console.log(`  ${r.label.padEnd(28)} req=${String(r.requests).padEnd(6)} write=${r.writeMTok.toFixed(3).padEnd(8)} `
    + `conv/W=${r.convOverWritePct.toFixed(1).padEnd(5)}% delta=${fmtPct(r.deltaPct)}`);
}
console.log('');

if (result.unknownModels.length) {
  console.log('-- unknown models (excluded from every total) --');
  for (const u of result.unknownModels) console.log(`  ${u.model}: ${u.count} request(s)`);
  console.log('');
}

console.log('-- main-session write split (confirms the setting does not touch main) --');
console.log(`  requests            : ${result.mainSession.requestsScanned}`);
console.log(`  5m write            : ${fmtMTok(result.mainSession.write5mMTok)}`);
console.log(`  1h write            : ${fmtMTok(result.mainSession.write1hMTok)}`);
console.log(`  1h share            : ${result.mainSession.write1hSharePct == null ? 'n/a' : result.mainSession.write1hSharePct.toFixed(1) + '%'}`);
console.log(`  subagents already writing 1h? : ${result.subagentsAlreadyWriting1h ? `YES (${fmtMTok(result.subagentWrite1hMTok)}) — the setting may already be in effect for some agents` : 'no'}`);
console.log('');

console.log('-- policy comparison --');
console.log(`  all 5-minute (today)         : ${fmtUsd(result.policy.allFiveMin)}`);
console.log(`  all 1-hour                   : ${fmtUsd(result.policy.allOneHour)}  (${fmtPct(result.policy.allOneHourDeltaPct)})`);
console.log(`  1h for opus/fable tier only  : ${fmtUsd(result.policy.oneHourOpusFableOnly)}  (${fmtPct(result.policy.opusFableOnlyDeltaPct)})`);
console.log('');

console.log('-- break-even: observed rewrite share vs. required, per tier (always shown) --');
for (const b of result.breakEvenByTier) {
  console.log(`  ${b.alias.padEnd(12)} observed=${b.observedPct.toFixed(1).padEnd(6)}% breakeven=${b.breakEvenPct.toFixed(1).padEnd(6)}% `
    + `spend-share=${b.spendSharePct.toFixed(1).padEnd(6)}% delta=${fmtPct(b.deltaPct)}`);
}
console.log('');

console.log(`-- per rung: 1h net saving, and each gap kind's share of it (experiment projects ${result.experimentProjects.included ? 'INCLUDED' : `excluded: ${result.experimentProjects.excludedProjects}`}) --`);
console.log(`  floor for a verdict: >=${result.rungFloor.files} files, >=${result.rungFloor.requests} requests, >=${result.rungFloor.viewGaps5to60} 5-60min gaps`);
console.log('  baseline = the 2x write premium with no gap credited; the gap kinds\' contributions sum to (all - baseline)');
for (const r of result.perRung) {
  const s = r.sample;
  const a = r.views.all;
  console.log(`  ${r.rung}  [${r.models.join(',')}] files=${s.files} req=${s.requests} gaps=${s.gaps} 5-60=${s.gaps5to60} resume-rewrites=${r.resumeRewrites}`);
  console.log(`    all        gaps=${String(a.gaps5to60).padEnd(5)} net=${fmtUsd(a.netSavingUsd).padEnd(10)} delta=${fmtPct(a.deltaPct).padEnd(8)} ${a.verdict}`);
  console.log(`    baseline   net=${fmtUsd(r.baseline.netSavingUsd)}`);
  for (const [v, x] of Object.entries(r.views)) {
    if (v === 'all') continue;
    console.log(`    ${v.padEnd(10)} gaps=${String(x.gaps5to60).padEnd(5)} contributes=${fmtUsd(x.contributionUsd).padEnd(10)} share=${x.sharePct.toFixed(1)}%`);
  }
}
console.log('');

console.log(`VERDICT: ${result.verdict}`);

process.exit(0);
