// usage/telemetry.mjs: the spawn telemetry rows the worker metrics read (daily usage analysis, batch 6b).
//
// Sources, all below the state root and all read only:
//   telemetry/spawns.jsonl           one row per Agent call (the spawn guard writes it)
//   telemetry/review-verdicts.jsonl  reviewer verdicts, folded into the reviewer rows by session and tool_use_id
//   telemetry/denials.jsonl          routing-guard denials
//   telemetry/struggle.jsonl         one row per operator prompt: the struggle detector's verdict for the session
//
// Records handed to the metrics (a record is a plain object with a kind and a sid; see cohort.mjs):
//   { kind:'srow',     sid, row, ... }   a spawn row, with the cohort fields mapped (declaredType, rung, fit ...)
//   { kind:'denial',   sid, row }
//   { kind:'struggle', sid, flagged, prompts }   one per session and day
//
// A file over the size cap is read from its tail. A missing file gives no rows; the caller decides whether that
// is a gap (a metric names the file it needs). Corrupt lines are skipped. Nothing here writes.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { dayStartMs, DAY_MS } from './days.mjs';

const MAX_BYTES = 48 * 1024 * 1024;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (x) => (typeof x === 'string' && x.trim() !== '' ? x : null);

/** The telemetry directory below a state root. */
export const telemetryDirOf = (root) => join(root, 'telemetry');

function readText(file) {
  try {
    const size = statSync(file).size;
    if (size <= MAX_BYTES) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      readSync(fd, buf, 0, MAX_BYTES, size - MAX_BYTES);
      return buf.toString('utf8').split('\n').slice(1).join('\n');
    } finally { closeSync(fd); }
  } catch { return null; }
}

function readRows(file) {
  const text = readText(file);
  if (text === null) return null;
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (isObj(j)) rows.push(j); } catch { /* torn or corrupt line */ }
  }
  return rows;
}

const atMs = (r, key = 'at') => (typeof r[key] === 'string' ? Date.parse(r[key]) : NaN);

/**
 * All telemetry of a state root, read once: { spawns, denials, struggle, present } where each list is oldest first
 * and `present` says which files exist. Reviewer rows carry `review_verdict` folded from review-verdicts.jsonl.
 */
export function readTelemetry(root) {
  const dir = telemetryDirOf(root);
  const spawns = readRows(join(dir, 'spawns.jsonl'));
  const verdicts = readRows(join(dir, 'review-verdicts.jsonl'));
  const denials = readRows(join(dir, 'denials.jsonl'));
  const struggle = readRows(join(dir, 'struggle.jsonl'));
  const by = new Map();
  for (const j of verdicts || []) {
    if (nonEmpty(j.review_of_tool_use_id) && typeof j.review_verdict === 'string') by.set(`${j.session_id}|${j.review_of_tool_use_id}`, j.review_verdict);
  }
  const folded = (spawns || []).map((r) => {
    if (r.review_verdict !== undefined || !nonEmpty(r.tool_use_id)) return r;
    const k = `${r.session_id}|${r.tool_use_id}`;
    return by.has(k) ? { ...r, review_verdict: by.get(k) } : r;
  });
  const sortAt = (rows, key) => rows.filter((r) => Number.isFinite(atMs(r, key))).sort((a, b) => atMs(a, key) - atMs(b, key));
  return {
    spawns: sortAt(folded, 'at'),
    denials: sortAt(denials || [], 'at'),
    struggle: sortAt(struggle || [], 'ts'),
    present: { spawns: spawns !== null, denials: denials !== null, struggle: struggle !== null, verdicts: verdicts !== null },
  };
}

// A spawn row mapped to the cohort field names. `model` is the alias the guard logged (opus, sonnet, haiku, a full id).
function srowOf(r) {
  const type = nonEmpty(r.declared_type_resolved) || nonEmpty(r.declared_type);
  return {
    kind: 'srow',
    sid: nonEmpty(r.session_id) || '(no session)',
    row: r,
    ...(type ? { declaredType: type } : {}),
    ...(nonEmpty(r.fit) ? { fit: r.fit } : {}),
    ...(nonEmpty(r.model) ? { model: r.model, models: [r.model] } : {}),
    ...(nonEmpty(r.caller_effort) ? { effort: r.caller_effort } : {}),
  };
}

/** The first spawn row at or after which each guard_version was seen: version -> ms. */
export function versionFirstSeen(tel) {
  const out = new Map();
  for (const r of tel.spawns) {
    const v = nonEmpty(r.guard_version);
    if (v && !out.has(v)) out.set(v, atMs(r));
  }
  return out;
}

// hooks/lib/struggle.mjs MIN_FLAGGED: flagged prompts in the window that make the detector fire (kept here so this reader stays dependency-free).
const STRUGGLE_MIN_FLAGGED = 2;
// The shipping writer (hooks/struggle-detector.mjs) logs "flagged" as an INTEGER count of flagged prompts in the window and
// "fired" as the boolean. The detector flagged the session when it fired, or when the window reached the firing count
// (a fire that cooldown or an unattended session suppressed still was a flag). A legacy boolean "flagged: true" also counts.
export function isFlaggedRow(r) {
  if (!r) return false;
  if (r.fired === true || r.flagged === true) return true;
  return Number.isFinite(r.flagged) && r.flagged >= STRUGGLE_MIN_FLAGGED;
}

/**
 * The records of one checkup day, from a telemetry read. `boundary` is the day-boundary UTC hour. A spawn row whose
 * guard version appears first in this day carries firstSeenVersion: true. A day with spawn rows but no telemetry file
 * at all returns [], and the metric's own gap says which file it needs.
 */
export function telemetryRecords(tel, day, boundary, { first = null } = {}) {
  const a = dayStartMs(day, boundary); const b = a + DAY_MS;
  const inDay = (r, key = 'at') => { const t = atMs(r, key); return t >= a && t < b; };
  const firstSeen = first || versionFirstSeen(tel);
  const out = [];
  for (const r of tel.spawns) {
    if (!inDay(r)) continue;
    const rec = srowOf(r);
    const v = nonEmpty(r.guard_version);
    if (v && firstSeen.get(v) === atMs(r)) rec.firstSeenVersion = true;
    out.push(rec);
  }
  for (const r of tel.denials) if (inDay(r)) out.push({ kind: 'denial', sid: nonEmpty(r.session_id) || '(no session)', row: r });
  const sess = new Map();
  for (const r of tel.struggle) {
    if (!inDay(r, 'ts')) continue;
    const sid = nonEmpty(r.session_id) || '(no session)';
    const s = sess.get(sid) || { kind: 'struggle', sid, flagged: false, prompts: 0 };
    s.prompts += 1; if (isFlaggedRow(r)) s.flagged = true;
    sess.set(sid, s);
  }
  out.push(...[...sess.values()].sort((x, y) => (x.sid < y.sid ? -1 : 1)));
  return out;
}
