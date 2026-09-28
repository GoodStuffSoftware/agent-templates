// Self-review: architect-class writers spawn their own reviewer (operator
// request 2026-09-28; config/model-tiers.json `selfReview`).
//
// Before this, the lead (hub) spawned a writer, waited, spawned a parity
// reviewer, waited, then resumed or re-spawned the writer for the fix round.
// Every hop stalled on the lead being free, and the fix round often started on
// a cold cache. A writer whose TYPE is listed in `selfReview.types` now runs
// that loop itself: commit, ONE foreground parity reviewer on its own rung,
// one fix round, return the verdict verbatim. The lead still lands, merges,
// settles disputed findings and spot-checks the review file.
//
// Three pieces live here, shared by the generator and the spawn guard:
//   1. The PROTOCOL TEXT. It is generated into the body of every ladder rung
//      that is currently the default route for a selfReview type
//      (scripts/routing-table.mjs --sync-agent-descriptions writes it,
//      --check-agent-descriptions fails on drift), between the markers
//      below, so a routing-table move carries it to the new rung and off the
//      old one. A writer reads it because it is in its own system prompt.
//   2. WRITER INFERENCE for a review a subagent spawns with no WRITER line:
//      the caller's own agent_type, resolved through agentDefinition() to
//      the model and effort its definition pins (writerFromCaller).
//   3. The caller's OWN spawn row, for the recursion guard (reviewers never
//      spawn reviewers). A subagent's PreToolUse payload carries its
//      agent_id; the harness writes a sidecar next to its transcript,
//      <session>/subagents/agent-<agent_id>.meta.json, whose `toolUseId` is
//      the id of the Agent call that spawned it; the spawn guard records that
//      same id (the PreToolUse payload's tool_use_id) on every spawns.jsonl
//      row. So agent_id -> sidecar -> toolUseId -> the one row the guard
//      wrote for that exact spawn. An exact join, never a timestamp guess:
//      a row that cannot be found this way is UNKNOWN, and unknown allows.
//
// hooks/ never imports scripts/; scripts/routing-table.mjs imports this.

import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import {
  modelTiers, taskTypeDef, agentDefinition, classifyModel, classifyEffort, callerIsSubagent,
  tailRecords, telemetryDir, isFixtureSession, resolveRoute, isLadderAgentName,
} from './context.mjs';
import { declarationLines } from './brief-directives.mjs';

export const SELF_REVIEW_BEGIN = '<!-- self-review protocol BEGIN: generated from config/model-tiers.json `selfReview` by scripts/routing-table.mjs --sync-agent-descriptions; do not edit by hand -->';
export const SELF_REVIEW_END = '<!-- self-review protocol END -->';
// What a reader looks for; the full BEGIN line may grow a word later.
const BEGIN_PREFIX = '<!-- self-review protocol BEGIN';

const DEFAULT_OPT_OUT = { line: 'REVIEW: lead', label: 'REVIEW', value: 'lead' };

// `optOut` is one brief line, "<LABEL>: <value>". Anything else falls back to
// the shipped line rather than disabling the opt-out.
function parseOptOut(raw) {
  const m = typeof raw === 'string' ? raw.trim().match(/^([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(\S(?:.*\S)?)$/) : null;
  if (!m) return { ...DEFAULT_OPT_OUT };
  return { line: `${m[1].toUpperCase()}: ${m[2]}`, label: m[1].toUpperCase(), value: m[2] };
}

// The config's `selfReview` section, normalised. Never throws.
export function selfReviewConfig(cfg) {
  let c = cfg;
  if (!c) { try { c = modelTiers(); } catch { c = {}; } }
  const raw = c && typeof c.selfReview === 'object' && c.selfReview && !Array.isArray(c.selfReview) ? c.selfReview : {};
  const types = Array.isArray(raw.types)
    ? [...new Set(raw.types.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase()))]
    : [];
  const fixRounds = Number.isInteger(raw.fixRounds) && raw.fixRounds >= 0 ? raw.fixRounds : 1;
  return {
    types,
    fixRounds,
    optOut: parseOptOut(raw.optOut),
    updated: typeof raw.updated === 'string' ? raw.updated : null,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}

// A task type sized to its writer (code-review today): `weight: "parity"`.
export function isParityType(name) {
  if (!name) return false;
  try { return taskTypeDef(String(name))?.def?.weight === 'parity'; } catch { return false; }
}

// True when the brief opts out of self-review with the config's line
// (`REVIEW: lead`). Read like every other brief declaration: from a line of
// its own, not inside fenced/indented code, a blockquote or an HTML comment
// (lib/brief-directives.mjs declarationLines), optionally list-marked or
// bold; the FIRST line naming the label decides, and its value must start
// with the opt-out word ("REVIEW: lead (hub reviews)" counts,
// "REVIEW: self" does not).
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function optedOut(brief, sr = selfReviewConfig()) {
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*|__)?${escapeRe(sr.optOut.label)}(?:\\*\\*|__)?[ \\t]*:(.*)$`, 'i');
  const want = new RegExp(`^${escapeRe(sr.optOut.value.toLowerCase())}(?![a-z0-9_-])`);
  for (const line of declarationLines(brief)) {
    const m = re.exec(line);
    if (!m) continue;
    return want.test(m[1].replace(/[*_`]/g, '').trim().toLowerCase());
  }
  return false;
}

