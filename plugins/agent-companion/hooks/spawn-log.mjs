// Feature 5 — Spawn telemetry (post-spawn; cannot and should not block).
// Feeds the calibration routine: which agent types and models actually ran.

import { readStdin, noteAgentType, opt, appendLog, passthrough, confirmPremiumStart } from './lib/context.mjs';

try {
  const p = readStdin();
  noteAgentType(p);
  if (opt('spawn_telemetry', true)) {
    appendLog('subagent-starts.jsonl', {
      at: new Date().toISOString(),
      session_id: p.session_id,
      agent_id: p.agent_id,
      agent_type: p.agent_type,
      effort: p.effort?.level, // the effort the harness reported AT SubagentStart
      transcript_path: p.transcript_path || null,
      agent_transcript_path: p.agent_transcript_path || null,
    });
  }
  // The premium fan-out cap counts spawns that actually STARTED: confirm the
  // spawn guard's pending entry for this session (context.mjs,
  // confirmPremiumStart). Independent of spawn_telemetry — this is cap state.
  try { confirmPremiumStart(p.session_id); } catch { /* fail open */ }
} catch { /* fail open */ }
passthrough();
