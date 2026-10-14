// Batch 6b of the daily usage analysis (0.31.18): the worker, routing, review, context, Haiku, routine and plugin metrics,
// their stat() adapters, the adapters of the register metrics that had only day(), and the shipped scenarios. Every figure
// is checked on a synthetic facts day plus synthetic telemetry and scheduled-run records, end to end through the runner with
// the REAL adapters. Ids are sess-*; nothing reads the operator's data; a fake `claude` on PATH is never called; nothing is
// written outside the state root.
import { makeFixture, runScript } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, utimesSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { dayRange } from '../scripts/lib/usage/days.mjs';
import { runAnalysis, readResult } from '../scripts/lib/usage/runner.mjs';
import { listMetrics, getMetric, FROZEN_REGISTER_IDS } from '../scripts/lib/usage/metrics/index.mjs';
import { RUNG_ORDER } from '../scripts/lib/usage/metrics/workers.mjs';
import { cronFiresBetween } from '../scripts/lib/usage/routines.mjs';

// ---------------------------------------------------------------- fixtures --

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const NOW = Date.parse('2026-10-11T12:00:00Z'); // 2026-10-10 (08:00Z to 08:00Z) is the last closed, settled day
const FIRST = '2026-10-02';
const LAST = '2026-10-10';
const T = (u, o = 0, req = 1) => [u, o, 0, 0, 0, req]; // u plan units of plain input (o output tokens at 5x), req requests
const Z = () => [0, 0, 0, 0, 0, 0];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg || 'value'}: ${a} vs ${b}`);

function row(hour, sid, { main = {}, proj = 'alpha', cwd = null, n = 0 } = {}) {
  const t = {};
  for (const [m, u] of Object.entries(main)) (t[m] ||= { m: Z(), s: Z() }).m = T(u);
  return { hour, sid, proj, cwd, tok: t, pr: { n, len: [n, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0 };
}

function spawn(day, sid, id, hm, o) {
  const { type, rung, model, fit, bucket, n, cat, ctx, peak, startup, comp, extraTurns, status, simple, rk } = o;
  return {
    id, sid, aid: `a-${id}`, proj: 'alpha', ...(type ? { type } : {}), role: 'writer', rung, ...(fit ? { fit } : {}), model, mixed: false,
    start: `${day}T${hm}:00.000Z`, end: `${day}T${hm}:20.000Z`, partial: false,
    req: { n, bucket, cat }, ctx: { buckets: [ctx[0] || Z(), ctx[1] || Z(), ctx[2] || Z(), ctx[3] || Z()], peak },
    startup, comp: comp || { n: 0, after: null }, extraTurns: extraTurns || 0, ...(status ? { status } : {}),
    simple: simple || { runs: 0, req: 0, tok: Z() }, rk: rk || { d: null, n: null, h: null },
  };
}

// seven spawns; units 10, 20, 50, 30, 8, 6, 14 = 138
function daySpawns(day) {
  return [
    spawn(day, 'sess-w1', 'sp1', '10:00', { type: 'explore', rung: 'haiku', model: HAIKU, fit: 'fit', bucket: '6-15', n: 10, cat: { read: T(6, 0, 6), wait: T(2, 0, 2), test: T(2, 0, 2) }, ctx: [T(10)], peak: 40000, startup: T(1), status: 'done', rk: { d: 'D1', n: null, h: null } }),
    spawn(day, 'sess-w1', 'sp2', '10:30', { type: 'explore', rung: 'sonnet/medium', model: SONNET, fit: 'fit', bucket: '6-15', n: 12, cat: { read: T(14, 0, 9), 'edit-small': T(2, 0, 1), wait: T(4, 0, 2) }, ctx: [T(20)], peak: 60000, startup: T(1), status: 'done', rk: { d: 'D1', n: null, h: null } }),
    spawn(day, 'sess-w1', 'sp3', '11:00', { type: 'bounded-feature', rung: 'sonnet/high', model: SONNET, fit: 'over', bucket: '16-40', n: 20, cat: { 'edit-small': T(10, 0, 5), test: T(30, 0, 10), read: T(10, 0, 5) }, ctx: [T(20), T(20), T(10)], peak: 160000, startup: T(2), comp: { n: 1, after: T(5) }, extraTurns: 2, status: 'done', simple: { runs: 1, req: 4, tok: T(3) }, rk: { d: 'D3', n: null, h: null } }),
    spawn(day, 'sess-w2', 'sp4', '12:00', { type: 'code-review', rung: 'opus/medium', model: OPUS, fit: 'fit', bucket: '6-15', n: 8, cat: { read: T(30, 0, 8) }, ctx: [T(30)], peak: 70000, startup: T(3), status: 'partial', rk: { d: 'D4', n: null, h: null } }),
    spawn(day, 'sess-w2', 'sp5', '13:00', { rung: 'sonnet/high', model: SONNET, bucket: '1-5', n: 3, cat: { text: T(8, 0, 3) }, ctx: [T(8)], peak: 20000, startup: T(1) }),
    spawn(day, 'sess-w2', 'sp6', '14:00', { type: 'lookup', rung: 'sonnet/low', model: SONNET, fit: 'under', bucket: '1-5', n: 4, cat: { read: T(6, 0, 4) }, ctx: [T(6)], peak: 20000, startup: T(1), status: 'blocked' }),
    spawn(day, 'sess-w2', 'sp7', '15:00', { type: 'explore', rung: 'haiku', model: HAIKU, fit: 'fit', bucket: '6-15', n: 8, cat: { read: T(14, 0, 8) }, ctx: [T(4, 2, 8)], peak: 30000, startup: T(1), status: 'done', rk: { d: 'D7', n: null, h: null } }),
  ];
}

const routineCwd = (fx) => join(fx.dir, 'routine-folder').split('\\').join('/');

function dayRows(day, fx) {
  return [
    row(`${day}T10:00:00.000Z`, 'sess-w1', { main: { [SONNET]: 30 }, n: 3 }),
    row(`${day}T12:00:00.000Z`, 'sess-w2', { main: { [SONNET]: 20 }, proj: 'beta', n: 2 }),
    row(`${day}T09:00:00.000Z`, 'sess-routine', { main: { [SONNET]: 12 }, proj: 'beta', cwd: routineCwd(fx) }),
  ];
}

function writeFacts(root, day, rows, spawns) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const models = {};
  for (const m of [SONNET, OPUS, HAIKU]) models[m] = { ...SPEC };
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${next}T08:00:00.000Z`, dataThrough: `${next}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${next}T09:00:00.000Z`, weightsUsed: models, rows, spawns,
  }));
}

