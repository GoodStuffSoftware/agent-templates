// Runaway-spawn flag: measure a finished subagent, and carry a one-line
// notice to the LEAD session.
//
// --- Measuring (hooks/runaway-check.mjs, SubagentStop) ----------------------
// The subagent's own transcript is read BOUNDED: at most RUNAWAY_READ_BYTES
// from the END of the file (the same tail-read shape tailRecords() and
// scripts/lib/model-mismatch.mjs use), and only `"type":"assistant"` lines
// are parsed. A transcript larger than the window yields a LOWER BOUND
// (partial: true) — a turn or dollar count over the threshold inside the tail
// is over it for the whole file too, so a partial read can only miss a flag,
// never invent one. SubagentStop fires on every subagent end, so this read is
// the whole of the hook's latency budget; it fails open (null) on any error.
//
// Turns are API requests, deduplicated the way lib/transcripts.mjs's D1 rule
// does: one request is written as several assistant lines (one per content
// block), all sharing a requestId (falling back to message.id), and its usage
// is the field-wise MAX over those lines, never a sum. Dollars are
// price-derived (list price x tokens, scripts/lib/pricing.mjs), never billed.
//
// --- Delivering (the queue) --------------------------------------------------
// A SubagentStop hook's output belongs to the subagent's stop, not to the
// lead: this plugin's own brevity gate (hooks/subagent-brevity.mjs) relies on
// a SubagentStop `decision: block` reason being fed back to the SAME subagent,
// and the hooks reference describes SubagentStop's additionalContext only as
// "context to show Claude" without saying which Claude. So the notice is not
// emitted there. It is QUEUED per lead session (the SubagentStop payload's
// session_id is the lead's — spawn-log.mjs relies on the same fact to confirm
// premium starts against the spawn guard's session) and DRAINED by lead-side
// by hooks/runaway-notice.mjs on two LEAD-ONLY events whose additionalContext
// is documented to reach the model:
//   - UserPromptSubmit, which also fires on a background worker's
//     task-notification turn (verified in real lead transcripts: UserPromptSubmit
//     hook_additional_context attachments parented on <task-notification>
//     records), so a background runaway lands on the turn that reports it;
//   - PostToolUse on Agent, which for a FOREGROUND spawn fires after that
//     subagent's SubagentStop, so the lead sees the notice with the result.
//     Only when the payload has no agent_id: in real payloads the main thread
//     carries neither agent_id nor agent_type, and a subagent's carries
//     agent_id (spawns.jsonl: caller_is_subagent === !!agent_id, 1433 rows).
// Draining renames the queue file first, so exactly one drainer wins a given
// batch and a notice is shown once.

import {
  openSync, fstatSync, readSync, closeSync, mkdirSync, appendFileSync,
  renameSync, readFileSync, unlinkSync, existsSync, writeFileSync, readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { stateDir, telemetryDir, tailRecords } from './context.mjs';
import { priceUsage } from '../../scripts/lib/pricing.mjs';

export const RUNAWAY_READ_BYTES = 8 * 1024 * 1024;
export const RUNAWAY_DEFAULT_TURNS = 300;
export const RUNAWAY_DEFAULT_USD = 40;

export function usageOf(u) {
  const x = u || {};
  const w5 = x.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const w1 = x.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const flat = x.cache_creation_input_tokens;
  return {
    input: x.input_tokens || 0,
    output: x.output_tokens || 0,
    cacheRead: x.cache_read_input_tokens || 0,
    cacheWrite: typeof flat === 'number' ? flat : w5 + w1,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
  };
}

// { turns, usd, unpricedTurns, partial, bytes, model } or null when the file
// cannot be read. `model` is the last request's model id.
export function measureTranscript(path, { maxBytes = RUNAWAY_READ_BYTES } = {}) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len) readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // may begin mid-record
    const reqs = new Map();
    let anon = 0;
    for (const line of lines) {
      if (!line.includes('"type":"assistant"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || rec.type !== 'assistant') continue;
      const msg = rec.message || {};
      const key = rec.requestId || msg.id || `anon-${anon += 1}`;
      const u = usageOf(msg.usage);
      const prev = reqs.get(key);
      if (prev) {
        for (const k of Object.keys(prev.usage)) prev.usage[k] = Math.max(prev.usage[k], u[k]);
        if (msg.model) prev.model = msg.model;
      } else {
        reqs.set(key, { usage: u, model: msg.model || '' });
      }
    }
    let usd = 0;
    let unpricedTurns = 0;
    let model = '';
    for (const r of reqs.values()) {
      if (r.model === '<synthetic>') continue;
      const p = priceUsage(r.usage, r.model);
      if (p) usd += p.usd; else unpricedTurns += 1;
      if (r.model) model = r.model;
    }
    const synthetic = [...reqs.values()].filter((r) => r.model === '<synthetic>').length;
    return { turns: reqs.size - synthetic, usd, unpricedTurns, partial: start > 0, bytes: size, model };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Which thresholds a measurement crosses. A threshold <= 0 is off.
export function runawayReasons(m, { turns, usd }) {
  if (!m) return [];
  const out = [];
  if (turns > 0 && m.turns > turns) out.push(`${m.turns} turns > ${turns}`);
  if (usd > 0 && m.usd > usd) out.push(`~$${m.usd.toFixed(2)} > $${usd}`);
  return out;
}

export const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
function queueDir() { return join(stateDir(), 'runaway-queue'); }

// Once per agent_id: SubagentStop fires again when a stopped worker is
// continued with SendMessage and stops again, and its transcript is still
// over the line. Exclusive create — the one process whose create wins flags.
export function claimAgentOnce(agentId) {
  try {
    const dir = join(stateDir(), 'runaway-flagged');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safe(agentId)}.seen`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function queueNotice(sessionId, text) {
  if (!sessionId) return false;
  try {
    const dir = queueDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${safe(sessionId)}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), text })}\n`);
    return true;
  } catch {
    return false;
  }
}

