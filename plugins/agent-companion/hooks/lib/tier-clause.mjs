// Project tiers: the clause appended to a writer's or reviewer's spawn brief, so the project's
// tier and the change-risk table reach every worker without the lead repeating them. Pure apart
// from the file reads in tierDetail(); spawn-guard (lib/sg-finish.mjs) merges the text into the
// updatedInput it is already building, like lib/scope-rule.mjs, and fails open.
//
// Which clause (by the brief's TYPE first, then its ROLE, as the scope rule does):
//   writer with the self-review protocol -> the full table, to pick its cell and spawn one reviewer
//   writer with `REVIEW: lead`           -> the leg clause: the lead applies the table once to the whole diff
//   writer with no protocol              -> the lead applies the table; the batch rule
//   reviewer (code-review, or ROLE reviewer with no TYPE) -> the reviewer's cells by the brief's RISK
//   lookup, operate, docs, anything undeclared -> none
// Idempotent: a brief that already carries the marker gets nothing.

import { scopeKind } from './scope-rule.mjs';
import { optedOut, selfReviewConfig } from './self-review.mjs';
import { tierDetail } from './project-tier.mjs';
import { reviewerClause, writerClause } from './tier-text.mjs';

export const TIER_MARKER = '[agent-companion: tier]';

// 'protocol' | 'leg' | 'plain' | 'reviewer' | null
export function tierKind(type, role, brief = '') {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (t === 'code-review' || (!t && r === 'reviewer')) return 'reviewer';
  if (scopeKind(t, r) !== 'writer') return null;
  const sr = selfReviewConfig();
  if (optedOut(brief, sr)) return 'leg';
  // A writer type the self-review protocol covers picks a cell; one it does not cover has no protocol to apply it.
  return t && sr.types.includes(t) ? 'protocol' : 'plain';
}

// The text to append, or '' when none applies, the brief already has it, or anything fails.
export function buildTierClause(type, role, brief = '', cwd = process.cwd()) {
  try {
    const text = String(brief ?? '');
    if (text.includes(TIER_MARKER)) return '';
    const kind = tierKind(type, role, text);
    if (!kind) return '';
    const d = tierDetail(cwd);
    const opts = { reviewEveryChange: !!d.config?.reviewEveryChange };
    const body = kind === 'reviewer'
      ? reviewerClause(d.tier, d.project, opts)
      : writerClause(d.tier, d.project, { ...opts, kind });
    return `\n\n${TIER_MARKER} ${body}`;
  } catch {
    return '';
  }
}
