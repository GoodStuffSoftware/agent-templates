// The decision register core (scripts/lib/decision-register.mjs, scripts/decision-register.mjs):
// schema and validator, changelog scan, the seen-set and streak state, the detail file, the
// SessionStart hook's pending line, fail-open behaviour, privacy and the CLI. Fixtures are
// synthetic with fixed 2026 timestamps; nothing reads the operator's register, transcripts or
// network. Metric and exercise evaluation are covered by the test file of the worker that
// implements them; here they are driven through injected evaluators.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import {
  validateRegister, loadRegister, registerPath, statePath, detailPath, scanChangelog, evaluateTriggers,
  readState, writeState, emptyState, runRegister, markSeen, SEEN_CAP, pendingFlags, pendingLine,
  markFlagsSurfaced, snapshotState, writeStateMerged, scanChangelogToState, formatRegisterLine, writeDetail, detailMarkdown, triggerRev, foldDays, freezeBaseline,
  EVALUATORS, METRIC_CATALOG, LINE_MAX, evalMetric, evalExercise, matchesWhere,
} from '../scripts/lib/decision-register.mjs';

const T = (s) => Date.parse(s);
const NOW = T('2026-10-12T10:00:00Z');
const HOUR = 3600000;
const EXAMPLE = join(PLUGIN_ROOT, 'config', 'decision-register.example.json');
const ROLLOUT = { 'staged-one': T('2026-10-10T08:00:00Z') };

const clone = (x) => JSON.parse(JSON.stringify(x));

function changelogTrigger(over = {}) {
  return { id: 'cl', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.296', flags: 'i', pattern: '\\bcache ttl\\b', ...over };
}
function metricTrigger(over = {}) {
  return {
    id: 'mt', premise: 'p1', kind: 'metric', source: 'history', metric: 'compactionsPer100Spawns', params: {},
    op: '>', threshold: 1.25, minSample: 5, minDays: 2, ...over,
  };
}
function decision(over = {}) {
  return {
    id: 'dec-one', title: 'Decision one', status: 'active', decided: '2026-10-10', decision: 'What is standing.',
    reverse: 'How to undo it.', premises: [{ id: 'p1', text: 'The claim.', label: 'M' }], evidence: ['notes/evidence.md'],
    triggers: [changelogTrigger(), metricTrigger()], ...over,
  };
}
function register(decisions = [decision()]) {
  return { schema: 'agent-companion/decision-register', version: 1, decisions };
}
const valid = (reg, rollout = ROLLOUT) => validateRegister(reg, { rollout });

// An evaluator that reports whatever `script.days` / `script.events` hold now.
function scripted() {
  const script = { days: null, events: null, ready: undefined, value: undefined, n: undefined };
  const fn = () => {
    const v = {};
    if (script.days) v.days = script.days;
    if (script.events) v.events = script.events;
    if (script.ready !== undefined) v.ready = script.ready;
    if (script.value !== undefined) v.value = script.value;
    if (script.n !== undefined) v.n = script.n;
    return v;
  };
  return { script, evaluators: { changelog: () => null, metric: fn, exercise: fn } };
}
const day = (d, hit, extra = {}) => ({ day: d, qualifies: true, hit, value: hit ? 2 : 0.5, n: 10, ...extra });

// ---------------------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------------------

test('1. the shipped example validates, with no rollout table at all', () => {
  const obj = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  assert.deepEqual(validateRegister(obj, { rollout: {} }), { ok: true, errors: [] });
  const loaded = loadRegister(EXAMPLE);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.register.decisions.length, 1);
  assert.equal(loaded.register.decisions[0].id, 'example-decision');
});

test('1. every error class reports', () => {
  const cases = [
    ['duplicate decision ids', (r) => { r.decisions.push(clone(r.decisions[0])); }, /duplicate decision id/],
    ['duplicate trigger ids', (r) => { r.decisions[0].triggers[1].id = 'cl'; }, /duplicate trigger id/],
    ['duplicate premise ids', (r) => { r.decisions[0].premises.push({ id: 'p1', text: 'again', label: 'E' }); }, /duplicate premise id/],
    ['bad regex', (r) => { r.decisions[0].triggers[0].pattern = '(unclosed'; }, /does not compile/],
    ['unknown metric', (r) => { r.decisions[0].triggers[1].metric = 'vibes'; }, /unknown metric/],
    ['metric on the wrong source', (r) => { r.decisions[0].triggers[1].source = 'spawns'; }, /reads source "history"/],
    ['unknown trigger kind', (r) => { r.decisions[0].triggers[1].kind = 'telepathy'; }, /unknown trigger kind/],
    ['trigger names a missing premise', (r) => { r.decisions[0].triggers[0].premise = 'p9'; }, /names no premise/],
    ['non-finite threshold', (r) => { r.decisions[0].triggers[1].threshold = null; }, /threshold must be a finite number/],
    ['bad op', (r) => { r.decisions[0].triggers[1].op = '=='; }, /op must be one of/],
    ['bad sinceVersion', (r) => { r.decisions[0].triggers[0].sinceVersion = 'latest'; }, /sinceVersion must be a version/],
    ['bad premise label', (r) => { r.decisions[0].premises[0].label = 'X'; }, /label must be M/],
    ['title too long', (r) => { r.decisions[0].title = 'x'.repeat(61); }, /max 60/],
    ['bad status', (r) => { r.decisions[0].status = 'paused'; }, /status must be/],
    ['bad id', (r) => { r.decisions[0].id = 'Not Kebab'; }, /kebab-case/],
    ['bad decided date', (r) => { r.decisions[0].decided = '10/10/2026'; }, /decided must be/],
    ['no premises', (r) => { r.decisions[0].premises = []; }, /premises must be a non-empty list/],
    ['wrong schema name', (r) => { r.schema = 'something/else'; }, /schema must be/],
    ['baseline without a rolloutId', (r) => { r.decisions[0].triggers[1].baseline = { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5 }; }, /requires the decision to name a rolloutId/],
    ['rolloutId not in the table', (r) => {
      r.decisions[0].rolloutId = 'nope';
      r.decisions[0].triggers[1].baseline = { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5 };
    }, /not in the rollout table/],
    ['metric params missing', (r) => { r.decisions[0].triggers[1].metric = 'unitsPerSpawn'; }, /needs params\.type or params\.rung/],
    ['exercise without a rolloutId', (r) => {
      r.decisions[0].triggers.push({ id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 7, where: {}, expect: {} });
    }, /requires the decision to name a rolloutId/],
    ['exercise afterDays', (r) => {
      r.decisions[0].rolloutId = 'staged-one';
      r.decisions[0].triggers.push({ id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 0, where: {}, expect: {} });
    }, /afterDays must be a number > 0/],
    ['exercise predicate type', (r) => {
      r.decisions[0].rolloutId = 'staged-one';
      r.decisions[0].triggers.push({ id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 3, where: { callerTypeIn: 'oops' }, expect: {} });
    }, /where\.callerTypeIn must be a list of strings/],
  ];
  for (const [name, mutate, re] of cases) {
    const r = register();
    mutate(r);
    const v = valid(r);
    assert.equal(v.ok, false, `${name}: should be invalid`);
    assert.ok(v.errors.some((e) => re.test(e)), `${name}: wanted ${re}, got ${JSON.stringify(v.errors)}`);
  }
});

test('1. a staged exercise and a baselined metric validate once the rollout id exists', () => {
  const r = register();
  r.decisions[0].rolloutId = 'staged-one';
  r.decisions[0].triggers.push(
    metricTrigger({ id: 'mb', baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5 }, post: { minDays: 2 } }),
    { id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 7, where: { declared_type: 'code-review', callerTypeNotIn: ['a'], callerTypeKnown: true }, expect: { effective_effort: 'high' } },
  );
  assert.deepEqual(valid(r), { ok: true, errors: [] });
  assert.equal(valid(r, {}).ok, false);
});

test('1. the metric catalog names are the eight of the spec', () => {
  assert.deepEqual(Object.keys(METRIC_CATALOG).sort(), [
    'ceilingNudgesPerDay', 'compactionsPer100Spawns', 'haikuSpawns', 'leadEffortShare', 'mainUnitsPerDay',
    'reviewsPerWriter', 'shareOver150kPct', 'unitsPerSpawn',
  ]);
});

test('1. an unknown register version is invalid; garbage never throws', () => {
  const r = register();
  r.version = 2;
  assert.equal(valid(r).ok, false);
  assert.match(valid(r).errors.join('\n'), /unsupported version/);
  for (const junk of [null, undefined, 5, 'x', [], {}, { schema: 'agent-companion/decision-register', version: 1, decisions: [null, 3, {}] }]) {
    const v = validateRegister(junk, { rollout: {} });
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.errors) && v.errors.length > 0);
  }
});

test('1. the default rollout table is the live rollout.json', () => {
  const fx = makeFixture();
  try {
    const r = register();
    r.decisions[0].rolloutId = 'staged-one';
    r.decisions[0].triggers[1] = metricTrigger({ baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5 } });
    assert.equal(validateRegister(r).ok, false);
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ 'staged-one': '2026-10-10T08:00:00Z' }));
    assert.equal(validateRegister(r).ok, true);
  } finally { fx.cleanup(); }
});

test('1. loadRegister: missing file is {ok:false, absent:true} and silent; bad JSON and invalid content report', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(loadRegister(registerPath()), { ok: false, absent: true });
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), '{ not json');
    const bad = loadRegister();
    assert.equal(bad.ok, false);
    assert.equal(bad.absent, undefined);
    assert.match(bad.errors[0], /not valid JSON/);
    const r = register();
    r.decisions[0].status = 'paused';
    writeFileSync(registerPath(), JSON.stringify(r));
    assert.equal(loadRegister().ok, false);
    writeFileSync(registerPath(), `\uFEFF${JSON.stringify(register())}`);
    assert.equal(loadRegister().ok, true, 'a BOM is tolerated');
    assert.ok(registerPath().replace(/\\/g, '/').endsWith('/config/decision-register.json'));
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 2. Changelog triggers
// ---------------------------------------------------------------------------------------