function seed(root, fx) {
  for (const day of dayRange(FIRST, LAST)) writeFacts(root, day, dayRows(day, fx), daySpawns(day));
  // the history record of the last day, with ceiling nudges
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'daily-checkup-history.jsonl'), `${JSON.stringify({
    v: 1, day: LAST, limitUnits: 2677, targetPct: 4, units: { main: 1, subagent: 1, total: 2 }, pct: { total: 4 },
    week: { start: '2026-10-09T16:00:00.000Z', units: 321.24, pctSoFar: 12, elapsedPct: 10, paceAtResetPct: 120, partial: false },
    limit: { hits: 0, firstAt: null }, ceilingNudges: 3,
  })}\n`);
  // routine pins: the folder a routine runs from
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'routine-pins.json'), JSON.stringify({ folders: { 'nightly-scan': routineCwd(fx) } }));
}

const jl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
function writeTelemetry(root) {
  const dir = join(root, 'telemetry');
  mkdirSync(dir, { recursive: true });
  const at = (hm) => `${LAST}T${hm}:00.000Z`;
  const base = { caller_is_subagent: false, guard_version: '0.31.17' };
  writeFileSync(join(dir, 'spawns.jsonl'), jl([
    { ...base, at: at('10:00'), session_id: 'sess-w1', tool_use_id: 'tu-1', caller_effort: 'xhigh', declared_type: 'bounded-feature', fit: 'under', model: 'sonnet', desc_sha: 'aaa', name: 'job-1' },
    { ...base, at: at('10:30'), session_id: 'sess-w1', tool_use_id: 'tu-2', caller_effort: 'xhigh', declared_type: 'bounded-feature', fit: 'fit', model: 'sonnet', desc_sha: 'aaa', name: 'job-1-fix', pin_model_departed: true },
    { ...base, at: at('11:00'), session_id: 'sess-w2', tool_use_id: 'tu-3', caller_effort: 'high', declared_type: 'bounded-feature', fit: 'over', model: 'sonnet', desc_sha: 'bbb', name: 'other', guard_version: '0.31.18' },
    { at: at('12:00'), session_id: 'sess-w2', tool_use_id: 'tu-4', caller_is_subagent: true, caller_tool_use_id: 'tu-3', declared_type: 'code-review', model: 'opus', guard_version: '0.31.18' },
    { at: at('12:30'), session_id: 'sess-w2', tool_use_id: 'tu-5', caller_is_subagent: true, caller_tool_use_id: 'tu-1', declared_type: 'code-review', model: 'opus', review_verdict: 'PASS', guard_version: '0.31.18' },
    { at: at('13:00'), session_id: 'sess-w2', tool_use_id: 'tu-6', caller_is_subagent: true, declared_type: 'bounded-feature', model: 'haiku', guard_version: '0.31.18' },
  ]));
  writeFileSync(join(dir, 'review-verdicts.jsonl'), jl([{ session_id: 'sess-w2', review_of_tool_use_id: 'tu-4', review_verdict: 'FIX' }]));
  writeFileSync(join(dir, 'denials.jsonl'), jl([{ at: at('10:15'), session_id: 'sess-w1', outcome: 'deny', guard: 'fit' }]));
  writeFileSync(join(dir, 'struggle.jsonl'), jl([
    { ts: at('10:00'), session_id: 'sess-w1', flagged: true },
    { ts: at('10:05'), session_id: 'sess-w1', flagged: false },
    { ts: at('11:00'), session_id: 'sess-w2', flagged: false },
  ]));
}

