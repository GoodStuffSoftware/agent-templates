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
import { resourceStatus, formatResourceStatus, isPidAlive, sweepLedger } from '../scripts/ci-budget.mjs';
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

const EV = { n: 14, size: 7, shells: 2, links: 3, cpuMs: 12, dtMs: 30_000, pct: 0.04, kids: 0, ports: [], why: null };

test('max-hold on an exclusive resource: a live holder is flagged OVER TIME and kept, active or measured idle; a dead holder is reclaimed', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000, idleMs: 30_000 }, monitored: true, label: 'A' });
    w.t += 59_000;
    a.recordActivity(w.t, w.t); // the tree is working
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'under the limit');
    w.t += 2_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'over the limit but active: kept');
    const holderOf = () => resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.deepEqual(holderOf().overTime, { heldMs: 61_000, maxHoldMs: 60_000, activity: 'active' });
    assert.equal(w.clears().length, 0);
    w.t += 40_000;
    a.recordActivity(w.t, T0 + 59_000, EV); // sampled now, quiet for 42 s (over idleMs)
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'measured idle but alive: flagged, not released');
    const flagged = holderOf().overTime;
    assert.equal(flagged.activity, 'idle');
    assert.equal(flagged.heldMs, 101_000);
    assert.equal(flagged.sampleAgeMs, 0);
    assert.deepEqual(flagged.sample, EV, 'the last sample rides on the flag');
    assert.equal(w.clears().length, 0);
    assert.equal(w.leases().length, 1, 'the lease file is still there');
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.cleared`)), false, 'no tombstone');
    a.beat();
    assert.equal(w.leases().length, 1);
    // The holder dies: the dead-pid rule reclaims it as before.
    w.dead.add(w.leases()[0].pid);
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears()[0].rule, 'pid-dead');
    a.release();
  } finally { w.done(); }
});

test('max-hold falls back to the resource limit; a live holder with or without a probe, exclusive or box-only, is flagged and kept; a disabled rule flags nothing', async () => {
  const w = makeWorld();
  try {
    w.opts.rules.resources['app-e2e'].maxHoldMs = 30_000;
    const e = await w.acq({ resources: { 'app-e2e': 1 }, label: 'E' });
    w.t += 31_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'no probe on an exclusive holder: unknown means keep');
    const held = resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.equal(held.overTime.activity, 'unknown');
    assert.match(formatResourceStatus(resourceStatus({ ...w.opts })), /OVER TIME \(.* limit, unknown: kept, not released\)/);
    e.release();

    w.opts.rules.resources.box.maxHoldMs = 30_000;
    const a = await w.acq({ box: 1, label: 'A' });
    w.t += 31_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'a live box-only holder is flagged, never released');
    assert.equal(w.clears().length, 0);
    const boxHolder = resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'box').holders.find((h) => h.label === 'A');
    assert.equal(boxHolder.overTime.maxHoldMs, 30_000);
    assert.match(formatResourceStatus(resourceStatus({ ...w.opts })), /\[A\].*OVER TIME/);
    // Dead: reclaimed by pid-dead at once.
    w.dead.add(w.leases().find((l) => l.label === 'A').pid);
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears()[0].rule, 'pid-dead');
    a.release();
    w.dead.clear();

    w.opts.rules.rules.find((r) => r.id === 'max-hold').enabled = false;
    const b = await w.acq({ resources: { 'app-e2e': 1 }, label: 'B' });
    w.t += 3_600_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0].overTime, null);
    b.release();
  } finally { w.done(); }
});

test('max-hold flags a live holder whatever the resource capacity (CI_BUDGET_RESOURCES): none is released', async () => {
  for (const envCap of ['app-e2e=2', 'app-e2e=1', undefined]) {
    const w = makeWorld();
    try {
      if (envCap) w.opts.env.CI_BUDGET_RESOURCES = envCap;
      const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000, idleMs: 30_000 }, monitored: true, label: 'A' });
      w.t += 61_000;
      a.recordActivity(w.t, w.t); // the tree is working
      assert.equal(sweepLedger({ ...w.opts }).length, 0, 'env ' + envCap);
      assert.equal(w.clears().length, 0);
      assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0].overTime.activity, 'active');
      a.release();
    } finally { w.done(); }
  }
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

test('idle never releases a live holder: a quiet sampler flags it IDLE? with the sample evidence; a dead holder is still reclaimed', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({
      resources: { 'app-e2e': 1 }, limits: { idleMs: 300_000, minHoldMs: 600_000 }, monitored: true, label: 'A',
    });
    w.t += 660_000; // 11 min
    a.recordActivity(w.t, T0, EV); // sampled now, last working at the start: the sampler reads a quiet tree
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'alive: flagged, not cleared');
    assert.equal(w.clears().length, 0);
    assert.equal(w.leases().length, 1);
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.cleared`)), false, 'no tombstone');
    const st = resourceStatus({ ...w.opts });
    const h = st.resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.equal(h.overTime, null);
    assert.deepEqual(h.idleFlag, { idleMs: 660_000, idleLimitMs: 300_000, sampleAgeMs: 0, sample: EV });
    assert.match(formatResourceStatus(st), /\[A\].*IDLE\? \(quiet 11m.* holder alive: kept, not released\)/);
    // The same flag from a sidecar written without a sample record (older wrapper): no sample, still flagged.
    a.recordActivity(w.t, T0);
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0].idleFlag.sample, null);
    // Only the holder's death ends it.
    w.dead.add(w.leases()[0].pid);
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears()[0].rule, 'pid-dead');
    a.release();
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

