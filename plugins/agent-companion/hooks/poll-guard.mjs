// Guard (b) — polling wakes (cache-advisor deliverable 7). PreToolUse on
// ScheduleWakeup / Monitor. ADVISORY ONLY: a hint via systemMessage, never a
// block — see hooks/lib/poll-guard.mjs for the detection doctrine and a
// pure, unit-testable evaluate(). Fail-open everywhere: a missing/unreadable
// transcript, a malformed payload, or any thrown error all fall through to
// passthrough() with no hint, never a stall or a block.
//
// Kill switch: plugin option `poll_guard` (default true).
//
// Bash and PowerShell also get the process-kill deny (lib/process-kill-guard.mjs: kill_by_name_guard, plugin uninstall).
// Bash on win32 also gets the python_stdin_guard DENY (hooks/lib/python-stdin.mjs): the only
// blocking path for the main thread; worker_wait_guard (0.31.23) can refuse a worker repeat loop, see below.
//
// Also PreToolUse on Bash / PowerShell, for SUBAGENTS only: the worker one-wait
// rule (workerWaitPattern in lib/poll-guard.mjs). A sleep, poll or watch loop in
// a worker gets one additionalContext line (the model sees it; the lead keeps its
// own rule), and every match is logged to telemetry/worker-wait.jsonl. Kill switch:
// `worker_wait_advisory` (default true). Since 0.31.23 option `worker_wait_guard`
// (hint | deny-repeat | off, default deny-repeat) adds a DENY for a repeat match by the
// same agent within `worker_wait_repeat_window_minutes` of its previous match (see
// workerWaitDecision in lib/poll-guard.mjs); `hint` is the earlier hint-only behaviour.

import {
  readStdin, opt, passthrough, deny, callerTranscriptPath, tailRecords, callerIsSubagent, appendLog, recordDenial,
} from './lib/context.mjs';
import { pythonStdinGuard } from './lib/python-stdin.mjs';
import { processGuard } from './lib/process-kill-guard.mjs';
import { envDumpGuard } from './lib/env-dump-guard.mjs';
import { claimOnce, readStamp, writeStamp } from './lib/subagent-context.mjs';
import { fileURLToPath } from 'node:url';
import {
  evaluate, POLL_TOOLS, TAIL_BYTES, workerWaitPattern, workerWaitHint, workerWaitDenyText, workerWaitDecision,
  workerWaitMode, WORKER_WAIT_WINDOW_MINUTES,
} from './lib/poll-guard.mjs';

// The clock; AGENT_COMPANION_FAKE_NOW (an ISO time) moves it for tests.
function fakeNowMs() {
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  if (fake) { const t = Date.parse(fake); if (Number.isFinite(t)) return t; }
  return Date.now();
}

// The hint, and NO permissionDecision: "allow" would also skip the permission
// prompt for the ScheduleWakeup / Monitor call, which advice has no business
// deciding. Without a decision the normal permission flow applies.
function hint(systemMessage) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse' },
  }));
  process.exit(0);
}