// scheduled runs: three fires of one routine; its SKILL.md pins sonnet and the folder pins medium effort for sonnet
function writeRoutines(fx) {
  const sessions = join(fx.dir, 'sessions');
  const cdir = join(fx.dir, 'cdir');
  const cwd = routineCwd(fx);
  const old = new Date('2026-10-01T00:00:00Z');
  const fires = [
    { id: 'sess-r1', at: '2026-10-10T09:00:00Z', model: OPUS, effort: 'high' }, // wrong model
    { id: 'sess-r2', at: '2026-10-10T09:30:00Z', model: SONNET, effort: 'high' }, // wrong effort
    { id: 'sess-r3', at: '2026-10-10T10:00:00Z', model: SONNET, effort: 'medium' }, // as pinned
  ];
  mkdirSync(join(sessions, 'acct', 'org'), { recursive: true });
  for (const f of fires) {
    writeFileSync(join(sessions, 'acct', 'org', `local_${f.id}.json`), JSON.stringify({
      scheduledTaskId: 'nightly-scan', sessionId: `local_${f.id}`, cwd, model: f.model, effort: f.effort, createdAt: Date.parse(f.at),
    }));
  }
  const skill = join(cdir, 'scheduled-tasks', 'nightly-scan', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, '---\nname: nightly-scan\nmodel: sonnet\n---\nscan\n');
  utimesSync(skill, old, old);
  const pin = join(cwd, '.claude', 'settings.local.json');
  mkdirSync(dirname(pin), { recursive: true });
  writeFileSync(pin, JSON.stringify({ modelSettings: { sonnet: { effortLevel: 'medium' } } }));
  utimesSync(pin, old, old);
  return { sessionsRoot: sessions, claudeDirPath: cdir };
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

const WORKER_IDS = [
  'spawn.rungLadder', 'haiku.likeForLike', 'spawn.startupUnits', 'spawn.categoryMix', 'spawn.pollWaste', 'spawn.gateAt100k', 'spawn.outcomeByRung',
  'spawn.escalations', 'spawn.extraTurns', 'spawn.typeMix', 'spawn.fitOverShare', 'spawn.untypedShare', 'spawn.exploreShape', 'spawn.respawnRate',
  'spawn.outputPerRequest', 'spawn.pinDeparture', 'spawn.simpleRuns', 'review.fixShare', 'review.size', 'spawn.declaredVsActual',
  'snag.precisionRecall', 'haiku.spawnsUnits', 'haiku.complianceLeak', 'plugin.versionEvents', 'routine.modelDrift', 'routine.costPerRun', 'routine.missedRuns',
];
const ADAPTED = [
  'unitsPerSpawn', 'shareOver150kPct', 'compactionsPer100Spawns', 'ceilingNudgesPerDay', 'leadEffortShare', 'reviewsPerWriter', 'haikuSpawns',
  'leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare',
];

// ------------------------------------------------------------------ tests --

test('every 6b metric and every listed register metric has both day() and stat(); the register ids stay frozen', () => {
  for (const id of [...WORKER_IDS, ...ADAPTED]) {
    const m = getMetric(id);
    assert.ok(m, `${id} is in the registry`);
    assert.equal(typeof m.day, 'function', `${id} day()`);
    assert.equal(typeof m.stat, 'function', `${id} stat()`);
    assert.ok(['M', 'E'].includes(m.label), id);
    assert.ok(Array.isArray(m.recordKinds) && m.recordKinds.length > 0, `${id} names the record kinds it reads`);
  }
  for (const id of WORKER_IDS) assert.equal(getMetric(id).register, false, `${id} is not a register metric`);
  for (const id of ADAPTED) assert.equal(getMetric(id).register, true, `${id} stays a register metric`);
  assert.equal(FROZEN_REGISTER_IDS.length, 13);
  // after this batch only the rater-backed lead metrics have no adapter, and they are not in the registry at all
  assert.deepEqual(listMetrics().filter((m) => typeof m.stat !== 'function').map((m) => m.id), []);
  assert.equal(getMetric('lead.corrections'), null);
  assert.equal(getMetric('lead.costPerCorrection'), null);
});

test('the rung order the escalation metric uses is the shipped ladder', () => {
  const tiers = JSON.parse(readFileSync(new URL('../config/model-tiers.json', import.meta.url), 'utf8'));
  const labels = tiers.ladder.map((r) => (r.model === 'haiku' ? 'haiku' : `${r.model}/${r.effort}`));
  assert.deepEqual([...RUNG_ORDER], labels);
});

test('spawn, review, context and Haiku metrics on a fixture day, through the runner with the real adapters', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    writeTelemetry(root);
    const out = run(root, writeRoutines(fx));
    assert.equal(out.error, undefined);
    assert.deepEqual(out.deferred, []);
    const res = readResult(root, LAST);
    const v = (id) => currentOf(res, id).value;
    const d = (id) => currentOf(res, id).detail;

    near(v('spawn.unitsPerSpawn'), 138 / 7, 'units per spawn');
    near(v('spawn.unitsSonnetHigh'), 29, 'units per spawn, cohort rung sonnet/high (the canonical label)');
    // a rung cohort entry with a slash is valid; the old dashed label matches nothing
    // rungLadder: spawns of 6-15 requests only: sp1 10, sp2 20, sp4 30, sp7 14; grouped by rung
    const ladder = scenarioOf(res, 'spawn.rungLadder').groups;
    assert.deepEqual(ladder.map((g) => g.key), ['haiku', 'opus/medium', 'sonnet/high', 'sonnet/low', 'sonnet/medium'], 'every rung is a group; a rung without spawns in the bucket has no value');
    near(ladder.find((g) => g.key === 'opus/medium').comparisons[0].current.value, 30, 'opus/medium rung');
    near(ladder.find((g) => g.key === 'haiku').comparisons[0].current.value, 12, 'haiku rung');
    // like for like: explore, 6-15: sp1 10 and sp7 14 on haiku, sp2 20 on sonnet/medium
    const lfl = scenarioOf(res, 'haiku.likeForLike').groups;
    near(lfl.find((g) => g.key === 'sonnet/medium').comparisons[0].current.value, 20, 'sonnet/medium explore');
    near(lfl.find((g) => g.key === 'haiku').comparisons[0].current.value, 12, 'haiku explore');
    near(v('spawn.startupUnits'), 10 / 7, 'startup units');
    // categories: 65 requests, 40 of them reads
    near(v('spawn.categoryMix'), (40 / 65) * 100, 'read share of requests');
    assert.equal(d('spawn.categoryMix').key, 'read');
    near(v('spawn.pollWaste'), (6 / 138) * 100, 'wait units over spawn units');
    near(v('spawn.gateAt100k'), (30 / 32) * 100, 'test units in spawns that passed 100K');
    // outcomes by rung: the haiku and sonnet rungs finished, the opus spawn was partial and the sonnet/low spawn blocked
    const oc = Object.fromEntries(scenarioOf(res, 'spawn.outcomeByRung').groups.map((g) => [g.key, g.comparisons[0].current.value]));
    assert.deepEqual(oc, { haiku: 100, 'opus/medium': 0, 'sonnet/high': 100, 'sonnet/low': 0, 'sonnet/medium': 100 });
    near(v('spawn.compactions'), (1 / 7) * 100, 'compactions per 100 spawns');
    near(v('spawn.escalations'), (1 / 7) * 100, 'sp2 re-spawned sp1 one rung up');
    near(v('spawn.extraTurns'), (2 / 7) * 100, 'extra turns per 100 spawns');
    near(v('spawn.typeMix'), (3 / 7) * 100, 'explore is the largest type');
    assert.equal(d('spawn.typeMix').key, 'explore');
    near(v('spawn.fitOverShare'), (1 / 6) * 100, 'fit over share of scored spawns');
    near(v('spawn.untypedShare'), (1 / 7) * 100, 'one spawn has no type');
    near(v('spawn.exploreShape'), 10, 'mean requests per explore spawn');
    assert.equal(d('spawn.exploreShape').median, 10);
    assert.equal(d('spawn.exploreShape').twoGroups.split, false);
    near(v('spawn.respawnRate'), (1 / 7) * 100, 're-spawn rate');
    const opr = Object.fromEntries(scenarioOf(res, 'spawn.outputPerRequest').groups.map((g) => [g.key, g.comparisons[0].current.value]));
    near(opr[HAIKU], 2 / 18, 'output tokens per request on haiku (sp1 and sp7: 18 requests)');
    near(opr[SONNET], 0, 'no output on sonnet');
    // spawn.simpleRuns is a weekly scenario, not due on this day: see the direct stat() test
    assert.equal(scenarioOf(res, 'spawn.simpleRuns').skipped, 'not-due');
    near(v('spawn.declaredVsActual'), (1 / 5) * 100, 'read-only spawns that edited');
    near(v('review.size'), 30, 'reviewer units');
    near(v('ctx.over150kShare'), (10 / 138) * 100, 'worker units over 150K context');
    near(v('ctx.ceilingNudges'), 3, 'ceiling nudges from the history record');
    near(v('haiku.spawnsUnits'), 24, 'haiku units');
    assert.equal(d('haiku.spawnsUnits').haikuSpawns, 2);
    near(v('haiku.complianceLeak'), 50, 'haiku-default types on another family (sp2, sp6 of sp1, sp2, sp6, sp7)');
  } finally { fx.cleanup(); }
});

