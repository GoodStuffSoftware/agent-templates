// Subagent context ceiling: a checkpoint nudge at 150K tokens.
//
// Why. A subagent that keeps working past ~150K tokens of context pays more
// per call and ends up compacting at ~217K. The operator-approved alternative
// (2026-10-10, evidence: tasks/usage-why-2026-10-06/ceiling-detail.md, best
// ceiling C = 150K) is to have the worker write a checkpoint file and return,
// so the lead continues with a FRESH worker that reads it.
//
// What. hooks/subagent-context.mjs (PreToolUse, inside the subagent) already
// reads the subagent's own context size from the tail of its transcript; the
// ceiling reuses that reading (no second file read). The first time the
// context is at or past `subagent_ceiling_tokens` (default 150000) the
// subagent is nudged ONCE; if it keeps growing to `subagent_ceiling_repeat_tokens`
// (default 175000) it is nudged a second and last time. A worker first seen
// already past the repeat line gets one nudge, not two. Advice only: the hook
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
import { stateRootPath } from './context.mjs';
import { claimOnce, fmtTokens } from './subagent-context.mjs';

export const CEILING_CHANGE_ID = 'context-ceiling';
export const CEILING_DEFAULT_TOKENS = 150000;
export const CEILING_REPEAT_DEFAULT_TOKENS = 175000;
export const CEILING_LOG = 'context-ceiling.jsonl';

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
    return `[agent-companion] Context checkpoint, second and last notice: your context is about ${n} tokens and still growing past ${fmtTokens(repeat)}. `
      + 'Do not start another step. Write the checkpoint file now and return.';
  }
  return `[agent-companion] Context checkpoint: your context is about ${n} tokens, past the ${fmtTokens(ceiling)}-token ceiling for subagents. `
    + 'Stop starting new work. Write a checkpoint file (name it <task>-checkpoint.md, in the directory your brief names for outputs; not REPORT/SUMMARY/FINDINGS/ANALYSIS) '
    + 'holding: the goal, what is done, the remaining steps, key paths, and open findings. Then return. '
    + 'Your final message gives the checkpoint file path and a proposed split of the remaining work, so the lead can continue with a fresh worker that reads the file. '
    + 'If you cannot write files, put the checkpoint in your final message instead.';
}

// The whole check. Returns { tier, text, row } or null. Cheap exits first: the
// context under the ceiling never touches the schedule file.
export function ceilingCheck(p, sig, { ceiling, repeat }) {
  if (!sig || !(ceiling > 0) || typeof sig.ctx !== 'number' || sig.ctx < ceiling) return null;
  // A compaction with no request after it yet: ctx is still the pre-compaction size.
  if (sig.boundary && sig.turnsAfterBoundary === 0) return null;
  if (!rolloutActive()) return null;
  const tier = claimCeilingTier(p.agent_id, sig.ctx, ceiling, repeat);
  if (!tier) return null;
  return {
    tier,
    text: ceilingNoticeText(tier, sig.ctx, ceiling, repeat),
    row: {
      at: new Date().toISOString(), session_id: p.session_id, agent_type: p.agent_type, agent_id: p.agent_id,
      model: sig.model || null, tokens: sig.ctx, tier, ceiling, repeat,
    },
  };
}
