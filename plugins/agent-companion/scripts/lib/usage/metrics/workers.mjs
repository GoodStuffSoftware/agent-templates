// Worker, routing, review, context and Haiku metrics of the daily usage analysis (design section 2, "Workers and
// routing" and "Haiku plan"; batch 6b), and the stat() adapters of the batch-1 register metrics that read workers.
//
// RECORDS. stat() reads what the runner's hooks hand it (cohort.mjs, runner.mjs makeHooks):
//   kind 'spawn'     one per worker spawn from the facts day file: sid, rung ('sonnet/high' | 'haiku' | an agent type),
//                    declaredType, role, effort, fit, model, status, bucket ('1-5' | '6-15' | '16-40' | '41+'), units{total},
//                    catUnits{category}, catReq{category}, ctxUnits[4] and ctxReq[4] (<100K, 100-150K, 150-200K, 200K+),
//                    peakCtx, startupUnits, comp{n, afterUnits}, extraTurns, simple{runs, req, units}, outTok, requests, rk, startMs
//   kind 'srow'      one per spawn-telemetry row (telemetry/spawns.jsonl): { row } plus the cohort fields
//   kind 'denial'    one per routing-guard denial: { row }
//   kind 'struggle'  one per session and day: flagged, prompts
//   kind 'day'       the checkup history figures and the day's spawn count (hooks.dayRecords)
// A figure with nothing to count is a gap that says what is missing, never a zero. Pure functions, no I/O.
//
// Label M = counted from records as written; E = a heuristic or a modelled figure (stated on each entry).
import { finite, nonEmpty, isLeadRow, buildLeadIndex } from './helpers.mjs';
import { r4 } from './day.mjs';
import { familyOf } from '../cohort.mjs';
import { respawnFlags } from './lead.mjs';

export const CATEGORIES = Object.freeze(['read', 'bash-read', 'bash-other', 'test', 'git-write', 'wait', 'edit-small', 'edit-large', 'orchestrate', 'mcp', 'meta', 'text']);
// The ladder, cheapest to dearest (config/model-tiers.json `ladder`; a test pins this list to it).
export const RUNG_ORDER = Object.freeze(['haiku', 'sonnet/low', 'sonnet/medium', 'sonnet/high', 'sonnet/xhigh', 'opus/low', 'opus/medium', 'opus/high', 'opus/xhigh', 'opus/max']);
const rungRank = (rung) => { const i = RUNG_ORDER.indexOf(String(rung || '')); return i < 0 ? null : i; };
const READ_ONLY_TYPES = Object.freeze(['explore', 'lookup', 'survey', 'research', 'verify', 'code-review']);
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);
const spawnsOf = (recs) => recs.filter((r) => r.kind === 'spawn');
const unitsOf = (s) => (s.units ? s.units.total : 0);
const noSpawns = { gap: true, why: 'no spawn records for the cohort (the facts spawn records feed them)' };
const sorted = (map) => { const o = {}; for (const k of Object.keys(map).sort()) o[k] = map[k]; return o; };
const table = (map) => { const o = {}; for (const k of Object.keys(map).sort()) o[k] = r4(map[k]); return o; };
const biggest = (map) => Object.keys(map).sort((a, b) => map[b] - map[a] || (a < b ? -1 : 1))[0];
const paramsOf = (ctx) => (ctx && ctx.params ? ctx.params : {});

// A ratio over spawns: value = sum(num) / sum(den) * scale; parts per session so a bootstrap can resample sessions.
function ratio(spawns, numOf, denOf, { scale = 1, sampleOf = null, what = 'the denominator is zero', detail = null } = {}) {
  if (!spawns.length) return noSpawns;
  const num = sumBy(spawns, numOf); const den = sumBy(spawns, denOf);
  if (!(den > 0)) return { gap: true, why: what };
  const by = new Map();
  for (const s of spawns) {
    const p = by.get(s.sid) || { id: s.sid, num: 0, den: 0 };
    p.num += numOf(s); p.den += denOf(s); by.set(s.sid, p);
  }
  return {
    num, den, scale, sample: sampleOf ? sumBy(spawns, sampleOf) : den,
    parts: [...by.values()].filter((p) => p.den > 0),
    ...(detail ? { detail: detail(spawns) } : {}),
  };
}
const count = () => 1;
const needsFacts = () => ({ gap: true, why: 'reads the facts spawn records, not the history record' });

