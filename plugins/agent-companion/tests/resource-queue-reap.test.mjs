// Wiring of the reaper (scripts/lib/reaper.mjs) into the resource queue: tree tracking on a run lease, the reap at
// release, the orphan pass on sweep, policy off / dry-run, `resource-queue.mjs reap --dry-run`. Fake process table and
// fake kill only: no test here stops a real process or takes a real process snapshot. Spec: docs/resource-queue.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sweepLedger } from '../scripts/ci-budget.mjs';
import { runUnderQueue, cli, buildRequest } from '../scripts/resource-queue.mjs';
import { treeFile, reapsFile, parseWinJson, processSnapshot } from '../scripts/lib/reaper.mjs';
import { makeWorld } from './resource-queue-world.mjs';

const WRAPPER = 9000;
const row = (pid, ppid, name, ct, extra = {}) => ({ pid, ppid, name, exe: `C:\\fake\\${name}`, cmd: name, creationTime: ct, memMb: 10, ...extra });

/** A fake process table with a fake kill that removes the process; `rt` counts snapshots and kills. */
function fakeProcs(initial) {
  const rt = { rows: [...initial], snaps: 0, kills: [] };
  rt.reapSeams = {
    table: () => { rt.snaps += 1; return rt.rows.map((r) => ({ ...r })); },
    kill: (t) => { rt.kills.push(t.pid); rt.rows = rt.rows.filter((r) => r.pid !== t.pid); return { ok: true }; },
  };
  return rt;
}
const baseRows = () => [
  row(WRAPPER, 1, 'node.exe', 1000),
  row(9001, WRAPPER, 'node.exe', 2000),
  row(9002, 9001, 'conhost.exe', 2100),
];
const reapRows = (w) => (existsSync(reapsFile(w.dir)) ? readFileSync(reapsFile(w.dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const dirState = (dir) => readdirSync(dir).sort().map((n) => `${n}:${readFileSync(join(dir, n), 'utf8')}`).join('\n');

test('a lease released normally reaps its recorded tree, and a live descendant that was never recorded', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 2, label: 'run', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    assert.equal(lease.trackable, true);
    assert.ok(lease.track(), 'the tick records the tree');
    assert.ok(existsSync(treeFile(w.dir, lease.id)));
    rt.rows.push(row(9004, 9001, 'node.exe', 3000)); // started after the last tick
    lease.release();
    assert.deepEqual(rt.kills.sort(), [9001, 9002, 9004]);
    assert.equal(existsSync(treeFile(w.dir, lease.id)), false, 'a fully reaped tree file is removed');
    const rows = reapRows(w);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.mode === 'kill' && r.why === 'release' && r.lease === lease.id && r.ok === true));
    assert.deepEqual(rows.map((r) => r.how).sort(), ['descendant', 'recorded', 'recorded']);
    assert.ok(w.lines.some((l) => /stopped 3 leftover processes of lease/.test(l)), 'one stderr line from the wrapper');
  } finally { w.done(); }
});

test('children go before parents: the deepest process is stopped first', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    lease.track(); lease.release();
    assert.ok(rt.kills.indexOf(9002) < rt.kills.indexOf(9001));
  } finally { w.done(); }
});

test('a never-listed process inside the tree survives, and so does everything under it', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs([...baseRows(), row(9003, 9001, 'keepme-server.exe', 2200), row(9005, 9003, 'node.exe', 2300)]);
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on', never: 'keepme-server' }, reapSeams: rt.reapSeams });
    lease.track(); lease.release();
    assert.ok(!rt.kills.includes(9003), 'the never-listed process is not stopped');
    assert.ok(!rt.kills.includes(9005), 'nor what runs under it');
    assert.ok(rt.kills.includes(9002), 'the rest of the tree is');
    const spared = reapRows(w).filter((r) => r.pid === 9003);
    assert.equal(spared.length, 0, 'a spared process is not a kill row');
  } finally { w.done(); }
});

test('policy off: nothing is snapshotted, recorded or killed', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'off' }, reapSeams: rt.reapSeams });
    assert.equal(lease.trackable, false);
    assert.equal(lease.track(), null);
    lease.release();
    sweepLedger({ ...w.opts, reap: { policy: 'off' }, reapSeams: rt.reapSeams });
    assert.equal(rt.snaps, 0, 'the process table was never read');
    assert.deepEqual(rt.kills, []);
    assert.equal(w.files(/\.tree$/).length, 0);
    assert.equal(existsSync(reapsFile(w.dir)), false);
  } finally { w.done(); }
});

test('an unknown policy value is dry-run, never on', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'sure' }, reapSeams: rt.reapSeams });
    lease.track(); lease.release();
    assert.deepEqual(rt.kills, []);
    assert.ok(reapRows(w).every((r) => r.mode === 'would-kill'));
  } finally { w.done(); }
});

