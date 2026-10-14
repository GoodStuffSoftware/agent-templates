// Batch 4 of the daily usage analysis (0.31.18): cohort filter, exclusions, comparisons, event
// resolution, thresholds with Wilson and seeded-bootstrap intervals, groupBy.
// Synthetic facts in a temp root; nothing reads the operator's data and nothing calls a model.
import { makeFixture } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  dayKeyOfMs, dayStartMs, dayEndMs, addDays, weekdayOf, dayRange, daysOverlapping, floorHour, isDayKey, DAY_MS, HOUR_MS,
} from '../scripts/lib/usage/days.mjs';
import {
  wilson, hashSeed, seedFor, mulberry32, bootstrapDiff, poolParts, quantileSorted, median, p90,
} from '../scripts/lib/usage/stats.mjs';
import {
  resolveEvent, resolveWindow, parseIso, scenarioDigest, diffConfigDigests, configChangeMs, makeGitTagTime, loadEventSources, CONFIG_JOURNAL_FILE,
} from '../scripts/lib/usage/events.mjs';
import {
  readFactsDay, sessionRecords, makeFactsLoader, applyCohort, applyExclusions, excludedShare, matchField, COUNTS_EVERYTHING, SPAWN_HOOK,
} from '../scripts/lib/usage/cohort.mjs';
import {
  makeProvider, poolSlots, judge, compareOne, evaluateScenario, UNKNOWN_GROUP,
} from '../scripts/lib/usage/compare.mjs';
import { loadConfig } from '../scripts/lib/usage/config.mjs';

// ---------------------------------------------------------------- fixtures --

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const FABLE = 'claude-fable-5';
const tok = (u) => [u, 0, 0, 0, 0, 1]; // u plan units of plain input: units === u under SPEC
const zero = () => [0, 0, 0, 0, 0, 0];

function row(hourIso, sid, units, { proj = 'alpha', sub = 0, model = SONNET, corr = 0, prompts = 1 } = {}) {
  return {
    hour: hourIso, sid, proj, cwd: null,
    tok: { [model]: { m: tok(units), s: sub ? tok(sub) : zero() } },
    pr: { n: prompts, len: [prompts, 0, 0, 0], corr }, ag: 0, sm: 0, gc: 0,
  };
}

