// PreToolUse on the desktop spawn_task (chip) tool, lead only. ADVISORY ONLY:
// one short note, once per session. Never blocks.
// Kill switch: plugin option `chip_check` (default true).
import { readStdin, opt, passthrough, isMainThread } from './lib/context.mjs';
import { CHIP_NOTE, isSpawnTask, claim } from './lib/advisory-a.mjs';

try {
  if (!opt('chip_check', true)) passthrough();
  const p = readStdin();
  if (!isMainThread(p) || !isSpawnTask(p.tool_name)) passthrough();
  if (claim('chip-check', p.session_id, 'chip')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: CHIP_NOTE },
    }));
  }
} catch {
  // fail open
}
passthrough();
