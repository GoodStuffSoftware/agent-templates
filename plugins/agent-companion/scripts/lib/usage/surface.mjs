// SessionStart surfacing of the daily usage summary, and the unattended guard (design sections 4 and 5;
// 0.31.18 batch 5b). Used by hooks/scout-surface.mjs. Reads two small files below the state root and
// writes one; no scan, no network, no child process, no model. Kept free of runner.mjs on purpose: a
// hook pays for every module it loads (the path strings are checked against usagePaths by a test).
//
// The summary (3 lines, written by the runner into state/usage-analysis-latest.json) surfaces once,
// and again only when the SET of regression ids changes (`surfaceKey`). The key last shown is in
// state/usage-analysis-surfaced.json. An unattended session is never shown the summary and never marks
// it shown: the 04:10 scout and the other routines would otherwise consume it before the operator sees it.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sessionRecordRoot, scheduledRuns } from '../routine-model-drift.mjs';

export const SURFACE_MAX_AGE_MS = 72 * 3600000;
export const ATTENDED_ENV = 'CLAUDE_CODE_SESSION_ATTENDED';
// A scheduled run's session record is created as the run starts; the hook runs at that start.
export const SCHEDULED_RECORD_WINDOW_MS = 3 * 60 * 1000;
export const DAY_OFFSET_MS = 8 * 3600000; // a checkup day runs 08:00Z to 08:00Z

export const latestFile = (root) => join(root, 'state', 'usage-analysis-latest.json');
export const surfacedFile = (root) => join(root, 'state', 'usage-analysis-surfaced.json');
export const routinePinsFile = (root) => join(root, 'config', 'routine-pins.json');

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The summary to show now, or null: { lines, key, day }. Null when no analysis ran, the latest day is
 * older than 72 hours past its close, or this regression set was already shown. Never throws.
 */
export function pendingUsageSummary({ root, nowT = Date.now() } = {}) {
  try {
    const latest = readJson(latestFile(root));
    if (!isObj(latest) || !Array.isArray(latest.lines) || latest.lines.length === 0 || typeof latest.surfaceKey !== 'string' || !latest.surfaceKey) return null;
    const startMs = Date.parse(`${latest.day}T08:00:00Z`);
    if (!Number.isFinite(startMs) || nowT - (startMs + 24 * 3600000) > SURFACE_MAX_AGE_MS) return null;
    const shown = readJson(surfacedFile(root));
    if (isObj(shown) && shown.key === latest.surfaceKey) return null;
    return { lines: latest.lines.filter((l) => typeof l === 'string'), key: latest.surfaceKey, day: latest.day };
  } catch {
    return null;
  }
}

/** Record that this regression set was shown. Fail-open. */
export function markUsageSurfaced(root, pending, nowT = Date.now()) {
  try {
    const f = surfacedFile(root);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ key: pending.key, day: pending.day, at: new Date(nowT).toISOString() })}\n`);
    renameSync(tmp, f);
  } catch { /* advisory */ }
}

// --- the unattended guard -------------------------------------------------------------------

const norm = (p) => {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const under = (child, parent) => {
  const a = norm(child); const b = norm(parent);
  return !!a && !!b && (a === b || a.startsWith(`${b}/`));
};

/** The routine run folders in config/routine-pins.json (`folders`), placeholders skipped. */
export function routineFolders(root) {
  const j = readJson(routinePinsFile(root));
  const f = isObj(j) && isObj(j.folders) ? j.folders : {};
  return Object.values(f).filter((v) => typeof v === 'string' && v && !v.includes('{{'));
}

/**
 * Why this session is unattended, or null when it is attended (or cannot be told: fail toward showing).
 *   - the env the struggle detector uses: CLAUDE_CODE_SESSION_ATTENDED === '0'
 *   - a cwd under a routine-cwd-* folder, or under a folder listed in routine-pins.json
 *   - a scheduledTaskId: on the hook payload, or on a scheduled-run session record the desktop app
 *     created for this cwd within the last few minutes
 * Cheap checks first; the record lookup is the only one that reads outside the state root.
 */
export function unattendedReason({
  env = process.env, payload = {}, cwd = process.cwd(), root, nowT = Date.now(), records = true,
} = {}) {
  try {
    if (env[ATTENDED_ENV] === '0') return `${ATTENDED_ENV}=0`;
    const dir = (payload && typeof payload.cwd === 'string' && payload.cwd) || cwd;
    if (/(^|\/)routine-cwd-[^/]*(\/|$)/i.test(String(dir).replace(/\\/g, '/'))) return 'routine folder (routine-cwd-*)';
    for (const f of routineFolders(root)) if (under(dir, f)) return 'routine folder (routine-pins)';
    if (payload && ((typeof payload.scheduledTaskId === 'string' && payload.scheduledTaskId) || (typeof payload.scheduled_task_id === 'string' && payload.scheduled_task_id))) return 'scheduledTaskId';
    if (records) {
      const sroot = sessionRecordRoot({ env });
      if (existsSync(sroot)) {
        for (const r of scheduledRuns(sroot, nowT, SCHEDULED_RECORD_WINDOW_MS)) {
          if (r.cwd && under(dir, r.cwd) && under(r.cwd, dir)) return 'scheduledTaskId (session record)';
        }
      }
    }
  } catch { /* fail toward attended: the summary shows */ }
  return null;
}