// The selfReview types that resolve, right now, to exactly this rung's
// (model, effort) through the SHIPPED table (profile:false, like the rung
// descriptions: committed files never depend on one machine's profile).
export function selfReviewTypesForRung(rung, sr = selfReviewConfig()) {
  const out = [];
  if (!rung) return out;
  let cfg;
  try { cfg = modelTiers(); } catch { return out; }
  for (const type of sr.types) {
    const t = (cfg.taskTypes || {})[type];
    if (!t || typeof t.weight !== 'number') continue;
    let r;
    try { r = resolveRoute({ type, profile: false }); } catch { continue; }
    if (r.model === rung.model && (r.effort || null) === (rung.effort || null)) out.push(type);
  }
  return out;
}

// Config mistakes the generator cannot paper over, one string each: a listed
// type the table does not know, a parity type (a reviewer that self-reviews
// is the recursion the guard denies), and a type whose route lands on no
// ladder rung (its writers would never read the protocol).
export function selfReviewConfigProblems(sr = selfReviewConfig()) {
  const out = [];
  let cfg;
  try { cfg = modelTiers(); } catch { return ['config/model-tiers.json could not be read']; }
  const ladder = Array.isArray(cfg.ladder) ? cfg.ladder : [];
  for (const type of sr.types) {
    const t = (cfg.taskTypes || {})[type];
    if (!t) { out.push(`selfReview.types names "${type}", which is not a task type`); continue; }
    if (t.weight === 'parity') { out.push(`selfReview.types names "${type}", a parity-sized review type: reviewers never spawn reviewers`); continue; }
    if (typeof t.weight !== 'number') continue;
    let r = null;
    try { r = resolveRoute({ type, profile: false }); } catch { r = null; }
    const rung = r && r.model ? ladder.find((x) => x && x.model === r.model && (x.effort || null) === (r.effort || null)) : null;
    if (!rung) out.push(`selfReview type "${type}" routes to ${r && r.model ? `${r.model}${r.effort ? '/' + r.effort : ''}` : 'nothing'}, which is no ladder rung, so no rung carries its protocol`);
  }
  return out;
}

// The protocol block for one rung, markers included, LF line endings, no
// trailing newline. Names the rung itself as the reviewer's rung, since the
// reviewer is spawned "on the rung matching your own model and effort".
export function selfReviewBlock(rung, sr = selfReviewConfig(), plugin = 'agent-companion') {
  const pair = `${rung.model}${rung.effort ? '/' + rung.effort : ''}`;
  const spawnAs = `${plugin}:${rung.agent}`;
  const types = sr.types.map((t) => `\`${t}\``).join(', ');
  const n = sr.fixRounds;
  const fix = n === 0
    ? 'Make no fixes: list every finding for the lead to settle. Never re-review: do not spawn a second reviewer.'
    : `${n === 1 ? 'Do one fix round' : `Do at most ${n} fix rounds`} on the blocker and should-fix findings. A finding you disagree with stays unfixed and is listed as disputed, with your reason. Never re-review: do not spawn a second reviewer.`;
  const L = [
    SELF_REVIEW_BEGIN,
    '## Self-review before you return',
    '',
    `This applies only when your brief's \`TYPE:\` line names one of ${types}, and the brief has no \`${sr.optOut.line}\` line. Otherwise skip this section: the lead reviews your work. If your TYPE is \`code-review\`, you are the reviewer: never spawn a reviewer (the spawn guard denies it).`,
    '',
    'When it applies, before you return:',
    '',
    '1. Commit your work, so the review has a fixed sha.',
    `2. Spawn exactly ONE reviewer, in the foreground (\`run_in_background: false\`), with \`subagent_type: "${spawnAs}"\`: this rung, which matches your own model and effort. Its brief opens with these two lines, as plain text:`,
    '   ```',
    '   TYPE: code-review',
    `   WRITER: ${pair}`,
    '   ```',
    '3. The rest of the reviewer\'s brief must contain:',
    '   - the lead\'s original brief, verbatim, or the path of a file that holds it verbatim;',
    '   - the branch, the commit sha and the diff range under review;',
    '   - this instruction: "Try to refute this change. Run the tests. Start with a verdict line, `VERDICT: PASS` or `VERDICT: FIX`, then list each finding as blocker, should-fix or nit, with file:line and a repro.";',
    '   - the review file to write: the path the lead\'s brief names for it, if any; otherwise `REVIEW-<name>.md` next to your report file, `<name>` being a short name for this task.',
    '   Add nothing that narrows the review: no areas to skip, no findings to expect, no summary of your own that stands in for the diff.',
    `4. ${fix}`,
    '5. Return: your report, the reviewer\'s verdict line verbatim, the review file path, the post-fix commit sha, and the disputed findings.',
    '',
    'If the reviewer cannot be spawned (no Agent tool here, or the spawn is denied), say so in your report and return: the lead reviews instead.',
    SELF_REVIEW_END,
  ];
  return L.join('\n');
}

