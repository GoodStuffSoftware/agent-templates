// The shared lock helper (hooks/lib/file-lock.mjs). Stat-then-unlink stale
// breaking removes LIVE locks: a waiter stats an old lock, the holder
// releases, a third process takes a fresh lock, and the waiter's unlink
// removes that one (measured on the routing-profile store: lost updates in
// 6 of 40 trials with 8 writers). The helper writes an owner token into the
// lock, releases only its own token, and breaks a lock only when its owner's
// pid is dead AND it is old, by a re-verified atomic rename.
//
// The counter test is the proof: several processes increment one counter
// under the lock with staleMs 0, so EVERY waiter judges every lock "old";
// only the owner-liveness check stands between them and breaking live
// locks. Any lost increment fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT } from './helpers.mjs';
import { acquireLock, releaseLock, withFileLock, pidAlive, LockTimeoutError } from '../hooks/lib/file-lock.mjs';

const HELPER = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'file-lock.mjs')).href;
// The wait for an acquire that MUST succeed. acquire() returns the moment
// it has the lock, so this costs nothing when the helper is right; it is
// only spent when the helper is wrong. A short budget here (100-500 ms)
// asserted "succeeds within N ms of wall time" instead of "succeeds", and a
// loaded machine can stall a few fs calls past that.
const GETS_IT_MS = 30_000;
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-file-lock-'));
  return { dir, lock: join(dir, 'x.lock'), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

test('pidAlive: this process is alive, an exited one is not, garbage is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(0), false);
});

test('a lock carries its owner, and release removes only a lock still holding the releaser\'s token', () => {
  const s = scratch();
  try {
    const h = acquireLock(s.lock, { waitMs: GETS_IT_MS });
    assert.ok(h);
    const owner = JSON.parse(readFileSync(s.lock, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.token, h.token);
    // Someone else's lock now stands at the name: release must not touch it.
    writeFileSync(s.lock, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() }));
    releaseLock(h);
    assert.equal(JSON.parse(readFileSync(s.lock, 'utf8')).token, 'someone-else');
  } finally { s.cleanup(); }
});

test('an old lock whose owner is alive is never broken', () => {
  const s = scratch();
  try {
    writeFileSync(s.lock, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() - 3_600_000 }));
    assert.equal(acquireLock(s.lock, { waitMs: 200, staleMs: 1 }), null);
    assert.equal(JSON.parse(readFileSync(s.lock, 'utf8')).token, 'live');
    assert.throws(() => withFileLock(s.lock, () => 1, { waitMs: 50, failOpen: false }), LockTimeoutError);
    assert.deepEqual(withFileLock(s.lock, (st) => st, { waitMs: 50, failOpen: true }), { locked: false });
  } finally { s.cleanup(); }
});

test('a dead owner\'s lock is broken only once it is old enough', () => {
  const s = scratch();
  try {
    const pid = deadPid();
    writeFileSync(s.lock, JSON.stringify({ pid, token: 'dead-fresh', at: Date.now() }));
    assert.equal(acquireLock(s.lock, { waitMs: 150, staleMs: 60_000 }), null, 'a fresh lock is not broken');
    writeFileSync(s.lock, JSON.stringify({ pid, token: 'dead-old', at: Date.now() - 120_000 }));
    const h = acquireLock(s.lock, { waitMs: GETS_IT_MS, staleMs: 60_000 });
    assert.ok(h, 'an old lock of a dead owner is broken');
    releaseLock(h);
    assert.equal(existsSync(s.lock), false);
    assert.deepEqual(readdirSync(s.dir), [], 'no temp or moved files are left behind');
  } finally { s.cleanup(); }
});

test('a lock with no readable owner is broken once old (a crash mid-create)', () => {
  const s = scratch();
  try {
    writeFileSync(s.lock, '');
    assert.equal(acquireLock(s.lock, { waitMs: 100, staleMs: 60_000 }), null);
    const h = acquireLock(s.lock, { waitMs: GETS_IT_MS, staleMs: 0 });
    assert.ok(h);
    releaseLock(h);
  } finally { s.cleanup(); }
});

