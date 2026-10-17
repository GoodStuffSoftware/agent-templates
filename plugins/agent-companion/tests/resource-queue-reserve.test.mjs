// Reservations ("reserve --for <group> --until"), hold/resume of one's own queued
// entries, and pid-bound daemon leases, in the machine-wide resource queue
// (scripts/ci-budget.mjs, scripts/resource-queue.mjs). Spec: docs/resource-queue.md.
//
// Every test runs in a temp ledger with a fake clock and fake liveness: nothing
// here sleeps, samples the cpu or touches the real ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import './isolate.mjs';
import {
  acquireResources, resourceStatus, reserveResource, unreserveResource, holdMine, resumeMine, sweepLedger, formatResourceStatus,
  MAX_RESERVATION_MS,
} from '../scripts/ci-budget.mjs';
import { cli, parseUntil } from '../scripts/resource-queue.mjs';

const H = 3600_000;
const NO_RULES = { version: 1, resources: {}, classes: [], rules: [] };

function world(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-reserve-'));
  const w = { dir, t: 1_700_000_000_000, dead: new Set(), gates: [], pid: 900 };
  w.now = () => w.t;
  w.delay = () => new Promise((r) => { w.gates.push(r); });
  w.opts = (o = {}) => ({
    dir, now: w.now, delay: w.delay, sleep: () => {}, isAlive: (p) => !w.dead.has(p), sampler: () => 0,
    budget: 8, cores: 8, staleMs: 1e12, rules: NO_RULES, env: {}, legacyDir: join(dir, 'legacy'), log: () => {},
    registerExit: false, heartbeat: 'off', session: '', project: 'p', repo: 'r', worktree: dir,
    freemem: () => 64 * 1024 ** 3, totalmem: () => 64 * 1024 ** 3, ...extra, ...o,
  });
  // A waiter: a distinct pid, a later createdAt than the one before it.
  w.start = (o = {}) => {
    w.t += 10;
    w.pid += 1;
    const s = { done: false, lease: null, pid: w.pid };
    s.promise = acquireResources(w.opts({ pid: w.pid, ...o })).then((l) => { s.done = true; s.lease = l; return l; });
    return s;
  };
  w.tick = async () => {
    const g = w.gates.splice(0);
    for (const r of g) r();
    await new Promise((r) => { setImmediate(r); });
    await new Promise((r) => { setImmediate(r); });
  };
  w.clears = () => {
    try { return readFileSync(join(dir, 'clears.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  w.status = (o = {}) => resourceStatus(w.opts(o));
  w.done = () => rmSync(dir, { recursive: true, force: true });
  return w;
}

test('matching waiters go first, the others keep their order and are passed over', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const n1 = w.start({ resources: { r: 1 } });
    const m1 = w.start({ resources: { r: 1 }, group: 'train' });
    const n2 = w.start({ resources: { r: 1 } });
    const res = reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000, reason: 'release train' }));
    assert.equal(res.ok, true);
    holder.release();
    await w.tick();
    assert.equal(m1.done, true, 'the matching waiter is admitted first, ahead of two older non-matching ones');
    assert.equal(n1.done, false);
    assert.equal(n2.done, false);
    const q = w.status().queue;
    assert.deepEqual(q.map((e) => e.position), [1, 2], 'non-matching waiters keep their places');
    assert.equal(q[0].pid, n1.pid);
    assert.equal(q[0].passedOver, true);
    assert.ok(q[0].blockedBy.includes('r'));
    m1.lease.release();
    await w.tick();
    assert.equal(n1.done || n2.done, false, 'still reserved: nobody outside the group takes it');
    // The reservation lapses: the original order comes back, nobody is starved.
    w.t += H + 1;
    await w.tick();
    assert.equal(n1.done, true, 'the older waiter is admitted first once the reservation has expired');
    assert.equal(n2.done, false);
    n1.lease.release();
    await w.tick();
    assert.equal(n2.done, true);
    n2.lease.release();
  } finally { w.done(); }
});

test('a later matching waiter does not jump the matching ones ahead of it (FIFO inside the group)', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const a = w.start({ resources: { r: 1 }, group: 'train' });
    const b = w.start({ resources: { r: 1 }, group: 'train' });
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    holder.release();
    await w.tick();
    assert.equal(a.done, true);
    assert.equal(b.done, false);
    a.lease.release(); await w.tick();
    assert.equal(b.done, true);
    b.lease.release();
  } finally { w.done(); }
});

