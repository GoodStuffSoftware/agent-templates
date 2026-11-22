// Live capacity of the resource queue (leg 4a): grants follow the machine's real CPU and RAM. Covers the pure helpers
// (scripts/lib/live-capacity.mjs, the cpu-time columns of scripts/lib/reaper.mjs) and their wiring into the ledger
// (scripts/ci-budget.mjs): admission by free CPU and RAM, a holder's charge following its measure after warm-up (floor,
// declared cap), the physical-cores cap, the ramp limit (a warming lease is charged what it is expected to use), the
// option off giving today's behaviour, and the status fields and reasons. Fake clock, fake process table; nothing real
// is sampled or stopped. Spec: docs/resource-queue.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourceStatus, formatResourceStatus } from '../scripts/ci-budget.mjs';
import {
  LIVE_DEFAULTS, normalizeLive, percentile, usageKeys, measureOf, sampleUse, makeUseTracker, expectedFor, effectiveBox,
  appendUsage, usageFile, useFile, readUse, PROG_DEFAULTS, procIo, sampleProgress, makeProgressTracker, stuckOf,
} from '../scripts/lib/live-capacity.mjs';
import { parsePsTime, parsePsOutput, parseWinJson } from '../scripts/lib/reaper.mjs';
import { makeWorld, baseRules, settle, GB } from './resource-queue-world.mjs';

const WRAPPER = 9100;
const CHILD = 9101;
const proc = (pid, ppid, name, ct, extra = {}) => ({ pid, ppid, name, exe: `C:\\fake\\${name}`, cmd: name, creationTime: ct, memMb: 100, ...extra });

/** A fake process table: the wrapper and one worker whose cpu time (ms) and memory the test moves. */
function fakeProcs() {
  const rt = { cpuMs: 0, memMb: 300 };
  rt.reapSeams = {
    table: () => [proc(WRAPPER, 1, 'node.exe', 1000), proc(CHILD, WRAPPER, 'worker.exe', 2000, { memMb: rt.memMb, cpuMs: rt.cpuMs })],
    kill: () => ({ ok: true }),
  };
  return rt;
}

/** Advance the fake clock one tick (25 s) with the worker burning `cores` cores, then take the wrapper's tick. */
function pump(w, rt, lease, cores, ticks = 1) {
  for (let i = 0; i < ticks; i += 1) { w.t += 25_000; rt.cpuMs += Math.round(cores * 25_000); lease.track(); }
}

/** Baseline reading plus `ticks` readings: a lease whose measure is warm after 3 of them. */
function warm(w, rt, lease, cores, ticks = 4) {
  lease.track(); // baseline: no interval yet
  pump(w, rt, lease, cores, ticks);
}

const world = (over = {}) => makeWorld({ live: true, rules: { ...baseRules(), rules: [] }, ...over });
const boxHolder = (w, label) => resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'box').holders.find((h) => h.label === label);
const reasonOf = (w, label) => resourceStatus({ ...w.opts, sample: true }).queue.find((q) => q.label === label)?.blockedReason ?? '';

/** Seed a job's history: `runs` rows under the key the ledger derives for (cls, label). */
function seedHistory(w, lease, { cpuP90, ramMaxMb, runs = 3 }) {
  const rec = w.leases().find((l) => l.id === lease.id);
  for (let i = 0; i < runs; i += 1) appendUsage(w.dir, { ts: 1000 + i, key: rec.ukey, key2: rec.key2, cls: rec.cls, cpuP90, ramMaxMb, n: 5, durMs: 90_000 });
}

// ---------------------------------------------------------------- pure helpers

test('normalizeLive: only an explicit off, false, 0 or no turns it off', () => {
  for (const v of ['off', 'OFF', 'false', '0', 'no', ' off ']) assert.equal(normalizeLive(v), false, v);
  for (const v of ['on', 'true', '1', '', undefined, 'yes', 'anything']) assert.equal(normalizeLive(v), true, String(v));
});

test('percentile is nearest-rank and ignores non-numbers', () => {
  assert.equal(percentile([], 0.9), 0);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([3, 1, 2, NaN, Infinity], 0.5), 2);
});

test('usageKeys folds digits and long ids, and gives a class key without the label', () => {
  const a = usageKeys('tests', 'orchard', 'unit tests 12 of 40');
  const b = usageKeys('tests', 'orchard', 'unit tests 7 of 9');
  assert.equal(a.exact, b.exact, 'numbers do not split a job into many keys');
  assert.equal(a.coarse, 'tests|orchard');
  assert.equal(usageKeys('', 'orchard', 'x').coarse, '', 'no class: no coarse key');
});