test('concurrent writers with every lock judged old never lose an update (owner liveness protects live locks)', async () => {
  const s = scratch();
  try {
    const counter = join(s.dir, 'counter.txt');
    writeFileSync(counter, '0');
    const worker = join(s.dir, 'worker.mjs');
    writeFileSync(worker, `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withFileLock } from ${JSON.stringify(HELPER)};
      const [lock, counter, n] = process.argv.slice(2);
      for (let i = 0; i < Number(n); i += 1) {
        withFileLock(lock, () => {
          const v = Number(readFileSync(counter, 'utf8'));
          writeFileSync(counter, String(v + 1));
        }, { waitMs: 60000, staleMs: 0, failOpen: false });
      }
    `);
    const W = 6;
    const N = 30;
    const codes = await Promise.all(Array.from({ length: W }, () => new Promise((resolve) => {
      const ch = spawn(process.execPath, [worker, s.lock, counter, String(N)], { windowsHide: true });
      let err = '';
      ch.stderr.on('data', (d) => { err += d; });
      ch.on('close', (code) => resolve({ code, err }));
    })));
    for (const c of codes) assert.equal(c.code, 0, c.err);
    assert.equal(Number(readFileSync(counter, 'utf8')), W * N, 'an update was lost: a live lock was broken');
    assert.deepEqual(readdirSync(s.dir).sort(), ['counter.txt', 'worker.mjs']);
  } finally { s.cleanup(); }
});

// 0.29.0 final review F3: a lock dated in the future (written before the
// clock stepped back) never aged, so a crashed holder's lock blocked every
// waiter until the clock caught up. Past a small skew allowance its age is
// unknowable: stale at once when its owner is dead, never when alive.
test('F3: a future-dated lock of a dead owner is broken; a live owner\'s is not', () => {
  const s = scratch();
  try {
    writeFileSync(s.lock, JSON.stringify({ pid: deadPid(), token: 'future-dead', at: Date.now() + 3_600_000 }));
    const h = acquireLock(s.lock, { waitMs: GETS_IT_MS, staleMs: 1000 });
    assert.ok(h, 'a dead owner\'s future-dated lock is broken');
    releaseLock(h);
    writeFileSync(s.lock, JSON.stringify({ pid: process.pid, token: 'future-live', at: Date.now() + 3_600_000 }));
    assert.equal(acquireLock(s.lock, { waitMs: 150, staleMs: 1000 }), null);
    assert.equal(JSON.parse(readFileSync(s.lock, 'utf8')).token, 'future-live');
    // Within the skew allowance a dead owner's lock still waits out staleMs.
    writeFileSync(s.lock, JSON.stringify({ pid: deadPid(), token: 'skew', at: Date.now() + 1000 }));
    assert.equal(acquireLock(s.lock, { waitMs: 150, staleMs: 60_000 }), null);
  } finally { s.cleanup(); }
});

// F3: a directory at the lock path. It used to be waited on for the whole
// waitMs and then reported as "held by another writer"; and a waiter must
// never move it aside as a stale lock. Now: answered at once, untouched.
test('F3: a directory at the lock path is reported at once as unusable, never waited on or moved', async () => {
  const s = scratch();
  try {
    const { LockUnusableError } = await import(HELPER);
    mkdirSync(s.lock);
    const old = new Date(Date.now() - 3_600_000);
    (await import('node:fs')).utimesSync(s.lock, old, old);
    // "At once" means "without waiting out waitMs": the budget is set far
    // above anything a loaded machine adds, and the bound is half of it.
    const WAIT = 60_000;
    let t0 = Date.now();
    assert.equal(acquireLock(s.lock, { waitMs: WAIT, staleMs: 10 }), null);
    assert.ok(Date.now() - t0 < WAIT / 2, `waited ${Date.now() - t0} ms on a directory`);
    t0 = Date.now();
    assert.equal(typeof LockUnusableError, 'function', 'LockUnusableError is exported');
    assert.throws(() => withFileLock(s.lock, () => 1, { waitMs: WAIT, failOpen: false }), (e) => e instanceof LockUnusableError && /a directory/.test(e.message));
    assert.deepEqual(withFileLock(s.lock, (st) => st, { waitMs: WAIT, failOpen: true }), { locked: false });
    assert.ok(Date.now() - t0 < WAIT / 2, `waited ${Date.now() - t0} ms on a directory`);
    assert.deepEqual(readdirSync(s.dir), ['x.lock'], 'the directory was left where it stands');
  } finally { s.cleanup(); }
});