test('telemetry-backed metrics: pin departures, review verdicts, plugin versions, struggle flags', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    writeTelemetry(root);
    run(root, writeRoutines(fx));
    const res = readResult(root, LAST);
    const v = (id) => currentOf(res, id).value;
    near(v('spawn.pinDeparture'), (1 / 6) * 100, 'one of six rows carries the pin departure flag');
    near(v('review.fixShare'), 50, 'one FIX (folded from review-verdicts.jsonl) and one PASS');
    assert.equal(currentOf(res, 'review.fixShare').detail.byReviewerModel.opus.n, 2);
    const ver = currentOf(res, 'plugin.versionEvents');
    assert.equal(ver.value, 2, 'two guard versions were first seen on the day');
    assert.deepEqual(ver.detail.firstSeen, ['0.31.17', '0.31.18']);
    // struggle: sess-w1 flagged and had a re-spawn; recall: sess-w2 also had bad outcomes but was not flagged
    const snag = currentOf(res, 'snag.precisionRecall');
    near(snag.value, 100, 'precision');
    near(snag.detail.recallPct, 50, 'recall');
  } finally { fx.cleanup(); }
});

test('register metrics that had only day() now evaluate through the runner', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    writeTelemetry(root);
    const mk = (metric, params = {}) => ({
      id: `u.reg.${metric}`, title: metric, metric, params, compare: ['prior-day'], threshold: { direction: 'up-is-worse', minSample: 1 }, severity: 'info', cadence: 'daily',
    });
    userConfig(root, {
      scenarios: [
        mk('unitsPerSpawn', { type: 'explore' }), mk('shareOver150kPct'), mk('compactionsPer100Spawns'), mk('ceilingNudgesPerDay'),
        mk('leadEffortShare', { levels: 'xhigh' }), mk('reviewsPerWriter', { writerType: 'bounded-feature' }), mk('haikuSpawns'),
        mk('leadRebriefsPer100Spawns', { levels: 'xhigh' }), mk('reviewFixShareByLeadEffort', { levels: 'high,xhigh' }),
        mk('leadRoutingDeniesPer100Spawns', { levels: 'xhigh' }), mk('leadUnderProvisionedShare', { levels: 'xhigh' }),
        mk('leadEffortShare', {}),
      ].map((s, i, all) => (i === all.length - 1 ? { ...s, id: 'u.reg.noLevels' } : s)),
    });
    const out = run(root, writeRoutines(fx));
    assert.equal(out.error, undefined);
    const res = readResult(root, LAST);
    const v = (m) => currentOf(res, `u.reg.${m}`).value;
    near(v('unitsPerSpawn'), 44 / 3, 'explore spawns: 10 + 20 + 14 units over 3 spawns');
    near(v('shareOver150kPct'), (10 / 138) * 100, 'share over 150K');
    near(v('compactionsPer100Spawns'), (1 / 7) * 100, 'compactions per 100 spawns');
    near(v('ceilingNudgesPerDay'), 3, 'ceiling nudges');
    // telemetry rows: 3 lead rows (2 xhigh, 1 high)
    near(v('leadEffortShare'), 2 / 3, 'share of lead spawns at xhigh');
    near(v('reviewsPerWriter'), 2 / 4, 'two reviewer rows over four bounded-feature rows');
    near(v('haikuSpawns'), 1, 'one telemetry row names haiku');
    near(v('leadRebriefsPer100Spawns'), 50, 'job-1-fix repeats job-1 inside six hours');
    near(v('reviewFixShareByLeadEffort'), 50, 'one FIX, one PASS, both writers at high or xhigh');
    near(v('leadRoutingDeniesPer100Spawns'), 50, 'one deny over two xhigh lead rows');
    near(v('leadUnderProvisionedShare'), 50, 'one under, one fit');
    // a lead-level metric without params.levels is a gap that says what is missing
    const g = scenarioOf(res, 'u.reg.noLevels').comparisons[0];
    assert.match(JSON.stringify(g), /params\.levels/);
  } finally { fx.cleanup(); }
});

