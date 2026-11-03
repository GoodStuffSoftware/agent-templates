// Plan-meter readings (0.31.47): the result of the desktop app's `get_usage` tool (mcp__ccd_session_mgmt__get_usage) is the
// only place the official weekly % can be read under the desktop app (the statusLine never runs there). Two readers use
// this parser: hooks/plan-meter-sample.mjs (appends each reading to state/plan-meter-samples.jsonl) and
// scripts/calibrate-weights.mjs (refits config/plan-weights.json from samples plus the same results found in transcripts).
//
// The result is JSON text: { plan: { status, plan: "Ultra", windows: [ { label: "Weekly · all models", percentUsed: 73,
// resetsAt: ISO, resetsIn: "2d 20h" }, { label: "Weekly · Fable", ... }, { label: "5-hour limit", ... } ] }, context: {...} }.
// The 5-hour window is absent on the Ultra plan.

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

// One line of state/plan-meter-samples.jsonl for a reading. Fields that are absent are left out.
export function sampleLine(reading, { ts, sessionId } = {}) {
  const out = { ts, source: 'get_usage', weekly_pct: reading.weekly };
  if (reading.fable !== null) out.fable_weekly_pct = reading.fable;
  if (reading.fiveHour !== null) out.five_hour_pct = reading.fiveHour;
  if (reading.plan) out.plan = reading.plan;
  if (sessionId) out.session_id = sessionId;
  if (reading.weeklyResetsAt) out.weekly_resets_at = reading.weeklyResetsAt;
  if (reading.fiveHourResetsAt) out.five_hour_resets_at = reading.fiveHourResetsAt;
  return out;
}
