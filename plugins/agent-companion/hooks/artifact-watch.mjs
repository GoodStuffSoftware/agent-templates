// PostToolUse on ArtifactComments and Artifact: when the result shows an artifact watch that failed to arm or is not
// connected, inject one directive (push notification + say so + the fix) on a transition into failed, once per failure episode.
// Option artifact_watch_alerts (default on). Fails open and silent: no payload, no match, any error = exit 0, no output.
import { readStdin, opt, passthrough, isMainThread } from './lib/context.mjs';
import { planPostToolUse } from './lib/artifact-watch.mjs';

try {
  if (opt('artifact_watch_alerts', true)) {
    const p = readStdin();
    if (isMainThread(p)) {
      const r = planPostToolUse(p);
      if (r) {
        // Directive first, state second: a timeout after the print cannot lose the alert.
        if (r.text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.text } }));
        r.commit();
      }
    }
  }
} catch {
  // fail open
}
passthrough();