// 0.29.0 final review F5: crash debris (a temp file from a crash mid-create,
// a moved stale lock, a dead breaker's claim, a guarded file's atomic-write
// temp) used to accumulate for ever. The next process to take the lock
// removes what is older than DEBRIS_MAX_AGE_MS, and nothing else.
test('F5: the next acquire sweeps old crash debris beside the lock, and only that', async () => {
  const s = scratch();
  try {
    const { DEBRIS_MAX_AGE_MS } = await import(HELPER);
    assert.equal(typeof DEBRIS_MAX_AGE_MS, 'number');
    const { utimesSync } = await import('node:fs');
    const guarded = join(s.dir, 'state.json');
    const old = new Date(Date.now() - DEBRIS_MAX_AGE_MS - 60_000);
    const dead = deadPid();
    const live = process.pid;
    // Hex parts of the helper's names, built at run time (a literal hex run
    // reads as a commit sha to the repo's leak check).
    const hx = (c, n = 8) => c.repeat(n);
    const debris = [`x.lock.${dead}.${hx('a')}.new`, `x.lock.${dead}.${hx('a')}.stale`, `x.lock.${hx('c', 16)}.1.break`, `state.json.${dead}.${hx('b')}.tmp`];
    // A file whose maker is still running is never crash debris, however
    // old: it is passed over without even a stat (a stat of every waiter's
    // in-flight temp file, under the lock, starved waiters on Windows).
    const keep = ['x.lock.notes', `other.json.${dead}.${hx('b')}.tmp`, 'state.json', `state.json.${dead}.${hx('b')}.tmp.bak`,
      `x.lock.${live}.${hx('d')}.new`, `x.lock.${live}.${hx('d')}.stale`, `state.json.${live}.${hx('d')}.tmp`];
    for (const n of [...debris, ...keep]) { writeFileSync(join(s.dir, n), 'x'); utimesSync(join(s.dir, n), old, old); }
    const fresh = [`x.lock.${dead}.${hx('e')}.new`, `state.json.${dead}.${hx('e')}.tmp`];
    for (const n of fresh) writeFileSync(join(s.dir, n), 'x');
    const h = acquireLock(s.lock, { waitMs: GETS_IT_MS, debris: [guarded] });
    assert.ok(h);
    assert.deepEqual(readdirSync(s.dir).sort(), [...keep, ...fresh, 'x.lock'].sort());
    releaseLock(h);
  } finally { s.cleanup(); }
});

