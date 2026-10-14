// Regression tests for the 0.31.18 core-b review fixes (comparison engine, runner, report):
//   1. exclusion scope "session" keeps the session's worker (spawn) records; "tree" removes them
//   2. the summary never says "regressions: none" when nothing was evaluated
//   4. a metric without a stat() adapter is a gap on every day, whatever the cadence
//   5. the report names unobservable exclusions ("name: n"), never "[object Object]"
//   6. a settled day with a facts file and zero sessions is a real 0 for sum metrics, a gap for ratio metrics
// Synthetic facts in a temp root; nothing reads the operator's data.
import { makeFixture } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { addDays, dayRange } from '../scripts/lib/usage/days.mjs';
import { applyExclusions, makeFactsLoader, factsFilePath } from '../scripts/lib/usage/cohort.mjs';
import { runAnalysis, readResult, reportPathFor, makeHooks } from '../scripts/lib/usage/runner.mjs';
import { renderReport, summaryLines } from '../scripts/lib/usage/report.mjs';

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const NOW = Date.parse('2026-10-11T12:00:00Z'); // 2026-10-10 is the last closed, settled day (a Saturday: no week reset in it)
const tok = (u) => [u, 0, 0, 0, 0, 1];
const zero = () => [0, 0, 0, 0, 0, 0];