test('dry-run: reaps.jsonl gets the plan, nothing is killed, the tree file is kept and logs once', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'dry-run' }, reapSeams: rt.reapSeams });
    lease.track();
    lease.release();
    assert.deepEqual(rt.kills, []);
    const rows = reapRows(w);
    assert.deepEqual(rows.map((r) => r.pid).sort(), [9001, 9002]);
    assert.ok(rows.every((r) => r.mode === 'would-kill' && r.ok === null && r.why === 'release'));
    assert.ok(existsSync(treeFile(w.dir, lease.id)), 'kept so a later pass can still act once the policy is on');
    assert.equal(JSON.parse(readFileSync(treeFile(w.dir, lease.id), 'utf8')).dryLogged, true);
    // the wrapper is gone now; a sweep must not log the same plan again
    rt.rows = rt.rows.filter((r) => r.pid !== WRAPPER);
    sweepLedger({ ...w.opts, reap: { policy: 'dry-run' }, reapSeams: rt.reapSeams });
    assert.equal(reapRows(w).length, 2, 'no second would-kill rows');
    assert.deepEqual(rt.kills, []);
  } finally { w.done(); }
});

test('a lease whose holder died is reaped by the sweep', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 2, label: 'crashed', pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    lease.track();
    // the wrapper dies without releasing; its children keep running
    w.dead.add(WRAPPER);
    rt.rows = rt.rows.filter((r) => r.pid !== WRAPPER);
    const cleared = sweepLedger({ ...w.opts, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    assert.equal(cleared.filter((c) => c.type === 'lease').length, 1, 'the dead lease is reclaimed');
    assert.deepEqual(rt.kills.sort(), [9001, 9002]);
    const rows = reapRows(w);
    assert.ok(rows.every((r) => r.mode === 'kill' && r.why === 'sweep' && r.lease === lease.id));
    assert.equal(existsSync(treeFile(w.dir, lease.id)), false);
  } finally { w.done(); }
});

test('the sweep leaves the tree of a lease that still exists, and of a wrapper that still runs', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    lease.track();
    sweepLedger({ ...w.opts, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    assert.deepEqual(rt.kills, []);
    assert.equal(w.files(/\.tree$/).length, 1, 'the live lease keeps its tree file');
    lease.release();
    assert.ok(rt.kills.length > 0, 'a normal release still reaps');
  } finally { w.done(); }
});

test('a lease released by hand while its wrapper still runs is not an orphan: the sweep leaves its processes alone', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    lease.track();
    for (const f of w.files(/^lease-[0-9a-f]+\.json$/)) rmSync(join(w.dir, f)); // what `release <id>` does to the file
    sweepLedger({ ...w.opts, reap: { policy: 'on' }, reapSeams: rt.reapSeams }); // the wrapper row is still in the table
    assert.deepEqual(rt.kills, []);
    assert.ok(existsSync(treeFile(w.dir, lease.id)));
  } finally { w.done(); }
});

test('bound leases and non-run leases record nothing', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const bound = await w.acq({ box: 1, pid: WRAPPER, bindPid: 4242, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    assert.equal(bound.bound, true);
    assert.equal(bound.trackable, false);
    assert.equal(bound.track(), null);
    bound.release();
    assert.equal(rt.snaps, 0);
    assert.equal(w.files(/\.tree$/).length, 0);
  } finally { w.done(); }
});

test('reap --dry-run prints the plan, kills nothing and leaves the ledger directory byte-identical', async () => {
  const w = makeWorld();
  try {
    const rt = fakeProcs(baseRows());
    const lease = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt.reapSeams });
    lease.track();
    lease.release(); // reaps; so start again with a fresh tree for the orphan
    const rt2 = fakeProcs(baseRows());
    const l2 = await w.acq({ box: 1, pid: WRAPPER, reap: { policy: 'on' }, reapSeams: rt2.reapSeams });
    l2.track();
    w.dead.add(WRAPPER);
    rt2.rows = rt2.rows.filter((r) => r.pid !== WRAPPER);
    // reclaim the lease WITHOUT the orphan pass (policy off), so the tree file stays for the plan
    sweepLedger({ ...w.opts, reap: { policy: 'off' }, reapSeams: rt2.reapSeams });
    assert.ok(existsSync(treeFile(w.dir, l2.id)));
    const before = dirState(w.dir);
    const lines = []; const errs = [];
    const code = await cli(['reap', '--dry-run'], { env: w.opts.env, out: (l) => lines.push(l), err: (l) => errs.push(l), ledger: { ...w.opts, reap: { policy: 'on' }, reapSeams: rt2.reapSeams } });
    assert.equal(code, 0, errs.join('\n'));
    assert.deepEqual(rt2.kills, []);
    assert.equal(dirState(w.dir), before, 'nothing written');
    const text = lines.join('\n');
    assert.match(text, /would stop pid 9001 node\.exe/);
    assert.match(text, /would stop pid 9002 conhost\.exe/);
    assert.match(text, new RegExp(`lease ${l2.id}`));
    const json = [];
    await cli(['reap', '--dry-run', '--json'], { env: w.opts.env, out: (l) => json.push(l), err: () => {}, ledger: { ...w.opts, reap: { policy: 'on' }, reapSeams: rt2.reapSeams } });
    assert.equal(JSON.parse(json.join('\n')).entries[0].plan.targets.length, 2);
  } finally { w.done(); }
});