// Units of requests in one category, summed over spawns
const catUnits = (s, c) => (s.catUnits && s.catUnits[c]) || 0;
const catReq = (s, c) => (s.catReq && s.catReq[c]) || 0;
const reqOf = (s) => (finite(s.requests) !== null ? s.requests : 0);

// share of spawns (percent) by a key; params[param] picks the key, else the largest
function shareByKey(spawns, keyOf, wanted, extra = () => ({})) {
  if (!spawns.length) return noSpawns;
  const n = {}; const units = {};
  for (const s of spawns) { const k = keyOf(s); n[k] = (n[k] || 0) + 1; units[k] = (units[k] || 0) + unitsOf(s); }
  const key = wanted || biggest(n);
  return { num: n[key] || 0, den: spawns.length, scale: 100, sample: spawns.length, detail: { key, spawns: sorted(n), units: table(units), ...extra(spawns) } };
}

// Escalations: a spawn whose session already spawned the same task (rk description, name stem or brief head) within the
// window at a LOWER rung. Unknown rungs are never counted.
function escalationFlags(spawns, windowMs) {
  const flagged = new Set();
  const bySid = new Map();
  for (const s of spawns) { if (!bySid.has(s.sid)) bySid.set(s.sid, []); bySid.get(s.sid).push(s); }
  for (const list of bySid.values()) {
    list.sort((a, b) => (a.startMs || 0) - (b.startMs || 0) || (String(a.id) < String(b.id) ? -1 : 1));
    const last = { d: new Map(), n: new Map(), h: new Map() };
    for (const s of list) {
      if (!Number.isFinite(s.startMs)) continue;
      const rank = rungRank(s.rung);
      const rk = s.rk || {};
      let up = false;
      for (const k of ['d', 'n', 'h']) {
        if (rk[k] == null) continue;
        const prev = last[k].get(rk[k]);
        if (prev && s.startMs - prev.t <= windowMs && rank !== null && prev.rank !== null && rank > prev.rank) up = true;
        last[k].set(rk[k], { t: s.startMs, rank });
      }
      if (up) flagged.add(s);
    }
  }
  return flagged;
}

// median and 90th percentile of a number list (nearest rank)
function quantile(values, q) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

// Two groups? The largest gap between sorted request counts, when it is at least as large as the median and both sides hold
// at least two spawns. E: a plain gap rule, not a mixture fit.
function splitsInTwo(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length < 4) return { split: false };
  let best = 0; let at = -1;
  for (let i = 1; i < v.length; i += 1) if (v[i] - v[i - 1] > best) { best = v[i] - v[i - 1]; at = i; }
  const med = quantile(v, 0.5);
  if (at < 2 || v.length - at < 2 || !(best >= med)) return { split: false };
  return { split: true, lowerMax: v[at - 1], upperMin: v[at], lowerSpawns: at, upperSpawns: v.length - at };
}

const haikuTypesOf = (p) => new Set((typeof p.haikuTypes === 'string' ? p.haikuTypes : 'lookup,explore,verify').split(',').map((x) => x.trim()).filter(Boolean));

// ------------------------------------------------------------------ the metrics --

