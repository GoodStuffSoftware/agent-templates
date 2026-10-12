// PreToolUse on Write|Edit of a JS/TS file. ADVISORY ONLY: one short note when
// the written text adds a child_process spawn/exec/execFile/fork call without
// windowsHide in that call. Runs in subagents too. Once per file per session.
// Never blocks, starts no process. Kill switch: option `window_check` (default true).
import { readFileSync } from 'node:fs';
import { readStdin, opt, passthrough } from './lib/context.mjs';
import { WINDOW_NOTE, WINDOW_EXT_RE, addsUnhiddenSpawn, claim } from './lib/advisory-a.mjs';

try {
  if (!opt('window_check', true)) passthrough();
  const p = readStdin();
  const ti = p.tool_input;
  if ((p.tool_name !== 'Write' && p.tool_name !== 'Edit') || !ti || typeof ti.file_path !== 'string') passthrough();
  if (!WINDOW_EXT_RE.test(ti.file_path)) passthrough();
  let text; let context;
  if (p.tool_name === 'Write') {
    text = ti.content; context = text;
  } else {
    text = ti.new_string;
    try { context = readFileSync(ti.file_path, 'utf8'); } catch { context = ''; }
  }
  if (typeof text !== 'string' || !addsUnhiddenSpawn(text, context)) passthrough();
  if (claim('window-check', p.session_id, ti.file_path.replace(/\\/g, '/'))) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: WINDOW_NOTE },
    }));
  }
} catch {
  // fail open
}
passthrough();
