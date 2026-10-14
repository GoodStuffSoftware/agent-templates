// usage/compare.mjs: comparisons, thresholds and groupBy of the daily usage analysis
// (design section 3.2: `compare`, `threshold`, `groupBy`; section 2, "Day and week").
//
// WHAT A STAT IS. A metric turns the day's selected records into a DayStat:
//   { num, den, scale, sample, parts? }  value = num / den * scale; `sample` is the n that
//                                         threshold.minSample is judged against
//   { gap: true, why }                   no value. A gap is NEVER a zero: it is left out of every
//                                         pool, and a comparison with too few usable days says so.
// `parts` ([{id, num, den, value?}], normally one per session) feeds `bootstrap-sessions`.
//
// PIPELINE for one scenario and one day (evaluateScenario):
//   load the day's records -> exclusions (cohort scenarios only) -> record kinds -> cohort
//   -> [group] -> metric.stat -> DayStat -> pool over the days a comparison names -> judge.
//
// COMPARISONS (current = the day being closed, except for windows)
//   prior-day        D-1
//   trailing-7       D-7..D-1 pooled; needs at least 4 usable days, else status "insufficient"
//   same-weekday-4   D-7, D-14, D-21, D-28 pooled; needs at least 2 usable days (E: the design names no minimum)
//   level            no baseline day: the day's figure against a fixed zero. For a count that must stay 0 (drifted fires, missed
//                    runs) any figure above 0 is the verdict, on every day it holds. A day with no figure is a gap, never ok.
//   {window, vs}     the window to date (clamped to the end of D) against window `vs`, or against
//                    "pre-window": the stretch of equal length just before the window starts.
//                    Boundaries are hour-resolved, so a window that starts mid-day pools the part
//                    of that day inside it (facts are hourly).
// Days are the checkup days of days.mjs: fixed 24-hour UTC spans, so a local DST change moves nothing.
//
// JUDGMENT. direction says which way is worse (default: the metric's, else up-is-worse). A breach
// needs the worse move to satisfy relPct AND abs (whichever are set), the current side's sample and
// the baseline's to reach minSample, and the current side to span minDays usable days. Then:
//   interval "none"                the point rule decides
//   interval "wilson"              also needs the 95% Wilson intervals of the two proportions to
//                                  separate (proportion metrics only; otherwise the point rule decides, and says so)
//   interval "bootstrap-sessions"  also needs the seeded 95% bootstrap interval of the difference to exclude 0
//                                  (seed = day + scenario id; needs parts; otherwise the point rule decides, and says so)
// status: regression | improvement | ok | unconfirmed (breach by the point rule that the interval did
// not confirm) | gap | insufficient | low-sample | low-days | not-started | window-unresolved.
//
// Pure: loadDay, the event sources and the metric are injected; nothing here reads or writes a file.

import {
  addDays, dayStartMs, dayEndMs, weekdayOf, daysOverlapping, DAY_MS, DEFAULT_BOUNDARY_UTC_HOUR,
} from './days.mjs';
import { resolveWindow } from './events.mjs';
import { applyCohort, applyExclusions, COUNTS_EVERYTHING } from './cohort.mjs';
import { wilson, bootstrapDiff, poolParts, median, p90, seedFor } from './stats.mjs';

export const TRAILING_DAYS = 7;
export const TRAILING_MIN_DAYS = 4;
export const SAME_WEEKDAY_WEEKS = 4;
export const SAME_WEEKDAY_MIN_DAYS = 2;
export const UNKNOWN_GROUP = '(unobservable)';
const MAX_GROUPS = 50;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------- group keys --

export function groupValue(rec, groupBy) {
  const v = groupBy === 'project' ? rec.proj : rec[groupBy];
  return v === undefined || v === null || v === '' ? UNKNOWN_GROUP : String(v);
}

// ------------------------------------------------------------------ providers --

/**
 * A provider answers stat(day, range?) for one scenario (and one group): the DayStat of that
 * day, or of the part of it inside `range` {fromMs, toMs}. Memoized.
 *   loadDay(day, range?) -> { records } | { gap, why }      (cohort.mjs makeFactsLoader)
 *   metric: { id, pool, direction, label, recordKinds?, stat(records, ctx) -> DayStat }
 */
