// Feature 5 — Spawn telemetry (post-spawn; cannot and should not block).
// Feeds the calibration routine: which agent types and models actually ran.

import { readStdin, noteAgentType, opt, appendLog, passthrough } from './lib/context.mjs';

try {
  const p = readStdin();
  noteAgentType(p);
  if (opt('spawn_telemetry', true)) {
    appendLog('subagent-starts.jsonl', {
      at: new Date().toISOString(),
      session_id: p.session_id,
      agent_id: p.agent_id,
      agent_type: p.agent_type,
      effort: p.effort?.level,
    });
  }
} catch { /* fail open */ }
passthrough();
