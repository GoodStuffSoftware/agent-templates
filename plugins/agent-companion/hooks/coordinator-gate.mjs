// Coordinator message gate: PreToolUse on SendMessage and mcp__ccd_session_mgmt__send_message.
//
// In a CHILD session (one another session started), a message to its COORDINATOR (the session that started
// it) must open with QUESTION:, BLOCKED:, DONE:, CHANGE:, FINDING: or ANSWER:. An untagged one is denied
// (coordinator_message_gate: block, the default), allowed with a note (warn) or not looked at (off). Status
// belongs on the card or task list: a status message wakes the coordinator for an expensive turn.
//
// Passes untouched, and never gated on a guess: a send from a coordinator or a top-level session, between
// children, to a subagent by name, from a subagent, a message that is not plain text, or to a target that
// cannot be resolved to the parent. Any error passes (fail open). One telemetry row per gated decision
// (telemetry/coordinator-messages.jsonl): the decision and the tag, never the message text.

import { readStdin, opt, passthrough, deny, appendLog, callerIsSubagent } from './lib/context.mjs';
import { modeFrom, tagOf, parentOf, resolveTargetSession, DENY_REASON, WARN_NOTE } from './lib/coordinator-gate.mjs';

function row(p, mode, decision, tag, via) {
  appendLog('coordinator-messages.jsonl', {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    tool_name: p.tool_name,
    mode,
    decision,
    tag,
    target: via,
  });
}

try {
  const mode = modeFrom(opt('coordinator_message_gate', 'block'));
  if (mode === 'off') passthrough();

  const p = readStdin();
  if (!p || typeof p !== 'object' || typeof p.session_id !== 'string' || !p.session_id) passthrough();
  if (callerIsSubagent(p)) passthrough();

  const input = p.tool_input || {};
  const mcp = p.tool_name === 'mcp__ccd_session_mgmt__send_message';
  const to = mcp ? input.session_id : (input.to || input.recipient);
  const message = input.message;
  if (typeof to !== 'string' || typeof message !== 'string') passthrough();
  // Only a session id or a reply address can name the coordinator; a name is a subagent or teammate.
  if (!/^(local_|uds:)/i.test(to.trim())) passthrough();

  const parent = parentOf(p.session_id);
  if (!parent) passthrough();
  const target = resolveTargetSession(to, p.transcript_path);
  if (!target || target !== parent) passthrough();

  const via = /^uds:/i.test(to.trim()) ? 'address' : 'session-id';
  const tag = tagOf(message);
  if (tag) {
    row(p, mode, 'allow', tag, via);
    passthrough();
  }
  if (mode === 'warn') {
    row(p, mode, 'warn', null, via);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: WARN_NOTE } }));
    process.exit(0);
  }
  row(p, mode, 'deny', null, via);
  deny(DENY_REASON);
} catch {
  passthrough(); // never break a session
}
