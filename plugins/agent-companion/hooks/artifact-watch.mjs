// PostToolUse on ArtifactComments and Artifact: when the result shows an artifact watch that failed to arm or is not
// connected, inject one directive (push notification + say so + the fix), once per session + url + at.
// Option artifact_watch_alerts (default on). Fails open and silent: no payload, no match, any error = exit 0, no output.
import { readStdin, opt, passthrough, isMainThread } from './lib/context.mjs';
import { handlePostToolUse } from './lib/artifact-watch.mjs';

try {
  if (opt('artifact_watch_alerts', true)) {
    const p = readStdin();
    if (isMainThread(p)) {
      const r = handlePostToolUse(p);
      if (r) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.text } }));
      }
    }
  }
} catch {
  // fail open
}
passthrough();
