#!/usr/bin/env node
// The daily checkup, run by hand or as the detached background process the scout
// and the main-session SessionStart hook start. No model call, no network.
//
//   node scripts/daily-checkup.mjs [--root <transcripts dir>] [--now <ISO>] [--hold-ms <n>] [--quiet]
//
// Prints one JSON object: the days it wrote, how much it read. The history
// itself is state/daily-checkup-history.jsonl in the agent-companion state dir.
// AGENT_COMPANION_STATE_DIR moves the state dir; AGENT_COMPANION_FAKE_NOW (or
// --now) moves the clock; AGENT_COMPANION_TRANSCRIPTS_ROOT (or --root) moves
// the transcripts. Exits 0 whatever happens: a failed run is retried by the
// next caller after a few hours.

import { runCheckup, takeLock, dropLock, nowMs } from './lib/daily-checkup.mjs';
import { runRegister } from './lib/decision-register.mjs';
import { opt } from '../hooks/lib/context.mjs';

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
    const when = Number.isFinite(nowT) ? nowT : nowMs();
    out = runCheckup({
      root: arg('root') || undefined,
      nowT: when,
      ...(holdArg !== undefined && Number.isFinite(Number(holdArg)) ? { holdMs: Number(holdArg) } : {}),
    });
    // The decision register reads the day records the checkup just wrote. Still inside the
    // lock; runRegister never throws, and no register means no work.
    try { if (opt('decision_register', true)) runRegister({ nowT: when }); } catch { /* advisory */ }
  } catch (e) {
    out = { error: String((e && e.message) || e).slice(0, 300) };
  } finally {
    dropLock();
  }
}
if (!argv.includes('--quiet')) process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