const RELEASES = [
  { version: '2.1.299', items: ['Fixed a crash', 'Changed the cache TTL for subagents to one hour'] },
  { version: '2.1.297', items: ['Added a thing', 'Tweaked the CACHE ttl display'] },
  { version: '2.1.296', items: ['The cache ttl was documented'] },
  { version: '2.1.290', items: ['The cache ttl existed already'] },
];

test('2. only releases strictly newer than sinceVersion are scanned, and full item text is tested', () => {
  const state = emptyState();
  const reg = register([decision({ triggers: [changelogTrigger()] })]);
  const fresh = scanChangelog(RELEASES, reg, state, { nowT: NOW });
  assert.deepEqual(fresh.sort(), ['dec-one/cl@2.1.297', 'dec-one/cl@2.1.299']);
  assert.equal(state.changelogHits['dec-one/cl@2.1.299'].item, 'Changed the cache TTL for subagents to one hour');
  assert.equal(state.changelogHits['dec-one/cl@2.1.296'], undefined, 'equal to sinceVersion is not newer');
  assert.equal(state.changelogHits['dec-one/cl@2.1.290'], undefined);
  assert.equal(state.flags['dec-one/cl@2.1.299'].kind, 'changelog');
  assert.equal(state.flags['dec-one/cl@2.1.299'].day, '2026-10-12', 'a changelog hit flags at once');
});

test('2. the item text is complete (an item no topic filter would keep) and capped at 300 chars', () => {
  const long = `Nothing about topics ${'x'.repeat(400)} cache ttl`;
  const state = emptyState();
  const reg = register([decision({ triggers: [changelogTrigger({ pattern: 'nothing about topics' })] })]);
  scanChangelog([{ version: '2.1.300', items: [long] }], reg, state, { nowT: NOW });
  assert.equal(state.changelogHits['dec-one/cl@2.1.300'].item.length, 300);
});

test('2. the same item twice is one key; a rescan adds nothing; a version seen twice counts once', () => {
  const state = emptyState();
  const reg = register([decision({ triggers: [changelogTrigger()] })]);
  const twice = [{ version: '2.1.300', items: ['cache ttl one', 'cache ttl one'] }, { version: '2.1.300', items: ['cache ttl two'] }];
  assert.equal(scanChangelog(twice, reg, state, { nowT: NOW }).length, 1);
  assert.equal(state.changelogHits['dec-one/cl@2.1.300'].count, 2);
  assert.deepEqual(scanChangelog(twice, reg, state, { nowT: NOW + HOUR }), []);
  assert.equal(Object.keys(state.changelogHits).length, 1);
  assert.equal(state.seen.filter((k) => k === 'dec-one/cl@2.1.300').length, 1);
});

test('2. minHits is respected', () => {
  const state = emptyState();
  const reg = register([decision({ triggers: [changelogTrigger({ minHits: 2 })] })]);
  assert.deepEqual(scanChangelog([{ version: '2.1.300', items: ['cache ttl one', 'unrelated'] }], reg, state, { nowT: NOW }), []);
  assert.equal(scanChangelog([{ version: '2.1.301', items: ['cache ttl one', 'cache ttl two'] }], reg, state, { nowT: NOW }).length, 1);
});

test('2. an edited pattern gets a new rev and is judged again', () => {
  const state = emptyState();
  const reg1 = register([decision({ triggers: [changelogTrigger()] })]);
  scanChangelog(RELEASES, reg1, state, { nowT: NOW });
  assert.equal(Object.keys(state.changelogHits).length, 2);
  const rev1 = state.triggers['dec-one/cl'].rev;
  // Unchanged register: nothing new.
  assert.deepEqual(scanChangelog(RELEASES, reg1, state, { nowT: NOW }), []);
  // Edit the pattern: old hits cleared, the release is judged fresh and hits again under the new rule.
  const reg2 = register([decision({ triggers: [changelogTrigger({ pattern: '\\bcache\\b' })] })]);
  assert.notEqual(triggerRev(reg2.decisions[0].triggers[0]), rev1);
  const fresh = scanChangelog(RELEASES, reg2, state, { nowT: NOW + HOUR });
  assert.deepEqual(fresh.sort(), ['dec-one/cl@2.1.297', 'dec-one/cl@2.1.299']);
  assert.notEqual(state.triggers['dec-one/cl'].rev, rev1);
  // An edit that matches nothing leaves no stale hits behind.
  const reg3 = register([decision({ triggers: [changelogTrigger({ pattern: 'zzzz' })] })]);
  assert.deepEqual(scanChangelog(RELEASES, reg3, state, { nowT: NOW + 2 * HOUR }), []);
  assert.deepEqual(state.changelogHits, {});
  assert.deepEqual(state.flags, {});
});

test('2. a note edit does not change the rev; an edited sinceVersion does', () => {
  const t = changelogTrigger();
  assert.equal(triggerRev({ ...t, note: 'new commentary' }), triggerRev(t));
  assert.notEqual(triggerRev({ ...t, sinceVersion: '2.1.298' }), triggerRev(t));
  assert.equal(triggerRev({ b: { y: 1, x: 2 }, a: 1 }), triggerRev({ a: 1, b: { x: 2, y: 1 } }), 'key order does not matter at any depth');
});

test('2. retired decisions are not scanned; removed triggers are pruned from the state', () => {
  const state = emptyState();
  scanChangelog(RELEASES, register([decision()]), state, { nowT: NOW });
  assert.ok(Object.keys(state.changelogHits).length > 0);
  scanChangelog(RELEASES, register([decision({ status: 'retired' })]), state, { nowT: NOW });
  assert.deepEqual(state.changelogHits, {});
  assert.deepEqual(state.triggers, {});
});

// ---------------------------------------------------------------------------------------
// 4. The state: streaks, seen-set, surfaced
// ---------------------------------------------------------------------------------------

function run(state, reg, evaluators, nowT = NOW) {
  return evaluateTriggers({ register: reg, history: [], spawnRows: [], nowT, state, evaluators }).newFlags;
}
const metricOnly = (over = {}) => register([decision({ triggers: [metricTrigger(over)] })]);

test('4. one episode flags once across five evaluations', () => {
  const state = emptyState();
  const { script, evaluators } = scripted();
  const reg = metricOnly();
  script.days = [day('2026-10-10', true)];
  assert.deepEqual(run(state, reg, evaluators), [], 'one qualifying hit day is below minDays 2');
  script.days = [day('2026-10-10', true), day('2026-10-11', true)];
  assert.deepEqual(run(state, reg, evaluators), ['dec-one/mt@2026-10-10']);
  script.days.push(day('2026-10-12', true));
  assert.deepEqual(run(state, reg, evaluators), []);
  script.days.push(day('2026-10-13', true));
  assert.deepEqual(run(state, reg, evaluators), []);
  assert.deepEqual(run(state, reg, evaluators), []);
  assert.equal(state.seen.filter((k) => k === 'dec-one/mt@2026-10-10').length, 1);
  assert.equal(state.triggers['dec-one/mt'].streak, 4);
});

test('4. a gap day neither flags early nor resets; a qualifying miss resets; the next episode is a new key', () => {
  const state = emptyState();
  const { script, evaluators } = scripted();
  const reg = metricOnly();
  const gap = { day: '2026-10-11', qualifies: false, hit: false };
  script.days = [day('2026-10-10', true), gap];
  assert.deepEqual(run(state, reg, evaluators), []);
  assert.equal(state.triggers['dec-one/mt'].streak, 1, 'the gap did not reset');
  script.days = [day('2026-10-10', true), gap, day('2026-10-12', true)];
  assert.deepEqual(run(state, reg, evaluators), ['dec-one/mt@2026-10-10'], 'two hit days around a gap flag');
  script.days.push(day('2026-10-13', false));
  assert.deepEqual(run(state, reg, evaluators), []);
  assert.equal(state.triggers['dec-one/mt'].streak, 0);
  assert.equal(state.triggers['dec-one/mt'].episodeStart, null);
  assert.ok(state.flags['dec-one/mt@2026-10-10'].closed, 'the episode flag closes when the streak resets');
  script.days.push(day('2026-10-14', true), day('2026-10-15', true));
  assert.deepEqual(run(state, reg, evaluators), ['dec-one/mt@2026-10-14'], 'a new episode is a new key');
  assert.ok(state.seen.includes('dec-one/mt@2026-10-10') && state.seen.includes('dec-one/mt@2026-10-14'));
});

test('4. ready:false withholds the flag until the baseline and post window are met', () => {
  const state = emptyState();
  const { script, evaluators } = scripted();
  const reg = metricOnly();
  script.days = [day('2026-10-10', true), day('2026-10-11', true)];
  script.ready = false;
  assert.deepEqual(run(state, reg, evaluators), []);
  script.ready = true;
  assert.deepEqual(run(state, reg, evaluators), ['dec-one/mt@2026-10-10']);
});

test('4. minDays defaults to 2 and a trigger can set 1', () => {
  const { script, evaluators } = scripted();
  script.days = [day('2026-10-10', true)];
  assert.deepEqual(run(emptyState(), metricOnly(), evaluators), []);
  assert.deepEqual(run(emptyState(), metricOnly({ minDays: 1 }), evaluators), ['dec-one/mt@2026-10-10']);
});

