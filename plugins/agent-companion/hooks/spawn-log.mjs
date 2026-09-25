// Feature 5 — Spawn telemetry (post-spawn; cannot and should not block).
// Feeds the calibration routine: which agent types and models actually ran.

import { readStdin, noteAgentType, opt, appendLog, passthrough } from './lib/context.mjs';
import { confirmPremiumStart } from './lib/premium-window.mjs';
import { resolveSpawnStart } from './lib/ladder-rewrite.mjs';

try {
  const p = readStdin();
  noteAgentType(p);
  // Did a ladder rewrite by the spawn guard actually take? (lib/ladder-rewrite.mjs)
  // A start that shows the rewritten spawn ran as its original type turns
  // rewriting off for the rest of this session. Independent of spawn_telemetry.
  let resolved = null;
  try { resolved = resolveSpawnStart(p.session_id, p.agent_type || null, Date.now()); } catch { resolved = null; }
  if (opt('spawn_telemetry', true)) {
    appendLog('subagent-starts.jsonl', {
      at: new Date().toISOString(),
      session_id: p.session_id,
      agent_id: p.agent_id,
      agent_type: p.agent_type,
      effort: p.effort?.level, // the effort the harness reported AT SubagentStart
      transcript_path: p.transcript_path || null,
      agent_transcript_path: p.agent_transcript_path || null,
      // The rung the guard rewrote this spawn to, when it ran as something else.
      ...(resolved && resolved.ignored ? { rewrite_ignored: resolved.ignored.wanted } : {}),
    });
  }
  // The premium fan-out cap counts spawns that actually STARTED: confirm the
  // spawn guard's pending entry for this session and agent type
  // (confirmPremiumStart in lib/premium-window.mjs). Independent of spawn_telemetry — this is cap state.
  // An ignored rewrite's premium entry was recorded under the rung's type, so
  // it is confirmed under that type.
  try {
    const t = resolved && resolved.ignored && resolved.ignored.wanted ? resolved.ignored.wanted : (p.agent_type || null);
    confirmPremiumStart(p.session_id, Date.now(), t);
  } catch { /* fail open */ }
} catch { /* fail open */ }
passthrough();
