// Live step budget (token bleed guard, phase 2, part C): a counter of a helper's
// own tool calls, a warning at a soft line and a deny at the hard one.
//
// Why. 9 in 10 helpers finish in under 80 calls and 99 in 100 in under 120
// (tasks/usage-why-2026-10-06/bleed-data-detail.md: median 37, p90 77, p99 115);
// the rest are runaways. maxTurns on the agent definitions (0.31.31) is the
// outer backstop; this is the inner, softer one: it tells the helper to wrap up
// and then refuses everything but writing its report.
//
// Where. hooks/subagent-context.mjs (PreToolUse, no matcher, subagent only)
// calls stepBudgetCheck() on every helper tool call. The payload's agent_id is
// the counter's key; the lead (no agent_id) never reaches it. A helper whose own
// transcript cannot be found (an in-process teammate, a payload with no usable
// path) is neither counted nor capped: fail open, like every guard here.
//
// Caps, from the helper's brief (the first user message of its own transcript,
// <lead dir>/<session_id>/subagents/agent-<id>.jsonl):
//   - TYPE: lookup | research | survey | explore | verify -> warn 40, stop 60;
//   - any other TYPE, or none -> warn 80, stop 120 (the writer caps);
//   - a `BUDGET: <n>` line sets the stop value; the warning is at 80% of it.
// All five numbers are options (step_budget_*; step_budget off disables the lot).
//
// Counting. One byte appended to state/step-budget/<agent>.cnt per call; the
// file size is the count, so parallel tool calls cannot lose an increment.
// "N steps used" includes the call being made. The warning fires once (an
// exclusive-create claim, the same once-only mechanism as the context notice).
// The deny starts with the first call after the stop value has been reached:
// with a stop of 120, calls 1 to 120 run and call 121 is refused.
//
// A helper that compacts a SECOND time is stopped the same way: the caller
// passes the compactions subagent-context.mjs has recorded for it, and a sticky
// marker keeps the stop on afterwards.
//
// The deny lets one kind of call through: writing a report or detail file
// (Write/Edit of a .md/.txt/.json/.csv file whose name says report, detail,
// handoff, review, summary, findings, analysis, verdict or notes), so the
// helper can still hand over what it has. It is a deny, not continue:false,
// whose scope inside a subagent is unconfirmed.

