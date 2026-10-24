// Redo alert (token bleed guard, phase 2, part E). When the lead spawns a helper whose brief
// closely matches a task that already ended STATUS: partial, or that was already run twice,
// in the last 24 hours, the spawn gets one note for the lead: re-brief it or move it up a
// rung instead of retrying.
//
// Data: the worker ledger (state/worker-ledger/<session>.jsonl, lib/advisory-b.mjs). Each
// stop row carries the helper's STATUS word, a word sketch of its brief (bfp) and its brief's
// task type (bty), all written by hooks/advisory-b.mjs at SubagentStop. The match runs over
// every session's ledger, because a redo is often spawned from a fresh lead session.
//
// False positives: two briefs match only when their word-set similarity is at least
// REDO_SIMILARITY (measured: 741 pairs of real, distinct briefs topped out at 0.38, a
// brief re-sent with an added paragraph scores 0.84 or more), they declare the same TYPE,
// the brief has at least MIN_BRIEF_TOKENS distinct words, and reviews are never matched (a
// reviewer's brief quotes the writer's). Advisory only: nothing here blocks a spawn.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, tailRecords, callerIsSubagent } from './context.mjs';
import { firstUserText, briefSketch, sketchSimilarity } from './brief-match.mjs';
import { resolveAgentTranscript } from './runaway.mjs';
import { briefDeclarations, declarationValue } from './brief-directives.mjs';

export const REDO_NOTE = 'third attempt at this task: re-brief it or move it up a rung instead of retrying';
export const REDO_WINDOW_MS = 24 * 3600 * 1000;
export const REDO_SIMILARITY = 0.5;
const MAX_FILES = 60;
const TAIL_BYTES = 512 * 1024;

// The TYPE a brief declares, lowercase ('' when none): rows are only compared within one type.
export function briefType(text) {
  try {
    const m = declarationValue(briefDeclarations(String(text || '')), 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

function isReview(text, type) {
  if (type === 'code-review') return true;
  try {
    const m = declarationValue(briefDeclarations(String(text || '')), 'ROLE', /([a-z]+)\b/.source);
    return !!m && m[1].toLowerCase() === 'reviewer';
  } catch { return false; }
}

// Extra fields for a helper's ledger stop row: the sketch of its brief (the first user message
// of its transcript) and the brief's TYPE. {} when the brief cannot be read or is too short.
export function briefLedgerFields(p) {
  try {
    const text = firstUserText(resolveAgentTranscript(p));
    const bfp = briefSketch(text);
    return bfp ? { bfp, bty: briefType(text) } : {};
  } catch { return {}; }
}

// Prior stop rows of helpers whose brief matches `text`, newest window only: [{ status, agent_id, at }].
export function matchingRuns(text, { now = Date.now(), windowMs = REDO_WINDOW_MS, dir = join(stateDir(), 'worker-ledger') } = {}) {
  const sk = briefSketch(text);
  if (!sk) return [];
  const type = briefType(text);
  if (isReview(text, type)) return [];
  let files = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => {
      const f = join(dir, n);
      let m = 0; try { m = statSync(f).mtimeMs; } catch { /* gone */ }
      return { f, m };
    }).filter((x) => now - x.m <= windowMs).sort((a, b) => b.m - a.m).slice(0, MAX_FILES);
  } catch { return []; }
  const seen = new Map();
  for (const { f } of files) {
    const rows = tailRecords(f, { bytes: TAIL_BYTES, filter: (l) => l.includes('"bfp"') });
    for (const r of rows) {
      if (!r || r.ev !== 'stop' || !Array.isArray(r.bfp) || !r.agent_id) continue;
      const at = Date.parse(r.at);
      if (!Number.isFinite(at) || now - at > windowMs) continue;
      if ((r.bty || '') !== type) continue;
      if (sketchSimilarity(sk, r.bfp) < REDO_SIMILARITY) continue;
      seen.set(r.agent_id, { status: r.status || null, agent_id: r.agent_id, at });
    }
  }
  return [...seen.values()];
}

// The note, or null: a close match ended partial, or the task has already run twice.
export function redoNote(text, opts = {}) {
  try {
    const runs = matchingRuns(text, opts);
    if (runs.length >= 2 || runs.some((r) => r.status === 'partial')) return REDO_NOTE;
  } catch { /* advisory */ }
  return null;
}

// Held by the spawn guard until an allow is emitted (a denied spawn says nothing), like the
// lead-effort note in lib/lead-effort-live.mjs.
let pending = null;

// Called once per spawn from the lead; lead-side only, never for a helper's own spawns.
export function redoAlertCheck({ p, brief, isCanary = false, enabled = true }) {
  pending = null;
  try {
    if (!enabled || isCanary || callerIsSubagent(p)) return null;
    pending = redoNote(brief);
    return pending;
  } catch { return null; }
}

// Adds the held note to the allow's additionalContext. Unchanged when there is none.
export function mergeRedoAlert(additionalContext) {
  const n = pending;
  if (!n) return additionalContext;
  pending = null;
  return [additionalContext, n].filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
}
