// The delegation guard's rules, kept apart from the hook so the one state
// machine is the thing the hook runs AND the thing a transcript replay runs:
// a replay that re-implemented the counting would measure a guard nobody ships.
//
// What counts: EXECUTION_TOOLS, the tools that put token volume on the main
// thread. Exactly the hooks.json PreToolUse matcher for delegation-guard.mjs
// (tests/delegation-guard.test.mjs holds the two equal). Everything else is
// never counted and never blocked — Agent, SendMessage, ToolSearch,
// AskUserQuestion, TaskStop, TaskOutput, every mcp__* tool (an agent bus and
// task board included) and anything that only reads notifications — so
// a lead the guard has stopped can always still delegate, message a worker
// and talk to the operator. The hook re-checks the set itself, so widening
// the matcher by hand cannot widen what the guard counts.
//
// What resets the streak: an Agent spawn or a SendMessage that actually ran
// (PostToolUse, so a spawn another guard denied resets nothing), and the
// guard's own firing.

import { opt, stateFile, readJson, writeJsonAtomic } from './context.mjs';
import { withStateLock } from './premium-window.mjs';

export const EXECUTION_TOOLS = Object.freeze([
  'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob',
]);
const EXECUTION_SET = new Set(EXECUTION_TOOLS);
export function isExecutionTool(name) { return EXECUTION_SET.has(String(name || '')); }

export const RESET_TOOLS = Object.freeze(['Agent', 'SendMessage']);
const RESET_SET = new Set(RESET_TOOLS);
export function isResetTool(name) { return RESET_SET.has(String(name || '')); }

export const DEFAULT_THRESHOLD = 4;
export const MIN_THRESHOLD = 2;
export const STREAK_FILE = 'delegation-streak.json';
// Entries untouched this long are dropped on the next write: the file holds
// one entry per main session, and every main session now reaches it.
export const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// delegation_guard: "off" | "warn" | "block". The option used to be a boolean:
// `true` meant a deny, but main-thread detection never matched a
// real payload, so no install ever saw one — nobody opted into blocking.
// A legacy true therefore reads as the shipped default ("warn"), false as
// "off". Anything unrecognised falls to "warn", the same direction
// foreground_guard takes for a typo.
export function delegationMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'block' || v === 'warn') return v;
  if (/^(false|0|no)$/.test(v)) return 'off';
  return 'warn';
}

export function delegationThreshold(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(MIN_THRESHOLD, Math.floor(n)) : DEFAULT_THRESHOLD;
}

export function guardSettings() {
  return {
    mode: delegationMode(opt('delegation_guard', 'warn')),
    threshold: delegationThreshold(opt('delegation_threshold', DEFAULT_THRESHOLD)),
  };
}

// One execution-class call on the main thread. `prev` is the streak before
// it. Returns the streak this call makes, whether the guard fires on it, and
// the streak to store: 0 after a firing, so in block mode the denied call,
// repeated, passes as call 1 of a new streak — the escape hatch.
export function countCall(prev, threshold) {
  const streak = (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1;
  const fires = streak >= threshold;
  return { streak, fires, next: fires ? 0 : streak };
}

function prune(st, now) {
  const out = {};
  for (const [sid, e] of Object.entries(st && typeof st === 'object' ? st : {})) {
    const at = Number(e?.touched ?? e?.firedAt ?? 0);
    if (now - at < ENTRY_TTL_MS) out[sid] = e;
  }
  return out;
}

// Count one call for `sid` under the state lock, and return the countCall
// verdict plus how many times this session has fired (the standing-rules
// 'delegation-drift' gate reads `fired`). Never throws: on any failure the
// verdict is "no fire", the fail-open direction.
export function recordExecutionCall(sid, threshold, now = Date.now()) {
  const f = stateFile(STREAK_FILE);
  try {
    return withStateLock(f, () => {
      const st = prune(readJson(f, {}), now);
      const prev = st[sid] || {};
      const v = countCall(prev.streak, threshold);
      const fired = (prev.fired || 0) + (v.fires ? 1 : 0);
      st[sid] = {
        streak: v.next,
        fired,
        ...(v.fires ? { firedAt: now } : (prev.firedAt ? { firedAt: prev.firedAt } : {})),
        touched: now,
      };
      writeJsonAtomic(f, st);
      return { ...v, fired };
    });
  } catch {
    return { streak: 0, fires: false, next: 0, fired: 0 };
  }
}

// An Agent spawn or SendMessage ran: the lead delegated, so its streak ends.
// Writes only when there is a streak to clear.
export function resetStreak(sid, now = Date.now()) {
  const f = stateFile(STREAK_FILE);
  try {
    withStateLock(f, () => {
      const st = readJson(f, {});
      const e = st && typeof st === 'object' ? st[sid] : null;
      if (!e || !(e.streak > 0)) return;
      st[sid] = { ...e, streak: 0, touched: now };
      writeJsonAtomic(f, prune(st, now));
    });
  } catch { /* fail open */ }
}
