// Day, week, meter and exclusion metrics of the daily usage analysis (design section 2, "Day and
// week"; batch 6a). Each entry has the register-style day(p, rec, rows, x) (it answers from the
// checkup history record where that holds the figure, else a gap that says what it needs) and the
// stat(records, ctx) adapter the runner's evaluateScenario calls.
//
// RECORDS. stat() reads what usage/cohort.mjs hands it:
//   kind 'session'  one per session (workers pooled into their lead): units{main,sub,total}, byModel{m,s},
//                   tok, pr, class, proj ...
//   kind 'day'      one per day (hooks.dayRecords): { hist, meter, hours } - the checkup history figures,
//                   the plan-meter sample nearest the day's end and the units per hour.
// A breakdown rides on `detail` (kept by compare.mjs for a single day); the headline figure is the
// DayStat (num / den * scale). A gap is never a zero.
//
// Zero tokens, no I/O: pure functions over records.
import { finite } from './helpers.mjs';
import { familyOf, applyExclusions } from '../cohort.mjs';

export const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : x);
const sumBy = (recs, f) => recs.reduce((s, r) => s + f(r), 0);
const sessionsOf = (recs) => recs.filter((r) => r.kind === 'session');
const dayOf = (recs) => recs.find((r) => r.kind === 'day') || null;

// Units by bucket -> { key: units } with stable (sorted) keys and 4-decimal values.
function table(map) {
  const out = {};
  for (const k of Object.keys(map).sort()) out[k] = r4(map[k]);
  return out;
}
const biggest = (map) => Object.keys(map).sort((a, b) => map[b] - map[a] || (a < b ? -1 : 1))[0];

// The share (percent) of the day's units in one bucket: params[param] when set, else the largest bucket.
function shareOf(recs, bucketOf, wanted, extraDetail = () => ({})) {
  const ss = sessionsOf(recs);
  const by = {}; const n = {};
  let total = 0;
  for (const r of ss) {
    const k = bucketOf(r);
    by[k] = (by[k] || 0) + r.units.total; n[k] = (n[k] || 0) + 1; total += r.units.total;
  }
  if (!(total > 0)) return { gap: true, why: 'the day has no units' };
  const key = wanted || biggest(by);
  return {
    num: by[key] || 0, den: total, scale: 100, sample: ss.length,
    detail: { key, units: table(by), sessions: n, totalUnits: r4(total), ...extraDetail(ss) },
  };
}

const historyGap = (why = 'no checkup history record for the day') => ({ gap: true, why });

export const PACE_MIN_ELAPSED_PCT = 25;
// A gap when too little of the plan week has elapsed for the projection to mean anything (and to compare across a reset).
function paceTooEarly(w, params) {
  const min = params && Number.isFinite(params.minElapsedPct) ? params.minElapsedPct : PACE_MIN_ELAPSED_PCT;
  const el = finite(w.elapsedPct);
  if (el === null) return { gap: true, why: 'the week figure has no elapsed share' };
  return el < min ? { gap: true, why: `only ${r4(el)}% of the plan week has elapsed (needs ${min}%): the pace is not compared across the week reset` } : null;
}

