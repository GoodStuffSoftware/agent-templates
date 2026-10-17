// The resource queue ledger (scripts/ci-budget.mjs, acquireResources): atomic multi-resource
// grants, per-resource FIFO, exclusivity, reclaim of dead and stale holders, the rule clears
// (gone requester, max hold, idle) and their log, a cleared lease whose process is still alive,
// RAM admission and the bounded wait. Fake work only: every ledger is a fresh temp dir, the
// clock, cpu sampler, RAM and pid liveness are injected, and the one real child process is a
// sleeping node that the test itself ends. Spec: docs/resource-queue.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resourceStatus, isPidAlive, sweepLedger } from '../scripts/ci-budget.mjs';
import { makeWorld, settle, GB, T0 } from './resource-queue-world.mjs';

const heldOf = (w, name) => resourceStatus({ ...w.opts }).resources.find((r) => r.name === name)?.held ?? 0;

// ---------------------------------------------------------------- atomic grant

test('a multi-resource request is granted in one lease, and a waiter holds nothing meanwhile', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A' });
    let during = null;
    const b = await w.acq({
      box: 4, resources: { 'app-e2e': 1 }, label: 'B',
      delay: async (ms) => {
        w.t += ms;
        if (!during) during = { leases: w.leases().map((l) => l.label), box: heldOf(w, 'box'), tickets: w.tickets().length };
        a.release();
      },
    });
    assert.deepEqual(during, { leases: ['A'], box: 0, tickets: 1 }, 'while B waited it held no box units and no lease');
    const rec = w.leases().find((l) => l.label === 'B');
    assert.equal(rec.kind, 'run');
    assert.equal(rec.units, 4);
    assert.deepEqual(rec.resources, { 'app-e2e': 1 });
    assert.equal(w.tickets().length, 0, 'the ticket is gone once the lease exists');
    assert.equal(heldOf(w, 'box'), 4);
    b.release();
    assert.equal(w.leases().length, 0);
  } finally { w.done(); }
});

test('a full box blocks the whole request: the free named resource is not taken in part', async () => {
  const w = makeWorld({ budget: 4 });
  try {
    const hog = await w.acq({ box: 3, label: 'hog' });
    let seen = null;
    const b = await w.acq({
      box: 2, resources: { pool: 1 }, label: 'B',
      delay: async (ms) => {
        w.t += ms;
        if (!seen) seen = { pool: heldOf(w, 'pool'), box: heldOf(w, 'box') };
        hog.release();
      },
    });
    assert.deepEqual(seen, { pool: 0, box: 3 }, 'pool was free the whole time and still not taken');
    assert.equal(w.leases()[0].units, 2);
    assert.deepEqual(w.leases()[0].resources, { pool: 1 });
    b.release();
  } finally { w.done(); }
});