test('stat() adapters read their records directly: simple runs, gaps for missing data, no invented zero', () => {
  const sp = (o) => ({ kind: 'spawn', sid: 'sess-x', id: 'sp', units: { total: 100 }, ...o });
  const simple = getMetric('spawn.simpleRuns').stat([sp({ simple: { runs: 1, req: 4, units: 3 } }), sp({ id: 'sp2', units: { total: 38 } })], { params: { savingFraction: 0.25 } });
  near(simple.num / simple.den * simple.scale, (3 / 138) * 100, 'simple runs share of spawn units');
  near(simple.detail.modelledSavingUnits, 0.75, 'modelled saving uses the stated fraction');
  assert.equal(getMetric('spawn.simpleRuns').label, 'E', 'the saving is a model, not a measurement');
  for (const id of WORKER_IDS.filter((x) => !x.startsWith('routine.'))) assert.equal(getMetric(id).stat([], { params: {} }).gap, true, `${id}: no records is a gap`);
  for (const id of ADAPTED) assert.equal(getMetric(id).stat([], { params: {} }).gap, true, `${id}: no records is a gap`);
  assert.match(getMetric('spawn.outcomeByRung').stat([sp({})], { params: {} }).why, /STATUS/, 'no reported status: a gap that says why');
  assert.match(getMetric('spawn.gateAt100k').stat([sp({ peakCtx: 5 })], { params: {} }).why, /no test requests/);
  assert.match(getMetric('ceilingNudgesPerDay').stat([{ kind: 'day', hist: { limit: null } }], {}).why, /ceiling nudges/);
});

