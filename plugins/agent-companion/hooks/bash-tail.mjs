// PreToolUse on Bash — send a known long-runner's output to a file and return
// only its tail (plus the file's path). Rules and the generated shell:
// hooks/lib/bash-tail.mjs. Decision record: docs/adr/0004-bash-output-tail.md.
//
// Runs for the main thread AND for subagents (the 2026-10-02 measurement put
// 78% of plan units in subagents). Returns `updatedInput` with NO
// permissionDecision, exactly as spawn-guard does: "allow" would skip the
// permission prompt, which is not this hook's call to make. A command that is
// not a known long-runner, or is piped, redirected, backgrounded and so on,
// passes through with no output at all.
//
// bash_tail (default true) is the opt-out: `false`, or
// CLAUDE_PLUGIN_OPTION_BASH_TAIL=0 in the environment.
// bash_tail_permission_modes (default "bypassPermissions"): the permission
// modes the rewrite applies in; see modeAllowed() for why.
//
// Telemetry, telemetry/bash-tail.jsonl: `wrapped` rows (this hook) and
// `result` rows (written by the wrapper itself when the command finishes:
// exit code, lines, bytes, characters returned). `skipped` rows only for a
// command that WAS a known runner and was left alone, with the reason.

import { readStdin, opt, passthrough, noteAgentType, appendLog, telemetryDir, callerIsSubagent, isFixtureSession } from './lib/context.mjs';
import { isServedCall } from './lib/delegation.mjs';
import {
  analyze, wrapCommand, outputTarget, pruneOldOutputs, modeAllowed, shellPath, TELEMETRY_STREAM,
} from './lib/bash-tail.mjs';

function row(p, extra) {
  appendLog(TELEMETRY_STREAM, {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_type: p.agent_type,
    caller_is_subagent: callerIsSubagent(p),
    ...extra,
  });
}

try {
  const p = readStdin();
  if (!opt('bash_tail', true)) passthrough();
  if (p.tool_name !== 'Bash') passthrough();
  const input = p.tool_input;
  if (!input || typeof input.command !== 'string') passthrough();
  if (isServedCall(p)) passthrough();
  noteAgentType(p);

  // A background command's output already goes to the task's own file.
  if (input.run_in_background) passthrough();

  const a = analyze(input.command);
  if (!a.runner) passthrough();

  if (!modeAllowed(p.permission_mode, opt('bash_tail_permission_modes', 'bypassPermissions'))) {
    row(p, { event: 'skipped', runner: a.runner, reason: `permission_mode:${p.permission_mode ?? 'absent'}` });
    passthrough();
  }
  if (a.blockers.length) {
    row(p, { event: 'skipped', runner: a.runner, reason: a.blockers.join(',') });
    passthrough();
  }

  const t = outputTarget();
  pruneOldOutputs(t.dir);
  // A fixture or canary session's results must not reach production telemetry
  // (appendLog redirects its own rows; the wrapper's shell write cannot).
  const resultLog = isFixtureSession(p.session_id) ? '' : shellPath(`${telemetryDir()}/${TELEMETRY_STREAM}`);
  const command = wrapCommand(input.command, { file: t.file, dir: t.dir, resultLog, id: t.id });
  row(p, { event: 'wrapped', id: t.id, runner: a.runner, command_chars: input.command.length });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input, command },
    },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
