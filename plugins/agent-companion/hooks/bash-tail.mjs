// PreToolUse on Bash: the ONE hook that rewrites a Bash command's input.
//
// Only one PreToolUse hook's updatedInput survives a call, so both rewrites live
// here, in a fixed order, as one `updatedInput`:
//   1. resource gate (hooks/lib/resource-gate.mjs): a heavy command (full test
//      suite, E2E, emulator, gradle...) is sent through the machine-wide resource
//      queue. Setting resource_gate: rewrite | deny | hint | off, default deny.
//      deny and hint end or annotate the call; rewrite replaces the whole command
//      line (after a leading `cd <dir> &&`) with `node <launcher> run --class <id>
//      --shell bash -- '<line>'`, which runs the line unchanged in bash.
//   2. output tail (below): a known long-runner's output goes to a file and only
//      its tail comes back. It analyzes the ORIGINAL command (what the agent
//      wrote) and wraps the command step 1 produced, so both survive together.
//
// The output tail: send a known long-runner's output to a file and return
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
// modes the rewrite applies in; see modeAllowed() for why. Independently of
// the mode, a command is left alone when a deny or ask rule from settings
// (user, project, local, managed) could match the original or a helper command
// the wrapper adds (readPermissionRules / blockingPermissionRule).
//
// Telemetry, telemetry/bash-tail.jsonl: `wrapped` rows (this hook) and
// `result` rows (written by the wrapper itself when the command finishes:
// exit code, lines, bytes, characters returned). `skipped` rows only for a
// command that WAS a known runner and was left alone, with the reason.
// The gate writes telemetry/resource-gate.jsonl (denied | hinted | rewritten |
// fallback rows: class, mode, command length; never the command text).

import { readStdin, opt, passthrough, noteAgentType, appendLog, telemetryDir, callerIsSubagent, isFixtureSession, claudeDir, homeRoot } from './lib/context.mjs';
import { homedir } from 'node:os';
import { isServedCall } from './lib/delegation.mjs';
import {
  analyze, wrapCommand, outputTarget, pruneOldOutputs, modeAllowed, shellPath, TELEMETRY_STREAM,
  readPermissionRules, blockingPermissionRule,
} from './lib/bash-tail.mjs';
import { gateDecision, gateMode, DEFAULT_GATE_MODE, TELEMETRY_STREAM as GATE_STREAM } from './lib/resource-gate.mjs';

