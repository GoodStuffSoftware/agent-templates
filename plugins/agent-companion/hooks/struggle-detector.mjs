// UserPromptSubmit: struggle detector. Scores each operator prompt for
// corrections and repeats (hooks/lib/struggle.mjs); when 2 of the last 6
// prompts score 2 or more it tells the operator (systemMessage) and gives the
// lead one line (additionalContext). Zero tokens otherwise. Per-session state
// under state/struggle/, one telemetry row per prompt in telemetry/struggle.jsonl
// (scores only, no prompt text). Main session only; unattended runs log but
// say nothing. Fail-open. Kill switch: plugin option `struggle_detector`.
import { isCrossSessionMessage } from './lib/cross-session.mjs';
import { join } from 'node:path';
import { readStdin, opt, passthrough, callerIsSubagent, telemetryDir, appendLog } from './lib/context.mjs';
import {
  scorePrompt, step, loadState, saveState, loadUserPatterns, lastLeadText, liveEffort,
  operatorMessage, leadMessage,
} from './lib/struggle.mjs';

try {
  if (!opt('struggle_detector', true)) passthrough();
  const p = readStdin();
  if (callerIsSubagent(p)) passthrough();
  const sid = p.session_id;
  const prompt = p.prompt ?? p.user_input ?? '';
  if (!sid || typeof prompt !== 'string' || !prompt.trim()) passthrough();
  // task notification, scheduled task, pasted block, or a message from another session
  if (/^\s*</.test(prompt) || isCrossSessionMessage(prompt)) passthrough();

  const state = loadState(sid);
  const scored = scorePrompt(prompt, {
    prevLead: lastLeadText(p.transcript_path),
    earlier: state.sentences,
    user: loadUserPatterns(),
  });
  const r = step(state, scored);
  saveState(sid, state);

  const unattended = process.env.CLAUDE_CODE_SESSION_ATTENDED === '0';
  const effort = r.fire ? liveEffort(p, join(telemetryDir(), 'spawns.jsonl'), sid) : null;
  try {
    appendLog('struggle.jsonl', {
      ts: new Date().toISOString(), session_id: sid, n: state.count, score: scored.n, flagged: r.flagged,
      fired: r.fire && !unattended, effort,
    });
  } catch { /* fail open */ }

  if (!r.fire || unattended) passthrough();
  process.stdout.write(JSON.stringify({
    systemMessage: operatorMessage(r.flagged, r.window, effort),
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: leadMessage(r.flagged, r.window) },
  }));
} catch {
  // fail open
}
passthrough();
