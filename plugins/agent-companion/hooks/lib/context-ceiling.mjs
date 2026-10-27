// Subagent context ceiling: an optional handoff nudge, OFF by default since 0.31.39
// (subagent_ceiling_tokens default 0). Workers compact instead of handing off: lead
// handoffs were measured on 2026-10-09 as saving nothing, and a 2026-10-27 compaction
// replay (tasks/usage-why-2026-10-06/compaction-replay-detail.md) confirmed one fixed
// compaction point is enough. The code stays, so a positive value turns the nudge back on.
//
// Why (when it is on). A subagent that keeps working past ~175K tokens of context pays more
// per call and ends up compacting at ~217K. The operator-approved alternative
// (2026-10-10, evidence: tasks/usage-why-2026-10-06/ceiling-detail.md, first
// ceiling C = 150K; raised to 175K on 2026-10-16 from a simulation over 544
// workers: 18% fewer handoffs, about 40K of headroom left before the ~217K
// subagent compaction) is to have the worker write a checkpoint file and
// return, so the lead continues with a FRESH worker that reads it.
//
// Which rungs (operator, 2026-10-13). Only sonnet/high, sonnet/xhigh and every
// opus rung are nudged (ceilingRung). Haiku, sonnet/low and sonnet/medium keep
// their current behaviour (the 300K kind=size notice only). The set is read
// from config/model-tiers.json (ladder + ladderVariants), not hard-coded. The
// nudge fires ONCE per worker (the repeat line defaults to 0 = off).
//
// What. hooks/subagent-context.mjs (PreToolUse, inside the subagent) already
// reads the subagent's own context size from the tail of its transcript; the
// ceiling reuses that reading (no second file read). The first time the
// context is at or past `subagent_ceiling_tokens` (default 0 = off) the
// subagent is nudged ONCE; only if `subagent_ceiling_repeat_tokens` is set (default
// 0 = off) and it keeps growing to that line is it nudged a second and last time.
// A worker first seen already past the repeat line gets one nudge, not two. Advice only: the hook
// output is additionalContext and nothing else, never a deny. The existing
// at-compaction wrap-up (lib/subagent-context.mjs) is unchanged and stays the
// backstop.
//
// Rollout gate. The operator rolls changes out one per day. The nudge does
// nothing until `activeFrom` for change id "context-ceiling" in the shared
// schedule <state root>/rollout.json ({ "<change-id>": "<UTC timestamp>" })
// has passed. A missing or unreadable file, a missing id or a bad timestamp
// all mean OFF. AGENT_COMPANION_FAKE_NOW moves the clock for tests.
//
// Log. Every nudge is one row in telemetry context-ceiling.jsonl (UTC time,
// agent type, agent_id, context tokens, tier), for the scout's daily count.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRootPath, modelTiers, ladderVariants } from './context.mjs';
import { claimOnce, fmtTokens } from './subagent-context.mjs';

export const CEILING_CHANGE_ID = 'context-ceiling';
export const CEILING_DEFAULT_TOKENS = 0; // off: compaction handles worker context
export const CEILING_MEASURE_TOKENS = 175000; // the line the daily checkup measures shareOverCeilingPct against while the nudge is off
export const CEILING_REPEAT_DEFAULT_TOKENS = 0; // once per worker; set a line above the ceiling (e.g. 200000) for a second notice
export const CEILING_LOG = 'context-ceiling.jsonl';

const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

// Does the handoff nudge apply to this worker? Ladder agents (and the browser
// variants) are judged by their model + effort in config/model-tiers.json:
// opus at any effort, or sonnet at high and above. Any other agent type is
// judged by the transcript's model id: opus yes, anything else silent (its
// effort is unknown). Returns 'opus' | 'sonnet-high+' | null.
export function ceilingRung(agentType, model) {
  const bare = String(agentType || '').replace(/^[^:]*:/, '');
  let spec = null;
  try {
    const cfg = modelTiers();
    const ladder = Array.isArray(cfg.ladder) ? cfg.ladder : [];
    spec = [...ladder, ...ladderVariants()].find((r) => r && r.agent === bare) || null;
  } catch { spec = null; }
  if (spec) {
    if (spec.model === 'opus') return 'opus';
    if (spec.model === 'sonnet' && (EFFORT_RANK[spec.effort] || 0) >= EFFORT_RANK.high) return 'sonnet-high+';
    return null;
  }
  if (/^ac-/.test(bare)) return null; // an ac- name the table does not know: stay silent
  return /opus/i.test(String(model || '')) ? 'opus' : null;
}