test('routine metrics read the decision register and the routine pins; a missing register is unobservable, never zero', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    userConfig(root, { environment: { routines: { watch: ['nightly-scan', 'hourly-sync'], cron: { 'hourly-sync': '30 * * * *' } } } });
    const out = run(root, writeRoutines(fx));
    assert.equal(out.error, undefined);
    const res = readResult(root, LAST);
    // three fires, all pinned (model line and folder effort pin): the wrong model and the wrong effort drifted
    const drift = currentOf(res, 'routine.modelDrift');
    near(drift.value, (2 / 3) * 100, 'drifted fires over pinned fires');
    assert.equal(drift.detail.tasks['nightly-scan'].drifted, 2);
    assert.ok(drift.detail.tasks['nightly-scan'].why.some((w) => /model .*pinned sonnet/.test(w)));
    assert.ok(drift.detail.tasks['nightly-scan'].why.some((w) => /effort high, pinned medium/.test(w)));
    // the routine session in the routine folder holds 12 units over 3 fires
    near(currentOf(res, 'routine.costPerRun').value, 4, 'units per fire');
    // nightly-scan has no cron (daily, seen 3 times); hourly-sync fires 24 times in a day and was never seen
    const missed = currentOf(res, 'routine.missedRuns');
    assert.equal(missed.value, 24);
    assert.equal(missed.detail.tasks['hourly-sync'].missed, 24);
    assert.equal(missed.detail.tasks['nightly-scan'].missed, 0);
  } finally { fx.cleanup(); }
});

