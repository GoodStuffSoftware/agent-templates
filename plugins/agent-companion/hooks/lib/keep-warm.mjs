// Keep-warm for a lead session (release 0.31.32): while background helpers run, the lead must not go
// cold. A lead's prompt cache lasts one hour; a lead that sits idle past it (waiting on helpers) pays a
// full cache write of its whole conversation on its next turn. A one-shot wakeup inside the window keeps
// it warm for the price of about 1/9 of that rebuild (r-keepwarm-sim-1017: one-shot ping 0.13 u against a
// 1.14 u rebuild premium at 200K context; one-shot pings at 55 min capped at 3 h saved the most).
//
// The mechanism is hook-driven and costs the lead nothing until a helper is spawned in the background:
//   1. PostToolUse of a background Agent spawn: when no wakeup is pending, one note tells the lead to arm
//      ONE wakeup 55 min out (ScheduleWakeup 3300 s, prompt "keep-warm ping"; CronCreate one-shot when it
//      has no ScheduleWakeup).
//   2. PostToolUse of that ScheduleWakeup / CronCreate call: recorded as the pending wakeup.
//   3. UserPromptSubmit of the ping itself: helpers still running and under the cap -> "re-arm ONE more";
//      none running -> "do not re-arm"; cap reached -> "no more pings". So there is never a ping when
//      nothing is running, and never a loop: each ping is armed by the previous one's note, one at a time.
// 55 min is a delay above the poll guard's 600 s line, so hooks/poll-guard.mjs never reads it as a poll.
// Claude Code 2.1.304 fixed 1-hour wakeups firing just after the cache expired; 55 min keeps a 5 min margin
// for older builds as well.
//
// State: state/keep-warm/<session>.json { dueAt, instructedAt, pings }. Never throws; every reader fails open.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, readJson, writeJsonAtomic } from './context.mjs';
import { readWorkers, agentNames } from './advisory-b.mjs';

export const KEEP_WARM_DELAY_S = 3300; // 55 min: inside the 1 h cache window with a 5 min margin
export const KEEP_WARM_MAX_DEFAULT_MIN = 180; // the sim's best cap: pings past 3 h of one idle stretch lose money
export const KEEP_WARM_MARKER = 'keep-warm ping';
// Spawns inside this window of the last instruction do not repeat it (a lead spawns a batch in a row).
const INSTRUCT_DEDUPE_MS = 5 * 60_000;
const ARM_TOOL_RE = /(?:^|__)(?:ScheduleWakeup|CronCreate)$/;
const MARKER_RE = new RegExp(KEEP_WARM_MARKER, 'i');

const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

function stateFile(sessionId) {
  const d = join(stateDir(), 'keep-warm');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return join(d, `${safe(sessionId)}.json`);
}
const readState = (sid) => {
  const s = readJson(stateFile(sid), null);
  return s && typeof s === 'object' ? s : {};
};
const writeState = (sid, st) => { try { writeJsonAtomic(stateFile(sid), st); } catch { /* fail open */ } };

/** Pings allowed in one idle stretch: 3 at the default 180 min (55, 110 and 165 min). 0 turns it off. */
export const maxPings = (maxMinutes = KEEP_WARM_MAX_DEFAULT_MIN) =>
  Math.floor((Math.max(0, Number(maxMinutes) || 0) * 60) / KEEP_WARM_DELAY_S);

/** A PostToolUse payload of an Agent spawn that went to the background. */
export function isBackgroundSpawn(p) {
  if (!p || p.tool_name !== 'Agent') return false;
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
  return input.run_in_background === true || resp.status === 'async_launched' || resp.isAsync === true;
}

