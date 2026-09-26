#!/usr/bin/env node
// cache-advisor.mjs — the break-even auto-compact window for each model, the
// one value that suits the operator's model mix, where the prompt-cache money
// goes, and what each subagent spawn costs cold. Read from the operator's own
// transcripts through the shared reader (scripts/lib/transcripts.mjs); the
// method is in scripts/lib/cache-advisor.mjs's header.
//
// ADVICE ONLY: this never writes a Claude Code setting. To act on it, run
// /autocompact <value> in Claude Code yourself. It saves a small summary
// (numbers and model ids) to the plugin's state directory so /ac recommend can
// quote it; --no-save skips that.
//
// Usage:
//   node cache-advisor.mjs                  # last 30 days, human report
//   node cache-advisor.mjs --days 14 --json
//   node cache-advisor.mjs --max-ms 20000   # time budget for reading (newest files first)
//   node cache-advisor.mjs --root <dir>     # a different transcripts root
//   node cache-advisor.mjs --min-turns 10   # fewest turns between compactions to allow
//   node cache-advisor.mjs --curve          # print every model's full cost curve
//   node cache-advisor.mjs --include-bench  # also read benchmark sessions (excluded by default)
//
// A run cut short by --max-ms never replaces a saved full-read summary.

import { runCacheAdvisor, saveAdvisorSummary, formatAdvice } from './lib/cache-advisor.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

const days = Number(val('--days')) || 30;
const advice = await runCacheAdvisor({
  root: val('--root'),
  days,
  maxMs: val('--max-ms') ? Number(val('--max-ms')) : null,
  workflows: has('--workflows'),
  minTurnsPerCompaction: val('--min-turns') ? Number(val('--min-turns')) : undefined,
  includeBench: has('--include-bench'),
});
if (!has('--no-save')) {
  try { advice.savedTo = saveAdvisorSummary(advice); } catch { /* fail open: the report still prints */ }
}

if (has('--json')) {
  console.log(JSON.stringify(advice, null, 2));
  process.exit(0);
}

for (const line of formatAdvice(advice, { curve: has('--curve') })) console.log(line);
