// Session churn — an OFFLINE aggregate of how much a lead session thrashed.
//
// Per lead (main) session per UTC day, four counts:
//   effort_switches  consecutive API requests whose top-level `effort`
//                    differs from the previous request's (a mid-session
//                    /effort change or a model switch that carried one)
//   tool_error_runs  runs of RUN_LENGTH or more consecutive tool results with
//                    is_error: true, each run counted once
//   corrections      user prompts matching CORRECTION_PATTERNS below
//   review_rounds    parity-type spawns (declared_type whose task type has
//                    weight "parity", e.g. code-review) in spawns.jsonl
//
// AGGREGATES ONLY. No message text, prompt text, tool name or file path is
// kept: a row is a session id, a day and integers. The correction matcher
// sees prompt text in memory and throws it away.
//
// Written by `node scripts/transcript-harvest.mjs --churn` to
// session-churn.jsonl beside spawns.jsonl; read by scripts/detect.mjs, which
// emits `session_churn` (dispatch routing-review) per churnVerdict() below.
// Bounded per run: main transcripts only, modified in the last WINDOW_DAYS,
// at most MAX_FILES files / MAX_BYTES bytes / MAX_MS wall clock.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { telemetryDir, taskTypeDef } from '../../hooks/lib/context.mjs';
import {
  transcriptsRoot, discoverTranscripts, readRecords, isCompactSummary,
} from './transcripts.mjs';

export const WINDOW_DAYS = 7;
export const MAX_FILES = 400;
export const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MAX_MS = 60000;
export const KEEP_DAYS = 90;
export const RUN_LENGTH = 3;

