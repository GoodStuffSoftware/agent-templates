// Batch 6a of the daily usage analysis (0.31.18): the day, week, meter, lead and exclusion metrics, their
// stat() adapters and the shipped scenarios. Every figure is checked on a synthetic
// facts day, end to end through the runner with the REAL adapters (no injected ones). Ids are sess-*; nothing
// reads the operator's data; a fake `claude` on PATH is never called; nothing is written outside the state root.
import { makeFixture } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, appendFileSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { dayRange } from '../scripts/lib/usage/days.mjs';
import { runAnalysis, readResult, makeHooks } from '../scripts/lib/usage/runner.mjs';
import { listMetrics, getMetric } from '../scripts/lib/usage/metrics/index.mjs';
import { respawnFlags } from '../scripts/lib/usage/metrics/lead.mjs';
import { loadConfig } from '../scripts/lib/usage/config.mjs';

// ---------------------------------------------------------------- fixtures --

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const NOW = Date.parse('2026-10-11T12:00:00Z'); // 2026-10-10 (08:00Z to 08:00Z) is the last closed, settled day
const FIRST = '2026-10-02';
const LAST = '2026-10-10';
const LATE = 26.77; // 1% of the 2677-unit weekly limit, in the last hours of the day, after the meter sample
const TOTAL = 91 + LATE;
const tok = (u) => [u, 0, 0, 0, 0, 1]; // u plan units of plain input under SPEC
const zero = () => [0, 0, 0, 0, 0, 0];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || 'value'}: ${a} vs ${b}`);

// one fact row: main = { model: units }, sub = { model: units }
function row(hour, sid, { main = {}, sub = {}, proj = 'alpha', n = 0, len = [n, 0, 0, 0], corr = 0, ag = 0, gc = 0 } = {}) {
  const t = {};
  for (const [m, u] of Object.entries(main)) (t[m] ||= { m: zero(), s: zero() }).m = tok(u);
  for (const [m, u] of Object.entries(sub)) (t[m] ||= { m: zero(), s: zero() }).s = tok(u);
  return { hour, sid, proj, cwd: null, tok: t, pr: { n, len, corr }, ag, sm: 0, gc };
}

function spawn(day, sid, id, { startHm, n = 'N1', units = 4, model = SONNET } = {}) {
  return {
    id, sid, aid: `a-${id}`, proj: 'alpha', type: 'bounded-feature', role: 'writer', rung: 'sonnet/high', fit: 'ok', model, mixed: false,
    start: `${day}T${startHm}:00.000Z`, end: `${day}T${startHm}:20.000Z`, partial: false,
    req: { n: 8, bucket: '6-15', cat: {} }, ctx: { buckets: [tok(units), zero(), zero(), zero()], peak: 90000 },
    startup: zero(), comp: { n: 0, after: null }, extraTurns: 0, status: 'done', simple: { runs: 0, req: 0, tok: zero() }, rk: { d: null, n, h: null },
  };
}

// the standard day: two leads, a lead on the heavy model, a session without prompts, and one late row after the meter sample
function dayRows(day) {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return [
    row(`${day}T10:00:00.000Z`, 'sess-lead-1', { main: { [OPUS]: 20 }, sub: { [SONNET]: 10 }, proj: 'alpha', n: 4, len: [1, 2, 1, 0], corr: 1, ag: 3, gc: 2 }),
    row(`${day}T14:00:00.000Z`, 'sess-lead-2', { main: { [SONNET]: 6 }, proj: 'beta', n: 2, len: [1, 1, 0, 0], ag: 1, gc: 1 }),
    row(`${day}T11:00:00.000Z`, 'sess-fable', { main: { [FABLE]: 50 }, proj: 'alpha', n: 1, len: [1, 0, 0, 0] }),
    row(`${day}T15:00:00.000Z`, 'sess-quiet', { main: { [SONNET]: 5 }, proj: 'beta' }),
    row(`${next}T02:00:00.000Z`, 'sess-late', { main: { [SONNET]: LATE }, proj: 'beta' }),
  ];
}
function daySpawns(day) {
  return [
    spawn(day, 'sess-lead-1', 'sp1', { startHm: '10:00', n: 'N1', units: 4 }),
    spawn(day, 'sess-lead-1', 'sp2', { startHm: '10:30', n: 'N1', units: 6 }), // a re-spawn of sp1
    spawn(day, 'sess-lead-1', 'sp3', { startHm: '20:00', n: 'N1', units: 3 }), // 9.5 h later: not a re-spawn
    spawn(day, 'sess-lead-1', 'sp4', { startHm: '12:00', n: 'N2', units: 5 }),
    spawn(day, 'sess-lead-2', 'sp5', { startHm: '15:00', n: 'N3', units: 2 }),
  ];
}

function writeFacts(root, day, rows, spawns = []) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const models = {};
  for (const m of [SONNET, OPUS, FABLE]) models[m] = { ...SPEC };
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${next}T08:00:00.000Z`, dataThrough: `${next}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${next}T09:00:00.000Z`, weightsUsed: models, rows, spawns,
  }));
}