test('a reservation on one resource does not touch another, nor a waiter behind a passed-over one', async () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'a', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    const onlyB = await acquireResources(w.opts({ resources: { b: 1 }, pid: 899 }));
    assert.equal(onlyB.off, undefined);
    assert.ok(onlyB.id !== 'off', 'a request for another resource is granted at once');
    onlyB.release();
    // X wants a+b and is passed over for a; Y wants b only, queued behind X. Y must not wait on X.
    const x = w.start({ resources: { a: 1, b: 1 } });
    const y = w.start({ resources: { b: 1 } });
    await w.tick();
    assert.equal(x.done, false);
    assert.equal(y.done, true, 'a ticket that cannot be admitted for policy blocks nobody behind it');
    y.lease.release();
    const q = w.status().queue;
    assert.equal(q.length, 1);
    assert.equal(q[0].pid, x.pid);
    // The grouped request still gets a.
    const z = w.start({ resources: { a: 1 }, group: 'train' });
    await w.tick();
    assert.equal(z.done, true);
    z.lease.release();
    unreserveResource(w.opts({ resource: 'a' }));
    await w.tick();
    assert.equal(x.done, true);
    x.lease.release();
  } finally { w.done(); }
});

test('a reservation can be lifted by anyone and is logged; one for the waiter\'s own group never blocks it', async () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    const n = w.start({ resources: { r: 1 } });
    await w.tick();
    assert.equal(n.done, false);
    const r = unreserveResource(w.opts({ resource: 'r' }));
    assert.equal(r.removed.length, 1);
    await w.tick();
    assert.equal(n.done, true);
    n.lease.release();
    assert.deepEqual(w.clears().map((c) => c.rule), ['unreserved']);
    assert.equal(w.status().reservations.length, 0);
    const none = unreserveResource(w.opts({ resource: 'r' }));
    assert.deepEqual(none.removed, []);
  } finally { w.done(); }
});

test('reserving again for the same group on the same resource replaces the earlier one', () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + 2 * H, ownerPid: 5000 }));
    reserveResource(w.opts({ resource: 'r', forGroup: 'other', until: w.t + H, ownerPid: 5000 }));
    const rs = w.status().reservations;
    assert.equal(rs.length, 2);
    assert.equal(rs.find((r) => r.forGroup === 'train').expiresAt, w.t + 2 * H);
  } finally { w.done(); }
});

test('a reservation is cleared, and logged, when its time has passed', async () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + 600_000, ownerPid: 5000, ownerSession: 'sess-own', reason: 'rt' }));
    assert.equal(w.status().reservations.length, 1);
    w.t += 599_999;
    assert.equal(sweepLedger(w.opts()).length, 0);
    w.t += 2;
    const cleared = sweepLedger(w.opts());
    assert.deepEqual(cleared.map((c) => [c.type, c.why]), [['reservation', 'reservation-expired']]);
    assert.equal(w.status().reservations.length, 0);
    const c = w.clears().at(-1);
    assert.equal(c.rule, 'reservation-expired');
    assert.equal(c.type, 'reservation');
    assert.equal(c.session, 'sess-own');
    assert.equal(c.evidence.forGroup, 'train');
    assert.deepEqual(readdirSync(w.dir).filter((n) => n.startsWith('reservation-')), []);
  } finally { w.done(); }
});

test('a reservation is cleared, and logged, when its owner is gone', async () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    const n = w.start({ resources: { r: 1 } });
    await w.tick();
    assert.equal(n.done, false, 'reserved while the owner lives');
    w.dead.add(5000);
    await w.tick(); // the waiter's own poll runs the sweep
    assert.equal(n.done, true, 'the owner is gone: the waiter is not held up');
    assert.equal(w.clears().at(-1).rule, 'reservation-owner-gone');
    assert.equal(w.clears().at(-1).pid, 5000);
    n.lease.release();
  } finally { w.done(); }
});

