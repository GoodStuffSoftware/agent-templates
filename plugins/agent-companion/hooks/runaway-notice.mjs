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
//
// The session budget advisory rides the same path (lib/session-budget.mjs):
// before draining, this hook adds up the whole session's plan units (the lead
// plus every subagent, incrementally) and, when the total has crossed another
// multiple of `session_budget_units` (default 350; 0 is off), queues one notice
// that the drain below then delivers. It only ever advises.
//
// The event name is taken from the payload. The drain's rename makes each
// notice appear exactly once. Empty stdout when there is nothing queued.

import { readStdin, passthrough, callerIsSubagent, opt } from './lib/context.mjs';
import { drainNotices, renderNotices } from './lib/runaway.mjs';
import { checkSessionBudget, SESSION_BUDGET_DEFAULT_UNITS } from './lib/session-budget.mjs';

const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

try {
  const p = readStdin();
  if (callerIsSubagent(p)) passthrough();
  const event = EVENTS.has(p.hook_event_name) ? p.hook_event_name : null;
  if (!event) passthrough();
  try { checkSessionBudget(p, { threshold: opt('session_budget_units', SESSION_BUDGET_DEFAULT_UNITS) }); } catch { /* advisory: never in the way */ }
  const text = renderNotices(drainNotices(p.session_id));
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }));
  process.exit(0);
} catch {
  passthrough();
}
