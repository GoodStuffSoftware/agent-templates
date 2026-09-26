// Guard (a) mechanics — resuming a stopped worker after its cache has
// expired (deliverable 6, CACHE-ADVISOR-HANDOFF.md). Kept deliberately
// separate from scripts/lib/transcripts.mjs (the shared reader): hooks must
// not import scripts/ (see guards-brief.md), so this is a small, self-
// contained duplicate of exactly the two things the hook needs — resolving a
// SendMessage target to its own transcript file, and a bounded tail-read of
// that file's last activity. The heavy, corpus-wide measurement (deliverable
// 6's "idle-expiry resumes and their rewrite tokens/$ over N days") lives in
// scripts/lib/transcript-report.mjs, which DOES use the shared reader.
//
// Resolution: every subagent transcript this session has written has a
// sidecar `<transcript>.meta.json` next to it (same mechanism
// lib/transcripts.mjs's own discovery reads — `name`, `agentType`, `model`,
// confirmed against a real transcript directory 2026-09-25: see the probe
// method in guard-a-report.md). SendMessage's `to` is either that `name`, or
// the raw agentId (the transcript's own filename, `agent-<id>.jsonl`) — both
// are handled; a name match wins if one is found, since a stale/collided raw
// id substring match is far less likely to be what the caller meant.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tailRecords } from './context.mjs';

export const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };

// A SendMessage `to`/`recipient` value, stripped of an optional disambiguating
// " [ref]" suffix (SendMessage's own doc: "worker [3fa9c1]"). Never thrown.
export function normalizeTo(to) {
  return String(to || '').trim().replace(/\s*\[[^\]]*\]\s*$/, '');
}

// Resolve `to` against THIS session's own subagents/ directory (sitting next
// to the main transcript SendMessage's own PreToolUse payload names:
// dirname(mainTranscriptPath)/subagents/). Returns
// { transcriptPath, agentId, name, agentType, model } or null — including
// when `to` names a teammate, a cross-session peer, or anything else this
// session did not itself spawn as a background subagent (out of this
// guard's scope; those are not "a stopped agent of this session" the way the
// brief scopes it).
export function resolveTarget(to, mainTranscriptPath) {
  const t = normalizeTo(to);
  if (!t || !mainTranscriptPath) return null;
  const dir = join(dirname(String(mainTranscriptPath)), 'subagents');
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  let byId = null;
  for (const f of entries) {
    if (!f.endsWith('.meta.json')) continue;
    const base = f.slice(0, -'.meta.json'.length); // "agent-<id>"
    const agentId = base.startsWith('agent-') ? base.slice('agent-'.length) : base;
    let meta;
    try { meta = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!meta || typeof meta !== 'object') continue;
    const transcriptPath = join(dir, `${base}.jsonl`);
    const entry = {
      transcriptPath, agentId,
      name: typeof meta.name === 'string' ? meta.name : null,
      agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
      model: typeof meta.model === 'string' ? meta.model : null,
    };
    if (entry.name && entry.name === t) return entry; // exact name match wins outright
    if (agentId === t) byId = entry;
  }
  return byId;
}

// This target's last activity: the last `type:"assistant"` record's
// timestamp and cache usage, from a bounded tail-read (the same
// tailRecords() every other hook here uses — no full-file parse). Returns
// null when the file is missing, empty, or has no assistant record in the
// tail window (a very large file's true last record could in principle sit
// further back than the tail window reaches; that reads as "unknown" and the
// guard fails open, same as any other unreadable case).
export function lastActivityOf(transcriptPath) {
  if (!transcriptPath) return null;
  const records = tailRecords(transcriptPath, { filter: (line) => line.includes('"type":"assistant"') });
  if (!records.length) return null;
  const last = records[records.length - 1];
  const ts = last && typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : NaN;
  const usage = (last && last.message && last.message.usage) || {};
  if (!Number.isFinite(ts) || typeof usage !== 'object') return null;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const split = usage.cache_creation || {};
  const cacheWrite1h = split.ephemeral_1h_input_tokens || 0;
  const cacheWrite5m = split.ephemeral_5m_input_tokens || 0;
  return {
    ts, cacheRead, cacheWrite, cacheWrite1h, cacheWrite5m,
    // Same formula as lib/transcripts.mjs's contextTokensOf(): the prompt
    // size the model saw on that request — what a rewrite has to pay again.
    contextTokens: input + cacheRead + cacheWrite,
  };
}

// Which TTL bucket applied to this activity: the larger of the 1h/5m split
// on its own write, same rule lib/transcripts.mjs's writeTtlOf() uses for
// the reader-backed report — falling back to the subagent default (5m) when
// the last request wrote nothing split by bucket (a pure cache read). This
// guard's scope is always a subagent (see resolveTarget's header), so there
// is no main-session 1h default branch to consider here.
export function ttlFor(activity) {
  const { cacheWrite1h = 0, cacheWrite5m = 0 } = activity || {};
  if (!cacheWrite1h && !cacheWrite5m) return '5m';
  return cacheWrite1h >= cacheWrite5m ? '1h' : '5m';
}