function seed(root, { from = FIRST, to = LAST } = {}) {
  for (const day of dayRange(from, to)) writeFacts(root, day, dayRows(day), daySpawns(day));
}

const WEEK_START = '2026-10-09T16:00:00.000Z';
const RESETS_AT = Date.parse('2026-10-16T16:00:00.000Z') / 1000;
function historyLine(day, { hits = 2, partial = false, pctSoFar = 12 } = {}) {
  return JSON.stringify({
    v: 1, day, limitUnits: 2677, targetPct: 4, units: { main: 1, subagent: 1, total: 2 }, pct: { total: 4 },
    // elapsedPct is past week.pace's minElapsedPct (25): earlier in the plan week the projection is a gap, see usage-scenarios-fixes.test.mjs
    week: { start: WEEK_START, units: 321.24, pctSoFar, elapsedPct: 30, paceAtResetPct: 120, partial },
    limit: { hits, firstAt: hits ? `${day}T12:00:00.000Z` : null },
  });
}
function writeHistory(root, lines) {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'daily-checkup-history.jsonl'), `${lines.join('\n')}\n`);
}
function meterLine(ts, pct, resetsAt = RESETS_AT) {
  return JSON.stringify({ ts, session_id: 'sess-meter', model: SONNET, cli: '2.1.0', rate_limits: { seven_day: { used_percentage: pct, resets_at: resetsAt } } });
}
function writeMeter(root, lines) {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'plan-meter-samples.jsonl'), `${lines.join('\n')}\n`);
}

function userConfig(root, cfg) {
  const file = join(root, 'config', 'usage-analysis.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 'agent-companion/usage-analysis', schemaVersion: 1, ...cfg }));
}

// no metrics option: the runner uses the registry's real stat() adapters
const run = (root, extra = {}) => runAnalysis({ root, nowT: NOW, cwds: [], ...extra });

const scenarioOf = (res, id) => res.scenarios.find((s) => s.id === id);
const currentOf = (res, id, i = 0) => {
  const sc = scenarioOf(res, id);
  assert.ok(sc, `scenario ${id} is in the result`);
  assert.equal(sc.skipped, undefined, `${id} was skipped: ${sc.skipped} ${sc.why || ''}`);
  const c = sc.comparisons[i];
  assert.ok(c && c.current, `${id}: comparison ${i} has a current side (${c && c.status} ${c && c.why})`);
  return c.current;
};

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
}

// ------------------------------------------------------------------ tests --

test('every 6a metric has both day() and stat(), and the real runner finds the adapter', () => {
  const ids = [
    'day.units', 'day.byClass', 'day.byProject', 'day.byModel', 'week.pace', 'meter.reconcile', 'day.limitHits', 'day.hours', 'day.excludedShare',
    'lead.unitsPerPrompt', 'lead.threadShare', 'lead.threadUnitsPerPrompt', 'lead.unitsPerTask', 'lead.workersPerTask', 'lead.workersPerPrompt',
    'lead.modelMix', 'lead.unitsPerCommitCall', 'lead.rework', 'lead.correctionFlags',
  ];
  for (const id of ids) {
    const m = getMetric(id);
    assert.ok(m, `${id} is in the registry`);
    assert.equal(typeof m.day, 'function', `${id} day()`);
    assert.equal(typeof m.stat, 'function', `${id} stat()`);
    assert.ok(['M', 'E'].includes(m.label), id);
    assert.equal(m.register, false, `${id} is not a register metric (the 13 register ids stay frozen)`);
  }
  // the two batch-1 register metrics inside these sections also carry an adapter
  for (const id of ['mainUnitsPerDay', 'mainUnitsPerLeadSpawn']) assert.equal(typeof getMetric(id).stat, 'function', id);
  // every registry metric without an adapter is a batch 6b (or later) metric
  const without = listMetrics().filter((m) => typeof m.stat !== 'function').map((m) => m.id);
  assert.ok(!without.some((id) => ids.includes(id)));
});