test('a request for more than exists is clamped (box to the budget, a resource to its capacity) with one warning each', async () => {
  const w = makeWorld({ budget: 4 });
  try {
    const l = await w.acq({ box: 9, resources: { pool: 3 } });
    assert.equal(l.units, 4);
    assert.deepEqual(w.leases()[0].resources, { pool: 2 });
    assert.equal(w.lines.filter((x) => /more than the whole budget/.test(x)).length, 1);
    assert.equal(w.lines.filter((x) => /more than its capacity/.test(x)).length, 1);
    l.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- FIFO

test('FIFO is per resource: a box waiter queues behind a box head, a named-only waiter behind a named head, unrelated ones pass', async () => {
  const w = makeWorld();
  try {
    const order = [];
    const watch = (name, p) => p.then((l) => { order.push(name); return l; });
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A' });

    const pB = watch('B', w.acq({ box: 2, resources: { 'app-e2e': 1 }, label: 'B' }));
    w.t += 1;
    const pC = watch('C', w.acq({ box: 2, label: 'C' })); // box is free, but B (ahead, wants box) is the head of the box queue
    w.t += 1;
    const pD = watch('D', w.acq({ resources: { pool: 1 }, label: 'D' })); // shares nothing with B or C
    w.t += 1;
    const pE = watch('E', w.acq({ resources: { 'app-e2e': 1 }, label: 'E' })); // behind B on app-e2e
    await settle();
    assert.deepEqual(order, ['D'], 'only the unrelated request passes the blocked head');
    assert.equal(w.tickets().length, 3, 'B, C and E are queued');

    a.release();
    await settle();
    assert.deepEqual(order, ['D', 'B', 'C'], 'B first, then C behind it; E waits for B to let go of app-e2e');

    const b = await pB;
    b.release();
    await settle();
    assert.deepEqual(order, ['D', 'B', 'C', 'E']);
    for (const p of [pB, pC, pD, pE]) (await p).release();
  } finally { w.done(); }
});

test('the tickets of one resource are served in arrival order', async () => {
  const w = makeWorld();
  try {
    const order = [];
    const a = await w.acq({ resources: { 'app-e2e': 1 } });
    const ps = [];
    for (const name of ['first', 'second', 'third']) {
      ps.push(w.acq({ resources: { 'app-e2e': 1 }, label: name }).then((l) => { order.push(name); l.release(); }));
      w.t += 1;
    }
    await settle();
    assert.deepEqual(order, []);
    a.release();
    await Promise.all(ps);
    assert.deepEqual(order, ['first', 'second', 'third']);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- exclusivity

test('a capacity-1 resource is never held twice, a capacity-2 resource twice but not three times', async () => {
  const w = makeWorld();
  try {
    const peak = { one: 0, two: 0 };
    const seen = () => { peak.one = Math.max(peak.one, heldOf(w, 'app-e2e')); peak.two = Math.max(peak.two, heldOf(w, 'pool')); };
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'a' });
    const p = w.acq({ resources: { 'app-e2e': 1 }, label: 'b', delay: async (ms) => { w.t += ms; seen(); if (w.polls++ >= 2) a.release(); } });
    const b = await p;
    seen();
    assert.equal(peak.one, 1);
    b.release();

    const p1 = await w.acq({ resources: { pool: 1 } });
    const p2 = await w.acq({ resources: { pool: 1 } });
    seen();
    assert.equal(peak.two, 2, 'two holders fit capacity 2');
    const third = await w.acq({
      resources: { pool: 1 }, label: 'third',
      delay: async (ms) => { w.t += ms; seen(); p1.release(); },
    });
    seen();
    assert.equal(peak.two, 2, 'the third waited for a release');
    for (const l of [p2, third]) l.release();
  } finally { w.done(); }
});

test('box units are exclusive up to the budget; alone on the box a request always progresses', async () => {
  const w = makeWorld({ budget: 4 });
  try {
    w.busy = 4; // outside load fills the machine, but nothing of ours is held
    const alone = await w.acq({ box: 4, label: 'alone' });
    assert.equal(w.polls, 0, 'granted without waiting');
    w.busy = 0;
    const p = w.acq({ box: 3, label: 'second', delay: async (ms) => { w.t += ms; alone.release(); } });
    const second = await p;
    assert.ok(w.polls === 0, 'second used its own delay');
    assert.equal(second.units, 3);
    second.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- reclaim

test('a lease whose pid is dead is reclaimed at once, and the clear is logged', async () => {
  const w = makeWorld();
  try {
    await w.acq({ pid: 4242, resources: { 'app-e2e': 1 }, label: 'doomed', project: 'proj-x' });
    w.dead.add(4242);
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    assert.equal(w.polls, 0, 'no wait: the dead holder was swept first');
    assert.ok(w.lines.some((l) => /cleared a stale lease \(process is gone\).*pid 4242/.test(l)));
    const [c] = w.clears();
    assert.equal(c.rule, 'pid-dead');
    assert.equal(c.type, 'lease');
    assert.equal(c.pid, 4242);
    assert.equal(c.label, 'doomed');
    assert.equal(c.project, 'proj-x');
    assert.deepEqual(c.resources, { 'app-e2e': 1 });
    b.release();
  } finally { w.done(); }
});

test('a lease with a stale heartbeat is reclaimed; a beat keeps it alive', async () => {
  const w = makeWorld({ staleMs: 90_000 });
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A' });
    w.t += 60_000;
    a.beat();
    w.t += 60_000; // 120 s after the start, 60 s after the beat
    let released = false;
    const b = await w.acq({
      resources: { 'app-e2e': 1 }, label: 'B',
      delay: async (ms) => { w.t += ms; if (!released) { released = true; a.release(); } },
    });
    assert.equal(w.clears().length, 0, 'a beaten lease was not stale');
    b.release();

    const c = await w.acq({ resources: { 'app-e2e': 1 }, label: 'C' });
    w.t += 91_000; // no beat for 91 s, the pid is alive
    const d = await w.acq({ resources: { 'app-e2e': 1 }, label: 'D' });
    assert.equal(w.clears().length, 1);
    assert.equal(w.clears()[0].rule, 'heartbeat-stale');
    assert.equal(w.clears()[0].label, 'C');
    assert.ok(w.lines.some((l) => /heartbeat is stale/.test(l)));
    d.release();
    c.release();
  } finally { w.done(); }
});

test('gone-requester: a queued ticket whose pid is dead is cleared, and a ticket with a stale heartbeat too', async () => {
  const w = makeWorld({ staleMs: 90_000 });
  try {
    const ticket = (id, pid, at, label) => writeFileSync(join(w.dir, `ticket-${id}.json`), JSON.stringify({
      id, pid, createdAt: at, heartbeatAt: at, kind: 'run', boxUnits: 0, resources: { 'app-e2e': 1 }, ramMb: 0, label, desired: 1,
    }));
    ticket('aaaaaa' + 'aaaaaa', 5151, w.t - 1000, 'ghost');
    w.dead.add(5151);
    ticket('bbbbbb' + 'bbbbbb', process.pid, w.t - 200_000, 'frozen');
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    assert.equal(w.polls, 0, 'neither ghost ticket held B back');
    const rules = Object.fromEntries(w.clears().map((c) => [c.label, c.rule]));
    assert.deepEqual(rules, { ghost: 'requester-gone', frozen: 'ticket-heartbeat-stale' });
    assert.ok(w.clears().every((c) => c.type === 'ticket'));
    b.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- rule clears: max-hold and idle

test('max-hold clears a lease over its limit: logged, tombstoned, never restored by a beat, process untouched', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000 }, label: 'A' });
    w.t += 59_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'under the limit');
    w.t += 2_000;
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    assert.equal(w.polls, 0);
    const [c] = w.clears();
    assert.equal(c.rule, 'max-hold');
    assert.equal(c.type, 'lease');
    assert.equal(c.label, 'A');
    assert.equal(c.evidence.heldMs, 61_000);
    assert.equal(c.evidence.maxHoldMs, 60_000);
    assert.ok(existsSync(join(w.dir, `lease-${a.id}.cleared`)), 'tombstone');
    assert.equal(a.cleared, true);
    a.beat();
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.json`)), false, 'the owner heartbeat does not put a rule-cleared lease back');
    assert.deepEqual(w.leases().map((l) => l.label), ['B']);
    a.release();
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.cleared`)), false, 'release removes the tombstone');
    b.release();
  } finally { w.done(); }
});