// Enterprise-managed settings, where Claude Code reads them.
function managedSettingsPaths() {
  if (process.platform === 'win32') return ['C:/Program Files/ClaudeCode/managed-settings.json'];
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function row(p, extra) {
  appendLog(TELEMETRY_STREAM, {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_type: p.agent_type,
    caller_is_subagent: callerIsSubagent(p),
    ...extra,
  });
}

function gateRow(p, extra) {
  appendLog(GATE_STREAM, {
    at: new Date().toISOString(),
    session_id: String(p.session_id ?? ''),
    agent_type: p.agent_type,
    caller_is_subagent: callerIsSubagent(p),
    ...extra,
  });
}

// Deny and ask rules from settings (every mode), read once per call, matched
// against the text that would run.
function permissionHit(p, command) {
  const managed = homeRoot() === homedir() ? managedSettingsPaths() : [];
  return blockingPermissionRule(readPermissionRules({
    cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
    claudeDirPath: claudeDir(),
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    managedPaths: managed,
    stopAt: homeRoot(),
  }), command);
}

let input = null;
let gateCommand = null; // the command after step 1, when the gate rewrote it
let gateText = null; // additionalContext from step 1 (hint mode, rewrite note)

// What the call becomes once the tail step is done (or skipped): the gate's
// rewrite and note if there were any, otherwise nothing at all.
function finish(command, extra = {}) {
  const out = { hookEventName: 'PreToolUse' };
  const cmd = command ?? gateCommand;
  if (cmd && input && cmd !== input.command) out.updatedInput = { ...input, command: cmd };
  if (gateText) out.additionalContext = gateText;
  if (!out.updatedInput && !out.additionalContext) passthrough();
  Object.assign(out, extra);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
  process.exit(0);
}

try {
  const p = readStdin();
  if (p.tool_name !== 'Bash') passthrough();
  input = p.tool_input;
  if (!input || typeof input.command !== 'string') passthrough();
  if (isServedCall(p)) passthrough();

  // ---- step 1: the resource gate (independent of the output-tail option) ------
  try {
    const mode = gateMode(opt('resource_gate', DEFAULT_GATE_MODE));
    if (mode !== 'off') {
      const permOk = mode === 'rewrite'
        && modeAllowed(p.permission_mode, opt('resource_gate_permission_modes', 'bypassPermissions'));
      const d = await gateDecision(input.command, {
        cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
        mode,
        // Deny and ask rules apply in every mode and are checked against the text
        // that RUNS, so a rewrite is allowed only when no rule could match the
        // original (a rewrite must not step around `Bash(git push:*)`) or the
        // wrapped command.
        rewriteAllowed: (wrapped) => permOk && !permissionHit(p, input.command) && !permissionHit(p, wrapped),
      });
      if (d.action === 'deny') {
        gateRow(p, { event: 'denied', mode, classes: d.classes, command_chars: input.command.length });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.text },
        }));
        process.exit(0);
      }
      if (d.action === 'hint') {
        gateRow(p, { event: 'hinted', mode, classes: d.classes, command_chars: input.command.length });
        gateText = d.text;
      }
      if (d.action === 'rewrite') {
        gateRow(p, { event: 'rewritten', mode, classes: d.classes, command_chars: input.command.length, run_in_background: Boolean(input.run_in_background) });
        gateCommand = d.command;
        gateText = d.text;
      }
    }
  } catch { /* the gate fails open: the command runs as written */ }

  // ---- step 2: the output tail -------------------------------------------------
  if (!opt('bash_tail', true)) finish();
  noteAgentType(p);

  // A background command's output already goes to the task's own file.
  if (input.run_in_background) finish();

  const a = analyze(input.command);
  if (!a.runner) finish();

  if (!modeAllowed(p.permission_mode, opt('bash_tail_permission_modes', 'bypassPermissions'))) {
    row(p, { event: 'skipped', runner: a.runner, reason: `permission_mode:${p.permission_mode ?? 'absent'}` });
    finish();
  }
  if (a.blockers.length) {
    row(p, { event: 'skipped', runner: a.runner, reason: a.blockers.join(',') });
    finish();
  }

  // Deny and ask rules apply in EVERY mode (bypassPermissions too) and are
  // matched against the rewritten text, which carries rm, tail, grep, printf
  // and redirects. If any rule could match the original or a helper, the
  // command runs as written. The managed-settings file is skipped when the
  // home directory is redirected (a test fixture) so a real one cannot leak in.
  const toRun = gateCommand ?? input.command;
  const hit = permissionHit(p, toRun);
  if (hit) {
    row(p, { event: 'skipped', runner: a.runner, reason: `permission-rule:${hit.kind}` });
    finish();
  }

  const t = outputTarget();
  pruneOldOutputs(t.dir);
  // A fixture or canary session's results must not reach production telemetry
  // (appendLog redirects its own rows; the wrapper's shell write cannot).
  const resultLog = isFixtureSession(p.session_id) ? '' : shellPath(`${telemetryDir()}/${TELEMETRY_STREAM}`);
  const command = wrapCommand(toRun, { file: t.file, dir: t.dir, resultLog, id: t.id });
  row(p, { event: 'wrapped', id: t.id, runner: a.runner, command_chars: input.command.length });
  finish(command);
} catch {
  // Never break a session: keep the gate's rewrite if there is one, else pass.
  try { finish(); } catch { /* exit */ }
  passthrough();
}
