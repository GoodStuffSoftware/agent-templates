// PreToolUse on the desktop scheduled-task tools. ADVISORY ONLY: one short
// additionalContext note on routine placement (folder effort pin, start effort,
// the /ac recommend rule). Never blocks, no permissionDecision. Fail-open.
// Kill switch: plugin option `routine_placement_note` (default true).
import { join } from 'node:path';
import { readStdin, opt, passthrough, claudeDir, configDir } from './lib/context.mjs';
import {
  applies, buildNote, folderPin, userDefault, readFolderMap, registerHasId,
} from './lib/routine-placement.mjs';

try {
  if (!opt('routine_placement_note', true)) passthrough();
  const p = readStdin();
  if (!applies(p.tool_name, p.tool_input)) passthrough();
  const cwd = p.cwd || process.cwd();
  const cfg = configDir();
  const note = buildNote({
    cwd,
    pin: folderPin(cwd),
    userDef: userDefault(claudeDir()),
    map: readFolderMap(cfg),
    why: registerHasId(join(cfg, 'decision-register.json')),
  });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note },
  }));
} catch {
  // fail open
}
passthrough();