test('reap without --dry-run is a usage error that points to sweep', async () => {
  const w = makeWorld();
  try {
    const errs = [];
    const code = await cli(['reap'], { env: w.opts.env, out: () => {}, err: (l) => errs.push(l), ledger: w.opts });
    assert.equal(code, 2);
    assert.match(errs.join('\n'), /--dry-run.*sweep/);
  } finally { w.done(); }
});

test('buildRequest carries reapTree: true by default, false when the class says so', () => {
  const rules = { classes: [{ id: 'keep', box: 1, reapTree: false }, { id: 'norm', box: 1 }], resources: {}, rules: [] };
  assert.equal(buildRequest({ resources: [{ name: 'box', units: 1 }] }, rules).reapTree, true);
  assert.equal(buildRequest({ cls: 'norm' }, rules).reapTree, true);
  assert.equal(buildRequest({ cls: 'keep' }, rules).reapTree, false);
});

test('runUnderQueue runs the tracking timer for a run lease, not when the class opts out', async () => {
  const mk = () => {
    const calls = { track: 0, released: false };
    const lease = {
      id: 'fake-lease', dir: '', trackable: true, bound: false, off: false, cleared: false,
      get released() { return calls.released; }, track() { calls.track += 1; }, release() { calls.released = true; }, checkCleared() { return false; },
    };
    return { calls, lease };
  };
  const run = async (reapTree) => {
    const { calls, lease } = mk();
    let child = null;
    const track = lease.track;
    // The child ends once the timer has ticked twice (or after 5 s): no dependence on how loaded the machine is.
    lease.track = () => { track(); if (calls.track >= 2) setImmediate(() => child.emit('exit', 0, null)); };
    const io = {
      env: { RESOURCE_QUEUE: '', CI_LOCAL_LOCK: '' }, err: () => {}, acquire: async () => lease,
      spawn: () => { const c = new EventEmitter(); c.pid = 5; c.kill = () => {}; child = c; setTimeout(() => c.emit('exit', 0, null), reapTree ? 5000 : 300); return c; },
      ledger: { reap: { policy: 'on', firstTickMs: 10, trackMs: 20 } },
    };
    const code = await runUnderQueue({ request: { box: 1, resources: {}, ramMb: 0, limits: {}, monitored: false, reapTree }, label: 't', cmd: ['node', '-e', '0'] }, io);
    return { code, calls };
  };
  const on = await run(true);
  assert.equal(on.code, 0);
  assert.ok(on.calls.track >= 2, `ticked ${on.calls.track} times`);
  assert.equal(on.calls.released, true);
  const off = await run(false);
  assert.equal(off.calls.track, 0);
});

// ---------------------------------------------------------------- leg 4b: the I/O column of the process snapshot

test('parseWinJson carries read+write+other transfer bytes as ioBytes, and leaves it off when the row has none', () => {
  const rows = parseWinJson(JSON.stringify([
    { p: 5, pp: 1, n: 'worker.exe', e: 'C:\\fake\\worker.exe', c: 'worker.exe', s: '20261121100000.000000+000', w: 2097152, k: 25_000_000, io: 123456 },
    { p: 6, pp: 1, n: 'other.exe', c: 'other.exe', w: 1048576, k: 10_000 },
    { p: 7, pp: 1, n: 'zero.exe', c: 'zero.exe', io: 0 },
  ]));
  assert.equal(rows[0].ioBytes, 123456);
  assert.equal(rows[0].cpuMs, 2500);
  assert.equal('ioBytes' in rows[1], false, 'no counter: not a zero');
  assert.equal(rows[2].ioBytes, 0);
});

test('the Windows snapshot asks for the three transfer counters; the rows come back with ioBytes', () => {
  let script = '';
  const spawn = (cmd, args) => {
    script = args[args.length - 1];
    return { status: 0, stdout: JSON.stringify([{ p: 9, pp: 1, n: 'a.exe', c: 'a.exe', io: 777 }]) };
  };
  const rows = processSnapshot({ platform: 'win32', spawn });
  assert.match(script, /ReadTransferCount/);
  assert.match(script, /WriteTransferCount/);
  assert.match(script, /OtherTransferCount/);
  assert.equal(rows[0].ioBytes, 777);
});
