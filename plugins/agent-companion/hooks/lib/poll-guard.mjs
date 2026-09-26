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

// Background launches that make harness-tracked work "in flight" — see
// hasInFlightLaunch() below. Named directly in the fix brief: "a background
// Agent/subagent or a background Bash/Monitor task". PowerShell is included
// alongside Bash (same run_in_background mechanism, same tool shape); it is
// not named in the brief but excluding it would be an arbitrary gap.
export const LAUNCH_TOOLS = ['Agent', 'Bash', 'PowerShell'];

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
// A Monitor arm's own timeout_ms at or below this reads as a short-interval
// watch in its own right (see gatedMonitorStreak) — same cadence line as
// ScheduleWakeup's DEFAULT_SHORT_DELAY_S, in milliseconds.
export const DEFAULT_MONITOR_SHORT_TIMEOUT_MS = 600000;
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

// A harness-injected completion record for a backgrounded Agent — verified
// shape (scripts/lib/transcripts.mjs's origin.kind === 'task-notification';
// tests/standing-rules.test.mjs, tests/transcripts-fix.test.mjs):
// `type:"user"`, `isMeta:true`, a top-level `origin:{kind:"task-notification"}`
// when the reader has already classified it, and/or raw text content
// `<task-notification><summary>Agent "NAME" completed</summary></task-notification>`
// — a hook's own tail read gets the RAW record, which may carry the text
// but not the reader's derived `origin`, so both are checked.
function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}
function isTaskNotification(rec) {
  if (!rec || rec.type !== 'user') return false;
  if (rec.origin && rec.origin.kind === 'task-notification') return true;
  if (rec.isMeta !== true) return false;
  return /<task-notification>/i.test(flattenText(rec.message && rec.message.content));
}
// The completed agent's NAME, quoted in the notification's own text (the
// verified format above) — matched against a background Agent launch's own
// `name` input (every backgrounded Agent carries one: spawn-guard's
// namegate, 0.29.9). Null when the text does not carry this shape (a Bash/
// PowerShell/Monitor completion, or an Agent launch with no name).
function completedAgentName(rec) {
  const text = flattenText(rec.message && rec.message.content);
  const m = /<task-notification>[\s\S]*?Agent\s+"([^"]+)"\s+completed/i.exec(text);
  return m ? m[1] : null;
}

// FIX (review finding 1, sharpened per main's follow-up): a short-delay
// noop streak alone cannot tell "polling harness-tracked work the harness
// will notify on anyway" (banned) apart from "polling external state the
// harness cannot track" (sanctioned — a CI run, a deploy, a merge gate:
// ScheduleWakeup's own doc names this exception). The corroborating signal
// the review asked for: a background launch — an Agent (subagent) or
// Bash/PowerShell call with run_in_background:true, or a Monitor watch
// armed — that is STILL OUTSTANDING, not merely one that happened at some
// point in the tail. "In flight" means launched AND not yet completed: a
// launch whose own completion notification already appears later in the
// tail is resolved and must not keep the hint alive.
//
// Pairing:
//   - Agent: by NAME against a completion's quoted name (see
//     completedAgentName above) — the one case with a verified, structured
//     id to pair on.
//   - Bash/PowerShell, and an Agent launch with no name (should not happen
//     post-namegate, kept as a defensive fallback): no verified per-launch
//     id is available cheaply, so these are paired FIFO, by ORDER ONLY,
//     against any task-notification that did not already resolve a named
//     launch. Known limitation, accepted: an unrelated anonymous
//     notification can resolve the wrong anonymous launch when several are
//     outstanding at once; it cannot manufacture a resolution that was
//     never there, so a truly still-outstanding launch is never hidden by
//     one that only LOOKS similar.
//   - Monitor: unconditional (no completion signal is tracked for it here;
//     its OWN re-arm cadence is what evaluate()'s Monitor branch gates).
export function hasInFlightLaunch(records) {
  if (!Array.isArray(records)) return false;
  const unresolvedNamed = new Map();
  let unresolvedAnon = 0;
  for (const rec of records) {
    if (isTaskNotification(rec)) {
      const name = completedAgentName(rec);
      if (name && (unresolvedNamed.get(name) || 0) > 0) {
        unresolvedNamed.set(name, unresolvedNamed.get(name) - 1);
      } else if (unresolvedAnon > 0) {
        unresolvedAnon -= 1;
      }
      continue;
    }
    if (!rec || rec.type !== 'assistant') continue;
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const inp = block.input || {};
      if (block.name === 'Monitor') return true;
      if (LAUNCH_TOOLS.includes(block.name) && inp.run_in_background === true) {
        if (block.name === 'Agent' && typeof inp.name === 'string' && inp.name) {
          unresolvedNamed.set(inp.name, (unresolvedNamed.get(inp.name) || 0) + 1);
        } else {
          unresolvedAnon += 1;
        }
      }
    }
  }
  if (unresolvedAnon > 0) return true;
  for (const n of unresolvedNamed.values()) if (n > 0) return true;
  return false;
}

