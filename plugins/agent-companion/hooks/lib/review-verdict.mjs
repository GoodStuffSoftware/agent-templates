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
//   reviewer_model, reviewer_effort   the reviewer's own model and effort, from its spawns.jsonl row (null when not found) (0.31.17)
//   reviewed_model, reviewed_effort   the writer under review, parsed from the brief's WRITER: line the way
//                            spawn-guard parses it (null when absent or unusable; effort null for a no-effort model) (0.31.17)
//                            Older rows carry none of these four; every reader treats a missing field as unknown.
//   reviewed_branch          the first feat|fix|chore|docs|refactor|release|wip/<name> token in the brief (null when none) (0.31.17)
//   post_pass_defect         always null on the row itself (unknown); append-only rows are never rewritten. A later FIX or BLOCK on
//                            the same branch after a PASS appends an outcome row to telemetry/review-outcomes.jsonl instead, and
//                            the register folds it back as post_pass_defect:true (an upper bound, see docs/TELEMETRY.md) (0.31.17)
//   at                       when the result returned
//   source                   'post-tool-use' (foreground: the result came back with the Agent call)
//                            | 'subagent-stop' (background: the result came with the SubagentStop event)
//   agent_id                 background only: the reviewer's agent id (null on the foreground path)
// readSpawnRows() in the register folds each row into its spawns.jsonl row as
// `review_verdict`, which is the field the metric reads.
//
// Background reviewers (0.31.14): a background spawn's PostToolUse carries the launch
// acknowledgement (tool_response: isAsync, status "async_launched", agentId, outputFile ...),
// not the result. The launch is remembered in state/review-agents/<agent_id>.json (session,
// spawn tool_use_id, name, declared type and role); the later SubagentStop event (agent_id,
// last_assistant_message, agent_transcript_path) is parsed with the same parser and written
// in the same row format. A spawn gets at most one row, whichever path records it first.
// Nothing here throws, writes to stdout, or changes the Agent result.

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { telemetryDir, stateDir, tailRecords, appendLog, isFixtureSession, canonicalTaskType, writerFromDeclaration } from './context.mjs';
import { briefDeclarations, declarationValue } from './brief-directives.mjs';
import { resolveAgentTranscript } from './runaway.mjs';

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

// The writer under review from the brief's WRITER: line -> { model, effort } (nulls when absent or unusable).
export function writerOf(prompt, cwd) {
  try {
    const decls = briefDeclarations(String(prompt || ''));
    if (!decls.WRITER) return { model: null, effort: null };
    const w = writerFromDeclaration(decls.WRITER.rest, cwd);
    if (!w || !w.ok) return { model: null, effort: null };
    return { model: w.model || null, effort: w.effort || null };
  } catch { return { model: null, effort: null }; }
}

// The branch a reviewer's brief names: the first token shaped like a conventional branch, else null.
export function branchOf(prompt) {
  try {
    const m = /(?<![A-Za-z0-9._/-])((?:feat|fix|chore|docs|refactor|release|wip)\/[A-Za-z0-9._/-]+)/.exec(String(prompt || ''));
    return m ? m[1].replace(/[._/-]+$/, '') : null;
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

// --- Background reviewers -----------------------------------------------------

// An async launch acknowledgement -> { agentId } (agentId may be null), else null.
export function asyncLaunch(resp) {
  try {
    if (resp && typeof resp === 'object' && !Array.isArray(resp)
      && (resp.status === 'async_launched' || resp.isAsync === true)) {
      let id = typeof resp.agentId === 'string' ? resp.agentId : null;
      if (!id) { const m = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(resp)); id = m ? m[1] : null; }
      return { agentId: id };
    }
  } catch { /* not a launch */ }
  return null;
}

const AGENT_TTL_MS = 7 * 86400000;
const idOk = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);
const agentsDir = () => join(stateDir(), 'review-agents');

