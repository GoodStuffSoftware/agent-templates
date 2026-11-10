// Long-run marker (replaces the hard maxTurns: 150 backstop on the agent definitions).
//
// Stopping a worker that is making progress costs more than a long run, so a long run is
// only noticed, never cut. When a subagent's own tool-call count reaches 150, and again at
// every further 100 (250, 350, ...): the crossing is logged as one JSON line in
// state/long-runs.jsonl; the LEAD session is told once per mark (hooks/lib/advisory-b.mjs
// longRunNotices, from the lead-side advisory hook); the WORKER hears one neutral line, at the
// first mark only, that says it is a progress marker and asks only that it keeps its detail file
// current. Nothing here ever denies, blocks or stops a call (operator ruling 2026-11-10: a step
// count must not act as a cap; "we just want to know when something is taking a long time").
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
// When a worker that passed the first mark ends, one more row, kind "summary", is appended (longRunSummaryRow, below).

import { openSync, fstatSync, readSync, closeSync, mkdirSync, appendFileSync, statSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, modelTiers } from './context.mjs';
import { claimOnce } from './subagent-context.mjs';
import { readBrief, briefAllowanceOnly, briefStepInfo } from './step-budget.mjs';
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

// What the worker itself is told at the first mark. A progress marker, never a cap: it does not mention a budget, a limit, finishing or
// stopping (tests/long-run.test.mjs pins that), because a worker reads any such word as an instruction to wrap up (operator ruling 2026-11-10).
export const longRunText = (n) =>
  `[agent-companion] Step ${n}: this is a progress marker, not a cap, and nothing will interrupt your run. Carry on as you were; the only ask is that you keep your detail file current.`;


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

// Append one crossing row to state/long-runs.jsonl (stateDir follows the plugin state root).
export function logLongRun(row) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), LONG_RUN_LOG), `${JSON.stringify(row)}
`);
  } catch { /* best effort */ }
}

// The log row for a crossing at n steps (the schema in the header).
export function longRunRow(p, n, transcript = null, now = new Date()) {
  const startedAt = readStartedAt(transcript);
  const dur = startedAt ? (now.getTime() - Date.parse(startedAt)) / 60000 : null;
  return {
    ts: now.toISOString(),
    sessionId: p.session_id ?? null,
    agentId: p.agent_id ?? null,
    agentType: p.agent_type ?? null,
    steps: n,
    startedAt,
    durationMin: dur !== null && Number.isFinite(dur) ? Math.max(0, Math.round(dur * 10) / 10) : null, // a clock skew never shows as negative minutes
    description: firstLine(readBrief(transcript)),
    transcriptPath: transcript || null,
  };
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
    // A helper on a `BUDGET: N%` allowance alone gets its own 80% / 100% notices instead: the crossing is still logged, the note is not sent.
    const quiet = !!transcript && briefAllowanceOnly(readBrief(transcript));
    // The worker hears it once per run, at the first mark (a marker per further 100 would be a drumbeat); the lead is told at every mark.
    // The second claim keeps it to one line per run even when a call races past 150 before the exact number is seen.
    const tell = !quiet && t === LONG_RUN_FIRST && claimOnce(`long-run-note-${p.agent_id}`);
    return { text: tell ? longRunText(n) : '', row: longRunRow(p, n, transcript, now) };
  } catch {
    return null;
  }
}

// --- The "why" record: one summary row when a worker that passed the first mark ends -----------------------------
// Written at SubagentStop (hooks/advisory-b.mjs worker-stop). It sits in the same log as the crossings, marked kind "summary", so the
// scout's long-run listing (scripts/long-runs.mjs) can show what the run was made of: which tools, how many failed commands, how long the
// brief was. Nothing here is a limit; the row exists so a long run can be looked at afterwards.

// Tool calls the hook has counted for this worker so far (0 when none).
export function stepsSoFar(agentId) {
  try { return statSync(join(countDir(), `${safe(agentId)}.cnt`)).size; } catch { return 0; }
}

// { toolCounts: {tool: n}, failedCommands } from a worker transcript. A failed command is a Bash tool result flagged is_error.
export function summarizeTranscript(path) {
  const toolCounts = {};
  let failedCommands = 0;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return { toolCounts, failedCommands }; }
  const names = new Map();
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.includes('"tool_use"') && !ln.includes('"tool_result"')) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
        if (b.id) names.set(b.id, b.name);
      } else if (b?.type === 'tool_result' && b.is_error === true && names.get(b.tool_use_id) === 'Bash') failedCommands += 1;
    }
  }
  return { toolCounts, failedCommands };
}

const rungOf = (agentType) => {
  const bare = String(agentType || '').split(':').pop();
  const hit = (modelTiers().ladder || []).find((r) => r && r.agent === bare);
  return hit ? hit.rung : null;
};

// The summary row for a worker that has ended, or null when it never reached the first mark. Never throws.
export function longRunSummaryRow(p, { transcript = null, name = null, now = new Date() } = {}) {
  try {
    if (!p || !p.agent_id) return null;
    const steps = stepsSoFar(p.agent_id);
    if (steps < LONG_RUN_FIRST) return null;
    const brief = readBrief(transcript);
    const startedAt = readStartedAt(transcript);
    const dur = startedAt ? (now.getTime() - Date.parse(startedAt)) / 60000 : null;
    const { toolCounts, failedCommands } = transcript ? summarizeTranscript(transcript) : { toolCounts: {}, failedCommands: 0 };
    return {
      kind: 'summary', ts: now.toISOString(), sessionId: p.session_id ?? null, agentId: p.agent_id, agentType: p.agent_type ?? null,
      name, type: briefStepInfo(brief).type, rung: rungOf(p.agent_type), steps,
      minutes: dur !== null && Number.isFinite(dur) ? Math.max(0, Math.round(dur * 10) / 10) : null,
      toolCounts, failedCommands, briefChars: brief.length,
    };
  } catch {
    return null;
  }
}
