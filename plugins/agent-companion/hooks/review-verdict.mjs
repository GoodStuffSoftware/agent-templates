// PostToolUse ^Agent$: record a reviewer's VERDICT line (hooks/lib/review-verdict.mjs).
// Fail open, silent: no output to the model, the Agent result is untouched.
import { readStdin, passthrough, opt } from './lib/context.mjs';
import { recordReviewVerdict } from './lib/review-verdict.mjs';

try {
  const p = readStdin();
  if (opt('spawn_telemetry', true)) recordReviewVerdict(p);
} catch { /* fail open */ }
passthrough();
