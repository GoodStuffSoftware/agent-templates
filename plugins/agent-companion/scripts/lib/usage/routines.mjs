// usage/routines.mjs: scheduled-run records for the routine metrics (daily usage analysis, batch 6b).
//
// Reads, never writes:
//   DR  the desktop app's session records (local_*.json with a scheduledTaskId), through scripts/lib/routine-model-drift.mjs
//   RP  each routine's SKILL.md `model:` line and the run folder's effort pin (.claude/settings.local.json)
// Both are the same reads the scout's routine drift signal makes; this module only shapes them into records.
//
// Records for one checkup day:
//   { kind:'routineSource', sid:'(routines)', dr, fires, watch:[...], cron:{task: expr} }   always one; dr:false = no session records
//   { kind:'routine', sid, class:'routine', routineId, task, cwd, model, effort, createdMs, expectModel, expectEffort,
//     pinKeys, drift:[reason ...], pinned }                                                   one per fire in the day
//
// A fire is judged only against pins that existed when it started (a pin file modified after the fire says nothing about it).
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  scheduledRuns, readTaskModels, folderEffortFor, modelMatches,
} from '../routine-model-drift.mjs';
import { dayStartMs, DAY_MS } from './days.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fileMtime = (f) => { try { return f ? statSync(f).mtimeMs : 0; } catch { return 0; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Is there a readable store of desktop session records at `sessionsRoot` (a directory with at least one account folder)? */
export function drPresent(sessionsRoot) {
  if (!sessionsRoot || !isDir(sessionsRoot)) return false;
  try { return readdirSync(sessionsRoot).length > 0; } catch { return false; }
}

/**
 * A source of routine fires: reads the store once (a scan of every record is not repeated per day) and answers
 * records(day, boundary, environment).
 *   sessionsRoot   the desktop session record store
 *   claudeDirPath  the config directory holding scheduled-tasks/<task>/SKILL.md
 *   nowMs          the clock
 *   keepDays       how far back fires are kept
 */
export function makeRoutineSource({ sessionsRoot, claudeDirPath, nowMs, keepDays = 200 }) {
  let runs = null; let tasks = null; let present = null;
  const load = () => {
    if (present !== null) return;
    present = drPresent(sessionsRoot);
    runs = present ? scheduledRuns(sessionsRoot, nowMs, keepDays * DAY_MS) : [];
    tasks = claudeDirPath ? readTaskModels(claudeDirPath) : new Map();
  };
  const judge = (r) => {
    const skillAt = claudeDirPath ? fileMtime(join(claudeDirPath, 'scheduled-tasks', r.task, 'SKILL.md')) : 0;
    const settingsAt = r.cwd ? fileMtime(join(r.cwd, '.claude', 'settings.local.json')) : 0;
    const expectModel = tasks.has(r.task) && !(skillAt && r.createdAt < skillAt) ? tasks.get(r.task) : null;
    const pin = settingsAt && r.createdAt < settingsAt ? null : folderEffortFor(r.cwd, r.model);
    const drift = [];
    if (expectModel && !modelMatches(expectModel, r.model)) drift.push(`model ${r.model || 'unrecorded'}, pinned ${expectModel}`);
    if (pin) {
      if (pin.level && r.effort && pin.level !== r.effort) drift.push(`effort ${r.effort}, pinned ${pin.level}`);
      if (!pin.level) drift.push(`the folder effort pin is keyed to ${pin.keys.join(', ')}, not ${r.model || 'this model'}`);
    }
    return {
      expectModel: expectModel || null, expectEffort: pin && pin.level ? pin.level : null, pinKeys: pin ? pin.keys : [],
      drift, pinned: !!expectModel || !!pin,
    };
  };
  return {
    records(day, boundary, environment = {}) {
      load();
      const routines = isObj(environment.routines) ? environment.routines : {};
      const watch = Array.isArray(routines.watch) ? routines.watch.filter((x) => typeof x === 'string') : [];
      const cron = isObj(routines.cron) ? routines.cron : {};
      const a = dayStartMs(day, boundary); const b = a + DAY_MS;
      const fires = runs.filter((r) => r.createdAt >= a && r.createdAt < b);
      const source = { kind: 'routineSource', sid: '(routines)', dr: present, fires: fires.length, fromMs: a, toMs: b, watch: watch.slice().sort(), cron };
      const recs = fires.map((r) => ({
        kind: 'routine', sid: `routine-${r.session}`, class: 'routine', routineId: r.task, task: r.task, cwd: r.cwd,
        model: r.model || undefined, effort: r.effort || undefined, createdMs: r.createdAt, ...judge(r),
      }));
      return [source, ...recs];
    },
  };
}

// ------------------------------------------------------------------ cron --

function fieldSet(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    let lo = min; let hi = max;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      lo = x; hi = y === undefined ? (m[2] ? max : x) : y;
    }
    if (!(lo >= min && hi <= max && lo <= hi)) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * How many times a five-field cron expression (minute hour day-of-month month day-of-week; numbers, ranges, lists, steps,
 * `*`) fires in [fromMs, toMs), in LOCAL time (the desktop app schedules in local time). null when the expression is not
 * understood. Day-of-month and day-of-week combine with OR when both are restricted, as cron does.
 */
export function cronFiresBetween(expr, fromMs, toMs) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets = [fieldSet(f[0], 0, 59), fieldSet(f[1], 0, 23), fieldSet(f[2], 1, 31), fieldSet(f[3], 1, 12), fieldSet(f[4].replace(/\b7\b/g, '0'), 0, 6)];
  if (sets.some((s) => !s)) return null;
  const domRestricted = f[2] !== '*'; const dowRestricted = f[4] !== '*';
  let n = 0;
  const start = Math.ceil(fromMs / 60000) * 60000;
  for (let t = start; t < toMs; t += 60000) {
    const d = new Date(t);
    if (!sets[0].has(d.getMinutes()) || !sets[1].has(d.getHours()) || !sets[3].has(d.getMonth() + 1)) continue;
    const dom = sets[2].has(d.getDate()); const dow = sets[4].has(d.getDay());
    const dayOk = domRestricted && dowRestricted ? dom || dow : dom && dow;
    if (dayOk) n += 1;
  }
  return n;
}