function row(hourIso, sid, units, { sub = 0 } = {}) {
  return { hour: hourIso, sid, proj: 'alpha', cwd: null, tok: { [SONNET]: { m: tok(units), s: sub ? tok(sub) : zero() } }, pr: { n: 1, len: [1, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0 };
}
function spawnRec(day, sid, id, units = 50) {
  return {
    id, sid, aid: `a-${id}`, proj: 'alpha', type: 'bounded-feature', role: 'writer', rung: 'sonnet/high', fit: 'ok', model: SONNET, mixed: false,
    start: `${day}T10:00:00.000Z`, end: `${day}T10:20:00.000Z`, partial: false, req: { n: 8, bucket: '6-15', cat: {} },
    ctx: { buckets: [tok(units), zero(), zero(), zero()], peak: 90000 }, startup: zero(), comp: { n: 0, after: null }, extraTurns: 0, status: 'done',
    simple: { runs: 0, req: 0, tok: zero() }, rk: { d: null, n: null, h: null },
  };
}
function writeFacts(root, day, rows, { spawns = [] } = {}) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${addDays(day, 1)}T08:00:00.000Z`, dataThrough: `${addDays(day, 1)}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${addDays(day, 1)}T09:00:00.000Z`, weightsUsed: { [SONNET]: { ...SPEC } }, rows, spawns,
  }));
}
const avgOf = (day) => 10 + Number(day.slice(8, 10));
function seedDays(root, from, to, { skip = [], n = 3 } = {}) {
  for (const day of dayRange(from, to)) {
    if (skip.includes(day)) continue;
    writeFacts(root, day, Array.from({ length: n }, (_, i) => row(`${day}T10:00:00.000Z`, `sess-${day}-${i}`, avgOf(day))));
  }
}
const dayUnits = { id: 'day.units', pool: 'sum', direction: 'up-is-worse', label: 'M', recordKinds: ['session'],
  stat: (recs) => ({ num: recs.reduce((s, r) => s + r.units.total, 0), den: 1, scale: 1, sample: recs.length }) };
const perSession = { id: 'test.perSession', pool: 'ratio', direction: 'up-is-worse', label: 'M', recordKinds: ['session'],
  stat: (recs) => ({ num: recs.reduce((s, r) => s + r.units.total, 0), den: recs.length, scale: 1, sample: recs.length }) };
const METRICS = (id) => ({ 'day.units': dayUnits, 'test.perSession': perSession })[id] || null;
const run = (root, extra = {}) => runAnalysis({ root, nowT: NOW, metrics: METRICS, cwds: [], ...extra });
function userConfig(root, scenarios, extra = {}) {
  const file = join(root, 'config', 'usage-analysis.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 'agent-companion/usage-analysis', schemaVersion: 1, scenarios, ...extra }));
}
const SC = (over = {}) => ({ id: 'u.units', title: 'Units', metric: 'day.units', compare: ['prior-day'], threshold: { direction: 'up-is-worse', relPct: 25, minSample: 1 }, severity: 'alert', ...over });
const compOf = (root, id, day = '2026-10-10') => readResult(root, day).scenarios.find((s) => s.id === id).comparisons[0];

// ---------------------------------------------------------------- 1. scope --

function loadFor(root, day) {
  const hooks = makeHooks({ store: { read: (d) => ({ facts: JSON.parse(readFileSync(factsFilePath(root, d), 'utf8')) }) }, environment: {}, routineFolders: [] });
  return makeFactsLoader({ root, hooks })(day);
}

test('exclusion scope "session" removes the session record only: its spawn records stay; "tree" removes them', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const day = '2026-10-10';
    writeFacts(root, day, [row(`${day}T10:00:00.000Z`, 'sess-a', 100, { sub: 40 }), row(`${day}T10:00:00.000Z`, 'sess-b', 10)], { spawns: [spawnRec(day, 'sess-a', 'sp1', 40)] });
    const L = loadFor(root, day);
    const one = applyExclusions(L.records, ['one'], { one: { sessionId: ['sess-a'], scope: 'session' } });
    assert.ok(one.kept.some((r) => r.kind === 'spawn' && r.sid === 'sess-a'), 'the worker record survives a session-scoped exclusion of its lead');
    const lead = one.kept.find((r) => r.kind === 'session' && r.sid === 'sess-a');
    assert.equal(lead.units.main, 0);
    assert.equal(lead.units.total, 40, 'workers stay inside the lead record');
    assert.equal(one.report.one.records, 1, 'only the session record is counted as removed');
    assert.equal(one.report.one.units, 100);

    const tree = applyExclusions(L.records, ['one'], { one: { sessionId: ['sess-a'], scope: 'tree' } });
    assert.ok(!tree.kept.some((r) => r.sid === 'sess-a'), 'tree scope removes the session and its workers');
    assert.ok(tree.kept.some((r) => r.sid === 'sess-b'));
  } finally { fx.cleanup(); }
});

test('exclusion scope "session" still removes a spawn record the rule names by a field only spawns carry (declaredType)', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const day = '2026-10-10';
    writeFacts(root, day, [row(`${day}T10:00:00.000Z`, 'sess-a', 100)], { spawns: [spawnRec(day, 'sess-a', 'sp1', 40)] });
    const L = loadFor(root, day);
    const spawn = L.records.find((r) => r.kind === 'spawn');
    const ex = applyExclusions(L.records, ['t'], { t: { declaredType: [spawn.declaredType ?? 'bounded-feature'], scope: 'session' } });
    if (spawn.declaredType !== undefined) assert.ok(!ex.kept.some((r) => r.kind === 'spawn'), 'a rule on the spawn own field removes the spawn record');
    assert.ok(ex.kept.some((r) => r.kind === 'session' && r.sid === 'sess-a'), 'the session record is not what that rule names');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- 2. summary --

test('summary never says "regressions: none" when no scenario was evaluated; it counts evaluated and gaps', () => {
  const allGaps = { day: '2026-10-10', totals: { units: 10, pctOfWeeklyLimit: 1 }, regressions: [],
    scenarios: [{ id: 'a', skipped: 'gap' }, { id: 'b', skipped: 'gap' }, { id: 'c', skipped: 'disabled' }, { id: 'd', skipped: 'not-due' }] };
  const l2 = summaryLines(allGaps)[1];
  assert.ok(!/regressions: none/.test(l2), l2);
  assert.match(l2, /0 scenarios evaluated/);
  assert.match(l2, /2 gaps/);

  const noScenarios = summaryLines({ day: '2026-10-10', regressions: [], scenarios: [] })[1];
  assert.ok(!/regressions: none/.test(noScenarios), noScenarios);
  assert.match(noScenarios, /0 scenarios evaluated/);

  const some = summaryLines({ day: '2026-10-10', regressions: [], scenarios: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'ok' }, { id: 'c', skipped: 'gap' }, { id: 'd', status: 'gap' }] })[1];
  assert.match(some, /^regressions: none \(2 scenarios evaluated, 2 gaps\)$/);
});

test('through the runner: a day on which every scenario is a gap reads "n/a", not "none"', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    userConfig(root, [SC({ id: 'u.x.a', metric: 'spawn.simpleRuns' })]);
    run(root);
    const res = readResult(root, '2026-10-10');
    assert.ok(!summaryLines(res)[1].startsWith('regressions: none'), summaryLines(res)[1]);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- 4. cadence --

test('a metric without a stat() adapter is a gap on a non-reset day even when the scenario is weekly; a weekly scenario with an adapter stays not-due', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    userConfig(root, [
      SC({ id: 'u.w.noadapter', metric: 'spawn.simpleRuns', cadence: 'weekly' }),
      SC({ id: 'u.w.adapter', metric: 'day.units', cadence: 'weekly' }),
      SC({ id: 'u.d.noadapter', metric: 'spawn.simpleRuns', cadence: 'daily' }),
    ]);
    const out = run(root);
    assert.equal(out.error, undefined);
    const res = readResult(root, '2026-10-10');
    const by = (id) => res.scenarios.find((s) => s.id === id);
    assert.equal(by('u.w.noadapter').skipped, 'gap');
    assert.equal(by('u.d.noadapter').skipped, 'gap');
    assert.equal(by('u.w.adapter').skipped, 'not-due');
    const gapIds = res.gaps.map((g) => g.id);
    assert.ok(gapIds.includes('u.w.noadapter') && gapIds.includes('u.d.noadapter'));
    assert.ok(!gapIds.includes('u.w.adapter'), 'not-due is not a gap');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- 5. report --

test('the report names exclusions that could not be judged as "name: n", never "[object Object]"', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    run(root);
    const res = readResult(root, '2026-10-10');
    const rows = [{ name: 'big', scope: 'tree', records: 1, units: 5, pctOfWeeklyLimit: 0.1, why: 'test' }];
    const text = renderReport({ ...res, exclusions: { rows, unobservable: { zeta: 2, alpha: 7 }, undefinedRules: [] } });
    assert.ok(!text.includes('[object Object]'));
    assert.ok(text.includes('could not be judged on (unobservable, so not excluded): alpha: 7, zeta: 2.'), text);
    const none = renderReport({ ...res, exclusions: { rows, unobservable: {}, undefinedRules: [] } });
    assert.ok(!none.includes('[object Object]'));
    assert.ok(!none.includes('could not be judged'), 'an empty map prints no line');
  } finally { fx.cleanup(); }
});

test('through the runner: an exclusion unobservable on some records is listed by name', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    userConfig(root, [SC({ excludeSets: ['byclass'], metric: 'test.perSession', id: 'u.sp' })], { exclusions: { byclass: { class: ['routine'], scope: 'session' } } });
    run(root);
    const text = readFileSync(reportPathFor(root, '2026-10-10'), 'utf8');
    assert.ok(!text.includes('[object Object]'));
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- 6. empty day --

test('a settled day with a facts file and zero sessions is a real 0 for a sum metric; with no facts file it stays a gap', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    writeFacts(root, '2026-10-09', []); // facts present, no usage: a real 0
    userConfig(root, [SC({ compare: ['prior-day'] })]);
    run(root);
    const c = compOf(root, 'u.units');
    assert.notEqual(c.status, 'gap', `prior-day vs an empty-but-present day: ${c.status} ${c.why}`);
    assert.equal(c.baseline.value, 0, 'the empty day counts as 0 u, not as a missing baseline');
  } finally { fx.cleanup(); }

  const fx2 = makeFixture();
  try {
    const root = fx2.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10', { skip: ['2026-10-09'] }); // no facts file at all
    userConfig(root, [SC({ compare: ['prior-day'] })]);
    run(root);
    const c = compOf(root, 'u.units');
    assert.equal(c.status, 'gap');
  } finally { fx2.cleanup(); }
});

test('the empty-day zero is a baseline day in a trailing-7 pool (not left out)', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    writeFacts(root, '2026-10-08', []);
    writeFacts(root, '2026-10-09', []);
    userConfig(root, [SC({ compare: ['trailing-7'] })]);
    run(root);
    const c = compOf(root, 'u.units');
    assert.equal(c.baseline.days.length, 7, 'both quiet days are usable baseline days');
  } finally { fx.cleanup(); }
});

test('a zero denominator stays a gap: a ratio metric on a day with zero sessions', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    writeFacts(root, '2026-10-09', []);
    userConfig(root, [SC({ id: 'u.r.per', metric: 'test.perSession', compare: ['prior-day'] })]);
    run(root);
    const c = compOf(root, 'u.r.per');
    assert.equal(c.status, 'gap');
  } finally { fx.cleanup(); }
});

test('a cohort that removes every record of a non-quiet day is still a gap, not a 0', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    userConfig(root, [SC({ id: 'u.c.none', cohort: { project: ['no-such-project'] }, compare: ['prior-day'] })]);
    run(root);
    const c = compOf(root, 'u.c.none');
    assert.equal(c.status, 'gap');
  } finally { fx.cleanup(); }
});

test('an empty-day facts file that is deferred (partial: the scan began mid-day) stays a gap', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, '2026-10-01', '2026-10-10');
    writeFacts(root, '2026-10-09', []);
    const p = factsFilePath(root, '2026-10-09');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    j.scanFrom = '2026-10-09T12:00:00.000Z';
    writeFileSync(p, JSON.stringify(j));
    userConfig(root, [SC({ compare: ['prior-day'] })]);
    run(root);
    const c = compOf(root, 'u.units');
    assert.equal(c.status, 'gap');
  } finally { fx.cleanup(); }
});
