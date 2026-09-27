// SubagentStop — flag a runaway spawn.
//
// A subagent that ran past `runaway_turns` API turns (default 300) or
// `runaway_usd` price-derived dollars (default 40; either <= 0 turns that half
// off) gets (a) one row in runaway.jsonl beside spawns.jsonl, and (b) a
// one-line notice QUEUED for the lead session, which hooks/runaway-notice.mjs
// drains into the lead's context on its next prompt (a background worker's
// task notification included) or right after a foreground Agent call
// returns. See lib/runaway.mjs for why the notice is not emitted from this
// event, and for the bounded read (tail window, assistant lines only) that
// keeps this hook cheap on every subagent end.
//
// Transcript path, first found wins (lib/runaway.mjs resolveAgentTranscript):
// the payload's agent_transcript_path; the path derived from the lead's
// transcript_path, <dir>/<session_id>/subagents/agent-<agent_id>.jsonl; this
// agent's SubagentStart row in subagent-starts.jsonl.
//
// Silent on every path: this hook never writes stdout. Fails open.

import { readStdin, opt, passthrough, appendLog } from './lib/context.mjs';
import {
  measureTranscript, runawayReasons, claimAgentOnce, queueNotice, resolveAgentTranscript, pruneRunawayState,
  RUNAWAY_DEFAULT_TURNS, RUNAWAY_DEFAULT_USD,
} from './lib/runaway.mjs';

try {
  const p = readStdin();
  const turns = opt('runaway_turns', RUNAWAY_DEFAULT_TURNS);
  const usd = opt('runaway_usd', RUNAWAY_DEFAULT_USD);
  if (!(turns > 0) && !(usd > 0)) passthrough();

  const path = resolveAgentTranscript(p);
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

  // No session id: no lead to deliver to (an `unknown` queue would be drained
  // by whichever other session also lacked one). The row above still stands.
  if (p.session_id) {
    const who = `${p.agent_type || 'subagent'}${p.agent_id ? ` (${String(p.agent_id).slice(0, 12)})` : ''}`;
    const unpriced = m.unpricedTurns ? `; ${m.unpricedTurns} turn(s) on a model with no price, so no dollar figure for them` : '';
    queueNotice(p.session_id, `[agent-companion] runaway spawn: ${who} was at ${reasons.join(', ')} when it stopped`
      + `${m.partial ? ' (lower bound: transcript tail only)' : ''}${unpriced}. Check it was not looping or mis-sized before resuming or re-spawning it; row in runaway.jsonl.`);
  }
  pruneRunawayState();
} catch { /* fail open */ }
passthrough();
