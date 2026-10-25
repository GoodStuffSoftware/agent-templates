// Keep-warm for a lead session (release 0.31.32): while background helpers run, the lead must not go
// cold. A lead's prompt cache lasts one hour; a lead that sits idle past it (waiting on helpers) pays a
// full cache write of its whole conversation on its next turn. A one-shot wakeup inside the window keeps
// it warm for the price of about 1/9 of that rebuild (r-keepwarm-sim-1017: one-shot ping 0.13 u against a
// 1.14 u rebuild premium at 200K context; one-shot pings at 55 min capped at 3 h saved the most).
//
// 0.31.36: the arm note is one line under 160 characters and only on the transition from no helper to a helper running
// (PostToolUse updatedToolOutput, which would keep it out of the chat, was not confirmed for Agent: see CHANGELOG).
//
// The mechanism is hook-driven and costs the lead nothing until a helper is spawned in the background:
//   1. PostToolUse of a background Agent spawn: when no wakeup is pending, one note tells the lead to arm
//      ONE wakeup 55 min out (CronCreate one-shot, recurring false, prompt "[ac-keep-warm] ping"; ScheduleWakeup
//      3300 s as the alternative where it exists: it is not in every harness).
//   2. PostToolUse of that CronCreate / ScheduleWakeup call: recorded as the pending wakeup.
//   3. UserPromptSubmit of the ping itself: helpers still running and under the cap -> "re-arm ONE more";
//      none running -> "do not re-arm"; cap reached -> "no more pings". Nothing is armed while nothing runs
//      (one trailing ping may fire up to 55 min after the last helper ends and says do not re-arm), and there
//      is never a loop: each ping is armed by the previous one's note, one at a time.
// 55 min is a delay above the poll guard's 600 s line, so hooks/poll-guard.mjs never reads it as a poll.
// Claude Code 2.1.304 fixed 1-hour wakeups firing just after the cache expired; 55 min keeps a 5 min margin
// for older builds as well.
//
// State: state/keep-warm/<session>.json { dueAt, pings } plus a keep-warm-told claim marker. Never throws; every reader fails open.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, readJson, writeJsonAtomic, canonicalTaskType } from './context.mjs';
import { readWorkers, agentNames, claimOnce } from './advisory-b.mjs';
import { briefStepInfo } from './step-budget.mjs';

export const KEEP_WARM_DELAY_S = 3300; // 55 min: inside the 1 h cache window with a 5 min margin
export const KEEP_WARM_MAX_DEFAULT_MIN = 180; // the sim's best cap: pings past 3 h of one idle stretch lose money
export const KEEP_WARM_MARKER = '[ac-keep-warm]';
export const KEEP_WARM_PROMPT = `${KEEP_WARM_MARKER} ping`; // the whole prompt the lead arms
// Only the plugin's own short prompt counts as a ping: a manual keep-warm prompt or a chat that mentions
// the marker must not be decided on (the marker must open the prompt, and the prompt stay short).
const PING_PROMPT_MAX = 80;
// Spawns inside this window of the last instruction do not repeat it (a lead spawns a batch in a row).
const INSTRUCT_DEDUPE_MS = 5 * 60_000;
const ARM_TOOL_RE = /(?:^|__)(?:ScheduleWakeup|CronCreate)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_RE = new RegExp(escapeRe(KEEP_WARM_MARKER), 'i');
const isPingPrompt = (s) => typeof s === 'string' && s.trim().length <= PING_PROMPT_MAX && s.trim().toLowerCase().startsWith(KEEP_WARM_MARKER);

// A helper that finishes in minutes needs no wakeup: its result lands inside the cache window anyway.
// Measured (bleed-data, 1131 helpers, 10-16 to 10-23): the median helper makes 37 calls in 10.6 min of wall
// time, 9 in 10 finish in 55 min (calls p90 77), and the short rungs sit far under that (ac-haiku and
// ac-sonnet-low p90 wall 4.8 and 8.1 min, 19 calls at p90). So a brief typed lookup, explore or verify, or
// with a BUDGET under 40 calls (about 11 min at the median pace), does not arm a ping. Anything else still
// does: the helpers past the 55 min line (about 10% of them, mostly long writers) are what the ping is for.
export const KEEP_WARM_SKIP_TYPES = ['lookup', 'explore', 'verify'];
export const KEEP_WARM_MIN_BUDGET = 40;

