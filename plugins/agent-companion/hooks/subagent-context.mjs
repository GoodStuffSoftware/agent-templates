// PreToolUse (no matcher), inside a SUBAGENT only — tell it, mid-run, that its
// own context is past `subagent_context_notice_tokens` (default 300000; 0 turns
// the notice off) or that it just compacted. See lib/subagent-context.mjs for
// what is measured, why PreToolUse can reach a subagent, and the once-only
// claims.
//
// A subagent payload carries agent_id (the main thread's carries none:
// callerIsSubagent, lib/context.mjs), so the lead exits at once. The context
// notice and the ceiling never block: their only output is additionalContext.
//
// The same hook carries the optional context CEILING (default 0 = off since 0.31.39) (lib/context-ceiling.mjs): the
// first time the context of a sonnet/high-or-above or opus subagent (never
// haiku, sonnet/low or sonnet/medium) is at or past subagent_ceiling_tokens it
// is told ONCE to write a handoff file and return, so the lead starts a fresh
// worker on the same rung (a second notice only if subagent_ceiling_repeat_tokens
// is set). Gated by the rollout schedule; reuses the
// transcript reading below, so it adds no read. Advice only, never a deny.
//
// The STEP BUDGET rides on the same hook (lib/step-budget.mjs): it counts the helper's
// tool calls, warns once at the soft line and DENIES every call but a report or detail
// write past the hard one (40/60 for lookup-type helpers, 80/120 otherwise, a `BUDGET: <n>`
// brief line replaces the stop). A second compaction stops the helper the same way. This
// is the one place the hook denies; options step_budget, step_budget_warn, step_budget_stop,
// step_budget_lookup_warn, step_budget_lookup_stop.
//
// Each firing writes one row to telemetry subagent-context.jsonl (phase
// "mid-run") and to the agent's events file, which hooks/runaway-check.mjs
// reads at SubagentStop to tell the lead.

import { readStdin, opt, passthrough, deny, recordDenial, callerIsSubagent, appendLog } from './lib/context.mjs';
import { resolveAgentTranscript } from './lib/runaway.mjs';
import {
  CONTEXT_DEFAULT_TOKENS, readContextSignal, claimSignals, recordEvent, subagentNoticeText, pruneContextState,
} from './lib/subagent-context.mjs';
import {
  CEILING_DEFAULT_TOKENS, CEILING_REPEAT_DEFAULT_TOKENS, CEILING_LOG, ceilingCheck,
} from './lib/context-ceiling.mjs';
import { STEP_LOG, stepBudgetCheck } from './lib/step-budget.mjs';

try {
  const p = readStdin();
  if (!callerIsSubagent(p)) passthrough();
  const threshold = opt('subagent_context_notice_tokens', CONTEXT_DEFAULT_TOKENS);
  const ceiling = opt('subagent_ceiling_tokens', CEILING_DEFAULT_TOKENS);
  const repeat = opt('subagent_ceiling_repeat_tokens', CEILING_REPEAT_DEFAULT_TOKENS);
  const stepsOn = opt('step_budget', true);
  if (!(threshold > 0) && !(ceiling > 0) && !stepsOn) passthrough();

  const path = resolveAgentTranscript(p);
  const wantCtx = threshold > 0 || ceiling > 0 || stepsOn; // the step budget counts compactions itself
  const sig = wantCtx ? readContextSignal(path) : null;
  const kinds = threshold > 0 ? claimSignals(p.agent_id, sig, threshold, { fresh: true }) : [];
  const nudge = ceilingCheck(p, sig, { ceiling, repeat });

  const at = new Date().toISOString();
  for (const kind of kinds) {
    const row = {
      at, session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type, model: sig.model || null,
      kind, phase: 'mid-run', tokens: sig.ctx, threshold,
      ...(kind === 'compaction' ? { trigger: sig.boundary.trigger, pre_tokens: sig.boundary.preTokens } : {}),
    };
    appendLog('subagent-context.jsonl', row);
    recordEvent(p.agent_id, row);
  }
  if (nudge) appendLog(CEILING_LOG, nudge.row);
  if (kinds.length || nudge) pruneContextState();

  // The step budget: count this call, warn once, deny past the stop. A helper that
  // has compacted twice is stopped the same way.
  let step = null;
  if (stepsOn) {
    step = stepBudgetCheck(p, { transcript: path, sig });
    if (step) appendLog(STEP_LOG, step.row);
  }
  if (step && step.deny) {
    recordDenial('step-budget', p, `${step.row.why} at ${step.row.steps} steps`);
    deny(step.deny);
  }

  const text = [kinds.length ? subagentNoticeText(kinds, threshold) : '', nudge ? nudge.text : '', step ? step.warn : '']
    .filter(Boolean).join('\n');
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
  process.exit(0);
} catch { /* fail open */ }
passthrough();