// Every queued notice for this session, exactly once. The fast path is one
// existsSync, because a drainer runs on the lead's hot path.
export function drainNotices(sessionId) {
  if (!sessionId) return [];
  const f = join(queueDir(), `${safe(sessionId)}.jsonl`);
  if (!existsSync(f)) return [];
  try { if (!statSync(f).isFile()) return []; } catch { return []; }
  const claimed = `${f}.${process.pid}.${Date.now()}.draining`;
  try { renameSync(f, claimed); } catch { return []; } // another drainer won
  let text = '';
  try { text = readFileSync(claimed, 'utf8'); } catch { /* lost */ }
  try { unlinkSync(claimed); } catch { /* best effort */ }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.text) out.push(String(r.text)); } catch { /* torn line */ }
  }
  return out;
}

export function renderNotices(list) {
  if (!list.length) return '';
  return list.slice(0, 5).join('\n') + (list.length > 5 ? `\n(+${list.length - 5} more in runaway.jsonl)` : '');
}

// --- Which transcript -------------------------------------------------------
// On-disk layout, checked against real ~/.claude/projects on 2026-09-27: the
// lead's transcript is <project>/<session_id>.jsonl and each subagent writes
// <project>/<session_id>/subagents/agent-<agent_id>.jsonl. SubagentStart rows
// carry agent_transcript_path null in practice (0 of 2229 real rows), so the
// path derived from the lead's transcript_path is the dependable fallback.
const idOk = (s) => /^[A-Za-z0-9_-]+$/.test(String(s || ''));
export function derivedAgentTranscript(leadTranscript, sessionId, agentId) {
  if (!leadTranscript || !idOk(sessionId) || !idOk(agentId)) return null;
  const p = join(dirname(String(leadTranscript)), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  return existsSync(p) ? p : null;
}

function transcriptFromStarts(agentId) {
  if (!agentId) return null;
  const needle = JSON.stringify(String(agentId));
  const rows = tailRecords(join(telemetryDir(), 'subagent-starts.jsonl'), {
    bytes: 1024 * 1024, filter: (l) => l.includes(needle),
  });
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r.agent_id !== agentId) continue;
    if (r.agent_transcript_path) return r.agent_transcript_path;
    const d = derivedAgentTranscript(r.transcript_path, r.session_id, agentId);
    if (d) return d;
  }
  return null;
}

// payload agent_transcript_path, else derived from the payload, else the
// SubagentStart row (its own path, or derived from its transcript_path).
export function resolveAgentTranscript(p) {
  return (p && p.agent_transcript_path)
    || derivedAgentTranscript(p?.transcript_path, p?.session_id, p?.agent_id)
    || transcriptFromStarts(p?.agent_id);
}

// --- Hygiene ------------------------------------------------------------------
// A queue for a session that never takes another prompt or Agent call (a -p
// run, the last worker before exit), a *.draining left by a crash between
// rename and unlink, and the once-per-agent markers would otherwise grow
// forever. Anything older than RUNAWAY_STATE_TTL_MS goes, on each flag.
export const RUNAWAY_STATE_TTL_MS = 7 * 86400000;
export function pruneRunawayState(now = Date.now()) {
  for (const sub of ['runaway-queue', 'runaway-flagged']) {
    const dir = join(stateDir(), sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = join(dir, n);
      try {
        if (now - statSync(f).mtimeMs > RUNAWAY_STATE_TTL_MS) rmSync(f, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }
}
