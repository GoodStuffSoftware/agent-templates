// Use-it-or-lose-it for reservations: a reservation lapses when no job of its group has
// held or waited for the resource for reservationIdleLapseMinutes (default 20; 0 = off).
// Every test runs in a temp ledger with a fake clock and fake liveness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import './isolate.mjs';
import { acquireResources, resourceStatus, reserveResource, sweepLedger } from '../scripts/ci-budget.mjs';
import { loadRules } from '../scripts/lib/resource-rules.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const rulesWith = (extra = {}) => ({ version: 1, resources: {}, classes: [], rules: [], ...extra });

function world(rules = rulesWith()) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-lapse-'));
  const w = { dir, t: 1_700_000_000_000, dead: new Set(), gates: [], pid: 900 };
  w.now = () => w.t;
  w.delay = () => new Promise((r) => { w.gates.push(r); });
  w.opts = (o = {}) => ({
    dir, now: w.now, delay: w.delay, sleep: () => {}, isAlive: (p) => !w.dead.has(p), sampler: () => 0,
    budget: 8, cores: 8, staleMs: 1e12, rules, env: {}, legacyDir: join(dir, 'legacy'), log: () => {},
    registerExit: false, heartbeat: 'off', session: '', project: 'p', repo: 'r', worktree: dir,
    freemem: () => 64 * 1024 ** 3, totalmem: () => 64 * 1024 ** 3, ...o,
  });
  w.start = (o = {}) => {
    w.t += 10;
    w.pid += 1;
    const s = { done: false, lease: null, pid: w.pid };
    s.promise = acquireResources(w.opts({ pid: w.pid, ...o })).then((l) => { s.done = true; s.lease = l; return l; });
    return s;
  };
  w.tick = async () => {
    for (const r of w.gates.splice(0)) r();
    await new Promise((r) => { setImmediate(r); });
    await new Promise((r) => { setImmediate(r); });
  };
  w.clears = () => {
    try { return readFileSync(join(dir, 'clears.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  w.reserve = (o = {}) => reserveResource(w.opts({ resource: 'r', forGroup: 'train', until: w.t + 4 * H, ownerPid: 0, ...o }));
  w.reservations = () => resourceStatus(w.opts()).reservations;
  w.done = () => rmSync(dir, { recursive: true, force: true });
  return w;
}

test('the shipped default is 20 minutes', () => {
  assert.equal(loadRules({}).reservationIdleLapseMinutes, 20);
});

test('a reservation lapses after the idle time with no matching job, and the lapse is logged', () => {
  const w = world();
  try {
    w.reserve({ ownerSession: 'sess-own', reason: 'rt' });
    w.t += 19 * MIN;
    assert.deepEqual(sweepLedger(w.opts()), []);
    assert.equal(w.reservations().length, 1);
    w.t += 2 * MIN;
    const cleared = sweepLedger(w.opts());
    assert.deepEqual(cleared.map((c) => [c.type, c.why]), [['reservation', 'reservation-idle-lapse']]);
    assert.equal(w.reservations().length, 0);
    const c = w.clears().at(-1);
    assert.equal(c.rule, 'reservation-idle-lapse');
    assert.equal(c.type, 'reservation');
    assert.equal(c.session, 'sess-own');
    assert.equal(c.evidence.forGroup, 'train');
    assert.equal(c.evidence.idleMinutes, 21);
    assert.equal(c.evidence.lapseMinutes, 20);
    assert.equal(c.evidence.lastMatchAt, c.evidence.createdAt, 'no matching job ever: counted from creation');
    assert.deepEqual(readdirSync(w.dir).filter((n) => n.startsWith('reservation-')), []);
    assert.ok(resourceStatus(w.opts()).recentClears.some((x) => x.rule === 'reservation-idle-lapse'), 'shows in recent clears');
  } finally { w.done(); }
});

test('the idle time is configurable', () => {
  const w = world(rulesWith({ reservationIdleLapseMinutes: 5 }));
  try {
    w.reserve();
    w.t += 6 * MIN;
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-idle-lapse']);
  } finally { w.done(); }
});

test('a matching waiter keeps the reservation alive; the clock runs from when it is gone', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 })); // no group
    w.reserve();
    const waiter = w.start({ resources: { r: 1 }, group: 'train' });
    await w.tick();
    assert.equal(waiter.done, false);
    for (let i = 0; i < 4; i += 1) {
      w.t += 30 * MIN;
      sweepLedger(w.opts());
      assert.equal(w.reservations().length, 1, 'alive while the matching waiter is queued');
    }
    w.dead.add(waiter.pid);
    sweepLedger(w.opts()); // finds the ticket gone; the last sighting was just before
    w.t += 19 * MIN;
    assert.deepEqual(sweepLedger(w.opts()), []);
    assert.equal(w.reservations().length, 1);
    w.t += 3 * MIN;
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-idle-lapse']);
    holder.release();
  } finally { w.done(); }
});

test('a waiter of another group does not keep it alive', async () => {
  const w = world();
  try {
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, pid: 899 }));
    w.reserve();
    w.start({ resources: { r: 1 }, group: 'other' });
    await w.tick();
    w.t += 21 * MIN;
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-idle-lapse']);
    holder.release();
  } finally { w.done(); }
});

test('a matching holder keeps it alive, and the idle clock restarts at its release', async () => {
  const w = world();
  try {
    w.reserve();
    const holder = await acquireResources(w.opts({ resources: { r: 1 }, group: 'train', pid: 899 }));
    for (let i = 0; i < 3; i += 1) {
      w.t += 30 * MIN; // 90 min held
      sweepLedger(w.opts());
      assert.equal(w.reservations().length, 1, 'alive while held');
    }
    w.t += 10 * MIN; // no sweep in between: only the release time counts
    holder.release();
    const releasedAt = w.t;
    w.t += 19 * MIN;
    assert.deepEqual(sweepLedger(w.opts()), []);
    assert.equal(w.reservations().length, 1, 'idle clock counts from the release, not from creation');
    w.t += 2 * MIN;
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-idle-lapse']);
    assert.equal(w.clears().at(-1).evidence.lastMatchAt, releasedAt);
  } finally { w.done(); }
});

test('0 turns the lapse off', () => {
  const w = world(rulesWith({ reservationIdleLapseMinutes: 0 }));
  try {
    w.reserve();
    w.t += 3 * H;
    assert.deepEqual(sweepLedger(w.opts()), []);
    assert.equal(w.reservations().length, 1);
  } finally { w.done(); }
});

test('the 4 h cap and the expiry still work', () => {
  const off = world(rulesWith({ reservationIdleLapseMinutes: 0 }));
  try {
    const r = off.reserve({ until: off.t + 100 * H });
    assert.equal(r.clamped, true);
    off.t += 4 * H - 1;
    assert.deepEqual(sweepLedger(off.opts()), []);
    off.t += 2;
    assert.deepEqual(sweepLedger(off.opts()).map((c) => c.why), ['reservation-expired']);
    assert.equal(off.clears().at(-1).rule, 'reservation-expired');
  } finally { off.done(); }
  const w = world();
  try {
    w.reserve({ until: w.t + 10 * MIN });
    w.t += 10 * MIN + 1; // expires before the 20 min idle time
    assert.deepEqual(sweepLedger(w.opts()).map((c) => c.why), ['reservation-expired']);
  } finally { w.done(); }
});
