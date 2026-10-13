// PostToolUse + PostToolUseFailure on Bash: append one row to telemetry/bash-exit.jsonl.
// Record only: prints nothing, never blocks, always exits 0. Rules: hooks/lib/bash-exit.mjs.
// Option bash_exit_telemetry (default true); also off when spawn_telemetry is off.
import { readStdin, opt, passthrough, appendLog, callerIsSubagent } from './lib/context.mjs';
import { exitOf, cmdKey, originalCommand } from './lib/bash-exit.mjs';

try {
  if (!opt('bash_exit_telemetry', true) || !opt('spawn_telemetry', true)) passthrough();
  const p = readStdin();
  if (p.tool_name !== 'Bash' && p.tool_name !== 'PowerShell') passthrough();
  const cmd = p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (!cmd) passthrough();
  const e = exitOf(p);
  let runner = null;
  try {
    // Loaded only for a Bash call that gets a row; a failure here leaves runner null.
    const { analyze } = await import('./lib/bash-tail.mjs');
    runner = analyze(originalCommand(cmd)).runner ?? null;
  } catch { /* fail open */ }
  appendLog('bash-exit.jsonl', {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_id: p.agent_id ? String(p.agent_id) : null,
    agent_type: p.agent_type ?? null,
    caller_is_subagent: callerIsSubagent(p),
    runner,
    cmd_key: cmdKey(cmd),
    exit: e.exit,
    failed: e.failed,
    ...(e.background ? { background: true } : {}),
    ...(e.interrupted ? { interrupted: true } : {}),
  });
} catch {
  // fail open
}
passthrough();