test('measureOf: not warm, stale, warm (floor and declared cap)', () => {
  const use = (o) => ({ at: 1_000_000, n: 5, cpu: 2, ramMb: 400, ramPeakMb: 500, win: [1, 2.2, 1.5, 0.5], ...o });
  const now = 1_010_000;
  assert.equal(measureOf(null, 8, now), null);
  const cold = measureOf(use({ n: 2 }), 8, now);
  assert.equal(cold.warm, false); assert.equal(cold.charge, null);
  const stale = measureOf(use({}), 8, 1_000_000 + LIVE_DEFAULTS.staleMs + 1);
  assert.equal(stale.fresh, false); assert.equal(stale.charge, null, 'a stale measure is not trusted');
  assert.equal(measureOf(use({}), 8, now).charge, 3, 'ceil of the peak of the window');
  assert.equal(measureOf(use({ win: [0.1, 0.2, 0.1, 0.05] }), 8, now).charge, 1, 'never below the floor');
  assert.equal(measureOf(use({ win: [20, 30, 25, 9] }), 8, now).charge, 8, 'never above declared');
  assert.equal(measureOf(use({ win: [9, 0.4, 0.4, 0.4, 0.4] }), 8, now).charge, 1, 'only the last window counts');
});

test('effectiveBox: expected cpu rounded up inside [floor, declared]; declared when unknown', () => {
  assert.equal(effectiveBox(8, undefined), 8);
  assert.equal(effectiveBox(8, null), 8);
  assert.equal(effectiveBox(8, 2.2), 3);
  assert.equal(effectiveBox(8, 0.2), 1);
  assert.equal(effectiveBox(8, 40), 8);
  assert.equal(effectiveBox(0, 3), 0);
});

test('sampleUse: interval cpu from deltas; a new pid counts whole, an old pid without baseline counts nothing, an exited pid drops out', () => {
  const tree = { procs: [{ pid: 1, creationTime: 10 }, { pid: 2, creationTime: 20 }] };
  assert.equal(sampleUse(null, tree, [{ pid: 1, creationTime: 10, cpuMs: undefined }], 100_000), null, 'no cpu column: nothing');
  const first = sampleUse(null, tree, [{ pid: 1, creationTime: 10, memMb: 50, cpuMs: 1000 }, { pid: 2, creationTime: 20, memMb: 70, cpuMs: 500 }], 100_000);
  assert.equal(first.cores, null, 'the first reading has no baseline');
  assert.equal(first.ramMb, 120);
  const tree3 = { procs: [...tree.procs, { pid: 3, creationTime: 105_000 }, { pid: 4, creationTime: 5 }] };
  const second = sampleUse(first, tree3, [
    { pid: 1, creationTime: 10, memMb: 50, cpuMs: 11_000 }, // +10 s over 20 s
    { pid: 3, creationTime: 105_000, memMb: 10, cpuMs: 4000 }, // born after the last reading: whole 4 s
    { pid: 4, creationTime: 5, memMb: 10, cpuMs: 90_000 }, // old, no baseline: 0
    // pid 2 exited
  ], 120_000);
  assert.ok(Math.abs(second.cores - (10_000 + 4000) / 20_000) < 1e-9);
  assert.equal(second.ramMb, 70);
  const reused = sampleUse(first, tree, [{ pid: 1, creationTime: 999, memMb: 5, cpuMs: 90_000 }], 120_000);
  assert.equal(reused.cores, 0, 'a reused pid (other creation time) is not ours');
});

test('makeUseTracker: no record for the baseline, a window after, a history row only once warm', () => {
  const tr = makeUseTracker();
  const tree = { procs: [{ pid: 1, creationTime: 10 }] };
  const tbl = (ms) => [{ pid: 1, creationTime: 10, memMb: 200, cpuMs: ms }];
  assert.equal(tr.add(tree, tbl(0), 0), null, 'baseline');
  const u1 = tr.add(tree, tbl(25_000), 25_000);
  assert.equal(u1.v, 1); assert.equal(u1.n, 1); assert.equal(u1.cpu, 1);
  assert.equal(tr.row({ key: 'k' }, 25_000), null, 'too short to trust');
  tr.add(tree, tbl(75_000), 50_000); // 2 cores
  tr.add(tree, tbl(100_000), 75_000);
  tr.add(tree, tbl(100_000), 100_000);
  const u5 = tr.add(tree, tbl(100_000), 125_000);
  assert.equal(u5.win.length, 4, 'window is the last four');
  const row = tr.row({ key: 'k' }, 125_000);
  assert.equal(row.key, 'k'); assert.equal(row.n, 5); assert.equal(row.cpuMax, 2); assert.equal(row.cpuP90, 2); assert.equal(row.ramMaxMb, 200);
});

