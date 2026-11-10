// Project tiers: the clause appended to a writer's or reviewer's spawn brief, so the project's
// tier and the change-risk table reach every worker without the lead repeating them. Pure apart
// from the file reads in tierDetail(); spawn-guard (lib/sg-finish.mjs) merges the text into the
// updatedInput it is already building, like lib/scope-rule.mjs, and fails open.
//
// Which clause (by the brief's TYPE first, then its ROLE, as the scope rule does):
//   writer whose spawn carries the self-review protocol -> the full table, to pick its cell and spawn one reviewer
//   writer with `REVIEW: lead`           -> the leg clause: the lead applies the table once to the whole diff
//   any other writer                     -> the plain clause: the lead applies the table; the batch rule
//   reviewer (code-review, or ROLE reviewer with no TYPE) -> the reviewer's cells by the brief's RISK
//   a spawn that neither writes code nor reviews it (ROLE docs, lookup, operate, other; TYPE research, survey,
//   explore, lookup, verify, operate) and anything undeclared -> none
// "Carries the protocol" is the spawn guard's own decision (selfReviewExpected, lib/sg-review-plan.mjs): the rung's file holds
// the protocol, or the guard appends it in the same pass. A writer type the protocol covers on an agent without it (general-purpose,
// a project's own agent) gets the plain clause, so it is never told to spawn a reviewer the lead is told it will not spawn.
//
// Idempotent: a brief that already carries the marker gets nothing, except a reviewer brief, which always ends with exactly one
// reviewer-kind clause: the writer's brief it embeds (the protocol tells a writer to build the reviewer's brief from the one it
// received) carries the writer's clause, which is removed (one marker line, stripped exactly) or, when it cannot be stripped
// exactly, superseded by a sentence in the reviewer clause. A second pass over the output changes nothing.

import { scopeKind } from './scope-rule.mjs';
import { optedOut, selfReviewConfig } from './self-review.mjs';
import { tierDetail } from './project-tier.mjs';
import { REVIEWER_TELL, reviewerClause, writerClause } from './tier-text.mjs';

export const TIER_MARKER = '[agent-companion: tier]';
export const REPLACES_SENTENCE = 'This clause replaces any earlier tier clause in this brief.';

// Types and roles whose spawn neither writes code nor reviews it: no clause (decided before anything else).
const NO_CLAUSE_TYPES = new Set(['research', 'survey', 'explore', 'lookup', 'verify', 'operate']);
const NO_CLAUSE_ROLES = new Set(['docs', 'lookup', 'operate', 'other']);

// 'protocol' | 'leg' | 'plain' | 'reviewer' | null. `protocolCarried`: the spawn guard's selfReviewExpected === true.
export function tierKind(type, role, brief = '', protocolCarried = false) {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  const r = typeof role === 'string' ? role.toLowerCase() : '';
  if (t === 'code-review' || (!t && r === 'reviewer')) return 'reviewer';
  if (t ? NO_CLAUSE_TYPES.has(t) : NO_CLAUSE_ROLES.has(r)) return null;
  if (scopeKind(t, r) !== 'writer') return null;
  const sr = selfReviewConfig();
  if (optedOut(brief, sr)) return 'leg';
  return t && sr.types.includes(t) && protocolCarried === true ? 'protocol' : 'plain';
}

// What a reviewer brief that already holds a tier clause needs: { strip: true } (every marker is a line of its own, remove those
// lines and append), { replace: true } (cannot strip exactly: append with the replaces sentence), or null (it already ends with
// a reviewer clause: nothing to do).
function reviewerPlan(text) {
  const last = text.lastIndexOf(TIER_MARKER);
  const lineStart = text.lastIndexOf('\n', last - 1) + 1;
  if (lineStart === last) {
    const lineEnd = text.indexOf('\n', last);
    if (text.slice(last, lineEnd < 0 ? text.length : lineEnd).includes(REVIEWER_TELL)) return null;
  }
  const lines = text.split('\n');
  const markerLines = lines.filter((l) => l.startsWith(TIER_MARKER)).length;
  const occurrences = text.split(TIER_MARKER).length - 1;
  return markerLines === occurrences ? { strip: true } : { replace: true };
}

// Remove every marker line and the one blank line that separated it from the text before it.
function stripMarkerLines(text) {
  const lines = text.split('\n');
  const out = [];
  for (const l of lines) {
    if (l.startsWith(TIER_MARKER)) {
      if (out.length && out[out.length - 1] === '') out.pop();
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

// { brief, clause }: the brief to send (a reviewer brief loses an embedded writer clause it can strip exactly) and the text to
// append ('' when none applies, the brief already has it, or anything fails).
export function applyTierClause(type, role, brief = '', cwd = process.cwd(), opts = {}) {
  const text = typeof brief === 'string' ? brief : String(brief ?? '');
  const none = { brief: typeof brief === 'string' ? brief : text, clause: '' };
  try {
    const kind = tierKind(type, role, text, !!opts.protocol);
    if (!kind) return none;
    let plan = null;
    if (text.includes(TIER_MARKER)) {
      if (kind !== 'reviewer') return none;
      plan = reviewerPlan(text);
      if (!plan) return none;
    }
    const d = tierDetail(cwd);
    const o = { reviewEveryChange: !!d.config?.reviewEveryChange, landing: d.landing || null };
    const body = kind === 'reviewer'
      ? reviewerClause(d.tier, d.project, o)
      : writerClause(d.tier, d.project, { ...o, kind });
    const lead = plan?.replace ? `${REPLACES_SENTENCE} ` : '';
    return { brief: plan?.strip ? stripMarkerLines(text) : text, clause: `\n\n${TIER_MARKER} ${lead}${body}` };
  } catch {
    return none;
  }
}

// The text to append, or '' (see applyTierClause).
export function buildTierClause(type, role, brief = '', cwd = process.cwd(), opts = {}) {
  return applyTierClause(type, role, brief, cwd, opts).clause;
}