try {
  const p = readStdin();
  const toolName = p.tool_name;

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    // python_stdin_guard (0.31.18): a DENY path in this hook (worker_wait_guard is the other), separate from the advisories
    // below. Bash on win32 only; fail-open (any error falls through to the advisory path).
    // In warn mode the python note does not end the hook: the worker one-wait advisory (and its telemetry row) still run,
    // and the two additionalContext strings go out together.
    let pyNote = null;
    // process_kill guards (0.31.25), Bash and PowerShell on every platform: kill-by-name (kill_by_name_guard deny|warn|off,
    // default deny) and `claude plugin uninstall` (always denied). Fail-open like the rest of this block.
    try {
      const pk = processGuard(p, { mode: String(opt('kill_by_name_guard', 'deny')) });
      if (pk) {
        try { recordDenial(pk.kind, p, pk.detail, pk.mode === 'warn' ? 'warn' : 'deny'); } catch { /* telemetry never blocks */ }
        if (pk.mode === 'deny') deny(pk.message);
        pyNote = pk.message;
      }
    } catch { /* fail open */ }
    // env_dump_guard (0.31.25): bulk environment-value dumps and prints of secret-named variables (deny|warn|off, default deny).
    try {
      const ed = envDumpGuard(p, { mode: String(opt('env_dump_guard', 'deny')) });
      if (ed) {
        try { recordDenial(ed.kind, p, ed.detail, ed.mode === 'warn' ? 'warn' : 'deny'); } catch { /* telemetry never blocks */ }
        if (ed.mode === 'deny') deny(ed.message);
        pyNote = [pyNote, ed.message].filter(Boolean).join('\n\n');
      }
    } catch { /* fail open */ }
    if (toolName === 'Bash') {
      try {
        const mode = String(opt('python_stdin_guard', 'deny')).toLowerCase();
        const py = pythonStdinGuard(p, { mode });
        if (py && py.mode === 'deny') deny(py.message);
        if (py) pyNote = [pyNote, py.message].filter(Boolean).join('\n\n');
      } catch { /* fail open */ }
    }
    const finish = (advisory) => {
      const parts = [pyNote, advisory].filter(Boolean);
      if (!parts.length) passthrough();
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') },
      }));
      process.exit(0);
    };
    const mode = workerWaitMode(opt('worker_wait_guard', 'deny-repeat'));
    if (!callerIsSubagent(p) || !opt('worker_wait_advisory', true) || mode === 'off') finish(null);
    const input = p.tool_input || {};
    const hit = workerWaitPattern(input.command, { background: input.run_in_background === true });
    if (!hit) finish(null);
    const windowMinutes = Math.max(1, opt('worker_wait_repeat_window_minutes', WORKER_WAIT_WINDOW_MINUTES));
    const key = 'worker-wait-' + p.agent_id;
    const now = fakeNowMs();
    const prev = mode === 'deny-repeat' ? readStamp(key) : null;
    const firstClaim = claimOnce(key);
    const d = workerWaitDecision({
      mode, prev, sessionId: p.session_id, nowMs: now, windowMs: windowMinutes * 60000, firstClaim,
    });
    if (mode === 'deny-repeat') writeStamp(key, { s: String(p.session_id ?? ''), t: now });
    appendLog('worker-wait.jsonl', {
      ts: new Date().toISOString(), session_id: p.session_id || null, agent_id: p.agent_id,
      agent_type: p.agent_type || null, tool: toolName, kind: hit.kind, first: d.first, action: d.action,
    });
    if (d.action === 'silent') finish(null);
    const root = process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url));
    if (d.action === 'deny') {
      const text = workerWaitDenyText(root, windowMinutes);
      recordDenial('worker-wait', p, `${hit.kind} repeat within ${windowMinutes} min of the one-wait notice`);
      deny(text);
    }
    finish(workerWaitHint(root, { denyRepeat: mode === 'deny-repeat', windowMinutes }));
  }

  if (!opt('poll_guard', true)) passthrough();
  if (!POLL_TOOLS.includes(toolName)) passthrough();

  const input = p.tool_input || {};
  const path = callerTranscriptPath(p);
  // Both assistant tool_use lines (launches) AND user task-notification
  // lines (their completions) are needed — hasInFlightLaunch() pairs the
  // two (see hooks/lib/poll-guard.mjs) — so the cheap substring prefilter
  // keeps both kinds and drops everything else (prompts, tool results with
  // no notification wrapper, ...).
  const records = path
    ? tailRecords(path, {
      bytes: opt('poll_guard_tail_bytes', TAIL_BYTES),
      filter: (line) => line.includes('"type":"assistant"')
        || (line.includes('"type":"user"') && (line.includes('task-notification') || line.includes('"isMeta":true'))),
    })
    : [];

  const result = evaluate({
    toolName,
    input,
    records,
    opts: {
      noopStreak: opt('poll_guard_noop_streak', 2),
      shortDelaySeconds: opt('poll_guard_short_delay_seconds', 600),
      monitorRearmStreak: opt('poll_guard_monitor_rearm_streak', 2),
      monitorShortTimeoutMs: opt('poll_guard_monitor_short_timeout_ms', 600000),
    },
  });

  if (result) hint(result.hint);
} catch {
  // fail open — this guard is advice, not enforcement
}
passthrough();