test('max-hold falls back to the resource limit, and a disabled rule clears nothing', async () => {
  const w = makeWorld();
  try {
    w.opts.rules.resources['app-e2e'].maxHoldMs = 30_000;
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A' });
    w.t += 31_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears()[0].evidence.maxHoldMs, 30_000);
    a.release();

    w.opts.rules.rules.find((r) => r.id === 'max-hold').enabled = false;
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    w.t += 3_600_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    b.release();
  } finally { w.done(); }
});

test('max-hold does not apply to a full or targeted ci-local lease', async () => {
  const w = makeWorld();
  try {
    w.opts.rules.resources.box.maxHoldMs = 1000;
    const { acquire } = await import('../scripts/ci-budget.mjs');
    const full = acquire({ ...w.opts, kind: 'full', desired: 2 });
    w.t += 3_600_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    assert.equal(w.clears().length, 0);
    full.release();
  } finally { w.done(); }
});

test('idle clears a monitored lease idle past idleMs, once it is old enough', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({
      resources: { 'app-e2e': 1 }, limits: { idleMs: 300_000, minHoldMs: 600_000 }, monitored: true, label: 'A',
    });
    w.t += 660_000; // 11 min
    a.recordActivity(w.t, T0); // sampled now, last working at the start
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    assert.equal(w.polls, 0);
    const [c] = w.clears();
    assert.equal(c.rule, 'idle');
    assert.equal(c.label, 'A');
    assert.equal(c.evidence.idleMs, 660_000);
    assert.equal(c.evidence.idleLimitMs, 300_000);
    assert.ok(existsSync(join(w.dir, `lease-${a.id}.cleared`)));
    a.release();
    b.release();
  } finally { w.done(); }
});