export function makeProvider({ scenario, resolved, loadDay, metric, group = null }) {
  const def = scenario.def || {};
  const everything = COUNTS_EVERYTHING.has(scenario.metric);
  const kinds = metric.recordKinds || ['session'];
  const memo = new Map();

  function select(day, range) {
    const L = loadDay(day, range);
    if (!L || L.gap) return { gap: true, why: (L && L.why) || `no records for ${day}` };
    let recs = L.records;
    // A loaded day (its facts file exists and the loader did not call it partial) with no session record at all.
    const quietDay = !recs.some((r) => r.kind === 'session');
    // Exclusions see every record kind first (a tree exclusion is decided on the session, whatever the metric counts).
    const meta = { exclusionsIgnored: everything && (def.excludeSets || []).length > 0 };
    if (!everything && (def.excludeSets || []).length) {
      const ex = applyExclusions(recs, def.excludeSets, resolved.exclusions || {});
      recs = ex.kept;
      meta.excluded = ex.report; meta.excludedUnobservable = ex.unobservable;
      if (ex.undefinedRules.length) meta.undefinedExclusions = ex.undefinedRules;
    }
    recs = recs.filter((r) => kinds.includes(r.kind));
    const c = applyCohort(recs, def.cohort);
    if (c.gap) return { gap: true, why: c.why, meta };
    if (Object.keys(c.unknown).length) meta.cohortUnobservable = c.unknown;
    return { records: c.kept, meta, quietDay };
  }

  function stat(day, range = null) {
    const key = `${day}|${range ? range.fromMs : ''}|${range ? range.toMs : ''}`;
    if (memo.has(key)) return memo.get(key);
    let out;
    try {
      const s = select(day, range);
      if (s.gap) out = { gap: true, why: s.why, meta: s.meta };
      else {
        const recs = group === null || !def.groupBy ? s.records : s.records.filter((r) => groupValue(r, def.groupBy) === group);
        // Empty-day rule (lead decision, 0.31.18). A SETTLED day whose facts file exists and holds zero sessions is a real
        // zero for a sum-type metric over facts records (session, spawn): nothing was spent, and leaving it out would bias every
        // baseline upward and hide a real drop to zero. For a ratio metric a zero denominator is still a gap. A day with no
        // facts file, or a partial/unsettled one, never gets here (loadDay says gap), and a cohort or exclusion that removed
        // the day's records (the day was not quiet) stays a gap too.
        if (!recs.length && group === null && s.quietDay && metric.pool === 'sum' && kinds.every((k) => k === 'session' || k === 'spawn')) {
          out = { num: 0, den: 1, scale: 1, sample: 0, meta: s.meta };
        } else if (!recs.length) out = { gap: true, why: group === null ? 'no records in the cohort' : `no records in group ${group}`, meta: s.meta };
        else {
          const r = metric.stat(recs, { day, range, params: def.params || {}, scenario, group, exclusions: resolved.exclusions || {}, meta: s.meta });
          if (!isObj(r) || r.gap) out = { gap: true, why: (r && r.why) || 'metric has no value', meta: s.meta };
          else if (!num(r.num) || !num(r.den) || r.den <= 0) out = { gap: true, why: 'metric has no sample', meta: s.meta };
          else out = { ...r, scale: num(r.scale) ? r.scale : 1, sample: num(r.sample) ? r.sample : r.den, meta: s.meta };
        }
      }
    } catch (e) {
      out = { gap: true, why: `metric failed: ${String((e && e.message) || e).slice(0, 80)}` };
    }
    memo.set(key, out);
    return out;
  }

  /** Sorted group values present among the selected records of `day` (the groupBy partition). */
  function groupKeys(day, range = null) {
    if (!def.groupBy) return [];
    const s = select(day, range);
    if (s.gap) return [];
    return [...new Set(s.records.map((r) => groupValue(r, def.groupBy)))].sort();
  }

  return { stat, groupKeys };
}

// -------------------------------------------------------------------- pooling --

/**
 * Pool the DayStats of `slots` [{day, range?, coverage}] with the metric's pool rule. Returns
 * { value, num, den, scale, sample, parts, days (usable keys), gapDays [{day, why}] }; value is null
 * when no slot is usable. Gaps and empty days are left out, never counted as zero.
 */