test('4. event verdicts (flag-at-once facts) flag once per suffix', () => {
  const state = emptyState();
  const { script, evaluators } = scripted();
  const reg = register([decision({ triggers: [metricTrigger()] })]);
  script.events = [{ suffix: 'wrong@2026-10-12', severity: 'wrong', summary: 'effective_effort xhigh not high', rows: [{ at: 'x' }] }];
  assert.deepEqual(run(state, reg, evaluators), ['dec-one/mt@wrong@2026-10-12']);
  assert.deepEqual(run(state, reg, evaluators), []);
  assert.equal(state.flags['dec-one/mt@wrong@2026-10-12'].severity, 'wrong');
});

test('4. surfaced is independent of seen; marking surfaces nothing else', () => {
  const fx = makeFixture();
  try {
    const state = emptyState();
    const { script, evaluators } = scripted();
    script.days = [day('2026-10-10', true), day('2026-10-11', true)];
    run(state, metricOnly(), evaluators);
    writeState(state);
    assert.deepEqual(readState().surfaced, []);
    assert.ok(readState().seen.includes('dec-one/mt@2026-10-10'));
    assert.equal(markFlagsSurfaced(['dec-one/mt@2026-10-10']), true);
    const after = readState();
    assert.deepEqual(after.surfaced, ['dec-one/mt@2026-10-10']);
    assert.ok(after.seen.includes('dec-one/mt@2026-10-10'), 'seen unchanged');
    assert.ok(Object.keys(after.flags).length === 1, 'the flag record survives being surfaced');
  } finally { fx.cleanup(); }
});

test('4. the seen-set caps at 500, newest last', () => {
  const state = emptyState();
  for (let i = 0; i < 520; i++) markSeen(state, `k${i}`);
  markSeen(state, 'k519');
  assert.equal(state.seen.length, SEEN_CAP);
  assert.equal(state.seen[0], 'k20');
  assert.equal(state.seen[SEEN_CAP - 1], 'k519');
});

test('4. foldDays is idempotent over days already folded', () => {
  const rec = { streak: 0, lastDay: null, episodeStart: null };
  const days = [day('2026-10-10', true), day('2026-10-11', true)];
  foldDays(rec, days);
  foldDays(rec, days);
  assert.equal(rec.streak, 2);
  assert.equal(rec.lastDay, '2026-10-11');
});

test('4. an edited metric trigger is judged fresh; a frozen baseline survives the edit', () => {
  const state = emptyState();
  const { script, evaluators } = scripted();
  script.days = [day('2026-10-10', true), day('2026-10-11', true)];
  run(state, metricOnly(), evaluators);
  freezeBaseline(state, 'dec-one/mt', { days: ['2026-10-02'], pooled: 2.7, n: 40 }, NOW);
  freezeBaseline(state, 'dec-one/mt', { days: ['2026-10-09'], pooled: 9, n: 1 }, NOW + HOUR);
  assert.equal(state.baselines['dec-one/mt'].pooled, 2.7, 'frozen once, never recomputed');
  script.days = [day('2026-10-10', true)];
  run(state, metricOnly({ threshold: 3 }), evaluators);
  assert.equal(state.triggers['dec-one/mt'].streak, 1, 'streak restarted under the edited rule');
  assert.deepEqual(state.flags, {}, 'old flag cleared');
  assert.equal(state.baselines['dec-one/mt'].pooled, 2.7);
});

test('4. the real evaluators give no verdict without data and leave the state alone', () => {
  const state = emptyState();
  const reg = register([decision({ rolloutId: 'staged-one', triggers: [metricTrigger(), { id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 3, where: {}, expect: {} }] })]);
  const before = clone(state);
  const flags = evaluateTriggers({ register: reg, history: [{ day: '2026-10-10' }], spawnRows: [{ at: 'x' }], nowT: NOW, state, evaluators: EVALUATORS }).newFlags;
  assert.deepEqual(flags, []);
  assert.equal(EVALUATORS.metric({}), null);
  assert.equal(EVALUATORS.exercise({}), null);
  assert.deepEqual(Object.keys(state.triggers).sort(), ['dec-one/ex', 'dec-one/mt']);
  assert.deepEqual({ ...state, triggers: {} }, { ...before, triggers: {} });
});

test('4. the dispatch hands the evaluator its decision, trigger, key and activeFromMs', () => {
  const fx = makeFixture();
  try {
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ 'staged-one': '2026-10-10T08:00:00Z' }));
    const seen = [];
    const evaluators = { metric: (ctx) => { seen.push(ctx); return null; }, exercise: () => null, changelog: () => null };
    const reg = register([decision({ rolloutId: 'staged-one', triggers: [metricTrigger()] })]);
    evaluateTriggers({ register: reg, history: [{ day: 'h' }], spawnRows: [{ r: 1 }], nowT: NOW, state: emptyState(), evaluators });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, 'dec-one/mt');
    assert.equal(seen[0].decision.id, 'dec-one');
    assert.equal(seen[0].trigger.id, 'mt');
    assert.equal(seen[0].activeFromMs, T('2026-10-10T08:00:00Z'));
    assert.equal(seen[0].history.length, 1);
    assert.equal(seen[0].spawnRows.length, 1);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 7. The detail file
// ---------------------------------------------------------------------------------------

function flaggedState() {
  const reg = register([decision({
    triggers: [changelogTrigger(), metricTrigger()],
    evidence: ['notes/evidence-one.md', 'notes/evidence-two.md'],
    premises: [{ id: 'p1', text: 'Cache writes stay cheap enough.', label: 'M' }],
  })]);
  const state = emptyState();
  scanChangelog([{ version: '2.1.300', items: ['Raised the cache TTL default'] }], reg, state, { nowT: NOW });
  const { script, evaluators } = scripted();
  script.days = [day('2026-10-10', true), day('2026-10-11', true)];
  script.value = 2.5;
  script.n = 12;
  run(state, reg, evaluators);
  return { reg, state };
}

