// PostToolUse on create_scheduled_task: read the new task's SKILL.md; with no `model:` line,
// say exactly which file to edit (all routines are evaluated and pinned). Advisory,
// fail-open. Kill switch: plugin option `routine_pin_rule` (default true).
import { readStdin, opt, claudeDir, passthrough } from './lib/context.mjs';
import { taskModelLine, taskIdFrom, skillPath } from './lib/routine-placement.mjs';

try {
  if (!opt('routine_pin_rule', true)) passthrough();
  const p = readStdin();
  if (p.tool_name !== 'mcp__scheduled-tasks__create_scheduled_task') passthrough();
  const id = taskIdFrom(p.tool_input, p.tool_response);
  if (!id) passthrough();
  const t = taskModelLine(claudeDir(), id);
  if (t.found && !t.model) {
    const path = skillPath(claudeDir(), id);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `Routine pin: the new task's SKILL.md has no model: line, so it would run on the composer's last-selected model. Run /ac recommend for its job, then add \`model: <alias>\` on the line right after \`description:\` in ${path}.`,
      },
    }));
  }
} catch {
  // fail open
}
passthrough();
