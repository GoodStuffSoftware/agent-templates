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
// from the main thread (PostToolUse, so a spawn another guard denied resets
// nothing), and the guard's own firing. Nothing else writes the streak file.
//
// Which sessions: see ATTENDED_ENV. By default only an attended session is
// counted; a headless one (`claude -p`, a woken or dispatched worker, an SDK
// program, a separate-process teammate) is itself the delegate.

import { opt, stateFile, readJson, writeJsonAtomic } from './context.mjs';
import { withFileLock } from './file-lock.mjs';

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
// one entry per main session, and every attended main session reaches it.
export const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Claude Code sets this in every hook's environment (and the Bash tool's):
// "1" for an attended session (the terminal REPL, desktop, VS Code), "0" for
// one nobody is watching (`claude -p`, SDK programs, background/daemon
// sessions, separate-process teammates, anything launched from inside
// another session's tool call). Read from the 2.1.280/2.1.281 binaries'
// hook env builder; UNDOCUMENTED, so an absent value counts (the pre-scope
// behaviour), the guard records what it saw per session (`attended` below),
// and scripts/detect.mjs raises `attended_env_missing` when a day of counted
// main-thread calls saw it nowhere.
export const ATTENDED_ENV = 'CLAUDE_CODE_SESSION_ATTENDED';
export function attendedValue(env = process.env) {
  const v = env[ATTENDED_ENV];
  return v === undefined ? 'absent' : String(v);
}

// delegation_guard: "off" | "warn" | "block". The option used to be a boolean:
// `true` meant a deny, but main-thread detection never matched a
// real payload, so no install ever saw one — nobody opted into blocking.
// A legacy true therefore reads as the shipped default ("warn"); false, and
// the other plain spellings of "off", read as "off". Anything unrecognised
// falls to "warn", the same direction foreground_guard takes for a typo.
export function delegationMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'block' || v === 'warn') return v;
  if (/^(off|false|0|no|none|disabled?)$/.test(v)) return 'off';
  return 'warn';
}

// delegation_guard_scope: "attended" (default) | "all".
export function delegationScope(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'all' ? 'all' : 'attended';
}

export function delegationThreshold(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(MIN_THRESHOLD, Math.floor(n)) : DEFAULT_THRESHOLD;
}

export function guardSettings() {
  return {
    mode: delegationMode(opt('delegation_guard', 'warn')),
    scope: delegationScope(opt('delegation_guard_scope', 'attended')),
    threshold: delegationThreshold(opt('delegation_threshold', DEFAULT_THRESHOLD)),
  };
}

// True when this session is out of scope: under "attended", a session whose
// hooks see the variable exactly "0". Absent is in scope.
export function outOfScope(scope, env = process.env) {
  return scope !== 'all' && env[ATTENDED_ENV] === '0';
}

// A tool call a remote (cloud) session had this machine run. Its hook input
// carries session_id "served:<caller session>" (or "served:unknown") and no
// transcript: it is not this machine's lead, and every unknown caller would
// share one streak.
export function isServedCall(p) {
  return typeof p?.session_id === 'string' && p.session_id.startsWith('served:');
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

// The streak file's lock. Its critical section is one small read and write,
// milliseconds, and it sits in front of EVERY counted lead call on the
// machine, so it treats a lock older than LOCK_MAX_AGE_MS as stuck whoever
// owns it (file-lock.mjs maxAgeMs): a lock left by a killed hook whose pid
// was then reused is broken by the first call that sees it, instead of
// costing every later call the full wait. Until it is that old, a stuck lock
// costs a call at most LOCK_WAIT_MS. On a timeout the count runs unlocked
// (fail open: at worst a lost update, which reads as a shorter streak).
export const LOCK_WAIT_MS = 1000;
export const LOCK_MAX_AGE_MS = 3000;
function withStreakLock(f, fn) {
  return withFileLock(`${f}.lock`, () => fn(), {
    waitMs: LOCK_WAIT_MS, staleMs: 1000, maxAgeMs: LOCK_MAX_AGE_MS, failOpen: true, debris: [f],
  });
}

// Count one call for `sid` under the lock, and return the countCall verdict
// plus how many times this session has fired (the standing-rules
// 'delegation-drift' gate reads `fired` against `reminded`). `attended` is
// what this call's env said (attendedValue), kept per session for the
// attended_env_missing signal. Never throws: on any failure the verdict is
// "no fire", the fail-open direction.
export function recordExecutionCall(sid, threshold, { now = Date.now(), attended = attendedValue() } = {}) {
  const f = stateFile(STREAK_FILE);
  try {
    return withStreakLock(f, () => {
      const st = prune(readJson(f, {}), now);
      const prev = st[sid] || {};
      const v = countCall(prev.streak, threshold);
      const fired = (prev.fired || 0) + (v.fires ? 1 : 0);
      st[sid] = {
        streak: v.next,
        fired,
        ...(prev.reminded ? { reminded: prev.reminded } : {}),
        ...(v.fires ? { firedAt: now } : (prev.firedAt ? { firedAt: prev.firedAt } : {})),
        touched: now,
        attended,
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
    withStreakLock(f, () => {
      const st = readJson(f, {});
      const e = st && typeof st === 'object' ? st[sid] : null;
      if (!e || !(e.streak > 0)) return;
      st[sid] = { ...e, streak: 0, touched: now };
      writeJsonAtomic(f, prune(st, now));
    });
  } catch { /* fail open */ }
}

// The delegate-reminder standing rule is due once per new firing: when the
// session has fired more times than it has been reminded. Read-only (the
// gate, and `rules test` from the CLI, call it).
export function reminderDue(sid) {
  if (!sid) return false;
  try {
    const e = readJson(stateFile(STREAK_FILE), {})?.[sid];
    return (e?.fired || 0) > (e?.reminded || 0);
  } catch {
    return false;
  }
}

// The reminder went out: catch `reminded` up with `fired`, so the next prompt
// is silent until the guard fires again.
export function markReminded(sid, now = Date.now()) {
  if (!sid) return;
  const f = stateFile(STREAK_FILE);
  try {
    withStreakLock(f, () => {
      const st = readJson(f, {});
      const e = st && typeof st === 'object' ? st[sid] : null;
      if (!e || !((e.fired || 0) > (e.reminded || 0))) return;
      st[sid] = { ...e, reminded: e.fired, touched: now };
      writeJsonAtomic(f, prune(st, now));
    });
  } catch { /* fail open */ }
}

// For scripts/detect.mjs: over entries touched since `since`, how many
// recorded an attended value, and how many of those saw the variable at all.
export function attendedCoverage(st, since) {
  let recorded = 0; let seen = 0;
  for (const e of Object.values(st && typeof st === 'object' ? st : {})) {
    if (!e || typeof e.attended !== 'string' || !(Number(e.touched) >= since)) continue;
    recorded += 1;
    if (e.attended !== 'absent') seen += 1;
  }
  return { recorded, seen };
}
