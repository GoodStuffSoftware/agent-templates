// resourceStatus(): the schema-v1 status object that hooks and `status --json` read. It must stay
// cheap (no cpu sampling, no spawned process unless asked) and must never throw. The key sets
// below are the contract in docs/resource-queue.md ("status --json schema"); a change to them is
// a schema change.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resourceStatus, formatResourceStatus, STATUS_SCHEMA_VERSION } from '../scripts/ci-budget.mjs';
import { makeWorld, settle } from './resource-queue-world.mjs';

const keys = (o) => Object.keys(o).sort();

const TOP = ['dir', 'generatedAt', 'legacyLocks', 'machine', 'ok', 'queue', 'recentClears', 'reservations', 'resources', 'schema', 'schemaVersion', 'strays'];
const MACHINE = ['busyCores', 'cores', 'externalCores', 'freeRamMb', 'loaded', 'ramReserveMb', 'totalRamMb'];
const RESOURCE = ['capacity', 'free', 'held', 'holders', 'name'];
const HOLDER = [
  'ageMs', 'alive', 'bound', 'boundPid', 'group', 'heartbeatAgeMs', 'heartbeatAt', 'id', 'idleMs', 'kind', 'label', 'lastActivityAt', 'overTime', 'pid', 'project', 'ramMb',
  'repo', 'session', 'stale', 'startedAt', 'units', 'worktree',
];
const QUEUE = [
  'alive', 'blockedBy', 'createdAt', 'group', 'heartbeatAt', 'id', 'kind', 'label', 'passedOver', 'paused', 'pausedBy', 'pausedUntil', 'pid', 'position', 'project', 'ramMb', 'repo', 'session',
  'waitedMs', 'wants', 'worktree',
];
const CLEAR = ['at', 'evidence', 'id', 'label', 'pid', 'project', 'repo', 'resources', 'rule', 'session', 'type', 'worktree'];

test('status schema v1: the key set of every level, filled from a busy ledger', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    const held = await w.acq({
      box: 2, resources: { 'app-e2e': 1 }, ramMb: 3000, label: 'holder', project: 'proj-a', session: 'sess-1',
      limits: { idleMs: 300_000 }, monitored: true,
    });
    held.recordActivity(w.t, w.t - 5000);
    // a cleared lease, to fill recentClears
    const gone = await w.acq({ pid: 777, resources: { pool: 1 }, label: 'gone' });
    w.dead.add(777);
    // a waiter: snapshot while it is queued
    let snap = null;
    const waiter = await w.acq({
      resources: { 'app-e2e': 1 }, label: 'waiter', project: 'proj-b',
      delay: async (ms) => { w.t += ms; snap ??= resourceStatus({ ...w.opts }); held.release(); },
    });
    assert.ok(gone);

    assert.deepEqual(keys(snap), TOP);
    assert.equal(snap.schema, 'resource-queue-status');
    assert.equal(snap.schemaVersion, STATUS_SCHEMA_VERSION);
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.ok, true);
    assert.equal(typeof snap.generatedAt, 'number');
    assert.equal(snap.dir, w.dir);
    assert.deepEqual(keys(snap.machine), MACHINE);
    assert.equal(snap.machine.totalRamMb, 65536);
    assert.equal(snap.machine.freeRamMb, 49152);
    assert.equal(snap.machine.ramReserveMb, 1000);
    assert.equal(snap.machine.busyCores, null, 'not sampled by default');
    assert.equal(snap.machine.externalCores, null);
    assert.equal(snap.machine.loaded, null);

    assert.deepEqual(snap.resources.map((r) => r.name), ['box', 'app-e2e', 'pool']);
    for (const r of snap.resources) assert.deepEqual(keys(r), RESOURCE);
    const box = snap.resources[0];
    assert.equal(box.capacity, 8);
    assert.equal(box.held, 2);
    assert.equal(box.free, 6);
    const e2e = snap.resources[1];
    assert.equal(e2e.capacity, 1);
    assert.equal(e2e.held, 1);
    assert.equal(e2e.free, 0);
    const h = e2e.holders[0];
    assert.deepEqual(keys(h), HOLDER);
    assert.equal(h.kind, 'run');
    assert.equal(h.label, 'holder');
    assert.equal(h.project, 'proj-a');
    assert.equal(h.session, 'sess-1');
    assert.equal(h.units, 1);
    assert.equal(h.ramMb, 3000);
    assert.equal(h.alive, true);
    assert.equal(h.stale, null);
    assert.equal(h.idleMs, 5000 + 1500, 'the activity sidecar feeds idleMs (5 s idle at the sample, one poll later)');
    assert.equal(typeof h.lastActivityAt, 'number');
    for (const k of ['startedAt', 'heartbeatAt', 'ageMs', 'heartbeatAgeMs']) assert.equal(typeof h[k], 'number', k);

    assert.equal(snap.queue.length, 1);
    const q = snap.queue[0];
    assert.deepEqual(keys(q), QUEUE);
    assert.equal(q.position, 1);
    assert.equal(q.label, 'waiter');
    assert.equal(q.project, 'proj-b');
    assert.deepEqual(q.wants, { 'app-e2e': 1 });
    assert.deepEqual(q.blockedBy, ['app-e2e']);
    assert.equal(q.alive, true);

    assert.equal(snap.recentClears.length, 1);
    assert.deepEqual(keys(snap.recentClears[0]), CLEAR);
    assert.equal(snap.recentClears[0].rule, 'pid-dead');
    assert.equal(snap.recentClears[0].label, 'gone');
    assert.deepEqual(snap.legacyLocks, []);
    assert.equal(snap.strays, null, 'strays are scanned only on request');
    waiter.release();
  } finally { w.done(); }
});