// FIX (review finding 2): trailingSameDescriptionStreak (unchanged, still
// unit-tested on its own for pure description matching) counts a CANDIDATE
// streak; this walks that same trailing slice backward once more and stops
// counting the moment a re-arm reads as a natural, non-poll expiry —
// Monitor's own doc prescribes exactly that pattern for a long watch ("set
// timeout_ms to the maximum and re-arm on each expiry"). A rearm counts
// toward the streak when EITHER is true (the brief's own "or"):
//   - it happened before the PRIOR arm's own timeout_ms could have expired
//     (elapsed < timeout_ms) — a demonstrably early re-arm, i.e. an actual
//     short-interval poll; or
//   - the prior arm's timeout_ms was itself short (<= shortTimeoutMs) — a
//     short watch by construction, whatever the measured gap.
// `sameDescCalls` must already be the trailing same-description slice, in
// file order (oldest first) — trailingSameDescriptionStreak's own count,
// sliced from the full prior-calls list. `nowTs` is the epoch ms of the
// call about to fire (the live hook: effectively now; the report: the
// historical call's own timestamp — see scripts/lib/poll-guard-report.mjs).
// A missing/unparseable timestamp or timeout_ms on a given arm, with no
// short-timeout evidence either, fails OPEN: the gap cannot be shown to be
// either short or early, so it stops the count rather than assuming it.
export function gatedMonitorStreak(sameDescCalls, nowTs, { shortTimeoutMs = DEFAULT_MONITOR_SHORT_TIMEOUT_MS } = {}) {
  let streak = 0;
  if (!Array.isArray(sameDescCalls)) return streak;
  let afterTs = Number.isFinite(nowTs) ? nowTs : null;
  for (let i = sameDescCalls.length - 1; i >= 0; i--) {
    const inp = sameDescCalls[i].input || {};
    const prevTimeoutMs = Number(inp.timeout_ms);
    const timeoutKnown = Number.isFinite(prevTimeoutMs) && prevTimeoutMs > 0;
    const shortWatch = timeoutKnown && prevTimeoutMs <= shortTimeoutMs;
    const thisTs = Date.parse(sameDescCalls[i].ts || '');
    const rearmedEarly = timeoutKnown && afterTs != null && Number.isFinite(thisTs) &&
      (afterTs - thisTs) < prevTimeoutMs;
    if (!(shortWatch || rearmedEarly)) break;
    streak += 1;
    if (Number.isFinite(thisTs)) afterTs = thisTs;
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
    // FIX (review finding 1): no corroborating in-flight harness launch ->
    // this reads as external-state polling (sanctioned), not a banned poll
    // of work the harness would notify on anyway. No hint, whatever the
    // delay or streak length.
    if (!hasInFlightLaunch(records)) return null;
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
    const shortTimeoutMs = opts.monitorShortTimeoutMs ?? DEFAULT_MONITOR_SHORT_TIMEOUT_MS;
    const calls = priorCallsOf(records, 'Monitor');
    const rawStreak = trailingSameDescriptionStreak(calls, inp.description);
    const sameDescCalls = rawStreak ? calls.slice(calls.length - rawStreak) : [];
    const nowTs = Number.isFinite(opts.now) ? opts.now : Date.now();
    const streak = gatedMonitorStreak(sameDescCalls, nowTs, { shortTimeoutMs });
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