test('day, week, meter and exclusion metrics on a fixture day, through the runner with the real adapters', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root);
    writeHistory(root, [historyLine(LAST)]);
    writeMeter(root, [meterLine('2026-10-10T20:00:00.000Z', 11)]);
    userConfig(root, { exclusions: { 'fable-tree': { model: ['claude-fable-*'], scope: 'tree', why: 'heavy-model design session' } } });
    const out = run(root);
    assert.equal(out.error, undefined);
    assert.deepEqual(out.deferred, []);
    const res = readResult(root, LAST);

    // day.units: everything, whatever the exclusions
    const u = currentOf(res, 'day.units');
    near(u.value, TOTAL, 'day.units');
    assert.equal(u.detail.sessions, 5);
    near(res.totals.units, TOTAL, 'the runner total agrees');
    // day.byClass: the lead class holds sess-lead-1, sess-lead-2 and sess-fable (86 of the day's units)
    const c = currentOf(res, 'day.byClass');
    near(c.value, (86 / TOTAL) * 100, 'lead share');
    assert.equal(c.detail.key, 'lead');
    near(c.detail.units.other, 5 + LATE, 'other class units');
    // day.byProject
    const p = currentOf(res, 'day.byProject');
    assert.equal(p.detail.key, 'alpha');
    near(p.value, (80 / TOTAL) * 100, 'alpha share');
    near(p.detail.units.beta, 11 + LATE, 'beta units');
    // day.byModel: units and raw tokens by model
    const m = currentOf(res, 'day.byModel');
    assert.equal(m.detail.key, 'fable');
    near(m.value, (50 / TOTAL) * 100, 'fable share');
    near(m.detail.unitsByModel[OPUS], 20, 'opus units');
    near(m.detail.unitsByModel[SONNET], 10 + 6 + 5 + LATE, 'sonnet units');
    assert.equal(m.detail.rawTokensByModel[FABLE], 50);
    // week.pace
    const w = currentOf(res, 'week.pace');
    assert.equal(w.value, 120);
    assert.equal(w.detail.pctSoFar, 12);
    // meter.reconcile: local week-to-date taken at the sample's time (12% at the day end less the 1% used after the sample)
    const r = currentOf(res, 'meter.reconcile');
    near(r.value, 0, 'meter gap');
    near(r.detail.localPct, 11, 'local at the sample');
    assert.equal(r.detail.meterPct, 11);
    // day.limitHits
    const l = currentOf(res, 'day.limitHits');
    assert.equal(l.value, 2);
    assert.equal(l.detail.firstAt, `${LAST}T12:00:00.000Z`);
    // day.hours: the busiest hour
    const h = currentOf(res, 'day.hours');
    assert.equal(h.detail.peakHour, `${LAST}T11:00:00.000Z`);
    near(h.value, (50 / TOTAL) * 100, 'peak hour share');
    assert.equal(Object.keys(h.detail.unitsByHour).length, 5);
    // day.excludedShare: what the user's exclusion removed, by rule (the Fable tree, 50 units)
    const e = currentOf(res, 'day.excludedShare');
    near(e.value, (50 / TOTAL) * 100, 'excluded share');
    near(e.detail.rules['fable-tree'].units, 50, 'fable-tree units');
    assert.equal(e.detail.rules['fable-tree'].scope, 'tree');
    // the runner's exclusions section carries the same rule and its share of the weekly limit
    const row0 = res.exclusions.rows.find((x) => x.name === 'fable-tree');
    near(row0.units, 50, 'exclusion row units');
    assert.ok(Math.abs(row0.pctOfWeeklyLimit - (50 / 2677) * 100) < 1e-3, 'exclusion % of the weekly limit');
  } finally { fx.cleanup(); }
});

