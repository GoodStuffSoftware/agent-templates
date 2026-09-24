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
    const h = acquireLock(s.lock, { waitMs: 100 });
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
    const h = acquireLock(s.lock, { waitMs: 500, staleMs: 60_000 });
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
    const h = acquireLock(s.lock, { waitMs: 500, staleMs: 0 });
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

// 0.29.0 final review F1: the put-back race. With 3 or more waiters racing a
// crashed holder's lock, waiter C judged the dead lock stale; before C's
// rename, another waiter B broke it and A created a live lock; C's rename
// moved A's LIVE lock aside; before C put it back, D created a lock; the
// put-back failed, and A and D both held the lock. Replayed deterministically
// here: the helper's fs calls are wrapped so that B, A and D run at exactly
// those instants, each through the helper's own acquireLock (B is a real
// waiter following the same protocol, not a raw rename). Run in a child
// process because the wrap patches node:fs for the whole process.
test('F1: the put-back interleaving never leaves two holders (3+ waiters racing a crashed holder)', () => {
  const s = scratch();
  try {
    const probe = join(s.dir, 'putback-probe.mjs');
    writeFileSync(probe, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [lock, deadPid] = process.argv.slice(2);
      fs.writeFileSync(lock, JSON.stringify({ pid: Number(deadPid), token: 'crashed', at: Date.now() - 60000 }));
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
    const r = spawnSync(process.execPath, [probe, s.lock, String(deadPid())], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
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
