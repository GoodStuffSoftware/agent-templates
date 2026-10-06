// Subagent context notice: tell a subagent, WHILE IT RUNS, that its own context
// has grown past `subagent_context_notice_tokens` (default 300000; 0 is off) or
// that it has just compacted, and tell the lead about it when the subagent
// stops.
//
// --- Mid-run delivery (verified 2026-10-02) ------------------------------------
// A PreToolUse hook fires inside a subagent's own tool loop. Its payload
// carries agent_id and agent_type (absent on the main thread) and
// transcript_path, which is the LEAD's transcript, not the subagent's. A
// PreToolUse hookSpecificOutput.additionalContext reaches that subagent's
// model: a `claude -p` run with a hook that returned a codeword for Bash calls
// carrying an agent_id had a general-purpose subagent report the codeword back.
// So hooks/subagent-context.mjs (PreToolUse, no matcher) reads the subagent's
// own transcript, derived the way lib/runaway.mjs does, and injects once.
//
// --- What is measured ------------------------------------------------------------
// Context size is the latest assistant record's input + cache_read + cache
// write tokens: what that request sent. After a compaction that figure drops,
// so the size notice rides on "past the threshold now" and a compaction is its
// own signal: a `compact_boundary` system record in the transcript, with at
// most BOUNDARY_FRESH_TURNS assistant requests after it (a boundary from long
// ago, seen the first time this hook runs on a resumed worker, is not "just
// compacted"). With autoCompactWindow at 200000 a worker compacts long before
// 300000, so the compaction signal is the one that usually fires.
//
// Reads are BOUNDED: the last CTX_TAIL_BYTES of the file, widened once to
// CTX_TAIL_WIDE_BYTES when the narrow tail holds no assistant record (a huge
// tool result sits last). Fails open everywhere.
//
// --- Once ----------------------------------------------------------------------------
// An exclusive-create claim per (agent, kind[, boundary]): the size notice fires
// once per agent, the compaction notice once per compaction. Each firing is
// recorded in telemetry subagent-context.jsonl and in a per-agent events file
// under state/, which hooks/runaway-check.mjs (SubagentStop) turns into a line
// in the lead's notice, next to the runaway flags. A worker whose PreToolUse
// never saw the signal (it crossed on its last turn, or made no tool call) is
// caught at SubagentStop by the same read, phase "stop".

import {
  openSync, fstatSync, readSync, closeSync, mkdirSync, writeFileSync, appendFileSync, readFileSync,
  readdirSync, statSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './context.mjs';
import { safe } from './runaway.mjs';

export const CONTEXT_DEFAULT_TOKENS = 300000;
export const CTX_TAIL_BYTES = 1024 * 1024;
export const CTX_TAIL_WIDE_BYTES = 8 * 1024 * 1024;
export const BOUNDARY_FRESH_TURNS = 3;
const STATE_TTL_MS = 7 * 86400000;

function readTail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (!size) return { lines: [], partial: false };
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // may begin mid-record
    return { lines, partial: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function ctxOf(msg) {
  const u = msg.usage || {};
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const flat = u.cache_creation_input_tokens;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (typeof flat === 'number' ? flat : w5 + w1);
}

// { ctx, model, turnsAfterBoundary, boundary: { id, trigger, preTokens } | null,
//   partial } or null when the file cannot be read or holds no assistant
// record in the window. `boundary` is the LAST compact_boundary in the window;
// `turnsAfterBoundary` counts distinct assistant requests after it.
export function readContextSignal(path) {
  if (!path) return null;
  for (const bytes of [CTX_TAIL_BYTES, CTX_TAIL_WIDE_BYTES]) {
    const t = readTail(path, bytes);
    if (!t) return null;
    let lastAssistant = null;
    let boundary = null;
    let after = new Set();
    let anon = 0;
    for (const line of t.lines) {
      const isA = line.includes('"type":"assistant"');
      const isB = !isA && line.includes('"compact_boundary"');
      if (!isA && !isB) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec) continue;
      if (isB && rec.type === 'system' && rec.subtype === 'compact_boundary') {
        boundary = {
          id: String(rec.uuid || rec.timestamp || 'boundary'),
          trigger: rec.compactMetadata?.trigger || null,
          preTokens: rec.compactMetadata?.preTokens ?? null,
        };
        after = new Set();
      } else if (isA && rec.type === 'assistant') {
        const msg = rec.message || {};
        if (msg.model === '<synthetic>') continue;
        lastAssistant = msg;
        after.add(rec.requestId || msg.id || `anon-${anon += 1}`);
      }
    }
    if (lastAssistant || bytes === CTX_TAIL_WIDE_BYTES || !t.partial) {
      if (!lastAssistant) return null;
      return {
        ctx: ctxOf(lastAssistant), model: lastAssistant.model || '', boundary,
        turnsAfterBoundary: boundary ? after.size : null, partial: t.partial,
      };
    }
  }
  return null;
}

// --- Once-per-event claims and the per-agent events file -------------------------

function claimDir() { return join(stateDir(), 'subagent-context-claims'); }
function eventsDir() { return join(stateDir(), 'subagent-context'); }

export function claimOnce(key) {
  try {
    mkdirSync(claimDir(), { recursive: true });
    writeFileSync(join(claimDir(), `${safe(key)}.seen`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function recordEvent(agentId, ev) {
  try {
    mkdirSync(eventsDir(), { recursive: true });
    appendFileSync(join(eventsDir(), `${safe(agentId)}.jsonl`), `${JSON.stringify(ev)}\n`);
  } catch { /* best effort */ }
}

export function readEvents(agentId) {
  const out = [];
  let text = '';
  try { text = readFileSync(join(eventsDir(), `${safe(agentId)}.jsonl`), 'utf8'); } catch { return out; }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

export function pruneContextState(now = Date.now()) {
  for (const dir of [claimDir(), eventsDir()]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = join(dir, n);
      try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// Which kinds fire for this signal. `fresh` demands a boundary that is just
// behind the agent (the PreToolUse path); the SubagentStop path accepts any
// boundary in the window. Claims are taken here, so a caller that gets a kind
// back owns it.
export function claimSignals(agentId, sig, threshold, { fresh }) {
  const kinds = [];
  if (!sig) return kinds;
  if (sig.boundary && (!fresh || sig.turnsAfterBoundary <= BOUNDARY_FRESH_TURNS)
    && claimOnce(`compact-${agentId}-${sig.boundary.id}`)) kinds.push('compaction');
  if (threshold > 0 && sig.ctx >= threshold && claimOnce(`size-${agentId}`)) kinds.push('size');
  return kinds;
}

export const fmtTokens = (n) => Number(n).toLocaleString('en-US');

// The text the subagent sees.
export function subagentNoticeText(kinds, threshold) {
  const what = kinds.includes('compaction')
    ? 'You just compacted'
    : `Your context is past ${fmtTokens(threshold)} tokens`;
  // A compaction is routine now (subagents compact at about 217K and are reused
  // across follow-ups): carry on, do not wrap up. Only a context past the
  // threshold is a reason to hand back.
  if (kinds.includes('compaction')) {
    return `[agent-companion] ${what}. Carry on; your summary may have dropped detail, so re-read a file before relying on a line you only remember.`;
  }
  return `[agent-companion] ${what}. Finish the current step, return your results, and if more work remains, say what is left; the lead will send it back to you or to another worker.`;
}