import { openSync, fstatSync, readSync, closeSync, mkdirSync, appendFileSync, statSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { opt, stateDir } from './context.mjs';
import { claimOnce } from './subagent-context.mjs';
import { briefDeclarations, declarationValue } from './brief-directives.mjs';
import { safe } from './runaway.mjs';

export const STEP_WARN_DEFAULT = 80;
export const STEP_STOP_DEFAULT = 120;
export const STEP_LOOKUP_WARN_DEFAULT = 40;
export const STEP_LOOKUP_STOP_DEFAULT = 60;
export const STEP_LOG = 'step-budget.jsonl';
export const LOOKUP_TYPES = ['lookup', 'research', 'survey', 'explore', 'verify'];
export const STOP_REASON = 'Step budget reached: write your report now and stop.';
const BRIEF_HEAD_BYTES = [64 * 1024, 1024 * 1024];
const STATE_TTL_MS = 7 * 86400000;

function budgetDir() { return join(stateDir(), 'step-budget'); }

// The first user message of the helper's transcript, as text ('' when unreadable).
// Reads only the head of the file: the brief is the first record.
export function readBrief(path) {
  if (!path) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    for (const want of BRIEF_HEAD_BYTES) { // a small read first: the brief is usually well under 64 KB
      const len = Math.min(size, want);
      if (!len) return '';
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, 0);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || rec.type !== 'user') continue;
        const c = rec.message?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
        return '';
      }
      if (len >= size) return '';
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// { type: string | null, budget: number | null } from the brief's directive lines.
export function briefStepInfo(brief) {
  const decls = briefDeclarations(String(brief || ''));
  const tm = declarationValue(decls, 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
  const bm = declarationValue(decls, 'BUDGET', /(\d{1,6})\b/.source);
  const budget = bm ? Number(bm[1]) : null;
  return { type: tm ? tm[1].toLowerCase() : null, budget: budget > 0 ? budget : null };
}

// { warn, stop, kind } for a brief. A stop <= 0 means no hard stop for the class.
// A BUDGET line replaces the stop and puts the warning at 80% of it.
export function capsFor({ type, budget }) {
  const lookup = LOOKUP_TYPES.includes(type);
  let stop = lookup ? opt('step_budget_lookup_stop', STEP_LOOKUP_STOP_DEFAULT) : opt('step_budget_stop', STEP_STOP_DEFAULT);
  let warn = lookup ? opt('step_budget_lookup_warn', STEP_LOOKUP_WARN_DEFAULT) : opt('step_budget_warn', STEP_WARN_DEFAULT);
  let kind = lookup ? 'lookup' : 'writer';
  if (budget) {
    stop = budget;
    warn = Math.max(1, Math.floor(budget * 0.8));
    kind = 'brief';
  }
  return { warn, stop, kind };
}

// Count this call and return the new total (the call itself included), or null.
export function countCall(agentId) {
  try {
    mkdirSync(budgetDir(), { recursive: true });
    const f = join(budgetDir(), `${safe(agentId)}.cnt`);
    appendFileSync(f, '.');
    return statSync(f).size;
  } catch {
    return null;
  }
}

const REPORT_NAME = /(report|detail|handoff|review|summary|findings|analysis|verdict|notes)/i;
const REPORT_EXT = /\.(md|txt|json|csv)$/i;

// May this call still run past the stop? Writing a report or detail file only.
export function isReportWrite(toolName, toolInput) {
  if (toolName !== 'Write' && toolName !== 'Edit') return false;
  const f = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  const name = basename(f.replace(/\\/g, '/'));
  return REPORT_EXT.test(name) && REPORT_NAME.test(name);
}

const stopMarker = (agentId) => join(budgetDir(), `${safe(agentId)}.stop`);

// The compaction stop is sticky: once a helper has compacted twice, every later call is stopped.
function markCompactionStop(agentId) {
  try {
    mkdirSync(budgetDir(), { recursive: true });
    writeFileSync(stopMarker(agentId), '');
  } catch { /* best effort */ }
}

export function pruneStepState(now = Date.now()) {
  let names = [];
  try { names = readdirSync(budgetDir()); } catch { return; }
  for (const n of names) {
    const f = join(budgetDir(), n);
    try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

export const warnText = (n, m) => `[agent-companion] ${n} of ${m} steps used: finish, write your detail file, report what is left.`;

// The whole check for one helper tool call. `compactions` is how many compactions
// subagent-context.mjs has recorded for this agent (including one found on this
// very call). Returns null (nothing to do), { warn: text, row } or { deny: reason, row }.
export function stepBudgetCheck(p, { transcript, compactions = 0 }) {
  if (!opt('step_budget', true) || !p.agent_id || !transcript) return null;
  const brief = readBrief(transcript);
  if (!brief) return null; // brief unreadable: not a helper this guard understands
  const info = briefStepInfo(brief);
  const caps = capsFor(info);
  const n = countCall(p.agent_id);
  if (n === null) return null;
  if (n === 1) pruneStepState();
  const base = () => ({
    at: new Date().toISOString(), session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type,
    tool: p.tool_name, steps: n, type: info.type, caps: { warn: caps.warn, stop: caps.stop, kind: caps.kind },
  });

  if (compactions >= 2) markCompactionStop(p.agent_id);
  const compactionStop = existsSync(stopMarker(p.agent_id));
  const stepStop = caps.stop > 0 && n > caps.stop;
  if ((stepStop || compactionStop) && !isReportWrite(p.tool_name, p.tool_input)) {
    return { deny: STOP_REASON, row: { ...base(), kind: 'stop', why: stepStop ? 'steps' : 'compactions' } };
  }
  if (caps.stop > 0 && caps.warn > 0 && caps.warn < caps.stop && n >= caps.warn && claimOnce(`step-warn-${p.agent_id}`)) {
    return { warn: warnText(n, caps.stop), row: { ...base(), kind: 'warn' } };
  }
  return null;
}
