// Batch 5a of the daily usage analysis (0.31.18): the runner core. Idempotent results (inputsDigest,
// revisions), deferral of days that are not settled, the --max-seconds resume, the shared lock, the
// hooks wired from facts, and the safety rules (no model call, every spawn hidden, writes below --root).
// Synthetic facts and transcripts in a temp root; nothing reads the operator's data.
import { makeFixture, runScript } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, unlinkSync, appendFileSync, utimesSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { addDays, dayRange } from '../scripts/lib/usage/days.mjs';
import {
  runAnalysis, writeStatus, readStatus, readLatest, readResult, rerenderReport, makeHooks, readRoutineFolders,
  stableStringify, regressionSetKey, usagePaths, resultPath, reportPathFor, weekResetInDay, RUNNER_VERSION,
} from '../scripts/lib/usage/runner.mjs';
import { renderReport, summaryLines } from '../scripts/lib/usage/report.mjs';
import { takeLock, dropLock, factsDir } from '../scripts/lib/daily-checkup.mjs';
import { main as usageMain } from '../scripts/usage-analysis.mjs';

// ---------------------------------------------------------------- fixtures --

const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const SONNET = 'claude-sonnet-5-5';
const NOW = Date.parse('2026-10-11T12:00:00Z'); // 2026-10-10 (08:00Z to 08:00Z) is the last closed, settled day
const FIRST = '2026-10-01';
const LAST = '2026-10-10';
const tok = (u) => [u, 0, 0, 0, 0, 1]; // u plan units of plain input: units === u under SPEC
const zero = () => [0, 0, 0, 0, 0, 0];

function row(hourIso, sid, units, { proj = 'alpha', cwd = null, prompts = 1, ag = 0 } = {}) {
  return {
    hour: hourIso, sid, proj, cwd,
    tok: { [SONNET]: { m: tok(units), s: zero() } },
    pr: { n: prompts, len: [prompts, 0, 0, 0], corr: 0 }, ag, sm: 0, gc: 0,
  };
}

function spawnRec(day, sid, id, { rung = 'sonnet/high', model = SONNET, units = 50 } = {}) {
  return {
    id, sid, aid: `a-${id}`, proj: 'alpha', type: 'bounded-feature', role: 'writer', rung, fit: 'ok', model, mixed: false,
    start: `${day}T10:00:00.000Z`, end: `${day}T10:20:00.000Z`, partial: false,
    req: { n: 8, bucket: '6-15', cat: {} }, ctx: { buckets: [tok(units), zero(), zero(), zero()], peak: 90000 },
    startup: zero(), comp: { n: 0, after: null }, extraTurns: 0, status: 'done', simple: { runs: 0, req: 0, tok: zero() }, rk: { d: null, n: null, h: null },
  };
}

