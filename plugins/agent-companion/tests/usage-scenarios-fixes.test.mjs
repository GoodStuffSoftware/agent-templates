// Review fixes for the 0.31.18 usage scenarios (batches 6a and 6b) and the python guard's warn path:
// A-1 untyped share, A-2 struggle rows as the writer emits them, A-3/A-4 the `level` comparison for routine drift and missed runs,
// A-5 week.pace across the plan-week reset, B-1 the warn-mode python note beside the worker one-wait advisory.
// Synthetic fixtures end to end through the runner; ids are sess-*; nothing reads the operator's data.
import { makeFixture, runHook } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dayRange } from '../scripts/lib/usage/days.mjs';
import { runAnalysis, readResult } from '../scripts/lib/usage/runner.mjs';
import { telemetryRecords, isFlaggedRow } from '../scripts/lib/usage/telemetry.mjs';
import { compareOne } from '../scripts/lib/usage/compare.mjs';
import { getMetric } from '../scripts/lib/usage/metrics/index.mjs';

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const FIRST = '2026-10-02';
const LAST = '2026-10-10';
const Z = () => [0, 0, 0, 0, 0, 0];
const T = (u, o = 0, req = 1) => [u, o, 0, 0, 0, req];
const jl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

function row(hour, sid, { main = {}, sub = {}, proj = 'alpha', n = 0, len = [n, 0, 0, 0], corr = 0, ag = 0, gc = 0 } = {}) {
  const t = {};
  for (const [m, u] of Object.entries(main)) (t[m] ||= { m: Z(), s: Z() }).m = T(u);
  for (const [m, u] of Object.entries(sub)) (t[m] ||= { m: Z(), s: Z() }).s = T(u);
  return { hour, sid, proj, cwd: null, tok: t, pr: { n, len, corr }, ag, sm: 0, gc };
}

// `type` as spawnRecord() writes it: a task-type token, null when unknown; a day file from before the fix says 'none'
function spawn(day, sid, id, hm, o = {}) {
  return {
    id, sid, aid: `a-${id}`, proj: 'alpha', type: o.type === undefined ? null : o.type, role: 'none', rung: o.rung ?? 'sonnet/high', fit: o.fit ?? null, model: o.model ?? SONNET, mixed: false,
    start: `${day}T${hm}:00.000Z`, end: `${day}T${hm}:20.000Z`, partial: false,
    req: { n: 8, bucket: '6-15', cat: { read: T(8, 0, 8) } },
    ctx: { buckets: [T(8, 0, 8), Z(), Z(), Z()], peak: 50000 },
    startup: T(1), comp: { n: 0, after: null }, extraTurns: 0, status: o.status ?? null,
    simple: { runs: 0, req: 0, tok: Z() }, rk: { d: null, n: null, h: null },
  };
}