export const WORKER_METRICS = [
  {
    // Units per spawn by rung, within one request-count bucket, so rungs are compared like for like. Group by rung.
    id: 'spawn.rungLadder', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { bucket: '6-15' } },
    day: needsFacts,
    stat(recs, ctx) {
      const bucket = typeof paramsOf(ctx).bucket === 'string' ? paramsOf(ctx).bucket : '6-15';
      const sp = spawnsOf(recs).filter((s) => s.bucket === bucket);
      if (!sp.length) return { gap: true, why: `no spawns in the ${bucket} request bucket` };
      return ratio(sp, unitsOf, count, {
        detail: (all) => {
          const by = {};
          for (const s of all) { const k = s.rung || '(unknown)'; const b = (by[k] ||= { spawns: 0, units: 0 }); b.spawns += 1; b.units += unitsOf(s); }
          const out = {};
          for (const k of Object.keys(by).sort()) out[k] = { spawns: by[k].spawns, unitsPerSpawn: r4(by[k].units / by[k].spawns) };
          return { bucket, byRung: out };
        },
      });
    },
  },
  {
    // Like for like for the Haiku trial: one task type and one request bucket, grouped by rung.
    id: 'haiku.likeForLike', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { type: 'explore', bucket: '6-15' } },
    day: needsFacts,
    stat(recs, ctx) {
      const type = typeof paramsOf(ctx).type === 'string' ? paramsOf(ctx).type : 'explore';
      const bucket = typeof paramsOf(ctx).bucket === 'string' ? paramsOf(ctx).bucket : '6-15';
      const sp = spawnsOf(recs).filter((s) => s.declaredType === type && s.bucket === bucket);
      if (!sp.length) return { gap: true, why: `no ${type} spawns in the ${bucket} request bucket` };
      return ratio(sp, unitsOf, count, {
        detail: (all) => {
          const by = {};
          for (const s of all) { const k = s.rung || '(unknown)'; const b = (by[k] ||= { spawns: 0, units: 0 }); b.spawns += 1; b.units += unitsOf(s); }
          const out = {};
          for (const k of Object.keys(by).sort()) out[k] = { spawns: by[k].spawns, unitsPerSpawn: r4(by[k].units / by[k].spawns) };
          return { type, bucket, byRung: out };
        },
      });
    },
  },
  {
    id: 'spawn.startupUnits', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat: (recs) => ratio(spawnsOf(recs).filter((s) => finite(s.startupUnits) !== null), (s) => s.startupUnits, count, {
      what: 'no spawn has a first request', detail: (all) => ({ spawns: all.length, startupUnits: r4(sumBy(all, (s) => s.startupUnits)), spawnUnits: r4(sumBy(all, unitsOf)) }),
    }),
  },
  {
    // The share of requests in one category (params.category), else the largest; detail has requests and units by category.
    id: 'spawn.categoryMix', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of requests', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { category: null } },
    day: needsFacts,
    stat(recs, ctx) {
      const sp = spawnsOf(recs);
      if (!sp.length) return noSpawns;
      const req = {}; const units = {};
      for (const c of CATEGORIES) { req[c] = sumBy(sp, (s) => catReq(s, c)); units[c] = sumBy(sp, (s) => catUnits(s, c)); }
      const total = sumBy(Object.values(req), (x) => x);
      if (!(total > 0)) return { gap: true, why: 'the spawns hold no categorised requests' };
      const want = paramsOf(ctx).category;
      const key = typeof want === 'string' && CATEGORIES.includes(want) ? want : biggest(req);
      return { num: req[key], den: total, scale: 100, sample: sp.length, detail: { key, requests: table(req), units: table(units), totalRequests: total } };
    },
  },
  {
    // A wait is a pure re-read: the units of the requests in the wait category as a share of the spawns' units.
    id: 'spawn.pollWaste', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of spawn units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat: (recs) => ratio(spawnsOf(recs), (s) => catUnits(s, 'wait'), unitsOf, {
      scale: 100, sampleOf: count, what: 'the spawns have no units',
      detail: (all) => ({ waitRequests: sumBy(all, (s) => catReq(s, 'wait')), waitUnits: r4(sumBy(all, (s) => catUnits(s, 'wait'))), spawnUnits: r4(sumBy(all, unitsOf)) }),
    }),
  },
  {
    // Test requests in spawns whose context reached 100K, as a share of all test units. E: the facts hold the category and
    // the context bucket of a spawn separately, so a spawn that peaked late counts all its test requests.
    id: 'spawn.gateAt100k', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of test units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const sp = spawnsOf(recs);
      const late = sp.filter((s) => (finite(s.peakCtx) || 0) >= 100000);
      return ratio(sp, (s) => ((finite(s.peakCtx) || 0) >= 100000 ? catUnits(s, 'test') : 0), (s) => catUnits(s, 'test'), {
        scale: 100, sampleOf: count, what: 'the spawns ran no test requests',
        detail: (all) => ({ testUnits: r4(sumBy(all, (s) => catUnits(s, 'test'))), testRequestsInLateSpawns: sumBy(late, (s) => catReq(s, 'test')), lateSpawns: late.length }),
      });
    },
  },
  {
    // The share of spawns with a given STATUS word (params.status, default done) among those that reported one. Group by rung.
    id: 'spawn.outcomeByRung', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of reported spawns', direction: 'down-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { status: 'done' } },
    day: needsFacts,
    stat(recs, ctx) {
      const want = ['done', 'blocked', 'partial'].includes(paramsOf(ctx).status) ? paramsOf(ctx).status : 'done';
      const sp = spawnsOf(recs).filter((s) => s.status === 'done' || s.status === 'blocked' || s.status === 'partial');
      if (!sp.length) return { gap: true, why: 'no spawn reported a STATUS word' };
      const n = { done: 0, blocked: 0, partial: 0 };
      for (const s of sp) n[s.status] += 1;
      return {
        num: n[want], den: sp.length, scale: 100, sample: sp.length,
        parts: [...sp.reduce((m, s) => { const p = m.get(s.sid) || { id: s.sid, num: 0, den: 0 }; p.den += 1; if (s.status === want) p.num += 1; return m.set(s.sid, p); }, new Map()).values()],
        detail: { status: want, counts: n, withoutStatus: spawnsOf(recs).length - sp.length },
      };
    },
  },
  {
    // A re-spawn at a higher rung within params.respawnHours (6) of the same task in the same session. E: the match is by
    // description hash, name stem or brief head (see lead.rework), and the rung order is the ladder.
    id: 'spawn.escalations', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'per 100 spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { respawnHours: 6 } },
    day: needsFacts,
    stat(recs, ctx) {
      const h = finite(paramsOf(ctx).respawnHours) !== null && paramsOf(ctx).respawnHours > 0 ? paramsOf(ctx).respawnHours : 6;
      const sp = spawnsOf(recs);
      if (!sp.length) return noSpawns;
      const up = escalationFlags(sp, h * 3600 * 1000);
      return { num: up.size, den: sp.length, scale: 100, sample: sp.length, detail: { escalations: up.size, spawns: sp.length } };
    },
  },
  {
    // Turns added to a worker after it reported (SendMessage), per 100 spawns. Units of those turns are not separable in the facts.
    id: 'spawn.extraTurns', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'turns per 100 spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat: (recs) => ratio(spawnsOf(recs), (s) => finite(s.extraTurns) || 0, count, {
      scale: 100, detail: (all) => ({ extraTurns: sumBy(all, (s) => finite(s.extraTurns) || 0), continuedSpawns: all.filter((s) => (finite(s.extraTurns) || 0) > 0).length }),
    }),
  },
  {
    id: 'spawn.typeMix', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { type: null } },
    day: needsFacts,
    stat: (recs, ctx) => shareByKey(spawnsOf(recs), (s) => s.declaredType || '(untyped)', typeof paramsOf(ctx).type === 'string' ? paramsOf(ctx).type : null),
  },
  {
    id: 'spawn.fitOverShare', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of scored spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const sp = spawnsOf(recs).filter((s) => s.fit === 'over' || s.fit === 'fit' || s.fit === 'under');
      return ratio(sp, (s) => (s.fit === 'over' ? 1 : 0), count, { scale: 100, what: 'no spawn was scored for fit', detail: (all) => ({ over: all.filter((s) => s.fit === 'over').length, under: all.filter((s) => s.fit === 'under').length, fit: all.filter((s) => s.fit === 'fit').length }) });
    },
  },
  {
    id: 'spawn.untypedShare', source: 'facts', register: false, entity: 'day', label: 'M', unit: '% of spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat: (recs) => ratio(spawnsOf(recs), (s) => (s.declaredType ? 0 : 1), count, { scale: 100 }),
  },
  {
    // Request counts of explore spawns (params.type): the mean is the value; the median, the 90th percentile and whether the
    // counts fall into two groups ride on detail. E: the two-group rule is a gap rule, not a mixture fit.
    id: 'spawn.exploreShape', source: 'facts', register: false, entity: 'day', label: 'E', unit: 'requests/spawn', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { type: 'explore' } },
    day: needsFacts,
    stat(recs, ctx) {
      const type = typeof paramsOf(ctx).type === 'string' ? paramsOf(ctx).type : 'explore';
      const sp = spawnsOf(recs).filter((s) => s.declaredType === type && reqOf(s) > 0);
      return ratio(sp, reqOf, count, {
        what: `no ${type} spawns`,
        detail: (all) => { const v = all.map(reqOf); return { type, median: quantile(v, 0.5), p90: quantile(v, 0.9), twoGroups: splitsInTwo(v) }; },
      });
    },
  },
  {
    id: 'spawn.respawnRate', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { respawnHours: 6 } },
    day: needsFacts,
    stat(recs, ctx) {
      const h = finite(paramsOf(ctx).respawnHours) !== null && paramsOf(ctx).respawnHours > 0 ? paramsOf(ctx).respawnHours : 6;
      const sp = spawnsOf(recs);
      if (!sp.length) return noSpawns;
      const re = respawnFlags(sp, h * 3600 * 1000);
      return { num: re.size, den: sp.length, scale: 100, sample: sp.length, detail: { respawns: re.size, spawns: sp.length, respawnUnits: r4(sumBy([...re], unitsOf)) } };
    },
  },
  {
    // Output tokens per request. Group by model to compare verbosity.
    id: 'spawn.outputPerRequest', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'output tokens/request', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat: (recs) => ratio(spawnsOf(recs).filter((s) => finite(s.outTok) !== null), (s) => s.outTok, reqOf, { what: 'the spawns made no requests', sampleOf: reqOf }),
  },
  {
    // The share of spawns that named a model other than the one the agent definition pins. Reads the telemetry rows' pin flag.
    id: 'spawn.pinDeparture', source: 'spawns', register: false, entity: 'day', label: 'M', unit: '% of spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S'], recordKinds: ['srow'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const rows = recs.filter((r) => r.kind === 'srow').map((r) => r.row);
      if (!rows.length) return { gap: true, why: 'no spawn telemetry rows for the cohort (telemetry/spawns.jsonl)' };
      // the guard logs one boolean per pinned spawn under a key that starts with pin_model_
      const flagged = (r) => Object.keys(r).some((k) => k.startsWith('pin_model_') && r[k] === true);
      const n = rows.filter(flagged).length;
      return { num: n, den: rows.length, scale: 100, sample: rows.length, detail: { departures: n, spawns: rows.length } };
    },
  },
  {
    // Runs of 4 or more simple steps (each with output of 500 tokens or less) and the modelled saving if they ran one rung
    // cheaper. E: params.savingFraction (0.5) is an assumption, not a measurement. The value is the runs' share of spawn units.
    id: 'spawn.simpleRuns', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of spawn units', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { savingFraction: 0.5 } },
    day: needsFacts,
    stat(recs, ctx) {
      const f = finite(paramsOf(ctx).savingFraction) !== null ? paramsOf(ctx).savingFraction : 0.5;
      return ratio(spawnsOf(recs), (s) => (s.simple ? s.simple.units : 0), unitsOf, {
        scale: 100, sampleOf: count, what: 'the spawns have no units',
        detail: (all) => {
          const u = sumBy(all, (s) => (s.simple ? s.simple.units : 0));
          return { runs: sumBy(all, (s) => (s.simple ? s.simple.runs : 0)), requests: sumBy(all, (s) => (s.simple ? s.simple.req : 0)), units: r4(u), savingFraction: f, modelledSavingUnits: r4(u * f) };
        },
      });
    },
  },
  {
    // FIX share of reviewer verdicts (FIX or BLOCK against PASS), from the telemetry rows. Detail: by reviewer model.
    id: 'review.fixShare', source: 'spawns', register: false, entity: 'day', label: 'M', unit: '% of verdicts', direction: 'up-is-worse', pool: 'ratio',
    needs: ['S', 'RV'], recordKinds: ['srow'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const rows = recs.filter((r) => r.kind === 'srow' && r.declaredType === 'code-review').map((r) => r.row);
      const verdict = (r) => { const v = typeof r.review_verdict === 'string' ? r.review_verdict.toUpperCase() : ''; return /\b(FIX|BLOCK)/.test(v) ? 'fix' : /\bPASS/.test(v) ? 'pass' : null; };
      const scored = rows.filter((r) => verdict(r) !== null);
      if (!scored.length) return { gap: true, why: rows.length ? 'no reviewer row has a verdict (telemetry/review-verdicts.jsonl)' : 'no reviewer rows for the cohort' };
      const by = {};
      for (const r of scored) { const k = nonEmpty(r.model) || '(unknown)'; const b = (by[k] ||= { fix: 0, n: 0 }); b.n += 1; if (verdict(r) === 'fix') b.fix += 1; }
      const fix = scored.filter((r) => verdict(r) === 'fix').length;
      return { num: fix, den: scored.length, scale: 100, sample: scored.length, detail: { byReviewerModel: sorted(by), withoutVerdict: rows.length - scored.length } };
    },
  },
  {
    // Reviewer cost: units per reviewer spawn, from the facts spawn records of type code-review.
    id: 'review.size', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/review', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { type: 'code-review' } },
    day: needsFacts,
    stat(recs, ctx) {
      const type = typeof paramsOf(ctx).type === 'string' ? paramsOf(ctx).type : 'code-review';
      const sp = spawnsOf(recs).filter((s) => s.declaredType === type);
      return ratio(sp, unitsOf, count, { what: `no ${type} spawns`, detail: (all) => ({ reviews: all.length, requests: sumBy(all, reqOf), units: r4(sumBy(all, unitsOf)) }) });
    },
  },
  {
    // Read-only task types (params.types, default the read-only set) that made edit or git-write requests, as a share of
    // those spawns: the declared type against what the spawn did. E: the expectation table is fixed here, not learned.
    id: 'spawn.declaredVsActual', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of read-only spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { types: READ_ONLY_TYPES.join(',') } },
    day: needsFacts,
    stat(recs, ctx) {
      const types = new Set((typeof paramsOf(ctx).types === 'string' ? paramsOf(ctx).types : READ_ONLY_TYPES.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
      const sp = spawnsOf(recs).filter((s) => types.has(s.declaredType));
      const writes = (s) => catReq(s, 'edit-small') + catReq(s, 'edit-large') + catReq(s, 'git-write');
      return ratio(sp, (s) => (writes(s) > 0 ? 1 : 0), count, {
        scale: 100, what: 'no spawn of a read-only type',
        detail: (all) => {
          const by = {};
          for (const s of all) { const b = (by[s.declaredType] ||= { spawns: 0, writing: 0 }); b.spawns += 1; if (writes(s) > 0) b.writing += 1; }
          return { byType: sorted(by) };
        },
      });
    },
  },
  {
    // Struggle flags against outcomes: of the sessions the detector flagged, the share that had a worker end blocked or
    // partial, or re-spawn one (precision); detail has the recall (the share of such sessions that were flagged). E.
    id: 'snag.precisionRecall', source: 'spawns', register: false, entity: 'day', label: 'E', unit: '% of flagged sessions', direction: 'down-is-worse', pool: 'ratio',
    needs: ['ST', 'F.spawn'], recordKinds: ['struggle', 'spawn'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const flaggedSids = new Set(recs.filter((r) => r.kind === 'struggle' && r.flagged).map((r) => r.sid));
      const seen = recs.filter((r) => r.kind === 'struggle');
      const sp = spawnsOf(recs);
      if (!seen.length) return { gap: true, why: 'no struggle rows for the cohort (telemetry/struggle.jsonl)' };
      if (!sp.length) return { gap: true, why: 'no spawn records to judge outcomes against' };
      const re = respawnFlags(sp);
      const bad = new Set(sp.filter((s) => s.status === 'blocked' || s.status === 'partial' || re.has(s)).map((s) => s.sid));
      const hits = [...flaggedSids].filter((s) => bad.has(s)).length;
      if (!flaggedSids.size) return { gap: true, why: 'the detector flagged no session today' };
      return {
        num: hits, den: flaggedSids.size, scale: 100, sample: flaggedSids.size,
        detail: { flaggedSessions: flaggedSids.size, flaggedWithBadOutcome: hits, sessionsWithBadOutcome: bad.size, recallPct: bad.size ? r4((hits / bad.size) * 100) : null },
      };
    },
  },
  {
    // Spawn units on the Haiku family; the value is the units, the sample the day's spawn count; detail has the spawn count.
    id: 'haiku.spawnsUnits', source: 'facts', register: false, entity: 'day', label: 'M', unit: 'units/day', direction: 'up-is-worse', pool: 'sum',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const sp = spawnsOf(recs);
      if (!sp.length) return noSpawns;
      const h = sp.filter((s) => familyOf(s.model) === 'haiku');
      return { num: sumBy(h, unitsOf), den: 1, scale: 1, sample: sp.length, detail: { haikuSpawns: h.length, spawns: sp.length } };
    },
  },
  {
    // Spawns of the Haiku-default types (params.haikuTypes) that ran on another family, as a share of those spawns. E: the
    // default list tracks the trial.
    id: 'haiku.complianceLeak', source: 'facts', register: false, entity: 'day', label: 'E', unit: '% of haiku-default spawns', direction: 'up-is-worse', pool: 'ratio',
    needs: ['F.spawn'], recordKinds: ['spawn'], params: { defaults: { haikuTypes: 'lookup,explore,verify' } },
    day: needsFacts,
    stat(recs, ctx) {
      const types = haikuTypesOf(paramsOf(ctx));
      const sp = spawnsOf(recs).filter((s) => types.has(s.declaredType) && s.model);
      return ratio(sp, (s) => (familyOf(s.model) === 'haiku' ? 0 : 1), count, {
        scale: 100, what: 'no spawn of a Haiku-default type',
        detail: (all) => { const by = {}; for (const s of all) { const k = s.rung || '(unknown)'; by[k] = (by[k] || 0) + 1; } return { types: [...types].sort(), byRung: sorted(by) }; },
      });
    },
  },
  {
    // First sightings of a guard version (a plugin release reaching the spawn guard) in the day's telemetry rows.
    // Only the spawn guard's own version is observable; the installed copy is not read.
    id: 'plugin.versionEvents', source: 'spawns', register: false, entity: 'day', label: 'M', unit: 'new versions', direction: 'up-is-worse', pool: 'sum',
    needs: ['S'], recordKinds: ['srow'], params: { defaults: {} },
    day: needsFacts,
    stat(recs) {
      const rows = recs.filter((r) => r.kind === 'srow');
      if (!rows.length) return { gap: true, why: 'no spawn telemetry rows for the cohort (telemetry/spawns.jsonl)' };
      const versioned = rows.filter((r) => nonEmpty(r.row.guard_version));
      if (!versioned.length) return { gap: true, why: 'unobservable: the telemetry rows carry no guard_version' };
      const fresh = versioned.filter((r) => r.firstSeenVersion).map((r) => r.row.guard_version);
      const seen = [...new Set(versioned.map((r) => r.row.guard_version))].sort();
      return { num: fresh.length, den: 1, scale: 1, sample: rows.length, detail: { firstSeen: [...new Set(fresh)].sort(), versionsToday: seen } };
    },
  },
];