function writeFacts(root, day, rows, { scanFrom = `${day}T08:00:00.000Z`, spawns = [] } = {}) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${addDays(day, 1)}T08:00:00.000Z`, dataThrough: `${addDays(day, 1)}T07:59:00.000Z`,
    scanFrom, computedAt: `${addDays(day, 1)}T09:00:00.000Z`, weightsUsed: { [SONNET]: { ...SPEC } }, rows, spawns,
  }));
}

// three sessions a day, average `avg` units; the average drifts with the day number
const avgOf = (day) => 10 + Number(day.slice(8, 10));
function seedDays(root, from = FIRST, to = LAST, { skip = [], partial = [], extra = () => [] } = {}) {
  for (const day of dayRange(from, to)) {
    if (skip.includes(day)) continue;
    const rows = Array.from({ length: 3 }, (_, i) => row(`${day}T10:00:00.000Z`, `sess-${day}-${i}`, avgOf(day)));
    writeFacts(root, day, [...rows, ...extra(day)], partial.includes(day) ? { scanFrom: `${day}T12:00:00.000Z` } : {});
  }
}

const dayUnits = {
  id: 'day.units', pool: 'sum', direction: 'up-is-worse', label: 'M', recordKinds: ['session'],
  stat: (recs) => ({ num: recs.reduce((s, r) => s + r.units.total, 0), den: 1, scale: 1, sample: recs.length }),
};
const spawnUnits = {
  id: 'test.spawnUnits', pool: 'ratio', direction: 'up-is-worse', label: 'M', recordKinds: ['spawn'],
  stat: (recs) => ({ num: recs.reduce((s, r) => s + ((r.units && r.units.total) || 0), 0), den: recs.length, scale: 1, sample: recs.length }),
};
const METRICS = (id) => ({ 'day.units': dayUnits, 'test.spawnUnits': spawnUnits })[id] || null;

const run = (root, extra = {}) => runAnalysis({ root, nowT: NOW, metrics: METRICS, cwds: [], ...extra });

function userConfig(root, scenarios) {
  const file = join(root, 'config', 'usage-analysis.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 'agent-companion/usage-analysis', schemaVersion: 1, scenarios }));
}
const UNITS_SCENARIO = (relPct = 25) => ({
  id: 'u.units', title: 'Units per day', metric: 'day.units', compare: ['prior-day'],
  threshold: { direction: 'up-is-worse', relPct, minSample: 1 }, severity: 'alert',
});

// every file below dir: relative path -> bytes (as latin1, so equal strings mean equal bytes)
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
const without = (snap, ...prefixes) => Object.fromEntries(Object.entries(snap).filter(([k]) => !prefixes.some((p) => k.startsWith(p))));
const outputs = (root) => without(snapshot(root), 'state/usage-facts/', 'config/', 'state/usage-config-digests');

// ------------------------------------------------------------------ tests --

test('a first run computes every settled day and writes results, reports, the latest summary and the status', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    userConfig(root, [UNITS_SCENARIO()]);
    const out = run(root);
    assert.equal(out.error, undefined);
    assert.deepEqual(out.computed, dayRange(FIRST, LAST));
    assert.deepEqual(out.deferred, []);
    assert.equal(out.partial, false);
    const p = usagePaths(root);
    for (const day of dayRange(FIRST, LAST)) {
      assert.ok(existsSync(resultPath(root, day)), `result ${day}`);
      assert.ok(existsSync(reportPathFor(root, day)), `report ${day}`);
    }
    const res = readResult(root, LAST);
    assert.equal(res.revision, 1);
    assert.deepEqual(res.revisions, [{ revision: 1, reason: 'first computation' }]);
    assert.equal(res.runnerVersion, RUNNER_VERSION);
    assert.equal(res.totals.units, 3 * avgOf(LAST));
    assert.equal(res.totals.sessions, 3);
    assert.equal(res.totals.pctOfWeeklyLimit, Math.round((3 * avgOf(LAST) / 2677) * 1e6) / 1e4);
    const sc = res.scenarios.find((s) => s.id === 'u.units');
    assert.equal(sc.comparisons[0].current.value, 3 * avgOf(LAST));
    // an unimplemented metric is a gap that names itself, never a zero
    const gap = res.scenarios.find((s) => s.id === 'day.byClass');
    assert.equal(gap.skipped, 'gap');
    assert.match(gap.why, /not implemented/);
    assert.ok(res.gaps.some((g) => g.id === 'day.byClass'));

    const latest = readLatest(root);
    assert.equal(latest.day, LAST);
    assert.equal(latest.lines.length, 3);
    assert.match(latest.lines[0], /^\[agent-companion\] usage 10-10: /);
    assert.match(latest.lines[2], /^report: .*usage-2026-10-10\.md$/);
    assert.ok(existsSync(p.latest));

    writeStatus(root, { out, run: { scheduled: true, durationMs: 5, bytesRead: 0 }, nowT: NOW });
    const st = readStatus(root);
    assert.equal(st.lastRun.scheduled, true);
    assert.equal(st.lastRun.computed.length, 10);
    assert.equal(st.days[LAST].state, 'computed');
    assert.deepEqual(st.deferred, []);
  } finally { fx.cleanup(); }
});

test('re-runs are byte-identical: an unchanged run writes nothing and --force recomputes the same bytes', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    userConfig(root, [UNITS_SCENARIO()]);
    run(root);
    const first = outputs(root);
    assert.equal(Object.keys(first).length, 21, '10 results, 10 reports and the latest file');

    const again = run(root);
    assert.deepEqual(again.computed, []);
    assert.equal(again.skipped.length, 8, 'the 8 days inside the revision window are checked');
    assert.deepEqual(outputs(root), first, 'an unchanged run changes no byte');

    const forced = run(root, { force: true });
    assert.equal(forced.computed.length, 8);
    assert.deepEqual(outputs(root), first, 'a forced recompute is byte-identical');

    // a deleted report is restored from the stored result
    unlinkSync(reportPathFor(root, LAST));
    run(root);
    assert.deepEqual(outputs(root), first);

    // the status file carries the clock and the run cost; the results and reports carry neither
    assert.ok(!/computedAt|durationMs|bytesRead/.test(Object.values(first).join('\n')));
  } finally { fx.cleanup(); }
});

test('a config change gives revision + 1 with its reason, only inside the revision window', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    run(root);
    assert.equal(readResult(root, LAST).revision, 1);

    userConfig(root, [UNITS_SCENARIO()]);
    const r2 = run(root);
    assert.deepEqual(r2.computed, dayRange('2026-10-03', LAST), 'the last 8 closed days are revised');
    const d = readResult(root, LAST);
    assert.equal(d.revision, 2);
    assert.deepEqual(d.revisions, [{ revision: 1, reason: 'first computation' }, { revision: 2, reason: 'config: scenario u.units added' }]);
    assert.equal(readResult(root, FIRST).revision, 1, 'older days keep their result until asked for');
    assert.match(readFileSync(reportPathFor(root, LAST), 'utf8'), /- revision 2: config: scenario u\.units added/);

    userConfig(root, [UNITS_SCENARIO(40)]);
    run(root);
    const d3 = readResult(root, LAST);
    assert.equal(d3.revision, 3);
    assert.equal(d3.revisions[2].reason, 'config: scenario u.units changed');

    // an explicit range recomputes an older day under the new config
    const old = run(root, { from: FIRST, to: FIRST });
    assert.deepEqual(old.computed, [FIRST]);
    assert.equal(readResult(root, FIRST).revision, 2);

    // unchanged config: nothing more
    assert.deepEqual(run(root).computed, []);

    // the journal got one baseline row for the added scenario and none for the threshold change
    const journal = readFileSync(join(root, 'state', 'usage-config-digests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(journal.filter((r) => r.scenario === 'u.units').length, 1);
  } finally { fx.cleanup(); }
});

test('a changed facts file revises the days that read it, with the reason', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    userConfig(root, [UNITS_SCENARIO()]);
    run(root);
    // 10-08 gets a heavier session: its own result and the prior-day comparison of 10-09 change
    writeFacts(root, '2026-10-08', [row('2026-10-08T10:00:00.000Z', 'sess-extra', 500)]);
    const r = run(root);
    assert.ok(r.computed.includes('2026-10-08') && r.computed.includes('2026-10-09'));
    assert.equal(readResult(root, '2026-10-08').revisions[1].reason, 'facts for 2026-10-08 changed');
    assert.equal(readResult(root, '2026-10-09').revisions[1].reason, 'facts for 2026-10-08 changed');
    assert.equal(readResult(root, '2026-10-03').revision, 1, 'a day that never read 10-08 is untouched');
  } finally { fx.cleanup(); }
});

test('a day that is not settled is deferred, never zero-filled, and computed once its data is whole', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const early = Date.parse('2026-10-11T08:03:00Z'); // 3 minutes after 2026-10-10 closed
    seedDays(root, FIRST, LAST, { skip: ['2026-10-07', '2026-10-08'], partial: ['2026-10-05'] });
    mkdirSync(join(root, 'state', 'usage-facts'), { recursive: true });
    writeFileSync(join(root, 'state', 'usage-facts', 'open.json'), JSON.stringify({
      schema: 'agent-companion/usage-facts-open', asOf: '2026-10-11T08:00:00.000Z', spawns: [{ id: 'toolu_open', sid: 'sess-open', startDay: '2026-10-08' }],
    }));
    userConfig(root, [UNITS_SCENARIO()]);

    const out = run(root, { nowT: early });
    assert.deepEqual(out.computed, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-09']);
    const kinds = Object.fromEntries(out.deferred.map((x) => [x.day, x.kind]));
    assert.deepEqual(kinds, { '2026-10-05': 'partial', '2026-10-07': 'no-facts', '2026-10-08': 'open-spawns', '2026-10-10': 'settling' });
    for (const x of out.deferred) {
      assert.ok(!existsSync(resultPath(root, x.day)), `no result file for deferred ${x.day}`);
      assert.ok(!existsSync(reportPathFor(root, x.day)), `no report for deferred ${x.day}`);
    }
    // the partial day is a gap as a baseline, not a low number
    const sc = readResult(root, '2026-10-06').scenarios.find((s) => s.id === 'u.units');
    assert.equal(sc.comparisons[0].baseline.value, null);
    assert.equal(sc.comparisons[0].baseline.num, 0);
    assert.deepEqual(sc.comparisons[0].baseline.days, []);
    assert.match(JSON.stringify(sc.comparisons[0]), /partial data/);

    writeStatus(root, { out, run: { scheduled: true }, nowT: early });
    const st = readStatus(root);
    assert.deepEqual(st.deferred.map((x) => `${x.day}:${x.kind}`), ['2026-10-05:partial', '2026-10-07:no-facts', '2026-10-08:open-spawns', '2026-10-10:settling']);
    assert.equal(st.days['2026-10-05'].state, 'deferred');
    assert.equal(st.days['2026-10-09'].state, 'computed');

    // later: the scan has rewritten nothing for 10-05 (a day file is written once) but the other days land
    unlinkSync(join(root, 'state', 'usage-facts', 'open.json'));
    seedDays(root, '2026-10-07', '2026-10-08');
    const late = run(root, { nowT: NOW });
    assert.deepEqual(late.computed.filter((d) => ['2026-10-07', '2026-10-08', '2026-10-10'].includes(d)), ['2026-10-07', '2026-10-08', '2026-10-10']);
    assert.deepEqual(late.deferred.map((x) => x.day), ['2026-10-05'], 'a partial day stays deferred');
    writeStatus(root, { out: late, run: { scheduled: true }, nowT: NOW });
    const st2 = readStatus(root);
    assert.deepEqual(st2.deferred.map((x) => x.day), ['2026-10-05']);
    assert.equal(st2.days['2026-10-07'].state, 'computed');
    assert.equal(st2.days['2026-10-10'].state, 'computed');
    // 10-06 read 10-05 and 10-04..: its inputs did not change, so it was not revised
    assert.equal(readResult(root, '2026-10-06').revision, 1);
  } finally { fx.cleanup(); }
});

test('--max-seconds resumes where it stopped and lands on the same bytes as one full run', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    userConfig(root, [UNITS_SCENARIO()]);
    const seen = [];
    let guard = 0;
    for (;;) {
      guard += 1;
      assert.ok(guard <= 12, 'the resume loop ends');
      const out = run(root, { maxSeconds: 0 });
      if (!out.computed.length) break;
      assert.equal(out.computed.length, 1, 'a zero budget still makes progress: one day per run');
      seen.push(out.computed[0]);
      if (out.remaining > 0) {
        assert.equal(out.partial, true);
        assert.ok(out.deferred.every((x) => x.kind === 'time-budget'));
        assert.equal(out.deferred.length, out.remaining);
      }
    }
    assert.deepEqual(seen, dayRange(FIRST, LAST), 'oldest first, each day once');
    const resumed = outputs(root);
    run(root, { force: true });
    assert.deepEqual(outputs(root), resumed, 'resumed runs equal one full recompute');
    // a generous budget does everything in one run
    for (const day of dayRange(FIRST, LAST)) { unlinkSync(resultPath(root, day)); }
    const all = run(root, { maxSeconds: 600 });
    assert.equal(all.computed.length, 10);
    assert.equal(all.partial, false);
  } finally { fx.cleanup(); }
});

test('maxDays limits one run and the next run resumes', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, FIRST, '2026-10-05');
    const a = run(root, { maxDays: 2, nowT: Date.parse('2026-10-06T12:00:00Z') });
    assert.deepEqual(a.computed, ['2026-10-01', '2026-10-02']);
    assert.deepEqual(a.deferred.map((x) => x.kind), ['run-limit', 'run-limit', 'run-limit']);
    const b = run(root, { maxDays: 5, nowT: Date.parse('2026-10-06T12:00:00Z') });
    assert.deepEqual(b.computed, ['2026-10-03', '2026-10-04', '2026-10-05']);
  } finally { fx.cleanup(); }
});

test('the shared lock blocks a second run cleanly (exit 0, nothing written)', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    const args = ['--scheduled', '--root', root, '--no-scan', '--now', new Date(NOW).toISOString()];
    assert.ok(takeLock(), 'this process holds the checkup lock');
    // a hand-typed run skips at once, exit 0 (unchanged behaviour)
    const hand = runScript('scripts/usage-analysis.mjs', ['--root', root, '--no-scan', '--json', '--now', new Date(NOW).toISOString()]);
    assert.equal(hand.status, 0);
    assert.equal(hand.json.skipped, 'another run holds the lock');
    // a scheduled run waits for the holder; with no wait budget it gives up with the distinct exit 3
    const blocked = runScript('scripts/usage-analysis.mjs', [...args, '--lock-wait-seconds', '0']);
    assert.equal(blocked.status, 3);
    assert.equal(blocked.json.skipped, 'lock still held after the wait');
    assert.equal(blocked.json.lockTimeout, true);
    assert.ok(!existsSync(usagePaths(root).status), 'a blocked run writes no status');
    assert.ok(!existsSync(usagePaths(root).resultsDir), 'a blocked run writes no result');
    dropLock();
    const ok = runScript('scripts/usage-analysis.mjs', args);
    assert.equal(ok.status, 0);
    assert.equal(ok.json.computed.length, 10);
    assert.ok(!existsSync(join(root, 'state', 'daily-checkup.lock')), 'the lock is released');
    const st = readStatus(root);
    assert.equal(st.lastRun.scheduled, true);
    assert.equal(st.lastRun.scanned, false);
  } finally { dropLock(); fx.cleanup(); }
});

const schedArgs = (root, ...more) => ['--scheduled', '--root', root, '--no-scan', '--no-register', '--now', new Date(NOW).toISOString(), ...more];
const lockFile = (root) => join(root, 'state', 'daily-checkup.lock');

test('--scheduled waits for a lock released mid-wait, then runs and records itself', async () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    const first = runScript('scripts/usage-analysis.mjs', schedArgs(root));
    assert.equal(first.json.computed.length, 10);
    assert.ok(takeLock(), 'a detached checkup run holds the lock');
    setTimeout(() => dropLock(), 600);
    const lines = [];
    const t0 = Date.now();
    const code = await usageMain(schedArgs(root, '--lock-wait-seconds', '20', '--lock-poll-ms', '100'), { out: (s) => lines.push(s) });
    const took = Date.now() - t0;
    assert.equal(code, 0);
    assert.ok(took >= 500 && took < 15000, `waited for the holder, not for the bound (${took} ms)`);
    const j = JSON.parse(lines.join(''));
    assert.equal(j.skipped, undefined);
    assert.deepEqual(j.computed, []);
    assert.ok(j.unchanged.length > 0 && j.unchanged.includes('2026-10-10'), 'the day the holder computed is found unchanged');
    assert.deepEqual(j.deferred, []);
    const st = readStatus(root);
    assert.equal(st.lastRun.scheduled, true, 'the scheduled run left its record');
    assert.ok(!existsSync(lockFile(root)), 'the lock is released');
  } finally { dropLock(); fx.cleanup(); }
});

test('--scheduled gives up with exit 3 when the lock is still held past the wait bound', async () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    assert.ok(takeLock());
    const lines = [];
    const t0 = Date.now();
    const code = await usageMain(schedArgs(root, '--lock-wait-seconds', '1', '--lock-poll-ms', '100'), { out: (s) => lines.push(s) });
    assert.ok(Date.now() - t0 >= 900, 'it waited the bound');
    assert.equal(code, 3);
    const j = JSON.parse(lines.join(''));
    assert.equal(j.skipped, 'lock still held after the wait');
    assert.equal(j.lockTimeout, true);
    assert.deepEqual(j.computed, []);
    assert.ok(existsSync(lockFile(root)), "the holder's lock is left alone");
    assert.ok(!existsSync(usagePaths(root).status), 'a timed-out run writes no status');
  } finally { dropLock(); fx.cleanup(); }
});

test('--scheduled takes a stale lock at once without waiting', async () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root);
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(lockFile(root), '99999');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(lockFile(root), old, old);
    const lines = [];
    const t0 = Date.now();
    const code = await usageMain(schedArgs(root, '--lock-wait-seconds', '20'), { out: (s) => lines.push(s) });
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 10000, 'no wait for a stale lock');
    assert.equal(JSON.parse(lines.join('')).computed.length, 10);
    assert.ok(!existsSync(lockFile(root)));
  } finally { dropLock(); fx.cleanup(); }
});

test('hooks: spawn records map to cohort fields and session classes come from what the checkup knows', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'routine-pins.json'), JSON.stringify({ folders: { nightly: '/work/routine-a', bad: '{{unset}}' } }));
    const folders = readRoutineFolders(root);
    assert.equal(folders.length, 1);
    const day = '2026-10-09';
    const store = { read: () => ({ facts: { weightsUsed: { [SONNET]: SPEC }, spawns: [spawnRec(day, 'sess-a', 'toolu_1'), spawnRec(day, 'sess-a', 'toolu_2', { rung: 'haiku' })] } }) };
    const hooks = makeHooks({ store, routineFolders: folders });

    const recs = hooks.spawnRecords(day, null);
    assert.equal(recs.length, 2);
    assert.deepEqual(
      { sid: recs[0].sid, rung: recs[0].rung, declaredType: recs[0].declaredType, role: recs[0].role, effort: recs[0].effort, fit: recs[0].fit, model: recs[0].model, requests: recs[0].requests, status: recs[0].status },
      { sid: 'sess-a', rung: 'sonnet/high', declaredType: 'bounded-feature', role: 'writer', effort: 'high', fit: 'ok', model: SONNET, requests: 8, status: 'done' },
    );
    assert.equal(recs[0].units.total, 50);
    assert.equal(recs[1].effort, undefined, 'an effort the rung does not name is unobservable, not a guess');
    const t = Date.parse(`${day}T10:00:00.000Z`);
    assert.equal(hooks.spawnRecords(day, { fromMs: t + 1, toMs: t + 99 }).length, 0, 'a range excludes spawns that started outside it');

    const cls = (r) => hooks.sessionAttrs({ hours: 1, ag: 0, pr: { n: 0 }, cwd: null, ...r }).class;
    assert.equal(cls({ cwd: '/work/routine-a/sub' }), 'routine');
    assert.equal(cls({ hours: 2, ag: 50 }), 'storm');
    assert.equal(cls({ pr: { n: 3 } }), 'lead');
    assert.equal(cls({}), 'other');
    assert.equal(hooks.sessionAttrs({ hours: 1, ag: 0, pr: { n: 0 } }).title, undefined, 'fields facts cannot give stay unobservable');
  } finally { fx.cleanup(); }
});

test('the hooks feed a spawn cohort and a class cohort end to end', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'routine-pins.json'), JSON.stringify({ folders: { nightly: '/work/routine-a' } }));
    for (const day of dayRange(FIRST, '2026-10-05')) {
      writeFacts(root, day, [
        row(`${day}T10:00:00.000Z`, `sess-${day}-lead`, 20, { prompts: 2 }),
        row(`${day}T11:00:00.000Z`, `sess-${day}-routine`, 7, { cwd: '/work/routine-a', prompts: 0 }),
      ], { spawns: [spawnRec(day, `sess-${day}-lead`, `toolu_${day}-a`, { units: 40 }), spawnRec(day, `sess-${day}-lead`, `toolu_${day}-b`, { rung: 'haiku', units: 90 })] });
    }
    userConfig(root, [
      { id: 'u.spawn', title: 'High-rung spawns', metric: 'test.spawnUnits', cohort: { rung: ['sonnet/high'] }, compare: ['prior-day'], threshold: { direction: 'up-is-worse', relPct: 25, minSample: 1 }, severity: 'info' },
      { id: 'u.routine', title: 'Routine units', metric: 'day.units', cohort: { class: ['routine'] }, compare: ['prior-day'], threshold: { direction: 'up-is-worse', relPct: 25, minSample: 1 }, severity: 'info' },
    ]);
    const out = run(root, { nowT: Date.parse('2026-10-06T12:00:00Z') });
    assert.equal(out.computed.length, 5);
    const res = readResult(root, '2026-10-05');
    const spawn = res.scenarios.find((s) => s.id === 'u.spawn');
    assert.ok(spawn.comparisons, JSON.stringify(res.scenarios.filter((s) => s.id.startsWith('u.'))));
    assert.equal(spawn.comparisons[0].current.value, 40, 'only the sonnet/high spawn');
    assert.equal(res.totals.spawns, 2);
    const routine = res.scenarios.find((s) => s.id === 'u.routine');
    assert.equal(routine.comparisons[0].current.value, 7, 'only the routine session');
  } finally { fx.cleanup(); }
});

test('--dry-run and --scenario compute without writing anything', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, FIRST, '2026-10-04');
    userConfig(root, [UNITS_SCENARIO()]);
    const before = snapshot(root);
    const dry = run(root, { dryRun: true, nowT: Date.parse('2026-10-05T12:00:00Z') });
    assert.equal(dry.computed.length, 4);
    assert.ok(dry.results['2026-10-04'].scenarios.length > 0);
    const only = run(root, { scenarios: ['u.units'], nowT: Date.parse('2026-10-05T12:00:00Z') });
    assert.equal(only.persisted, false);
    assert.deepEqual(only.results['2026-10-04'].scenarios.map((s) => s.id), ['u.units']);
    assert.deepEqual(snapshot(root), before, 'no file changed or appeared');
  } finally { fx.cleanup(); }
});

test('the report and summary are pure: same results, same text; the regression key follows the set of ids', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, FIRST, '2026-10-09', { extra: (day) => (day === '2026-10-09' ? [row(`${day}T10:30:00.000Z`, 'sess-spike', 200)] : []) });
    userConfig(root, [UNITS_SCENARIO()]);
    const out = run(root, { nowT: Date.parse('2026-10-10T12:00:00Z') });
    const res = readResult(root, '2026-10-09');
    assert.equal(renderReport(res), renderReport(JSON.parse(JSON.stringify(res))));
    const sc = res.scenarios.find((s) => s.id === 'u.units');
    assert.equal(sc.status, 'regression', JSON.stringify(sc.comparisons));
    assert.deepEqual(res.summary.regressionIds, ['u.units']);
    assert.match(summaryLines(res)[1], /^regressions: u\.units /);
    const latest = readLatest(root);
    assert.equal(latest.surfaceKey, regressionSetKey(['u.units']));
    assert.equal(regressionSetKey(['b', 'a', 'a']), regressionSetKey(['a', 'b']));
    assert.notEqual(regressionSetKey(['a']), regressionSetKey(['a', 'b']));
    assert.equal(rerenderReport(root, '2026-10-09').written, false, 'a re-render of an unchanged result writes nothing');
    assert.ok(out.computed.length === 9);
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }, 0), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  } finally { fx.cleanup(); }
});

test('weekly scenarios are due on the day that holds the plan-week reset', () => {
  assert.equal(weekResetInDay('2026-10-09', 8, 'Fri 16:00'), true, '2026-10-09 is a Friday: 16:00Z is inside the 08:00Z-08:00Z day');
  assert.equal(weekResetInDay('2026-10-08', 8, 'Fri 16:00'), false);
  assert.equal(weekResetInDay('2026-10-08', 8, 'Fri 06:00'), true, 'a reset before 08:00Z falls in the day that started the day before');
  assert.equal(weekResetInDay('2026-10-09', 8, 'Fri 06:00'), false);
  assert.equal(weekResetInDay('2026-10-09', 8, 'nonsense'), false);
});

test('the CLI scans, analyses and registers on fixture transcripts; no claude call; writes only below --root', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const tdir = join(fx.dir, 'transcripts');
    const day = '2026-10-09';
    const asst = (id, ts, u) => JSON.stringify({
      type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, cwd: '/work/proj-a',
      message: { id: `msg_${id}`, model: SONNET, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: u, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const prompt = (uuid, ts, text) => JSON.stringify({ type: 'user', timestamp: ts, uuid, cwd: '/work/proj-a', message: { role: 'user', content: text } });
    mkdirSync(join(tdir, 'proj-a'), { recursive: true });
    writeFileSync(join(tdir, 'proj-a', 'sess-1.jsonl'), `${[
      prompt('p1', `${day}T10:00:00Z`, 'Please add the thing to the parser and run the tests'),
      asst('m1', `${day}T10:00:05Z`, 4000),
      asst('m2', `${day}T10:30:00Z`, 6000),
    ].join('\n')}\n`);

    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    const transcriptsBefore = snapshot(tdir);
    const sep = process.platform === 'win32' ? ';' : ':';
    const res = runScript('scripts/usage-analysis.mjs', ['--scheduled', '--root', root, '--transcripts', tdir, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0'], {
      env: { PATH: `${bin}${sep}${process.env.PATH}` },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.json.computed, [day]);
    assert.ok(existsSync(join(factsDir(), `${day}.json`)), 'the scan wrote the facts file');
    assert.ok(existsSync(resultPath(root, day)));
    assert.ok(existsSync(reportPathFor(root, day)));
    assert.ok(!existsSync(log), 'the fake claude was never called');
    assert.deepEqual(snapshot(tdir), transcriptsBefore, 'the transcript root is read-only');
    const stray = Object.keys(snapshot(fx.dir)).filter((p) => !p.startsWith('transcripts/') && !p.startsWith('fakebin/') && !p.startsWith('.claude/agent-companion/'));
    assert.deepEqual(stray, [], 'every new file is under --root');
    const st = readStatus(root);
    assert.equal(st.lastRun.scanned, true);
    assert.equal(st.lastRun.llm.enabled, false);
    assert.ok(st.lastRun.bytesRead > 0);
    assert.equal(readResult(root, day).totals.units > 0, true);

    // a second run changes nothing in the outputs
    const before = outputs(root);
    const again = runScript('scripts/usage-analysis.mjs', ['--scheduled', '--root', root, '--transcripts', tdir, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0']);
    assert.equal(again.status, 0);
    assert.deepEqual(again.json.computed, []);
    assert.deepEqual(without(outputs(root), 'state/usage-analysis-status.json', 'state/daily-checkup'), without(before, 'state/usage-analysis-status.json', 'state/daily-checkup'));

    // status and report subcommands
    const status = runScript('scripts/usage-analysis.mjs', ['status', '--root', root, '--json']);
    assert.equal(status.status, 0);
    assert.equal(status.json.latest.day, day);
    const rep = runScript('scripts/usage-analysis.mjs', ['report', '--root', root, '--day', day, '--dry-run']);
    assert.equal(rep.status, 0);
    assert.match(rep.stdout, /^# Usage 2026-10-09 \(revision 1\)/);
    assert.equal(runScript('scripts/usage-analysis.mjs', ['--bogus']).status, 2);
    assert.equal(runScript('scripts/usage-analysis.mjs', ['--day', 'tomorrow']).status, 2);
  } finally { fx.cleanup(); }
});

test('the runner waits only for a held lock and every child process it could start hides its window', () => {
  for (const rel of ['scripts/lib/usage/runner.mjs', 'scripts/lib/usage/report.mjs', 'scripts/usage-analysis.mjs']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?<![.\w])(?:spawn|spawnSync|exec|execFile|execFileSync|fork|spawnFn)\(/g)) {
      assert.match(src.slice(m.index, m.index + 400), /windowsHide:\s*true/, `${rel}: a child process without windowsHide at ${m.index}`);
    }
    assert.ok(!/child_process/.test(src), `${rel} starts no process of its own`);
    // The one sanctioned wait: the --scheduled lock wait in usage-analysis.mjs, a single bounded setTimeout (never a spin).
    const waits = (src.match(/setTimeout|setInterval|Atomics\.wait|sleep\(/g) || []).length;
    assert.equal(waits, rel === 'scripts/usage-analysis.mjs' ? 1 : 0, `${rel} waits only in the scheduled lock wait`);
    assert.ok(!/['"`]claude['"`]|claude -p|api\.anthropic/.test(src), `${rel} makes no model call`);
  }
});

test('the config digest journal is appended only by a persisted run', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    seedDays(root, FIRST, '2026-10-03');
    userConfig(root, [UNITS_SCENARIO()]);
    run(root, { dryRun: true, nowT: Date.parse('2026-10-04T12:00:00Z') });
    assert.ok(!existsSync(join(root, 'state', 'usage-config-digests.jsonl')));
    run(root, { nowT: Date.parse('2026-10-04T12:00:00Z') });
    assert.ok(existsSync(join(root, 'state', 'usage-config-digests.jsonl')));
    appendFileSync(join(root, 'state', 'usage-config-digests.jsonl'), '');
  } finally { fx.cleanup(); }
});