test('lead metrics on the fixture day (shipped scenarios: lead cohort, no exclusions)', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root);
    run(root);
    const res = readResult(root, LAST);
    // the lead cohort: sess-lead-1, sess-lead-2, sess-fable. units 30 + 6 + 50 = 86; main 20 + 6 + 50 = 76;
    // prompts 4 + 2 + 1 = 7; tasks (prompts of 60+ characters) 3 + 1 + 0 = 4; Agent calls 3 + 1 = 4; commit calls 3; flags 1
    const v = (id) => currentOf(res, id);
    near(v('lead.unitsPerPrompt').value, 86 / 7, 'units per prompt');
    assert.equal(v('lead.unitsPerPrompt').sample, 7);
    near(v('lead.threadShare').value, (76 / 86) * 100, 'thread share');
    near(v('lead.threadUnitsPerPrompt').value, 76 / 7, 'thread units per prompt');
    near(v('lead.unitsPerTask').value, 86 / 4, 'units per task');
    near(v('lead.workersPerTask').value, 1, 'workers per task');
    near(v('lead.workersPerPrompt').value, 4 / 7, 'workers per prompt');
    near(v('lead.modelMix').value, (20 / 86) * 100, 'opus share');
    near(v('lead.modelMixSonnet').value, (16 / 86) * 100, 'sonnet share');
    near(v('lead.unitsPerCommitCall').value, 86 / 3, 'units per commit call');
    near(v('lead.correctionFlags').value, (1 / 7) * 100, 'correction flags per 100');
    // lead.rework: sp2 is a re-spawn of sp1 within 6 h (6 units); sp3 is 9.5 h later and is not one
    const rw = v('lead.rework');
    assert.equal(rw.value, 6);
    assert.equal(rw.detail.respawns, 1);
    assert.equal(rw.detail.spawns, 5);
    // the baseline days are the same fixture, so the trailing-7 baseline matches the day (7 prompts is under the shipped minSample, so no verdict)
    const cmp0 = scenarioOf(res, 'lead.unitsPerPrompt').comparisons[0];
    near(cmp0.baseline.value, 86 / 7, 'trailing-7 baseline');
    assert.notEqual(scenarioOf(res, 'lead.unitsPerPrompt').status, 'regression');
    // lead.byObservedEffort: grouped by observed effort; the desktop records are not available, so the one group says so
    const g = scenarioOf(res, 'lead.unitsPerPromptByEffort');
    assert.deepEqual(g.groups.map((x) => x.key), ['(unobservable)']);
    // register metrics with an adapter: main units, and main units per spawn
    const reg = getMetric('mainUnitsPerDay');
    assert.ok(reg);
  } finally { fx.cleanup(); }
});

test('exclusions in the user layer reach the lead metrics; a window comparison pools the days inside it', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root);
    const lead = { class: ['lead'] };
    const mk = (id, metric, extra = {}) => ({
      id, title: id, metric, cohort: lead, excludeSets: ['fable-tree'], compare: [{ window: 'w-now', vs: 'w-before' }],
      threshold: { direction: 'up-is-worse', minSample: 1 }, severity: 'info', cadence: 'daily', ...extra,
    });
    userConfig(root, {
      windows: { 'w-before': { from: '2026-10-07T08:00:00Z', to: '2026-10-09T08:00:00Z' }, 'w-now': { from: '2026-10-09T08:00:00Z', to: '2026-10-11T08:00:00Z' } },
      exclusions: { 'fable-tree': { model: ['claude-fable-*'], scope: 'tree' } },
      scenarios: [mk('u.t.unitsPerPrompt', 'lead.unitsPerPrompt'), mk('u.t.threadShare', 'lead.threadShare'), mk('u.t.mix', 'lead.modelMix', { params: { family: 'opus' } })],
    });
    run(root);
    const res = readResult(root, LAST);
    const cmp = (id) => scenarioOf(res, id).comparisons[0];
    // without the Fable tree: units 30 + 6 = 36, prompts 4 + 2 = 6, thread 26, opus 20; two days a side (the same figure every day)
    const a = cmp('u.t.unitsPerPrompt');
    near(a.current.value, 6, 'units per prompt without the excluded tree');
    near(a.baseline.value, 6, 'baseline');
    assert.equal(a.current.days.length, 2);
    assert.equal(a.current.den, 12, 'two days of 6 prompts');
    assert.equal(a.status, 'ok');
    near(cmp('u.t.threadShare').current.value, (26 / 36) * 100, 'thread share without the excluded tree');
    near(cmp('u.t.mix').current.value, (20 / 36) * 100, 'opus share without the excluded tree');
    assert.equal(scenarioOf(res, 'u.t.unitsPerPrompt').meta.excluded['fable-tree'].records, 1);
  } finally { fx.cleanup(); }
});