// ---------------------------------------------------------------- live-holder ceiling, stale heartbeat of a live pid, manual release

const CEIL = 4 * 3600_000;

test('live-holder ceiling: a flagged live holder is kept up to 4 h from the grant, then released with a loud clear that names the flag', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000, idleMs: 30_000 }, monitored: true, label: 'A', pid: 811 });
    w.t += CEIL - 1000; // 3 h 59 min 59 s
    a.recordActivity(w.t, w.t); // working, over the 60 s limit: flagged OVER TIME
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'under the ceiling: flagged and kept');
    assert.ok(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0].overTime);
    w.t += 2000; // past 4 h
    a.recordActivity(w.t, w.t);
    const cleared = sweepLedger({ ...w.opts });
    assert.equal(cleared.length, 1);
    const c = w.clears()[0];
    assert.equal(c.rule, 'live-holder-ceiling');
    assert.equal(c.pid, 811);
    assert.equal(c.evidence.flaggedBy, 'max-hold');
    assert.equal(c.evidence.ceilingMs, CEIL);
    assert.equal(c.evidence.heldMs, CEIL + 1000);
    assert.equal(c.evidence.maxHoldMs, 60_000, 'the original flag evidence rides on the record');
    assert.ok(w.lines.some((l) => /RELEASED the lease of LIVE pid 811/.test(l) && /NOT touched/.test(l)), 'a loud line');
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.cleared`)), true, 'tombstone: the wrapper heartbeat does not put it back');
    assert.equal(w.leases().length, 0);
    a.release();
  } finally { w.done(); }
});

test('live-holder ceiling: idle-flagged holders too; configurable in the rules; null or 0 or disabled keeps the flag for ever', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { idleMs: 300_000, minHoldMs: 0 }, monitored: true, label: 'A' });
    w.t += 600_000;
    a.recordActivity(w.t, T0, EV);
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'IDLE? flagged and kept');
    w.opts.rules.rules.push({ id: 'live-holder-ceiling', enabled: true, ceilingMs: 500_000 });
    a.recordActivity(w.t, T0, EV);
    assert.equal(sweepLedger({ ...w.opts }).length, 1, 'a 500 s ceiling releases it at 600 s');
    assert.equal(w.clears()[0].rule, 'live-holder-ceiling');
    assert.equal(w.clears()[0].evidence.flaggedBy, 'idle');
    a.release();
    for (const off of [{ ceilingMs: null }, { ceilingMs: 0 }, { enabled: false }]) {
      const w2 = makeWorld();
      try {
        w2.opts.rules.rules.push({ id: 'live-holder-ceiling', enabled: true, ceilingMs: 120_000, ...off });
        const b = await w2.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000 }, label: 'B' });
        w2.t += 10 * 3600_000;
        assert.equal(sweepLedger({ ...w2.opts }).length, 0, JSON.stringify(off));
        assert.ok(w2.leases().length === 1);
        b.release();
      } finally { w2.done(); }
    }
  } finally { w.done(); }
});

test('a holder over time and quiet carries both flags; every flag names the release command', async () => {
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, limits: { maxHoldMs: 60_000, idleMs: 30_000, minHoldMs: 0 }, monitored: true, label: 'A' });
    w.t += 120_000;
    a.recordActivity(w.t, T0, EV); // sampled now, quiet since the start
    assert.equal(sweepLedger({ ...w.opts }).length, 0);
    const st = resourceStatus({ ...w.opts });
    const h = st.resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.equal(h.overTime.activity, 'idle');
    assert.ok(h.idleFlag, 'idleFlag is set beside overTime');
    assert.match(h.releaseCommand, new RegExp(`resource-queue\\.mjs" release ${a.id}$`));
    assert.equal(h.ceilingMs, CEIL);
    const text = formatResourceStatus(st);
    assert.match(text, /OVER TIME .*IDLE\? /);
    assert.match(text, new RegExp(`released by the sweep at 4h.*release by hand: node ".*resource-queue\\.mjs" release ${a.id}`));
    a.release();
  } finally { w.done(); }
});