// ----------------------------------------------------- adapters of register metrics --

function unitsPerSpawnStat(recs, ctx) {
  const p = paramsOf(ctx);
  let sp = spawnsOf(recs);
  if (nonEmpty(p.type)) sp = sp.filter((s) => s.declaredType === p.type);
  if (nonEmpty(p.rung)) sp = sp.filter((s) => s.rung === p.rung);
  return ratio(sp, unitsOf, count, { what: 'no spawns match' });
}

// The registry's telemetry-backed register metrics keep their day(p, rec, rows, x); the adapter gives them the day's rows.
function telemetryAdapter(metric) {
  return (recs, ctx) => {
    // a scenario parameter is a number, boolean or short string: levels is a comma-separated list there
    const raw = paramsOf(ctx);
    const levels = Array.isArray(raw.levels) ? raw.levels : typeof raw.levels === 'string' ? raw.levels.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const p = { ...raw, levels };
    if ((metric.byLeadLevels || metric.id === 'leadEffortShare') && !levels.length) return { gap: true, why: `${metric.id} needs params.levels (the lead efforts counted, e.g. "high,xhigh")` };
    if (metric.id === 'reviewsPerWriter' && !nonEmpty(p.writerType)) return { gap: true, why: 'reviewsPerWriter needs params.writerType' };
    const rows = recs.filter((r) => r.kind === 'srow').map((r) => r.row);
    if (!rows.length) return { gap: true, why: 'no spawn telemetry rows for the cohort (telemetry/spawns.jsonl)' };
    const denials = recs.filter((r) => r.kind === 'denial').map((r) => r.row);
    let idx = null;
    const x = { idx: () => idx || (idx = buildLeadIndex(rows)), denials };
    const r = metric.day(p, null, rows, x);
    if (!r || r.gap) return r || { gap: true, why: 'no value' };
    return { ...r, ...(metric.id === 'haikuSpawns' ? { detail: { rows: rows.length } } : {}) };
  };
}