test('7. the detail file carries premise, trigger values, the matched item and the evidence', () => {
  const { reg, state } = flaggedState();
  const fx = makeFixture();
  try {
    const file = writeDetail(state, reg, join(fx.dir, 'details.md'), NOW);
    assert.ok(file && existsSync(file));
    const md = readFileSync(file, 'utf8');
    assert.match(md, /## Decision one \(dec-one\)/);
    assert.match(md, /To reverse: How to undo it\./);
    assert.match(md, /Premise p1 \[M\]: Cache writes stay cheap enough\./);
    assert.match(md, /Raised the cache TTL default/);
    assert.match(md, /Matched changelog item \(2\.1\.300/);
    assert.match(md, /compactionsPer100Spawns 2\.5 vs > 1\.25 over 2 days \(n=12\)/);
    assert.match(md, /Value 2\.5, pre pool n\/a, sample n=12, 2 qualifying day\(s\) since 2026-10-10/);
    assert.match(md, /notes\/evidence-one\.md/);
    assert.match(md, /notes\/evidence-two\.md/);
    assert.match(md, /To review, ask for one worker on this file \(no model call has been made\)\./);
  } finally { fx.cleanup(); }
});

test('7. the detail file lists at most 5 offending rows', () => {
  const reg = register([decision({ rolloutId: 'staged-one', triggers: [{ id: 'ex', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 7, where: {}, expect: { effective_effort: 'high' } }] })]);
  const state = emptyState();
  const { script, evaluators } = scripted();
  script.events = [{
    suffix: 'wrong@2026-10-12', severity: 'wrong', summary: 'effective_effort xhigh not high',
    rows: Array.from({ length: 9 }, (_, i) => ({ at: `2026-10-12T0${i}:00:00Z`, subagent_type: 'agent-companion:ac-opus-xhigh', effective_effort: 'xhigh', caller_declared_type: 'bounded-feature' })),
  }];
  run(state, reg, evaluators);
  const md = detailMarkdown(state, reg, NOW);
  assert.equal((md.match(/subagent_type agent-companion:ac-opus-xhigh/g) || []).length, 5);
  assert.match(md, /caller_declared_type bounded-feature/);
});

test('7. no open flag: the file is absent (and a stale one is removed)', () => {
  const fx = makeFixture();
  try {
    const file = join(fx.dir, 'details.md');
    const reg = register();
    assert.equal(writeDetail(emptyState(), reg, file, NOW), null);
    assert.equal(existsSync(file), false);
    const { reg: r2, state } = flaggedState();
    writeDetail(state, r2, file, NOW);
    assert.equal(existsSync(file), true);
    // Retire the decision: the flags are no longer open and the file goes.
    r2.decisions[0].status = 'retired';
    assert.equal(writeDetail(state, r2, file, NOW), null);
    assert.equal(existsSync(file), false);
    // A flag older than 30 days is not open.
    const { reg: r3, state: s3 } = flaggedState();
    assert.equal(detailMarkdown(s3, r3, NOW + 31 * 24 * HOUR), null);
  } finally { fx.cleanup(); }
});

test('7. runRegister writes the detail file at the default path and reports the open count', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(register([decision({ triggers: [changelogTrigger()] })])));
    const out = runRegister({ nowT: NOW, parsed: [{ version: '2.1.300', items: ['Raised the cache TTL default'] }] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.newFlags, ['dec-one/cl@2.1.300']);
    assert.equal(out.open, 1);
    assert.equal(out.detail, detailPath());
    assert.ok(existsSync(detailPath()));
    assert.ok(existsSync(statePath()));
    assert.equal(readState().flags['dec-one/cl@2.1.300'].decision, 'dec-one');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 8 (lib level). What the SessionStart hook calls
// ---------------------------------------------------------------------------------------

test('8. pendingLine: one line of LINE_MAX (300) chars or fewer, the title, premise and path; marked once, then silent', () => {
  const fx = makeFixture();
  try {
    const reg = register([decision({ title: 'T'.repeat(30), triggers: [changelogTrigger()] })]);
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    const state = emptyState();
    scanChangelog([{ version: '2.1.300', items: [`${'long item '.repeat(40)}cache ttl`] }], reg, state, { nowT: NOW });
    writeState(state);
    const p = pendingLine({ nowT: NOW + HOUR });
    assert.ok(p, 'a line is due');
    assert.ok(p.line.length <= LINE_MAX, `line is ${p.line.length} chars`);
    assert.ok(!p.line.includes('\n'));
    assert.ok(p.line.startsWith('[agent-companion] Decision review due: '));
    assert.ok(p.line.includes('premise p1 hit:'));
    assert.ok(p.line.endsWith(`Details: ${detailPath()}`));
    assert.deepEqual(p.keys, ['dec-one/cl@2.1.300']);
    assert.equal(markFlagsSurfaced(p.keys), true);
    assert.equal(pendingLine({ nowT: NOW + 2 * HOUR }), null, 'second session start prints nothing');
  } finally { fx.cleanup(); }
});

test('8. an unsurfaced flag older than 72 h goes only to the detail file', () => {
  const fx = makeFixture();
  try {
    const reg = register([decision({ triggers: [changelogTrigger()] })]);
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    const state = emptyState();
    scanChangelog([{ version: '2.1.300', items: ['cache ttl'] }], reg, state, { nowT: NOW });
    writeState(state);
    assert.ok(pendingLine({ nowT: NOW + 71 * HOUR }));
    assert.equal(pendingLine({ nowT: NOW + 73 * HOUR }), null);
    assert.ok(detailMarkdown(readState(), reg, NOW + 73 * HOUR), 'still in the detail file');
  } finally { fx.cleanup(); }
});

test('8. no line for an absent or invalid register; "+N more" and the severity order', () => {
  const fx = makeFixture();
  try {
    assert.equal(pendingLine({ nowT: NOW }), null);
    const reg = register([
      decision({ id: 'dec-a', triggers: [changelogTrigger()] }),
      decision({ id: 'dec-b', title: 'Decision two', rolloutId: 'staged-one', triggers: [metricTrigger()] }),
    ]);
    const state = emptyState();
    scanChangelog([{ version: '2.1.300', items: ['cache ttl'] }], reg, state, { nowT: NOW });
    const { script, evaluators } = scripted();
    script.events = [{ suffix: 'wrong@2026-10-12', severity: 'wrong', summary: 'effective_effort xhigh not high' }];
    run(state, reg, evaluators);
    const flags = pendingFlags({ state, register: reg, nowT: NOW });
    assert.deepEqual(flags.map((f) => f.severity), ['wrong', 'changelog']);
    const line = formatRegisterLine(flags, detailPath());
    assert.match(line, /Decision two \(dec-b\)/);
    assert.match(line, /\+1 more\./);
    // An invalid register on disk silences the line.
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), '{ bad');
    writeState(state);
    assert.equal(pendingLine({ nowT: NOW }), null);
  } finally { fx.cleanup(); }
});

test('8. formatRegisterLine stays within LINE_MAX (300) chars even with a very long path and summary', () => {
  const flag = { title: 'T'.repeat(60), decision: 'd'.repeat(40), premise: 'p1', summary: 's'.repeat(300) };
  const line = formatRegisterLine([flag, flag], `C:/${'deep/'.repeat(60)}details.md`);
  assert.ok(line.length <= LINE_MAX, `line is ${line.length}`);
});

test('8. formatRegisterLine keeps the version suffix of a typical changelog summary with a realistic details path', () => {
  const flag = { title: 'Plan usage multipliers', decision: 'plan-usage-multipliers', premise: 'p1', summary: '"Sonnet cache-read price now one tenth of input" in 2.1.296' };
  const line = formatRegisterLine([flag], 'C:/Users/someone/.claude/agent-companion/state/decision-register-details.md');
  assert.ok(line.length <= LINE_MAX, `line is ${line.length}`);
  assert.ok(line.includes('in 2.1.296'), line);
});

test('3. a write that read the state before another writer added a flag and a surfaced key keeps both', () => {
  const fx = makeFixture();
  try {
    const reg = register([decision({ triggers: [changelogTrigger()] })]);
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    // Writer A (the checkup) reads an empty state ...
    const a = readState();
    const snap = snapshotState(a);
    // ... writer B (the scout scan) records a flag, and the hook marks it shown ...
    scanChangelogToState([{ version: '2.1.300', items: ['cache ttl changed'] }], { nowT: NOW });
    const b = readState();
    const key = Object.keys(b.flags)[0];
    assert.ok(key, 'the scan recorded a flag');
    assert.equal(markFlagsSurfaced([key]), true);
    // ... then A finishes its own work and writes.
    a.lastEvalDay = '2026-10-12';
    assert.equal(writeStateMerged(a, snap), true);
    const after = readState();
    assert.ok(after.flags[key], 'the flag B added survives A\'s write');
    assert.ok(after.changelogHits[Object.keys(b.changelogHits)[0]], 'the hit survives');
    assert.ok(after.surfaced.includes(key), 'the surfaced mark survives, so the line is not shown again');
    assert.equal(after.lastEvalDay, '2026-10-12');
    // A key A deleted on purpose (it was in A's snapshot) is not carried back.
    const c = readState();
    const snapC = snapshotState(c);
    delete c.flags[key];
    writeStateMerged(c, snapC);
    assert.equal(readState().flags[key], undefined);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 9. Fail open
// ---------------------------------------------------------------------------------------

test('9. a corrupt state file, a corrupt history line and a corrupt spawns row are skipped and evaluation continues', () => {
  const fx = makeFixture();
  try {
    const reg = register([decision({ triggers: [metricTrigger({ minDays: 1 })] })]);
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    writeFileSync(statePath(), '{ "v": 1, "triggers": [oops');
    const historyFile = join(fx.dir, 'history.jsonl');
    writeFileSync(historyFile, `${JSON.stringify({ day: '2026-10-10' })}\n{ not json\n${JSON.stringify({ day: '2026-10-11' })}\n`);
    const spawnsFile = join(fx.dir, 'spawns.jsonl');
    writeFileSync(spawnsFile, `${JSON.stringify({ at: 'a' })}\ngarbage\n${JSON.stringify({ at: 'b' })}\n`);
    let got = null;
    const evaluators = {
      changelog: () => null, exercise: () => null,
      metric: (ctx) => { got = { h: ctx.history.length, s: ctx.spawnRows.length }; return { days: [day('2026-10-11', true)] }; },
    };
    const out = runRegister({ nowT: NOW, historyFile, spawnsFile, evaluators });
    assert.equal(out.ok, true);
    assert.deepEqual(got, { h: 2, s: 2 }, 'the good lines survive');
    assert.deepEqual(out.newFlags, ['dec-one/mt@2026-10-11']);
    assert.equal(readState().v, 1, 'the corrupt state was replaced by a valid one');
  } finally { fx.cleanup(); }
});

test('9. missing history and spawns files, and a throwing evaluator, do not stop the run', () => {
  const fx = makeFixture();
  try {
    const reg = register([decision({ triggers: [metricTrigger({ id: 'boom' }), changelogTrigger()] })]);
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(reg));
    const evaluators = { changelog: () => null, exercise: () => null, metric: () => { throw new Error('boom'); } };
    const out = runRegister({ nowT: NOW, historyFile: join(fx.dir, 'none.jsonl'), spawnsFile: join(fx.dir, 'none2.jsonl'), evaluators, parsed: [{ version: '2.1.300', items: ['cache ttl'] }] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.newFlags, ['dec-one/cl@2.1.300'], 'the changelog trigger still flagged');
  } finally { fx.cleanup(); }
});

test('9. runRegister on an absent or invalid register returns without throwing', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(runRegister({ nowT: NOW }), { ok: false, absent: true });
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify({ schema: 'x' }));
    const out = runRegister({ nowT: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.invalid, true);
    assert.ok(out.errors.length > 0);
    assert.equal(existsSync(statePath()), false, 'an invalid register is not evaluated and writes nothing');
  } finally { fx.cleanup(); }
});

test('9. runRegister skips when nothing is new, and force or a new changelog re-runs it', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(register([decision({ triggers: [changelogTrigger()] })])));
    const historyFile = join(fx.dir, 'h.jsonl');
    writeFileSync(historyFile, `${JSON.stringify({ day: '2026-10-10' })}\n`);
    const opts = { nowT: NOW, historyFile, spawnsFile: join(fx.dir, 's.jsonl') };
    assert.equal(runRegister(opts).evaluated, true);
    assert.equal(runRegister(opts).skipped, 'nothing new');
    assert.equal(runRegister({ ...opts, force: true }).evaluated, true);
    assert.equal(runRegister({ ...opts, parsed: [] }).evaluated, true);
    writeFileSync(historyFile, `${JSON.stringify({ day: '2026-10-10' })}\n${JSON.stringify({ day: '2026-10-11' })}\n`);
    assert.equal(runRegister(opts).evaluated, true, 'a new history day re-runs it');
    assert.equal(readState().lastEvalDay, '2026-10-11');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 10. Privacy
// ---------------------------------------------------------------------------------------

test('10. the shipped files carry no operator path and the operator register is not in the repo', () => {
  const FORBIDDEN = [/\/Users\//, /C:\\\\?Users/i, /\.claude[\\/]+tasks/, /\.claude[\\/]+agent-companion/];
  for (const rel of ['config/decision-register.example.json', 'scripts/decision-register.mjs', 'scripts/lib/decision-register.mjs']) {
    const text = readFileSync(join(PLUGIN_ROOT, rel), 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${rel} matches ${re}`);
  }
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const m = /\n#+ Decision register[\s\S]*?(?=\n## |\n# |$)/.exec(readme);
  if (m) for (const re of FORBIDDEN) assert.ok(!re.test(m[0]), `README block matches ${re}`);
  assert.equal(existsSync(join(PLUGIN_ROOT, 'config', 'decision-register.json')), false);
});

// ---------------------------------------------------------------------------------------
// 11. CLI
// ---------------------------------------------------------------------------------------

test('11. --check exits 0 on a valid register, an invalid one and an absent one, and prints the errors', () => {
  const fx = makeFixture();
  try {
    const env = { AGENT_COMPANION_HOME_OVERRIDE: fx.dir, AGENT_COMPANION_STATE_DIR: fx.stateDir };
    const absent = runScript('scripts/decision-register.mjs', ['--check'], { env });
    assert.equal(absent.status, 0);
    assert.match(absent.stdout, /No register at/);

    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), readFileSync(EXAMPLE, 'utf8'));
    const ok = runScript('scripts/decision-register.mjs', ['--check'], { env });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^OK: .*\(1 decision, 2 triggers\)/);

    const bad = register();
    bad.decisions[0].triggers[0].pattern = '(unclosed';
    bad.decisions[0].triggers[1].metric = 'vibes';
    writeFileSync(registerPath(), JSON.stringify(bad));
    const inv = runScript('scripts/decision-register.mjs', ['--check'], { env });
    assert.equal(inv.status, 0);
    assert.match(inv.stdout, /INVALID: .*\(2 errors\)/);
    assert.match(inv.stdout, /does not compile/);
    assert.match(inv.stdout, /unknown metric/);

    writeFileSync(registerPath(), '{ bad json');
    const junk = runScript('scripts/decision-register.mjs', ['--check'], { env });
    assert.equal(junk.status, 0);
    assert.match(junk.stdout, /not valid JSON/);
  } finally { fx.cleanup(); }
});

test('11. --evaluate runs once, --detail and --path print paths, no args prints usage; all exit 0', () => {
  const fx = makeFixture();
  try {
    const env = { AGENT_COMPANION_HOME_OVERRIDE: fx.dir, AGENT_COMPANION_STATE_DIR: fx.stateDir, AGENT_COMPANION_FAKE_NOW: '2026-10-12T10:00:00Z' };
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(registerPath(), readFileSync(EXAMPLE, 'utf8'));
    const ev = runScript('scripts/decision-register.mjs', ['--evaluate'], { env });
    assert.equal(ev.status, 0);
    assert.equal(ev.json.ok, true);
    assert.equal(ev.json.evaluated, true);
    assert.ok(existsSync(statePath()));
    const det = runScript('scripts/decision-register.mjs', ['--detail'], { env });
    assert.equal(det.status, 0);
    assert.ok(det.stdout.trim().replace(/\\/g, '/').endsWith('/state/decision-register-details.md'));
    const p = runScript('scripts/decision-register.mjs', ['--path'], { env });
    assert.ok(p.stdout.trim().replace(/\\/g, '/').endsWith('/config/decision-register.json'));
    const none = runScript('scripts/decision-register.mjs', [], { env });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /usage:/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// Groups 3, 5 and 6: the metric catalog, staged baselines and exercise triggers, through the
// real evaluators. `drive` pins activeFromMs (null = no rollout) so no rollout.json is needed.
// ---------------------------------------------------------------------------------------

const DAY = 24 * HOUR;
const AF = T('2026-10-10T08:00:00Z');

function hday(d, o = {}) {
  const total = o.total ?? 100;
  const main = o.main ?? total / 2;
  return {
    v: 1, day: d, units: { main, subagent: o.sub ?? total - main, total },
    spawns: { total: o.spawns ?? 0, byType: o.byType || {}, byRung: o.byRung || {} },
    subagent: { compactions: o.comp ?? 0, unitsOver150k: o.over ?? 0 },
    ceilingNudges: o.nudges ?? 0, ...(o.limit ? { limit: o.limit } : {}),
  };
}
// A day with `spawns` spawns and `comp` compactions: compactionsPer100Spawns = comp/spawns*100.
const cday = (d, spawns, comp, extra = {}) => hday(d, { spawns, comp, ...extra });
function srow(at, o = {}) {
  return { at, subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', caller_is_subagent: false, caller_effort: 'high', ...o };
}
function drive(reg, { history = [], spawnRows = [], nowT = NOW, state = emptyState(), af = null } = {}) {
  const evaluators = {
    changelog: () => null,
    metric: (c) => evalMetric({ ...c, activeFromMs: af }),
    exercise: (c) => evalExercise({ ...c, activeFromMs: af }),
  };
  const out = evaluateTriggers({ register: reg, history, spawnRows, nowT, state, evaluators });
  return { ...out, state };
}
const regOf = (trigger, over = {}) => register([decision({ triggers: [trigger], ...over })]);

test('3. one hit on a qualifying day does not flag; two consecutive qualifying days do', () => {
  const reg = regOf(metricTrigger());
  const one = drive(reg, { history: [cday('2026-10-10', 40, 2), cday('2026-10-11', 40, 0)] });
  assert.deepEqual(one.newFlags, []);
  const two = drive(reg, { history: [cday('2026-10-10', 40, 2), cday('2026-10-11', 40, 2)] });
  assert.deepEqual(two.newFlags, ['dec-one/mt@2026-10-10']);
  assert.equal(two.state.flags['dec-one/mt@2026-10-10'].summary, 'compactionsPer100Spawns 5 vs > 1.25 over 2 days (n=40)');
});

test('3. a zero-unit gap day neither flags early nor resets the streak', () => {
  const reg = regOf(metricTrigger());
  const zero = hday('2026-10-11', { total: 0, main: 0, sub: 0, spawns: 0 });
  const early = drive(reg, { history: [cday('2026-10-10', 40, 2), zero] });
  assert.deepEqual(early.newFlags, [], 'a zero day is not a second hit');
  assert.equal(early.state.triggers['dec-one/mt'].streak, 1);
  const later = drive(reg, { history: [cday('2026-10-10', 40, 2), zero, cday('2026-10-12', 40, 2)], state: early.state });
  assert.deepEqual(later.newFlags, ['dec-one/mt@2026-10-10'], 'the gap did not reset the streak');
});

test('3. a qualifying day without a hit resets the streak', () => {
  const reg = regOf(metricTrigger());
  const out = drive(reg, { history: [cday('2026-10-10', 40, 2), cday('2026-10-11', 40, 0), cday('2026-10-12', 40, 2)] });
  assert.deepEqual(out.newFlags, []);
  assert.equal(out.state.triggers['dec-one/mt'].streak, 1);
  assert.equal(out.state.triggers['dec-one/mt'].episodeStart, '2026-10-12');
});

test('3. a day below minSample is skipped, not read as good or bad', () => {
  const reg = regOf(metricTrigger({ minSample: 5 }));
  // 10-11 has 4 spawns (a "hit" at 25 per 100) but is below minSample 5: a gap.
  const out = drive(reg, { history: [cday('2026-10-10', 40, 2), cday('2026-10-11', 4, 1), cday('2026-10-12', 40, 2)] });
  assert.deepEqual(out.newFlags, ['dec-one/mt@2026-10-10']);
  const thin = drive(reg, { history: [cday('2026-10-10', 40, 2), cday('2026-10-11', 4, 1)] });
  assert.deepEqual(thin.newFlags, []);
  assert.equal(thin.state.triggers['dec-one/mt'].streak, 1);
});

test('3. a limit-hit day is a gap for per-day totals but counts for ratio metrics', () => {
  const lim = { hits: 1, firstAt: '2026-10-11T09:00:00Z' };
  const main = regOf(metricTrigger({ metric: 'mainUnitsPerDay', op: '>', threshold: 50, minSample: 50 }));
  const limited = hday('2026-10-11', { total: 90, main: 10, limit: lim }); // would be a miss (10 < 50) if it counted
  const h = [hday('2026-10-10', { total: 160, main: 120 }), limited, hday('2026-10-12', { total: 160, main: 120 })];
  assert.deepEqual(drive(main, { history: h }).newFlags, ['dec-one/mt@2026-10-10'], 'the limit day was a gap, not a miss');
  const plain = { ...limited }; delete plain.limit;
  assert.deepEqual(drive(main, { history: [h[0], plain, h[2]] }).newFlags, [], 'the same day without the marker resets the streak');
  const nud = regOf(metricTrigger({ metric: 'ceilingNudgesPerDay', op: '<=', threshold: 0, minSample: 20 }));
  const nh = [hday('2026-10-10', { spawns: 30 }), hday('2026-10-11', { spawns: 30, nudges: 4, limit: lim }), hday('2026-10-12', { spawns: 30 })];
  assert.deepEqual(drive(nud, { history: nh }).newFlags, ['dec-one/mt@2026-10-10']);
  // A ratio metric keeps the limit day when it meets minSample.
  const rh = [cday('2026-10-10', 40, 2), cday('2026-10-11', 40, 2, { limit: lim })];
  assert.deepEqual(drive(regOf(metricTrigger()), { history: rh }).newFlags, ['dec-one/mt@2026-10-10']);
});

test('3. the eight catalog metrics compute their day values from the two sources', () => {
  const val = (trigger, history, spawnRows = []) => evalMetric({
    decision: {}, trigger, key: 'k', history, spawnRows, nowT: T('2026-10-20T00:00:00Z'), state: emptyState(), activeFromMs: null,
  });
  const lastValue = (v) => v.days.filter((d) => d.qualifies).pop().value;
  const base = { id: 'mt', premise: 'p1', kind: 'metric', op: '>', threshold: 0, minSample: 1, minDays: 1 };
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'unitsPerSpawn', params: { type: 'bounded-feature' } },
    [hday('2026-10-10', { byType: { 'bounded-feature': { n: 10, units: 25 } } })])), 2.5);
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'unitsPerSpawn', params: { rung: 'sonnet/high' } },
    [hday('2026-10-10', { byRung: { 'sonnet/high': { n: 4, units: 6 } } })])), 1.5);
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'mainUnitsPerDay', params: {} }, [hday('2026-10-10', { total: 100, main: 70 })])), 70);
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'shareOver150kPct', params: {} }, [hday('2026-10-10', { total: 100, main: 20, over: 20 })])), 25, 'unitsOver150k / units.subagent, in percent');
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'compactionsPer100Spawns', params: {} }, [cday('2026-10-10', 50, 3)])), 6);
  assert.equal(lastValue(val({ ...base, source: 'history', metric: 'ceilingNudgesPerDay', params: {} }, [hday('2026-10-10', { spawns: 9, nudges: 3 })])), 3);
  // spawns metrics: the rows of checkup day 2026-10-10 run 08:00Z to 07:59Z
  const lead = (at, eff, sub = false) => srow(at, { caller_is_subagent: sub, caller_effort: eff });
  const leadRows = [lead('2026-10-10T09:00:00Z', 'xhigh'), lead('2026-10-10T10:00:00Z', 'max'), lead('2026-10-10T11:00:00Z', 'high'), lead('2026-10-11T07:00:00Z', 'high'),
    lead('2026-10-10T12:00:00Z', 'xhigh', true), srow('2026-10-10T13:00:00Z', { caller_effort: '' })];
  assert.equal(lastValue(val({ ...base, source: 'spawns', metric: 'leadEffortShare', params: { levels: ['xhigh', 'max'] } }, [], leadRows)), 0.5,
    'subagent callers and rows with no caller_effort are not counted: 2 of 4');
  const rev = (at, id) => srow(at, { declared_type: 'code-review', caller_tool_use_id: id });
  const wr = (at) => srow(at, { declared_type: 'bounded-feature' });
  const revRows = [wr('2026-10-10T09:00:00Z'), wr('2026-10-10T10:00:00Z'), rev('2026-10-10T11:00:00Z', 'a'), rev('2026-10-10T12:00:00Z', 'a'), rev('2026-10-10T13:00:00Z', 'b'), rev('2026-10-10T14:00:00Z', '')];
  assert.equal(lastValue(val({ ...base, source: 'spawns', metric: 'reviewsPerWriter', params: { writerType: 'bounded-feature' } }, [], revRows)), 1.5, '3 reviews with a caller id / 2 writers');
  const hk = [srow('2026-10-10T09:00:00Z', { model: 'haiku' }), srow('2026-10-10T10:00:00Z'), srow('2026-10-10T11:00:00Z', { model: 'haiku' })];
  assert.equal(lastValue(val({ ...base, source: 'spawns', metric: 'haikuSpawns', params: {} }, [], hk)), 2);
});

test('3. spawn rows are bucketed with the checkup day (08:00Z), and the open day is not read', () => {
  const trig = metricTrigger({ source: 'spawns', metric: 'haikuSpawns', params: {}, op: '>=', threshold: 1, minSample: 1, minDays: 1 });
  const rows = [
    srow('2026-10-10T07:59:59Z', { model: 'haiku' }), // belongs to day 2026-10-09
    srow('2026-10-10T08:00:00Z'), // day 2026-10-10, no haiku
    srow('2026-10-11T08:30:00Z', { model: 'haiku' }), // day 2026-10-11 is still open at nowT
  ];
  const v = evalMetric({ decision: {}, trigger: trig, key: 'k', history: [], spawnRows: rows, nowT: T('2026-10-11T12:00:00Z'), state: emptyState(), activeFromMs: null });
  assert.deepEqual(v.days.map((d) => [d.day, d.hit]), [['2026-10-09', true], ['2026-10-10', false]]);
});

test('3. without a rollout, days before the decision date are not evidence', () => {
  const trig = metricTrigger({ source: 'spawns', metric: 'haikuSpawns', params: {}, op: '>=', threshold: 1, minSample: 1, minDays: 1 });
  const reg = register([decision({ decided: '2026-10-10', triggers: [trig] })]);
  const rows = [srow('2026-10-08T12:00:00Z', { model: 'haiku' }), srow('2026-10-09T12:00:00Z', { model: 'haiku' }), srow('2026-10-09T20:00:00Z', { model: 'haiku' })];
  // checkup days 10-08 and 10-09 both start before 2026-10-10T00:00Z
  assert.deepEqual(drive(reg, { spawnRows: rows, nowT: T('2026-10-10T12:00:00Z') }).newFlags, []);
  // a haiku spawn in the first checkup day that starts on the decision date does flag
  const after = [...rows, srow('2026-10-10T09:00:00Z', { model: 'haiku' })];
  assert.deepEqual(drive(reg, { spawnRows: after, nowT: T('2026-10-11T12:00:00Z') }).newFlags, ['dec-one/mt@2026-10-10']);
});

test('3. a zero-unit history day is a gap for a spawns metric too', () => {
  const trig = metricTrigger({ source: 'spawns', metric: 'haikuSpawns', params: {}, op: '>=', threshold: 1, minSample: 1, minDays: 1 });
  const zero = hday('2026-10-10', { total: 0, main: 0, sub: 0 });
  const v = evalMetric({ decision: {}, trigger: trig, key: 'k', history: [zero], spawnRows: [srow('2026-10-10T09:00:00Z', { model: 'haiku' })], nowT: T('2026-10-12T00:00:00Z'), state: emptyState(), activeFromMs: null });
  assert.equal(v.days[0].qualifies, false);
});

// ----- 5. staged baselines ------------------------------------------------------------

// The pre window of the spec's example: bounded-feature spawns per day and units per spawn.
const PRE = [
  ['2026-10-02', 17, 3.73], ['2026-10-03', 58, 2.16], ['2026-10-04', 4, 2.08], ['2026-10-05', 15, 1.35], ['2026-10-06', 22, 4.27],
].map(([d, n, ups]) => hday(d, { byType: { 'bounded-feature': { n, units: n * ups } } }));
const ZERO = (d) => hday(d, { total: 0, main: 0, sub: 0 });
const POOLED = (17 * 3.73 + 58 * 2.16 + 15 * 1.35 + 22 * 4.27) / (17 + 58 + 15 + 22); // the 4 days with n >= 5
const bf = (d, n, units) => hday(d, { byType: { 'bounded-feature': { n, units } } });
function costTrigger(over = {}) {
  return metricTrigger({
    id: 'cost-up', metric: 'unitsPerSpawn', params: { type: 'bounded-feature' }, threshold: 1.25, minSample: 5, minDays: 2,
    baseline: { mode: 'pre-window', ratio: true, preDays: 5, minPerDay: 5 }, post: { minDays: 2 }, ...over,
  });
}
const stagedReg = (trigger) => register([decision({ rolloutId: 'staged-one', triggers: [trigger] })]);

test('5. the pre window takes the last qualifying days, skips thin and zero days, and pools (not a mean of ratios)', () => {
  const reg = stagedReg(costTrigger());
  const history = [...PRE, ZERO('2026-10-07'), ZERO('2026-10-08'), bf('2026-10-09', 3, 30), bf('2026-10-10', 10, 40)];
  const out = drive(reg, { history, nowT: T('2026-10-11T12:00:00Z'), af: AF });
  const b = out.state.baselines['dec-one/cost-up'];
  assert.deepEqual(b.days, ['2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06'], 'n=4 and n=3 days and the zero days are skipped');
  assert.ok(Math.abs(b.pooled - POOLED) < 1e-9, `pooled ${b.pooled} vs ${POOLED}`);
  assert.equal(b.n, 112);
  const mean = (3.73 + 2.16 + 1.35 + 4.27) / 4;
  assert.ok(Math.abs(b.pooled - mean) > 0.1, 'pooled differs from the mean of per-day values');
  assert.equal(out.state.triggers['dec-one/cost-up'].pre, POOLED);
});

test('5. the pre window keeps at most preDays qualifying days and ignores days older than 8', () => {
  const history = [bf('2026-09-30', 50, 500), ...PRE.filter((x) => x.day !== '2026-10-04'), bf('2026-10-10', 10, 40)];
  const nowT = T('2026-10-11T12:00:00Z');
  const three = drive(stagedReg(costTrigger({ baseline: { mode: 'pre-window', ratio: true, preDays: 3, minPerDay: 5 } })), { history, nowT, af: AF });
  assert.deepEqual(three.state.baselines['dec-one/cost-up'].days, ['2026-10-03', '2026-10-05', '2026-10-06']);
  const wide = drive(stagedReg(costTrigger({ baseline: { mode: 'pre-window', ratio: true, preDays: 9, minPerDay: 5 } })), { history, nowT, af: AF });
  assert.ok(!wide.state.baselines['dec-one/cost-up'].days.includes('2026-09-30'), '09-30 is more than 8 days before the switch');
  assert.equal(wide.state.baselines['dec-one/cost-up'].days.length, 4);
});

test('5. the ratio threshold uses the pooled post window against the pooled pre window', () => {
  const reg = stagedReg(costTrigger());
  // Day 1 alone is 6.0 per spawn (2.2x pre, a hit); after day 2 the pool is 130/55 = 2.36 (0.87x): no hit.
  // A mean of per-day ratios would be (2.2 + 0.74) / 2 = 1.47 and would flag.
  const out = drive(reg, { history: [...PRE, bf('2026-10-10', 5, 30), bf('2026-10-11', 50, 100)], nowT: T('2026-10-12T12:00:00Z'), af: AF });
  assert.deepEqual(out.newFlags, []);
  const rec = out.state.triggers['dec-one/cost-up'];
  assert.equal(rec.streak, 0);
  assert.ok(Math.abs(rec.value - 130 / 55 / POOLED) < 1e-9, `ratio ${rec.value}`);
  // Two bad days flag, with the pre pool and the post sample in the state for the detail file.
  const bad = drive(reg, { history: [...PRE, bf('2026-10-10', 10, 40), bf('2026-10-11', 10, 40)], nowT: T('2026-10-12T12:00:00Z'), af: AF });
  assert.deepEqual(bad.newFlags, ['dec-one/cost-up@2026-10-10']);
  const r2 = bad.state.triggers['dec-one/cost-up'];
  assert.equal(r2.pre, POOLED);
  assert.equal(r2.n, 20);
  assert.ok(Math.abs(r2.value - 4 / POOLED) < 1e-9);
});

test('5. the baseline freezes: pruned history changes nothing, and the verdict still comes', () => {
  const reg = stagedReg(costTrigger());
  const state = emptyState();
  drive(reg, { history: [...PRE, bf('2026-10-10', 10, 40)], nowT: T('2026-10-11T12:00:00Z'), af: AF, state });
  const frozen = clone(state.baselines['dec-one/cost-up']);
  assert.ok(frozen.frozenAt);
  // The history has dropped every pre day by the time the second post day closes.
  const out = drive(reg, { history: [bf('2026-10-10', 10, 40), bf('2026-10-11', 10, 40)], nowT: T('2026-10-12T12:00:00Z'), af: AF, state });
  assert.deepEqual(state.baselines['dec-one/cost-up'], frozen, 'the stored baseline is untouched');
  assert.deepEqual(out.newFlags, ['dec-one/cost-up@2026-10-10']);
});

test('5. fewer than 3 qualifying pre days is "insufficient": silent, nothing frozen, noted for the detail file', () => {
  const reg = stagedReg(costTrigger());
  const history = [PRE[0], PRE[1], ZERO('2026-10-07'), bf('2026-10-10', 10, 90), bf('2026-10-11', 10, 90)];
  const state = emptyState();
  const out = drive(reg, { history, nowT: T('2026-10-12T12:00:00Z'), af: AF, state });
  assert.deepEqual(out.newFlags, []);
  assert.deepEqual(state.baselines, {});
  assert.equal(state.triggers['dec-one/cost-up'].baselineStatus, 'insufficient');
  // Another flag makes a detail file; it says which baseline is unusable.
  const both = register([decision({ rolloutId: 'staged-one', triggers: [changelogTrigger(), costTrigger()] })]);
  scanChangelog([{ version: '2.1.300', items: ['Raised the cache ttl'] }], both, state, { nowT: NOW });
  assert.match(detailMarkdown(state, both, NOW), /Baselines not usable yet.*dec-one\/cost-up/);
  // A third qualifying pre day arriving later freezes it and clears the note.
  const again = drive(reg, { history: [...history, PRE[3]], nowT: T('2026-10-12T12:00:00Z'), af: AF, state });
  assert.ok(state.baselines['dec-one/cost-up']);
  assert.equal(state.triggers['dec-one/cost-up'].baselineStatus, undefined);
  assert.deepEqual(again.newFlags, ['dec-one/cost-up@2026-10-10']);
});

test('5. post.minDays, and no verdict before the switch or without a rollout instant', () => {
  const reg = stagedReg(costTrigger({ minDays: 1, post: { minDays: 2 } }));
  const one = drive(reg, { history: [...PRE, bf('2026-10-10', 10, 40)], nowT: T('2026-10-11T12:00:00Z'), af: AF });
  assert.deepEqual(one.newFlags, [], 'one post day is not enough');
  const two = drive(reg, { history: [...PRE, bf('2026-10-10', 10, 40), bf('2026-10-11', 10, 40)], nowT: T('2026-10-12T12:00:00Z'), af: AF });
  assert.deepEqual(two.newFlags, ['dec-one/cost-up@2026-10-10']);
  const before = drive(reg, { history: PRE, nowT: AF - HOUR, af: AF });
  assert.deepEqual(before.state.baselines, {}, 'nothing is frozen before the switch');
  assert.deepEqual(before.newFlags, []);
  const unknown = drive(reg, { history: PRE, nowT: AF + DAY, af: null });
  assert.deepEqual(unknown.newFlags, [], 'a rollout id that does not resolve gives no verdict');
});

test('5. a post window without a baseline: absolute per-day threshold from the switch, flag after post.minDays', () => {
  const trig = metricTrigger({ id: 'nudges', metric: 'ceilingNudgesPerDay', op: '<=', threshold: 0, minSample: 20, minDays: 3, post: { minDays: 3 } });
  const reg = stagedReg(trig);
  const h = (d, sp, nu) => hday(d, { spawns: sp, nudges: nu });
  // 10-09 is before the switch and is not read; 10-10 has too few spawns (a gap).
  const history = [h('2026-10-09', 50, 0), h('2026-10-10', 10, 0), h('2026-10-11', 30, 0), h('2026-10-12', 30, 0), h('2026-10-13', 30, 0)];
  const early = drive(reg, { history: history.slice(0, 4), nowT: T('2026-10-13T12:00:00Z'), af: AF });
  assert.deepEqual(early.newFlags, []);
  const out = drive(reg, { history, nowT: T('2026-10-14T12:00:00Z'), af: AF });
  assert.deepEqual(out.newFlags, ['dec-one/nudges@2026-10-11']);
});

test('5. an absolute baseline (ratio false) needs minPerDay per day and minSample pooled over the post window', () => {
  const trig = metricTrigger({
    id: 'rework', source: 'spawns', metric: 'reviewsPerWriter', params: { writerType: 'bounded-feature' }, op: '>', threshold: 1.4,
    minSample: 10, minDays: 1, baseline: { mode: 'pre-window', ratio: false, preDays: 5, minPerDay: 3 }, post: { minDays: 3 },
  });
  const reg = stagedReg(trig);
  const rows = [];
  const add = (day, writers, reviews) => {
    for (let i = 0; i < writers; i++) rows.push(srow(`${day}T10:0${i}:00Z`, { declared_type: 'bounded-feature' }));
    for (let i = 0; i < reviews; i++) rows.push(srow(`${day}T11:0${i}:00Z`, { declared_type: 'code-review', caller_tool_use_id: `${day}-${i}` }));
  };
  for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) add(d, 3, 3); // pre: 9 writers, 9 reviews = 1.0
  add('2026-10-10', 3, 5);
  add('2026-10-11', 3, 5);
  const six = drive(reg, { spawnRows: rows, nowT: T('2026-10-12T12:00:00Z'), af: AF });
  assert.equal(six.state.baselines['dec-one/rework'].pooled, 1);
  assert.deepEqual(six.newFlags, [], 'two post days, 6 writers pooled: under post.minDays and under minSample 10');
  add('2026-10-12', 4, 6); // third post day: 10 writers pooled, 16 reviews
  const ten = drive(reg, { spawnRows: rows, nowT: T('2026-10-13T12:00:00Z'), af: AF });
  assert.deepEqual(ten.newFlags, ['dec-one/rework@2026-10-10']);
  assert.ok(Math.abs(ten.state.triggers['dec-one/rework'].value - 1.6) < 1e-9);
  assert.equal(ten.state.triggers['dec-one/rework'].n, 10);
});

test('5. end to end: runRegister with the real rollout table, history and spawns files', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ 'staged-one': '2026-10-10T08:00:00Z' }));
    writeFileSync(registerPath(), JSON.stringify(register([decision({ rolloutId: 'staged-one', triggers: [costTrigger()] })])));
    const historyFile = join(fx.dir, 'history.jsonl');
    writeFileSync(historyFile, [...PRE, bf('2026-10-10', 10, 40), bf('2026-10-11', 10, 40)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const spawnsFile = join(fx.dir, 'spawns.jsonl');
    writeFileSync(spawnsFile, '');
    const out = runRegister({ nowT: T('2026-10-12T12:00:00Z'), historyFile, spawnsFile });
    assert.equal(out.ok, true);
    assert.deepEqual(out.newFlags, ['dec-one/cost-up@2026-10-10']);
    assert.ok(readState().baselines['dec-one/cost-up']);
  } finally { fx.cleanup(); }
});

// ----- 6. exercise ----------------------------------------------------------------------

const OPUS_AF = T('2026-10-11T08:00:00Z');
const capTrigger = (over = {}) => ({
  id: 'cap', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 7,
  where: { declared_type: 'code-review', declaredWriterModel: 'opus', callerTypeNotIn: ['novel-design', 'critical-change'], callerTypeKnown: true },
  expect: { effective_effort: 'high' }, ...over,
});
const exReg = (...triggers) => register([decision({ rolloutId: 'staged-one', triggers })]);
const reviewRow = (at, o = {}) => srow(at, {
  declared_type: 'code-review', declared_writer: 'opus/medium', caller_declared_type: 'bounded-feature', effective_effort: 'high', ...o,
});

test('6. unexercised flags at activeFrom + afterDays with no matching row, not before, and once', () => {
  const reg = exReg(capTrigger());
  assert.deepEqual(drive(reg, { nowT: OPUS_AF + 7 * DAY - 1, af: OPUS_AF }).newFlags, []);
  const state = emptyState();
  const at = drive(reg, { nowT: OPUS_AF + 7 * DAY, af: OPUS_AF, state });
  assert.deepEqual(at.newFlags, ['dec-one/cap@unexercised']);
  assert.equal(state.flags['dec-one/cap@unexercised'].severity, 'unexercised');
  assert.equal(state.flags['dec-one/cap@unexercised'].summary, 'unexercised after 7 days');
  assert.deepEqual(drive(reg, { nowT: OPUS_AF + 8 * DAY, af: OPUS_AF, state }).newFlags, [], 'the seen-set holds it');
  assert.deepEqual(drive(reg, { nowT: OPUS_AF - HOUR, af: OPUS_AF }).newFlags, [], 'before the switch: no verdict');
});

test('6. rows before activeFrom and rows that miss the predicates do not count as exercise', () => {
  const reg = exReg(capTrigger());
  const rows = [
    reviewRow('2026-10-11T07:59:00Z'), // before the switch
    reviewRow('2026-10-12T10:00:00Z', { declared_writer: 'sonnet/high' }), // sonnet writer
    reviewRow('2026-10-12T11:00:00Z', { caller_declared_type: 'novel-design' }), // exempt type
    reviewRow('2026-10-12T12:00:00Z', { declared_type: 'bounded-feature' }), // not a review
  ];
  const out = drive(reg, { spawnRows: rows, nowT: OPUS_AF + 7 * DAY, af: OPUS_AF });
  assert.deepEqual(out.newFlags, ['dec-one/cap@unexercised']);
});

test('6. wrong flags on the first offending row at once: an opus reviewer at xhigh for a bounded-feature caller', () => {
  const reg = exReg(capTrigger());
  const bad = reviewRow('2026-10-12T10:00:00Z', { effective_effort: 'xhigh' });
  const state = emptyState();
  const out = drive(reg, { spawnRows: [bad], nowT: OPUS_AF + DAY + 5 * HOUR, af: OPUS_AF, state });
  assert.deepEqual(out.newFlags, ['dec-one/cap@wrong-2026-10-12T10:00:00Z']);
  const f = state.flags[out.newFlags[0]];
  assert.equal(f.severity, 'wrong');
  assert.equal(f.summary, 'effective_effort xhigh not high (1 row)');
  assert.equal(f.detail.rows[0].effective_effort, 'xhigh');
  // The same first row again, plus a good one: nothing new.
  const more = drive(reg, { spawnRows: [bad, reviewRow('2026-10-12T14:00:00Z')], nowT: OPUS_AF + 2 * DAY, af: OPUS_AF, state });
  assert.deepEqual(more.newFlags, []);
  const good = drive(reg, { spawnRows: [reviewRow('2026-10-12T10:00:00Z')], nowT: OPUS_AF + 9 * DAY, af: OPUS_AF });
  assert.deepEqual(good.newFlags, [], 'a correct row is neither wrong nor unexercised');
});

test('6. exempt writer types expect xhigh', () => {
  const exempt = { id: 'exempt', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 7,
    where: { declared_type: 'code-review', declaredWriterModel: 'opus', callerTypeIn: ['novel-design', 'critical-change'] }, expect: { effective_effort: 'xhigh' } };
  const reg = exReg(exempt);
  const low = reviewRow('2026-10-12T10:00:00Z', { caller_declared_type: 'critical-change', effective_effort: 'high' });
  assert.deepEqual(drive(reg, { spawnRows: [low], nowT: OPUS_AF + DAY, af: OPUS_AF }).newFlags, ['dec-one/exempt@wrong-2026-10-12T10:00:00Z']);
  const ok = reviewRow('2026-10-12T10:00:00Z', { caller_declared_type: 'novel-design', effective_effort: 'xhigh' });
  assert.deepEqual(drive(reg, { spawnRows: [ok], nowT: OPUS_AF + 9 * DAY, af: OPUS_AF }).newFlags, []);
  // A non-exempt caller type is not this trigger's business.
  const other = reviewRow('2026-10-12T10:00:00Z', { caller_declared_type: 'bounded-feature', effective_effort: 'high' });
  assert.deepEqual(drive(reg, { spawnRows: [other], nowT: OPUS_AF + 9 * DAY, af: OPUS_AF }).newFlags, ['dec-one/exempt@unexercised']);
});

test('6. rows without caller_declared_type are excluded when callerTypeKnown is set', () => {
  const reg = exReg(capTrigger());
  const blank = reviewRow('2026-10-12T10:00:00Z', { caller_declared_type: '', effective_effort: 'medium' });
  const none = reviewRow('2026-10-12T11:00:00Z', { effective_effort: 'medium' });
  delete none.caller_declared_type;
  const out = drive(reg, { spawnRows: [blank, none], nowT: OPUS_AF + 7 * DAY, af: OPUS_AF });
  assert.deepEqual(out.newFlags, ['dec-one/cap@unexercised'], 'no wrong flag from rows that cannot be judged; they do not exercise it either');
  assert.equal(matchesWhere(blank, { callerTypeKnown: false }), true);
  assert.equal(matchesWhere(blank, { callerTypeKnown: true }), false);
});

test('6. repeatForSameCaller counts two reviewers for one caller_tool_use_id', () => {
  const rep = { id: 'repeat', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 14, where: { declared_type: 'code-review', repeatForSameCaller: true }, expect: {} };
  const reg = exReg(rep);
  const nowT = OPUS_AF + 14 * DAY;
  const two = [reviewRow('2026-10-12T10:00:00Z', { caller_tool_use_id: 'w1' }), reviewRow('2026-10-12T11:00:00Z', { caller_tool_use_id: 'w1' })];
  assert.deepEqual(drive(reg, { spawnRows: two, nowT, af: OPUS_AF }).newFlags, [], 'a writer that spawned a second reviewer exercised it');
  const apart = [reviewRow('2026-10-12T10:00:00Z', { caller_tool_use_id: 'w1' }), reviewRow('2026-10-12T11:00:00Z', { caller_tool_use_id: 'w2' })];
  assert.deepEqual(drive(reg, { spawnRows: apart, nowT, af: OPUS_AF }).newFlags, ['dec-one/repeat@unexercised']);
  const blank = [reviewRow('2026-10-12T10:00:00Z'), reviewRow('2026-10-12T11:00:00Z')];
  assert.deepEqual(drive(reg, { spawnRows: blank, nowT, af: OPUS_AF }).newFlags, ['dec-one/repeat@unexercised'], 'blank caller ids never pair up');
  // Two reviewers, one of them before the switch, is one in the window.
  const old = [reviewRow('2026-10-11T07:00:00Z', { caller_tool_use_id: 'w3' }), reviewRow('2026-10-12T11:00:00Z', { caller_tool_use_id: 'w3' })];
  assert.deepEqual(drive(reg, { spawnRows: old, nowT, af: OPUS_AF }).newFlags, ['dec-one/repeat@unexercised']);
});

test('6. subagentTypeStartsWith matches the effective type; medium-not-landing flags a high writer', () => {
  const med = { id: 'medium', premise: 'p1', kind: 'exercise', source: 'spawns', afterDays: 3,
    where: { declared_type: 'bounded-feature', subagentTypeStartsWith: 'agent-companion:ac-sonnet' }, expect: { effective_effort: 'medium' } };
  const reg = exReg(med);
  const w = (at, o) => srow(at, { declared_type: 'bounded-feature', effective_effort: 'medium', ...o });
  const rows = [
    w('2026-10-11T09:00:00Z', { subagent_type: 'agent-companion:ac-opus-high', effective_effort: 'high' }), // other family: ignored
    w('2026-10-11T10:00:00Z', { subagent_type: 'agent-companion:ac-sonnet-medium' }), // fine
  ];
  assert.deepEqual(drive(reg, { spawnRows: rows, nowT: AF + DAY, af: AF }).newFlags, []);
  const rewritten = w('2026-10-11T11:00:00Z', { subagent_type: 'agent-companion:ac-opus-high', subagent_type_rewritten_to: 'agent-companion:ac-sonnet-high', effective_effort: 'high' });
  const out = drive(reg, { spawnRows: [...rows, rewritten], nowT: AF + DAY, af: AF });
  assert.deepEqual(out.newFlags, ['dec-one/medium@wrong-2026-10-11T11:00:00Z']);
  assert.equal(matchesWhere({ subagent_type: 'general-purpose' }, { subagentTypeStartsWith: 'agent-companion:ac-sonnet' }), false);
});

test('6. an unexercised flag closes when a matching row appears later', () => {
  const reg = exReg(capTrigger());
  const state = emptyState();
  drive(reg, { nowT: OPUS_AF + 7 * DAY, af: OPUS_AF, state });
  assert.equal(state.flags['dec-one/cap@unexercised'].closed, null);
  drive(reg, { spawnRows: [reviewRow('2026-10-19T10:00:00Z')], nowT: OPUS_AF + 9 * DAY, af: OPUS_AF, state });
  assert.ok(state.flags['dec-one/cap@unexercised'].closed);
});

test('6. end to end: runRegister writes a wrong flag and the offending row into the detail file', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ 'staged-one': '2026-10-11T08:00:00Z' }));
    writeFileSync(registerPath(), JSON.stringify(exReg(capTrigger())));
    const historyFile = join(fx.dir, 'history.jsonl');
    writeFileSync(historyFile, `${JSON.stringify(hday('2026-10-11'))}\n`);
    const spawnsFile = join(fx.dir, 'spawns.jsonl');
    writeFileSync(spawnsFile, `${JSON.stringify(reviewRow('2026-10-12T10:00:00Z', { effective_effort: 'xhigh' }))}\ngarbage\n`);
    const out = runRegister({ nowT: T('2026-10-12T20:00:00Z'), historyFile, spawnsFile });
    assert.deepEqual(out.newFlags, ['dec-one/cap@wrong-2026-10-12T10:00:00Z']);
    const md = readFileSync(detailPath(), 'utf8');
    assert.match(md, /effective_effort xhigh/);
    assert.match(md, /caller_declared_type bounded-feature/);
  } finally { fx.cleanup(); }
});
