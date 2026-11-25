// SessionStart (resume|compact): a session that holds artifact watches is told, in one line, to list them once so a
// watch that failed to arm shows up (the PostToolUse hook artifact-watch.mjs then alerts). Silent for sessions without
// watches. No transcript scan: recorded state and a cached session-metadata lookup only. Fails open.
import { readStdin, opt, passthrough, sessionIsSubagent } from './lib/context.mjs';
import { sessionHoldsWatches, startLine } from './lib/artifact-watch.mjs';

try {
  if (opt('artifact_watch_alerts', true)) {
    const p = readStdin();
    if (!sessionIsSubagent(p) && (p.source === 'resume' || p.source === 'compact') && typeof p.session_id === 'string' && sessionHoldsWatches(p.session_id)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: startLine() } }));
    }
  }
} catch {
  // fail open
}
passthrough();