test('idle never clears on weak evidence: a stale probe, recent activity, too young, or an unmonitored lease', async () => {
  const w = makeWorld();
  try {
    const limits = { idleMs: 300_000, minHoldMs: 600_000 };
    // 1. nobody sampled for 11 min (the sidecar still holds the start): "unknown", never "idle"
    const unknown = await w.acq({ resources: { 'app-e2e': 1 }, limits, monitored: true });
    w.t += 660_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'stale probe');
    // 2. sampled just now and active a second ago
    unknown.recordActivity(w.t, w.t - 1000);
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'recent activity');
    unknown.release();

    // 3. idle for 6 min but only held 6 min (under minHoldMs 10 min)
    const young = await w.acq({ resources: { 'app-e2e': 1 }, limits, monitored: true });
    w.t += 360_000;
    young.recordActivity(w.t, T0);
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'under minHoldMs');
    young.release();

    // 4. no monitoring: no sidecar, no idle verdict however long it sits
    const plain = await w.acq({ resources: { 'app-e2e': 1 }, limits });
    w.t += 7_200_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'unmonitored');
    plain.release();
    assert.equal(w.clears().length, 0);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- cleared but alive

test('a cleared lease whose process is alive is never signalled or killed, and its CPU still counts as outside load', async () => {
  const w = makeWorld({ budget: 8, isAlive: isPidAlive });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const realKill = process.kill;
  const signals = [];
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    await new Promise((r) => { child.once('spawn', r); });
    const other = await w.acq({ box: 1, label: 'other' });
    const runaway = await w.acq({ box: 4, pid: child.pid, limits: { maxHoldMs: 60_000 }, label: 'runaway' });
    w.busy = 5; // the runaway's 4 cores plus the other's one: nothing is idle
    process.kill = (pid, sig) => { signals.push(sig); return realKill.call(process, pid, sig); };

    w.t += 61_000;
    const cleared = sweepLedger({ ...w.opts });
    assert.equal(cleared.length, 1);
    assert.equal(w.clears()[0].rule, 'max-hold');
    assert.equal(w.clears()[0].pid, child.pid);

    assert.deepEqual(signals.filter((s) => s !== 0 && s !== undefined), [], 'only liveness probes (signal 0), never a real signal');
    assert.equal(isPidAlive(child.pid), true);
    assert.equal(exited, false, 'the process runs on');

    // The lease is gone, so its four cores are not "held" any more: they read as outside load.
    const st = resourceStatus({ ...w.opts, sample: true });
    assert.equal(st.machine.busyCores, 5);
    assert.equal(st.machine.externalCores, 4, 'busy 5 minus held 1');
    assert.equal(st.resources[0].held, 1);

    let line = '';
    const d = await w.acq({
      box: 4, label: 'D',
      delay: async (ms) => {
        w.t += ms;
        line = w.lines.find((l) => /outside load ~4/.test(l)) ?? line;
        w.busy = 1; // the runaway finally stops
      },
    });
    assert.match(line, /box:4 needed, 3 free of 8 \(1 held, outside load ~4\)/, 'D waited on the cleared process load');
    assert.ok(d.units === 4);
    d.release();
    other.release();
    runaway.release();
  } finally {
    process.kill = realKill;
    child.kill();
    w.done();
  }
});

// ---------------------------------------------------------------- RAM admission

test('RAM admission: free RAM minus the reserve minus leases still ramping must cover the request', async () => {
  const w = makeWorld({ totalmem: () => 64 * GB });
  try {
    w.free = 24 * GB; // 24576 MB; reserve 1000 -> 23576
    const a = await w.acq({ box: 1, ramMb: 4000, label: 'A' });
    let firstWait = '';
    const b = await w.acq({
      box: 1, ramMb: 23_000, label: 'B', // 23576 - 4000 ramping = 19576 < 23000
      delay: async (ms) => {
        w.t += ms;
        if (!firstWait) { firstWait = w.lines.find((l) => /RAM/.test(l)) ?? ''; w.t += 61_000; } // A is past its ramp
      },
    });
    assert.match(firstWait, /RAM 23000 MB needed, 19576 MB free after a 1000 MB reserve and 4000 MB still ramping up/);
    assert.equal(b.units, 1, 'granted once A finished ramping (23576 >= 23000)');
    a.release();
    b.release();
  } finally { w.done(); }
});

