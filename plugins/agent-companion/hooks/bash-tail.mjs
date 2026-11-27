// PreToolUse on Bash: the ONE hook that rewrites a Bash command's input.
//
// Only one PreToolUse hook's updatedInput survives a call, so the rewrites live
// here, in a fixed order, as one `updatedInput`:
//   0. worktree remove (hooks/lib/worktree-remove.mjs, scripts/worktree-remove-safe.mjs):
//      `git worktree remove <tree>` of a tree holding a Windows junction or a directory
//      symlink is rewritten IN PLACE to the safe script, which unlinks each link first
//      (git follows a junction and empties its target). Bash: updatedInput; PowerShell:
//      a denial carrying the rewritten command unless resource_gate_powershell_rewrite.
//      A line it cannot rewrite cleanly is denied. Option worktree_remove_safe (default
//      true). Not seen: `bash -c "..."`, `xargs git worktree remove`, aliases and functions.
//   0b. wait-loop cap (hooks/lib/wait-cap.mjs): a background command's unbounded `until/while ... sleep`
//      loop gets a $SECONDS deadline (option wait_loop_cap_minutes, default 60, 0 = off).
//   1. resource gate (hooks/lib/resource-gate.mjs): a heavy command (full test
//      suite, E2E, emulator, gradle...) is sent through the machine-wide resource
//      queue. Setting resource_gate: rewrite | deny | hint | off, default deny.
//      deny and hint end or annotate the call; rewrite replaces the whole command
//      line (after a leading `cd <dir> &&`) with `node <launcher> run --class <id>
//      --shell bash -- '<line>'`, which runs the line unchanged in bash.
//   2. output tail (below): a known long-runner's output goes to a file and only
//      its tail comes back. It analyzes the command as steps 0 and 1 left it
//      (the worktree-remove rewrite included) and wraps that, so all survive together.
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
// fallback rows: class, mode, command length; never the command text). The worktree-remove
// step writes `worktree-remove-denied` and `worktree-remove-rewritten` rows to the same stream
// (tool, command_chars, count; no mode or classes).

import { isReviewerSession, recordDenial, readStdin, opt, passthrough, noteAgentType, appendLog, telemetryDir, callerIsSubagent, isFixtureSession, writeAndExit } from './lib/context.mjs';
import { isServedCall } from './lib/delegation.mjs';
import {
  analyze, wrapCommand, outputTarget, pruneOldOutputs, modeAllowed, shellPath, TELEMETRY_STREAM,
} from './lib/bash-tail.mjs';
import { diffCapTarget, diffCapWrap } from './lib/diff-cap.mjs';
import { worktreeRemoveDecision } from './lib/worktree-remove.mjs';
import { waitCapRewrite, WAIT_REWRITE_NOTE } from './lib/wait-cap.mjs';
import { tailWaitApplies, tailRewritesWait, tailStampKey, windowMinutesOpt, permissionHit } from './lib/worker-wait-rewrite.mjs';
import { readStamp, writeStamp } from './lib/subagent-context.mjs';
import { gateDecision, gateMode, DEFAULT_GATE_MODE, TELEMETRY_STREAM as GATE_STREAM } from './lib/resource-gate.mjs';

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

let input = null;
let gateCommand = null; // the command after step 1, when the gate rewrote it
let origCommand = null; // the caller's command, when step 0 rewrote it (steps 1 and 2 then see the rewritten text)
let bgRewrite = false; // step 0a made the call a background command (the worker one-wait rewrite)
let gateText = null; // additionalContext from step 1 (hint mode, rewrite note)

// What the call becomes once the tail step is done (or skipped): the gate's
// rewrite and note if there were any, otherwise nothing at all.
function finish(command, extra = {}) {
  const out = { hookEventName: 'PreToolUse' };
  const cmd = command ?? gateCommand ?? (origCommand ? input.command : null);
  if (cmd && input && cmd !== (origCommand ?? input.command)) out.updatedInput = { ...input, command: cmd };
  if (bgRewrite) out.updatedInput = { ...input, command: cmd ?? input.command, run_in_background: true };
  if (gateText) out.additionalContext = gateText;
  if (!out.updatedInput && !out.additionalContext) passthrough();
  Object.assign(out, extra);
  // updatedInput echoes the caller's whole command, so the reply can be large: send it whole (context.mjs).
  writeAndExit(JSON.stringify({ hookSpecificOutput: out }));
}