test('the expiry is required and capped at 4 hours', () => {
  const w = world();
  try {
    assert.equal(MAX_RESERVATION_MS, 4 * H);
    const noUntil = reserveResource(w.opts({ resource: 'r', forGroup: 'train' }));
    assert.equal(noUntil.ok, false);
    assert.match(noUntil.error, /expiry is required/);
    assert.equal(reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t - 1 })).ok, false);
    assert.equal(reserveResource(w.opts({ resource: 'r', forGroup: '', until: w.t + H })).ok, false, 'a reservation names who it is for');
    assert.equal(reserveResource(w.opts({ resource: 'bad name', forGroup: 'g', until: w.t + H })).ok, false);
    const long = reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + 10 * H, ownerPid: 5000 }));
    assert.equal(long.ok, true);
    assert.equal(long.clamped, true);
    assert.equal(long.reservation.expiresAt, w.t + 4 * H);
    assert.equal(w.status().reservations[0].expiresAt, w.t + 4 * H);
    w.t += 4 * H;
    assert.equal(sweepLedger(w.opts()).length, 1, 'gone at exactly 4 h');
  } finally { w.done(); }
});

test('a hand-written reservation cannot outlast 4 h or lack an expiry', () => {
  const w = world();
  try {
    const created = w.t;
    writeFileSync(join(w.dir, 'reservation-aaaa11' + '112222.json'), JSON.stringify({
      id: 'aaaa11' + '112222', resource: 'r', forGroup: 'train', owner: { pid: 0, session: '' }, createdAt: created, expiresAt: created + 100 * H,
    }));
    writeFileSync(join(w.dir, 'reservation-bbbb11' + '112222.json'), JSON.stringify({
      id: 'bbbb11' + '112222', resource: 'r', forGroup: 'train2', owner: { pid: 0, session: '' }, createdAt: created,
    }));
    const st = w.status();
    assert.deepEqual(st.reservations.map((r) => r.id), ['aaaa11' + '112222'], 'no expiry: not a reservation');
    assert.equal(st.reservations[0].expiresAt, created + 4 * H, 'status shows the capped end');
    const cleared = sweepLedger(w.opts());
    assert.deepEqual(cleared.map((c) => c.why), ['reservation-invalid']);
    w.t += 4 * H + 1;
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-expired']);
  } finally { w.done(); }
});

test('hold pauses my queued entries, keeps their place, and affects nobody else', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const a = w.start({ resources: { r: 1 }, session: 'sess-a' });
    const b = w.start({ resources: { r: 1 }, session: 'sess-b' });
    const held = holdMine(w.opts({ session: 'sess-a' }));
    assert.equal(held.ok, true);
    assert.equal(held.ids.length, 1);
    let q = w.status().queue;
    assert.equal(q[0].paused, true);
    assert.equal(q[0].pausedBy, 'sess-a');
    assert.equal(q[1].paused, false);
    assert.match(formatResourceStatus(w.status()), /PAUSED/);
    holder.release();
    await w.tick();
    assert.equal(a.done, false, 'the paused entry is passed over');
    assert.equal(b.done, true, 'the other session goes ahead');
    assert.equal(w.status().queue[0].position, 1, 'the paused entry keeps its place');
    b.lease.release();
    await w.tick();
    assert.equal(a.done, false, 'still paused while the resource is free');
    const back = resumeMine(w.opts({ session: 'sess-a' }));
    assert.equal(back.ids.length, 1);
    await w.tick();
    assert.equal(a.done, true);
    a.lease.release();
    assert.deepEqual(readdirSync(w.dir).filter((n) => n.endsWith('.paused')), [], 'no hold left behind');
  } finally { w.done(); }
});

test('hold only touches the caller\'s session, needs a session, and ends by itself within 4 hours', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const none = w.start({ resources: { r: 1 } }); // no session recorded
    const b = w.start({ resources: { r: 1 }, session: 'sess-b' });
    assert.equal(holdMine(w.opts({ session: '' })).ok, false, 'no session: nothing to match "mine" against');
    assert.deepEqual(holdMine(w.opts({ session: 'sess-other' })).ids, []);
    assert.equal(w.status().queue.every((e) => !e.paused), true);
    assert.deepEqual(holdMine(w.opts({ session: 'sess-b', until: w.t + 100 * H })).ids.length, 1);
    assert.ok(w.status().queue[1].pausedUntil <= w.t + 4 * H, 'a hold is capped at 4 h');
    holder.release();
    await w.tick();
    assert.equal(none.done, true);
    none.lease.release();
    await w.tick();
    assert.equal(b.done, false);
    w.t += 4 * H + 1;
    await w.tick();
    assert.equal(b.done, true, 'the hold lapsed: no entry is held for ever');
    b.lease.release();
  } finally { w.done(); }
});