test('RAM admission: low free RAM holds a request back, a freeing machine lets it in; alone and no-ram requests skip the check', async () => {
  const w = makeWorld();
  try {
    w.free = 1 * GB;
    const alone = await w.acq({ box: 1, ramMb: 50_000, label: 'alone' });
    assert.equal(w.polls, 0, 'nothing else is held: always progress');
    const noRam = await w.acq({ box: 1, label: 'no ram request' });
    assert.equal(w.polls, 0, 'ramMb 0 is not checked');
    noRam.release();

    w.t += 61_000; // alone is past its ramp
    let blocked = 0;
    const b = await w.acq({
      box: 1, ramMb: 8000, label: 'B',
      delay: async (ms) => { w.t += ms; blocked += 1; if (blocked === 3) w.free = 20 * GB; },
    });
    assert.equal(blocked, 3, 'three polls under the reserve, then in');
    b.release();
    alone.release();
  } finally { w.done(); }
});

test('RAM reserve: the shipped default is max(2 GB, 12.5% of total RAM) and a user value overrides it', async () => {
  const { loadRules } = await import('../scripts/lib/resource-rules.mjs');
  const { ramReserveMb } = await import('../scripts/lib/resource-rules.mjs');
  const shipped = loadRules({ AC_RESOURCE_RULES: join(process.cwd(), 'no-such-rules.json'), CLAUDE_CONFIG_DIR: join(process.cwd(), 'no-such-dir') });
  const at = (gb) => ramReserveMb(shipped, gb * 1024);
  assert.equal(at(64), 8192, '64 GB machine: 8 GB');
  assert.equal(at(32), 4096);
  assert.equal(at(16), 2048, '12.5% of 16 GB is exactly the 2 GB floor');
  assert.equal(at(8), 2048, 'small machine: the floor');
  assert.equal(at(128), 16384);
  assert.equal(ramReserveMb({ ram: { reserveMb: 3000 } }, 64 * 1024), 3000, 'an explicit number wins');
  assert.equal(ramReserveMb({ ram: { reserveMb: 0 } }, 64 * 1024), 0, 'zero turns the reserve off');
  assert.equal(ramReserveMb({}, 64 * 1024), 8192, 'no rules at all: the same default');
});

// ---------------------------------------------------------------- bounded wait, fail open

test('the wait is bounded: past maxWait the request runs over budget with exactly one line', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A' });
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B', maxWaitMs: 5000 });
    assert.equal(heldOf(w, 'app-e2e'), 2, 'over capacity, by design');
    assert.equal(w.lines.filter((l) => /running over budget/.test(l)).length, 1);
    assert.equal(w.tickets().length, 0);
    a.release();
    b.release();
  } finally { w.done(); }
});

test('an unusable ledger directory fails open with a no-op lease; off:true touches nothing', async () => {
  const w = makeWorld();
  try {
    const file = join(w.dir, 'a-file');
    writeFileSync(file, 'x');
    const l = await w.acq({ dir: join(file, 'sub'), box: 2, resources: { 'app-e2e': 1 } });
    assert.equal(l.off, true);
    assert.ok(w.lines.some((x) => /unusable/.test(x)));
    l.release();

    const off = await w.acq({ off: true, box: 2, resources: { 'app-e2e': 1 } });
    assert.equal(off.off, true);
    assert.equal(w.files(/^(lease|ticket)-/).length, 0);
  } finally { w.done(); }
});

test('lease heartbeat: the sidecar file is rewritten by a beat and the lease record carries the run fields', async () => {
  const w = makeWorld();
  try {
    const l = await w.acq({ box: 2, resources: { pool: 1 }, ramMb: 1500, label: 'fields', project: 'p1', session: 's1', limits: { maxHoldMs: 5000 }, monitored: true });
    const rec = w.leases()[0];
    for (const [k, v] of Object.entries({ kind: 'run', units: 2, heavy: 0, ramMb: 1500, label: 'fields', project: 'p1', session: 's1', monitored: true })) {
      assert.deepEqual(rec[k], v, k);
    }
    assert.deepEqual(rec.resources, { pool: 1 });
    assert.deepEqual(rec.limits, { maxHoldMs: 5000 });
    w.t += 5000;
    l.beat();
    assert.equal(Number(readFileSync(join(w.dir, `lease-${l.id}.hb`), 'utf8')), w.t);
    assert.ok(existsSync(join(w.dir, `lease-${l.id}.act`)), 'monitored leases get an activity sidecar');
    l.release();
    assert.equal(w.files(/^lease-/).length, 0, 'release removes the record and every sidecar');
  } finally { w.done(); }
});