function running(p, now) {
  const workers = readWorkers(p.session_id, { transcriptPath: p.transcript_path, now });
  const ids = [...workers].filter(([, w]) => w.running).map(([id]) => id);
  if (!ids.length) return [];
  let names = new Map();
  try { names = agentNames(p.transcript_path, p.session_id); } catch { /* names are a courtesy */ }
  return ids.map((id) => names.get(id) || workers.get(id).agent_type || id);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function armText(n) {
  return `Keep-warm: ${plural(n, 'background helper')} running. Past 1 hour idle this session's prompt cache expires and the next turn re-reads the whole conversation at full price. ` +
    `Arm ONE wakeup now, 55 minutes out: ScheduleWakeup with delaySeconds ${KEEP_WARM_DELAY_S} and prompt "${KEEP_WARM_MARKER}" (no ScheduleWakeup: CronCreate, recurring false, about 55 minutes ahead, same prompt). ` +
    'Arm no second one and never poll: a helper finishing wakes you anyway. On the ping reply "ok" in one word, and re-arm only when the keep-warm note tells you to.';
}

/**
 * PostToolUse, lead only. A background Agent spawn: the arm instruction when no wakeup is pending (or null).
 * A ScheduleWakeup / CronCreate call carrying the marker: records the pending wakeup (returns null).
 */
export function keepWarmToolNote(p, { now = Date.now(), maxMinutes = KEEP_WARM_MAX_DEFAULT_MIN } = {}) {
  try {
    if (!p || !p.session_id || maxPings(maxMinutes) < 1) return null;
    if (ARM_TOOL_RE.test(String(p.tool_name || ''))) {
      const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
      if (!MARKER_RE.test(JSON.stringify(input))) return null;
      const delay = Number(input.delaySeconds);
      const st = readState(p.session_id);
      writeState(p.session_id, { ...st, dueAt: now + (Number.isFinite(delay) && delay > 0 ? delay * 1000 : KEEP_WARM_DELAY_S * 1000) });
      return null;
    }
    if (!isBackgroundSpawn(p)) return null;
    const st = readState(p.session_id);
    // A new spawn is real activity: the idle stretch (and its ping cap) starts over.
    const next = { ...st, pings: 0 };
    const pending = Number(st.dueAt) > now + 60_000;
    const justTold = Number(st.instructedAt) > 0 && now - Number(st.instructedAt) < INSTRUCT_DEDUPE_MS;
    if (pending || justTold) { writeState(p.session_id, next); return null; }
    next.instructedAt = now;
    writeState(p.session_id, next);
    // The spawn's own SubagentStart row may not be written yet: at least this one helper is running.
    return armText(Math.max(1, running(p, now).length));
  } catch { return null; }
}

/**
 * UserPromptSubmit, lead only: the decision at a keep-warm ping. Null for any other prompt.
 * Helpers running and ping count under the cap -> re-arm one; none running -> stop; cap reached -> stop.
 */
export function keepWarmPingNote(p, { now = Date.now(), maxMinutes = KEEP_WARM_MAX_DEFAULT_MIN } = {}) {
  try {
    if (!p || !p.session_id || typeof p.prompt !== 'string' || !MARKER_RE.test(p.prompt)) return null;
    const limit = maxPings(maxMinutes);
    if (limit < 1) return null;
    const st = readState(p.session_id);
    const pings = (Number(st.pings) || 0) + 1;
    const live = running(p, now);
    if (!live.length) {
      writeState(p.session_id, { ...st, pings: 0, dueAt: 0 });
      return 'Keep-warm ping: no helpers running. Reply "ok" in one word and do not re-arm; nothing keeps this session warm now.';
    }
    writeState(p.session_id, { ...st, pings, dueAt: 0 });
    const who = [...new Set(live)].slice(0, 4).join(', ');
    if (pings >= limit) {
      return `Keep-warm ping ${pings} of ${limit}: ${plural(live.length, 'helper')} still running (${who}). Cap reached (${limit} pings, about 3 h idle): reply "ok" in one word and do not re-arm; the cache goes cold unless a helper reports first.`;
    }
    return `Keep-warm ping ${pings} of ${limit}: ${plural(live.length, 'helper')} still running (${who}). Reply "ok" in one word, then arm ONE more wakeup: ScheduleWakeup delaySeconds ${KEEP_WARM_DELAY_S}, prompt "${KEEP_WARM_MARKER}" (or CronCreate one-shot about 55 minutes ahead).`;
  } catch { return null; }
}
