// Guard (b) — polling wakes (cache-advisor deliverable 7).
//
// Doctrine: "One completion wait, never per-item wakes." When harness-tracked
// background work (a backgrounded Agent/Bash/PowerShell call, or a Monitor
// stream) finishes, the harness re-invokes the caller automatically — a
// short-interval ScheduleWakeup or a re-armed Monitor watching the same thing
// is a poll loop paying a full context re-read on every tick for no new work.
//
// "No new work" is defined from fields the harness itself already writes,
// not guessed from transcript shape:
//   - ScheduleWakeup carries `noop` — the caller's own "nothing changed"
//     signal (see the tool's live schema: true = nothing to report, false =
//     something worth keeping). A run of consecutive `noop:true` ticks IS a
//     run of wakes that produced no new work, by the harness's own account.
//   - Monitor carries no such field, so a comparable signal is built here:
//     re-arming Monitor with the SAME `description` back to back is, by
//     definition, watching the same thing again rather than something new —
//     Monitor's own docs distinguish a genuine recurring-event stream from
//     re-arming as a substitute for a single completion wait.
//
// This module is pure (no I/O, no process.exit) so it is unit-testable
// without spawning a child process; hooks/poll-guard.mjs is the thin
// PreToolUse wrapper that feeds it real stdin + a transcript tail.

export const POLL_TOOLS = ['ScheduleWakeup', 'Monitor'];

// Below this cadence a ScheduleWakeup reads as a poll rather than a long
// fallback heartbeat — the tool's own guidance is 1200s+ for a fallback
// while something else (Monitor, a task notification) is the primary wake
// signal; 600s gives room under that without flagging a deliberate short
// wait for fast-changing external state (the tool's own CI-run example is a
// single ~480s check, not a repeated one).
export const DEFAULT_SHORT_DELAY_S = 600;
// Consecutive PRIOR no-op wakes that trip the hint on the next short-delay
// ScheduleWakeup call (so the 3rd such call in a row is the one that hints).
export const DEFAULT_NOOP_STREAK = 2;
// Consecutive PRIOR Monitor arms of the identical description that trip the
// hint on the next one.
export const DEFAULT_MONITOR_REARM_STREAK = 2;
// Bytes of transcript tail read for prior-call history — bounded and cheap,
// per the brief ("a tail read / mtime", never a full parse).
export const TAIL_BYTES = 131072;

// Prior tool_use calls of `toolName`, oldest first, from an array of already
// -parsed assistant records (e.g. from hooks/lib/context.mjs's tailRecords).
// Never throws on a malformed record.
export function priorCallsOf(records, toolName) {
  const out = [];
  if (!Array.isArray(records)) return out;
  for (const rec of records) {
    if (!rec || rec.type !== 'assistant') continue;
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name === toolName) {
        out.push({ input: block.input || {}, ts: rec.timestamp || null });
      }
    }
  }
  return out;
}

// Trailing run of `noop:true` calls at the END of a ScheduleWakeup history,
// counted backward from the most recent prior call. A `stop:true` call is
// not a wake (it ends the loop) and breaks the streak without counting.
export function trailingNoopStreak(calls) {
  let streak = 0;
  if (!Array.isArray(calls)) return streak;
  for (let i = calls.length - 1; i >= 0; i--) {
    const inp = calls[i].input || {};
    if (inp.stop === true) break;
    if (inp.noop === true) { streak += 1; continue; }
    break;
  }
  return streak;
}

// Trailing run of PRIOR Monitor calls whose `description` (trimmed,
// case-folded) matches the one about to fire.
export function trailingSameDescriptionStreak(calls, description) {
  const norm = String(description || '').trim().toLowerCase();
  let streak = 0;
  if (!norm || !Array.isArray(calls)) return streak;
  for (let i = calls.length - 1; i >= 0; i--) {
    const d = String((calls[i].input || {}).description || '').trim().toLowerCase();
    if (d === norm) { streak += 1; continue; }
    break;
  }
  return streak;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Evaluate whether the about-to-fire ScheduleWakeup/Monitor call is a
// polling-wake episode. `records` is the CALLER's own prior transcript
// records (this call is not in it yet — PreToolUse fires before the tool
// runs). Returns null (never hint) or { streak, hint, kind }.
export function evaluate({ toolName, input, records, opts = {} }) {
  const inp = input || {};
  if (toolName === 'ScheduleWakeup') {
    if (inp.stop === true) return null; // ending the loop is never a poll
    const shortDelayS = opts.shortDelaySeconds ?? DEFAULT_SHORT_DELAY_S;
    const noopStreak = opts.noopStreak ?? DEFAULT_NOOP_STREAK;
    const delay = Number(inp.delaySeconds);
    if (!Number.isFinite(delay) || delay > shortDelayS) return null;
    const calls = priorCallsOf(records, 'ScheduleWakeup');
    const streak = trailingNoopStreak(calls);
    if (streak < noopStreak) return null;
    return {
      kind: 'schedule-wakeup-noop-streak',
      streak,
      delaySeconds: delay,
      hint: `${streak} consecutive no-op wakes at a ${delay}s cadence with nothing to report. One completion ` +
        'wait, never per-item wakes: harness-tracked background work notifies you automatically when it ' +
        'finishes — arm one long fallback (1200s+) instead of polling.',
    };
  }
  if (toolName === 'Monitor') {
    const rearmStreak = opts.monitorRearmStreak ?? DEFAULT_MONITOR_REARM_STREAK;
    const calls = priorCallsOf(records, 'Monitor');
    const streak = trailingSameDescriptionStreak(calls, inp.description);
    if (streak < rearmStreak) return null;
    return {
      kind: 'monitor-rearm-streak',
      streak,
      description: inp.description || null,
      hint: `Re-arming Monitor on "${inp.description || ''}" for the ${ordinal(streak + 1)} time in a row. One ` +
        'completion wait, never per-item wakes: if this is waiting on harness-tracked background work rather ' +
        'than a genuinely new event stream, one long-lived watch (or the background task\'s own completion ' +
        'notification) replaces the re-arms.',
    };
  }
  return null;
}
