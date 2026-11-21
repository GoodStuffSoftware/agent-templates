// PreToolUse (no matcher), inside a SUBAGENT only — tell it, mid-run, that its
// own context is past `subagent_context_notice_tokens` (default 110000; 0 turns
// the notice off) or that it just compacted. See lib/subagent-context.mjs for
// what is measured, why PreToolUse can reach a subagent, and the once-only
// claims.
//
// A subagent payload carries agent_id (the main thread's carries none:
// callerIsSubagent, lib/context.mjs), so the lead exits at once. The context
// notice and the ceiling never block: their only output is additionalContext.
//
// The same hook carries the optional context CEILING (lib/context-ceiling.mjs; off by default since 0.31.39): the
// first time the context of a sonnet/high-or-above or opus subagent (never
// haiku, sonnet/low or sonnet/medium) is at or past subagent_ceiling_tokens it
// is told ONCE to write a handoff file and return, so the lead starts a fresh
// worker on the same rung (a second notice only if subagent_ceiling_repeat_tokens
// is set). Gated by the rollout schedule; reuses the
// transcript reading below, so it adds no read. Advice only, never a deny.
//
// The WORKER HANDOFF LIMITS (0.31.60, lib/handoff-limit.mjs) ride on the same reading: the size notice above is the soft limit and
// repeats every subagent_context_notice_repeat_tokens (15000) while the context keeps growing; at subagent_context_hard_tokens (150000) this
// hook DENIES every call except the handoff itself (Write, Edit or Read of a file whose name contains "handoff"; Bash that is only git add,
// commit, push, status, diff or log). Switch subagent_handoff_limits, exemptions subagent_handoff_exempt_types; rows in handoff-limit.jsonl.
// Like the step-budget deny below, this is a deny only on that setting (on by default), and every error fails open.
//
// The STEP BUDGET rides on the same hook (lib/step-budget.mjs). Since 0.31.50 it is not a cap by default: a brief with no `BUDGET: <n>` line
// gets no step note; a brief with one gets a single checkpoint note at n (worded as a progress marker). Only with step_budget_deny on
// (opt-in, default off) does the old cap return: the warning at 80% of the stop and a DENY of every call but a report or detail write past
// it (40/60 for lookup-type helpers, 80/120 otherwise, a `BUDGET: <n>` brief line replaces the stop), and the Nth compaction
// (step_budget_compaction_stop, default 3, 0 = off) stops it the same way. This is the one place the hook can deny, and only on that opt-in;
// options step_budget, step_budget_deny, step_budget_warn, step_budget_stop, step_budget_lookup_warn, step_budget_lookup_stop.
//
// The LONG-RUN marker (lib/long-run.mjs) replaces the old hard maxTurns: 150 on the agent definitions. At 150 tool calls and every further
// 100 the crossing is logged in state/long-runs.jsonl and the lead session is told once (lib/advisory-b.mjs longRunNotices, from the lead-side
// hook, never from here); the helper itself gets one neutral line at 150 that asks only that it keep its detail file current. It never denies.
//
// A brief line `BUDGET: N%` (percent of the weekly plan limit) makes the same hook add ONE allowance note at the helper's
// first call (lib/plan-allowance.mjs; option plan_allowance) and ONE notice when the helper's own spend (its transcript and
// the agents it spawned) reaches allowance_notice_pct (80) percent of the allowance and one at 100%: it should send whoever
// briefed it a short status and keep going. Advice only: nothing stops or denies on it.
//
// Each firing writes one row to telemetry subagent-context.jsonl (phase
// "mid-run") and to the agent's events file, which hooks/runaway-check.mjs
// reads at SubagentStop to tell the lead.

import { readStdin, opt, passthrough, deny, recordDenial, callerIsSubagent, appendLog } from './lib/context.mjs';
import { resolveAgentTranscript } from './lib/runaway.mjs';
import {
  CONTEXT_DEFAULT_TOKENS, readContextSignal, claimSignals, recordEvent, subagentNoticeText, noticeVariant, pruneContextState,
} from './lib/subagent-context.mjs';
import {
  CEILING_DEFAULT_TOKENS, CEILING_REPEAT_DEFAULT_TOKENS, CEILING_LOG, ceilingCheck,
} from './lib/context-ceiling.mjs';
import { HANDOFF_LOG, handoffConfig, handoffActive, noteFirst, repeatDue, hardCheck, handoffRow, denyText } from './lib/handoff-limit.mjs';
import { STEP_LOG, stepBudgetCheck, readBrief } from './lib/step-budget.mjs';
import { longRunCheck, logLongRun } from './lib/long-run.mjs';
import { allowanceNote, allowanceWatch } from './lib/plan-allowance.mjs';

