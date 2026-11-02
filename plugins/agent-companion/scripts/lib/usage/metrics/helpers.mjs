// Shared helpers for the usage metric registry (scripts/lib/usage/metrics/). Moved verbatim from
// scripts/lib/decision-register.mjs; pure functions over spawn and denial rows, no I/O, no imports
// from the register (the register imports the registry, never the reverse).

export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export const nonEmpty = (x) => (typeof x === 'string' && x.trim() !== '' ? x : null);
export const typeOf = (r) => r.declared_type_resolved ?? r.declared_type;

// Task types that write or change things: every config/model-tiers.json selfReview.types entry (a test
// pins that), plus the two writer types that are not self-reviewed (bounded-feature-small, mechanical-edit).
// The reviewsPerWriter denominator counts all of them, since reviews cover every one.
export const WRITER_TYPES = new Set([
  "bounded-feature", "bounded-feature-small", "integration", "debug-root-cause", "large-refactor",
  "novel-design", "critical-change", "long-autonomous-run", "mechanical-edit",
]);

// --- lead-effort helpers (decision leads-at-high) ---------------------------------------------
export const REBRIEF_WINDOW_MS = 6 * 3600 * 1000;
export const DENY_GUARDS = new Set(['fit', 'warrant', 'premium-cap', 'inherit']); // routing-guard denials
export const isLeadRow = (r) => r && r.caller_is_subagent === false && nonEmpty(r.caller_effort) !== null;
export const tsOf = (r) => (r && typeof r.at === 'string' ? Date.parse(r.at) : NaN);

// Base name of a spawn: the name with trailing -N / -fix / -review / -retry / -rerun removed, so
// "scout-copy-fix" and "scout-copy-fix-2" both give "scout-copy".
export function baseName(n) {
  let s = String(n || '').toLowerCase();
  for (let i = 0; i < 4; i++) {
    const m = s.replace(/-(?:\d+|fix|review|retry|rerun)$/, '');
    if (m === s) break;
    s = m;
  }
  return s;
}

// Index over ALL spawn rows (a re-brief can cross a day boundary): lead rows per session sorted
// by time, the set of rows that are re-briefs, and tool_use_id -> row for the review join. Built
// once per evaluation, only by the metrics that need it.
//   Re-brief: the same heuristic as the 2026-10-10 lead-effort evidence (section 1, "re-brief
//   heuristic"): a lead spawn row whose session spawned from the main thread, within the 6 h
//   before it, the same description hash (desc_sha) or the same base name. That heuristic is
//   unvalidated (E): it also catches planned fix-then-review chains, so read the rate as a figure
//   to compare across lead efforts, not as a count of mistakes. A row with the `redone` flag
//   set (the evidence's redo flag; no current telemetry writes it) counts too.
export function buildLeadIndex(all) {
  const list0 = Array.isArray(all) ? all : [];
  const rows = list0.filter((r) => isLeadRow(r) && Number.isFinite(tsOf(r)));
  const bySession = new Map();
  const byToolUse = new Map();
  for (const r of list0) if (r && nonEmpty(r.tool_use_id)) byToolUse.set(r.tool_use_id, r);
  for (const r of rows) {
    const k = nonEmpty(r.session_id);
    if (k === null) continue;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(r);
  }
  const rebrief = new Set();
  for (const list of bySession.values()) {
    list.sort((a, b) => tsOf(a) - tsOf(b));
    const lastSha = new Map(); const lastBase = new Map();
    for (const r of list) {
      const t = tsOf(r);
      const sha = nonEmpty(r.desc_sha);
      const base = baseName(r.name_effective || r.name) || null;
      const near = (m, key) => key !== null && m.has(key) && t - m.get(key) <= REBRIEF_WINDOW_MS;
      if (near(lastSha, sha) || near(lastBase, base) || r.redone === true) rebrief.add(r);
      if (sha !== null) lastSha.set(sha, t);
      if (base !== null) lastBase.set(base, t);
    }
  }
  return { bySession, rebrief, byToolUse };
}

// The lead effort a routing denial belongs to: the caller_effort of the session's first lead spawn
// row at or after the denial, else its last one before (denials carry no effort themselves).
export function denialEffort(idx, d) {
  const list = idx.bySession.get(nonEmpty(d && d.session_id));
  const t = tsOf(d);
  if (!list || !list.length || !Number.isFinite(t)) return null;
  const next = list.find((r) => tsOf(r) >= t);
  return (next || list[list.length - 1]).caller_effort;
}

// A reviewer row's verdict, from the optional `review_verdict` field: 'fix' (FIX or BLOCK),
// 'pass', or null (absent or unreadable).
export const verdictOf = (r) => {
  const v = typeof r.review_verdict === 'string' ? r.review_verdict.toUpperCase() : '';
  if (/\b(FIX|BLOCK)/.test(v)) return 'fix';
  if (/\bPASS/.test(v)) return 'pass';
  return null;
};
