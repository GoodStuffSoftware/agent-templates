// Deliver queued runaway-spawn notices to the LEAD session.
//
// hooks/runaway-check.mjs queues a one-line notice per runaway subagent,
// keyed by the lead's session_id (lib/runaway.mjs). This drains that queue
// into the lead's context via additionalContext on two events, both
// documented to add it to the model's context:
//   UserPromptSubmit     every lead prompt, including the task-notification
//                        turn that reports a background worker done;
//   PostToolUse ^Agent$  right after a FOREGROUND spawn returns (its
//                        SubagentStop has already run).
// Lead only: a payload carrying agent_id comes from inside a subagent (real
// main-thread payloads carry no agent_id and no agent_type), and is ignored —
// callerIsSubagent(), the one shared test (lib/context.mjs).
//
// The session budget advisory rides the same path (lib/session-budget.mjs):
// before draining, this hook adds up the whole session's plan units (the lead
// plus every subagent, incrementally) and, when the total has crossed another
// multiple of `session_budget_units` (default 350; 0 is off), queues one notice
// that the drain below then delivers. It only ever advises.
//
// A third line source, on UserPromptSubmit only: background workers an interrupt of the lead cut off (lib/interrupted-workers.mjs,
// option interrupted_worker_notice, default on), each reported once.
//
// The event name is taken from the payload. The drain's rename makes each
// notice appear exactly once. Empty stdout when there is nothing queued.

import { readStdin, passthrough, callerIsSubagent, opt, stateRootPath } from './lib/context.mjs';
import {
  flagLine as releaseWatchLine, isHoldActive, clear as clearWatch, now as nowMs, noteShown, noteCandidate, confirmCandidates,
  matchHumanPrompt, promptSha, CLEAR_WORDS_RE,
} from './lib/release-watch-state.mjs';
import { unattendedReason } from '../scripts/lib/usage/surface.mjs';
import { drainNotices, renderNotices } from './lib/runaway.mjs';
import { interruptedNotices } from './lib/interrupted-workers.mjs';
import { checkSessionBudget, SESSION_BUDGET_DEFAULT_UNITS } from './lib/session-budget.mjs';

const EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

try {
  const p = readStdin();
  if (callerIsSubagent(p)) passthrough();
  const event = EVENTS.has(p.hook_event_name) ? p.hook_event_name : null;
  if (!event) passthrough();
  try { checkSessionBudget(p, { threshold: opt('session_budget_units', SESSION_BUDGET_DEFAULT_UNITS) }); } catch { /* advisory: never in the way */ }
  const interrupted = event === 'UserPromptSubmit' && opt('interrupted_worker_notice', true) ? interruptedNotices(p) : [];
  // Release watch: the open-flag or hold line on every lead prompt. Only a typed prompt (origin human, proven by the payload or the
  // transcript) stops the hold countdown or lifts a hold; scheduled wakeups, notifications and peer messages never do.
  let watch = null;
  if (event === 'UserPromptSubmit') {
    try {
      if (unattendedReason({ payload: p, root: stateRootPath() }) === null) {
        const prompt = String(p.prompt || '');
        const at = nowMs();
        // The operator's words lift a hold only from a typed prompt. When the transcript record is not written yet, a candidate is
        // kept and the hold stays; the next prompt confirms it.
        const typedNow = () => (p.origin && p.origin.kind === 'human')
          || matchHumanPrompt(p.transcript_path, promptSha(prompt), at - 120e3, at + 10e3);
        const wantsClear = isHoldActive() && CLEAR_WORDS_RE.test(prompt.trim());
        if (wantsClear && typedNow()) {
          clearWatch({ by: 'prompt' });
          watch = '[agent-companion] The release hold is lifted on the operator\'s word: new agents, heavy jobs and running workers carry on.';
        } else {
          confirmCandidates({ at });                      // a candidate from an earlier turn of any session
          if (wantsClear || !/^\s*[<[]/.test(prompt)) {   // cheap pre-filter: skip system-looking text
            noteCandidate({ sessionId: p.session_id, transcriptPath: p.transcript_path, prompt, payloadOrigin: p.origin, at });
          }
          watch = releaseWatchLine();
          if (watch && wantsClear) watch += ' The "clear hold" words could not be confirmed as typed by the operator yet: ask the operator to repeat "clear hold", or run the clear command after the operator says so.';
          if (watch) noteShown(p.session_id, at);         // after the candidate: this turn's prompt was typed before the line was shown
        }
      }
    } catch { watch = null; }
  }
  const text = [watch, renderNotices(drainNotices(p.session_id)), ...interrupted].filter(Boolean).join('\n');
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }));
  process.exit(0);
} catch {
  passthrough();
}