test('without the decision register the routine metrics are unobservable, not zero', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    userConfig(root, { environment: { routines: { watch: ['nightly-scan'] } } });
    const out = run(root, { sessionsRoot: join(fx.dir, 'no-such-sessions'), claudeDirPath: join(fx.dir, 'no-such-cdir') });
    assert.equal(out.error, undefined);
    const res = readResult(root, LAST);
    for (const id of ['routine.modelDrift', 'routine.costPerRun', 'routine.missedRuns']) {
      const c = scenarioOf(res, id).comparisons[0];
      assert.ok(c, id);
      assert.equal(c.current && c.current.value, null, `${id} has no value`);
      assert.match(JSON.stringify(c), /unobservable/, `${id} says unobservable`);
    }
    assert.match(getMetric('routine.modelDrift').stat([], {}).why, /unobservable/);
    assert.match(getMetric('routine.modelDrift').stat([{ kind: 'routineSource', dr: false, fires: 0, watch: [], cron: {} }], {}).why, /unobservable/);
    assert.match(getMetric('routine.missedRuns').stat([{ kind: 'routineSource', dr: false, fires: 0, watch: ['x'], cron: {} }], {}).why, /unobservable/);
  } finally { fx.cleanup(); }
});

test('cronFiresBetween: steps, lists, ranges, and expressions it does not understand', () => {
  const a = Date.parse('2026-10-10T08:00:00Z');
  const day = 24 * 3600 * 1000;
  assert.equal(cronFiresBetween('30 * * * *', a, a + day), 24);
  assert.equal(cronFiresBetween('0 12 * * *', a, a + day), 1);
  assert.equal(cronFiresBetween('*/15 * * * *', a, a + day), 96);
  assert.equal(cronFiresBetween('not a cron', a, a + day), null);
  assert.equal(cronFiresBetween('61 * * * *', a, a + day), null);
});

test('a fire is only judged against pins that existed when it started', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    const paths = writeRoutines(fx);
    // the SKILL.md and the folder pin are rewritten after the fires: they say nothing about them
    const later = new Date('2026-10-12T00:00:00Z');
    utimesSync(join(paths.claudeDirPath, 'scheduled-tasks', 'nightly-scan', 'SKILL.md'), later, later);
    utimesSync(join(routineCwd(fx), '.claude', 'settings.local.json'), later, later);
    run(root, paths);
    const c = scenarioOf(readResult(root, LAST), 'routine.modelDrift').comparisons[0];
    assert.equal(c.current && c.current.value, null, 'no fire had a pin to be judged against');
    assert.match(JSON.stringify(c), /no fire of the day had a pin/);
  } finally { fx.cleanup(); }
});