// The block currently in a file's text: { block } (LF-normalised, markers
// included), { block: null } when absent, or { malformed: reason }.
export function readSelfReviewBlock(text) {
  const t = String(text || '');
  const s = t.indexOf(BEGIN_PREFIX);
  const e = t.indexOf(SELF_REVIEW_END);
  if (s < 0 && e < 0) return { block: null };
  if (s < 0 || e < 0 || e < s) return { malformed: 'unbalanced self-review protocol markers' };
  if (t.indexOf(BEGIN_PREFIX, s + 1) >= 0) return { malformed: 'more than one self-review protocol block' };
  return { block: t.slice(s, e + SELF_REVIEW_END.length).replace(/\r\n/g, '\n') };
}

// Sets (block) or removes (null) the protocol block in a whole file's text,
// in the file's own line endings. Appended after the body when absent;
// replaced in place when present; removed with the blank lines that
// separated it. Idempotent, and removing an appended block restores the
// original bytes. Returns null for a malformed file (the check reports it;
// sync never guesses where a block ends).
export function setSelfReviewBlock(text, block) {
  const t = String(text || '');
  const cur = readSelfReviewBlock(t);
  if (cur.malformed) return null;
  const nl = t.includes('\r\n') ? '\r\n' : '\n';
  const b = block == null ? null : String(block).replace(/\r\n/g, '\n').split('\n').join(nl);
  if (cur.block === null) {
    if (b === null) return t;
    const head = t.replace(/(?:\r?\n)+$/, '');
    return `${head}${nl}${nl}${b}${nl}`;
  }
  const s = t.indexOf(BEGIN_PREFIX);
  const e = t.indexOf(SELF_REVIEW_END) + SELF_REVIEW_END.length;
  if (b !== null) return t.slice(0, s) + b + t.slice(e);
  const head = t.slice(0, s).replace(/(?:\r?\n)+$/, '');
  const tail = t.slice(e).replace(/^(?:\r?\n)+/, '');
  return tail ? `${head}${nl}${nl}${tail}` : `${head}${nl}`;
}

// Whether the definition that will run carries the protocol:
//   true  - its file holds the block;
//   false - it cannot: a ladder rung without the block (the rungs are
//           generated, so this is the table's own answer), or no
//           definition file at all (a built-in type such as general-purpose);
//   null  - unknown: another agent file (a project, user or other plugin's
//           agent), which may carry a protocol of its own in other words.
export function definitionCarriesProtocol(type, def) {
  if (def && def.file) {
    try {
      if (readFileSync(def.file, 'utf8').includes(BEGIN_PREFIX)) return true;
    } catch { return null; }
    return isLadderAgentName(type) ? false : null;
  }
  return false;
}