export function rolloutFile() { return join(stateRootPath(), 'rollout.json'); }

export function nowMs() {
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  if (fake) { const t = Date.parse(fake); if (Number.isFinite(t)) return t; }
  return Date.now();
}

// true only when rollout.json holds a parseable activeFrom for `id` that is
// not in the future. Everything else is OFF.
export function rolloutActive(id = CEILING_CHANGE_ID, now = nowMs()) {
  try {
    // PowerShell 5.1 writes a UTF-8 BOM; strip it rather than fail closed.
    const j = JSON.parse(readFileSync(rolloutFile(), 'utf8').replace(/^\uFEFF/, ''));
    const v = j && typeof j === 'object' ? j[id] : undefined;
    // activeFrom is UTC: a date-time with no zone designator is read as UTC, not local time.
    const t = typeof v === 'string' ? Date.parse(/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(v.trim()) ? `${v.trim()}Z` : v) : NaN;
    return Number.isFinite(t) && t <= now;
  } catch {
    return false;
  }
}

// 0 = no nudge, 1 = first, 2 = second. Claims are taken here, so a caller that
// gets a tier back owns it.
export function claimCeilingTier(agentId, ctx, ceiling, repeat) {
  if (!(ceiling > 0) || !agentId || typeof ctx !== 'number' || ctx < ceiling) return 0;
  const pastRepeat = repeat > 0 && ctx >= repeat;
  if (claimOnce(`ceiling-1-${agentId}`)) {
    if (pastRepeat) claimOnce(`ceiling-2-${agentId}`); // first seen late: one nudge, not two
    return 1;
  }
  if (pastRepeat && claimOnce(`ceiling-2-${agentId}`)) return 2;
  return 0;
}

export function ceilingNoticeText(tier, ctx, ceiling, repeat) {
  const n = fmtTokens(ctx);
  if (tier === 2) {
    return `[agent-companion] Handoff checkpoint, second and last notice: your context is about ${n} tokens and still growing past ${fmtTokens(repeat)}. `
      + 'Do not start another step. Write the handoff file now and return.';
  }
  return `[agent-companion] Handoff checkpoint: your context is about ${n} tokens, past the ${fmtTokens(ceiling)}-token line for this rung. `
    + 'Stop starting new work. Write a handoff file (<task>-handoff.md, in the directory your brief names for outputs; not REPORT/SUMMARY/FINDINGS/ANALYSIS) '
    + 'with: state (what is done and what is verified), files touched, next step, open questions. Then return. '
    + 'Your final message gives the handoff path and STATUS: partial, so the lead starts a fresh worker on the same rung that reads it. '
    + 'If you cannot write files, put the handoff in your final message instead.';
}

// The whole check. Returns { tier, text, row } or null. Cheap exits first: the
// context under the ceiling never touches the schedule file.
export function ceilingCheck(p, sig, { ceiling, repeat }) {
  if (!sig || !(ceiling > 0) || typeof sig.ctx !== 'number' || sig.ctx < ceiling) return null;
  // A compaction with no request after it yet: ctx is still the pre-compaction size.
  if (sig.boundary && sig.turnsAfterBoundary === 0) return null;
  const rungClass = ceilingRung(p.agent_type, sig.model);
  if (!rungClass) return null; // no claim, no log
  if (!rolloutActive()) return null;
  const tier = claimCeilingTier(p.agent_id, sig.ctx, ceiling, repeat);
  if (!tier) return null;
  return {
    tier,
    text: ceilingNoticeText(tier, sig.ctx, ceiling, repeat),
    row: {
      at: new Date().toISOString(), session_id: p.session_id, agent_type: p.agent_type, agent_id: p.agent_id,
      model: sig.model || null, tokens: sig.ctx, tier, rung_class: rungClass, ceiling, repeat,
    },
  };
}
