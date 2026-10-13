// scripts/ci-lock.mjs: the machine-wide ci-local run lock. Fake work only: the
// real suite is never run here, and every lock lives in a fresh temp dir.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock, resolveLockConfig, isPidAlive } from '../ci-lock.mjs';

const LOCK_MODULE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'ci-lock.mjs')).href;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-lock-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A pid that is certainly not alive: spawn nothing, ask the OS for a huge one.
const DEAD_PID = 2147483646;

test('resolveLockConfig: defaults, CI_LOCAL_LOCK=0 bypass, bad parallel falls back to 1', () => {
  assert.deepEqual(
    { ...resolveLockConfig({}), dir: 'x' },
    { off: false, maxParallel: 1, pollMs: 5000, maxAgeMs: 45 * 60 * 1000, warning: '', dir: 'x' },
  );
  assert.equal(resolveLockConfig({ CI_LOCAL_LOCK: '0' }).off, true);
  assert.equal(resolveLockConfig({ CI_LOCAL_LOCK: '1' }).off, false);
  assert.equal(resolveLockConfig({ CI_LOCAL_MAX_PARALLEL: '3' }).maxParallel, 3);
  const bad = resolveLockConfig({ CI_LOCAL_MAX_PARALLEL: '0' });
  assert.equal(bad.maxParallel, 1);
  assert.match(bad.warning, /not a positive integer/);
});

test('a second run waits (one announce line naming the holder) and proceeds after release', () => {
  const t = tmp();
  try {
    const a = acquireLock({ dir: t.dir, worktree: 'wt-A', pid: process.pid });
    const lines = [];
    let sleeps = 0;
    const b = acquireLock({
      dir: t.dir, worktree: 'wt-B', pollMs: 10, log: (l) => lines.push(l),
      sleep: () => { sleeps += 1; if (sleeps === 3) a.release(); },
    });
    assert.equal(sleeps, 3, 'polled until the holder released, no more');
    assert.equal(lines.length, 1, 'exactly one waiting line');
    assert.match(lines[0], new RegExp(`pid ${process.pid}, wt-A, started \\d{4}-\\d\\d-\\d\\dT`));
    b.release();
    assert.equal(readdirSync(t.dir).length, 0, 'release leaves no file behind');
  } finally { t.cleanup(); }
});

test('two real processes serialize: their critical sections never overlap', async () => {
  const t = tmp();
  try {
    const out = join(t.dir, 'events.log');
    const code = `
      import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
      import { appendFileSync } from 'node:fs';
      const id = process.argv[1];
      const l = acquireLock({ dir: ${JSON.stringify(join(t.dir, 'locks'))}, worktree: 'wt-' + id, pollMs: 25, log: () => {} });
      appendFileSync(${JSON.stringify(out)}, id + ' start\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      appendFileSync(${JSON.stringify(out)}, id + ' end\\n');
      l.release();
    `;
    const run = (id) => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code, id], { windowsHide: true, stdio: 'ignore' });
      c.on('error', rej);
      c.on('exit', (status) => (status === 0 ? res() : rej(new Error(`child ${id} exited ${status}`))));
    });
    await Promise.all([run('A'), run('B')]);
    const events = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(events.length, 4);
    // Serialized: each "start" is immediately followed by the same id's "end".
    assert.equal(events[0].split(' ')[0], events[1].split(' ')[0]);
    assert.equal(events[1].split(' ')[1], 'end');
    assert.equal(events[2].split(' ')[0], events[3].split(' ')[0]);
    assert.notEqual(events[0].split(' ')[0], events[2].split(' ')[0]);
  } finally { t.cleanup(); }
});

test('stale lock: a dead holder pid is taken over at once', () => {
  const t = tmp();
  try {
    writeFileSync(join(t.dir, 'slot-0.lock'), JSON.stringify({
      pid: DEAD_PID, worktree: 'ghost', startedAt: Date.now(), startedAtIso: new Date().toISOString(), token: 'x',
    }));
    assert.equal(isPidAlive(DEAD_PID), false);
    const lines = [];
    const l = acquireLock({ dir: t.dir, log: (x) => lines.push(x), sleep: () => assert.fail('must not wait') });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /took over a stale lock \(holder process is gone\).*ghost/);
    const now = JSON.parse(readFileSync(join(t.dir, 'slot-0.lock'), 'utf8'));
    assert.equal(now.pid, process.pid);
    l.release();
  } finally { t.cleanup(); }
});

test('stale lock: a live holder older than the age cap is taken over; a young one is not', () => {
  const t = tmp();
  try {
    const t0 = 1_000_000_000_000;
    writeFileSync(join(t.dir, 'slot-0.lock'), JSON.stringify({
      pid: process.pid, worktree: 'old', startedAt: t0, startedAtIso: 'then', token: 'x',
    }));
    // Young: 1 min old, cap 45 min -> must wait (timeout proves it did not take over).
    assert.throws(
      () => acquireLock({ dir: t.dir, now: () => t0 + 60_000, sleep: () => {}, log: () => {}, timeoutMs: 0 }),
      { code: 'ELOCKTIMEOUT' },
    );
    assert.ok(existsSync(join(t.dir, 'slot-0.lock')));
    // Old: 46 min.
    const l = acquireLock({ dir: t.dir, now: () => t0 + 46 * 60_000, sleep: () => {}, log: () => {} });
    assert.equal(l.slot, 0);
    l.release();
  } finally { t.cleanup(); }
});

test('release only removes the caller\'s own lock', () => {
  const t = tmp();
  try {
    const a = acquireLock({ dir: t.dir });
    writeFileSync(join(t.dir, 'slot-0.lock'), JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: Date.now() }));
    a.release();
    assert.ok(existsSync(join(t.dir, 'slot-0.lock')), 'a taken-over lock is not deleted by the old holder');
  } finally { t.cleanup(); }
});

test('maxParallel=2 lets two runs hold at once and makes a third wait', () => {
  const t = tmp();
  try {
    const a = acquireLock({ dir: t.dir, maxParallel: 2 });
    const b = acquireLock({ dir: t.dir, maxParallel: 2, sleep: () => assert.fail('second slot is free') });
    assert.notEqual(a.slot, b.slot);
    assert.throws(
      () => acquireLock({ dir: t.dir, maxParallel: 2, sleep: () => {}, log: () => {}, timeoutMs: 0 }),
      { code: 'ELOCKTIMEOUT' },
    );
    a.release(); b.release();
  } finally { t.cleanup(); }
});

test('CI_LOCAL_LOCK=0 bypasses: a process holding the lock does not stop a bypassing run', async () => {
  const t = tmp();
  try {
    const holder = acquireLock({ dir: t.dir });
    const code = `
      import { ensureRunLock } from ${JSON.stringify(LOCK_MODULE)};
      const h = ensureRunLock({ env: process.env });
      process.stdout.write('slot=' + h.slot);
    `;
    const res = await new Promise((resolve, reject) => {
      let stdout = '';
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], {
        windowsHide: true,
        env: { ...process.env, CI_LOCAL_LOCK_DIR: t.dir, CI_LOCAL_LOCK: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => { c.kill(); reject(new Error('bypass run blocked on the lock')); }, 10_000);
      c.stdout.on('data', (d) => { stdout += d; });
      c.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, 'slot=-1');
    holder.release();
  } finally { t.cleanup(); }
});