test('missing inputs are gaps with a reason, never zeros: no history, no meter sample, a partial week, no spawns', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root);
    // no history and no meter file at all
    run(root);
    let res = readResult(root, LAST);
    const why = (id) => scenarioOf(res, id).comparisons[0].why || '';
    assert.match(why('week.pace'), /gap|no value|history/i);
    assert.match(scenarioOf(res, 'week.pace').comparisons[0].status, /gap/);
    assert.equal(scenarioOf(res, 'meter.reconcile').comparisons[0].status, 'gap');
    assert.equal(scenarioOf(res, 'day.limitHits').comparisons[0].status === 'gap' || scenarioOf(res, 'day.limitHits').comparisons[0].current === undefined, true);
    assert.ok(res.gaps.some((g) => g.id === 'week.pace'), 'listed among the gaps');

    // history, but no meter sample in the day, then a sample from another plan week, then a partial week
    writeHistory(root, [historyLine(LAST)]);
    run(root);
    res = readResult(root, LAST);
    near(currentOf(res, 'week.pace').value, 120, 'week.pace now has a value');
    assert.equal(res.revision, 2, 'new history revises the day');
    const m1 = scenarioOf(res, 'meter.reconcile').comparisons[0];
    assert.equal(m1.status, 'gap');
    assert.match(m1.why, /no plan-meter sample|unusable|baseline|day itself/i);
    writeMeter(root, [meterLine('2026-10-10T20:00:00.000Z', 11, RESETS_AT + 7 * 86400)]);
    run(root);
    res = readResult(root, LAST);
    assert.equal(scenarioOf(res, 'meter.reconcile').comparisons[0].status, 'gap');
    assert.match(scenarioOf(res, 'meter.reconcile').comparisons[0].why, /another plan week/);
    writeHistory(root, [historyLine(LAST, { partial: true })]);
    run(root);
    res = readResult(root, LAST);
    assert.match(scenarioOf(res, 'week.pace').comparisons[0].why, /partial/);
  } finally { fx.cleanup(); }
});

test('a changed plan-meter sample revises the day and says why', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root);
    writeHistory(root, [historyLine(LAST)]);
    writeMeter(root, [meterLine('2026-10-10T20:00:00.000Z', 11)]);
    run(root);
    assert.equal(readResult(root, LAST).revision, 1);
    near(currentOf(readResult(root, LAST), 'meter.reconcile').value, 0, 'first');
    appendFileSync(join(root, 'state', 'plan-meter-samples.jsonl'), `${meterLine('2026-10-10T21:00:00.000Z', 14)}\n`);
    run(root);
    const res = readResult(root, LAST);
    assert.equal(res.revision, 2);
    assert.match(res.revisions[res.revisions.length - 1].reason, /plan meter sample changed/);
    // the sample at 21:00Z: local = 12 - (units after 22:00Z, the late row = 1%) = 11, against 14: a gap of 3 points
    near(currentOf(res, 'meter.reconcile').value, 3, 'new gap');
    near(currentOf(res, 'meter.reconcile').detail.signedGapPoints, -3, 'signed: the meter is above the local figure (cloud use)');
    // an unchanged run writes nothing new
    run(root);
    assert.equal(readResult(root, LAST).revision, 2);
  } finally { fx.cleanup(); }
});

