// Soft step warning (replaces the hard maxTurns: 150 backstop on the agent definitions).
//
// Stopping a worker that is making progress costs more than a long run, so a long run is
// only noticed, never cut: when a subagent's own tool-call count reaches 150, and again at
// every further 100 (250, 350, ...), it gets ONE short note as additionalContext and the
// crossing is logged as one JSON line in state/long-runs.jsonl for later evaluation.
// Nothing here ever denies, blocks or stops a call.
//
// Where. hooks/subagent-context.mjs (PreToolUse, subagent only: the payload carries
// agent_id, the lead's does not) calls longRunCheck() on every helper tool call. The count
// is its own one-byte-per-call file (state/long-runs/<agent_id>.cnt; the file size is the
// count, so parallel tool calls cannot lose an increment), independent of the step budget
// so it works with step_budget off. Each threshold is claimed once (exclusive create), and
// the claim is for the highest threshold at or below the count, so a call that races past
// the exact number still fires the note once.
//
// Log row (read by the long-run listing script):
//   { ts, sessionId, agentId, agentType, steps, startedAt, durationMin, description, transcriptPath }
// description is the first non-empty line of the brief (the first user message of the
// helper's transcript), startedAt the transcript's first timestamp; null when unknown.

import { openSync, fstatSync, readSync, closeSync, mkdirSync, appendFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './context.mjs';
import { claimOnce } from './subagent-context.mjs';
import { readBrief } from './step-budget.mjs';
import { safe } from './runaway.mjs';

export const LONG_RUN_FIRST = 150;
export const LONG_RUN_EVERY = 100;
export const LONG_RUN_LOG = 'long-runs.jsonl';
const STATE_TTL_MS = 7 * 86400000;
const DESC_MAX = 200;

const countDir = () => join(stateDir(), 'long-runs');

// The highest threshold (150, 250, 350, ...) at or below n, or null below the first.
export function thresholdFor(n) {
  if (!Number.isFinite(n) || n < LONG_RUN_FIRST) return null;
  return LONG_RUN_FIRST + LONG_RUN_EVERY * Math.floor((n - LONG_RUN_FIRST) / LONG_RUN_EVERY);
}

export const longRunText = (n) =>
  `[agent-companion] Step ${n}: if you are making progress, keep going and update your running notes file now; if you are stuck or looping, stop and report what is blocking.`;

function countCall(agentId) {
  try {
    mkdirSync(countDir(), { recursive: true });
    const f = join(countDir(), `${safe(agentId)}.cnt`);
    appendFileSync(f, '.');
    return statSync(f).size;
  } catch {
    return null;
  }
}

function pruneState(now = Date.now()) {
  let names = [];
  try { names = readdirSync(countDir()); } catch { return; }
  for (const n of names) {
    const f = join(countDir(), n);
    try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

// The timestamp on the first record of the transcript that has one (ISO), else null.
export function readStartedAt(path) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const len = Math.min(fstatSync(fd).size, 64 * 1024);
    if (!len) return null;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"timestamp"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const t = rec && typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function firstLine(text) {
  for (const l of String(text || '').split(/\r?\n/)) {
    const t = l.trim();
    if (t) return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX - 1)}…` : t;
  }
  return null;
}

// Append one crossing row to state/long-runs.jsonl (stateDir honours the plugin's state-dir override).
export function logLongRun(row) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), LONG_RUN_LOG), `${JSON.stringify(row)}
`);
  } catch { /* best effort */ }
}

// The whole check for one helper tool call: count it, and on the first call at or past a
// new threshold return { text, row } (else null). Never throws.
export function longRunCheck(p, { transcript = null, now = new Date() } = {}) {
  try {
    if (!p || !p.agent_id) return null;
    const n = countCall(p.agent_id);
    if (n === null) return null;
    if (n === 1) pruneState();
    const t = thresholdFor(n);
    if (t === null || !claimOnce(`long-run-${p.agent_id}-${t}`)) return null;
    const startedAt = readStartedAt(transcript);
    const dur = startedAt ? (now.getTime() - Date.parse(startedAt)) / 60000 : null;
    return {
      text: longRunText(n),
      row: {
        ts: now.toISOString(),
        sessionId: p.session_id ?? null,
        agentId: p.agent_id,
        agentType: p.agent_type ?? null,
        steps: n,
        startedAt,
        durationMin: dur !== null && Number.isFinite(dur) ? Math.round(dur * 10) / 10 : null,
        description: firstLine(readBrief(transcript)),
        transcriptPath: transcript || null,
      },
    };
  } catch {
    return null;
  }
}
