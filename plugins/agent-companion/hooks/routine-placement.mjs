// PreToolUse on the desktop scheduled-task tools. ADVISORY ONLY: one short
// additionalContext note on routine placement (folder effort pin, start effort,
// the /ac recommend rule). Never blocks, no permissionDecision. Fail-open.
// Kill switch: plugin option `routine_placement_note` (default true).
import { join } from 'node:path';
import { readStdin, opt, passthrough, claudeDir, configDir } from './lib/context.mjs';
import {
  applies, buildNote, folderPinInfo, userDefault, readFolderMap, registerHasId, taskModelLine, pinApplicability, skillPath,
} from './lib/routine-placement.mjs';

try {
  if (!opt('routine_placement_note', true)) passthrough();
  const p = readStdin();
  if (!applies(p.tool_name, p.tool_input)) passthrough();
  const cwd = p.cwd || process.cwd();
  const cfg = configDir();
  const info = folderPinInfo(cwd);
  const taskId = p.tool_input && typeof p.tool_input.taskId === 'string' ? p.tool_input.taskId : '';
  const taskModel = taskModelLine(claudeDir(), taskId);
  const note = buildNote({
    cwd,
    pin: info ? info.text : null,
    pinStart: info ? info.start : null,
    taskModel,
    applic: pinApplicability(cwd, taskModel.model),
    skill: skillPath(claudeDir(), taskId),
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