function pruneAgents(now = Date.now()) {
  try {
    const dir = agentsDir();
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      try { if (now - statSync(f).mtimeMs > AGENT_TTL_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* none yet */ }
}

function rememberLaunch(agentId, rec) {
  try {
    if (!idOk(agentId)) return;
    mkdirSync(agentsDir(), { recursive: true });
    writeFileSync(join(agentsDir(), `${agentId}.json`), JSON.stringify(rec));
    pruneAgents();
  } catch { /* fail open */ }
}

function recallLaunch(agentId) {
  try {
    if (!idOk(agentId)) return null;
    const rec = JSON.parse(readFileSync(join(agentsDir(), `${agentId}.json`), 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch { return null; }
}

// --- Row writing --------------------------------------------------------------

const streamFile = (sid, name) => join(telemetryDir(), isFixtureSession(sid) ? 'fixtures.jsonl' : name);
const inStream = (sid, r, name) => !isFixtureSession(sid) || r.stream === name;

// The reviewer's own spawns.jsonl row, or null.
function spawnRowOf(sid, tu) {
  if (!tu) return null;
  const needle = JSON.stringify(tu);
  const rows = tailRecords(streamFile(sid, 'spawns.jsonl'), { bytes: 4 * 1024 * 1024, filter: (l) => l.includes(needle) })
    .filter((r) => r && r.tool_use_id === tu && r.session_id === sid && inStream(sid, r, 'spawns.jsonl'));
  return rows.length ? rows[rows.length - 1] : null;
}

// Has a verdict row for this spawn been written already (by either path)?
function alreadyRecorded(sid, tu) {
  if (!tu) return false;
  const needle = JSON.stringify(tu);
  return tailRecords(streamFile(sid, 'review-verdicts.jsonl'), { bytes: 4 * 1024 * 1024, filter: (l) => l.includes(needle) })
    .some((r) => r && r.review_of_tool_use_id === tu && r.session_id === sid && inStream(sid, r, 'review-verdicts.jsonl'));
}

const OUTCOME_WINDOW_MS = 7 * 86400000;
const nonEmptyStr = (x) => typeof x === 'string' && x.length > 0;

// After a FIX or BLOCK row on a branch: find the most recent earlier PASS row on that branch (within
// 7 days, any session) that has no outcome row yet, and append one marking a defect found after PASS.
// No git, no child process; bounded tail reads. Fails open.
function recordPostPassDefect(fixRow) {
  try {
    if (!fixRow.reviewed_branch || (fixRow.review_verdict !== 'FIX' && fixRow.review_verdict !== 'BLOCK')) return null;
    const sid = fixRow.session_id;
    const now = Date.parse(fixRow.at);
    const needle = JSON.stringify(fixRow.reviewed_branch);
    const verdicts = tailRecords(streamFile(sid, 'review-verdicts.jsonl'), { bytes: 4 * 1024 * 1024, filter: (l) => l.includes(needle) })
      .filter((r) => r && r.reviewed_branch === fixRow.reviewed_branch && inStream(sid, r, 'review-verdicts.jsonl')
        && !(r.session_id === sid && r.review_of_tool_use_id === fixRow.review_of_tool_use_id));
    const passes = verdicts.filter((r) => r.review_verdict === 'PASS' && nonEmptyStr(r.review_of_tool_use_id)
      && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) <= now && now - Date.parse(r.at) <= OUTCOME_WINDOW_MS);
    if (!passes.length) return null;
    const outcomes = tailRecords(streamFile(sid, 'review-outcomes.jsonl'), { bytes: 4 * 1024 * 1024, filter: (l) => l.includes(needle) })
      .filter((r) => r && inStream(sid, r, 'review-outcomes.jsonl'));
    const done = new Set(outcomes.map((r) => r.session_id + '|' + r.review_of_tool_use_id));
    const pass = passes[passes.length - 1];
    if (done.has(pass.session_id + '|' + pass.review_of_tool_use_id)) return null;
    const row = {
      at: fixRow.at,
      session_id: pass.session_id,
      review_of_tool_use_id: pass.review_of_tool_use_id,
      reviewed_branch: fixRow.reviewed_branch,
      post_pass_defect: true,
      evidence: 'later-fix-verdict',
      evidence_ref: fixRow.review_of_tool_use_id,
    };
    appendLog('review-outcomes.jsonl', row);
    return row;
  } catch { return null; }
}

function writeVerdictRow({ sid, tu, name, rv, pv, source, agentId, writer, branch }) {
  if (alreadyRecorded(sid, tu)) return null;
  const orig = spawnRowOf(sid, tu);
  const row = {
    at: new Date().toISOString(),
    session_id: sid,
    review_of_tool_use_id: tu,
    name: typeof name === 'string' ? name : null,
    review_verdict: pv.verdict,
    review_verdict_raw: pv.raw,
    declared_type: rv.type,
    declared_role: rv.role,
    caller_effort: orig ? orig.caller_effort ?? null : null,
    caller_is_subagent: orig ? orig.caller_is_subagent ?? null : null,
    caller_tool_use_id: orig ? orig.caller_tool_use_id ?? null : null,
    reviewer_model: orig && typeof orig.model === 'string' ? orig.model : null,
    reviewer_effort: orig ? orig.spawn_effort ?? orig.effective_effort ?? null : null,
    reviewed_model: writer?.model ?? null,
    reviewed_effort: writer?.effort ?? null,
    reviewed_branch: typeof branch === 'string' && branch ? branch : null,
    post_pass_defect: null,
    spawn_row_found: !!orig,
    source,
    agent_id: agentId || null,
  };
  appendLog('review-verdicts.jsonl', row);
  recordPostPassDefect(row);
  return row;
}

// Handle one Agent PostToolUse payload. Returns the row written, or null.
// A foreground reviewer's result is parsed here; a background reviewer's launch is remembered
// for recordBackgroundVerdict().
export function recordReviewVerdict(p) {
  try {
    if (!p || p.tool_name !== 'Agent') return null;
    const input = p.tool_input || {};
    const rv = reviewerOf(input.prompt);
    if (!rv) return null;
    const sid = String(p.session_id || '');
    const tu = typeof p.tool_use_id === 'string' ? p.tool_use_id : null;
    const launch = asyncLaunch(p.tool_response);
    if (launch) {
      if (launch.agentId && tu) {
        rememberLaunch(launch.agentId, {
          at: new Date().toISOString(), session_id: sid, tool_use_id: tu,
          name: typeof input.name === 'string' ? input.name : null, type: rv.type, role: rv.role,
          writer: writerOf(input.prompt, p.cwd), branch: branchOf(input.prompt),
        });
      }
      return null;
    }
    const pv = parseVerdict(resultText(p.tool_response));
    if (!pv) return null;
    return writeVerdictRow({ sid, tu, name: input.name, rv, pv, source: 'post-tool-use', agentId: null, writer: writerOf(input.prompt, p.cwd), branch: branchOf(input.prompt) });
  } catch { return null; }
}

// The last assistant message of an agent transcript (bounded tail read), '' when unreadable.
function lastAssistantText(path) {
  try {
    if (!path) return '';
    const recs = tailRecords(path, { bytes: 512 * 1024, filter: (l) => l.includes('"assistant"') });
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const m = recs[i] && recs[i].message;
      if (recs[i].type !== 'assistant' || !m) continue;
      const t = resultText({ content: m.content });
      if (t.trim()) return t;
    }
  } catch { /* unreadable */ }
  return '';
}

// Handle one SubagentStop payload. Returns the row written, or null. Only an agent whose
// launch was remembered as a reviewer is read; every other stop returns null untouched.
export function recordBackgroundVerdict(p) {
  try {
    if (!p || !idOk(p.agent_id)) return null;
    const rec = recallLaunch(p.agent_id);
    if (!rec || !rec.tool_use_id) return null;
    const sid = String(rec.session_id || p.session_id || '');
    if (alreadyRecorded(sid, rec.tool_use_id)) return null;
    let pv = parseVerdict(typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '');
    if (!pv) pv = parseVerdict(lastAssistantText(resolveAgentTranscript(p)));
    if (!pv) return null;
    return writeVerdictRow({
      sid, tu: rec.tool_use_id, name: rec.name, rv: { type: rec.type ?? null, role: rec.role ?? null },
      pv, source: 'subagent-stop', agentId: p.agent_id,
      writer: rec.writer && typeof rec.writer === 'object' ? { model: rec.writer.model ?? null, effort: rec.writer.effort ?? null } : null,
      branch: typeof rec.branch === 'string' ? rec.branch : null,
    });
  } catch { return null; }
}