// The writer a review spawned by a SUBAGENT gates, when its brief has no
// WRITER line: the caller's own agent_type (the subagent hook payload's
// `agent_type`), resolved through agentDefinition() to the model and effort
// its definition pins — the same place the harness reads them. Returns the
// writerFromDeclaration() shape with via: 'caller', or { ok: false, reason }.
// Never guesses: a caller with no agent_type, a built-in type (no definition
// file), or a definition with no model yields no writer. Never throws.
export function writerFromCaller(p) {
  try {
    if (!callerIsSubagent(p)) return { ok: false, reason: 'the caller is the main thread, not a subagent' };
    const t = typeof p.agent_type === 'string' ? p.agent_type.trim() : '';
    if (!t) return { ok: false, reason: "the caller's hook payload names no agent_type" };
    const d = agentDefinition(t, p.cwd);
    if (!d) {
      return { ok: false, reason: `the caller's agent type "${t.slice(0, 80)}" has no definition file the guard can read (a built-in type pins no model or effort)` };
    }
    if (!d.model) return { ok: false, reason: `the caller's definition "${t.slice(0, 80)}" states no model, so it ran on its own lead's model` };
    const cls = classifyModel(d.model);
    if (!cls.known) return { ok: false, reason: `the caller's definition "${t.slice(0, 80)}" pins model "${String(d.model).slice(0, 40)}", which is not in the tier table` };
    const own = d.effort ? classifyEffort(d.effort) : null;
    const effort = own && own.known ? own.level : '';
    const takesEffort = (((modelTiers().tiers || {})[cls.alias] || {}).efforts || []).length > 0;
    return {
      ok: true,
      model: cls.alias,
      effort,
      label: effort ? `${cls.alias}/${effort}` : cls.alias,
      via: 'caller',
      agent: t,
      effortIssue: !effort && takesEffort ? 'agent-none' : null,
      effortToken: null,
    };
  } catch {
    return { ok: false, reason: 'the tier table could not be read' };
  }
}

// The caller's sidecar: <dir>/<session>/subagents/agent-<agent_id>.meta.json,
// next to the transcript the harness writes for that agent. Only ever the
// file named for THIS agent_id, so another agent's sidecar is never read.
export function callerSidecarPath(p) {
  if (!p || !p.agent_id) return null;
  const id = String(p.agent_id);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const want = `agent-${id}.jsonl`;
  let jsonl = null;
  if (typeof p.agent_transcript_path === 'string' && basename(p.agent_transcript_path) === want) {
    jsonl = p.agent_transcript_path;
  } else if (typeof p.transcript_path === 'string' && p.transcript_path) {
    const tp = p.transcript_path;
    jsonl = join(dirname(tp), basename(tp, '.jsonl'), 'subagents', want);
  }
  return jsonl ? jsonl.replace(/\.jsonl$/i, '.meta.json') : null;
}

// The spawns.jsonl row the guard wrote for the CALLER's own spawn, found by
// the exact key above. { state: 'found', row, toolUseId } or
// { state: 'unknown', why }. Unknown whenever any link is missing: no
// sidecar, no toolUseId in it, no row carrying that id in this session (a row
// written before rows carried tool_use_id, a spawn made with spawn_telemetry
// off, or one older than the bounded tail read), or rows that disagree on
// the declared type. Never throws.
export function callerSpawnRow(p, { bytes = 4 * 1024 * 1024 } = {}) {
  try {
    const meta = callerSidecarPath(p);
    if (!meta) return { state: 'unknown', why: 'the payload gives no path to the caller\'s sidecar' };
    let m;
    try { m = JSON.parse(readFileSync(meta, 'utf8')); } catch { return { state: 'unknown', why: 'the caller\'s sidecar could not be read' }; }
    const tu = m && typeof m.toolUseId === 'string' ? m.toolUseId : '';
    if (!tu) return { state: 'unknown', why: 'the caller\'s sidecar names no toolUseId' };
    const sid = String(p.session_id || '');
    const fixture = isFixtureSession(sid);
    const file = join(telemetryDir(), fixture ? 'fixtures.jsonl' : 'spawns.jsonl');
    const needle = JSON.stringify(tu);
    const rows = tailRecords(file, { bytes, filter: (line) => line.includes(needle) })
      .filter((r) => r && r.tool_use_id === tu && r.session_id === sid && (!fixture || r.stream === 'spawns.jsonl'));
    if (!rows.length) return { state: 'unknown', why: 'no spawns.jsonl row carries the caller\'s tool_use_id', toolUseId: tu };
    const types = new Set(rows.map((r) => (typeof r.declared_type === 'string' ? r.declared_type : null)));
    if (types.size > 1) return { state: 'unknown', why: 'the caller\'s spawn rows disagree on its declared type', toolUseId: tu };
    return { state: 'found', row: rows[rows.length - 1], toolUseId: tu };
  } catch {
    return { state: 'unknown', why: 'the lookup failed' };
  }
}
