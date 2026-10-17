// The usage metric registry (daily-analysis design, section 3.4). One entry per code-backed
// metric: id, the source it reads, an M/E label, its pooling rule and a day() function that
// returns { num, den, scale, sample } or { gap: true }. Entries marked `register: true` are the
// decision register's metric catalog; those 13 ids are FROZEN (a change in meaning gets a new id).
//
// Zero tokens: pure functions over rows the caller already read. No I/O here.
//
// Labels: M = measured from telemetry as written; E = estimated or heuristic (the re-brief
// detector is unvalidated, see helpers.mjs buildLeadIndex).
import {
  isObj, finite, nonEmpty, typeOf, isLeadRow, verdictOf, buildLeadIndex, denialEffort, DENY_GUARDS,
} from './helpers.mjs';
import { DAY_METRICS } from './day.mjs';
import { LEAD_METRICS } from './lead.mjs';
import { WORKER_METRICS, REGISTER_ADAPTERS, telemetryAdapter } from './workers.mjs';
import { ROUTINE_METRICS } from './routine.mjs';

// The metric context handed to day(): p = trigger params, rec = the history record for the day
// (or null), rows = the day's spawn rows (or undefined), x = { idx(), denials }.
const levelsOf = (p) => (Array.isArray(p.levels) ? p.levels : []);