test('a paused entry ahead does not block those behind it, and a hold dies with its ticket', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const a = w.start({ resources: { r: 1 }, session: 'sess-a' });
    holdMine(w.opts({ session: 'sess-a' }));
    const c = w.start({ resources: { r: 1 } });
    holder.release();
    await w.tick();
    assert.equal(c.done, true);
    c.lease.release();
    w.dead.add(a.pid); // the paused requester dies: the sweep removes ticket and hold
    sweepLedger(w.opts());
    assert.deepEqual(readdirSync(w.dir).filter((n) => /^ticket-/.test(n)), []);
  } finally { w.done(); }
});

test('a held or passed-over entry waits past the bounded wait; an ordinary one goes over budget', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    const logs = [];
    const plain = w.start({ resources: { r: 1 }, maxWaitMs: 120_000, log: (l) => logs.push(l) });
    reserveResource(w.opts({ resource: 'q', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    const passed = w.start({ resources: { q: 1 }, maxWaitMs: 120_000 });
    w.t += 10 * 60_000;
    await w.tick();
    assert.equal(plain.done, true, 'an ordinary wait still ends over budget after the bound');
    assert.ok(logs.some((l) => /over budget/.test(l)));
    assert.equal(passed.done, false, 'a reservation is honored past the bound');
    plain.lease.release(); holder.release();
    unreserveResource(w.opts({ resource: 'q' }));
    await w.tick();
    assert.equal(passed.done, true);
    passed.lease.release();
  } finally { w.done(); }
});

test('nothing makes every waiter stop: a yield file is not read, and a group reservation spares other resources', async () => {
  const w = world();
  try {
    const rules = { ...NO_RULES, legacyLocks: [{ resource: 'r', dir: join(w.dir, 'old.lock'), yieldFile: 'e2e.yield' }] };
    writeFileSync(join(w.dir, 'e2e.yield'), 'go first');
    const n = w.start({ resources: { r: 1 }, rules });
    await w.tick();
    assert.equal(n.done, true, 'the global yield file of the 2026-10 incident blocks nobody');
    n.lease.release();
    // Even the widest reservation (the box) is for one group, one resource, and ends.
    reserveResource(w.opts({ resource: 'box', forGroup: 'train', until: w.t + H, ownerPid: 5000 }));
    const named = w.start({ resources: { other: 1 } });
    await w.tick();
    assert.equal(named.done, true, 'a request that does not use the box is untouched');
    named.lease.release();
    const boxed = w.start({ box: 2 });
    await w.tick();
    assert.equal(boxed.done, false);
    const grouped = w.start({ box: 2, group: 'train' });
    await w.tick();
    assert.equal(grouped.done, true);
    grouped.lease.release();
    w.t += H + 1;
    await w.tick();
    assert.equal(boxed.done, true, 'and it ends');
    boxed.lease.release();
  } finally { w.done(); }
});

test('a pid-bound lease lives as long as that pid, not the wrapper, and is released when it dies', async () => {
  const w = world();
  try {
    const lease = await acquireResources(w.opts({ resources: { 'android-emu': 1 }, pid: 901, bindPid: 777, label: 'emulator' }));
    assert.equal(lease.bound, true);
    assert.equal(lease.boundPid, 777);
    const rec = JSON.parse(readFileSync(lease.file, 'utf8'));
    assert.equal(rec.pid, 777);
    assert.equal(rec.boundPid, 777);
    assert.equal(rec.wrapperPid, 901);
    w.dead.add(901); // the wrapper is gone; the daemon is not
    w.t += 3 * H; // no heartbeat for hours: a bound lease has none to expire
    const st = w.status().resources.find((r) => r.name === 'android-emu');
    assert.equal(st.held, 1);
    assert.equal(st.holders[0].bound, true);
    assert.equal(st.holders[0].boundPid, 777);
    assert.equal(st.holders[0].alive, true);
    const waiter = w.start({ resources: { 'android-emu': 1 } });
    await w.tick();
    assert.equal(waiter.done, false, 'held while the daemon lives');
    w.dead.add(777);
    await w.tick();
    assert.equal(waiter.done, true, 'released when the bound pid dies');
    const c = w.clears().find((x) => x.type === 'lease');
    assert.equal(c.rule, 'pid-dead');
    assert.equal(c.pid, 777);
    waiter.lease.release();
  } finally { w.done(); }
});

test('max-hold on a live bound pid of an exclusive resource flags it over time and keeps it; a dead one is cleared at once; the process is never touched', async () => {
  const w = world();
  try {
    const rules = {
      ...NO_RULES, resources: { 'android-emu': { capacity: 1, maxHoldMs: 3600_000 } },
      rules: [{ id: 'max-hold', enabled: true, appliesTo: ['run'] }],
    };
    const lease = await acquireResources(w.opts({ resources: { 'android-emu': 1 }, bindPid: 777, rules }));
    assert.equal(lease.bound, true);
    w.t += 59 * 60_000;
    assert.equal(sweepLedger(w.opts({ rules })).length, 0);
    w.t += 2 * 60_000;
    assert.equal(sweepLedger(w.opts({ rules })).length, 0, 'live and unmeasured: kept');
    const h = resourceStatus(w.opts({ rules })).resources.find((r) => r.name === 'android-emu').holders[0];
    assert.equal(h.overTime.activity, 'unknown');
    assert.equal(w.dead.has(777), false, 'the bound process is never signaled');
    w.dead.add(777); // the emulator exits
    const cleared = sweepLedger(w.opts({ rules }));
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].why, 'process is gone');
    assert.equal(w.clears().at(-1).rule, 'pid-dead');
  } finally { w.done(); }
});

