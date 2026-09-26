// Guard (b) — polling wakes (cache-advisor deliverable 7). PreToolUse on
// ScheduleWakeup / Monitor. ADVISORY ONLY: a hint via systemMessage, never a
// block — see hooks/lib/poll-guard.mjs for the detection doctrine and a
// pure, unit-testable evaluate(). Fail-open everywhere: a missing/unreadable
// transcript, a malformed payload, or any thrown error all fall through to
// passthrough() with no hint, never a stall or a block.
//
// Kill switch: plugin option `poll_guard` (default true).

import {
  readStdin, opt, passthrough, callerTranscriptPath, tailRecords,
} from './lib/context.mjs';
import { evaluate, POLL_TOOLS, TAIL_BYTES } from './lib/poll-guard.mjs';

function allowWith(systemMessage) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  }));
  process.exit(0);
}

try {
  if (!opt('poll_guard', true)) passthrough();

  const p = readStdin();
  const toolName = p.tool_name;
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

  if (result) allowWith(result.hint);
} catch {
  // fail open — this guard is advice, not enforcement
}
passthrough();
