// SubagentStop — flag a runaway spawn.
//
// A subagent that ran past `runaway_turns` API turns (default 300) or
// `runaway_usd` price-derived dollars (default 40; either <= 0 turns that half
// off) gets (a) one row in runaway.jsonl beside spawns.jsonl, and (b) a
// one-line notice QUEUED for the lead session, which a lead-side hook drains
// into the lead's context on its next prompt or main-thread tool call. See
// lib/runaway.mjs for why the notice is not emitted from this event, and for
// the bounded read (tail window, assistant lines only) that keeps this hook
// cheap on every subagent end.
//
// The transcript path comes from the payload's agent_transcript_path, or —
// when a harness build leaves it out — from this agent_id's own SubagentStart
// row in subagent-starts.jsonl (hooks/spawn-log.mjs records it there).
//
// Silent on every path: this hook never writes stdout. Fails open.

import { join } from 'node:path';
import { readStdin, opt, passthrough, appendLog, telemetryDir, tailRecords } from './lib/context.mjs';
import {
  measureTranscript, runawayReasons, claimAgentOnce, queueNotice,
  RUNAWAY_DEFAULT_TURNS, RUNAWAY_DEFAULT_USD,
} from './lib/runaway.mjs';

function transcriptFromStarts(agentId) {
  if (!agentId) return null;
  const needle = JSON.stringify(String(agentId));
  const rows = tailRecords(join(telemetryDir(), 'subagent-starts.jsonl'), {
    bytes: 1024 * 1024, filter: (l) => l.includes(needle),
  });
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].agent_id === agentId && rows[i].agent_transcript_path) return rows[i].agent_transcript_path;
  }
  return null;
}

try {
  const p = readStdin();
  const turns = opt('runaway_turns', RUNAWAY_DEFAULT_TURNS);
  const usd = opt('runaway_usd', RUNAWAY_DEFAULT_USD);
  if (!(turns > 0) && !(usd > 0)) passthrough();

  const path = p.agent_transcript_path || transcriptFromStarts(p.agent_id);
  const m = measureTranscript(path);
  const reasons = runawayReasons(m, { turns, usd });
  if (!reasons.length) passthrough();
  if (!claimAgentOnce(p.agent_id || path)) passthrough();

  appendLog('runaway.jsonl', {
    at: new Date().toISOString(),
    session_id: p.session_id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    model: m.model || null,
    turns: m.turns,
    usd: Math.round(m.usd * 100) / 100,
    usd_basis: 'price-derived',
    unpriced_turns: m.unpricedTurns,
    partial: m.partial,
    transcript_bytes: m.bytes,
    thresholds: { turns, usd },
    reasons,
  });

  const who = `${p.agent_type || 'subagent'}${p.agent_id ? ` (${String(p.agent_id).slice(0, 12)})` : ''}`;
  queueNotice(p.session_id, `[agent-companion] runaway spawn: ${who} finished after ${reasons.join(', ')}`
    + `${m.partial ? ' (lower bound: transcript tail only)' : ''}. Check it was not looping or mis-sized before resuming or re-spawning it; row in runaway.jsonl.`);
} catch { /* fail open */ }
passthrough();