test('a bound pid that is already gone at the grant gives a lease the wrapper owns', async () => {
  const w = world();
  try {
    const logs = [];
    w.dead.add(777);
    const lease = await acquireResources(w.opts({ resources: { r: 1 }, bindPid: 777, log: (l) => logs.push(l) }));
    assert.notEqual(lease.bound, true);
    assert.ok(logs.some((l) => /bound pid 777 is not running/.test(l)));
    lease.release();
  } finally { w.done(); }
});

test('records and tickets from before these fields still read', async () => {
  const w = world();
  try {
    const t0 = w.t;
    writeFileSync(join(w.dir, 'lease-0a0a0a' + '0a0a0a.json'), JSON.stringify({
      id: '0a0a0a' + '0a0a0a', pid: 4321, startedAt: t0 - 1000, heartbeatAt: t0, repo: 'old', worktree: '/old', kind: 'full', units: 2, heavy: 0, heavyCost: 3, label: 'ci-local',
    }));
    writeFileSync(join(w.dir, 'ticket-0b0b0b' + '0b0b0b.json'), JSON.stringify({
      id: '0b0b0b' + '0b0b0b', pid: 4322, createdAt: t0 - 500, heartbeatAt: t0, repo: 'old', worktree: '/old2', desired: 4,
    }));
    const st = w.status();
    assert.equal(st.ok, true);
    const box = st.resources.find((r) => r.name === 'box');
    assert.equal(box.held, 2);
    assert.equal(box.holders[0].group, '');
    assert.equal(box.holders[0].bound, false);
    assert.equal(st.queue.length, 1);
    assert.equal(st.queue[0].paused, false);
    assert.equal(st.queue[0].group, '');
    assert.deepEqual(st.reservations, []);
    // The old lease still counts, the old ticket still queues; a new grouped request sits behind it.
    const n = w.start({ box: 8 });
    await w.tick();
    assert.equal(n.done, false);
    assert.equal(w.status().queue.length, 2);
    // A reservation file that is not valid JSON is ignored, never a block.
    writeFileSync(join(w.dir, 'reservation-cccc11' + '112222.json'), '{not json');
    assert.deepEqual(w.status().reservations, []);
    n.promise.catch(() => {});
  } finally { w.done(); }
});

test('status --json carries reservations, group, hold and bound fields; schema stays v1', () => {
  const w = world();
  try {
    reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + H, ownerPid: 5000, ownerSession: 'sess-own', reason: 'rt' }));
    const st = w.status();
    assert.equal(st.schemaVersion, 1);
    assert.deepEqual(Object.keys(st.reservations[0]).sort(), [
      'createdAt', 'expiresAt', 'forGroup', 'id', 'owner', 'ownerAlive', 'reason', 'remainingMs', 'resource',
    ]);
    assert.deepEqual(st.reservations[0].owner, { pid: 5000, session: 'sess-own' });
    assert.equal(st.reservations[0].remainingMs, H);
    assert.match(formatResourceStatus(st), /Reservations \(1\)/);
  } finally { w.done(); }
});

