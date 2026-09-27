// UserPromptSubmit — deliver queued runaway-spawn notices to the lead.
//
// hooks/runaway-check.mjs queues a one-line notice per runaway subagent,
// keyed by the lead's session_id (lib/runaway.mjs). This drains that queue
// into the lead's context via additionalContext, which the hooks reference
// documents as reaching the model for UserPromptSubmit. The main-thread
// delegation guard (hooks/delegation-guard.mjs) drains the same queue on
// PreToolUse, so a notice lands on whichever comes first; the drain's rename
// makes it exactly once. Empty stdout when there is nothing queued.

import { readStdin, passthrough } from './lib/context.mjs';
import { drainNotices, renderNotices } from './lib/runaway.mjs';

try {
  const p = readStdin();
  const text = renderNotices(drainNotices(p.session_id));
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  }));
  process.exit(0);
} catch {
  passthrough();
}
