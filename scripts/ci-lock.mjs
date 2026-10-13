// scripts/ci-lock.mjs — machine-wide run lock for scripts/ci-local.mjs.
//
// Why: on 2026-10-13, 11 to 23 concurrent ci-local runs (mostly pre-push hooks
// in separate agent worktrees, each with its own `node --test` fan-out) pegged
// the CPU at 100% and made timing tests flake. At most N full runs (default 1)
// may run per machine, across every worktree.
//
// Design: N slot files `slot-<i>.lock` under os.tmpdir()/agent-templates-ci-local
// (machine-wide, not in any worktree). A slot is taken by an exclusive create
// (`wx`), so exactly one process wins. The file holds {pid, worktree, startedAt,
// token}. A waiter prints ONE line naming the holder, then sleeps (Atomics.wait,
// no busy loop) and re-checks every pollMs (default 5 s). A slot is stale when
// its holder pid is dead or it is older than maxAgeMs (default 45 min); a stale
// slot is moved aside and retaken. The lock is released on process exit (which
// also runs after an error or a handled SIGINT/SIGTERM); a hard kill is
// recovered by the dead-pid rule. Synchronous on purpose: ci-local runs its
// suites with spawnSync, so the wait must block too. Nothing here spawns a
// process, so nothing can open a window.

import {
  mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_POLL_MS = 5000;
export const DEFAULT_MAX_AGE_MS = 45 * 60 * 1000;

export function lockDir() {
  return join(tmpdir(), 'agent-templates-ci-local');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolder(file) {
  try {
    const h = JSON.parse(readFileSync(file, 'utf8'));
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}

// Returns a reason string when stale, false when live, null when unreadable
// (a writer may be mid-write: treated as busy for one poll).
function staleReason(holder, { now, maxAgeMs, alive }) {
  if (!holder) return null;
  if (!alive(holder.pid)) return 'holder process is gone';
  if (now - Number(holder.startedAt) > maxAgeMs) return 'lock older than the age cap';
  return false;
}

/**
 * Take one slot, waiting if all are busy. Returns {release(), slot, waitedMs}.
 * Options (all injectable for tests): dir, maxParallel, pollMs, maxAgeMs,
 * worktree, pid, now(), sleep(ms), isAlive(pid), log(line), timeoutMs.
 */
export function acquireLock({
  dir = lockDir(),
  maxParallel = 1,
  pollMs = DEFAULT_POLL_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  worktree = process.cwd(),
  pid = process.pid,
  now = Date.now,
  sleep = sleepMs,
  isAlive = isPidAlive,
  log = (l) => console.error(l),
  timeoutMs = Infinity,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(8).toString('hex');
  const begin = now();
  let announced = false;
  for (;;) {
    let busy = null;
    for (let i = 0; i < maxParallel; i += 1) {
      const file = join(dir, `slot-${i}.lock`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(file, JSON.stringify({
            pid, worktree, startedAt: now(), startedAtIso: new Date(now()).toISOString(), token,
          }), { flag: 'wx' });
          return {
            slot: i,
            waitedMs: now() - begin,
            release() {
              const h = readHolder(file);
              if (h && h.token === token) {
                try { unlinkSync(file); } catch { /* already gone */ }
              }
            },
          };
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        const holder = readHolder(file);
        const stale = staleReason(holder, { now: now(), maxAgeMs, alive: isAlive });
        if (stale) {
          // Move it aside first: of several waiters, only one rename succeeds.
          try {
            renameSync(file, `${file}.stale-${token}`);
            unlinkSync(`${file}.stale-${token}`);
            log(`ci-local: took over a stale lock (${stale}); it was held by ${holder.worktree} pid ${holder.pid}`);
          } catch { /* lost the race; the retry sees the winner's lock */ }
          continue; // retry the create
        }
        busy = busy || holder || { pid: '?', worktree: '?', startedAtIso: '?' };
        break;
      }
    }
    if (!announced && busy) {
      announced = true;
      log(`ci-local: waiting for another run (pid ${busy.pid}, ${busy.worktree}, started ${busy.startedAtIso}); `
        + `polling every ${Math.round(pollMs / 1000)} s. CI_LOCAL_LOCK=0 skips the wait.`);
    }
    if (now() - begin >= timeoutMs) {
      const e = new Error('timed out waiting for the ci-local lock');
      e.code = 'ELOCKTIMEOUT';
      throw e;
    }
    sleep(pollMs);
  }
}

export function resolveLockConfig(env = process.env) {
  const off = String(env.CI_LOCAL_LOCK ?? '').trim() === '0';
  const raw = String(env.CI_LOCAL_MAX_PARALLEL ?? '').trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const maxParallel = Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : 1;
  const pollRaw = Number(env.CI_LOCAL_LOCK_POLL_MS);
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : DEFAULT_POLL_MS;
  const ageRaw = Number(env.CI_LOCAL_LOCK_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(ageRaw) && ageRaw > 0 ? ageRaw : DEFAULT_MAX_AGE_MS;
  const warning = raw && !(Number.isInteger(n) && n >= 1)
    ? `ci-local: CI_LOCAL_MAX_PARALLEL="${raw}" is not a positive integer; using 1.` : '';
  return { off, maxParallel, pollMs, maxAgeMs, warning, dir: env.CI_LOCAL_LOCK_DIR || lockDir() };
}

let held = null;

// Idempotent: the first call takes the lock (or waits for it), later calls are
// no-ops. Released on process exit however the process ends.
export function ensureRunLock({ env = process.env, worktree = process.cwd(), ...rest } = {}) {
  if (held) return held;
  const cfg = resolveLockConfig(env);
  if (cfg.warning) console.error(cfg.warning);
  if (cfg.off) { held = { release() {}, slot: -1, waitedMs: 0 }; return held; }
  const mine = acquireLock({
    dir: cfg.dir, maxParallel: cfg.maxParallel, pollMs: cfg.pollMs, maxAgeMs: cfg.maxAgeMs, worktree, ...rest,
  });
  held = mine;
  process.on('exit', () => mine.release());
  return held;
}