/** Why a background spawn's brief is not worth a keep-warm ping, or null. */
export function shortHelperReason(input) {
  try {
    const prompt = input && typeof input === 'object' ? input.prompt : '';
    const { type, budget } = briefStepInfo(prompt);
    const t = type ? (canonicalTaskType(type)?.name || type) : '';
    if (t && KEEP_WARM_SKIP_TYPES.includes(t)) return `TYPE ${t}`;
    if (budget && budget < KEEP_WARM_MIN_BUDGET) return `BUDGET ${budget}`;
  } catch { /* an unreadable brief arms as before */ }
  return null;
}

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

/** Pings allowed in one idle stretch: 3 at the default 180 min (55, 110 and 165 min). Below 55 minutes (or 0) it is off. */
export const maxPings = (maxMinutes = KEEP_WARM_MAX_DEFAULT_MIN) =>
  Math.floor((Math.max(0, Number(maxMinutes) || 0) * 60) / KEEP_WARM_DELAY_S);

/** A PostToolUse payload of an Agent spawn that went to the background. */
export function isBackgroundSpawn(p) {
  if (!p || p.tool_name !== 'Agent') return false;
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
  return input.run_in_background === true || resp.status === 'async_launched' || resp.isAsync === true;
}

function running(p, now, exceptId = null) {
  const workers = readWorkers(p.session_id, { transcriptPath: p.transcript_path, now });
  const ids = [...workers].filter(([id, w]) => w.running && id !== exceptId).map(([id]) => id);
  if (!ids.length) return [];
  let names = new Map();
  try { names = agentNames(p.transcript_path, p.session_id); } catch { /* names are a courtesy */ }
  return ids.map((id) => names.get(id) || workers.get(id).agent_type || id);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// One short line (under 160 characters): it reaches the lead as additionalContext, which the app shows.
// 0.31.36: the full instruction is gone; the ping notes below still carry the re-arm wording.
export function armText(n) {
  return `Keep-warm: ${plural(n, 'helper')} running. Arm ONE CronCreate wakeup 55 min out (recurring false, prompt "${KEEP_WARM_PROMPT}"); the cache expires after 1 h idle.`;
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
    // A short helper (lookup, explore, verify, or a BUDGET under 40) is no reason to arm: touches no state.
    if (shortHelperReason(p.tool_input)) return null;
    const st = readState(p.session_id);
    // A new spawn is real activity: the idle stretch (and its ping cap) starts over.
    const next = { ...st, pings: 0 };
    const pending = Number(st.dueAt) > now;
    writeState(p.session_id, next);
    if (pending) return null;
    // 0.31.36: told only on the 0-to-N helpers transition: another helper already running (this spawn's own
    // agent id left out) means the lead has been told and a wakeup is its business.
    const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
    if (running(p, now, typeof resp.agentId === 'string' ? resp.agentId : null).length > 0) return null;
    // Exclusive create: a parallel batch of spawns gets one note, not several.
    if (!claimOnce('keep-warm-told', p.session_id, Math.floor(now / INSTRUCT_DEDUPE_MS))) return null;
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
    if (!p || !p.session_id || !isPingPrompt(p.prompt)) return null;
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
    return `Keep-warm ping ${pings} of ${limit}: ${plural(live.length, 'helper')} still running (${who}). Reply "ok" in one word, then arm ONE more wakeup: CronCreate recurring false, a cron for now + 55 minutes in local time, prompt "${KEEP_WARM_PROMPT}" (or ScheduleWakeup delaySeconds ${KEEP_WARM_DELAY_S} where it exists).`;
  } catch { return null; }
}