export function poolSlots(provider, slots, pool = 'ratio') {
  let n = 0; let d = 0; let sample = 0; let scale = 1;
  const parts = []; const days = []; const gapDays = []; const dayValues = []; const details = [];
  for (const s of slots) {
    const st = provider.stat(s.day, s.range || null);
    if (!st || st.gap) { gapDays.push({ day: s.day, why: st ? st.why : 'no stat' }); continue; }
    n += st.num; d += st.den * (pool === 'sum' ? s.coverage ?? 1 : 1); sample += st.sample; scale = st.scale;
    if (Array.isArray(st.parts)) parts.push(...st.parts.map((p) => ({ ...p, day: s.day })));
    dayValues.push((st.num / st.den) * st.scale);
    if (st.detail !== undefined) details.push(st.detail);
    days.push(s.day);
  }
  let value = null;
  if (days.length) {
    if (pool === 'median' || pool === 'p90') value = parts.length ? poolParts(parts, pool, scale) : (pool === 'median' ? median(dayValues) : p90(dayValues));
    else value = d > 0 ? (n / d) * scale : null;
  }
  // a metric may attach a breakdown (detail); it is kept when exactly one day is pooled
  return { value, num: n, den: d, scale, sample, parts, days, gapDays, ...(days.length === 1 && details.length === 1 ? { detail: details[0] } : {}) };
}

function slotsOfRange(fromMs, toMs, boundary) {
  return daysOverlapping(fromMs, toMs, boundary).map((day) => {
    const s = dayStartMs(day, boundary); const e = s + DAY_MS;
    const from = Math.max(fromMs, s); const to = Math.min(toMs, e);
    const whole = from === s && to === e;
    return { day, range: whole ? null : { fromMs: from, toMs: to }, coverage: (to - from) / DAY_MS };
  });
}

const slotsOfDays = (keys) => keys.map((day) => ({ day, range: null, coverage: 1 }));

// ------------------------------------------------------------------- judgment --

/**
 * Judge `cur` against `base` (pooled sides) under `threshold`. Returns the verdict fields:
 * { status, delta, relPct, worse, direction, thresholdMet, interval }.
 */
export function judge({ cur, base, threshold = {}, direction = 'up-is-worse', metric = {}, day, scenarioId }) {
  const dir = direction === 'down-is-worse' ? 'down-is-worse' : 'up-is-worse';
  const minSample = num(threshold.minSample) ? threshold.minSample : 1;
  const minDays = num(threshold.minDays) ? threshold.minDays : 1;
  const out = { direction: dir };
  if (cur.value === null || base.value === null) return { ...out, status: 'gap' };
  const delta = cur.value - base.value;
  const relPct = base.value !== 0 ? (delta / Math.abs(base.value)) * 100 : null;
  Object.assign(out, { delta, relPct });
  if (cur.sample < minSample || base.sample < minSample) return { ...out, status: 'low-sample', thresholdMet: { sample: false, minSample } };
  if (cur.days.length < minDays) return { ...out, status: 'low-days', thresholdMet: { days: false, minDays } };

  const worseSign = dir === 'up-is-worse' ? 1 : -1;
  // Is the move in direction `sign` (+1 up, -1 down) big enough under relPct and abs?
  const moves = (sign) => {
    const amount = delta * sign;
    if (!(amount > 0)) return { rel: false, abs: false, all: false };
    const rel = !num(threshold.relPct) || (base.value === 0 ? true : (amount / Math.abs(base.value)) * 100 >= threshold.relPct);
    const abs = !num(threshold.abs) || amount >= threshold.abs;
    return { rel, abs, all: rel && abs };
  };
  const worse = moves(worseSign); const better = moves(-worseSign);
  const kind = worse.all ? 'regression' : better.all ? 'improvement' : null;
  out.thresholdMet = { sample: true, days: true, rel: kind === 'improvement' ? better.rel : worse.rel, abs: kind === 'improvement' ? better.abs : worse.abs };
  if (!kind) return { ...out, status: 'ok', worse: delta * worseSign > 0 };

  // The move runs in direction `sign` of a figure: confirm it with the requested interval.
  const sign = kind === 'regression' ? worseSign : -worseSign;
  const want = threshold.interval || 'none';
  let interval = { kind: want, applied: false };
  let confirmed = true;
  if (want === 'wilson') {
    const prop = (s) => Number.isInteger(s.num) && Number.isInteger(s.den) && s.num >= 0 && s.num <= s.den && (s.scale === 1 || s.scale === 100) && metric.pool !== 'median' && metric.pool !== 'p90';
    const wc = prop(cur) && prop(base) ? [wilson(cur.num, cur.den), wilson(base.num, base.den)] : null;
    if (!wc || !wc[0] || !wc[1]) interval = { kind: want, applied: false, why: 'the metric is not a proportion of counts; the point rule decided' };
    else {
      confirmed = sign > 0 ? wc[0].lo > wc[1].hi : wc[0].hi < wc[1].lo;
      interval = { kind: want, applied: true, confirmed, cur: { lo: wc[0].lo, hi: wc[0].hi }, base: { lo: wc[1].lo, hi: wc[1].hi } };
    }
  } else if (want === 'bootstrap-sessions') {
    if (!cur.parts.length || !base.parts.length) interval = { kind: want, applied: false, why: 'no per-session parts; the point rule decided' };
    else {
      const bs = bootstrapDiff({ cur: cur.parts, base: base.parts, pool: metric.pool || 'ratio', scale: cur.scale, seed: seedFor(day, scenarioId) });
      if (!bs) interval = { kind: want, applied: false, why: 'bootstrap produced no samples; the point rule decided' };
      else {
        confirmed = sign > 0 ? bs.lo > 0 : bs.hi < 0;
        interval = { kind: want, applied: true, confirmed, lo: bs.lo, hi: bs.hi, iterations: bs.iterations, seed: bs.seed };
      }
    }
  }
  return { ...out, interval, status: confirmed ? kind : 'unconfirmed', worse: delta * worseSign > 0 };
}