try {
  const p = readStdin();
  if (!callerIsSubagent(p)) passthrough();
  const threshold = opt('subagent_context_notice_tokens', CONTEXT_DEFAULT_TOKENS);
  const ceiling = opt('subagent_ceiling_tokens', CEILING_DEFAULT_TOKENS);
  const repeat = opt('subagent_ceiling_repeat_tokens', CEILING_REPEAT_DEFAULT_TOKENS);
  const stepsOn = opt('step_budget', true);
  const hcfg = handoffConfig(threshold);
  const handoffOn = handoffActive(hcfg, p.agent_type); // false: switch off or an exempt agent type; the compaction note is unaffected

  const path = resolveAgentTranscript(p);
  const wantCtx = threshold > 0 || ceiling > 0 || stepsOn || (handoffOn && hcfg.hard > 0); // the step budget counts compactions itself
  const sig = wantCtx ? readContextSignal(path) : null;
  const sizeLine = handoffOn ? threshold : 0;
  const kinds = threshold > 0 ? claimSignals(p.agent_id, sig, sizeLine, { fresh: true }) : [];
  const repeatNote = handoffOn && sizeLine > 0 && sig && !kinds.includes('size') && !(sig.boundary && sig.turnsAfterBoundary === 0)
    && repeatDue(p.agent_id, sig.ctx, sizeLine, hcfg.repeat);
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
  if (kinds.includes('size')) { noteFirst(p.agent_id, sig.ctx); appendLog(HANDOFF_LOG, handoffRow(p, sig, 'soft', 'notice', sizeLine)); }
  if (repeatNote) appendLog(HANDOFF_LOG, handoffRow(p, sig, 'soft', 'repeat', sizeLine));
  if (kinds.length || nudge || repeatNote) pruneContextState();

  // The hard limit: past it, only the handoff itself goes through (lib/handoff-limit.mjs allowedAtHard).
  const hard = hardCheck(p, sig, { ...hcfg, on: handoffOn });
  if (hard) {
    appendLog(HANDOFF_LOG, hard.row);
    recordDenial('handoff-hard-limit', p, `${p.tool_name} at ${sig.ctx} tokens, limit ${hcfg.hard}`);
    deny(denyText(sig.ctx, hcfg.hard, noticeVariant(readBrief(path), p.agent_type)));
  }

  // The soft long-run note: at 150 tool calls and every further 100, once. Never denies; counted before the step
  // budget so a call that budget denies is still counted.
  const longRun = longRunCheck(p, { transcript: path });
  if (longRun) logLongRun(longRun.row);

  // The step budget: count this call, warn once, deny past the stop. A helper that
  // has reached step_budget_compaction_stop compactions is stopped the same way.
  let step = null;
  if (stepsOn) {
    step = stepBudgetCheck(p, { transcript: path, sig });
    if (step) appendLog(STEP_LOG, step.row);
  }
  if (step && step.deny) {
    recordDenial('step-budget', p, `${step.row.why} at ${step.row.steps} steps`);
    deny(step.deny);
  }

  // The percent allowance note (`BUDGET: N%`, lib/plan-allowance.mjs): once, at the first call. Advice only: never a deny.
  // The 80% and 100% notices of that allowance (option allowance_notice_pct, 0 = off): incremental, one send per threshold.
  const planOn = opt('plan_allowance', true);
  const noticePct = opt('allowance_notice_pct', 80);
  const allowance = planOn ? allowanceNote(p, { transcript: path, sig, noticePct }) : null;
  const nearLimit = planOn && noticePct > 0 ? allowanceWatch(p, { noticePct }) : null;

  const variant = (kinds.includes('size') || repeatNote) ? noticeVariant(readBrief(path), p.agent_type) : 'writer';
  const info = { ctx: sig ? sig.ctx : undefined, hard: handoffOn ? hcfg.hard : 0 };
  const text = [kinds.length ? subagentNoticeText(kinds, threshold, variant, info) : '', repeatNote ? subagentNoticeText(['size'], threshold, variant, info) : '', nudge ? nudge.text : '', step ? step.warn : '', longRun ? longRun.text : '', allowance || '', nearLimit || '']
    .filter(Boolean).join('\n');
  if (!text) passthrough();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
  process.exit(0);
} catch { /* fail open */ }
passthrough();
