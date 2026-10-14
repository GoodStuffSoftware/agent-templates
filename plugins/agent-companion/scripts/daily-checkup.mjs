#!/usr/bin/env node
// The daily checkup, run by hand or as the detached background process the scout and the
// main-session SessionStart hook start. No model call, no network.
//
//   node scripts/daily-checkup.mjs [--root <transcripts dir>] [--now <ISO>] [--hold-ms <n>]
//                                  [--max-seconds <n>] [--quiet]
//
// The pipeline, in this order, inside one lock (scripts/lib/usage/pipeline.mjs): scan the transcripts
// (history line and facts files), run the zero-token usage analysis for every settled day that has no
// result yet (a deferred day is retried), write the analysis status, then the decision register.
// --max-seconds bounds the analysis stage between days (default 20 s: a session start never waits on
// it, and what is left resumes on the next run). No waiter is started for a day that is not settled.
//
// Prints one JSON object: the days it wrote, how much it read, and an `analysis` object. The history
// itself is state/daily-checkup-history.jsonl in the agent-companion state dir.
// AGENT_COMPANION_STATE_DIR moves the state dir; AGENT_COMPANION_FAKE_NOW (or --now) moves the
// clock; AGENT_COMPANION_TRANSCRIPTS_ROOT (or --root) moves the transcripts. Exits 0 whatever
// happens: a failed run is retried by the next caller after a few hours.

import { takeLock, dropLock, nowMs, ANALYSIS_BUDGET_SECONDS } from './lib/daily-checkup.mjs';
import { runPipeline } from './lib/usage/pipeline.mjs';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

let out;
if (!takeLock()) {
  out = { skipped: 'another run holds the lock' };
} else {
  try {
    const nowArg = arg('now');
    const nowT = nowArg ? Date.parse(nowArg) : nowMs();
    const holdArg = arg('hold-ms');
    const secArg = arg('max-seconds');
    const when = Number.isFinite(nowT) ? nowT : nowMs();
    ({ out } = runPipeline({
      root: arg('root') || undefined,
      nowT: when,
      ...(holdArg !== undefined && Number.isFinite(Number(holdArg)) ? { holdMs: Number(holdArg) } : {}),
      maxSeconds: secArg !== undefined && Number(secArg) >= 0 ? Number(secArg) : ANALYSIS_BUDGET_SECONDS,
    }));
  } catch (e) {
    out = { error: String((e && e.message) || e).slice(0, 300) };
  } finally {
    dropLock();
  }
}
if (!argv.includes('--quiet')) process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
