// One exclusive lock-file helper for every read-modify-write of shared state
// (the premium window today; the routing-profile store is to adopt it).
//
// Why not stat-then-unlink: a waiter that stats an old lock and then unlinks
// "it" can remove a DIFFERENT, live lock that replaced the old one in
// between; measured on the profile store as lost updates in 6 of 40 trials
// with 8 writers. So:
//   - the lock carries a unique token, and is created WITH its content in one
//     step (a temp file hard-linked to the lock name: link fails if the name
//     exists), so no reader ever sees a live lock without its owner;
//   - release unlinks only while the lock still holds the releaser's token;
//   - a lock is broken only when its owner's pid is dead (process.kill(pid,
//     0); EPERM counts as alive) AND it is older than staleMs, and it is
//     broken by an atomic rename to a unique name followed by re-reading the
//     renamed file: if that is not the lock judged stale (it was replaced in
//     between), it is put back (link, which never clobbers) and nothing is
//     broken. A lock with no readable owner (a crash between creating the
//     fallback-path file and writing it) counts as dead once old enough.
// Residual, accepted: a dead owner's pid reused by an unrelated live process
// keeps its lock alive; waiters then time out (fail open for hooks), never
// corrupt anything.

import {
  readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, openSync, writeSync, closeSync,
  statSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* retry at once */ }
}

function newToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

// { raw, owner: { pid, token, at } | null } or null when the lock is absent.
function readLock(lockPath) {
  let raw;
  try { raw = readFileSync(lockPath, 'utf8'); } catch { return null; }
  let owner = null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.token === 'string') owner = { pid: Number(o.pid), token: o.token, at: Number(o.at) };
  } catch { /* unreadable owner */ }
  return { raw, owner };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// Create the lock with its content in one step. true = acquired, false =
// held by someone else, null = cannot lock here at all.
function tryCreate(lockPath, content) {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.new`;
  try {
    writeFileSync(tmp, content);
    try { linkSync(tmp, lockPath); return true; } catch (e) {
      if (e?.code === 'EEXIST') return false;
      // No hard links here: fall back to O_EXCL create, then write.
      try {
        const fd = openSync(lockPath, 'wx');
        try { writeSync(fd, content); } finally { closeSync(fd); }
        return true;
      } catch (e2) {
        return ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e2?.code) ? false : null;
      }
    }
  } catch (e) {
    return ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e?.code) ? false : null;
  } finally {
    try { unlinkSync(tmp); } catch { /* never written */ }
  }
}

// Break `lockPath` if it is still exactly `seen` (the lock judged stale).
function breakStale(lockPath, seen) {
  const moved = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try { renameSync(lockPath, moved); } catch { return; } // gone or busy: retry the acquire
  let raw = null;
  try { raw = readFileSync(moved, 'utf8'); } catch { /* unreadable: treat as not ours */ }
  if (raw === seen.raw) {
    try { unlinkSync(moved); } catch { /* best effort */ }
    return;
  }
  // Replaced in between: a live lock was moved. Put it back without
  // clobbering whatever may have been created since.
  try { linkSync(moved, lockPath); } catch { /* a newer lock stands; the moved owner's release is a no-op */ }
  try { unlinkSync(moved); } catch { /* best effort */ }
}

function lockAge(lockPath, owner) {
  if (owner && Number.isFinite(owner.at)) return Date.now() - owner.at;
  try { return Date.now() - statSync(lockPath).mtimeMs; } catch { return 0; }
}

// Acquire: a handle { lockPath, token } or null when not acquired within
// waitMs (or the lock cannot be created here at all).
export function acquireLock(lockPath, { waitMs = 2000, staleMs = 5000 } = {}) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* create reports it */ }
  const token = newToken();
  const content = JSON.stringify({ pid: process.pid, token, at: Date.now() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = tryCreate(lockPath, content);
    if (got === true) return { lockPath, token };
    if (got === null) return null;
    const seen = readLock(lockPath);
    if (seen && lockAge(lockPath, seen.owner) > staleMs && !(seen.owner && pidAlive(seen.owner.pid))) {
      breakStale(lockPath, seen);
      if (Date.now() < deadline) continue;
    }
    if (Date.now() >= deadline) return null;
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
}

// Release: unlink only while the lock still holds this handle's token. On
// Windows a waiter reading the lock at that instant can make the unlink fail
// transiently (EPERM/EBUSY); retried briefly, because a lock left behind by a
// LIVE owner is never broken, and would block this process's next acquire.
export function releaseLock(handle) {
  if (!handle) return;
  for (let i = 0; i < 50; i += 1) {
    const cur = readLock(handle.lockPath);
    if (cur === null) {
      // Unreadable for a moment is not gone: only a vanished lock ends this.
      try { statSync(handle.lockPath); } catch { return; }
    } else if (cur.owner?.token !== handle.token) {
      return; // not ours (any more): never touch it
    } else {
      try { unlinkSync(handle.lockPath); return; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) return;
      }
    }
    sleepSync(10);
  }
}

export class LockTimeoutError extends Error {
  constructor(lockPath) {
    super(`lock is held by another writer: ${lockPath}`);
    this.code = 'ELOCKED';
    this.lockPath = lockPath;
  }
}

// Run fn under the lock. failOpen (hooks): on a timeout fn still runs,
// unlocked. Otherwise a timeout throws LockTimeoutError. fn must not exit
// the process while holding the lock.
export function withFileLock(lockPath, fn, { waitMs = 2000, staleMs = 5000, failOpen = true } = {}) {
  const handle = acquireLock(lockPath, { waitMs, staleMs });
  if (!handle && !failOpen) throw new LockTimeoutError(lockPath);
  try {
    return fn({ locked: !!handle });
  } finally {
    releaseLock(handle);
  }
}
