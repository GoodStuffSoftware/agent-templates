// Review verdict telemetry (0.31.13). A reviewer spawn's result ends with a
// `VERDICT:` line; this records it so the decision register's metric
// reviewFixShareByLeadEffort (scripts/lib/decision-register.mjs) has data.
//
// Written to telemetry/review-verdicts.jsonl, one row per reviewer result that
// carries a readable verdict:
//   session_id               the spawning session
//   review_of_tool_use_id    the Agent call that spawned the reviewer (its spawns.jsonl row's tool_use_id)
//   name                     the reviewer's name as declared (null when unnamed)
//   review_verdict           PASS | FIX | BLOCK (normalized)
//   review_verdict_raw       the verdict text as written (first 80 chars)
//   declared_type, declared_role   what the brief declared
//   caller_effort, caller_is_subagent, caller_tool_use_id   copied from the reviewer's own spawns.jsonl row (null when not found)
//   at                       when the result returned
// readSpawnRows() in the register folds each row into its spawns.jsonl row as
// `review_verdict`, which is the field the metric reads.
// Nothing here throws, writes to stdout, or changes the Agent result.

import { join } from 'node:path';
import { telemetryDir, tailRecords, appendLog, isFixtureSession, canonicalTaskType } from './context.mjs';
import { briefDeclarations, declarationValue } from './brief-directives.mjs';

// The brief's reviewer declaration: { type, role } or null when it is no reviewer.
export function reviewerOf(prompt) {
  try {
    const decls = briefDeclarations(String(prompt || ''));
    const tm = declarationValue(decls, 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
    const rm = declarationValue(decls, 'ROLE', /([a-z]+)\b/.source);
    const type = tm ? tm[1].toLowerCase() : null;
    const role = rm ? rm[1].toLowerCase() : null;
    const canon = type ? (canonicalTaskType(type)?.name || type) : null;
    return canon === 'code-review' || role === 'reviewer' ? { type, role } : null;
  } catch { return null; }
}

// The result text of an Agent PostToolUse payload (string, content blocks, or a result field).
export function resultText(resp) {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  const parts = [];
  const take = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const b of c) { if (typeof b === 'string') parts.push(b); else if (b && typeof b.text === 'string') parts.push(b.text); }
  };
  take(resp.content); take(resp.result); take(resp.text);
  return parts.join('\n');
}

// PASS | FIX | BLOCK from the first VERDICT line that classifies, else null.
// Variants seen in real results (APPROVE WITH FIXES, REQUEST CHANGES, SHIP-WITH-FIXES,
// FAIL, REJECT) map onto the three; "with fixes" is a FIX, as the metric counts it.
export function parseVerdict(text) {
  const re = /^[\s>*_#|`-]*VERDICT\b[\s:*_`-]*([^\n]*)$/gim;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const rest = m[1].replace(/[*_`]/g, '').trim().slice(0, 80);
    if (!rest) continue;
    let v = null;
    // Classify on the leading word: a remark after it ("PASS (no blockers)") must not outrank it.
    const head = rest.replace(/^[^A-Za-z]+/, '');
    if (/^BLOCK/i.test(head)) v = 'BLOCK';
    else if (/^(APPROVE|SHIP|PASS)\b[\s-]*(WITH[\s-]+)?FIXES\b/i.test(head)) v = 'FIX';
    else if (/^(FIX|CHANGES|FAIL|REJECT|REQUEST)/i.test(head)) v = 'FIX';
    else if (/^(PASS|APPROVE|SHIP|CLEAN|LGTM)/i.test(head)) v = 'PASS';
    if (v) return { verdict: v, raw: rest };
  }
  return null;
}

// Handle one Agent PostToolUse payload. Returns the row written, or null.
export function recordReviewVerdict(p) {
  try {
    if (!p || p.tool_name !== 'Agent') return null;
    const input = p.tool_input || {};
    const rv = reviewerOf(input.prompt);
    if (!rv) return null;
    const pv = parseVerdict(resultText(p.tool_response));
    if (!pv) return null;
    const sid = String(p.session_id || '');
    const tu = typeof p.tool_use_id === 'string' ? p.tool_use_id : null;
    let orig = null;
    if (tu) {
      const fixture = isFixtureSession(sid);
      const file = join(telemetryDir(), fixture ? 'fixtures.jsonl' : 'spawns.jsonl');
      const needle = JSON.stringify(tu);
      const rows = tailRecords(file, { bytes: 4 * 1024 * 1024, filter: (l) => l.includes(needle) })
        .filter((r) => r && r.tool_use_id === tu && r.session_id === sid && (!fixture || r.stream === 'spawns.jsonl'));
      orig = rows.length ? rows[rows.length - 1] : null;
    }
    const row = {
      at: new Date().toISOString(),
      session_id: sid,
      review_of_tool_use_id: tu,
      name: typeof input.name === 'string' ? input.name : null,
      review_verdict: pv.verdict,
      review_verdict_raw: pv.raw,
      declared_type: rv.type,
      declared_role: rv.role,
      caller_effort: orig ? orig.caller_effort ?? null : null,
      caller_is_subagent: orig ? orig.caller_is_subagent ?? null : null,
      caller_tool_use_id: orig ? orig.caller_tool_use_id ?? null : null,
      spawn_row_found: !!orig,
    };
    appendLog('review-verdicts.jsonl', row);
    return row;
  } catch { return null; }
}