function writeFacts(root, day, rows, models = [SONNET, FABLE]) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  const weightsUsed = {}; for (const m of models) weightsUsed[m] = { ...SPEC };
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 1, day,
    from: `${day}T08:00:00.000Z`, to: `${addDays(day, 1)}T08:00:00.000Z`, dataThrough: null,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${addDays(day, 1)}T09:00:00.000Z`, weightsUsed, rows,
  }));
}

// n sessions on `day`, each `avg` units, hour 10:00Z (inside the day). null avg: no file (a gap).
function seedSeries(root, from, to, fn, { n = 3, proj = 'alpha' } = {}) {
  for (const day of dayRange(from, to)) {
    const avg = fn(day);
    if (avg === null || avg === undefined) continue;
    writeFacts(root, day, Array.from({ length: n }, (_, i) => row(`${day}T10:00:00.000Z`, `s-${day}-${i}`, avg, { proj })));
  }
}

// The metric under test: units per session, with one part per session.
const unitsPerSession = {
  id: 'test.unitsPerSession', pool: 'ratio', direction: 'up-is-worse', label: 'M',
  stat(recs) {
    return { num: recs.reduce((s, r) => s + r.units.total, 0), den: recs.length, scale: 1, sample: recs.length, parts: recs.map((r) => ({ id: r.sid, num: r.units.total, den: 1 })) };
  },
};
// A proportion: the share of sessions with a correction flag, in percent.
const corrShare = {
  id: 'test.corrShare', pool: 'ratio', direction: 'up-is-worse', label: 'M',
  stat(recs) { return { num: recs.filter((r) => r.pr.corr > 0).length, den: recs.length, scale: 100, sample: recs.length }; },
};

const THR = { direction: 'up-is-worse', relPct: 10, abs: 1, minSample: 1, minDays: 1 };
const scen = (id, def, metric = 'test.unitsPerSession') => ({ id, metric, state: 'enabled', def: { threshold: THR, ...def } });
const RES = (extra = {}) => ({ environment: { day: { boundaryUtcHour: 8 } }, windows: {}, exclusions: {}, ...extra });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

function evalOn(root, scenario, day, { resolved = RES(), metric = unitsPerSession, sources = {}, hooks = {} } = {}) {
  return evaluateScenario({ scenario, resolved, day, loadDay: makeFactsLoader({ root, hooks }), metric, sources });
}

// A fingerprint of every file under `dir`: path, size and mtime.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name); const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}|${st.size}|${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

// ------------------------------------------------------------------ days --

test('days: a day is 24 hours from the boundary, keys and weekdays are calendar dates', () => {
  assert.equal(dayStartMs('2026-10-08'), Date.parse('2026-10-08T08:00:00Z'));
  assert.equal(dayEndMs('2026-10-08') - dayStartMs('2026-10-08'), DAY_MS);
  assert.equal(dayKeyOfMs(Date.parse('2026-10-08T07:59:59Z')), '2026-10-07');
  assert.equal(dayKeyOfMs(Date.parse('2026-10-08T08:00:00Z')), '2026-10-08');
  assert.equal(dayKeyOfMs(Date.parse('2026-10-08T03:00:00Z'), 0), '2026-10-08');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-10-13'), 'Tue');
  assert.deepEqual(dayRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(daysOverlapping(Date.parse('2026-10-08T12:00Z'), Date.parse('2026-10-09T09:00Z')), ['2026-10-08', '2026-10-09']);
  assert.deepEqual(daysOverlapping(Date.parse('2026-10-08T08:00Z'), Date.parse('2026-10-09T08:00Z')), ['2026-10-08']);
  assert.equal(floorHour(Date.parse('2026-10-08T12:34:56Z')), Date.parse('2026-10-08T12:00:00Z'));
  assert.equal(isDayKey('2026-02-30'), false);
  assert.throws(() => addDays('nope', 1));
});

// ----------------------------------------------------------------- stats --

test('stats: Wilson intervals match the textbook values', () => {
  const a = wilson(5, 10); near(a.lo, 0.2366, 5e-4); near(a.hi, 0.7634, 5e-4);
  const z = wilson(0, 10); assert.equal(z.lo, 0); near(z.hi, 0.2775, 5e-4);
  const f = wilson(10, 10); near(f.lo, 0.7225, 5e-4); near(f.hi, 1);
  assert.equal(wilson(1, 0), null);
  assert.equal(wilson(3, 2), null);
  assert.equal(wilson(-1, 5), null);
});

test('stats: quantiles, medians and pools', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantileSorted([], 0.5), null);
  near(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9.1);
  const parts = [{ num: 2, den: 1 }, { num: 6, den: 3 }, { num: 10, den: 1 }];
  near(poolParts(parts, 'ratio', 1), 18 / 5);
  near(poolParts(parts, 'ratio', 100), 360);
  assert.equal(poolParts(parts, 'median', 1), 2);
  assert.equal(poolParts([], 'ratio'), null);
  assert.equal(poolParts([{ num: 1, den: 0 }], 'ratio'), null);
});

test('stats: the bootstrap is deterministic, and the seed is fixed by day and scenario id', () => {
  assert.equal(hashSeed('x'), hashSeed('x'));
  assert.notEqual(seedFor('2026-10-08', 'a'), seedFor('2026-10-09', 'a'));
  assert.notEqual(seedFor('2026-10-08', 'a'), seedFor('2026-10-08', 'b'));
  assert.equal(seedFor('2026-10-08', 'lead.unitsPerPrompt'), seedFor('2026-10-08', 'lead.unitsPerPrompt'));
  const g1 = mulberry32(42); const g2 = mulberry32(42);
  const s1 = [g1(), g1(), g1()]; const s2 = [g2(), g2(), g2()];
  assert.deepEqual(s1, s2);
  assert.ok(s1.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(s1, [mulberry32(43)(), 0, 0]);
  const cur = [8, 9, 10, 11, 12, 30].map((v, i) => ({ id: `c${i}`, num: v, den: 1 }));
  const base = [5, 6, 7, 8, 9, 10].map((v, i) => ({ id: `b${i}`, num: v, den: 1 }));
  const a = bootstrapDiff({ cur, base, seed: seedFor('2026-10-08', 'x') });
  const b = bootstrapDiff({ cur, base, seed: seedFor('2026-10-08', 'x') });
  assert.deepEqual(a, b);
  const c = bootstrapDiff({ cur, base, seed: seedFor('2026-10-09', 'x') });
  assert.notDeepEqual(a, c);
  assert.ok(a.lo < a.hi && a.iterations === 1000 && a.used === 1000);
  assert.equal(bootstrapDiff({ cur: [], base, seed: 1 }), null);
  // a pinned figure: a change of generator or resampling would silently move every verdict
  assert.equal(hashSeed('2026-10-08|lead.unitsPerPrompt'), seedFor('2026-10-08', 'lead.unitsPerPrompt'));
});

// ------------------------------------------------------------ the cohort --

function recs() {
  const tokS = { [SONNET]: { m: tok(10), s: zero() } };
  const mk = (sid, over) => ({ kind: 'session', sid, proj: 'alpha', tok: tokS, pr: { n: 3 }, units: { main: 10, sub: 0, total: 10 }, models: [SONNET], model: SONNET, ...over });
  return [
    mk('sess-aa-1', { class: 'lead', title: 'Fix the login bug', hasDesktopRecord: true }),
    mk('sess-bb-2', { class: 'worker', proj: 'beta', title: 'Design review notes', models: [FABLE], model: FABLE }),
    mk('sess-cc-3', { class: 'lead', title: 'Refactor billing', hasDesktopRecord: false, pr: { n: 1 } }),
    mk('sess-dd-4', { class: 'routine', routineId: 'scout' }),
  ];
}

test('cohort: every field, OR within a list and AND across fields', () => {
  const r = recs();
  const sids = (c) => applyCohort(r, c).kept.map((x) => x.sid);
  assert.deepEqual(sids({ class: ['lead'] }), ['sess-aa-1', 'sess-cc-3']);
  assert.deepEqual(sids({ class: ['lead', 'routine'] }), ['sess-aa-1', 'sess-cc-3', 'sess-dd-4']);
  assert.deepEqual(sids({ class: ['lead'], project: ['beta'] }), []);
  assert.deepEqual(sids({ project: ['beta'] }), ['sess-bb-2']);
  assert.deepEqual(sids({ model: ['claude-fable-*'] }), ['sess-bb-2']);
  assert.deepEqual(sids({ model: ['!claude-fable-*'] }), ['sess-aa-1', 'sess-cc-3', 'sess-dd-4']);
  assert.deepEqual(sids({ modelFamily: ['fable'] }), ['sess-bb-2']);
  assert.deepEqual(sids({ sessionId: ['SESS-AA', 'sess-cc'] }), ['sess-aa-1', 'sess-cc-3']);
  assert.deepEqual(sids({ titleAny: ['login', 'billing'] }), ['sess-aa-1', 'sess-cc-3']);
  assert.deepEqual(sids({ titleAny: ['log'] }), [], 'whole words only');
  assert.deepEqual(sids({ titlePattern: '^refactor' }), ['sess-cc-3']);
  assert.deepEqual(sids({ routineId: ['scout'] }), ['sess-dd-4']);
  assert.deepEqual(sids({}), r.map((x) => x.sid));
  assert.equal(matchField('class', ['lead'], {}), null, 'an absent attribute is unobservable, not false');
});

test('cohort: a record that lacks a field is counted unobservable, never matched', () => {
  const r = recs();
  const c = applyCohort(r, { titleAny: ['login'] });
  assert.deepEqual(c.kept.map((x) => x.sid), ['sess-aa-1']);
  assert.equal(c.unknown.titleAny, 1, 'the routine record has no title');
  assert.equal(c.gap, undefined);
  // a field that is definitively false on a record ends the match before an unobservable one counts
  const d = applyCohort(r, { class: ['lead'], titleAny: ['login'] });
  assert.deepEqual(d.kept.map((x) => x.sid), ['sess-aa-1']);
  assert.equal(d.unknown.titleAny, undefined);
});

test('cohort: a field no record carries is a gap that names its hook (spawn fields: batch 2b)', () => {
  const c = applyCohort(recs(), { rung: ['3'] });
  assert.equal(c.gap, true);
  assert.deepEqual(c.kept, []);
  assert.match(c.why, /"rung" is unobservable/);
  assert.match(c.why, new RegExp(SPAWN_HOOK.replace('.', '\\.')));
  assert.equal(applyCohort([], { rung: ['3'] }).gap, undefined, 'no records at all is an empty day, not a missing hook');
  const d = applyCohort(recs(), { effortObserved: ['xhigh'] });
  assert.match(d.why, /hooks\.sessionAttrs/);
});

// ------------------------------------------------------------ exclusions --

function exclusionFixture() {
  const mkSession = (sid, model, m, s, extra = {}) => ({
    kind: 'session', sid, proj: 'alpha', tok: { [model]: { m: tok(m), s: tok(s) } }, pr: { n: 4, len: [4, 0, 0, 0], corr: 1 }, ag: 2, sm: 1, gc: 1,
    units: { main: m, sub: s, total: m + s }, models: [model], model, ...extra,
  });
  return [
    mkSession('sess-ff-1', FABLE, 100, 50, { title: 'design sprint' }),
    mkSession('sess-a2-2', SONNET, 40, 10, { title: 'ordinary work' }),
    mkSession('sess-b3-3', SONNET, 30, 20, { title: 'bus chatter' }),
    { kind: 'spawn', sid: 'sess-ff-1', model: SONNET, units: { total: 7 } },
    { kind: 'spawn', sid: 'sess-a2-2', model: SONNET, units: { total: 3 } },
  ];
}
const EXCL = {
  'fable-tree': { model: ['claude-fable-*'], scope: 'tree', why: 'design sessions' },
  'bus-main': { titleAny: ['bus'], scope: 'session' },
};

test('exclusions: scope tree removes the session with its workers and its spawn records', () => {
  const r = exclusionFixture();
  const ex = applyExclusions(r, ['fable-tree'], EXCL);
  assert.deepEqual(ex.kept.map((x) => `${x.kind}:${x.sid}`), ['session:sess-a2-2', 'session:sess-b3-3', 'spawn:sess-a2-2']);
  assert.equal(ex.report['fable-tree'].records, 2);
  assert.equal(ex.report['fable-tree'].units, 150 + 7);
  assert.equal(ex.report['fable-tree'].scope, 'tree');
  assert.equal(ex.report['fable-tree'].why, 'design sessions');
});

test('exclusions: scope session removes only the main thread; the workers stay', () => {
  const r = exclusionFixture();
  const ex = applyExclusions(r, ['bus-main'], EXCL);
  const b = ex.kept.find((x) => x.sid === 'sess-b3-3');
  assert.ok(b, 'the session survives with its workers');
  assert.equal(b.units.main, 0);
  assert.equal(b.units.total, 20);
  assert.equal(b.pr.n, 0);
  assert.equal(b.tok[SONNET].s[0], 20);
  assert.equal(b.mainExcluded, true);
  assert.equal(ex.report['bus-main'].units, 30);
  assert.equal(ex.kept.length, 5);
});

test('exclusions: the report never double counts, and kept plus removed is the input', () => {
  const r = exclusionFixture();
  const total = r.reduce((s, x) => s + x.units.total, 0);
  const ex = applyExclusions(r, ['bus-main', 'fable-tree'], EXCL);
  const kept = ex.kept.reduce((s, x) => s + x.units.total, 0);
  const removed = Object.values(ex.report).reduce((s, v) => s + v.units, 0);
  assert.equal(kept + removed, total);
  assert.equal(ex.removed.length, 3);
  // a tree match beats an earlier session match on the same session
  const both = applyExclusions(r, ['bus-main', 'fable-tree'], { ...EXCL, 'f-main': { titleAny: ['design'], scope: 'session' } });
  assert.equal(both.report['fable-tree'].records, 2);
  assert.equal(both.report['bus-main'].records, 1);
});

test('exclusions: an undefined name is reported, an unobservable selector does not exclude', () => {
  const r = exclusionFixture();
  const ex = applyExclusions(r, ['nope', 'stray'], { stray: { rule: 'noDesktopRecordAndPromptsAtMost1' } });
  assert.deepEqual(ex.undefinedRules, ['nope']);
  assert.equal(ex.kept.length, r.length, 'no record carries hasDesktopRecord: nothing is excluded');
  assert.equal(ex.unobservable.stray, 5, 'the three sessions and the two spawn records could not be judged');
  const seen = r.map((x) => (x.kind === 'session' ? { ...x, hasDesktopRecord: x.sid !== 'sess-b3-3', pr: { n: x.sid === 'sess-b3-3' ? 1 : 4 } } : x));
  const ex2 = applyExclusions(seen, ['stray'], { stray: { rule: 'noDesktopRecordAndPromptsAtMost1' } });
  assert.deepEqual(ex2.removed.map((x) => x.rec.sid), ['sess-b3-3']);
});

test('exclusions never reduce day.units: the always-everything metrics ignore excludeSets', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    writeFacts(root, '2026-10-08', [row('2026-10-08T10:00:00.000Z', 'sess-ff-1', 100, { model: FABLE }), row('2026-10-08T11:00:00.000Z', 'sess-a2-2', 40)]);
    const seen = [];
    const metric = { id: 'day.units', pool: 'sum', direction: 'up-is-worse', label: 'M', stat(recs2) { seen.push(recs2.length); return { num: recs2.reduce((s, r) => s + r.units.total, 0), den: 1, scale: 1, sample: recs2.length }; } };
    for (const id of COUNTS_EVERYTHING) assert.ok(['day.units', 'week.pace', 'meter.reconcile', 'day.excludedShare'].includes(id));
    const resolved = RES({ exclusions: { 'fable-tree': { model: ['claude-fable-*'], scope: 'tree' } } });
    const asUnits = scen('day.units', { excludeSets: ['fable-tree'], compare: ['prior-day'] }, 'day.units');
    const r1 = evalOn(root, asUnits, '2026-10-08', { resolved, metric });
    assert.equal(r1.meta.exclusionsIgnored, true);
    assert.deepEqual(seen, [2], 'the metric saw both sessions');
    const prov = makeProvider({ scenario: asUnits, resolved, loadDay: makeFactsLoader({ root }), metric });
    assert.equal(prov.stat('2026-10-08').num, 140, 'day.units counts everything');
    // the same exclusion on a cohort metric does remove the fable session
    const cohortScen = scen('c.cohort', { excludeSets: ['fable-tree'], compare: ['prior-day'] });
    const prov2 = makeProvider({ scenario: cohortScen, resolved, loadDay: makeFactsLoader({ root }), metric: unitsPerSession });
    const s2 = prov2.stat('2026-10-08');
    assert.equal(s2.num, 40);
    assert.equal(s2.meta.excluded['fable-tree'].units, 100);
    // and what an exclusion removed is reported, so it cannot hide spend
    const f = makeFactsLoader({ root })('2026-10-08');
    const share = excludedShare(f.records, ['fable-tree'], resolved.exclusions, 1000);
    assert.equal(share.totalUnits, 140);
    assert.equal(share.removedUnits, 100);
    near(share.rows[0].pctOfWeeklyLimit, 10);
    near(share.pctOfDay, (100 / 140) * 100);
  } finally { fx.cleanup(); }
});

// ----------------------------------------------------------------- facts --

test('facts reading: sessions pool over hours, units recompute with new weights, a missing day is a gap', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    writeFacts(root, '2026-10-08', [
      row('2026-10-08T09:00:00.000Z', 's1', 10, { sub: 5, prompts: 2 }),
      row('2026-10-08T10:00:00.000Z', 's1', 20, { corr: 1 }),
      row('2026-10-08T10:00:00.000Z', 's2', 7, { model: FABLE }),
    ]);
    const f = readFactsDay(root, '2026-10-08');
    const [s1, s2] = sessionRecords(f.facts);
    assert.equal(s1.sid, 's1'); assert.equal(s1.hours, 2);
    assert.deepEqual(s1.units, { main: 30, sub: 5, total: 35 });
    assert.equal(s1.pr.n, 3); assert.equal(s1.pr.corr, 1);
    assert.equal(s2.model, FABLE);
    const heavy = sessionRecords(f.facts, { weights: { [FABLE]: 5 } });
    assert.equal(heavy[1].units.total, 35, 'fable priced at weight 5');
    const only = sessionRecords(f.facts, { range: { fromMs: Date.parse('2026-10-08T10:00:00Z'), toMs: Date.parse('2026-10-08T11:00:00Z') } });
    assert.deepEqual(only.map((x) => [x.sid, x.units.total]), [['s1', 20], ['s2', 7]]);
    const miss = readFactsDay(root, '2026-10-07');
    assert.equal(miss.gap, true); assert.match(miss.why, /no facts for 2026-10-07/);
    writeFileSync(join(root, 'state', 'usage-facts', '2026-10-06.json'), '{ not json');
    assert.match(readFactsDay(root, '2026-10-06').why, /unreadable/);
    writeFileSync(join(root, 'state', 'usage-facts', '2026-10-05.json'), JSON.stringify({ schema: 'agent-companion/usage-facts', factsVersion: 99, rows: [] }));
    assert.match(readFactsDay(root, '2026-10-05').why, /newer than this reader/);
  } finally { fx.cleanup(); }
});

// ----------------------------------------------------------- comparisons --

// 09-10 .. 10-08 at 10 units a session, with the exceptions that matter:
const SERIES = {
  '2026-10-01': 14, '2026-10-04': null, '2026-09-24': 6, '2026-09-10': null, '2026-10-08': 20,
};
const seriesFn = (day) => (day in SERIES ? SERIES[day] : 10);

test('comparisons: prior-day, trailing-7 and same-weekday-4 give the expected figures, and gaps are never zeros', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-09-10', '2026-10-08', seriesFn);
    const r = evalOn(root, scen('t.cmp', { compare: ['prior-day', 'trailing-7', 'same-weekday-4'] }), '2026-10-08');
    const [pd, t7, sw] = r.comparisons;
    assert.equal(pd.compare, 'prior-day');
    near(pd.baseline.value, 10); near(pd.current.value, 20); near(pd.delta, 10); near(pd.relPct, 100);
    assert.equal(pd.status, 'regression');
    // 10-01..10-07: 10-04 has no facts. Six usable days: (14 + 5 * 10) * 3 / 18
    assert.equal(t7.baseline.days.length, 6);
    assert.deepEqual(t7.baseline.gapDays.map((g) => g.day), ['2026-10-04']);
    near(t7.baseline.value, 64 / 6);
    assert.notEqual(Math.round(t7.baseline.value * 1000), Math.round((192 / 21) * 1000), 'the gap day is not a zero in the pool');
    assert.equal(t7.status, 'regression');
    // 10-01 (14), 09-24 (6), 09-17 (10) usable; 09-10 is a gap: not (14+6+10+0)/4
    assert.equal(sw.weekday, 'Thu');
    assert.deepEqual(sw.baseline.days, ['2026-09-17', '2026-09-24', '2026-10-01']);
    near(sw.baseline.value, 10);
    assert.deepEqual(sw.baseline.gapDays.map((g) => g.day), ['2026-09-10']);
    assert.match(sw.baseline.gapDays[0].why, /no facts/);
  } finally { fx.cleanup(); }
});

test('comparisons: fewer than 4 usable trailing days is "insufficient"; a gap prior day is a gap', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    // 10-01..10-03 exist, 10-04 is missing, D = 10-05: three usable trailing days
    seedSeries(root, '2026-10-01', '2026-10-05', (d) => (d === '2026-10-04' ? null : 10));
    const r = evalOn(root, scen('t.insuf', { compare: ['prior-day', 'trailing-7', 'same-weekday-4'] }), '2026-10-05');
    const [pd, t7, sw] = r.comparisons;
    assert.equal(pd.status, 'gap');
    assert.equal(t7.status, 'insufficient');
    assert.equal(t7.have, 3); assert.equal(t7.need, 4);
    assert.equal(t7.current.value, 10, 'the current day is still reported');
    assert.equal(sw.status, 'insufficient');
    assert.equal(r.status, 'no-data');
    // exactly 4 usable days is enough
    writeFacts(root, '2026-10-04', Array.from({ length: 3 }, (_, i) => row('2026-10-04T10:00:00.000Z', `x${i}`, 10)));
    const again = evalOn(root, scen('t.insuf', { compare: ['trailing-7'] }), '2026-10-05');
    assert.equal(again.comparisons[0].baseline.days.length, 4);
    assert.notEqual(again.comparisons[0].status, 'insufficient');
  } finally { fx.cleanup(); }
});

test('comparisons: a day with no value is a gap, not a regression to zero', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-10-01', '2026-10-07', () => 10);
    const r = evalOn(root, scen('t.gapcur', { compare: ['prior-day', 'trailing-7'] }), '2026-10-08');
    for (const c of r.comparisons) { assert.equal(c.status, 'gap'); assert.match(c.why, /the day itself has no value/); }
    assert.equal(r.status, 'no-data');
    // a cohort that selects nothing is a gap too
    seedSeries(root, '2026-10-08', '2026-10-08', () => 10);
    const empty = evalOn(root, scen('t.empty', { cohort: { project: ['nowhere'] }, compare: ['prior-day'] }), '2026-10-08');
    assert.equal(empty.comparisons[0].status, 'gap');
    assert.match(empty.comparisons[0].why, /no records in the cohort/);
  } finally { fx.cleanup(); }
});

test('comparisons: window against window, against the pre-window, and a window that has not started', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-09-10', '2026-10-08', seriesFn);
    const resolved = RES({
      windows: {
        'w-old': { from: '2026-10-02T08:00:00Z', to: '2026-10-06T08:00:00Z', label: 'E' },
        'w-new': { from: '2026-10-06T08:00:00Z' },
        'w-future': { from: '2026-10-20T08:00:00Z' },
        'w-bad': { from: 'rollout:nope' },
      },
    });
    const sc1 = scen('t.win', { compare: [{ window: 'w-new', vs: 'w-old' }, { window: 'w-new', vs: 'pre-window' }, { window: 'w-future', vs: 'w-old' }, { window: 'w-bad', vs: 'w-old' }, { window: 'w-new', vs: 'w-undefined' }] });
    const r = evalOn(root, sc1, '2026-10-08', { resolved });
    const [vsOld, vsPre, future, bad, undef] = r.comparisons;
    // w-new to date: 10-06 (10), 10-07 (10), 10-08 (20); w-old: 10-02, 10-03, 10-05 (10-04 is a gap)
    near(vsOld.current.value, (10 + 10 + 20) / 3);
    assert.deepEqual(vsOld.current.days, ['2026-10-06', '2026-10-07', '2026-10-08']);
    near(vsOld.baseline.value, 10);
    assert.deepEqual(vsOld.baseline.days, ['2026-10-02', '2026-10-03', '2026-10-05']);
    assert.deepEqual(vsOld.baseline.gapDays.map((g) => g.day), ['2026-10-04']);
    assert.equal(vsOld.label, 'E', 'a window labelled E makes the comparison E');
    assert.equal(vsOld.status, 'regression');
    // pre-window: the same length (3 days) just before 10-06 08:00Z -> 10-03, 10-04 (gap), 10-05
    near(vsPre.baseline.value, 10);
    assert.deepEqual(vsPre.baseline.days, ['2026-10-03', '2026-10-05']);
    assert.equal(vsPre.label, 'E', 'w-new starts at an ISO literal, which is E');
    assert.equal(future.status, 'not-started');
    assert.equal(bad.status, 'window-unresolved'); assert.match(bad.why, /no rollout instant for "nope"/);
    assert.equal(undef.status, 'window-unresolved'); assert.match(undef.why, /not defined/);
  } finally { fx.cleanup(); }
});

test('comparisons: a window boundary resolves to the hour, so a part of a day is pooled', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    // day 10-07 holds hour 05:00Z of 10-08 (10-08 05:00Z is before the 08:00Z boundary); day 10-08 the rest
    writeFacts(root, '2026-10-07', [row('2026-10-08T05:00:00.000Z', 's0', 50)]);
    writeFacts(root, '2026-10-08', [
      row('2026-10-08T11:00:00.000Z', 's1', 10),
      row('2026-10-08T12:00:00.000Z', 's2', 90),
      row('2026-10-08T19:00:00.000Z', 's3', 90),
      row('2026-10-08T20:00:00.000Z', 's4', 900),
    ]);
    const resolved = RES({ windows: { late: { from: '2026-10-08T12:34:56Z', to: '2026-10-08T20:00:00Z' } } });
    const r = evalOn(root, scen('t.hour', { compare: [{ window: 'late', vs: 'pre-window' }], threshold: { ...THR, minSample: 1 } }), '2026-10-08', { resolved });
    const c = r.comparisons[0];
    assert.equal(c.windows.current.fromMs, Date.parse('2026-10-08T12:00:00Z'), 'floored to the hour');
    near(c.current.value, 90, 1e-9); // s2 (12:00) and s3 (19:00): 180 / 2; s4 at 20:00 is outside
    assert.equal(c.current.sample, 2);
    // pre-window = [04:00Z, 12:00Z): s0 (05:00, day 10-07) and s1 (11:00)
    near(c.baseline.value, 30);
    assert.equal(c.baseline.sample, 2);
    assert.deepEqual(c.baseline.days, ['2026-10-07', '2026-10-08']);
  } finally { fx.cleanup(); }
});

// ----------------------------------------------------------- thresholds --

const side = (value, { num = value, den = 1, sample = 100, days = ['d'], parts = [], scale = 1 } = {}) => ({ value, num, den, scale, sample, days, parts, gapDays: [] });

test('thresholds: relPct and abs must both hold, direction decides what is worse', () => {
  const t = { relPct: 20, abs: 1, minSample: 10, minDays: 1 };
  const j = (c, b, over = {}) => judge({ cur: side(c), base: side(b), threshold: { ...t, ...over }, day: '2026-10-08', scenarioId: 'x', ...over.args });
  assert.equal(j(12, 10).status, 'regression');
  assert.equal(j(11.9, 10).status, 'ok', 'under relPct');
  assert.equal(j(1.5, 1).status, 'ok', 'over relPct but under abs');
  assert.equal(j(8, 10).status, 'improvement');
  assert.equal(j(8, 10, { args: { direction: 'down-is-worse' } }).status, 'regression');
  assert.equal(j(12, 10, { args: { direction: 'down-is-worse' } }).status, 'improvement');
  assert.equal(j(5, 0).status, 'regression', 'a zero baseline has an unbounded relative move; abs still applies');
  assert.equal(j(0.5, 0).status, 'ok');
  assert.equal(j(10, 10).status, 'ok');
  assert.equal(j(null, 10).status, 'gap');
  assert.equal(judge({ cur: side(30, { sample: 9 }), base: side(10), threshold: t, day: 'd', scenarioId: 'x' }).status, 'low-sample');
  assert.equal(judge({ cur: side(30), base: side(10, { sample: 9 }), threshold: t, day: 'd', scenarioId: 'x' }).status, 'low-sample');
  assert.equal(judge({ cur: side(30), base: side(10), threshold: { ...t, minDays: 2 }, day: 'd', scenarioId: 'x' }).status, 'low-days');
});

test('thresholds: a Wilson interval must separate before a proportion regresses', () => {
  const prop = (k, n) => side((k / n) * 100, { num: k, den: n, sample: n, scale: 100 });
  const t = { relPct: 20, abs: 5, minSample: 5, minDays: 1, interval: 'wilson' };
  const base = prop(8, 40); // 20%, Wilson upper bound about 35%
  const clear = judge({ cur: prop(9, 10), base, threshold: t, day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(clear.status, 'regression');
  assert.equal(clear.interval.applied, true);
  assert.ok(clear.interval.cur.lo > clear.interval.base.hi);
  const murky = judge({ cur: prop(6, 10), base, threshold: t, day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(murky.status, 'unconfirmed', 'a point breach whose intervals overlap is not reported as a regression');
  assert.equal(murky.interval.confirmed, false);
  // down-is-worse mirrors it: 10% against 75% separates, 30% (3/10) against 60% (12/20) overlaps
  const downClear = judge({ cur: prop(1, 10), base: prop(30, 40), threshold: t, direction: 'down-is-worse', day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(downClear.status, 'regression');
  const downMurky = judge({ cur: prop(3, 10), base: prop(12, 20), threshold: t, direction: 'down-is-worse', day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(downMurky.status, 'unconfirmed');
});

test('thresholds: wilson on a non-proportion falls back to the point rule and says so', () => {
  const r = judge({ cur: side(30, { num: 30, den: 2.5 }), base: side(10), threshold: { relPct: 20, abs: 1, minSample: 1, interval: 'wilson' }, day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(r.status, 'regression');
  assert.equal(r.interval.applied, false);
  assert.match(r.interval.why, /not a proportion/);
});

test('thresholds: the bootstrap interval decides, deterministically', () => {
  const parts = (vals, p) => vals.map((v, i) => ({ id: `${p}${i}`, num: v, den: 1 }));
  const mk = (cv, bv) => ({ cur: side(cv.reduce((a, b) => a + b, 0) / cv.length, { parts: parts(cv, 'c') }), base: side(bv.reduce((a, b) => a + b, 0) / bv.length, { parts: parts(bv, 'b') }) });
  const t = { relPct: 20, abs: 1, minSample: 1, interval: 'bootstrap-sessions' };
  const sep = mk([18, 19, 20, 21, 22, 23], [8, 9, 10, 11, 12, 13]);
  const a = judge({ ...sep, threshold: t, day: '2026-10-08', scenarioId: 'u.x', metric: { pool: 'ratio' } });
  const b = judge({ ...sep, threshold: t, day: '2026-10-08', scenarioId: 'u.x', metric: { pool: 'ratio' } });
  assert.deepEqual(a, b, 'same inputs, same verdict, same interval');
  assert.equal(a.status, 'regression');
  assert.ok(a.interval.lo > 0);
  assert.equal(a.interval.seed, seedFor('2026-10-08', 'u.x'));
  const other = judge({ ...sep, threshold: t, day: '2026-10-09', scenarioId: 'u.x', metric: { pool: 'ratio' } });
  assert.notEqual(other.interval.seed, a.interval.seed);
  // one huge session on each side: the point estimate moves 25% but the interval straddles zero
  const noisy = mk([0, 0, 0, 0, 0, 50], [0, 0, 0, 0, 0, 40]);
  const n1 = judge({ ...noisy, threshold: t, day: '2026-10-08', scenarioId: 'u.x', metric: { pool: 'ratio' } });
  assert.equal(n1.status, 'unconfirmed');
  assert.ok(n1.interval.lo < 0 && n1.interval.hi > 0);
  // no parts: the point rule decides, and says so
  const none = judge({ cur: side(30), base: side(10), threshold: t, day: 'd', scenarioId: 'x', metric: { pool: 'ratio' } });
  assert.equal(none.status, 'regression');
  assert.match(none.interval.why, /no per-session parts/);
});

test('thresholds through the pipeline: the same fixture facts give the same bootstrap verdict on every run', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-10-01', '2026-10-08', (d) => (d === '2026-10-08' ? 20 : 10), { n: 6 });
    const def = { compare: ['trailing-7'], threshold: { ...THR, interval: 'bootstrap-sessions', minSample: 5 } };
    const r1 = evalOn(root, scen('t.boot', def), '2026-10-08');
    const r2 = evalOn(root, scen('t.boot', def), '2026-10-08');
    assert.deepEqual(r1, r2);
    assert.equal(r1.comparisons[0].interval.applied, true);
    assert.equal(r1.comparisons[0].status, 'regression');
  } finally { fx.cleanup(); }
});

// --------------------------------------------------------------- groupBy --

test('groupBy: each group is compared on its own, and records without the attribute form their own group', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    for (const day of ['2026-10-07', '2026-10-08']) {
      const cur = day === '2026-10-08';
      writeFacts(root, day, [
        row(`${day}T10:00:00.000Z`, `a1-${day}`, cur ? 30 : 10, { proj: 'alpha' }),
        row(`${day}T10:00:00.000Z`, `a2-${day}`, cur ? 30 : 10, { proj: 'alpha' }),
        row(`${day}T10:00:00.000Z`, `b1-${day}`, 10, { proj: 'beta' }),
        row(`${day}T10:00:00.000Z`, `n1-${day}`, 10, { proj: null }),
      ]);
    }
    const r = evalOn(root, scen('t.group', { groupBy: 'project', compare: ['prior-day'] }), '2026-10-08');
    assert.equal(r.groupBy, 'project');
    assert.deepEqual(r.groups.map((g) => g.key), ['(unobservable)', 'alpha', 'beta']);
    const by = Object.fromEntries(r.groups.map((g) => [g.key, g.comparisons[0]]));
    assert.equal(by.alpha.status, 'regression'); near(by.alpha.current.value, 30);
    assert.equal(by.beta.status, 'ok');
    assert.equal(by[UNKNOWN_GROUP].status, 'ok');
    assert.equal(r.status, 'regression');
    assert.equal(r.counts.regression, 1);
    // a group present today but absent yesterday is a gap for that group, not a zero baseline
    writeFacts(root, '2026-10-09', [row('2026-10-09T10:00:00.000Z', 'g1', 5, { proj: 'gamma' }), row('2026-10-09T10:00:00.000Z', 'a9', 10, { proj: 'alpha' })]);
    const r2 = evalOn(root, scen('t.group', { groupBy: 'project', compare: ['prior-day'] }), '2026-10-09');
    const gamma = r2.groups.find((g) => g.key === 'gamma').comparisons[0];
    assert.equal(gamma.status, 'gap');
  } finally { fx.cleanup(); }
});

test('groupBy model and a spawn-fed groupBy (rung) that has no feed yet', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    for (const day of ['2026-10-07', '2026-10-08']) {
      writeFacts(root, day, [row(`${day}T10:00:00.000Z`, `s-${day}`, 10), row(`${day}T10:00:00.000Z`, `f-${day}`, 10, { model: FABLE })]);
    }
    const r = evalOn(root, scen('t.model', { groupBy: 'model', compare: ['prior-day'] }), '2026-10-08');
    assert.deepEqual(r.groups.map((g) => g.key), [FABLE, SONNET]);
    const rung = evalOn(root, scen('t.rung', { groupBy: 'rung', compare: ['prior-day'] }), '2026-10-08');
    assert.deepEqual(rung.groups.map((g) => g.key), [UNKNOWN_GROUP], 'without spawn records, rung is unobservable, never invented');
    // with the spawn hook, spawn records group by rung
    const spawns = (day) => [{ sid: `s-${day}`, rung: '3', model: SONNET, units: { total: 4 } }, { sid: `f-${day}`, rung: '5', model: FABLE, units: { total: 6 } }];
    const spawnMetric = { id: 'test.spawnUnits', pool: 'ratio', direction: 'up-is-worse', label: 'M', recordKinds: ['spawn'], stat(recs) { return { num: recs.reduce((s, x) => s + x.units.total, 0), den: recs.length, scale: 1, sample: recs.length }; } };
    const r3 = evalOn(root, scen('t.rung2', { groupBy: 'rung', compare: ['prior-day'] }, 'test.spawnUnits'), '2026-10-08', { metric: spawnMetric, hooks: { spawnRecords: (day) => spawns(day) } });
    assert.deepEqual(r3.groups.map((g) => g.key), ['3', '5']);
    near(r3.groups[1].comparisons[0].current.value, 6);
    // a spawn cohort field with no spawn feed is a gap that names the hook
    const r4 = evalOn(root, scen('t.rung3', { cohort: { rung: ['3'] }, compare: ['prior-day'] }, 'test.spawnUnits'), '2026-10-08', { metric: spawnMetric });
    assert.equal(r4.comparisons[0].status, 'gap');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- events --

test('events: ISO times resolve to the hour and are E; garbage is a gap', () => {
  const r = resolveEvent('2026-10-10T20:03Z', {});
  assert.equal(r.ms, Date.parse('2026-10-10T20:00:00Z'));
  assert.equal(r.rawMs, Date.parse('2026-10-10T20:03:00Z'));
  assert.equal(r.label, 'E');
  assert.equal(resolveEvent('2026-10-10', {}).ms, Date.parse('2026-10-10T00:00:00Z'));
  assert.equal(parseIso('2026-02-30'), null);
  assert.equal(parseIso('2026-10-10T25:00Z'), null);
  assert.equal(resolveEvent('whenever', {}).gap, true);
  assert.equal(resolveEvent('weird:thing', {}).gap, true);
});

test('events: rollout, decision, release, cli, setting, tag, config', () => {
  const sources = {
    rolloutMs: (id) => (id === 'leads-xhigh' ? Date.parse('2026-10-11T14:27:31Z') : null),
    decisions: [
      { id: 'haiku-5-5-trial', decided: '2026-10-12' },
      { id: 'leads-at-xhigh', decided: '2026-10-10', rolloutId: 'leads-xhigh' },
      { id: 'dangling', decided: '2026-10-09', rolloutId: 'missing' },
      { id: 'undated' },
    ],
    spawnRows: [
      { at: '2026-10-09T12:45:00Z', guard_version: '0.31.15' },
      { at: '2026-10-08T09:10:00Z', guard_version: '0.31.15' },
      { at: '2026-10-10T07:00:00Z', guard_version: '0.31.16' },
    ],
    cliVersions: [{ at: '2026-10-05T10:20:00Z', version: '2.1.281' }, { at: '2026-10-04T10:20:00Z', version: '2.1.281' }],
    settingsRows: [
      { at: '2026-10-03T08:00:00Z', session_id: 'a', model: 'opus', effort: 'high' },
      { at: '2026-10-06T08:30:00Z', session_id: 'b', model: 'opus', effort: 'xhigh' },
      { at: '2026-10-07T08:30:00Z', session_id: 'c', model: 'opus', effort: 'high' },
      { at: '2026-10-09T08:30:00Z', session_id: 'd', model: 'opus', effort: 'xhigh' },
    ],
    tagTimeMs: (project, tag) => (project === 'proj' && tag === 'v1.2.0' ? Date.parse('2026-09-30T15:45:10Z') : null),
    configRows: [
      { at: '2026-10-01T04:00:00Z', scenario: 'u.a', digest: 'd1' },
      { at: '2026-10-02T04:00:00Z', scenario: 'u.a', digest: 'd1' },
      { at: '2026-10-05T04:00:00Z', scenario: 'u.a', digest: 'd2' },
      { at: '2026-10-08T04:00:00Z', scenario: 'u.a', digest: 'd3' },
      { at: '2026-10-01T04:00:00Z', scenario: 'u.b', digest: 'x' },
    ],
  };
  const at = (ref) => resolveEvent(ref, sources);
  const roll = at('rollout:leads-xhigh');
  assert.equal(roll.ms, Date.parse('2026-10-11T14:00:00Z')); assert.equal(roll.label, 'M');
  assert.equal(at('rollout:nope').gap, true);
  assert.equal(at('decision:leads-at-xhigh').ms, Date.parse('2026-10-11T14:00:00Z'));
  assert.equal(at('decision:leads-at-xhigh').label, 'M');
  const dec = at('decision:haiku-5-5-trial');
  assert.equal(dec.ms, Date.parse('2026-10-12T00:00:00Z')); assert.equal(dec.label, 'E', 'a decided date is E');
  assert.equal(at('decision:dangling').label, 'E', 'an unresolvable rollout falls back to the decided date');
  assert.equal(at('decision:undated').gap, true);
  assert.equal(at('decision:ghost').gap, true);
  assert.equal(at('release:agent-companion@0.31.15').ms, Date.parse('2026-10-08T09:00:00Z'), 'the FIRST row with that version');
  assert.equal(at('release:agent-companion@9.9.9').gap, true);
  assert.equal(at('release:other@1.0.0').gap, true);
  assert.equal(at('release:agent-companion').gap, true);
  assert.equal(at('cli:2.1.281').ms, Date.parse('2026-10-04T10:00:00Z'));
  assert.equal(at('cli:9.9.9').gap, true);
  assert.equal(at('setting:effort=xhigh').ms, Date.parse('2026-10-06T08:00:00Z'), 'the first instant, not the later switch back to it');
  assert.equal(at('setting:effort=low').gap, true);
  assert.equal(at('setting:model=opus').ms, Date.parse('2026-10-03T08:00:00Z'));
  assert.equal(at('tag:proj/v1.2.0').ms, Date.parse('2026-09-30T15:00:00Z'));
  assert.equal(at('tag:proj/v0.0.1').gap, true);
  assert.equal(at('config:u.a').ms, Date.parse('2026-10-08T04:00:00Z'), 'the latest change; the first row is a baseline, not a change');
  assert.equal(at('config:u.b').gap, true, 'one journaled digest and no change');
  assert.equal(at('config:u.zzz').gap, true);
  // missing sources are gaps that name themselves
  assert.match(resolveEvent('cli:2.1.281', {}).why, /sources\.cliVersions/);
  assert.match(resolveEvent('release:agent-companion@1', {}).why, /spawns\.jsonl/);
  assert.match(resolveEvent('setting:effort=high', {}).why, /journal/);
  assert.match(resolveEvent('tag:p/t', {}).why, /no git tag source/);
  // a source that throws is a gap, not a crash
  assert.equal(resolveEvent('tag:p/t', { tagTimeMs: () => { throw new Error('boom'); } }).gap, true);
});

test('events: a window resolves both ends, labels E when any end or its definition is E, and rejects an inverted window', () => {
  const sources = { rolloutMs: () => Date.parse('2026-10-11T14:27:00Z') };
  const w = resolveWindow({ from: '2026-10-10T20:03Z', to: 'rollout:x' }, sources);
  assert.equal(w.fromMs, Date.parse('2026-10-10T20:00:00Z'));
  assert.equal(w.toMs, Date.parse('2026-10-11T14:00:00Z'));
  assert.equal(w.label, 'E');
  const m = resolveWindow({ from: 'rollout:x' }, sources);
  assert.equal(m.label, 'M'); assert.equal(m.toMs, null);
  assert.equal(resolveWindow({ from: 'rollout:x', label: 'E' }, sources).label, 'E');
  assert.match(resolveWindow({ from: 'rollout:x', to: '2026-10-01' }, sources).why, /ends before it starts/);
  assert.match(resolveWindow({ from: 'rollout:y' }, { rolloutMs: () => null }).why, /^from: /);
  assert.match(resolveWindow({ from: 'rollout:x', to: 'rollout:y' }, { rolloutMs: (id) => (id === 'x' ? 1e12 : null) }).why, /^to: /);
  assert.equal(resolveWindow({}, sources).gap, true);
});

test('events: file-backed sources read below the root only, lazily, and settings use the batch 11 journal', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    mkdirSync(join(root, 'telemetry'), { recursive: true });
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'rollout.json'), JSON.stringify({ 'leads-xhigh': '2026-10-11T14:27:31Z', bad: 'tomorrow' }));
    writeFileSync(join(root, 'config', 'decision-register.json'), JSON.stringify({ decisions: [{ id: 'd1', decided: '2026-10-02' }] }));
    writeFileSync(join(root, 'telemetry', 'spawns.jsonl'), `${JSON.stringify({ at: '2026-10-09T10:15:00Z', guard_version: '0.31.17' })}\nnot json\n`);
    writeFileSync(join(root, 'telemetry', 'settings-changes.jsonl'), `${JSON.stringify({ v: 1, at: '2026-10-06T08:30:00Z', session_id: 'b', effort: 'xhigh' })}\n`);
    writeFileSync(join(root, 'state', CONFIG_JOURNAL_FILE), [{ at: '2026-10-01T04:00:00Z', scenario: 'u.a', digest: 'd1' }, { at: '2026-10-03T04:00:00Z', scenario: 'u.a', digest: 'd2' }].map((x) => JSON.stringify(x)).join('\n'));
    const before = tree(root);
    const src = loadEventSources(root);
    assert.equal(resolveEvent('rollout:leads-xhigh', src).ms, Date.parse('2026-10-11T14:00:00Z'));
    assert.equal(resolveEvent('rollout:bad', src).gap, true);
    assert.equal(resolveEvent('decision:d1', src).label, 'E');
    assert.equal(resolveEvent('release:agent-companion@0.31.17', src).ms, Date.parse('2026-10-09T10:00:00Z'));
    assert.equal(resolveEvent('setting:effort=xhigh', src).ms, Date.parse('2026-10-06T08:00:00Z'));
    assert.equal(resolveEvent('config:u.a', src).ms, Date.parse('2026-10-03T04:00:00Z'));
    assert.equal(resolveEvent('cli:2.1.281', src).gap, true);
    assert.equal(tree(root), before, 'reading wrote nothing');
    const empty = loadEventSources(join(fx.dir, 'nowhere'));
    assert.equal(resolveEvent('release:agent-companion@1', empty).gap, true);
  } finally { fx.cleanup(); }
});

test('events: the git tag source asks git read-only, refuses an option-shaped tag, and needs a configured path', () => {
  const calls = [];
  const git = (args) => { calls.push(args); return '2026-09-30T11:45:10-04:00\n'; };
  const tagTime = makeGitTagTime({ projects: { proj: { paths: ['C:/work/proj'] } } }, { git });
  assert.equal(tagTime('proj', 'v1.2.0'), Date.parse('2026-09-30T15:45:10Z'));
  assert.deepEqual(calls[0].slice(0, 3), ['-C', 'C:/work/proj', 'for-each-ref']);
  assert.ok(calls[0].every((a) => !/^(commit|push|tag|checkout|reset)$/.test(a)));
  assert.equal(tagTime('proj', '--upload-pack=evil'), null);
  assert.equal(tagTime('other', 'v1'), null);
  assert.equal(calls.length, 1, 'refused cases never reached git');
  const empty = makeGitTagTime({ projects: { proj: { paths: ['x'] } } }, { git: () => '' });
  assert.equal(empty('proj', 'v9'), null);
  const boom = makeGitTagTime({ projects: { proj: { paths: ['x'] } } }, { git: () => { throw new Error('no git'); } });
  assert.equal(boom('proj', 'v9'), null);
});

test('events: the config digest covers what defines a series and not the thresholds; the diff is the baseline then the changes', () => {
  const sc = (over = {}) => ({ id: 'u.a', metric: 'm', def: { cohort: { class: ['lead'] }, excludeSets: ['x'], params: { p: 1 }, threshold: { relPct: 20 }, severity: 'info', ...over } });
  const ex = { x: { model: ['a'], scope: 'tree' } };
  const d0 = scenarioDigest(sc(), ex);
  assert.equal(d0, scenarioDigest(sc({ threshold: { relPct: 99 }, severity: 'alert' }), ex), 'thresholds and severity do not break a series');
  assert.notEqual(d0, scenarioDigest(sc({ params: { p: 2 } }), ex));
  assert.notEqual(d0, scenarioDigest(sc({ cohort: { class: ['worker'] } }), ex));
  assert.notEqual(d0, scenarioDigest(sc(), { x: { model: ['b'], scope: 'tree' } }), 'an exclusion it uses changed');
  assert.equal(d0, scenarioDigest({ ...sc(), def: { ...sc().def, cohort: { class: ['lead'] } } }, { ...ex, unused: { model: ['z'] } }), 'an exclusion it does not use is irrelevant');
  const first = diffConfigDigests([], [sc()], ex, Date.parse('2026-10-13T04:00:00Z'));
  assert.equal(first.length, 1); assert.equal(first[0].at, '2026-10-13T04:00:00.000Z');
  assert.deepEqual(diffConfigDigests(first, [sc()], ex, Date.now()), [], 'unchanged: nothing to journal');
  const changed = diffConfigDigests(first, [sc({ params: { p: 3 } })], ex, Date.parse('2026-10-14T04:00:00Z'));
  assert.equal(changed.length, 1);
  assert.equal(configChangeMs([...first, ...changed], 'u.a'), Date.parse('2026-10-14T04:00:00Z'));
});

// ----------------------------------------------------- the real config shape --

test('the real resolved config (config.mjs) drives an evaluation end to end, including a config: window', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-10-01', '2026-10-08', (d) => (d >= '2026-10-06' ? 20 : 10));
    // a fable session on 10-08 that the exclusion must keep out of the cohort
    writeFacts(root, '2026-10-08', [
      ...Array.from({ length: 3 }, (_, i) => row('2026-10-08T10:00:00.000Z', `s-2026-10-08-${i}`, 20)),
      row('2026-10-08T11:00:00.000Z', 'fable-lead', 900, { model: FABLE }),
    ]);
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'state'), { recursive: true });
    const shipped = join(fx.dir, 'shipped.json');
    writeFileSync(shipped, JSON.stringify({ schema: 'agent-companion/usage-analysis', schemaVersion: 1, defaults: { threshold: { relPct: 25, minSample: 1, minDays: 1 } }, scenarios: [] }));
    writeFileSync(join(root, 'config', 'usage-analysis.json'), JSON.stringify({
      schema: 'agent-companion/usage-analysis', schemaVersion: 1,
      windows: { before: { from: '2026-10-01T08:00:00Z', to: 'config:u.real' }, after: { from: 'config:u.real' } },
      exclusions: { 'fable-tree': { model: ['claude-fable-*'], scope: 'tree', why: 'design sessions' } },
      scenarios: [{ id: 'u.real', metric: 'day.units', excludeSets: ['fable-tree'], compare: ['prior-day', { window: 'after', vs: 'before' }, { window: 'after', vs: 'pre-window' }], threshold: { direction: 'up-is-worse', relPct: 25, abs: 1 }, severity: 'alert' }],
    }));
    const cfg = loadConfig({ root, shippedPath: shipped, writeSignal: false });
    assert.deepEqual(cfg.problems, []);
    const scenario = cfg.resolved.scenarios.get('u.real');
    const sources = { configRows: [{ at: '2026-10-05T04:00:00Z', scenario: 'u.real', digest: 'a' }, { at: '2026-10-06T08:20:00Z', scenario: 'u.real', digest: 'b' }] };
    const r = evaluateScenario({ scenario, resolved: cfg.resolved, day: '2026-10-08', loadDay: makeFactsLoader({ root }), metric: { ...unitsPerSession, id: 'day.units', recordKinds: ['session'] }, sources });
    // day.units is an always-everything metric: the fable session is counted despite excludeSets
    assert.equal(r.meta.exclusionsIgnored, true);
    const [pd, wvw, wvp] = r.comparisons;
    assert.equal(pd.current.sample, 4);
    assert.equal(wvw.windows.current.fromMs, Date.parse('2026-10-06T08:00:00Z'), 'config: floors to the hour');
    assert.equal(wvw.windows.baseline.toMs, Date.parse('2026-10-06T08:00:00Z'));
    assert.equal(wvp.status !== 'window-unresolved', true);
    // the same scenario as a cohort metric excludes the fable tree
    const cohortScenario = { ...scenario, metric: 'test.unitsPerSession' };
    const r2 = evaluateScenario({ scenario: cohortScenario, resolved: cfg.resolved, day: '2026-10-08', loadDay: makeFactsLoader({ root }), metric: unitsPerSession, sources });
    assert.equal(r2.comparisons[0].current.sample, 3);
    near(r2.comparisons[0].current.value, 20);
    assert.equal(r2.meta.excluded['fable-tree'].units, 900);
    // a disabled scenario is skipped, not evaluated
    assert.deepEqual(evaluateScenario({ scenario: { ...scenario, state: 'disabled' }, resolved: cfg.resolved, day: '2026-10-08', loadDay: () => { throw new Error('must not load'); }, metric: unitsPerSession }), { id: 'u.real', skipped: 'disabled' });
  } finally { fx.cleanup(); }
});

// ----------------------------------------------------------- pooling rules --

test('pooling: sum metrics are a per-day mean, and a partial day weighs by its coverage', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-10-01', '2026-10-03', () => 10, { n: 1 });
    const sumMetric = { id: 'test.daily', pool: 'sum', direction: 'up-is-worse', label: 'M', stat(recs) { return { num: recs.reduce((s, r) => s + r.units.total, 0), den: 1, scale: 1, sample: recs.length }; } };
    const prov = makeProvider({ scenario: scen('t.sum', {}), resolved: RES(), loadDay: makeFactsLoader({ root }), metric: sumMetric });
    const full = poolSlots(prov, [{ day: '2026-10-01', coverage: 1 }, { day: '2026-10-02', coverage: 1 }], 'sum');
    near(full.value, 10);
    const half = poolSlots(prov, [{ day: '2026-10-01', coverage: 1 }, { day: '2026-10-02', range: { fromMs: dayStartMs('2026-10-02'), toMs: dayStartMs('2026-10-02') + 12 * HOUR_MS }, coverage: 0.5 }], 'sum');
    // the 10:00Z row lies in the first 12 hours: 20 units over 1.5 days
    near(half.value, 20 / 1.5);
    const none = poolSlots(prov, [{ day: '2026-09-01', coverage: 1 }], 'sum');
    assert.equal(none.value, null);
    assert.equal(none.gapDays.length, 1);
  } finally { fx.cleanup(); }
});

test('pooling: median and p90 metrics pool the parts, not the day figures', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'root');
    writeFacts(root, '2026-10-01', [row('2026-10-01T10:00:00.000Z', 'a', 1), row('2026-10-01T10:00:00.000Z', 'b', 2), row('2026-10-01T10:00:00.000Z', 'c', 3)]);
    writeFacts(root, '2026-10-02', [row('2026-10-02T10:00:00.000Z', 'd', 100)]);
    const med = { id: 'test.median', pool: 'median', direction: 'up-is-worse', label: 'M', stat(recs) { const v = recs.map((r) => r.units.total).sort((a, b) => a - b); return { num: v[Math.floor(v.length / 2)], den: 1, scale: 1, sample: recs.length, parts: recs.map((r) => ({ id: r.sid, num: r.units.total, den: 1, value: r.units.total })) }; } };
    const prov = makeProvider({ scenario: scen('t.med', {}), resolved: RES(), loadDay: makeFactsLoader({ root }), metric: med });
    const p = poolSlots(prov, [{ day: '2026-10-01', coverage: 1 }, { day: '2026-10-02', coverage: 1 }], 'median');
    assert.equal(p.value, 2.5, 'median of the four sessions, not of the two day medians (2 and 100)');
  } finally { fx.cleanup(); }
});

// ------------------------------------------------------------------- DST --

test('DST: the 2026-11-01 change moves no day boundary, weekday or comparison', () => {
  const fx = makeFixture();
  const savedTz = process.env.TZ;
  try {
    const root = join(fx.dir, 'root');
    // Local time falls back at 06:00Z on 2026-11-01 (America/New_York), a 25-hour local day. A checkup day
    // is 24 hours from 08:00Z, so 11-01 holds hours 08:00Z 11-01 .. 07:00Z 11-02, and the repeated local
    // hour (05:00Z and 06:00Z) lies in the day 10-31.
    const fn = (d) => (d === '2026-11-01' ? 30 : 10);
    seedSeries(root, '2026-10-04', '2026-11-04', fn);
    writeFacts(root, '2026-10-31', [
      row('2026-11-01T04:00:00.000Z', 'e0', 10), row('2026-11-01T05:00:00.000Z', 'e1', 10),
      row('2026-11-01T06:00:00.000Z', 'e2', 10), row('2026-11-01T07:00:00.000Z', 'e3', 10), row('2026-10-31T10:00:00.000Z', 'e4', 10),
    ]);
    const resolved = RES({ windows: { dst: { from: '2026-11-01T05:00:00Z' } } });
    const def = { compare: ['prior-day', 'trailing-7', 'same-weekday-4', { window: 'dst', vs: 'pre-window' }] };
    const run = () => evalOn(root, scen('t.dst', def), '2026-11-01', { resolved });
    process.env.TZ = 'UTC';
    const utc = run();
    process.env.TZ = 'America/New_York';
    const ny = run();
    process.env.TZ = 'Pacific/Auckland';
    const nz = run();
    assert.deepEqual(ny, utc);
    assert.deepEqual(nz, utc);
    // the day keys and weekdays across the change
    assert.equal(weekdayOf('2026-11-01'), 'Sun');
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(dayStartMs('2026-11-02') - dayStartMs('2026-11-01'), DAY_MS);
    assert.equal(dayKeyOfMs(Date.parse('2026-11-01T07:59:59Z')), '2026-10-31');
    assert.equal(dayKeyOfMs(Date.parse('2026-11-01T08:00:00Z')), '2026-11-01');
    // 11-01 is a Sunday; its same weekdays are 10-25, 10-18, 10-11, 10-04, a week apart in UTC
    const sw = utc.comparisons[2];
    assert.deepEqual(sw.baseline.days, ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
    near(sw.baseline.value, 10);
    near(utc.comparisons[1].baseline.value, 10);
    assert.deepEqual(utc.comparisons[1].baseline.days, dayRange('2026-10-25', '2026-10-31'));
    // 10-31 holds the repeated local hour: the five 'e' sessions (this file replaced the seeded one)
    const prior = utc.comparisons[0];
    assert.equal(prior.baseline.sample, 5);
    // the day itself: three sessions of 30
    near(utc.comparisons[0].current.value, 30);
    // the window from 05:00Z reaches back into 10-31 for its pre-window and forward only to the end of 11-01
    const w = utc.comparisons[3];
    assert.equal(w.windows.current.fromMs, Date.parse('2026-11-01T05:00:00Z'));
    assert.equal(w.windows.current.toMs, Date.parse('2026-11-02T08:00:00Z'));
    const len = w.windows.current.toMs - w.windows.current.fromMs;
    assert.equal(w.windows.baseline.fromMs, w.windows.current.fromMs - len);
    assert.equal(len, 27 * HOUR_MS);
    // every hour of the 24-hour day is addressable exactly once
    const hours = new Set();
    for (let h = 0; h < 24; h += 1) hours.add(new Date(dayStartMs('2026-11-01') + h * HOUR_MS).toISOString());
    assert.equal(hours.size, 24);
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    fx.cleanup();
  }
});

// -------------------------------------------------------- general (batch rules) --

test('general: a fake claude on PATH is never called, nothing is written, and nothing spawns without windowsHide', () => {
  const fx = makeFixture();
  const savedPath = process.env.PATH;
  try {
    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${bin}${sep}${savedPath}`;
    const root = join(fx.dir, 'root');
    seedSeries(root, '2026-10-01', '2026-10-08', seriesFn);
    mkdirSync(join(root, 'telemetry'), { recursive: true });
    writeFileSync(join(root, 'telemetry', 'spawns.jsonl'), `${JSON.stringify({ at: '2026-10-05T10:00:00Z', guard_version: '0.31.17' })}\n`);
    const outside = join(fx.dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'x');
    const homeBefore = tree(fx.dir.replace(/\\/g, '/') + '/outside');
    const rootBefore = tree(root);
    const resolved = RES({ windows: { w: { from: 'release:agent-companion@0.31.17' } }, exclusions: { e: { model: ['x*'], scope: 'tree' } } });
    const sources = loadEventSources(root);
    const r = evalOn(root, scen('t.gen', { excludeSets: ['e'], groupBy: 'project', compare: ['prior-day', 'trailing-7', 'same-weekday-4', { window: 'w', vs: 'pre-window' }], threshold: { ...THR, interval: 'bootstrap-sessions' } }), '2026-10-08', { resolved, sources });
    assert.ok(r.groups.length >= 1);
    assert.ok(!existsSyncSafe(log), 'the fake claude was never called');
    assert.equal(tree(root), rootBefore, 'the library wrote nothing under the root');
    assert.equal(tree(outside), homeBefore, 'and nothing outside it');
    // every child-process call in the new files hides its window
    for (const rel of ['days', 'stats', 'events', 'cohort', 'compare']) {
      const src = readFileSync(new URL(`../scripts/lib/usage/${rel}.mjs`, import.meta.url), 'utf8');
      assert.ok(!/['"`]claude['"`]/.test(src), `${rel}: no claude invocation`);
      assert.ok(!/node:child_process|from 'child_process'/.test(src), `${rel}: no direct child_process`);
      for (const m of src.matchAll(/(?<![.\w])(?:spawn|spawnSync|exec|execFile|execFileSync|fork)\(/g)) {
        assert.match(src.slice(m.index, m.index + 400), /windowsHide:\s*true/, `${rel}: a spawn without windowsHide at ${m.index}`);
      }
      assert.ok(!/\b(writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync|createWriteStream)\b/.test(src), `${rel}: the compare library does not write`);
    }
    // the only process it can start is git, through gitClean, which hides the window
    assert.match(readFileSync(new URL('../scripts/lib/proc.mjs', import.meta.url), 'utf8'), /windowsHide: true/);
  } finally {
    process.env.PATH = savedPath;
    fx.cleanup();
  }
});

function existsSyncSafe(p) { try { statSync(p); return true; } catch { return false; } }

test('general: no fixture holds a username, machine path, short commit id or internal service name', () => {
  // names of people and services are the job of scripts/leak-check.mjs; this guards the shapes
  const src = readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => !l.includes('const machine = [')).join('\n');
  const machine = [/[A-Z]:[\\/]+Users[\\/]/i, /\/home\/\w+/, /\.claude\/(?:projects|tasks)/];
  for (const re of machine) assert.ok(!re.test(src), `fixture text matches ${re}`);
  // short commit ids: a bare 7-hex word that is not a plain number or word
  const hex = [...src.matchAll(/\b(?=[0-9a-f]{7}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7}\b/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], 'no short commit ids');
});
