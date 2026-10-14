// Routine metrics of the daily usage analysis (design section 2, "Routines and the plugin"; batch 6b).
//
// RECORDS (usage/routines.mjs):
//   kind 'routineSource'  one per day: dr (are the desktop session records readable?), fires, watch[], cron{task: expr}
//   kind 'routine'        one per scheduled fire in the day: task, model, effort, expectModel, expectEffort, drift[], pinned
//   kind 'session'        the day's session records; those of class 'routine' carry the routine's units
//
// DR is the decision register's source of routine runs (the desktop app's session records); RP is the routine pins
// (SKILL.md model line, the run folder's effort pin). A missing DR gives "unobservable", never zero: no records is not
// "no drift". Pure functions, no I/O.
import { r4 } from './day.mjs';
import { cronFiresBetween } from '../routines.mjs';
import { DAY_MS } from '../days.mjs';

const sourceOf = (recs) => recs.find((r) => r.kind === 'routineSource') || null;
const unobservable = { gap: true, why: 'unobservable: no desktop session records (DR) are readable here, so scheduled runs cannot be seen' };
const needsFacts = () => ({ gap: true, why: 'reads the routine records, not the history record' });

export const ROUTINE_METRICS = [
  {
    // Fires that departed from a pin (model or effort) over the fires that had a pin to be judged against. M.
    id: 'routine.modelDrift', source: 'routines', register: false, entity: 'day', label: 'M', unit: '% of pinned fires', direction: 'up-is-worse', pool: 'ratio',
    needs: ['DR', 'RP'], recordKinds: ['routineSource', 'routine'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const src = sourceOf(recs);
      if (!src || !src.dr) return unobservable;
      const fires = recs.filter((r) => r.kind === 'routine' && r.pinned);
      if (!fires.length) return { gap: true, why: src.fires ? 'no fire of the day had a pin to be judged against (RP)' : 'no scheduled fire in the day' };
      const drifted = fires.filter((r) => r.drift.length > 0);
      const byTask = {};
      for (const r of fires) { const b = (byTask[r.task] ||= { fires: 0, drifted: 0, why: [] }); b.fires += 1; if (r.drift.length) { b.drifted += 1; for (const w of r.drift) if (!b.why.includes(w)) b.why.push(w); } }
      const tasks = {}; for (const k of Object.keys(byTask).sort()) tasks[k] = byTask[k];
      const by = new Map();
      for (const r of fires) { const p = by.get(r.sid) || { id: r.sid, num: 0, den: 0 }; p.den += 1; if (r.drift.length) p.num += 1; by.set(r.sid, p); }
      return { num: drifted.length, den: fires.length, scale: 100, sample: fires.length, parts: [...by.values()], detail: { fires: src.fires, pinnedFires: fires.length, drifted: drifted.length, tasks } };
    },
  },
  {
    // Units of routine-class sessions per scheduled fire. E: sessions and fires are matched by day, not by folder.
    id: 'routine.costPerRun', source: 'routines', register: false, entity: 'day', label: 'E', unit: 'units/run', direction: 'up-is-worse', pool: 'ratio',
    needs: ['DR', 'F'], recordKinds: ['routineSource', 'session'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const src = sourceOf(recs);
      if (!src || !src.dr) return unobservable;
      if (!(src.fires > 0)) return { gap: true, why: 'no scheduled fire in the day' };
      const ss = recs.filter((r) => r.kind === 'session' && r.class === 'routine');
      const units = ss.reduce((a, r) => a + r.units.total, 0);
      return { num: units, den: src.fires, scale: 1, sample: src.fires, detail: { routineSessions: ss.length, fires: src.fires, units: r4(units) } };
    },
  },
  {
    // Expected fires of the watched routines minus the fires seen. Expected = the cron expression of the task (environment
    // routines.cron), else one per day for a watched task. E: a task with no cron is assumed daily.
    id: 'routine.missedRuns', source: 'routines', register: false, entity: 'day', label: 'E', unit: 'missed runs', direction: 'up-is-worse', pool: 'sum',
    needs: ['DR'], recordKinds: ['routineSource', 'routine'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const src = sourceOf(recs);
      if (!src || !src.dr) return unobservable;
      if (!src.watch.length) return { gap: true, why: 'no routine is watched (environment routines.watch is empty)' };
      const a = src.fromMs;
      const seen = {};
      for (const r of recs) if (r.kind === 'routine') seen[r.task] = (seen[r.task] || 0) + 1;
      let missed = 0; let expectedAll = 0;
      const tasks = {};
      for (const t of src.watch) {
        let exp = 1; let how = 'daily';
        const expr = src.cron[t];
        if (typeof expr === 'string' && Number.isFinite(a)) {
          const n = cronFiresBetween(expr, a, a + DAY_MS);
          if (n !== null) { exp = n; how = 'cron'; }
        }
        const got = seen[t] || 0;
        const m = Math.max(0, exp - got);
        tasks[t] = { expected: exp, seen: got, missed: m, how };
        missed += m; expectedAll += exp;
      }
      return { num: missed, den: 1, scale: 1, sample: expectedAll, detail: { expected: expectedAll, missed, tasks } };
    },
  },
];