export const DAY_METRICS = [
  {
    id: 'day.units', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/day', direction: 'up-is-worse', pool: 'sum',
    needs: ['F'], recordKinds: ['session'], params: { defaults: {} },
    day(p, rec) {
      const total = rec && rec.units ? finite(rec.units.total) : null;
      return total === null ? historyGap() : { num: total, den: 1, scale: 1, sample: 1 };
    },
    stat(recs) {
      const ss = sessionsOf(recs);
      if (!ss.length) return { gap: true, why: 'no sessions on the day' };
      return {
        num: sumBy(ss, (r) => r.units.total), den: 1, scale: 1, sample: ss.length,
        detail: { mainUnits: r4(sumBy(ss, (r) => r.units.main)), subagentUnits: r4(sumBy(ss, (r) => r.units.sub)), sessions: ss.length },
      };
    },
  },
  {
    id: 'day.byClass', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of day units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F', 'class rules'], recordKinds: ['session'], params: { defaults: { class: null } },
    day() { return { gap: true, why: 'reads the facts (session classes), not the history record' }; },
    // value: the share of the day's units in params.class, else in the largest class; detail: units by class
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      return shareOf(recs, (r) => r.class || '(unobservable)', typeof p.class === 'string' ? p.class : null);
    },
  },
  {
    id: 'day.byProject', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of day units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: { project: null } },
    day() { return { gap: true, why: 'reads the facts (project labels), not the history record' }; },
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      return shareOf(recs, (r) => r.proj || '(unknown)', typeof p.project === 'string' ? p.project : null);
    },
  },
  {
    id: 'day.byModel', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of day units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['session'], params: { defaults: { family: null } },
    day() { return { gap: true, why: 'reads the facts (tokens by model), not the history record' }; },
    // value: the share of the day's units on model family params.family, else on the largest family; detail adds raw tokens by model
    stat(recs, ctx) {
      const p = ctx && ctx.params ? ctx.params : {};
      const ss = sessionsOf(recs);
      const fam = {}; const byModel = {}; const tokens = {};
      let total = 0;
      for (const r of ss) {
        for (const [m, u] of Object.entries(r.byModel || {})) {
          const units = u.m + u.s;
          const f = familyOf(m) || '(other)';
          fam[f] = (fam[f] || 0) + units; byModel[m] = (byModel[m] || 0) + units; total += units;
        }
        for (const [m, t] of Object.entries(r.tok || {})) tokens[m] = (tokens[m] || 0) + sumBy([0, 1, 2, 3, 4], (i) => t.m[i] + t.s[i]);
      }
      if (!(total > 0)) return { gap: true, why: 'the day has no units' };
      const key = typeof p.family === 'string' ? p.family : biggest(fam);
      return {
        num: fam[key] || 0, den: total, scale: 100, sample: ss.length,
        detail: { key, unitsByFamily: table(fam), unitsByModel: table(byModel), rawTokensByModel: table(tokens), totalUnits: r4(total) },
      };
    },
  },
  {
    // The projected percentage of the weekly limit at the end of the plan week, at the pace so far.
    id: 'week.pace', source: 'history', register: false, entity: 'day', label: 'M', unit: '% at week end', direction: 'up-is-worse', pool: 'ratio',
    // A projection from the first hours of a plan week swings far past any threshold against the last day of the old one, so a
    // day with less than params.minElapsedPct of its plan week elapsed is a gap: the first days after the reset are never compared
    // across the reset (a gap baseline gives no verdict), only days well inside one week against the day before.
    needs: ['H', 'week reset'], recordKinds: ['day'], params: { defaults: { minElapsedPct: PACE_MIN_ELAPSED_PCT } },
    day(p, rec) {
      const w = rec && rec.week ? rec.week : null;
      if (!w || finite(w.paceAtResetPct) === null) return historyGap();
      if (w.partial) return { gap: true, why: 'the week figure is partial: the scan began after the week started' };
      const early = paceTooEarly(w, p);
      if (early) return early;
      return { num: w.paceAtResetPct, den: 1, scale: 1, sample: 1 };
    },
    stat(recs, ctx) {
      const d = dayOf(recs);
      const w = d && d.hist ? d.hist.week : null;
      if (!w || finite(w.paceAtResetPct) === null) return historyGap();
      if (w.partial) return { gap: true, why: 'the week figure is partial: the scan began after the week started' };
      const early = paceTooEarly(w, ctx && ctx.params);
      if (early) return early;
      return {
        num: w.paceAtResetPct, den: 1, scale: 1, sample: 1,
        detail: { pctSoFar: w.pctSoFar, elapsedPct: w.elapsedPct, projectedAtResetPct: w.paceAtResetPct },
      };
    },
  },
  {
    // Local week-to-date percentage against the plan meter's seven_day.used_percentage. The value is the absolute
    // gap in points; detail carries the signed gap (positive = local above the meter: weight error;
    // negative = cloud use or another machine).
    id: 'meter.reconcile', source: 'plan-meter', register: false, entity: 'day', label: 'M', unit: 'points', direction: 'up-is-worse', pool: 'ratio',
    needs: ['H', 'PM'], recordKinds: ['day'], params: { defaults: {} },
    day() { return { gap: true, why: 'unobservable: reads the plan-meter samples (statusline), not the history record' }; },
    stat(recs) {
      const d = dayOf(recs);
      if (!d || !d.hist || !d.hist.week) return historyGap();
      const w = d.hist.week;
      if (w.partial) return { gap: true, why: 'the week figure is partial: the scan began after the week started' };
      const m = d.meter;
      if (!m) return { gap: true, why: 'unobservable: no plan-meter sample (statusline) on the day' };
      if (m.otherWeek) return { gap: true, why: 'the meter sample belongs to another plan week than the day end' };
      const local = w.pctSoFar - (m.pctAfterSample || 0);
      const signed = local - m.pct;
      return {
        num: Math.abs(signed), den: 1, scale: 1, sample: 1,
        detail: { localPct: r4(local), meterPct: m.pct, signedGapPoints: r4(signed), sampleAt: m.at, weekToDateAtDayEndPct: w.pctSoFar },
      };
    },
  },
  {
    id: 'day.limitHits', source: 'history', register: false, entity: 'day', label: 'M', unit: 'hits', direction: 'up-is-worse', pool: 'sum',
    needs: ['H'], recordKinds: ['day'], params: { defaults: {} },
    day(p, rec) {
      const n = rec && rec.limit ? finite(rec.limit.hits) : null;
      return n === null ? historyGap() : { num: n, den: 1, scale: 1, sample: 1 };
    },
    stat(recs) {
      const d = dayOf(recs);
      const l = d && d.hist ? d.hist.limit : null;
      if (!l || finite(l.hits) === null) return historyGap();
      return { num: l.hits, den: 1, scale: 1, sample: 1, detail: { firstAt: l.firstAt || null } };
    },
  },
  {
    // The share of the day's units in its busiest hour (a storm or an overnight run shows as a high share).
    id: 'day.hours', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% in the busiest hour', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F'], recordKinds: ['day'], params: { defaults: {} },
    day() { return { gap: true, why: 'reads the facts (hourly rows), not the history record' }; },
    stat(recs) {
      const d = dayOf(recs);
      const hours = d && d.hours ? d.hours : null;
      if (!hours) return { gap: true, why: 'no hourly units for the day' };
      const keys = Object.keys(hours);
      const total = sumBy(keys, (k) => hours[k]);
      if (!(total > 0)) return { gap: true, why: 'the day has no units' };
      const peak = biggest(hours);
      return {
        num: hours[peak], den: total, scale: 100, sample: keys.length,
        detail: { peakHour: peak, unitsByHour: table(hours), totalUnits: r4(total) },
      };
    },
  },
  {
    // What the user layer's exclusions removed from the day: the units and the share of the day's units. It applies
    // every defined exclusion itself (COUNTS_EVERYTHING), so the report shows what each rule took. Nothing defined: 0.
    id: 'day.excludedShare', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of day units removed', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F', 'exclusions'], recordKinds: ['session'], params: { defaults: {} },
    day() { return { gap: true, why: 'reads the facts and the exclusion rules, not the history record' }; },
    stat(recs, ctx) {
      const ss = sessionsOf(recs);
      const total = sumBy(ss, (r) => r.units.total);
      if (!(total > 0)) return { gap: true, why: 'the day has no units' };
      const table0 = ctx && ctx.exclusions ? ctx.exclusions : {};
      const names = Object.keys(table0).sort();
      const ex = applyExclusions(ss, names, table0);
      const removed = sumBy(Object.values(ex.report), (v) => v.units);
      const rules = {};
      for (const [n, v] of Object.entries(ex.report)) rules[n] = { units: r4(v.units), records: v.records, scope: v.scope, ...(v.why ? { why: v.why } : {}) };
      return {
        num: removed, den: total, scale: 100, sample: ss.length,
        detail: { removedUnits: r4(removed), totalUnits: r4(total), rules, unobservable: ex.unobservable, undefinedRules: ex.undefinedRules },
      };
    },
  },
];
