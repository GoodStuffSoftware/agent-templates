// Review verdict recorder (hooks/lib/review-verdict.mjs). Two events:
//   PostToolUse ^Agent$          a foreground reviewer's VERDICT line; a background reviewer's launch is remembered
//   SubagentStop (--event stop)  a background reviewer's final message
// Fail open, silent: no output to the model, the Agent result is untouched.
import { readStdin, passthrough, opt } from './lib/context.mjs';
import { recordReviewVerdict, recordBackgroundVerdict } from './lib/review-verdict.mjs';

try {
  const p = readStdin();
  if (opt('spawn_telemetry', true)) {
    const i = process.argv.indexOf('--event');
    const stop = (i >= 0 && process.argv[i + 1] === 'stop') || (p && p.hook_event_name === 'SubagentStop');
    if (stop) recordBackgroundVerdict(p);
    else recordReviewVerdict(p);
  }
} catch { /* fail open */ }
passthrough();