try {
  const p = readStdin();
  const isPs = p.tool_name === 'PowerShell';
  if (p.tool_name !== 'Bash' && !isPs) passthrough();
  input = p.tool_input;
  if (!input || typeof input.command !== 'string') passthrough();
  if (isServedCall(p)) passthrough();

  // ---- step 0: worktree remove over junctions (scripts/worktree-remove-safe.mjs) ---------
  // A `git worktree remove` of a tree that holds junctions or directory symlinks is rewritten to the
  // safe script (git follows a Windows junction and empties its target). Silent: no note, a rewrite
  // the agent never has to act on; a denial only when a rewrite is not clean. Opt-out: worktree_remove_safe=false.
  try {
    if (opt('worktree_remove_safe', true) && /worktree/.test(input.command) && !permissionHit(p, input.command)) {
      const w = worktreeRemoveDecision(input.command, {
        cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
        shell: isPs ? 'powershell' : 'bash',
        psRewrite: opt('resource_gate_powershell_rewrite', false) === true,
      });
      if (w.action !== 'none') {
        gateRow(p, { event: w.action === 'deny' ? 'worktree-remove-denied' : 'worktree-remove-rewritten', tool: p.tool_name, command_chars: input.command.length, count: w.count });
        if (w.action === 'deny') {
          writeAndExit(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: w.text } }));
        }
        // Fall through: the resource gate and the output tail run on the rewritten text, so one command
        // still gets both rewrites (a heavy command next to the remove is queued or denied as usual).
        origCommand = input.command;
        input = { ...input, command: w.command };
      }
    }
  } catch { /* fails open: the command runs as written */ }

  // ---- step 0a: worker one-wait rewrite (0.31.79) ------------------------------------------
  // A subagent's REPEAT foreground sleep / poll / watch loop (same window and session rule as poll-guard.mjs's deny-repeat) runs as
  // the sanctioned one-wait form, a background command that notifies on finish, instead of being refused. poll-guard.mjs
  // leaves such a call alone; any command this hook rewrites for another reason (heavy, a long-runner, worktree remove) keeps
  // poll-guard's refusal. Own stamp, so it does not race poll-guard's. Bash only; option worker_wait_rewrite (default true).
  try {
    if (tailWaitApplies(p, isPs)) {
      const key = tailStampKey(p);
      const fake = Date.parse(process.env.AGENT_COMPANION_FAKE_NOW || '');
      const now = Number.isFinite(fake) ? fake : Date.now();
      const prev = readStamp(key);
      writeStamp(key, { s: String(p.session_id ?? ''), t: now });
      // The same predicate poll-guard.mjs uses to stand down (lib/worker-wait-rewrite.mjs): the two cannot disagree.
      if (tailRewritesWait(p, { isPs, prev, nowMs: now })) {
        const windowMinutes = windowMinutesOpt();
        gateRow(p, { event: 'worker-wait-rewritten', tool: p.tool_name, command_chars: input.command.length });
        recordDenial('worker-wait', p, 'repeat wait within ' + windowMinutes + ' min, run in the background', 'rewrite');
        bgRewrite = true;
        input = { ...input, run_in_background: true };
        gateText = WAIT_REWRITE_NOTE;
      }
    }
  } catch { /* fails open: poll-guard's refusal applies instead */ }

  // ---- step 0b: wait-loop cap (hooks/lib/wait-cap.mjs) ------------------------------------
  // A BACKGROUND Bash command with an unbounded `until/while ... sleep ...` loop gets a $SECONDS deadline in the
  // loop body (prints `wait-cap: gave up after N min; condition never met`, exit 124). Foreground calls die at the
  // tool timeout and are left alone. Silent: no note. Option wait_loop_cap_minutes (default 60, 0 = off).
  try {
    const capMin = Number(opt('wait_loop_cap_minutes', 60));
    if (!isPs && input.run_in_background === true && capMin > 0 && /sleep/.test(input.command) && !permissionHit(p, input.command)) {
      const c = waitCapRewrite(input.command, capMin);
      if (c) {
        gateRow(p, { event: 'wait-cap-rewritten', tool: p.tool_name, command_chars: input.command.length, count: c.count, cap_minutes: capMin });
        origCommand = origCommand ?? input.command;
        input = { ...input, command: c.command };
      }
    }
  } catch { /* fails open: the command runs as written */ }

  // ---- step 1: the resource gate (independent of the output-tail option) ------
  try {
    const mode = gateMode(opt('resource_gate', DEFAULT_GATE_MODE));
    if (mode !== 'off') {
      const permOk = mode === 'rewrite'
        && modeAllowed(p.permission_mode, opt('resource_gate_permission_modes', 'bypassPermissions'))
        // Fail closed: nothing documents that the PowerShell tool applies updatedInput, and this hook cannot
        // tell. Unless the option is on, a PowerShell rewrite becomes a deny that carries the queued command.
        && (!isPs || opt('resource_gate_powershell_rewrite', false) === true);
      const d = await gateDecision(input.command, {
        payload: p,
        cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
        mode,
        shell: isPs ? 'powershell' : 'bash',
        // Deny and ask rules apply in every mode and are checked against the text
        // that RUNS, so a rewrite is allowed only when no rule could match the
        // original (a rewrite must not step around `Bash(git push:*)`) or the
        // wrapped command.
        rewriteAllowed: (wrapped) => permOk && !permissionHit(p, origCommand ?? input.command) && !permissionHit(p, input.command) && !permissionHit(p, wrapped),
      });
      if (d.action === 'deny') {
        gateRow(p, { event: 'denied', mode, classes: d.classes, tool: p.tool_name, command_chars: input.command.length });
        // The reason carries the wrapped command (tests/resource-gate.test.mjs), so it can be as large as the command.
        writeAndExit(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.text },
        }));
      }
      if (d.action === 'hint') {
        gateRow(p, { event: 'hinted', mode, classes: d.classes, command_chars: input.command.length });
        gateText = d.text;
      }
      if (d.action === 'rewrite') {
        gateRow(p, { event: 'rewritten', mode, classes: d.classes, tool: p.tool_name, command_chars: input.command.length, run_in_background: Boolean(input.run_in_background) });
        gateCommand = d.command;
        gateText = d.text;
      }
    }
  } catch { /* the gate fails open: the command runs as written */ }

  // The PowerShell tool gets the gate only: the output tail is bash-specific.
  if (isPs) finish();

  // ---- step 1b: diff cap (hooks/lib/diff-cap.mjs) -----------------------------------------
  // One git diff / show / log -p call returns at most 400 lines: more goes to a file, and the stat, the first 300 lines and the
  // file's path come back (read the rest by range). Silent; exit status kept. Option diff_cap (default true). Only in the permission modes of
  // bash_tail_permission_modes (default bypassPermissions): the permission rules are checked against the REWRITTEN command, so in other modes an allow
  // rule (Bash(git diff:*)) would stop matching it. Not widened on purpose.
  try {
    if (opt('diff_cap', true) && !gateCommand && !input.run_in_background && diffCapTarget(input.command)
      && modeAllowed(p.permission_mode, opt('bash_tail_permission_modes', 'bypassPermissions'))) {
      const t = outputTarget();
      pruneOldOutputs(t.dir);
      const wrapped = diffCapWrap(input.command, { file: t.file });
      if (!permissionHit(p, input.command) && !permissionHit(p, wrapped)) {
        row(p, { event: 'diff-capped', id: t.id, command_chars: input.command.length });
        finish(wrapped);
      }
    }
  } catch { /* fails open: the diff prints as written */ }

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