export const REGISTER_ADAPTERS = {
  unitsPerSpawn: { recordKinds: ['spawn'], stat: unitsPerSpawnStat },
  shareOver150kPct: {
    recordKinds: ['spawn'],
    stat: (recs) => ratio(spawnsOf(recs), (s) => ((s.ctxUnits && (s.ctxUnits[2] + s.ctxUnits[3])) || 0), (s) => sumBy(s.ctxUnits || [], (x) => x), {
      scale: 100, sampleOf: count, what: 'the spawns have no context-bucketed units',
      detail: (all) => ({ spawns: all.length, unitsOver150k: r4(sumBy(all, (s) => (s.ctxUnits ? s.ctxUnits[2] + s.ctxUnits[3] : 0))) }),
    }),
  },
  compactionsPer100Spawns: {
    recordKinds: ['spawn'],
    stat: (recs) => ratio(spawnsOf(recs), (s) => (s.comp ? s.comp.n : 0), count, {
      scale: 100, detail: (all) => ({ compactions: sumBy(all, (s) => (s.comp ? s.comp.n : 0)), unitsAfterFirstCompaction: r4(sumBy(all, (s) => (s.comp && s.comp.afterUnits) || 0)), spawns: all.length }),
    }),
  },
  ceilingNudgesPerDay: {
    recordKinds: ['day'],
    stat(recs) {
      const d = recs.find((r) => r.kind === 'day');
      const h = d && d.hist ? d.hist : null;
      if (!h || finite(h.ceilingNudges) === null) return { gap: true, why: 'no checkup history record with ceiling nudges for the day' };
      if (h.limit && finite(h.limit.hits) > 0) return { gap: true, why: 'a limit-hit day is a gap for a per-day total' };
      return { num: h.ceilingNudges, den: 1, scale: 1, sample: Math.max(1, finite(d.spawns) || 0) };
    },
  },
};
for (const id of ['leadEffortShare', 'reviewsPerWriter', 'haikuSpawns', 'leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare']) {
  REGISTER_ADAPTERS[id] = { recordKinds: id === 'leadRoutingDeniesPer100Spawns' ? ['srow', 'denial'] : ['srow'], telemetry: true };
}
// Scenario parameters a register metric accepts through the runner (a scenario may only set declared ones).
const LEVELS = { levels: '' };
REGISTER_ADAPTERS.unitsPerSpawn.params = { type: '', rung: '' };
REGISTER_ADAPTERS.reviewsPerWriter.params = { writerType: '' };
for (const id of ['leadEffortShare', 'leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare']) REGISTER_ADAPTERS[id].params = LEVELS;
export { telemetryAdapter, isLeadRow };