export const REGISTRY = [
  {
    id: 'unitsPerSpawn', source: 'history', register: true, entity: 'day', label: 'M', unit: 'units/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H'], perDayTotal: false, byLeadLevels: false,
    day(p, rec) {
      if (!rec || !rec.spawns) return { gap: true };
      const cls = nonEmpty(p.type) ? (rec.spawns.byType || {})[p.type] : (rec.spawns.byRung || {})[p.rung];
      const units = cls ? finite(cls.units) : null;
      const n = cls ? finite(cls.n) : null;
      if (units === null || n === null || n <= 0) return { gap: true };
      return { num: units, den: n, scale: 1, sample: n };
    },
  },
  {
    id: 'mainUnitsPerDay', source: 'history', register: true, entity: 'day', label: 'M', unit: 'units/day', direction: 'up-is-worse', pool: 'sum',
    needs: ['H'], perDayTotal: true, byLeadLevels: false,
    day(p, rec) {
      const main = rec && rec.units ? finite(rec.units.main) : null;
      const total = rec && rec.units ? finite(rec.units.total) : null;
      if (main === null || total === null) return { gap: true };
      return { num: main, den: 1, scale: 1, sample: total };
    },
    // runner adapter: the day's main-thread units over the session records (sample = the day's units, as day() has it)
    recordKinds: ['session'],
    stat(recs) {
      const ss = recs.filter((r) => r.kind === 'session');
      const total = ss.reduce((a, r) => a + r.units.total, 0);
      if (!ss.length || !(total > 0)) return { gap: true, why: 'no units on the day' };
      return { num: ss.reduce((a, r) => a + r.units.main, 0), den: 1, scale: 1, sample: total };
    },
  },
  {
    id: 'shareOver150kPct', source: 'history', register: true, entity: 'day', label: 'M', unit: '%', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H'], perDayTotal: false, byLeadLevels: false,
    day(p, rec) {
      const over = rec && rec.subagent ? finite(rec.subagent.unitsOver150k) : null;
      const sub = rec && rec.units ? finite(rec.units.subagent) : null;
      if (over === null || sub === null || sub <= 0) return { gap: true };
      return { num: over, den: sub, scale: 100, sample: sub };
    },
  },
  {
    id: 'compactionsPer100Spawns', source: 'history', register: true, entity: 'day', label: 'M', unit: 'per 100 spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H'], perDayTotal: false, byLeadLevels: false,
    day(p, rec) {
      const comp = rec && rec.subagent ? finite(rec.subagent.compactions) : null;
      const sp = rec && rec.spawns ? finite(rec.spawns.total) : null;
      if (comp === null || sp === null || sp <= 0) return { gap: true };
      return { num: comp, den: sp, scale: 100, sample: sp };
    },
  },
  {
    id: 'ceilingNudgesPerDay', source: 'history', register: true, entity: 'day', label: 'M', unit: 'nudges/day', direction: 'up-is-worse', pool: 'sum',
    needs: ['H'], perDayTotal: true, byLeadLevels: false,
    day(p, rec) {
      const nud = rec ? finite(rec.ceilingNudges) : null;
      const sp = rec && rec.spawns ? finite(rec.spawns.total) : null;
      if (nud === null || sp === null) return { gap: true };
      return { num: nud, den: 1, scale: 1, sample: sp };
    },
  },
  {
    id: 'leadEffortShare', source: 'spawns', register: true, entity: 'day', label: 'M', unit: 'share', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], perDayTotal: false, byLeadLevels: false,
    day(p, rec, rows) {
      const lead = (rows || []).filter((r) => r.caller_is_subagent === false && nonEmpty(r.caller_effort));
      const hit = lead.filter((r) => levelsOf(p).includes(r.caller_effort)).length;
      return { num: hit, den: lead.length, scale: 1, sample: lead.length };
    },
  },
  {
    id: 'reviewsPerWriter', source: 'spawns', register: true, entity: 'day', label: 'M', unit: 'reviews/writer', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], perDayTotal: false, byLeadLevels: false,
    day(p, rec, rows) {
      const reviews = (rows || []).filter((r) => typeOf(r) === 'code-review' && nonEmpty(r.caller_tool_use_id)).length;
      const writers = (rows || []).filter((r) => typeOf(r) === p.writerType).length;
      return { num: reviews, den: writers, scale: 1, sample: writers };
    },
  },
  {
    id: 'haikuSpawns', source: 'spawns', register: true, entity: 'day', label: 'M', unit: 'spawns', direction: 'up-is-worse', pool: 'sum',
    needs: ['S'], perDayTotal: false, byLeadLevels: false,
    day(p, rec, rows) {
      const all = rows || [];
      return { num: all.filter((r) => r.model === 'haiku').length, den: 1, scale: 1, sample: all.length };
    },
  },
  // Lead-effort metrics (decision leads-at-high). Zero token: local telemetry only.
  {
    id: 'leadRebriefsPer100Spawns', source: 'spawns', register: true, entity: 'day', label: 'E', unit: 'per 100 spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], perDayTotal: false, byLeadLevels: true,
    day(p, rec, rows, x) {
      const lead = (rows || []).filter((r) => isLeadRow(r) && levelsOf(p).includes(r.caller_effort));
      const idx = x.idx && x.idx();
      return { num: idx ? lead.filter((r) => idx.rebrief.has(r)).length : 0, den: lead.length, scale: 100, sample: lead.length };
    },
  },
  {
    id: 'reviewFixShareByLeadEffort', source: 'spawns', register: true, entity: 'day', label: 'M', unit: '%', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S', 'RV'], perDayTotal: false, byLeadLevels: true,
    day(p, rec, rows, x) {
      const levels = levelsOf(p);
      const idx = x.idx && x.idx();
      let fix = 0; let all = 0;
      for (const r of rows || []) {
        if (typeOf(r) !== 'code-review') continue;
        const v = verdictOf(r);
        if (v === null) continue; // no verdict in telemetry: not a sample
        // The writer that spawned the reviewer; a reviewer a lead spawned itself counts for that lead.
        const w = idx && nonEmpty(r.caller_tool_use_id) ? idx.byToolUse.get(r.caller_tool_use_id) : null;
        const lr = w ? (isLeadRow(w) ? w : null) : (isLeadRow(r) ? r : null);
        if (!lr || !levels.includes(lr.caller_effort)) continue;
        all += 1; if (v === 'fix') fix += 1;
      }
      return { num: fix, den: all, scale: 100, sample: all };
    },
  },
  {
    // Also reads denials.jsonl (x.denials).
    id: 'leadRoutingDeniesPer100Spawns', source: 'spawns', register: true, entity: 'day', label: 'M', unit: 'per 100 spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], perDayTotal: false, byLeadLevels: true, extraInputs: ['denials'],
    day(p, rec, rows, x) {
      const levels = levelsOf(p);
      const lead = (rows || []).filter((r) => isLeadRow(r) && levels.includes(r.caller_effort));
      const idx = x.idx && x.idx();
      const n = (x.denials || []).filter((d) => d && d.outcome === 'deny' && DENY_GUARDS.has(d.guard) && idx && levels.includes(denialEffort(idx, d))).length;
      return { num: n, den: lead.length, scale: 100, sample: lead.length };
    },
  },
  {
    id: 'leadUnderProvisionedShare', source: 'spawns', register: true, entity: 'day', label: 'M', unit: '%', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], perDayTotal: false, byLeadLevels: true,
    day(p, rec, rows) {
      const levels = levelsOf(p);
      const scored = (rows || []).filter((r) => isLeadRow(r) && levels.includes(r.caller_effort) && nonEmpty(r.declared_type) !== null && ['fit', 'over', 'under'].includes(r.fit));
      return { num: scored.filter((r) => r.fit === 'under').length, den: scored.length, scale: 100, sample: scored.length };
    },
  },
  {
    id: 'mainUnitsPerLeadSpawn', source: 'history', register: true, entity: 'day', label: 'M', unit: 'units/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H'], perDayTotal: false, byLeadLevels: false,
    day(p, rec) {
      const main = rec && rec.units ? finite(rec.units.main) : null;
      const sp = rec && rec.spawns ? finite(rec.spawns.total) : null;
      if (main === null || sp === null || sp <= 0) return { gap: true };
      return { num: main, den: sp, scale: 1, sample: sp };
    },
    // runner adapter: main-thread units per spawn record (needs both kinds; the spawn records come from the spawn hook)
    recordKinds: ['session', 'spawn'],
    stat(recs) {
      const ss = recs.filter((r) => r.kind === 'session');
      const sp = recs.filter((r) => r.kind === 'spawn').length;
      if (!sp) return { gap: true, why: 'no spawn records' };
      return { num: ss.reduce((a, r) => a + r.units.main, 0), den: sp, scale: 1, sample: sp };
    },
  },
  {
    // The share over the ACTIVE context ceiling (subagent_ceiling_tokens, default 175K), with the line
    // the day was counted against beside it (subagent.ceilingTokens). A day without one line is a gap.
    id: 'shareOverCeilingPct', source: 'history', register: true, entity: 'day', label: 'M', unit: '%', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H'], perDayTotal: false, byLeadLevels: false,
    day(p, rec) {
      const s = rec && rec.subagent ? rec.subagent : null;
      const over = s && finite(s.ceilingTokens) > 0 ? finite(s.unitsOverCeiling) : null;
      const sub = rec && rec.units ? finite(rec.units.subagent) : null;
      if (over === null || sub === null || sub <= 0) return { gap: true };
      return { num: over, den: sub, scale: 100, sample: sub };
    },
  },
  // Day, week, meter, exclusion and lead metrics (batch 6a): not register metrics; each has day() and stat().
  ...DAY_METRICS,
  ...LEAD_METRICS,
  // Worker, routing, review, Haiku, routine and plugin metrics (batch 6b).
  ...WORKER_METRICS,
  ...ROUTINE_METRICS,
];

