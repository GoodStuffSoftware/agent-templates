// The one decision "bash-tail.mjs will rewrite this worker wait to run_in_background", shared by hooks/bash-tail.mjs (which acts on it)
// and hooks/poll-guard.mjs (which stands down only when it is true), so the two cannot drift. Only bash-tail.mjs may return
// updatedInput for a shell tool (Claude Code runs matching hooks in parallel and does not chain updatedInput).
//
// Residual case no code here can see: bash-tail.mjs crashes or times out after poll-guard stood down. The hooks are separate
// processes, so the call then runs in the foreground. Also, poll-guard reads bash-tail's stamp while bash-tail may already have
// written this call's stamp; both stamps move together, so the prediction is the same in practice.

import { homedir } from 'node:os';
import { opt, isReviewerSession, callerIsSubagent, claudeDir, homeRoot } from './context.mjs';
import { isServedCall } from './delegation.mjs';
import { readStamp } from './subagent-context.mjs';
import { analyze as analyzeTail, readPermissionRules, blockingPermissionRule } from './bash-tail.mjs';
import { classifyCommand } from './resource-gate.mjs';
import { workerWaitPattern, workerWaitDecision, workerWaitMode, WORKER_WAIT_WINDOW_MINUTES } from './poll-guard.mjs';

// Enterprise-managed settings, where Claude Code reads them.
function managedSettingsPaths() {
  // All three locations: a path that does not exist on this OS reads as no file.
  return ['C:/Program Files/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json'];
}

// Deny and ask rules from settings (every mode), read once per call, matched against the text that would run.
export function permissionHit(p, command) {
  const managed = homeRoot() === homedir() ? managedSettingsPaths() : [];
  return blockingPermissionRule(readPermissionRules({
    cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
    claudeDirPath: claudeDir(),
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    managedPaths: managed,
    stopAt: homeRoot(),
  }), command);
}

// True when bash-tail has a rewrite of its own for this command (heavy, a known long-runner, a worktree remove). Only one
// rewrite survives a call, so the worker-wait rewrite leaves such a command alone and poll-guard keeps its refusal.
export function tailOwnsCommand(command, cwd) {
  try {
    return classifyCommand(command, { cwd }).heavy.length > 0 || Boolean(analyzeTail(command).runner) || /worktree/.test(command);
  } catch { return true; }
}

export const tailStampKey = (p) => 'worker-wait-tail-' + p.agent_id;
export const windowMinutesOpt = () => Math.max(1, opt('worker_wait_repeat_window_minutes', WORKER_WAIT_WINDOW_MINUTES));

// Step 0a applies to this call at all (bash-tail then reads and rewrites its own stamp, whatever the decision).
export function tailWaitApplies(p, isPs) {
  const input = p.tool_input;
  return Boolean(!isPs && input && typeof input.command === 'string' && !input.run_in_background
    && opt('worker_wait_rewrite', true) && opt('worker_wait_advisory', true)
    && !isReviewerSession() && callerIsSubagent(p) && workerWaitMode(opt('worker_wait_guard', 'deny-repeat')) === 'deny-repeat'
    && workerWaitPattern(input.command, { background: false }));
}

// Whether bash-tail rewrites this call to run in the background. prev = bash-tail's own stamp before this call.
export function tailRewritesWait(p, { isPs = false, prev, nowMs }) {
  if (isServedCall(p) || !tailWaitApplies(p, isPs)) return false;
  const d = workerWaitDecision({
    mode: 'deny-repeat', prev, sessionId: p.session_id, nowMs, windowMs: windowMinutesOpt() * 60000, firstClaim: false,
  });
  const command = p.tool_input.command;
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  return d.action === 'deny' && !tailOwnsCommand(command, cwd) && !permissionHit(p, command);
}

// For poll-guard.mjs: the same decision, reading the stamp read-only.
export function tailWillRewriteWait(p, nowMs) {
  return tailRewritesWait(p, { isPs: p.tool_name === 'PowerShell', prev: readStamp(tailStampKey(p)), nowMs });
}