test('expectedFor: unknown below minRuns, the p90 over runs, class key as fallback, newest rows only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-live-hist-'));
  try {
    const keys = usageKeys('tests', 'orchard', 'unit tests');
    assert.equal(expectedFor(dir, keys), null, 'no history file');
    const row = (key, key2, cpuP90, ramMaxMb) => ({ ts: 1, key, key2, cpuP90, ramMaxMb });
    appendUsage(dir, row(keys.exact, keys.coarse, 2, 1000));
    appendUsage(dir, row(keys.exact, keys.coarse, 3, 2000));
    assert.equal(expectedFor(dir, keys), null, 'two runs are not enough');
    appendUsage(dir, row(keys.exact, keys.coarse, 1, 3000));
    const exact = expectedFor(dir, keys);
    assert.deepEqual({ cpu: exact.cpu, ramMb: exact.ramMb, runs: exact.runs, basis: exact.basis }, { cpu: 3, ramMb: 3000, runs: 3, basis: 'exact' });
    const other = usageKeys('tests', 'orchard', 'a different job');
    assert.equal(expectedFor(dir, other).basis, 'class', 'the class key answers when the exact key has no history');
    assert.equal(expectedFor(dir, usageKeys('build', 'orchard', 'unit tests')), null);
    for (let i = 0; i < 25; i += 1) appendUsage(dir, row(keys.exact, keys.coarse, 1, 100));
    assert.equal(expectedFor(dir, keys).cpu, 1, 'only the newest 20 rows are read');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cpu time in process snapshots: ps time column (with and without), Windows kernel+user time', () => {
  assert.equal(parsePsTime('00:00:07'), 7000);
  assert.equal(parsePsTime('01:02:03.50'), 3_723_500);
  assert.equal(parsePsTime('2-00:00:01'), 172_801_000);
  assert.equal(parsePsTime('12:30'), 750_000);
  assert.equal(parsePsTime('garbage'), null);
  const withTime = parsePsOutput('  412   1  20480  00:01:30 Sat Nov 21 10:00:00 2026 /usr/bin/worker --serve\n');
  assert.equal(withTime.length, 1);
  assert.equal(withTime[0].pid, 412); assert.equal(withTime[0].cpuMs, 90_000); assert.equal(withTime[0].memMb, 20); assert.equal(withTime[0].cmd, '/usr/bin/worker --serve');
  const without = parsePsOutput('  412   1  20480 Sat Nov 21 10:00:00 2026 /usr/bin/worker --serve\n');
  assert.equal(without.length, 1);
  assert.equal('cpuMs' in without[0], false);
  const win = parseWinJson(JSON.stringify([{ p: 5, pp: 1, n: 'a.exe', e: 'C:\\a.exe', c: 'a.exe', s: '20261121100000.000000+000', w: 2097152, k: 25_000_000 }, { p: 6, pp: 1, n: 'b.exe', c: 'b.exe', w: 1048576 }]));
  assert.equal(win[0].cpuMs, 2500);
  assert.equal('cpuMs' in win[1], false, 'no k: no cpuMs');
});

// ---------------------------------------------------------------- admission by free CPU and RAM

