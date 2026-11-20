// Plan-meter readings (0.31.47): the result of the desktop app's `get_usage` tool (mcp__ccd_session_mgmt__get_usage) is the
// only place the official weekly % can be read under the desktop app (the statusLine never runs there). Two readers use
// this parser: hooks/plan-meter-sample.mjs (appends each reading to state/plan-meter-samples.jsonl) and
// scripts/calibrate-weights.mjs (refits config/plan-weights.json from samples plus the same results found in transcripts).
//
// The result is JSON text: { plan: { status, plan: "Ultra", windows: [ { label: "Weekly · all models", percentUsed: 73,
// resetsAt: ISO, resetsIn: "2d 20h" }, { label: "Weekly · Fable", ... }, { label: "5-hour limit", ... } ] }, context: {...} }.
// The 5-hour window is absent on the Ultra plan. The result carries the plan's name but NO account id (checked against real stored
// samples, 2026-11), so the sampler tags each sample from lib/account.mjs instead (0.31.59).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRootPath } from './context.mjs';

const textOf = (v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (v && typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.content !== undefined) return textOf(v.content);
  }
  return '';
};

// The parsed JSON object of a tool result in any shape the harness uses (string, content blocks, already an object), or null.
export function usageJson(res) {
  if (res && typeof res === 'object' && !Array.isArray(res) && res.plan && typeof res.plan === 'object') return res;
  const t = textOf(res).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* text around the JSON */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const pct = (w) => (w && typeof w.percentUsed === 'number' && Number.isFinite(w.percentUsed) ? w.percentUsed : null);
const iso = (s) => (typeof s === 'string' && Number.isFinite(Date.parse(s)) ? s : null);

// { weekly, fable, fiveHour, plan, weeklyResetsAt, fiveHourResetsAt } or null when there is no weekly all-models %.
// Percents are the card's integers; a window that is absent is null.
export function parseUsage(res) {
  const j = usageJson(res);
  const windows = j && j.plan && Array.isArray(j.plan.windows) ? j.plan.windows : null;
  if (!windows) return null;
  const find = (re) => windows.find((w) => w && typeof w.label === 'string' && re.test(w.label));
  const wk = find(/all models/i);
  const weekly = pct(wk);
  if (weekly === null) return null;
  const fable = find(/fable/i);
  const five = find(/5.?hour/i);
  return {
    weekly,
    fable: pct(fable),
    fiveHour: pct(five),
    plan: typeof j.plan.plan === 'string' ? j.plan.plan : null,
    weeklyResetsAt: iso(wk.resetsAt),
    fiveHourResetsAt: five ? iso(five.resetsAt) : null,
  };
}

// One line of state/plan-meter-samples.jsonl for a reading. Fields that are absent are left out. `account` (0.31.59, lib/account.mjs
// currentAccount()) is written as `acct` when known, so a reading can be told from another account's after a switch.
export function sampleLine(reading, { ts, sessionId, account } = {}) {
  const out = { ts, source: 'get_usage', weekly_pct: reading.weekly };
  if (account) out.acct = account;
  if (reading.fable !== null) out.fable_weekly_pct = reading.fable;
  if (reading.fiveHour !== null) out.five_hour_pct = reading.fiveHour;
  if (reading.plan) out.plan = reading.plan;
  if (sessionId) out.session_id = sessionId;
  if (reading.weeklyResetsAt) out.weekly_resets_at = reading.weeklyResetsAt;
  if (reading.fiveHourResetsAt) out.five_hour_resets_at = reading.fiveHourResetsAt;
  return out;
}

// --- Reading the samples back (0.31.59) -----------------------------------------------------------------------------------------
// Each account has its own weekly meter, so a reader must only use the current account's samples (lib/account.mjs).

// The get_usage lines of state/plan-meter-samples.jsonl (or `file`), oldest first:
// { ts, tMs, weekly, fable, fiveHour, plan, weeklyResetsAt, fiveHourResetsAt, acct } with absent fields null. A missing file, a torn
// line or a line of another shape (the old statusLine format) is skipped.
export function readSampleLines(file = join(stateRootPath(), 'state', 'plan-meter-samples.jsonl')) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('weekly_pct')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const tMs = Date.parse(j && j.ts);
    if (!Number.isFinite(tMs) || typeof j.weekly_pct !== 'number') continue;
    out.push({
      ts: j.ts, tMs, weekly: j.weekly_pct,
      fable: typeof j.fable_weekly_pct === 'number' ? j.fable_weekly_pct : null,
      fiveHour: typeof j.five_hour_pct === 'number' ? j.five_hour_pct : null,
      plan: typeof j.plan === 'string' ? j.plan : null,
      weeklyResetsAt: iso(j.weekly_resets_at), fiveHourResetsAt: iso(j.five_hour_resets_at),
      acct: typeof j.acct === 'string' && j.acct ? j.acct : null,
    });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

// The samples that belong to `account` (a readSampleLines result in, same shape out). Samples written before accounts were tagged
// carry no `acct`: while NO sample is tagged they all count (one account, as before); once any is tagged, a sample counts only when its
// tag equals `account`, and an account of null matches the untagged ones. Never another account's reading.
export function samplesOf(samples, account = null) {
  if (!samples.some((s) => s.acct)) return samples;
  return samples.filter((s) => (s.acct || null) === (account || null));
}

// The newest sample of `account`, or null: the "no reading" case a fresh install is in. The caller decides what a sample whose
// weeklyResetsAt has passed means (its week rolled over).
export function latestSample(account = null, samples = readSampleLines()) {
  const mine = samplesOf(samples, account);
  return mine.length ? mine[mine.length - 1] : null;
}
