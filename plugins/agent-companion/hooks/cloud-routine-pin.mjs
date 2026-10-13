// PreToolUse on RemoteTrigger create/update: a cloud routine whose job_config names no model
// at job_config.ccr.session_context.model is denied (all routines are evaluated and pinned).
// A full pinned id gets a non-blocking note. Bodies without job_config pass. Fail-open.
// Kill switch: plugin option `routine_pin_rule` (default true).
import { readStdin, opt, deny, passthrough } from './lib/context.mjs';
import { cloudRoutineVerdict } from './lib/cloud-routine-pin.mjs';

try {
  if (!opt('routine_pin_rule', true)) passthrough();
  const p = readStdin();
  if (p.tool_name !== 'RemoteTrigger') passthrough();
  const r = cloudRoutineVerdict(p.tool_input);
  if (r.verdict === 'deny') deny(r.reason);
  if (r.verdict === 'note') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.note },
    }));
  }
} catch {
  // fail open
}
passthrough();
