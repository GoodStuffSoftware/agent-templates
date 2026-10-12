// PreToolUse on Artifact (main thread) and on AskUserQuestion that asks for a UI
// sign-off. ADVISORY ONLY: one short additionalContext note. Never blocks.
// Rate: once per artifact id per 30 minutes; once per session for the question.
// Kill switch: plugin option `publish_check` (default true).
import { readStdin, opt, passthrough, isMainThread } from './lib/context.mjs';
import { PUBLISH_NOTE, ARTIFACT_WINDOW_MS, signoffQuestion, artifactKey, claim } from './lib/advisory-a.mjs';

try {
  if (!opt('publish_check', true)) passthrough();
  const p = readStdin();
  if (!isMainThread(p)) passthrough();
  let fire = false;
  if (p.tool_name === 'Artifact') {
    fire = claim('publish-check', p.session_id, artifactKey(p.tool_input), { windowMs: ARTIFACT_WINDOW_MS });
  } else if (p.tool_name === 'AskUserQuestion' && signoffQuestion(p.tool_input)) {
    fire = claim('publish-check', p.session_id, 'ask-user-question');
  }
  if (fire) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: PUBLISH_NOTE },
    }));
  }
} catch {
  // fail open
}
passthrough();