test('the shipped 6b scenarios use known metrics and the canonical rung label, and sit below the untouched 6a block', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/usage-analysis.defaults.json', import.meta.url), 'utf8'));
  const ids = cfg.scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.indexOf('day.units'), 0);
  assert.equal(ids.indexOf('lead.correctionFlags'), 20, 'the 6a block is contiguous at the top');
  const tail = cfg.scenarios.slice(21);
  assert.equal(tail[0].id, 'spawn.unitsPerSpawn', 'the 6b block follows directly');
  for (const s of tail) assert.ok(getMetric(s.metric), `${s.id} names the metric ${s.metric}`);
  for (const id of ['spawn.rungLadder', 'haiku.likeForLike', 'routine.modelDrift', 'routine.missedRuns', 'plugin.versionEvents', 'snag.precisionRecall', 'spawn.pinDeparture']) assert.ok(ids.includes(id), id);
  assert.deepEqual(tail.find((s) => s.id === 'spawn.unitsSonnetHigh').cohort.rung, ['sonnet/high']);
  for (const s of tail.filter((x) => x.cohort && x.cohort.rung)) for (const r of s.cohort.rung) assert.match(r, /^(haiku|(sonnet|opus)\/(low|medium|high|xhigh|max))$/);
  const fx = makeFixture();
  try {
    seed(fx.stateDir, fx);
    run(fx.stateDir);
    const res = readResult(fx.stateDir, LAST);
    for (const s of tail) {
      const r = scenarioOf(res, s.id);
      assert.ok(r, `${s.id} was evaluated`);
      assert.notEqual(r.skipped, 'unknown-metric', s.id);
    }
  } finally { fx.cleanup(); }
});

test('a run never calls claude and writes only under the state root; the fixtures hold no machine identifiers', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seed(root, fx);
    writeTelemetry(root);
    const paths = writeRoutines(fx);
    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    const before = snapshot(fx.dir);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${savedPath}`;
    try { run(root, paths); } finally { process.env.PATH = savedPath; }
    assert.ok(!existsSync(log), 'the fake claude was never called');
    const after = snapshot(fx.dir);
    for (const p of Object.keys(after)) {
      if (after[p] === before[p]) continue;
      assert.ok(/^\.claude\/agent-companion\//.test(p), `written outside the state root: ${p}`);
      assert.ok(!/^\.claude\/agent-companion\/telemetry\//.test(p), `the telemetry is only read: ${p}`);
    }
    for (const p of Object.keys(before)) if (/^(sessions|cdir|routine-folder)\//.test(p)) assert.equal(after[p], before[p], `${p} is only read`);
    // the fixture source: no username, machine path, 7-12 hex id (sess-* ids only) or internal service name
    const src = readFileSync(new URL('./usage-scenarios-workers.test.mjs', import.meta.url), 'utf8');
    // A hosted CI or container account ("runner", "root") is an ordinary word this file uses in prose
    // ("the runner", "the state root"), so it is checked only as a path segment, as scripts/leak-check.mjs does.
    const user = userInfo().username.toLowerCase();
    const serviceAccount = ['runner', 'runneradmin', 'root', 'user', 'node', 'ubuntu', 'vsts', 'vscode', 'codespace'].includes(user);
    const lower = src.toLowerCase();
    assert.ok(serviceAccount ? !lower.includes(`/${user}/`) && !lower.includes(`\\${user}\\`) : !lower.includes(user), 'no username');
    assert.ok(!/[A-Za-z]:[\\/]+(Users|Windows)|\/home\/\w|\/Users\/\w/.test(src), 'no machine path');
    assert.ok(!/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/.test(src), 'no 7-12 hex id');
    assert.ok(!new RegExp(['deck' + 'hand', 'wheel' + 'house'].join('|'), 'i').test(src), 'no internal service name');
  } finally { fx.cleanup(); }
});

test('the 6b library files make no model call, start no process, never wait, write nothing; the metric files are pure', () => {
  for (const rel of ['scripts/lib/usage/metrics/workers.mjs', 'scripts/lib/usage/metrics/routine.mjs', 'scripts/lib/usage/telemetry.mjs', 'scripts/lib/usage/routines.mjs']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(!/child_process/.test(src), `${rel} starts no process of its own`);
    assert.ok(!/setTimeout|setInterval|Atomics\.wait|sleep\(/.test(src), `${rel} never waits`);
    assert.ok(!/['"`]claude['"`]|claude -p|api\.anthropic/.test(src), `${rel} makes no model call`);
    assert.ok(!/writeFileSync|appendFileSync|mkdirSync|unlinkSync|renameSync/.test(src), `${rel} writes nothing`);
  }
  for (const rel of ['scripts/lib/usage/metrics/workers.mjs', 'scripts/lib/usage/metrics/routine.mjs']) {
    assert.ok(!/node:fs|node:os|node:path/.test(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')), `${rel} is pure`);
  }
});
