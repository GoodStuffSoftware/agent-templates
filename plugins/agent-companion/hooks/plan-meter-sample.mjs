// PostToolUse on the desktop app's get_usage tool: append the reading to state/plan-meter-samples.jsonl, the log
// scripts/calibrate-weights.mjs refits config/plan-weights.json from. Zero tokens (nothing is injected), fast, and
// fail-safe: any bad input exits 0 without output. Parser and line shape: hooks/lib/plan-meter.mjs.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, stateDir, passthrough } from './lib/context.mjs';
import { parseUsage, sampleLine } from './lib/plan-meter.mjs';

try {
  const p = readStdin();
  if (!/get_usage$/.test(String(p.tool_name || ''))) passthrough();
  const reading = parseUsage(p.tool_response);
  if (!reading) passthrough();
  const line = sampleLine(reading, { ts: new Date().toISOString(), sessionId: typeof p.session_id === 'string' ? p.session_id : null });
  appendFileSync(join(stateDir(), 'plan-meter-samples.jsonl'), `${JSON.stringify(line)}\n`);
} catch {
  // fail open
}
passthrough();