test('stale heartbeat, pid verified live (started no later than the grant): flagged HEARTBEAT STALE and kept; a reused pid or an unknown start is released; the 4 h ceiling applies', async () => {
  const w = makeWorld({ staleMs: 90_000 });
  try {
    w.starts[821] = T0 - 60_000; // the holder's process started before the grant
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A', pid: 821 });
    w.t += 120_000; // no beat for 120 s
    // status never spawns and never writes: nothing verified yet, so it reads as stale
    assert.equal(resourceStatus({ ...w.opts }).resources.find((r) => r.name === 'app-e2e').holders[0].stale, 'heartbeat is stale');
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.live`)), false);
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'verified live: kept');
    assert.equal(w.clears().length, 0);
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.live`)), true, 'the verification is cached beside the lease');
    const st = resourceStatus({ ...w.opts });
    const h = st.resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.equal(h.stale, null);
    assert.equal(h.hbStale.staleMs, 90_000);
    assert.ok(h.hbStale.heartbeatAgeMs >= 120_000);
    assert.match(formatResourceStatus(st), /HEARTBEAT STALE \(no beat for 2m.*pid verified alive: kept, not released\).*release by hand: node ".*" release /);
    // it still holds the resource: a second request waits
    let polled = 0;
    const b = w.acq({ resources: { 'app-e2e': 1 }, label: 'B', delay: async (ms) => { w.t += ms; polled += 1; if (polled === 3) w.dead.add(821); } });
    const got = await b;
    assert.ok(polled >= 3, 'B waited behind the flagged holder');
    assert.equal(w.clears().find((c) => c.label === 'A').rule, 'pid-dead', 'a dead holder is still cleared at once');
    got.release();
    a.release();

    // past the ceiling
    const c = await w.acq({ resources: { 'app-e2e': 1 }, label: 'C', pid: 822 });
    w.starts[822] = w.t - 60_000;
    w.t += CEIL - 1000;
    assert.equal(sweepLedger({ ...w.opts }).length, 0, 'stale but verified live, under the ceiling');
    w.t += 2000;
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    const cc = w.clears().find((x) => x.label === 'C');
    assert.equal(cc.rule, 'live-holder-ceiling');
    assert.equal(cc.evidence.flaggedBy, 'heartbeat-stale');
    assert.equal(existsSync(join(w.dir, `lease-${c.id}.live`)), false, 'the cache file goes with the lease');
    c.release();

    // a reused pid (its process started after the grant) is not the holder: released as stale
    const d = await w.acq({ resources: { 'app-e2e': 1 }, label: 'D', pid: 823 });
    w.starts[823] = w.t + 30_000;
    w.t += 120_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears().find((x) => x.label === 'D').rule, 'heartbeat-stale');
    d.release();
    // an unknown start time: also released, as before
    const e = await w.acq({ resources: { 'app-e2e': 1 }, label: 'E', pid: 824 });
    w.t += 120_000;
    assert.equal(sweepLedger({ ...w.opts }).length, 1);
    assert.equal(w.clears().find((x) => x.label === 'E').rule, 'heartbeat-stale');
    e.release();
  } finally { w.done(); }
});

test('release by hand: by id or unique prefix, logged as a clear by "manual", the tombstone stops the wrapper, the process is not touched', async () => {
  const { releaseLease } = await import('../scripts/ci-budget.mjs');
  const w = makeWorld();
  try {
    const a = await w.acq({ resources: { 'app-e2e': 1 }, label: 'A', project: 'proj-a', pid: 831 });
    const b = await w.acq({ resources: { pool: 1 }, label: 'B', pid: 832 });
    assert.equal(releaseLease({ ...w.opts, id: 'zz' }).ok, false);
    assert.match(releaseLease({ ...w.opts, id: 'beef01' }).error, /no lease with id/);
    const r = releaseLease({ ...w.opts, id: a.id.slice(0, 6) });
    assert.equal(r.ok, true);
    assert.equal(r.released.id, a.id);
    assert.equal(r.released.wasAlive, true);
    const c = w.clears()[0];
    assert.equal(c.rule, 'manual');
    assert.equal(c.evidence.by, 'manual');
    assert.equal(c.label, 'A');
    assert.equal(c.pid, 831);
    assert.deepEqual(c.resources, { 'app-e2e': 1 });
    assert.equal(existsSync(join(w.dir, `lease-${a.id}.cleared`)), true);
    assert.deepEqual(w.leases().map((l) => l.label), ['B'], 'only A went');
    assert.equal(resourceStatus({ ...w.opts }).resources.find((x) => x.name === 'app-e2e').held, 0);
    assert.equal(releaseLease({ ...w.opts, id: a.id }).ok, false, 'already gone');
    b.release(); a.release();
  } finally { w.done(); }
});

// ---------------------------------------------------------------- cleared but alive

test('a cleared lease whose process is alive is never signalled or killed, and its CPU still counts as outside load', async () => {
  const w = makeWorld({ budget: 8, isAlive: isPidAlive, staleMs: 60_000 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const realKill = process.kill;
  const signals = [];
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    await new Promise((r) => { child.once('spawn', r); });
    const other = await w.acq({ box: 1, label: 'other' });
    const runaway = await w.acq({ box: 4, pid: child.pid, label: 'runaway' }); // its heartbeat goes stale: the clear that can still leave a live process
    w.busy = 5; // the runaway's 4 cores plus the other's one: nothing is idle
    process.kill = (pid, sig) => { signals.push(sig); return realKill.call(process, pid, sig); };

    w.t += 61_000;
    other.beat();
    const cleared = sweepLedger({ ...w.opts });
    assert.equal(cleared.length, 1);
    assert.equal(w.clears()[0].rule, 'heartbeat-stale');
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