test('parseUntil: durations, clock times, ISO, epoch ms', () => {
  const now = Date.UTC(2026, 9, 17, 10, 0, 0);
  assert.equal(parseUntil('90m', now), now + 90 * 60_000);
  assert.equal(parseUntil('2h', now), now + 2 * H);
  assert.equal(parseUntil('1h30m', now), now + 90 * 60_000);
  assert.equal(parseUntil('45s', now), now + 45_000);
  assert.equal(parseUntil('2026-10-17T12:00:00Z', now), Date.UTC(2026, 9, 17, 12));
  assert.equal(parseUntil(String(now + 5000), now), now + 5000);
  const hhmm = parseUntil('14:30', now);
  assert.ok(hhmm > now && hhmm <= now + 24 * H);
  for (const bad of ['', 'soon', '30', 'tomorrow', '12']) assert.equal(parseUntil(bad, now), null, `"${bad}"`);
});

test('CLI: reserve needs --for and --until, caps at 4 h, unreserve lifts, hold and resume need a session', async () => {
  const w = world();
  try {
    const out = []; const err = [];
    const run = (argv, env = {}) => {
      const ledger = w.opts({ env });
      if (env.CLAUDE_CODE_SESSION_ID) ledger.session = env.CLAUDE_CODE_SESSION_ID; else delete ledger.session;
      return cli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, rules: NO_RULES, ledger });
    };
    assert.equal(await run(['reserve', 'r', '--until', '1h']), 2);
    assert.match(err.join('\n'), /names who it is for/);
    err.length = 0;
    assert.equal(await run(['reserve', 'r', '--for', 'train']), 2);
    assert.match(err.join('\n'), /--until/);
    err.length = 0;
    assert.equal(await run(['reserve', 'r', '--for', 'train', '--until', 'whenever']), 2);
    err.length = 0;
    assert.equal(await run(['reserve', 'r', '--for', 'train', '--until', '9h', '--reason', 'release train', '--owner-pid', '5000']), 0);
    assert.match(out.at(-1), /capped at 4 h/);
    const rs = w.status().reservations;
    assert.equal(rs.length, 1);
    assert.equal(rs[0].reason, 'release train');
    assert.equal(rs[0].remainingMs, 4 * H);
    assert.equal(await run(['unreserve', 'r']), 0);
    assert.match(out.at(-1), /lifted 1 reservation/);
    assert.equal(await run(['unreserve', 'r']), 0);
    assert.match(out.at(-1), /no reservation/);
    assert.equal(await run(['hold']), 2, 'no session id in the environment');
    assert.equal(await run(['hold'], { CLAUDE_CODE_SESSION_ID: 's1' }), 0);
    assert.match(out.at(-1), /held 0 of your queued entries/);
    assert.equal(await run(['resume'], { CLAUDE_CODE_SESSION_ID: 's1' }), 0);
    assert.equal(await run(['run', '--resource', 'x', '--bind-pid', 'abc']), 2);
    assert.equal(await run(['run', '--resource', 'x', '--group', 'bad group', '--', 'echo']), 2);
    assert.equal(await run(['run', '--resource', 'x']), 2, 'a command, or --bind-pid');
  } finally { w.done(); }
});

test('CLI: run --bind-pid with no command takes the lease for a running pid and exits', async () => {
  const w = world();
  try {
    const out = []; const err = [];
    const code = await cli(['run', '--resource', 'android-emu', '--bind-pid', '777', '--label', 'avd'], {
      out: (l) => out.push(l), err: (l) => err.push(l), env: {}, rules: NO_RULES, ledger: w.opts({ pid: 901 }),
    });
    assert.equal(code, 0);
    assert.match(err.join('\n'), /held by lease [0-9a-f]+ for as long as pid 777 runs/);
    const h = w.status().resources.find((r) => r.name === 'android-emu').holders[0];
    assert.equal(h.boundPid, 777);
    assert.equal(h.label, 'avd');
    assert.deepEqual(readdirSync(w.dir).filter((n) => /^ticket-/.test(n)), []);
  } finally { w.done(); }
});