test('free CPU: a request is refused when the machine has not that many idle cores, admitted when it has, and live off never asks', async () => {
  const mk = (live) => world({ live, cores: 64, budget: 16, reserve: 8, loadPct: Infinity });
  const w = mk(true);
  try {
    w.busy = 60; // outside work keeps 60 of 64 cores busy; the threshold is 56 (8 kept idle)
    const a = await w.acq({ box: 1, label: 'holder', pid: 9001 });
    w.t += 200_000; // past warm-up: no promised-but-unmeasured cpu in the way
    let b = null;
    const pb = w.acq({ box: 3, label: 'wants three', pid: 9002 }).then((l) => { b = l; });
    await settle(40);
    assert.equal(b, null, 'refused: no free cpu');
    assert.match(reasonOf(w, 'wants three'), /cpu 3 wanted \(declared\), 0 free \(60 cores busy of 64, 8 kept idle/);
    w.busy = 50; // load drops: 6 free
    await settle(40);
    await pb;
    assert.ok(b && !b.off, 'admitted once the cores are free');
    a.release(); b.release();
  } finally { w.done(); }
  const off = mk(false);
  try {
    off.busy = 60;
    const a = await off.acq({ box: 1, label: 'holder', pid: 9001 });
    const b = await off.acq({ box: 3, label: 'wants three', pid: 9002, maxWaitMs: 5000 });
    assert.equal(off.polls, 0, 'live off: admitted at once, as before');
    a.release(); b.release();
  } finally { off.done(); }
});

test('free CPU uses the expected cpu when the job has a history', async () => {
  const w = world({ cores: 64, budget: 16, reserve: 8, loadPct: Infinity });
  try {
    w.busy = 54; // 2 free under the 56 threshold
    const seed = await w.acq({ box: 3, label: 'nightly suite', cls: 'tests', pid: 9001 });
    seedHistory(w, seed, { cpuP90: 1, ramMaxMb: 500 });
    seed.release();
    const holder = await w.acq({ box: 1, label: 'holder', pid: 9002 });
    w.t += 200_000;
    const known = await w.acq({ box: 3, label: 'nightly suite', cls: 'tests', pid: 9003, maxWaitMs: 1e9 });
    assert.equal(w.leases().find((l) => l.id === known.id).expCpu, 1, 'the lease records what it was expected to use');
    let other = null;
    const po = w.acq({ box: 3, label: 'fresh job', cls: 'other', pid: 9004 }).then((l) => { other = l; });
    await settle(40);
    assert.equal(other, null, 'no history: declared 3 against 2 free');
    known.release(); holder.release();
    await settle(40);
    await po;
    other.release();
  } finally { w.done(); }
});

test('RAM: a running job is charged its expected peak while it ramps up, then drops out of the committed RAM', async () => {
  const w = world();
  try {
    w.free = 40 * GB; w.total = 64 * GB; // 40960 MB free, reserve 1000 MB
    const seed = await w.acq({ box: 2, label: 'build', cls: 'compile', pid: 9001 });
    seedHistory(w, seed, { cpuP90: 1, ramMaxMb: 30_000 });
    seed.release();
    const a = await w.acq({ box: 2, label: 'build', cls: 'compile', pid: 9002 });
    assert.equal(w.leases().find((l) => l.id === a.id).expRamMb, 30_000);
    let b = null;
    const pb = w.acq({ box: 2, ramMb: 20_000, label: 'needs ram', pid: 9003 }).then((l) => { b = l; });
    await settle(8); // the waiter's polls move the fake clock 1.5 s each: stay inside the 60 s ramp
    assert.equal(b, null, '30 GB still ramping up leaves too little');
    assert.match(reasonOf(w, 'needs ram'), /RAM 20000 MB needed, \d+ MB free after a \d+ MB reserve and 30000 MB still ramping up/);
    w.t += 61_000; // ramp over: the real free RAM (fake: unchanged) is what counts
    await settle(40);
    await pb;
    assert.ok(b && !b.off);
    a.release(); b.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- charge follows measure

test('charge follows the measure after warm-up: an idle holder costs the floor and a second job gets in; live off keeps declared', async () => {
  for (const live of [true, false]) {
    const w = world({ live, cores: 64, budget: 16 });
    try {
      const rt = fakeProcs();
      w.busy = 1;
      const a = await w.acq({ box: 12, label: 'idle holder', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
      warm(w, rt, a, 0.3);
      const h = boxHolder(w, 'idle holder');
      assert.equal(h.declared, 12);
      assert.equal(h.charged, live ? 1 : 12, live ? 'the floor' : 'declared, as before');
      let b = null;
      const pb = w.acq({ box: 8, label: 'second job', pid: 9002 }).then((l) => { b = l; });
      await settle(40);
      if (live) {
        assert.ok(b && !b.off, '1 + 8 fits a budget of 16');
        assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'box').held, 9);
      } else {
        assert.equal(b, null, '12 + 8 does not');
        assert.match(reasonOf(w, 'second job'), /box:8 wanted, 4 available of 16/);
        a.release();
        await settle(40);
      }
      await pb;
      assert.ok(b && !b.off);
      a.release(); b.release();
    } finally { w.done(); }
  }
});

test('charge: warm and fresh measure charges ceil(peak of the window); declared is the cap; a stale measure goes back to declared', async () => {
  const w = world({ cores: 64, budget: 16 });
  try {
    const rt = fakeProcs();
    const a = await w.acq({ box: 6, label: 'busy holder', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    warm(w, rt, a, 2.2);
    assert.equal(boxHolder(w, 'busy holder').charged, 3);
    pump(w, rt, a, 40, 4); // far over declared
    assert.equal(boxHolder(w, 'busy holder').charged, 6, 'never above declared');
    pump(w, rt, a, 0.1, 4);
    assert.equal(boxHolder(w, 'busy holder').charged, 1);
    w.t += LIVE_DEFAULTS.staleMs + 1_000; // the wrapper stopped ticking
    const h = boxHolder(w, 'busy holder');
    assert.equal(h.charged, 6, 'stale: declared again');
    assert.equal(h.measured.fresh, false);
    a.release();
  } finally { w.done(); }
});

test('physical cores cap: the box limit is min(budget, cores) with live on, the budget alone with live off', async () => {
  for (const live of [true, false]) {
    const w = world({ live, cores: 4, budget: 16 });
    try {
      w.busy = 0;
      const a = await w.acq({ box: 3, label: 'first', pid: 9001 });
      let b = null;
      const pb = w.acq({ box: 3, label: 'second', pid: 9002 }).then((l) => { b = l; });
      await settle(40);
      if (live) {
        assert.equal(b, null, '3 + 3 is over the 4 physical cores');
        assert.match(reasonOf(w, 'second'), /box:3 wanted, 1 available of 4, capped at the 4 physical cores/);
        a.release();
        await settle(40);
      }
      await pb;
      assert.ok(b && !b.off, live ? 'admitted after the first released' : 'live off: the 16-unit budget admits it');
      if (!live) a.release();
      b.release();
    } finally { w.done(); }
  }
});

test('ramp limit: a lease still warming is charged its expected usage, so a burst of grants cannot pass the cores; unmeasured past warmingMs it is declared', async () => {
  const w = world({ cores: 4, budget: 4, reserve: 0 });
  try {
    w.busy = 0;
    const seed = await w.acq({ box: 4, label: 'burst job', cls: 'tests', pid: 9001 });
    seedHistory(w, seed, { cpuP90: 1.5, ramMaxMb: 200 });
    seed.release();
    const a = await w.acq({ box: 4, label: 'burst job', cls: 'tests', pid: 9002 });
    const b = await w.acq({ box: 4, label: 'burst job', cls: 'tests', pid: 9003 });
    assert.equal(boxHolder(w, 'burst job').charged, 2, 'expected 1.5 cores, charged 2 while warming');
    assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'box').held, 4, 'two warming leases charge 2 + 2');
    let c = null;
    const pc = w.acq({ box: 4, label: 'burst job', cls: 'tests', pid: 9004 }).then((l) => { c = l; });
    await settle(40);
    assert.equal(c, null, 'a third would pass the 4 cores');
    assert.match(reasonOf(w, 'burst job'), /box:2 \(expected, declared 4\) wanted, 0 available of 4/);
    w.t += LIVE_DEFAULTS.warmingMs + 1_000; // never measured (no wrapper ticks): back to declared, 4 + 4
    const h = resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'box');
    assert.equal(h.held, 8, 'past the warm-up window an unmeasured lease costs its declared size');
    a.release(); b.release();
    await settle(40);
    await pc;
    c.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- status

test('status: each holder reports declared, charged, measured and expected; the machine reports liveCapacity', async () => {
  const w = world({ cores: 64, budget: 16 });
  try {
    const rt = fakeProcs();
    rt.memMb = 640;
    const a = await w.acq({ box: 6, label: 'measured one', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    let st = resourceStatus({ ...w.opts });
    assert.equal(st.machine.liveCapacity, true);
    assert.equal(boxHolder(w, 'measured one').measured, null, 'nothing measured yet');
    warm(w, rt, a, 2);
    const h = boxHolder(w, 'measured one');
    assert.equal(h.declared, 6); assert.equal(h.charged, 2);
    assert.equal(h.measured.warm, true); assert.equal(h.measured.fresh, true); assert.equal(h.measured.cpu, 2); assert.equal(h.measured.ramMb, 640);
    assert.match(formatResourceStatus(resourceStatus({ ...w.opts })), /declared 6 \/ charged 2 \/ measured 2 cpu 640 MB/);
    w.t += LIVE_DEFAULTS.staleMs + 1_000;
    assert.match(formatResourceStatus(resourceStatus({ ...w.opts })), /warming up or stale: charged as declared/);
    a.release();
    const off = world({ live: false });
    try { assert.equal(resourceStatus({ ...off.opts }).machine.liveCapacity, false); } finally { off.done(); }
  } finally { w.done(); }
});

test('status: every waiter gets its reason, not only the first', async () => {
  const w = world({ cores: 4, budget: 4 });
  try {
    w.busy = 0;
    const a = await w.acq({ box: 4, label: 'holder', pid: 9001 });
    let b = null; let c = null;
    const pb = w.acq({ box: 3, label: 'waiter one', pid: 9002 }).then((l) => { b = l; });
    await settle(20);
    const pc = w.acq({ box: 2, label: 'waiter two', pid: 9003 }).then((l) => { c = l; });
    await settle(40);
    const text = formatResourceStatus(resourceStatus({ ...w.opts, sample: true }));
    const whys = text.split('\n').filter((l) => /^\s+why: /.test(l));
    assert.equal(whys.length, 2, text);
    assert.match(whys[0], /box:3 wanted/);
    assert.match(whys[1], /queued behind pid 9002|box:2 wanted/);
    a.release();
    await settle(40);
    await pb; b.release();
    await settle(40);
    await pc; c.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- the wrapper's tick and the history row

test('track() writes lease-<id>.use; release() removes it and appends one usage row that the next request reads', async () => {
  const w = world({ cores: 64, budget: 16 });
  try {
    const rt = fakeProcs();
    const a = await w.acq({ box: 4, label: 'recorded job 3', cls: 'tests', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    assert.equal(existsSync(useFile(w.dir, a.id)), false, 'no sidecar before the first interval');
    a.track();
    assert.equal(existsSync(useFile(w.dir, a.id)), false, 'the baseline reading writes nothing');
    pump(w, rt, a, 1.5, 4);
    const use = readUse(w.dir, a.id);
    assert.equal(use.n, 4); assert.equal(use.cpu, 1.5); assert.deepEqual(use.win, [1.5, 1.5, 1.5, 1.5]); assert.equal(use.ramMb, 300);
    a.release();
    assert.equal(existsSync(useFile(w.dir, a.id)), false, 'the sidecar goes with the lease');
    const rows = readFileSync(usageFile(w.dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cpuP90, 1.5); assert.equal(rows[0].ramMaxMb, 300); assert.equal(rows[0].n, 4); assert.equal(rows[0].declared, 4); assert.equal(rows[0].cls, 'tests');
    assert.equal(rows[0].key, usageKeys('tests', rows[0].repo, 'recorded job 3').exact, 'numbers in the label are folded');
    for (let i = 0; i < 2; i += 1) { // two more runs make the job known (minRuns 3)
      const r = await w.acq({ box: 4, label: `recorded job ${i + 4}`, cls: 'tests', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
      warm(w, rt, r, 1.5); r.release();
    }
    const next = await w.acq({ box: 4, label: 'recorded job 9', cls: 'tests', pid: 9050 });
    assert.equal(w.leases().find((l) => l.id === next.id).expCpu, 1.5);
    assert.deepEqual(w.tickets(), []);
    next.release();
  } finally { w.done(); }
});

test('a run shorter than the warm-up leaves no history row', async () => {
  const w = world();
  try {
    const rt = fakeProcs();
    const a = await w.acq({ box: 4, label: 'quick job', cls: 'tests', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    warm(w, rt, a, 1, 2);
    a.release();
    assert.equal(existsSync(usageFile(w.dir)), false);
  } finally { w.done(); }
});

test('live off: no sidecar, no history row, no expected values, declared charge, and the option reads from the environment', async () => {
  const w = world({ live: false, cores: 64, budget: 16 });
  try {
    const rt = fakeProcs();
    const a = await w.acq({ box: 6, label: 'plain job', cls: 'tests', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    warm(w, rt, a, 0.2);
    assert.equal(existsSync(useFile(w.dir, a.id)), false);
    const rec = w.leases().find((l) => l.id === a.id);
    assert.equal(rec.ukey, undefined); assert.equal(rec.expCpu, undefined);
    assert.equal(boxHolder(w, 'plain job').charged, 6);
    a.release();
    assert.equal(existsSync(usageFile(w.dir)), false);
  } finally { w.done(); }
  const prev = process.env.CLAUDE_PLUGIN_OPTION_LIVE_CAPACITY;
  const e = world({ live: undefined, cores: 64, budget: 16 });
  try {
    process.env.CLAUDE_PLUGIN_OPTION_LIVE_CAPACITY = 'off';
    assert.equal(resourceStatus({ ...e.opts }).machine.liveCapacity, false, 'the option text off turns it off');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_LIVE_CAPACITY; else process.env.CLAUDE_PLUGIN_OPTION_LIVE_CAPACITY = prev;
    e.done();
  }
});

// ---------------------------------------------------------------- stuck holders (leg 4b): progress sampler and verdict

const pt = (pid, ppid, ct, extra = {}) => ({ pid, ppid, name: 'worker.exe', exe: 'C:\\fake\\worker.exe', cmd: 'worker.exe', creationTime: ct, memMb: 50, ...extra });
const progTree = (...pids) => ({ procs: pids.map((p) => ({ pid: p, creationTime: p * 10 })) });

test('procIo: Linux rchar + wchar; null elsewhere, on a read failure, or with no counters', () => {
  const read = () => 'rchar: 100\nwchar: 50\nsyscr: 3\n';
  assert.equal(procIo(7, { platform: 'linux', read }), 150);
  assert.equal(procIo(7, { platform: 'darwin', read }), null);
  assert.equal(procIo(7, { platform: 'win32', read }), null);
  assert.equal(procIo(7, { platform: 'linux', read: () => { throw new Error('gone'); } }), null);
  assert.equal(procIo(7, { platform: 'linux', read: () => 'syscr: 3\n' }), null);
});

test('sampleProgress: the first reading is a baseline; cpu, io and spawn deltas count; the snapshot probe child does not', () => {
  const tree = progTree(1, 2);
  const t0 = [pt(1, 9, 10, { cpuMs: 1000, ioBytes: 5000 }), pt(2, 1, 20, { cpuMs: 500, ioBytes: 100 })];
  const first = sampleProgress(null, tree, t0, 100_000);
  assert.deepEqual([first.cpu, first.io, first.spawn], [false, false, false]);
  assert.equal(first.haveCpu, true); assert.equal(first.haveIo, true);
  // a snapshot child (powershell Get-CimInstance Win32_Process) in the tree this tick: not a spawn, not cpu
  const probe = { ...pt(3, 1, 100_500), name: 'powershell.exe', cmd: 'powershell -Command Get-CimInstance Win32_Process | ConvertTo-Json', cpuMs: 400, ioBytes: 9000 };
  const treeP = progTree(1, 2, 3);
  const quiet = sampleProgress(first, treeP, [pt(1, 9, 10, { cpuMs: 1000, ioBytes: 5000 }), pt(2, 1, 20, { cpuMs: 500, ioBytes: 100 }), probe], 125_000);
  assert.deepEqual([quiet.cpu, quiet.io, quiet.spawn], [false, false, false], 'nothing moved but the probe');
  assert.deepEqual(quiet.pids, [1, 2]);
  // cpu: 1.25 s over 25 s = 5% of a core
  const busy = sampleProgress(quiet, tree, [pt(1, 9, 10, { cpuMs: 2250, ioBytes: 5000 }), pt(2, 1, 20, { cpuMs: 500, ioBytes: 100 })], 150_000);
  assert.equal(busy.cpu, true); assert.equal(busy.io, false);
  // io: 2 KB moved
  const ioMoved = sampleProgress(busy, tree, [pt(1, 9, 10, { cpuMs: 2250, ioBytes: 7048 }), pt(2, 1, 20, { cpuMs: 500, ioBytes: 100 })], 175_000);
  assert.equal(ioMoved.io, true); assert.equal(ioMoved.cpu, false);
  // a pid that appears is a spawn
  const spawned = sampleProgress(ioMoved, progTree(1, 2, 4), [pt(1, 9, 10, { cpuMs: 2250, ioBytes: 7048 }), pt(2, 1, 20, { cpuMs: 500, ioBytes: 100 }), pt(4, 1, 190_000)], 200_000);
  assert.equal(spawned.spawn, true);
});

test('sampleProgress: no cpu column and no io counter reads null; the io reader fills the counters a table lacks', () => {
  const tree = progTree(1);
  assert.equal(sampleProgress(null, tree, [pt(1, 9, 10)], 100_000), null);
  assert.equal(sampleProgress(null, tree, 'nope', 100_000), null);
  const first = sampleProgress(null, tree, [pt(1, 9, 10, { cpuMs: 10 })], 100_000, { ioOf: () => 1000 });
  assert.equal(first.haveIo, true);
  const next = sampleProgress(first, tree, [pt(1, 9, 10, { cpuMs: 10 })], 125_000, { ioOf: () => 9000 });
  assert.equal(next.io, true);
});

test('makeProgressTracker: the baseline starts the clock; only cpu, io, spawn or output move it', () => {
  const tree = progTree(1);
  const tr = makeProgressTracker(PROG_DEFAULTS);
  const row = (cpu, io) => [pt(1, 9, 10, { cpuMs: cpu, ioBytes: io })];
  const a = tr.add(tree, row(0, 0), 100_000);
  assert.equal(a.lastAt, 100_000); assert.equal(a.n, 1);
  const b = tr.add(tree, row(0, 0), 125_000);
  assert.equal(b.lastAt, 100_000, 'a quiet tick does not move it'); assert.equal(b.n, 2);
  const c = tr.add(tree, row(0, 4096), 150_000);
  assert.equal(c.lastAt, 150_000); assert.equal(c.sig.io, 150_000); assert.equal(c.sig.cpu, 0);
  tr.noteOutput(10, 160_000);
  const d = tr.add(tree, row(0, 4096), 175_000);
  assert.equal(d.lastAt, 160_000); assert.equal(d.outBytes, 10); assert.equal(d.sig.out, 160_000);
  assert.equal(tr.add(null, [], 200_000), null);
});

test('stuckOf: stuck needs all signals silent past the window, a hold past the expected one, and an io or output witness', () => {
  const rule = { quietMs: 120_000, defaultHoldMs: 240_000 };
  const now = 1_000_000;
  const prog = (o = {}) => ({ at: now - 10_000, n: 9, lastAt: now - 300_000, sig: { cpu: 0, io: 0, spawn: 0, out: 0 }, cpuMs: 5000, ioBytes: 70_000, outBytes: 0, ...o });
  const args = (o = {}) => ({ prog: prog(), startedAt: now - 600_000, maxHoldMs: null, rule, now, ...o });
  const v = stuckOf(args());
  assert.equal(v.stuck, true);
  assert.equal(v.quietMs, 300_000); assert.equal(v.quietLimitMs, 120_000);
  assert.equal(v.heldMs, 600_000); assert.equal(v.expectedHoldMs, 240_000);
  assert.deepEqual(v.signals, ['cpu', 'io', 'spawn']);
  // tree cpu alone: no io counters, no output: never a verdict, however quiet
  assert.equal(stuckOf(args({ prog: prog({ ioBytes: null }) })).stuck, false);
  // output is a witness in place of io counters
  assert.equal(stuckOf(args({ prog: prog({ ioBytes: null, outBytes: 5 }) })).stuck, true);
  // not past the expected hold (the lease's own limit wins over the default)
  assert.equal(stuckOf(args({ startedAt: now - 200_000 })).stuck, false);
  assert.equal(stuckOf(args({ maxHoldMs: 900_000 })).stuck, false);
  assert.equal(stuckOf(args({ maxHoldMs: 500_000 })).stuck, true);
  // any signal inside the window clears it: the lease's own latest io, the idle probe seeing activity
  assert.equal(stuckOf(args({ prog: prog({ lastAt: now - 60_000, sig: { cpu: 0, io: now - 60_000, spawn: 0, out: 0 } }) })).stuck, false);
  const probed = stuckOf(args({ act: { sampledAt: now - 5_000, activeAt: now - 30_000 } }));
  assert.equal(probed.stuck, false); assert.equal(probed.by, 'probe');
  assert.equal(stuckOf(args({ act: { sampledAt: now - 400_000, activeAt: now - 30_000 } })).stuck, true, 'a stale probe sample is ignored');
  // too few readings, or a record the wrapper stopped refreshing: no verdict at all
  assert.equal(stuckOf(args({ prog: prog({ n: 1 }) })), null);
  assert.equal(stuckOf(args({ prog: prog({ at: now - 200_000 }) })), null);
  assert.equal(stuckOf(args({ prog: null })), null);
});

test('stuck, end to end through the wrapper tick: a silent worker with io counters reads STUCK in status; any cpu or io tick clears it', async () => {
  const w = makeWorld({ live: true, rules: { ...baseRules(), rules: [{ id: 'stuck', enabled: true, appliesTo: ['run'], quietMs: 120_000, defaultHoldMs: 240_000 }] } });
  try {
    const rt = { cpuMs: 1000, io: 50_000 };
    rt.reapSeams = {
      table: () => [proc(WRAPPER, 1, 'node.exe', 1000), proc(CHILD, WRAPPER, 'worker.exe', 2000, { cpuMs: rt.cpuMs, ioBytes: rt.io })],
      kill: () => ({ ok: true }),
    };
    const a = await w.acq({ box: 2, label: 'hung job', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    a.track();
    for (let i = 0; i < 6; i += 1) { w.t += 25_000; a.track(); }
    assert.equal(boxHolder(w, 'hung job').stuck, null, '150 s quiet but held under the 240 s expected hold');
    for (let i = 0; i < 8; i += 1) { w.t += 25_000; a.track(); }
    const h = boxHolder(w, 'hung job');
    assert.ok(h.stuck, 'quiet 350 s, held 350 s');
    assert.ok(h.stuck.quietMs >= 300_000);
    assert.equal(h.stuck.expectedHoldMs, 240_000);
    assert.ok(h.stuck.signals.includes('io'));
    assert.match(formatResourceStatus(resourceStatus({ ...w.opts })), /STUCK \(no progress \d+m on cpu, io: held \d+m > expected 4m; policy flag: kept\)/);
    w.t += 25_000; rt.io += 8192; a.track(); // the worker reads a file: progress
    assert.equal(boxHolder(w, 'hung job').stuck, null);
    for (let i = 0; i < 14; i += 1) { w.t += 25_000; rt.cpuMs += 5000; a.track(); } // busy on cpu, no io
    assert.equal(boxHolder(w, 'hung job').stuck, null, 'cpu moving is progress');
    a.release();
  } finally { w.done(); }
});

test('stuck: with no io counters (a snapshot without them) tree cpu alone never gives a verdict', async () => {
  const w = makeWorld({ live: true, rules: { ...baseRules(), rules: [{ id: 'stuck', enabled: true, appliesTo: ['run'], quietMs: 120_000, defaultHoldMs: 240_000 }] } });
  try {
    const rt = fakeProcs();
    const a = await w.acq({ box: 2, label: 'cpu only job', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    a.track();
    for (let i = 0; i < 20; i += 1) { w.t += 25_000; a.track(); }
    const h = boxHolder(w, 'cpu only job');
    assert.equal(h.stuck, null);
    assert.equal(h.progress.stuck, false);
    a.release();
  } finally { w.done(); }
});
