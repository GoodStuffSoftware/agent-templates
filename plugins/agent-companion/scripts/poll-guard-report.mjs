#!/usr/bin/env node
// poll-guard-report.mjs — polling-wake episodes across the operator's own
// transcripts (cache-advisor guard b, deliverable 7 measurement half). See
// scripts/lib/poll-guard-report.mjs for the method: it reuses the exact
// evaluate() the live PreToolUse hook (hooks/poll-guard.mjs) calls, so this
// report counts precisely what the guard would have hinted on.
//
// Read-only. Never writes a setting or anything under ~/.claude.
//
// Usage:
//   node poll-guard-report.mjs                 # last 30 days, human report
//   node poll-guard-report.mjs --days 7
//   node poll-guard-report.mjs --json
//
// window's scripts/cache-advisor.mjs (deliverable 2) is the eventual shared
// home for this section — see this file's header note in
// scripts/lib/poll-guard-report.mjs.

import { scanPollGuardEpisodes } from './lib/poll-guard-report.mjs';
import { opt } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

const days = Number(val('--days')) || 30;
const asJson = has('--json');
const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

const result = await scanPollGuardEpisodes({
  sinceMs,
  maxMs: Number(val('--max-ms')) || 20000,
  opts: {
    noopStreak: opt('poll_guard_noop_streak', 2),
    shortDelaySeconds: opt('poll_guard_short_delay_seconds', 600),
    monitorRearmStreak: opt('poll_guard_monitor_rearm_streak', 2),
  },
});

if (asJson) {
  console.log(JSON.stringify({ windowDays: days, ...result }, null, 2));
  process.exit(0);
}

console.log(`poll-guard-report — polling-wake episodes (last ${days}d)`);
console.log(`root: ${result.root}${result.exists ? '' : ' (does not exist)'}`);
console.log(`files: ${result.filesRead}/${result.filesFound} read${result.truncated ? ' (TRUNCATED by time budget)' : ''}`);
console.log('');
console.log(`episodes            : ${result.episodeCount}`);
console.log(`flagged wakes total : ${result.totalWakes}`);
console.log(`context re-read total: ${result.totalContextTokens.toLocaleString()} tokens`);
console.log('');
if (result.byFile.length) {
  console.log('-- by file --');
  for (const f of result.byFile.slice(0, 20)) {
    console.log(`  ${(f.agentType || f.kind).padEnd(24)} episodes=${f.episodeCount}  ${f.path}`);
  }
  if (result.byFile.length > 20) console.log(`  ... and ${result.byFile.length - 20} more file(s)`);
}