test('the adapters of the batch-1 register metrics inside these sections', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, { from: LAST, to: LAST });
    const hooks = makeHooks({ store: { read: () => ({ gap: true }) } });
    assert.equal(typeof hooks.dayRecords, 'function');
    userConfig(root, {
      scenarios: [
        { id: 'u.t.mainUnits', metric: 'mainUnitsPerDay', compare: ['prior-day'], threshold: { minSample: 1 }, severity: 'info' },
        { id: 'u.t.mainPerSpawn', metric: 'mainUnitsPerLeadSpawn', compare: ['prior-day'], threshold: { minSample: 1 }, severity: 'info' },
      ],
    });
    run(root);
    const res = readResult(root, LAST);
    // main-thread units: 20 + 6 + 50 + 5 + LATE; five spawn records
    near(currentOf(res, 'u.t.mainUnits').value, 81 + LATE, 'main units');
    near(currentOf(res, 'u.t.mainPerSpawn').value, (81 + LATE) / 5, 'main units per spawn');
  } finally { fx.cleanup(); }
});

test('respawnFlags: same session, same key, within six hours; the first spawn and a distant one are not re-spawns', () => {
  const S = (sid, id, startMs, rk) => ({ sid, id, startMs, rk });
  const h = 3600000;
  const a = S('sess-a', '1', 0, { n: 'x' });
  const b = S('sess-a', '2', 2 * h, { n: 'x' });
  const c = S('sess-a', '3', 12 * h, { n: 'x' });
  const d = S('sess-b', '4', 3 * h, { n: 'x' }); // another session
  const e = S('sess-a', '5', 3 * h, { d: 'desc' });
  const f = S('sess-a', '6', 4 * h, { d: 'desc' }); // same description hash
  const flagged = respawnFlags([f, a, d, c, b, e]);
  assert.deepEqual([...flagged].map((s) => s.id).sort(), ['2', '6']);
  assert.equal(respawnFlags([]).size, 0);
});

test('stat() adapters: gaps for zero denominators and unsupported parameters', () => {
  const lead = { kind: 'session', sid: 'sess-x', units: { main: 2, sub: 0, total: 2 }, byModel: {}, tok: {}, pr: { n: 0, len: [0, 0, 0, 0], corr: 0 }, ag: 0, gc: 0 };
  assert.equal(getMetric('lead.unitsPerPrompt').stat([lead], {}).gap, true, 'no prompts: a gap');
  assert.equal(getMetric('lead.unitsPerCommitCall').stat([lead], {}).gap, true, 'no commit calls: a gap');
  assert.equal(getMetric('lead.unitsPerTask').stat([{ ...lead, pr: { n: 3, len: [3, 0, 0, 0], corr: 0 } }], { params: {} }).gap, true, 'no long prompt, no task');
  assert.match(getMetric('lead.unitsPerTask').stat([lead], { params: { taskMinChars: 100 } }).why, /60-character/);
  assert.equal(getMetric('lead.unitsPerPrompt').stat([], {}).gap, true, 'no sessions: a gap');
  assert.equal(getMetric('week.pace').stat([], {}).gap, true, 'no day record: a gap');
  assert.equal(getMetric('meter.reconcile').stat([{ kind: 'day', hist: { week: { pctSoFar: 5 } }, meter: null }], {}).gap, true);
  assert.equal(getMetric('day.units').stat([], {}).gap, true);
  assert.equal(getMetric('day.byClass').stat([{ ...lead, units: { main: 0, sub: 0, total: 0 } }], { params: {} }).gap, true, 'a day without units');
  assert.equal(getMetric('lead.rework').stat([], { params: {} }).gap, true);
  // corrections and cost per correction need rater labels (batch 10): no adapter yet
  assert.equal(getMetric('lead.corrections'), null);
  assert.equal(getMetric('lead.costPerCorrection'), null);
});

test('the new library files make no model call, start no process and never wait', () => {
  for (const rel of ['scripts/lib/usage/metrics/day.mjs', 'scripts/lib/usage/metrics/lead.mjs']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(!/child_process/.test(src), `${rel} starts no process of its own`);
    assert.ok(!/setTimeout|setInterval|Atomics\.wait|sleep\(/.test(src), `${rel} never waits`);
    assert.ok(!/['"`]claude['"`]|claude -p|api\.anthropic/.test(src), `${rel} makes no model call`);
  }
  // the metric files do no I/O at all
  for (const rel of ['scripts/lib/usage/metrics/day.mjs', 'scripts/lib/usage/metrics/lead.mjs']) {
    assert.ok(!/node:fs|node:os|node:path/.test(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')), `${rel} is pure`);
  }
});
