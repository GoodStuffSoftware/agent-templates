// SessionStart — surface what the locally scheduled scout found.
//
// The stateful signals (harness version delta, zero denials, spawn activity,
// unknown agent types) only exist where the plugin data directory persists,
// which means a scheduled `detect.mjs` on this machine. But a scheduled script
// has no one to tell. This hook reads its last result and puts unresolved
// signals in front of the next person to start a session here.
//
// Zero recurring tokens: the scheduled run is plain node, and this injects a
// few lines of context ONLY when there is a signal. A quiet scout adds nothing.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, opt, dataDirs, stateDir, passthrough } from './lib/context.mjs';
import { syncLegacy } from './lib/state-sync.mjs';

const MAX_AGE_DAYS = 7;

try {
  readStdin();
  if (!opt('scout_surface', true)) passthrough();

  // Recover any durable history left behind under the (pre-0.17.0) plugin
  // data directory before reading anything. Fully fail-open on its own; a
  // SessionStart hook must never block or throw because import had a bad day.
  try { syncLegacy(); } catch { /* fail open */ }

  // scout-latest.json now lives under the durable state root. Fall back to
  // the legacy per-marketplace scan only when that has not been written yet
  // (e.g. the very first run before any scout or import has happened).
  let latest = null;
  const primary = join(stateDir(), 'scout-latest.json');
  if (existsSync(primary)) {
    try { latest = JSON.parse(readFileSync(primary, 'utf8')); } catch { /* fall through */ }
  }
  if (!latest) {
    // Several data dirs can exist (one per marketplace, plus -inline). Take
    // the freshest scout result across all of them.
    for (const d of dataDirs()) {
      const f = join(d, 'scout-latest.json');
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (!latest || Date.parse(j.checkedAt) > Date.parse(latest.checkedAt)) latest = j;
      } catch { /* unreadable: skip */ }
    }
  }
  if (!latest || !Array.isArray(latest.signals) || latest.signals.length === 0) passthrough();

  const ageDays = (Date.now() - Date.parse(latest.checkedAt)) / 86400000;
  if (!(ageDays <= MAX_AGE_DAYS)) passthrough(); // stale results are not news

  const lines = latest.signals.map((s) => `- ${s.kind}: ${s.detail}${s.dispatch && s.dispatch !== 'none' ? ` → ${s.dispatch}` : ''}`);
  const when = latest.checkedAt.slice(0, 16).replace('T', ' ');

  process.stdout.write(JSON.stringify({
    systemMessage: `agent-companion scout (${when}): ${latest.signals.length} signal(s) — ${latest.signals.map((s) => s.kind).join(', ')}`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[agent-companion] The locally scheduled calibration scout last ran ${when} and found:\n${lines.join('\n')}\n` +
        `These are drift signals, not errors. If the user asks about routing, model changes, guards, or costs, mention them; ` +
        `otherwise do not act on them unprompted. The audit skill can investigate: node <plugin>/scripts/audit.mjs --only harness-drift,guard-canary`,
    },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