// 0.29.0 final review F1: the put-back race. With 3 or more waiters racing a
// crashed holder's lock, waiter C judged the dead lock stale; before C's
// rename, another waiter B broke it and A created a live lock; C's rename
// moved A's LIVE lock aside; before C put it back, D created a lock; the
// put-back failed, and A and D both held the lock. Replayed deterministically
// here: the helper's fs calls are wrapped so that B, A and D run at exactly
// those instants, each through the helper's own acquireLock (B is a real
// waiter following the same protocol, not a raw rename). Run in a child
// process because the wrap patches node:fs for the whole process.
//
// The probe runs on a LOGICAL clock, so no wall-clock budget decides it.
// On the real clock C had 200 ms of wall time to reach its rename and then
// take the freed lock, and under the full suite's load stalled fs calls
// spent it: C gave up at stage 0 ("the interleaving point was reached",
// a --ci-parity run, 2026-09-25), or after the break with no holder (the
// same budget, spent later; reproduced by stalling each statSync 120 ms).
// Here Date.now() stands still until the interleaving point is reached, and
// after it advances only by the protocol's own backoff sleeps. So C always
// reaches the point, and its waitMs is then a budget of backoff, which the
// correct protocol never spends: the lock is free once the dead one is
// broken. A protocol that never reaches the point hangs the probe, and the
// spawn's hang guard reports that as its own failure.
test('F1: the put-back interleaving never leaves two holders (3+ waiters racing a crashed holder)', () => {
  const s = scratch();
  try {
    const probe = join(s.dir, 'putback-probe.mjs');
    writeFileSync(probe, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [lock, deadPid] = process.argv.slice(2);
      fs.writeFileSync(lock, JSON.stringify({ pid: Number(deadPid), token: 'crashed', at: Date.now() - 60000 }));
      let logical = Date.now();
      Date.now = () => logical;
      const realWait = Atomics.wait;
      Atomics.wait = function (ta, i, v, ms) {
        if (stage >= 1 && Number.isFinite(ms)) logical += ms;
        return realWait.call(Atomics, ta, i, v, ms);
      };
      const realRename = fs.renameSync, realLink = fs.linkSync;
      let mod; let stage = 0; const h = { A: null, B: null, D: null };
      const opts = { waitMs: 0, staleMs: 1000 };
      fs.renameSync = function (a, b) {
        if (stage === 0 && String(b).endsWith('.stale')) {
          stage = 1;
          h.B = mod.acquireLock(lock, opts); // B: breaks the dead lock, if it may
          h.A = mod.acquireLock(lock, opts); // A: takes the lock, if it is free
          stage = 2;
        }
        return realRename(a, b);
      };
      fs.linkSync = function (a, b) {
        if (stage === 2 && String(a).endsWith('.stale')) { stage = 3; h.D = mod.acquireLock(lock, opts); }
        return realLink(a, b);
      };
      syncBuiltinESMExports();
      mod = await import(${JSON.stringify(HELPER)});
      h.C = mod.acquireLock(lock, { waitMs: 200, staleMs: 1000 });
      const onDisk = fs.existsSync(lock) ? JSON.parse(fs.readFileSync(lock, 'utf8')).token : null;
      const holders = Object.entries(h).filter(([, v]) => v).map(([k, v]) => ({ k, token: v.token }));
      process.stdout.write(JSON.stringify({ stage, holders, onDisk }));
    `);
    const r = spawnSync(process.execPath, [probe, s.lock, String(deadPid())], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.ok(r.error?.code !== 'ETIMEDOUT', 'the probe hung: waiter C never reached the interleaving point, or never finished after it');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.stage >= 1, 'the interleaving point was reached');
    assert.ok(out.holders.length <= 1, `two holders at once: ${JSON.stringify(out)}`);
    assert.equal(out.holders.length, 1, `somebody gets the lock once the dead one is broken: ${JSON.stringify(out)}`);
    assert.equal(out.holders[0].token, out.onDisk, 'the one holder is the lock on disk');
  } finally { s.cleanup(); }
});

// The same race under real concurrency: crashed holders leave dead-owner
// locks while workers contend with a 50 ms stale time. Each critical section
// takes an O_EXCL sentinel; an EEXIST means two holders overlapped. (The
// deterministic replay above is the proof; this guards the whole protocol.)
test('F1: workers racing crashed holders\' locks never overlap in the critical section', async () => {
  const s = scratch();
  try {
    const child = join(s.dir, 'child.mjs');
    writeFileSync(child, `
      import { openSync, closeSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      import { acquireLock, releaseLock } from ${JSON.stringify(HELPER)};
      const [dir, role, startAt] = process.argv.slice(2);
      const lock = join(dir, 'x.lock'), cs = join(dir, 'cs.flag');
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (Date.now() < Number(startAt)) { /* common start */ }
      const opts = { waitMs: 8000, staleMs: 50 };
      if (role === 'crash') { acquireLock(lock, opts); process.exit(0); }
      const out = { overlaps: 0, got: 0 };
      for (let i = 0; i < 5; i += 1) {
        const h = acquireLock(lock, opts);
        if (!h) continue;
        out.got += 1;
        let fd = null;
        try { fd = openSync(cs, 'wx'); } catch (e) { if (e.code === 'EEXIST') out.overlaps += 1; }
        sleep(3);
        if (fd !== null) { closeSync(fd); for (let j = 0; j < 50; j += 1) { try { unlinkSync(cs); break; } catch { sleep(2); } } }
        releaseLock(h);
      }
      process.stdout.write(JSON.stringify(out));
    `);
    let overlaps = 0; let got = 0;
    for (let t = 0; t < 4; t += 1) {
      const dir = join(s.dir, `t${t}`);
      mkdirSync(dir);
      const startAt = String(Date.now() + 700);
      const run = (role) => new Promise((resolve) => {
        const ch = spawn(process.execPath, [child, dir, role, startAt], { windowsHide: true });
        let o = ''; ch.stdout.on('data', (d) => { o += d; });
        ch.on('close', () => resolve(o));
      });
      const outs = await Promise.all([...Array(3)].map(() => run('crash')).concat([...Array(8)].map(() => run('work'))));
      for (const o of outs.slice(3)) { const j = JSON.parse(o); overlaps += j.overlaps; got += j.got; }
    }
    assert.equal(overlaps, 0, 'two holders were in the critical section at once');
    assert.ok(got > 0);
  } finally { s.cleanup(); }
});