// ---------------------------------------------------------------- comparisons --

const specName = (spec) => (typeof spec === 'string' ? spec : `${spec.window} vs ${spec.vs}`);

function side(p) { return { ...(p.detail !== undefined ? { detail: p.detail } : {}), value: p.value, num: p.num, den: p.den, scale: p.scale, sample: p.sample, days: p.days, gapDays: p.gapDays, ...(p.parts.length ? { parts: p.parts.length } : {}) }; }

/**
 * One comparison of one provider on `day`. Returns
 *   { compare, label, status, why?, current, baseline, delta, relPct, interval, thresholdMet, ... }
 */
export function compareOne({ spec, day, provider, metric = {}, threshold = {}, scenarioId, windows = {}, sources = {}, boundary = DEFAULT_BOUNDARY_UTC_HOUR }) {
  const pool = metric.pool || 'ratio';
  const base = { compare: specName(spec), label: metric.label === 'E' ? 'E' : 'M' };
  const dir = threshold.direction || metric.direction || 'up-is-worse';
  const finish = (cur, bas, extra = {}) => ({ ...base, ...extra, current: side(cur), baseline: side(bas), ...judge({ cur, base: bas, threshold, direction: dir, metric: { ...metric, pool }, day, scenarioId }) });
  const unusable = (status, why, extra = {}) => ({ ...base, status, why, ...extra });

  if (typeof spec === 'string') {
    const cur = poolSlots(provider, slotsOfDays([day]), pool);
    if (cur.value === null) return unusable('gap', `the day itself has no value: ${(cur.gapDays[0] && cur.gapDays[0].why) || 'empty'}`, { current: side(cur) });
    if (spec === 'level') return finish(cur, { value: 0, num: 0, den: 1, scale: cur.scale, sample: cur.sample, parts: [], days: [day], gapDays: [] });
    let keys; let need;
    if (spec === 'prior-day') { keys = [addDays(day, -1)]; need = 1; }
    else if (spec === 'trailing-7') { keys = Array.from({ length: TRAILING_DAYS }, (_, i) => addDays(day, -(i + 1))); need = TRAILING_MIN_DAYS; }
    else if (spec === 'same-weekday-4') { keys = Array.from({ length: SAME_WEEKDAY_WEEKS }, (_, i) => addDays(day, -7 * (i + 1))); need = SAME_WEEKDAY_MIN_DAYS; }
    else return unusable('gap', `unknown comparison "${spec}"`);
    const bas = poolSlots(provider, slotsOfDays(keys.reverse()), pool);
    const extra = spec === 'same-weekday-4' ? { weekday: weekdayOf(day) } : {};
    if (bas.days.length < need) {
      return unusable(spec === 'prior-day' ? 'gap' : 'insufficient', `${bas.days.length} usable of ${keys.length} baseline days; ${need} needed`, { ...extra, current: side(cur), baseline: side(bas), have: bas.days.length, need });
    }
    return finish(cur, bas, extra);
  }

  // window against window, or against the stretch before it
  if (!isObj(spec) || typeof spec.window !== 'string') return unusable('gap', 'malformed comparison');
  const wa = windows[spec.window] ? resolveWindow(windows[spec.window], sources) : { gap: true, why: `window "${spec.window}" is not defined` };
  if (wa.gap) return unusable('window-unresolved', `${spec.window}: ${wa.why}`);
  const evalEnd = dayEndMs(day, boundary);
  if (wa.fromMs >= evalEnd) return unusable('not-started', `${spec.window} starts after ${day}`, { windowLabel: wa.label });
  const curTo = Math.min(wa.toMs === null ? Infinity : wa.toMs, evalEnd);
  let bFrom; let bTo; let wb = null;
  if (spec.vs === 'pre-window') {
    const len = curTo - wa.fromMs;
    bFrom = wa.fromMs - len; bTo = wa.fromMs;
  } else {
    wb = windows[spec.vs] ? resolveWindow(windows[spec.vs], sources) : { gap: true, why: `window "${spec.vs}" is not defined` };
    if (wb.gap) return unusable('window-unresolved', `${spec.vs}: ${wb.why}`);
    bFrom = wb.fromMs; bTo = Math.min(wb.toMs === null ? Infinity : wb.toMs, evalEnd);
    if (!(bTo > bFrom)) return unusable('not-started', `${spec.vs} has not started by ${day}`);
  }
  const windowLabel = wa.label === 'E' || (wb && wb.label === 'E') ? 'E' : 'M';
  const cur = poolSlots(provider, slotsOfRange(wa.fromMs, curTo, boundary), pool);
  const bas = poolSlots(provider, slotsOfRange(bFrom, bTo, boundary), pool);
  const r = finish(cur, bas, { windows: { current: { fromMs: wa.fromMs, toMs: curTo }, baseline: { fromMs: bFrom, toMs: bTo } } });
  if (windowLabel === 'E') r.label = 'E';
  return r;
}

