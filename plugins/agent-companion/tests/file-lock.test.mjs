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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
