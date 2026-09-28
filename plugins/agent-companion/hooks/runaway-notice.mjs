// Deliver queued runaway-spawn notices to the LEAD session.
//
// hooks/runaway-check.mjs queues a one-line notice per runaway subagent,
// keyed by the lead's session_id (lib/runaway.mjs). This drains that queue
// into the lead's context via additionalContext on two events, both
// documented to add it to the model's context:
//   UserPromptSubmit     every lead prompt, including the task-notification
//                        turn that reports a background worker done;
//   PostToolUse ^Agent$  right after a FOREGROUND spawn returns (its
//                        SubagentStop has already run).
// Lead only: a payload carrying agent_id comes from inside a subagent (real
// main-thread payloads carry no agent_id and no agent_type), and is ignored —
// callerIsSubagent(), the one shared test (lib/context.mjs).
// The event name is taken from the payload. The drain's rename makes each
// notice appear exactly once. Empty stdout when there is nothing queued.

import { readStdin, passthrough, callerIsSubagent } from './lib/context.mjs';
import { drainNotices, renderNotices } from './lib/runaway.mjs';

const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

try {
  const p = readStdin();
  if (callerIsSubagent(p)) passthrough();
  const event = EVENTS.has(p.hook_event_name) ? p.hook_event_name : null;
  if (!event) passthrough();
  const text = renderNotices(drainNotices(p.session_id));
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }));
  process.exit(0);
} catch {
  passthrough();
}
