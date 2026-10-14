// Guard (b) — polling wakes (cache-advisor deliverable 7). PreToolUse on
// ScheduleWakeup / Monitor. ADVISORY ONLY: a hint via systemMessage, never a
// block — see hooks/lib/poll-guard.mjs for the detection doctrine and a
// pure, unit-testable evaluate(). Fail-open everywhere: a missing/unreadable
// transcript, a malformed payload, or any thrown error all fall through to
// passthrough() with no hint, never a stall or a block.
//
// Kill switch: plugin option `poll_guard` (default true).
//
// Bash on win32 also gets the python_stdin_guard DENY (hooks/lib/python-stdin.mjs): the only
// blocking path in this file, independent of the advisory switches above and below.
//
// Also PreToolUse on Bash / PowerShell, for SUBAGENTS only: the worker one-wait
// rule (workerWaitPattern in lib/poll-guard.mjs). A sleep, poll or watch loop in
// a worker gets one additionalContext line per worker (the model sees it; the
// lead keeps its own rule), and every match is logged to
// telemetry/worker-wait.jsonl. Kill switch: `worker_wait_advisory` (default true).

import {
  readStdin, opt, passthrough, deny, callerTranscriptPath, tailRecords, callerIsSubagent, appendLog,
} from './lib/context.mjs';
import { pythonStdinCheck } from './lib/python-stdin.mjs';
import { claimOnce } from './lib/subagent-context.mjs';
import { fileURLToPath } from 'node:url';
import {
  evaluate, POLL_TOOLS, TAIL_BYTES, workerWaitPattern, workerWaitHint,
} from './lib/poll-guard.mjs';

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
    // python_stdin_guard (0.31.18): the one DENY path in this hook, separate from the advisories
    // below. Bash on win32 only; fail-open (any error falls through to the advisory path).
    // In warn mode the python note does not end the hook: the worker one-wait advisory (and its telemetry row) still run,
    // and the two additionalContext strings go out together.
    let pyNote = null;
    if (toolName === 'Bash') {
      try {
        const mode = String(opt('python_stdin_guard', 'deny')).toLowerCase();
        const py = pythonStdinCheck((p.tool_input || {}).command, { mode });
        if (py && py.mode === 'deny') deny(py.message);
        if (py) pyNote = py.message;
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
    if (!callerIsSubagent(p) || !opt('worker_wait_advisory', true)) finish(null);
    const input = p.tool_input || {};
    const hit = workerWaitPattern(input.command, { background: input.run_in_background === true });
    if (!hit) finish(null);
    const first = claimOnce('worker-wait-' + p.agent_id);
    appendLog('worker-wait.jsonl', {
      ts: new Date().toISOString(), session_id: p.session_id || null, agent_id: p.agent_id,
      agent_type: p.agent_type || null, tool: toolName, kind: hit.kind, first,
    });
    if (!first) finish(null);
    const root = process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url));
    finish(workerWaitHint(root));
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
