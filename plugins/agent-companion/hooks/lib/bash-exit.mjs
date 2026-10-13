// Bash exit-status telemetry (record only). Shared by hooks/bash-exit.mjs.
//
// What Claude Code delivers (https://code.claude.com/docs/en/hooks, read 2026-10-13):
//  - PostToolUse fires only "after a tool call succeeds"; the input has tool_input and tool_response.
//  - PostToolUseFailure fires "after a tool call fails": tool_input, `error` (for Bash and
//    PowerShell a command that ran and exited gives a first line `Exit code N`, then the output),
//    optional `is_interrupt`, optional `duration_ms`. No tool_response.
// So success -> exit 0 (unless a defensive field says otherwise); failure -> parse `error`.
// The shape could not be confirmed with a live run, so both events are handled, and a
// PostToolUse payload that carries an error or a non-zero exit field is read as a failure.
import { createHash } from 'node:crypto';

// PreToolUse bash-tail rewrites the command; PostToolUse may show the rewritten text.
// Recover the original from `{ <command>\n} > "$__acf" 2>&1`.
export function originalCommand(command) {
  const s = String(command ?? '');
  if (!s.startsWith('__acf=')) return s;
  const start = s.indexOf('\n{ ');
  const end = s.indexOf('\n} > "$__acf" 2>&1');
  if (start < 0 || end < start) return s;
  return s.slice(start + 3, end);
}

// Same gate, different spelling -> same string: collapse whitespace, drop leading `cd <path> &&`,
// drop a trailing `2>&1` and a trailing `| tail|head ...`.
export function normalizeCommand(command) {
  let c = originalCommand(command).replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = c;
    c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
  } while (c !== prev);
  c = c.replace(/\s*\|\s*(tail|head)(\s+-\S+(\s+\d+)?|\s+\d+)*\s*$/, '');
  c = c.replace(/\s*2>&1\s*$/, '');
  return c.trim();
}

export function cmdKey(command) {
  return createHash('sha1').update(normalizeCommand(command)).digest('hex').slice(0, 12);
}

const asNum = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null));

// -> { exit: number|null, failed: boolean, interrupted: boolean }
// A run_in_background call returns at once: recorded as background (exit null), never as a finished 0.
export function exitOf(p) {
  if (p?.tool_input?.run_in_background === true) return { exit: null, failed: false, interrupted: false, background: true };
  const ev = String(p?.hook_event_name ?? '');
  const err = typeof p?.error === 'string' ? p.error : (p?.error != null ? String(p.error?.message ?? '') : '');
  const r = p?.tool_response && typeof p.tool_response === 'object' ? p.tool_response : null;
  const interrupted = p?.is_interrupt === true || r?.interrupted === true;
  const m = /^\s*Exit code (\d+)/.exec(err);
  if (m) return { exit: Number(m[1]), failed: Number(m[1]) !== 0, interrupted };
  const field = r ? (asNum(r.exit_code) ?? asNum(r.exitCode) ?? asNum(r.returncode)) : null;
  if (field !== null) return { exit: field, failed: field !== 0, interrupted };
  if (interrupted) return { exit: null, failed: false, interrupted: true };
  if (ev === 'PostToolUseFailure' || err || r?.is_error === true) return { exit: null, failed: true, interrupted: false };
  return { exit: 0, failed: false, interrupted: false };
}