// ------------------------------------------------------------ the scenario level --

const RANK = { regression: 5, unconfirmed: 4, improvement: 3, ok: 2 };

function rollup(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  let status = 'no-data';
  let best = 0;
  for (const [s, n] of Object.entries(counts)) if (n && (RANK[s] || 1) > best) { best = RANK[s] || 1; status = RANK[s] ? s : 'no-data'; }
  return { status, counts };
}

/**
 * Evaluate one resolved scenario ({ id, metric, def, state }) on `day`.
 *   resolved   cfg.resolved of config.mjs (windows, exclusions, environment)
 *   loadDay    (day, range?) -> { records } | { gap, why }   (cohort.mjs makeFactsLoader)
 *   metric     { id, pool, direction, label, recordKinds?, stat(records, ctx) -> DayStat }
 *   sources    event sources of events.mjs
 * Returns { id, metric, day, label, status, counts, comparisons, groups?, meta } where status is the
 * strongest comparison status (regression > unconfirmed > improvement > ok), or "no-data".
 * A disabled, retired or gapped scenario returns { id, skipped: state }.
 */
export function evaluateScenario({ scenario, resolved, day, loadDay, metric, sources = {} }) {
  if (scenario.state && scenario.state !== 'enabled') return { id: scenario.id, skipped: scenario.state };
  const def = scenario.def || {};
  const boundary = resolved.environment && resolved.environment.day ? resolved.environment.day.boundaryUtcHour ?? DEFAULT_BOUNDARY_UTC_HOUR : DEFAULT_BOUNDARY_UTC_HOUR;
  const specs = Array.isArray(def.compare) && def.compare.length ? def.compare : [];
  const mk = (group) => makeProvider({ scenario, resolved, loadDay, metric, group });
  const run = (provider) => specs.map((spec) => compareOne({
    spec, day, provider, metric, threshold: def.threshold || {}, scenarioId: scenario.id, windows: resolved.windows || {}, sources, boundary,
  }));

  const whole = mk(null);
  const today = whole.stat(day);
  const out = { id: scenario.id, metric: scenario.metric, day, label: metric.label === 'E' ? 'E' : 'M', meta: today.meta || {} };
  if (!def.groupBy) {
    out.comparisons = run(whole);
    Object.assign(out, rollup(out.comparisons));
  } else {
    // Group keys: those present on the evaluated day, and in the current window of a window comparison.
    const keys = new Set(whole.groupKeys(day));
    for (const spec of specs) {
      if (!isObj(spec) || !resolved.windows || !resolved.windows[spec.window]) continue;
      const w = resolveWindow(resolved.windows[spec.window], sources);
      if (w.gap || w.fromMs >= dayEndMs(day, boundary)) continue;
      for (const s of slotsOfRange(w.fromMs, Math.min(w.toMs === null ? Infinity : w.toMs, dayEndMs(day, boundary)), boundary)) for (const k of whole.groupKeys(s.day, s.range)) keys.add(k);
    }
    out.groupBy = def.groupBy;
    out.groups = [...keys].sort().slice(0, MAX_GROUPS).map((key) => {
      const comparisons = run(mk(key));
      return { key, comparisons, ...rollup(comparisons) };
    });
    if (keys.size > MAX_GROUPS) out.groupsTruncated = keys.size;
    out.comparisons = [];
    Object.assign(out, rollup(out.groups.flatMap((g) => g.comparisons)));
  }
  return out;
}