// stat() adapters for the register metrics that had only day() (batch 6b); the register metrics keep their meaning.
for (const m of REGISTRY) {
  const a = REGISTER_ADAPTERS[m.id];
  if (!a || m.stat) continue;
  m.recordKinds = a.recordKinds;
  if (a.params) m.params = { defaults: { ...a.params } };
  m.stat = a.telemetry ? telemetryAdapter(m) : a.stat;
}

const BY_ID = new Map(REGISTRY.map((m) => [m.id, m]));

export function getMetric(id) { return BY_ID.get(id) || null; }
export function listMetrics() { return REGISTRY.slice(); }

// The registry as loadConfig's `metrics` option wants it ({id: {params:{defaults}}}): with it an unknown
// metric id is a config error and a scenario's params are checked against the metric's declared defaults.
export function configMetricRegistry() {
  return Object.fromEntries(REGISTRY.map((m) => [m.id, { params: m.params }]));
}

// The register's catalog is a projection of the registry: name -> the source it reads.
export function registerCatalog() {
  const out = {};
  for (const m of REGISTRY) if (m.register) out[m.id] = m.source;
  return out;
}
export const METRIC_CATALOG = registerCatalog();

// The frozen register ids. A test pins this list; add to it only by adding a new id.
export const FROZEN_REGISTER_IDS = Object.freeze(Object.keys(METRIC_CATALOG));

// Metrics that need params.levels (the lead efforts counted).
export const LEAD_LEVEL_METRICS = new Set(REGISTRY.filter((m) => m.byLeadLevels).map((m) => m.id));
// Per-day totals: a limit-hit day is a gap for these.
export const PER_DAY_TOTALS = new Set(REGISTRY.filter((m) => m.perDayTotal).map((m) => m.id));

// One checkup day of one metric: { num, den, scale, sample } (value = num/den*scale; sample = the
// day's n for minSample) or { gap:true }. A zero-unit day (usage lockout) is a gap, and so is a
// limit-hit day (history `limit.hits > 0`) for the per-day total metrics; ratio metrics keep a
// limit-hit day when it meets the sample. `t` is the trigger ({ metric, params }).
export function metricDayStat(t, rec, rows, x = {}) {
  const p = isObj(t.params) ? t.params : {};
  if (rec) {
    const total = rec.units ? finite(rec.units.total) : null;
    if (total === 0) return { gap: true };
    if (PER_DAY_TOTALS.has(t.metric) && rec.limit && finite(rec.limit.hits) > 0) return { gap: true };
  }
  const m = BY_ID.get(t.metric);
  if (!m) return { gap: true };
  return m.day(p, rec, rows, x);
}

// Index builder re-exported for the register, which memoises it across a trigger's days.
export { buildLeadIndex };