function writeFacts(root, day, rows, spawns = []) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  const models = {};
  for (const m of [SONNET, OPUS, HAIKU]) models[m] = { ...SPEC };
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${nextDay(day)}T08:00:00.000Z`, dataThrough: `${nextDay(day)}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${nextDay(day)}T09:00:00.000Z`, weightsUsed: models, rows, spawns,
  }));
}

const quietRows = (day) => [
  row(`${day}T10:00:00.000Z`, 'sess-lead-1', { main: { [OPUS]: 20 }, sub: { [SONNET]: 10 }, n: 20, len: [10, 6, 4, 0], corr: 2, ag: 3, gc: 2 }),
  row(`${day}T14:00:00.000Z`, 'sess-lead-2', { main: { [SONNET]: 12 }, proj: 'beta', n: 20, len: [10, 6, 4, 0], ag: 1, gc: 1 }),
];
const quietSpawns = (day) => [
  spawn(day, 'sess-lead-1', 'sp1', '10:00', { type: 'bounded-feature', fit: 'fit', status: 'done' }),
  spawn(day, 'sess-lead-1', 'sp2', '11:00', { type: 'explore', rung: 'haiku', model: HAIKU, fit: 'fit', status: 'done' }),
];
function seedQuiet(root) {
  for (const day of dayRange(FIRST, LAST)) writeFacts(root, day, quietRows(day), quietSpawns(day));
}
function userConfig(root, cfg) {
  const file = join(root, 'config', 'usage-analysis.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 'agent-companion/usage-analysis', schemaVersion: 1, ...cfg }));
}
const run = (root, extra = {}) => runAnalysis({ root, nowT: NOW, cwds: [], ...extra });
const scenarioOf = (res, id) => res.scenarios.find((s) => s.id === id);

// ------------------------------------------------------------------ A-1 --

test('A-1: spawn.untypedShare reads 100% when every spawn is untyped (type null, or "none" in a day file written before the fix)', () => {
  for (const unknown of [null, 'none']) {
    const fx = makeFixture();
    try {
      for (const day of dayRange(FIRST, LAST)) {
        writeFacts(fx.stateDir, day, quietRows(day), ['a', 'b', 'c'].map((id, k) => spawn(day, 'sess-lead-1', id, `1${k}:00`, { type: unknown })));
      }
      run(fx.stateDir);
      const res = readResult(fx.stateDir, LAST);
      const c = scenarioOf(res, 'spawn.untypedShare').comparisons[0].current;
      assert.equal(c.value, 100, `type ${unknown}: untypedShare reads ${c.value}%`);
      const tm = scenarioOf(res, 'spawn.typeMix').comparisons[0].current;
      assert.deepEqual(Object.keys(tm.detail.spawns), ['(untyped)']);
    } finally { fx.cleanup(); }
  }
});

test('A-1: a mix of typed and untyped spawns reads the untyped share', () => {
  const fx = makeFixture();
  try {
    for (const day of dayRange(FIRST, LAST)) {
      writeFacts(fx.stateDir, day, quietRows(day), [
        spawn(day, 'sess-lead-1', 'a', '10:00', { type: 'explore' }),
        spawn(day, 'sess-lead-1', 'b', '11:00', { type: 'none' }),
        spawn(day, 'sess-lead-1', 'c', '12:00', { type: null }),
        spawn(day, 'sess-lead-2', 'd', '13:00', { type: 'bounded-feature' }),
      ]);
    }
    run(fx.stateDir);
    const c = scenarioOf(readResult(fx.stateDir, LAST), 'spawn.untypedShare').comparisons[0].current;
    assert.equal(c.value, 50);
  } finally { fx.cleanup(); }
});

// ------------------------------------------------------------------ A-2 --

// rows exactly as hooks/struggle-detector.mjs appends them (appendLog('struggle.jsonl', ...)): flagged is the integer count of
// flagged prompts in the window, fired the boolean
const REAL_ROWS = [
  { ts: `${LAST}T10:00:00.000Z`, session_id: 'sess-lead-1', n: 5, score: 3, flagged: 2, fired: true, effort: 'high' },
  { ts: `${LAST}T10:30:00.000Z`, session_id: 'sess-lead-3', n: 6, score: 2, flagged: 2, fired: false, effort: null }, // cooldown or unattended: the window still flagged
  { ts: `${LAST}T11:00:00.000Z`, session_id: 'sess-lead-2', n: 3, score: 0, flagged: 0, fired: false, effort: 'high' },
  { ts: `${LAST}T11:05:00.000Z`, session_id: 'sess-lead-4', n: 4, score: 2, flagged: 1, fired: false, effort: 'high' }, // one flagged prompt: not a flag
];

test('A-2: isFlaggedRow and the struggle records read the writer\'s row shape', () => {
  assert.equal(isFlaggedRow(REAL_ROWS[0]), true);
  assert.equal(isFlaggedRow(REAL_ROWS[1]), true);
  assert.equal(isFlaggedRow(REAL_ROWS[2]), false);
  assert.equal(isFlaggedRow(REAL_ROWS[3]), false);
  assert.equal(isFlaggedRow({ flagged: true }), true, 'the older boolean form still counts');
  assert.equal(isFlaggedRow({ flagged: false }), false);
  assert.equal(isFlaggedRow(null), false);
  const recs = telemetryRecords({ spawns: [], denials: [], struggle: REAL_ROWS }, LAST, 8).filter((r) => r.kind === 'struggle');
  assert.deepEqual(recs.map((r) => [r.sid, r.flagged]), [['sess-lead-1', true], ['sess-lead-2', false], ['sess-lead-3', true], ['sess-lead-4', false]]);
});

test('A-2: snag.precisionRecall has a value on real-shape struggle rows', () => {
  const fx = makeFixture();
  try {
    for (const day of dayRange(FIRST, LAST)) {
      writeFacts(fx.stateDir, day, quietRows(day), [
        spawn(day, 'sess-lead-1', 'a', '10:00', { type: 'explore', status: 'blocked' }),
        spawn(day, 'sess-lead-2', 'b', '11:00', { type: 'explore', status: 'done' }),
      ]);
    }
    const tdir = join(fx.stateDir, 'telemetry');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'struggle.jsonl'), jl(REAL_ROWS));
    run(fx.stateDir);
    const c = scenarioOf(readResult(fx.stateDir, LAST), 'snag.precisionRecall').comparisons[0];
    assert.ok(c.current && Number.isFinite(c.current.value), `no value: ${c.why || c.status}`);
    assert.equal(c.current.detail.flaggedSessions, 2);
    assert.equal(c.current.detail.flaggedWithBadOutcome, 1);
  } finally { fx.cleanup(); }
});

// -------------------------------------------------------------- A-3, A-4 --

const routineCwd = (fx) => join(fx.dir, 'routine-folder').split('\\').join('/');
function seedRoutinePins(fx) {
  const sessions = join(fx.dir, 'sessions');
  const cdir = join(fx.dir, 'cdir');
  const cwd = routineCwd(fx);
  const old = new Date('2026-10-01T00:00:00Z');
  const skill = join(cdir, 'scheduled-tasks', 'nightly-scan', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, '---\nname: nightly-scan\nmodel: sonnet\n---\nscan\n');
  utimesSync(skill, old, old);
  mkdirSync(join(sessions, 'acct', 'org'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { sessions, cdir, cwd };
}
function fire(r, id, day, model) {
  writeFileSync(join(r.sessions, 'acct', 'org', `local_${id}.json`), JSON.stringify({
    scheduledTaskId: 'nightly-scan', sessionId: `local_${id}`, cwd: r.cwd, model, effort: 'medium', createdAt: Date.parse(`${day}T09:00:00Z`),
  }));
}
function routineRun(fx, fires, day = LAST) {
  seedQuiet(fx.stateDir);
  const r = seedRoutinePins(fx);
  for (const [i, f] of fires.entries()) fire(r, `r${i}`, f.day, f.model);
  userConfig(fx.stateDir, { environment: { routines: { watch: ['nightly-scan'] } } });
  run(fx.stateDir, { sessionsRoot: r.sessions, claudeDirPath: r.cdir });
  return readResult(fx.stateDir, day);
}

test('A-3: routine.modelDrift alerts on a drifted fire when the day before had no judged fire', () => {
  const fx = makeFixture();
  try {
    const sc = scenarioOf(routineRun(fx, [{ day: LAST, model: OPUS }]), 'routine.modelDrift');
    assert.equal(sc.status, 'regression', `status ${sc.status}`);
    assert.equal(sc.comparisons[0].compare, 'level');
  } finally { fx.cleanup(); }
});

test('A-4: routine.modelDrift alerts on every drifted day, not only the first', () => {
  const fx = makeFixture();
  try {
    const sc = scenarioOf(routineRun(fx, [{ day: '2026-10-09', model: OPUS }, { day: LAST, model: OPUS }]), 'routine.modelDrift');
    assert.equal(sc.status, 'regression', `two drifted days in a row: ${sc.status}`);
  } finally { fx.cleanup(); }
});

test('A-3/A-4 controls: clean fires are ok, a day with no judged fire is a gap (no-data), never ok', () => {
  const fx = makeFixture();
  try {
    const res = routineRun(fx, [{ day: '2026-10-09', model: SONNET }, { day: LAST, model: SONNET }]);
    assert.equal(scenarioOf(res, 'routine.modelDrift').status, 'ok');
  } finally { fx.cleanup(); }
  const fx2 = makeFixture();
  try {
    const sc = scenarioOf(routineRun(fx2, [{ day: '2026-10-09', model: OPUS }]), 'routine.modelDrift'); // nothing on LAST
    assert.equal(sc.status, 'no-data');
    assert.match(sc.comparisons[0].why || '', /no value|gap|no scheduled fire|judged/i);
  } finally { fx2.cleanup(); }
});

test('A-4: routine.missedRuns alerts on every day with a missed run', () => {
  const fx = makeFixture();
  try {
    const res = routineRun(fx, []); // the watched routine never fires: missed on 10-09 and 10-10
    const sc = scenarioOf(res, 'routine.missedRuns');
    assert.equal(sc.status, 'regression');
    assert.equal(sc.comparisons[0].compare, 'level');
    assert.equal(sc.comparisons[0].current.value, 1);
    assert.equal(scenarioOf(readResult(fx.stateDir, '2026-10-09'), 'routine.missedRuns').status, 'regression');
  } finally { fx.cleanup(); }
  const fx2 = makeFixture();
  try {
    assert.equal(scenarioOf(routineRun(fx2, [{ day: LAST, model: SONNET }]), 'routine.missedRuns').status, 'ok');
  } finally { fx2.cleanup(); }
});

test('level comparison: a figure above 0 is the verdict whatever the days before were; 0 is ok; no figure is a gap', () => {
  const metric = { id: 'm', pool: 'ratio', label: 'M', direction: 'up-is-worse' };
  const prov = (stats) => ({ stat: (day) => stats[day] || { gap: true, why: 'no data' } });
  const stat = (n) => ({ num: n, den: 1, scale: 1, sample: 4 });
  const cmp = (stats) => compareOne({ spec: 'level', day: '2026-10-10', provider: prov(stats), metric, threshold: { direction: 'up-is-worse', minSample: 1 }, scenarioId: 't' });
  assert.equal(cmp({ '2026-10-10': stat(3), '2026-10-09': stat(3) }).status, 'regression', 'same as yesterday still alerts');
  assert.equal(cmp({ '2026-10-10': stat(3) }).status, 'regression', 'no baseline day needed');
  assert.equal(cmp({ '2026-10-10': stat(0), '2026-10-09': stat(5) }).status, 'ok');
  assert.equal(cmp({}).status, 'gap');
});

// ------------------------------------------------------------------ A-5 --

function historyLine(day, week) {
  return JSON.stringify({
    v: 1, day, limitUnits: 2677, targetPct: 4, units: { main: 1, subagent: 1, total: 2 }, pct: { total: 4 }, week,
    limit: { hits: 0, firstAt: null },
  });
}
function paceRun(fx, lines) {
  seedQuiet(fx.stateDir);
  mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
  writeFileSync(join(fx.stateDir, 'state', 'daily-checkup-history.jsonl'), `${lines.join('\n')}\n`);
  run(fx.stateDir);
  return scenarioOf(readResult(fx.stateDir, LAST), 'week.pace');
}

test('A-5: the first day of a plan week is not compared with the last day of the old one (reset-day)', () => {
  const fx = makeFixture();
  try {
    const sc = paceRun(fx, [
      historyLine('2026-10-09', { start: '2026-10-02T16:00:00.000Z', units: 2600, pctSoFar: 97, elapsedPct: 97, paceAtResetPct: 100, partial: false }),
      historyLine(LAST, { start: '2026-10-09T16:00:00.000Z', units: 200, pctSoFar: 7.5, elapsedPct: 5.4, paceAtResetPct: 140, partial: false }),
    ]);
    assert.notEqual(sc.status, 'regression');
    assert.equal(sc.status, 'no-data');
    assert.match(sc.comparisons[0].why || '', /elapsed|reset/);
  } finally { fx.cleanup(); }
});

test('A-5 control: inside one plan week a 40% jump in the projection still alerts', () => {
  const fx = makeFixture();
  try {
    const wk = { start: '2026-10-02T16:00:00.000Z', partial: false };
    const sc = paceRun(fx, [
      historyLine('2026-10-09', { ...wk, units: 1000, pctSoFar: 40, elapsedPct: 60, paceAtResetPct: 100 }),
      historyLine(LAST, { ...wk, units: 1500, pctSoFar: 70, elapsedPct: 75, paceAtResetPct: 140 }),
    ]);
    assert.equal(sc.status, 'regression');
  } finally { fx.cleanup(); }
});

test('A-5: week.pace is a gap below params.minElapsedPct, whatever the value', () => {
  const metric = getMetric('week.pace');
  const rec = (elapsedPct) => [{ kind: 'day', hist: { week: { paceAtResetPct: 120, pctSoFar: 5, elapsedPct, partial: false } } }];
  assert.equal(metric.stat(rec(24.9), { params: {} }).gap, true);
  assert.equal(metric.stat(rec(25), { params: {} }).num, 120);
  assert.equal(metric.stat(rec(10), { params: { minElapsedPct: 5 } }).num, 120);
});

// ------------------------------------------------------------------ B-1 --

const win32Only = process.platform === 'win32';
test('B-1: in warn mode the python note and the worker one-wait advisory both reach the worker (warn never denies)', { skip: !win32Only }, () => {
  const { dir, cleanup } = makeFixture();
  try {
    const data = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    const r = runHook('hooks/poll-guard.mjs', {
      session_id: 'fx-py-1', tool_name: 'Bash', tool_input: { command: 'until gh pr checks 31; do sleep 20; done; python3 -' }, agent_id: 'agent-fx',
    }, { env: { CLAUDE_PLUGIN_OPTION_PYTHON_STDIN_GUARD: 'warn', CLAUDE_PLUGIN_DATA: data } });
    const ctx = r.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /stdin/);
    assert.match(ctx, /One-wait rule/);
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, 'warn never denies');
  } finally { cleanup(); }
});

test('B-1 control: warn mode on a main-thread command carries the python note alone', { skip: !win32Only }, () => {
  const r = runHook('hooks/poll-guard.mjs', {
    session_id: 'fx-py-2', tool_name: 'Bash', tool_input: { command: 'python3 -' },
  }, { env: { CLAUDE_PLUGIN_OPTION_PYTHON_STDIN_GUARD: 'warn' } });
  const ctx = r.json?.hookSpecificOutput?.additionalContext || '';
  assert.match(ctx, /stdin/);
  assert.doesNotMatch(ctx, /One-wait rule/);
});