test('status lists a stale holder with its reason, and the text form flags it', async () => {
  const w = makeWorld();
  try {
    await w.acq({ pid: 31337, box: 3, resources: { 'app-e2e': 1 }, label: 'zombie' });
    w.dead.add(31337);
    const st = resourceStatus({ ...w.opts });
    const h = st.resources.find((r) => r.name === 'app-e2e').holders[0];
    assert.equal(h.stale, 'process is gone');
    assert.equal(h.alive, false);
    assert.equal(st.resources.find((r) => r.name === 'box').holders[0].stale, 'process is gone');
    assert.equal(w.leases().length, 1, 'status reads only: the stale lease is still on disk');
    const text = formatResourceStatus(st);
    assert.match(text, /STALE \(process is gone\)/);
    assert.match(text, /PID DEAD/);
    assert.match(text, /app-e2e: 0\/1 held, 1 free/, 'a stale holder does not count as held');
  } finally { w.done(); }
});

test('status does no cpu sampling and spawns nothing unless asked', async () => {
  const w = makeWorld();
  try {
    let sampled = 0;
    const sampler = () => { sampled += 1; return 3; };
    await w.acq({ box: 1, label: 'x' });
    const plain = resourceStatus({ ...w.opts, sampler });
    assert.equal(sampled, 0, 'the default call never touches the sampler');
    assert.equal(plain.machine.busyCores, null);
    const withCpu = resourceStatus({ ...w.opts, sampler, sample: true });
    assert.equal(sampled, 1);
    assert.equal(withCpu.machine.busyCores, 3);
    assert.equal(withCpu.machine.externalCores, 2, 'busy 3 minus 1 held');
    assert.equal(withCpu.machine.loaded, false);
    // a throwing sampler on request is swallowed
    const bad = resourceStatus({ ...w.opts, sampler: () => { throw new Error('no cpu'); }, sample: true });
    assert.equal(bad.ok, true);
    assert.equal(bad.machine.busyCores, null);
  } finally { w.done(); }
});

test('status never throws: a failing clock, RAM probe, directory or garbage in the ledger still returns an object', async () => {
  const w = makeWorld();
  try {
    const boom = () => { throw new Error('boom'); };
    for (const over of [{ freemem: boom }, { totalmem: boom }, { now: boom }]) {
      const st = resourceStatus({ ...w.opts, ...over });
      assert.equal(st.ok, false);
      assert.equal(st.error, 'boom');
      assert.equal(st.schemaVersion, 1);
      assert.deepEqual(keys(st), [...TOP, 'error'].sort(), 'the failure shape has the same top-level keys plus error');
      assert.deepEqual(st.resources, []);
      assert.deepEqual(st.queue, []);
      assert.ok(formatResourceStatus(st).includes('unavailable'));
    }
    // a directory that is a file, one that does not exist, garbage files, hostile options
    const notDir = join(w.dir, 'plain-file');
    writeFileSync(notDir, 'x');
    for (const dir of [notDir, join(w.dir, 'nope', 'deeper')]) {
      const st = resourceStatus({ ...w.opts, dir });
      assert.equal(st.ok, true);
      assert.equal(st.resources[0].name, 'box');
      assert.equal(st.resources[0].held, 0);
    }
    writeFileSync(join(w.dir, 'lease-abcdef' + '123456.json'), '{ not json');
    writeFileSync(join(w.dir, 'ticket-abcdef' + '123456.json'), '[]');
    writeFileSync(join(w.dir, 'lease-012345' + '6789ab.json'), JSON.stringify({ pid: 'x', units: 'many', resources: { 'bad name': 'z', pool: -1 }, ramMb: 'lots' }));
    writeFileSync(join(w.dir, 'clears.jsonl'), 'torn line\n{"at":');
    const odd = resourceStatus({ ...w.opts, rules: { resources: 5, ram: 'x', legacyLocks: [null, { resource: 'r' }] } });
    assert.equal(typeof odd.ok, 'boolean');
    assert.doesNotThrow(() => formatResourceStatus(odd));
    mkdirSync(join(w.dir, 'subdir'));
    assert.doesNotThrow(() => resourceStatus({ env: null, dir: null }));
    assert.doesNotThrow(() => resourceStatus());
  } finally { w.done(); }
});

test('status shows an old-lock holder in the box as legacy and keeps the queue positions in order', async () => {
  const w = makeWorld({ budget: 8 });
  try {
    writeFileSync(join(w.legacy, 'slot-0.lock'), JSON.stringify({ pid: 4444, startedAt: w.t - 1000, worktree: 'old-wt' }));
    const st = resourceStatus({ ...w.opts });
    const legacy = st.resources[0].holders.find((x) => x.kind === 'legacy');
    assert.equal(legacy.pid, 4444);
    assert.equal(legacy.worktree, 'old-wt');
    assert.ok(st.resources[0].held >= 1, 'the old holder is charged to the box');

    const a = await w.acq({ resources: { 'app-e2e': 1 } });
    const waiters = [];
    for (const name of ['q1', 'q2', 'q3']) { waiters.push(w.acq({ resources: { 'app-e2e': 1 }, label: name })); w.t += 1; }
    await settle(3);
    const q = resourceStatus({ ...w.opts }).queue;
    assert.deepEqual(q.map((x) => [x.position, x.label]), [[1, 'q1'], [2, 'q2'], [3, 'q3']]);
    a.release();
    for (const p of waiters) (await p).release();
  } finally { w.done(); }
});