// Precision over recall: each pattern is something a person types when the
// agent did the wrong thing, and rarely otherwise. A plain "no" is only
// counted as the FIRST word followed by punctuation ("no, ..." / "no."), and
// not when an approval follows it ("no, that's fine", "nope, all good").
// Prompts over MAX_CORRECTION_CHARS are skipped — long pastes are specs and
// logs, not corrections.
export const CORRECTION_PATTERNS = [
  /^\s*(?:no|nope)\s*[,.!](?!\s*(?:that(?:'s| is) )?(?:fine|ok|okay|good|all good|go ahead|ship)\b)/i,
  /\bthat(?:'s| is) (?:not what i (?:asked|meant|said|wanted)|wrong)\b/i,
  /\bi (?:already )?(?:told|asked) you\b/i,
  /\byou (?:ignored|missed|forgot|didn'?t (?:read|follow|listen))\b/i,
  /\b(?:stop|quit) doing that\b/i,
  /^\s*(?:undo|revert) (?:that|this|it)\b/i,
  /\bwhy did you\b/i,
];
export const MAX_CORRECTION_CHARS = 1500;

// A session-day CHURNS when any count reaches its threshold; the scout signal
// fires when at least CHURN_MIN_SESSION_DAYS session-days churned inside the
// last WINDOW_DAYS. One bad afternoon is noise; two in a week is a pattern
// worth a routing review (a worker sized too low gets corrected, re-run and
// re-reviewed; an effort flipped mid-session is a sizing decision made late).
export const CHURN_THRESHOLDS = { effort_switches: 3, tool_error_runs: 2, corrections: 3, review_rounds: 4 };
export const CHURN_MIN_SESSION_DAYS = 2;
// session-churn.jsonl older than this is reported as stale by the scout,
// never read as "no churn" (the daily scout routine refreshes it).
export const CHURN_STALE_MS = 2 * 86400000;

const HARVEST = 'transcript-harvest.mjs --churn';

// { stale, detail } for the scout, from the file's last write (mtimeMs, null
// when it does not exist) against CHURN_STALE_MS. The write time, not the
// newest row: a run over a quiet week writes the file with no fresh rows and
// is still a fresh run.
export function churnFreshness(mtimeMs, { now = new Date() } = {}) {
  if (mtimeMs == null) return { stale: true, detail: `session-churn.jsonl has never been written, so session_churn cannot fire until ${HARVEST} runs (a daily scout step)` };
  const age = now.getTime() - mtimeMs;
  if (age > CHURN_STALE_MS) {
    return { stale: true, detail: `session-churn.jsonl is stale: last written ${(age / 86400000).toFixed(1)} days ago, so session_churn is reading old data; the daily scout's ${HARVEST} step has not run` };
  }
  return { stale: false, detail: '' };
}

export function isCorrection(text) {
  const t = String(text || '');
  if (!t.trim() || t.length > MAX_CORRECTION_CHARS) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(t));
}

// The typed prompt of a real user record, or null: tool results, meta
// records, compaction summaries and harness-injected tags are not prompts.
function promptText(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || !rec.message) return null;
  if (isCompactSummary(rec)) return null;
  const c = rec.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  if (text == null) return null;
  const t = text.trimStart();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return null;
  return text;
}

const emptyRow = (sessionId, day) => ({
  session_id: sessionId, day, effort_switches: 0, tool_error_runs: 0, corrections: 0, review_rounds: 0, prompts: 0, requests: 0,
});

// Feed one transcript's records; returns Map day -> row.
export async function churnOfTranscript(path, sessionId, fallbackDay) {
  const rows = new Map();
  const rowFor = (day) => {
    const d = day || fallbackDay;
    if (!rows.has(d)) rows.set(d, emptyRow(sessionId, d));
    return rows.get(d);
  };
  const seenReq = new Set();
  let lastEffort = null;
  let run = 0;
  for await (const rec of readRecords(path)) {
    const day = typeof rec.timestamp === 'string' ? rec.timestamp.slice(0, 10) : null;
    if (rec.type === 'assistant') {
      const key = rec.requestId || rec.message?.id;
      if (key && seenReq.has(key)) continue;
      if (key) seenReq.add(key);
      const row = rowFor(day);
      row.requests += 1;
      const e = typeof rec.effort === 'string' && rec.effort ? rec.effort : null;
      if (e && lastEffort && e !== lastEffort) row.effort_switches += 1;
      if (e) lastEffort = e;
      continue;
    }
    if (rec.type !== 'user' || !rec.message) continue;
    const c = rec.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
      for (const b of c) {
        if (!b || b.type !== 'tool_result') continue;
        if (b.is_error === true) {
          run += 1;
          if (run === RUN_LENGTH) rowFor(day).tool_error_runs += 1;
        } else run = 0;
      }
      continue;
    }
    const text = promptText(rec);
    if (text == null) continue;
    const row = rowFor(day);
    row.prompts += 1;
    if (isCorrection(text)) row.corrections += 1;
  }
  return rows;
}

function isParityType(t) {
  if (!t) return false;
  try { return taskTypeDef(t, { profile: false })?.def?.weight === 'parity'; } catch { return false; }
}

export function readSpawnRows() {
  const f = join(telemetryDir(), 'spawns.jsonl');
  if (!existsSync(f)) return [];
  const out = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

export async function scanChurn({
  root = transcriptsRoot(), now = Date.now(), days = WINDOW_DAYS,
  maxFiles = MAX_FILES, maxBytes = MAX_BYTES, maxMs = MAX_MS, spawnRows = readSpawnRows(),
} = {}) {
  const sinceMs = now - days * 86400000;
  const started = Date.now();
  // Discover with no cap (a stat per file only), then keep the NEWEST files
  // first: discoverTranscripts caps in directory order, which would always
  // drop the alphabetically last projects, not the oldest sessions.
  const { files: found } = discoverTranscripts(root, {
    sinceMs, main: true, subagents: false, workflows: false, meta: false,
  });
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const files = [];
  let bytes = 0;
  for (const f of found) {
    if (files.length >= maxFiles || bytes + f.size > maxBytes) continue;
    bytes += f.size;
    files.push(f);
  }
  const dropped = found.length - files.length;
  const capped = dropped > 0;
  const byKey = new Map();
  let timedOut = false;
  let scanned = 0;
  for (const f of files) {
    if (Date.now() - started > maxMs) { timedOut = true; break; }
    const fallbackDay = new Date(f.mtimeMs).toISOString().slice(0, 10);
    // eslint-disable-next-line no-await-in-loop
    const rows = await churnOfTranscript(f.path, f.sessionId, fallbackDay);
    scanned += 1;
    for (const [day, r] of rows) {
      const k = `${f.sessionId}|${day}`;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, r); continue; }
      for (const n of ['effort_switches', 'tool_error_runs', 'corrections', 'prompts', 'requests']) prev[n] += r[n];
    }
  }
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  for (const s of spawnRows) {
    if (!s || !s.session_id || typeof s.at !== 'string' || !isParityType(s.declared_type)) continue;
    const day = s.at.slice(0, 10);
    if (day < sinceDay) continue;
    const k = `${s.session_id}|${day}`;
    if (!byKey.has(k)) byKey.set(k, emptyRow(s.session_id, day));
    byKey.get(k).review_rounds += 1;
  }
  return {
    rows: [...byKey.values()].filter((r) => r.day >= sinceDay),
    stats: {
      found: found.length, files: files.length, dropped, scanned,
      unscanned: files.length - scanned, truncated: capped || timedOut, timedOut,
    },
  };
}

// Replace the fresh keys, keep older history, drop rows past KEEP_DAYS.
export function mergeChurnRows(existing, fresh, { now = Date.now(), keepDays = KEEP_DAYS } = {}) {
  const floor = new Date(now - keepDays * 86400000).toISOString().slice(0, 10);
  const map = new Map();
  for (const r of existing) if (r && r.session_id && r.day >= floor) map.set(`${r.session_id}|${r.day}`, r);
  const at = new Date(now).toISOString();
  for (const r of fresh) map.set(`${r.session_id}|${r.day}`, { ...r, at });
  return [...map.values()].sort((a, b) => (a.day === b.day ? String(a.session_id).localeCompare(String(b.session_id)) : a.day.localeCompare(b.day)));
}

export function churnFile() { return join(telemetryDir(), 'session-churn.jsonl'); }

export function readChurnRows(file = churnFile()) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

export function writeChurnRows(rows, file = churnFile()) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, file);
}

export function churnReasons(r) {
  return Object.entries(CHURN_THRESHOLDS).filter(([k, t]) => (r[k] || 0) >= t).map(([k]) => `${k}=${r[k]}`);
}

// { fire, detail, churning } over the last WINDOW_DAYS of rows.
export function churnVerdict(rows, { now = new Date(), days = WINDOW_DAYS, minSessionDays = CHURN_MIN_SESSION_DAYS } = {}) {
  const sinceDay = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const churning = rows.filter((r) => r && typeof r.day === 'string' && r.day >= sinceDay && churnReasons(r).length);
  if (churning.length < minSessionDays) return { fire: false, detail: '', churning: churning.length };
  const tally = {};
  for (const r of churning) for (const k of Object.keys(CHURN_THRESHOLDS)) if ((r[k] || 0) >= CHURN_THRESHOLDS[k]) tally[k] = (tally[k] || 0) + 1;
  const parts = Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ');
  return {
    fire: true,
    churning: churning.length,
    detail: `${churning.length} lead session-day(s) in ${days}d crossed a churn threshold (${parts}; thresholds ${Object.entries(CHURN_THRESHOLDS).map(([k, t]) => `${k}>=${t}`).join(' ')}) — check whether those sessions' workers were sized too low`,
  };
}
