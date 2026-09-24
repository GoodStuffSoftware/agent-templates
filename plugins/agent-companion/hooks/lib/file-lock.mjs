// One exclusive lock-file helper for every read-modify-write of shared state
// (the premium window, and the routing-profile store's file and journal).
//
// Why not stat-then-unlink: a waiter that stats an old lock and then unlinks
// "it" can remove a DIFFERENT, live lock that replaced the old one in
// between; measured on the profile store as lost updates in 6 of 40 trials
// with 8 writers. So:
//   - the lock carries a unique token, and is created WITH its content in one
//     step (a temp file hard-linked to the lock name: link fails if the name
//     exists), so no reader ever sees a live lock without its owner;
//   - release unlinks only while the lock still holds the releaser's token;
//   - a lock is judged stale only when its owner's pid is dead
//     (process.kill(pid, 0); EPERM counts as alive) AND it is older than
//     staleMs. A lock with no readable owner (a crash between creating the
//     fallback-path file and writing it) counts as dead once old enough.
//
// Breaking a stale lock is SERIALISED. A filesystem has no compare-and-delete,
// so any breaker that moves the lock name aside can move a lock that replaced
// the stale one a moment earlier: that is how 0.29.0 could leave two holders
// at once when 3 or more waiters raced a crashed holder's lock (a waiter
// renamed a newly-created live lock aside, a fourth created another, and the
// put-back failed). Now a waiter that judges a lock stale must first create a
// CLAIM on that exact lock, `<lock>.<id>.<k>.break`, where <id> is a digest of
// the stale lock's content and file identity. A claim is created the same
// O_EXCL way as a lock, so at most one live process holds the claim for a
// given stale lock. Only the claim holder re-reads the lock, re-checks that
// it is still that same stale lock, and moves it aside. Nothing else can
// change the lock in between: its owner is dead, a new lock cannot be created
// while it stands, and every other breaker of it needs the same claim.
// A crashed claim holder's claim is never removed while it matters; the next
// breaker takes slot k+1 once slot k's holder is dead AND old (the same test
// as for a lock), so a claim needs no stale-breaking of its own and cannot
// reintroduce the race it prevents.
//
// Residual, accepted: a dead owner's pid reused by an unrelated live process
// keeps its lock alive; waiters then time out (fail open for hooks), never
// corrupt anything. A process running an OLDER copy of this helper (0.29.0
// and before) takes no claims, so mid-upgrade it can still race a newer one
// over a crashed holder's lock.

import {
  readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, openSync, writeSync, closeSync,
  statSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

// A breaker gives up (and the acquire loop retries) after this many dead
// claims on one stale lock: each one needs a process that died mid-break.
const MAX_CLAIM_SLOTS = 32;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* retry at once */ }
}

function newToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

function lockContent(token) {
  return JSON.stringify({ pid: process.pid, token, at: Date.now() });
}

// null when the lock is absent, else { raw, owner, st, id }:
//   raw   - the content, or null when it cannot be read
//   owner - { pid, token, at }, or null (no readable owner)
//   st    - the stat taken before the read
//   id    - a digest of the content AND the file's identity (inode, size,
//           times): it names this one lock file for a breaker's claim
function readLock(lockPath) {
  let st;
  try { st = statSync(lockPath); } catch { return null; }
  let raw = null;
  try { raw = readFileSync(lockPath, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
  }
  let owner = null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.token === 'string') owner = { pid: Number(o.pid), token: o.token, at: Number(o.at) };
  } catch { /* unreadable owner */ }
  const id = createHash('sha256')
    .update(`${raw === null ? '\0unreadable' : raw}\0${st.ino}:${st.size}:${st.mtimeMs}:${st.birthtimeMs}`)
    .digest('hex').slice(0, 16);
  return { raw, owner, st, id };
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

function lockAge(seen) {
  if (seen.owner && Number.isFinite(seen.owner.at)) return Date.now() - seen.owner.at;
  return Number.isFinite(seen.st?.mtimeMs) ? Date.now() - seen.st.mtimeMs : 0;
}

// Stale: older than staleMs, and its owner is not a live process.
function isStale(seen, staleMs) {
  return lockAge(seen) > staleMs && !(seen.owner && pidAlive(seen.owner.pid));
}

// The claim that makes this process the ONE breaker of the stale lock `id`:
// a handle, or null when another live breaker holds it (or it cannot be
// created). Slot k is passed over only when its holder is dead AND old; a
// dead claim is never removed here, so no two live processes ever hold a
// claim on the same stale lock.
function claimBreak(lockPath, id, staleMs) {
  let k = 1;
  for (let tries = 0; k <= MAX_CLAIM_SLOTS && tries < 2 * MAX_CLAIM_SLOTS; tries += 1) {
    const claimPath = `${lockPath}.${id}.${k}.break`;
    const token = newToken();
    const got = tryCreate(claimPath, lockContent(token));
    if (got === true) return { lockPath: claimPath, token };
    if (got === null) return null;
    const c = readLock(claimPath);
    if (c === null) continue; // released in between: try the same slot again
    if (!isStale(c, staleMs)) return null; // a live breaker is at work
    k += 1;
  }
  return null;
}

// Break `lockPath` if it is still exactly the lock judged stale (`seen`).
function breakStale(lockPath, seen, staleMs) {
  const claim = claimBreak(lockPath, seen.id, staleMs);
  if (!claim) return;
  try {
    const cur = readLock(lockPath);
    if (!cur || cur.id !== seen.id || !isStale(cur, staleMs)) return; // already broken, or replaced
    // Holding the claim, nothing can replace the lock before this rename. A
    // rename (not an unlink) frees the name at once, even while a reader on
    // Windows holds the file open.
    const moved = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
    try { renameSync(lockPath, moved); } catch { return; } // busy: retry the acquire
    let raw = null;
    try { raw = readFileSync(moved, 'utf8'); } catch { /* unreadable */ }
    if (raw !== cur.raw) {
      // Unreachable while every writer takes claims (see the header); an
      // older helper mid-upgrade does not. Put it back, never clobbering.
      try { linkSync(moved, lockPath); } catch { /* a newer lock stands */ }
    }
    try { unlinkSync(moved); } catch { /* best effort */ }
  } finally {
    releaseLock(claim);
  }
}

// Acquire: a handle { lockPath, token } or null when not acquired within
// waitMs (or the lock cannot be created here at all).
export function acquireLock(lockPath, { waitMs = 2000, staleMs = 5000 } = {}) {
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* create reports it */ }
  const token = newToken();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = tryCreate(lockPath, lockContent(token));
    if (got === true) return { lockPath, token };
    if (got === null) return null;
    const seen = readLock(lockPath);
    if (seen && isStale(seen, staleMs)) {
      breakStale(lockPath, seen, staleMs);
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
    if (cur === null) return; // gone
    if (cur.raw !== null) {
      if (cur.owner?.token !== handle.token) return; // not ours (any more): never touch it
      try { unlinkSync(handle.lockPath); return; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) return;
      }
    }
    // Unreadable for a moment is not gone: retry.
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
