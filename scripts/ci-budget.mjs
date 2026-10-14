#!/usr/bin/env node
// scripts/ci-budget.mjs: a machine-wide shared worker budget for scripts/ci-local.mjs.
//
// Replaces the one-run mutex (scripts/ci-lock.mjs, removed). Several ci-local and
// pre-push runs may go at once; the TOTAL number of test workers across all of
// them, plus load from outside our runs, stays under one budget that scales
// with the machine. A run that finds the box busy starts with fewer workers or
// waits in a fair queue. It never fails. Design note: CONTRIBUTING.md, "Shared
// CI budget".
//
// The lease format and protocol (file names, fields, atomic rules, stale rules,
// units) are specified ONCE, in CONTRIBUTING.md, "Shared CI budget"; other
// repos follow that spec. Ledger: budgetDir() below (machine-wide, repo-neutral,
// not in any worktree). One JSON file per holder:
//   lease-<id>.json   {id, pid, startedAt, heartbeatAt, repo, worktree, kind, units, heavy, heavyCost, label}
//   lease-<id>.hb     heartbeat sidecar: a timestamp, rewritten by a worker thread
//   ticket-<id>.json  a queued full run: {id, pid, createdAt, heartbeatAt, worktree, desired}
//   admit.lock        short mutex around "read the ledger, then write a lease"
// Create is an exclusive open ('wx'); update is write-temp-then-rename.
//
// Nothing here spawns a process, so nothing can open a window. The admission
// path reads os.cpus() twice (about 300 ms apart) and the ledger directory;
// that is all. Heartbeats come from a worker THREAD, not a child process.
//
// Units. A lease holds `units` plain workers and `heavy` heavy workers (test
// files that spawn many git/sh processes). It is charged
//   charge = units + heavy * heavyCost
// against the budget, and `heavy` counts toward the machine-wide heavy cap.
//
// Admission, full run (kind 'full'; takes a ticket and queues):
//   free  = budget - held - external          (held = sum of live charges)
//   admit only when this run's ticket is the head of the queue (ordered by
//   (createdAt, pid)), fewer than maxFull full leases are live, and free >= 1;
//   grant = min(desired, free) plain units.
//   A run that finds NO live lease may always start with at least 1 unit, so
//   external load alone can never starve it.
// Admission, targeted run (kind 'targeted', "express"): 1 unit, no ticket,
//   admitted at once while held + 1 <= budget + express; otherwise it polls
//   (still with no ticket, so it never queues behind full suites).
// External load: busy = sum over cores of (1 - idleDelta/totalDelta) between
//   two os.cpus() samples; external = max(0, round(busy - held)), i.e. the
//   busy cores that our held units do not explain. The sampler is injectable.
// Transition: a worktree on 0.31.17 or earlier still takes the old mutex's slot
//   files and never asks this budget. Each live holder counts as one full run at
//   the default concurrency (legacyRunUnits), read-only. See readLegacy().
// Reclaim: a lease or ticket is stale when its pid is not alive OR its
//   heartbeat (the newer of heartbeatAt and the sidecar) is older than staleMs
//   (90 s). Stale entries are removed by whoever notices.

import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, existsSync,
} from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir, availableParallelism, cpus } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export const DEFAULT_HEAVY_COST = 3;
export const DEFAULT_HEAVY_MAX = 2;
export const DEFAULT_EXPRESS = 2;
export const DEFAULT_POLL_MS = 1500;
export const DEFAULT_ANNOUNCE_MS = 60_000;
export const DEFAULT_STALE_MS = 90_000;
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const DEFAULT_SAMPLE_MS = 300;
export const DEFAULT_HEAVY_MAX_WAIT_MS = 600_000;
export const DEFAULT_QUEUE_MAX_WAIT_MS = 30 * 60_000; // a full run's queue wait
export const DEFAULT_EXPRESS_MAX_WAIT_MS = 5 * 60_000; // a targeted run's wait
const LEGACY_MAX_AGE_MS = 45 * 60 * 1000; // the old mutex's own age cap
const ADMIT_STALE_MS = 10_000;
const DEBRIS_MAX_AGE_MS = 600_000; // *.tmp-* / *.stale-* left by a crash between write and rename
const ADMIT_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

// The default `repo` label: the basename of the git top-level directory above
// `start` (the nearest ancestor holding `.git`, a directory or, in a linked
// worktree, a file), else the basename of `start`. Only fs calls, no process.
export function repoLabel(start) {
  const from = resolve(start || process.cwd());
  for (let d = from; ;) {
    if (existsSync(join(d, '.git'))) return basename(d) || 'unknown';
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return basename(from) || 'unknown';
}

// Repo-neutral and machine-wide, so other repos can take leases from the same
// budget. CI_BUDGET_DIR wins; else %LOCALAPPDATA%/ci-budget on Windows,
// $XDG_RUNTIME_DIR/ci-budget elsewhere, else os.tmpdir()/ci-budget.
export function budgetDir(env = process.env) {
  if (env.CI_BUDGET_DIR) return env.CI_BUDGET_DIR;
  if (process.platform === 'win32') {
    return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ci-budget') : join(tmpdir(), 'ci-budget');
  }
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'ci-budget') : join(tmpdir(), 'ci-budget');
}

export function defaultBudget(cores) {
  return Math.max(2, Math.floor(cores * 0.5));
}

// What one run of the OLD ci-local (0.31.17 and earlier, which still takes the
// scripts/ci-lock.mjs mutex and never asks this budget) is charged while it
// holds that mutex: its default test concurrency, half the cores clamped to 1..8.
export function legacyRunUnits(cores) {
  return Math.min(8, Math.max(1, Math.floor(cores / 2)));
}

// Where the old mutex kept its slot files (it used os.tmpdir()/agent-templates-ci-local).
export function legacyLockDir(env = process.env) {
  return env.CI_LOCAL_LOCK_DIR || join(tmpdir(), 'agent-templates-ci-local');
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

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

// ---------------------------------------------------------------- config

function posInt(env, name, fallback, warnings, { min = 1 } = {}) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= min) return n;
  warnings.push(`ci-budget: ${name}="${raw}" is not an integer >= ${min}; using ${fallback}.`);
  return fallback;
}

/** Read the knobs from the environment. `cores` is injectable for tests. */
export function resolveBudgetConfig(env = process.env, { cores = availableParallelism() } = {}) {
  const warnings = [];
  const off = String(env.CI_LOCAL_LOCK ?? '').trim() === '0';
  const budget = posInt(env, 'CI_LOCAL_BUDGET', defaultBudget(cores), warnings);
  const heavyCost = Math.min(posInt(env, 'CI_LOCAL_HEAVY_COST', DEFAULT_HEAVY_COST, warnings), budget);
  const heavyMax = posInt(env, 'CI_LOCAL_HEAVY_MAX', DEFAULT_HEAVY_MAX, warnings, { min: 0 });
  const express = posInt(env, 'CI_LOCAL_EXPRESS', DEFAULT_EXPRESS, warnings, { min: 0 });
  const maxFull = posInt(env, 'CI_LOCAL_MAX_PARALLEL', Infinity, warnings);
  const pollMs = posInt(env, 'CI_LOCAL_BUDGET_POLL_MS', DEFAULT_POLL_MS, warnings);
  const staleMs = posInt(env, 'CI_LOCAL_BUDGET_STALE_MS', DEFAULT_STALE_MS, warnings);
  const heavyMaxWaitMs = posInt(env, 'CI_LOCAL_HEAVY_MAX_WAIT_MS', DEFAULT_HEAVY_MAX_WAIT_MS, warnings);
  const queueMaxWaitMs = posInt(env, 'CI_LOCAL_QUEUE_MAX_WAIT_MS', DEFAULT_QUEUE_MAX_WAIT_MS, warnings);
  const expressMaxWaitMs = posInt(env, 'CI_LOCAL_EXPRESS_MAX_WAIT_MS', DEFAULT_EXPRESS_MAX_WAIT_MS, warnings);
  return {
    off, cores, budget, heavyCost, heavyMax, express, maxFull, pollMs, staleMs, heavyMaxWaitMs, queueMaxWaitMs, expressMaxWaitMs,
    heartbeatMs: DEFAULT_HEARTBEAT_MS, announceMs: DEFAULT_ANNOUNCE_MS, sampleMs: DEFAULT_SAMPLE_MS,
    dir: budgetDir(env), warnings,
  };
}

const OVERRIDES = [
  'dir', 'budget', 'heavyCost', 'heavyMax', 'express', 'maxFull', 'pollMs', 'staleMs',
  'heartbeatMs', 'announceMs', 'sampleMs', 'off', 'legacyDir', 'legacyUnits', 'heavyMaxWaitMs',
  'queueMaxWaitMs', 'expressMaxWaitMs',
];

// Environment config, then explicit options on top, plus the injectable seams.
function makeCtx(o = {}) {
  const cfg = resolveBudgetConfig(o.env ?? process.env, { cores: o.cores ?? availableParallelism() });
  const ctx = { ...cfg };
  for (const k of OVERRIDES) if (o[k] !== undefined) ctx[k] = o[k];
  ctx.heavyCost = Math.min(ctx.heavyCost, ctx.budget);
  ctx.legacyDir ??= legacyLockDir(o.env ?? process.env);
  ctx.legacyUnits = Math.min(ctx.legacyUnits ?? legacyRunUnits(ctx.cores), ctx.budget);
  ctx.now = o.now ?? Date.now;
  ctx.sleep = o.sleep ?? sleepMs;
  ctx.isAlive = o.isAlive ?? isPidAlive;
  ctx.log = o.log ?? ((l) => console.error(l));
  ctx.pid = o.pid ?? process.pid;
  ctx.worktree = o.worktree ?? process.cwd();
  ctx.repo = o.repo ?? ((o.env ?? process.env).CI_BUDGET_REPO || repoLabel(ctx.worktree));
  ctx.sampler = o.sampler ?? (() => sampleBusyCores({ ms: ctx.sampleMs }));
  ctx.registerExit = o.registerExit ?? true;
  ctx.timeoutMs = o.timeoutMs ?? Infinity;
  ctx.heartbeat = o.heartbeat ?? 'worker';
  if (!o.log) for (const w of cfg.warnings) console.error(w);
  return ctx;
}

// ---------------------------------------------------------------- external load

/**
 * Busy cores over a window: sum over cores of (1 - idle share). Spawns nothing.
 * `read` and `sleep` are injectable so a test can feed fixed cpu times.
 */
export function sampleBusyCores({ ms = DEFAULT_SAMPLE_MS, sleep = sleepMs, read = cpus } = {}) {
  const a = read();
  sleep(ms);
  const b = read();
  let busy = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const ta = a[i].times; const tb = b[i].times;
    const sum = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
    const total = sum(tb) - sum(ta);
    const idle = tb.idle - ta.idle;
    if (total > 0) busy += Math.min(1, Math.max(0, 1 - idle / total));
  }
  return busy;
}

function measureExternal(ctx) {
  const busy = Number(ctx.sampler());
  const held = totals(ctx, readState(ctx, { reclaim: false })).held;
  return Number.isFinite(busy) ? Math.max(0, Math.round(busy - held)) : 0;
}

// ---------------------------------------------------------------- files

function newId() {
  return randomBytes(6).toString('hex');
}

function tryUnlink(file) {
  try { unlinkSync(file); } catch { /* already gone */ }
}

function writeAtomic(ctx, file, obj) {
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, JSON.stringify(obj));
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(tmp, file); return; } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) { tryUnlink(tmp); throw err; }
      ctx.sleep(10 + attempt * 10); // Windows: a reader holds the target for a moment
    }
  }
}

// Move aside first: of several reclaimers, only one rename succeeds.
function dropFile(file, ...extra) {
  try {
    const aside = `${file}.stale-${newId()}`;
    renameSync(file, aside);
    tryUnlink(aside);
  } catch { /* lost the race, or already gone */ }
  for (const f of extra) tryUnlink(f);
}

function readJson(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : null;
  } catch {
    // A partial write or crash debris. Debris older than 30 s is removed.
    try { if (Date.now() - statSync(file).mtimeMs > 30_000) dropFile(file); } catch { /* gone */ }
    return null;
  }
}

function readHb(file) {
  try {
    const n = Number(readFileSync(file, 'utf8'));
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function staleReason(ctx, e) {
  if (!ctx.isAlive(e.pid)) return 'process is gone';
  const hb = Math.max(num(e.heartbeatAt), num(e.hbSide), num(e.startedAt), num(e.createdAt));
  if (ctx.now() - hb > ctx.staleMs) return 'heartbeat is stale';
  return null;
}

const charge = (ctx, l) => l.units + l.heavy * (l.heavyCost ?? ctx.heavyCost);

/**
 * Read the ledger. With reclaim, stale leases and tickets are removed (and
 * returned in `reclaimed`); without it they are listed with a `stale` reason and
 * left alone, and are excluded from the live lists either way.
 */
export function readState(ctx, { reclaim = true } = {}) {
  let names = [];
  try { names = readdirSync(ctx.dir); } catch { /* no ledger yet */ }
  const leases = []; const tickets = []; const staleEntries = []; const reclaimed = [];
  const leaseIds = new Set();
  const legacy = readLegacy(ctx);
  for (const name of names) {
    let m = /^lease-([0-9a-f]+)\.json$/.exec(name);
    if (m) {
      const file = join(ctx.dir, name);
      const d = readJson(file);
      if (!d) continue;
      const hbFile = join(ctx.dir, `lease-${m[1]}.hb`);
      // Another repo's writer may leave fields out or mistype them: normalize
      // so one sparse lease cannot turn the totals into NaN or break status.
      const hc = Math.trunc(num(d.heavyCost));
      const e = {
        ...d, id: m[1], file, hbFile, hbSide: readHb(hbFile),
        pid: num(d.pid),
        kind: d.kind === 'targeted' ? 'targeted' : 'full',
        repo: typeof d.repo === 'string' ? d.repo : '',
        worktree: typeof d.worktree === 'string' ? d.worktree : '',
        label: typeof d.label === 'string' ? d.label : '',
        units: Math.max(0, Math.trunc(num(d.units))), heavy: Math.max(0, Math.trunc(num(d.heavy))),
        heavyCost: hc >= 1 ? hc : ctx.heavyCost,
      };
      const why = staleReason(ctx, e);
      leaseIds.add(m[1]);
      if (why) {
        staleEntries.push({ ...e, type: 'lease', stale: why });
        if (reclaim) { dropFile(file, hbFile); reclaimed.push({ type: 'lease', pid: e.pid, worktree: e.worktree, why }); }
      } else leases.push(e);
      continue;
    }
    m = /^ticket-([0-9a-f]+)\.json$/.exec(name);
    if (m) {
      const file = join(ctx.dir, name);
      const d = readJson(file);
      if (!d) continue;
      const e = {
        ...d, id: m[1], file, pid: num(d.pid),
        repo: typeof d.repo === 'string' ? d.repo : '',
        worktree: typeof d.worktree === 'string' ? d.worktree : '',
        desired: Math.max(1, Math.trunc(num(d.desired)) || 1),
      };
      const why = staleReason(ctx, e);
      if (why) {
        staleEntries.push({ ...e, type: 'ticket', stale: why });
        if (reclaim) { dropFile(file); reclaimed.push({ type: 'ticket', pid: e.pid, worktree: e.worktree, why }); }
      } else tickets.push(e);
    }
  }
  if (reclaim) {
    for (const name of names) {
      // Crash debris: a temp file from a crash between write and rename, or a
      // file moved aside and never unlinked. Young ones may be in flight.
      if (/\.(?:tmp|stale)-[0-9a-f]+$/.test(name)) {
        try { if (Date.now() - statSync(join(ctx.dir, name)).mtimeMs > DEBRIS_MAX_AGE_MS) tryUnlink(join(ctx.dir, name)); } catch { /* gone */ }
        continue;
      }
      // Orphan sidecars (a worker tick landing after its lease was removed).
      const m = /^lease-([0-9a-f]+)\.hb$/.exec(name);
      if (!m || leaseIds.has(m[1])) continue;
      try { if (Date.now() - statSync(join(ctx.dir, name)).mtimeMs > 300_000) tryUnlink(join(ctx.dir, name)); } catch { /* gone */ }
    }
  }
  leases.sort((a, b) => num(a.startedAt) - num(b.startedAt) || num(a.pid) - num(b.pid));
  tickets.sort((a, b) => num(a.createdAt) - num(b.createdAt) || num(a.pid) - num(b.pid) || (a.id < b.id ? -1 : 1));
  return { leases, tickets, stale: staleEntries, reclaimed, legacy };
}

// Live holders of the pre-budget run mutex (scripts/ci-lock.mjs, removed in
// 0.31.18): a worktree that has not been rebased yet still takes it and never
// asks this budget. Each live slot counts as one full run at the default
// concurrency, so an old run and a new run cannot flood the box together.
// Read-only: this never touches that directory.
function readLegacy(ctx) {
  const out = [];
  let names = [];
  try { names = readdirSync(ctx.legacyDir); } catch { return out; }
  for (const name of names) {
    if (!/^slot-\d+\.lock$/.test(name)) continue;
    let d = null;
    try { d = JSON.parse(readFileSync(join(ctx.legacyDir, name), 'utf8')); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    if (!ctx.isAlive(num(d.pid)) || ctx.now() - num(d.startedAt) > LEGACY_MAX_AGE_MS) continue;
    out.push({ pid: num(d.pid), worktree: typeof d.worktree === 'string' ? d.worktree : '', startedAt: num(d.startedAt) });
  }
  return out;
}

export function totals(ctx, state) {
  let held = state.legacy.length * ctx.legacyUnits; let heavyHeld = 0; let fullCount = 0;
  for (const l of state.leases) {
    held += charge(ctx, l);
    heavyHeld += l.heavy;
    if (l.kind === 'full') fullCount += 1;
  }
  return { held, heavyHeld, fullCount };
}

// ---------------------------------------------------------------- admission mutex

function withAdmit(ctx, fn) {
  const file = join(ctx.dir, 'admit.lock');
  const token = newId();
  for (let tries = 0; ; tries += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid: ctx.pid, at: ctx.now(), token }), { flag: 'wx' });
      break;
    } catch (err) {
      // EPERM/EBUSY can be a file pending deletion on Windows: retry a few
      // times; a directory that really cannot be written fails open upstream.
      if (err.code !== 'EEXIST' && !(ADMIT_RETRY_CODES.includes(err.code) && tries < 10)) throw err;
      if (err.code !== 'EEXIST') { ctx.sleep(5 + tries * 5); continue; }
    }
    const h = readJson(file);
    let dead;
    if (h) dead = !ctx.isAlive(h.pid) || ctx.now() - num(h.at) > ADMIT_STALE_MS;
    else { try { dead = Date.now() - statSync(file).mtimeMs > ADMIT_STALE_MS; } catch { dead = false; } }
    if (dead) { dropFile(file); continue; }
    ctx.sleep(5 + (tries % 5) * 5);
  }
  try {
    return fn();
  } finally {
    const h = readJson(file);
    if (h && h.token === token) tryUnlink(file);
  }
}

// ---------------------------------------------------------------- cleanup registry

const cleanups = new Set();
let hooksInstalled = false;

export function releaseAll() {
  for (const fn of [...cleanups]) {
    try { fn(); } catch { /* best effort */ }
  }
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', releaseAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      releaseAll();
      // If we are the only listener, node's default (exit) is gone: do it ourselves.
      if (process.listenerCount(sig) <= 1) process.exit(code);
    };
    process.on(sig, handler);
  }
}

function register(ctx, fn) {
  if (ctx.registerExit) installHooks();
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

// ---------------------------------------------------------------- leases

// Each tick rewrites the sidecar and, if the lease file has been reclaimed while
// this process was frozen (a laptop sleep), puts the lease back from the record
// the main thread last sent.
// `flags` is a shared Int32Array: [0] = release requested, [1] = a tick is in
// progress. The tick sets [1] BEFORE it looks at [0]; release() sets [0] BEFORE
// it looks at [1]. Atomics are sequentially consistent, so at least one side
// sees the other: either the tick sees the release and does nothing, or release()
// sees the tick and waits for it to finish. Either way no tick can write (or
// restore) the lease file after release() has begun to remove it.
const HB_WORKER_SRC = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const flags = new Int32Array(workerData.flags);
let rec = workerData.rec;
parentPort.on('message', (m) => { if (m && !m.stop) rec = m; });
const tick = () => {
  Atomics.store(flags, 1, 1);
  try {
    if (Atomics.load(flags, 0) === 1) return;
    try { fs.writeFileSync(workerData.hbFile, String(Date.now())); } catch {}
    if (!fs.existsSync(workerData.leaseFile)) {
      try { fs.writeFileSync(workerData.leaseFile, JSON.stringify(Object.assign({}, rec, { heartbeatAt: Date.now() })), { flag: 'wx' }); } catch {}
    }
  } finally {
    Atomics.store(flags, 1, 0);
    Atomics.notify(flags, 1);
  }
};
tick();
setInterval(tick, workerData.ms);
`;

const STOP_WAIT_MS = 5000;

// The heartbeat lives in a worker THREAD because ci-local blocks the main
// thread in spawnSync for minutes at a time; a main-thread timer would not fire.
// Returns {stop() -> Promise, stopSync(), setRecord(rec)}. stopSync() blocks
// until no tick is in progress and none can start (see HB_WORKER_SRC), so the
// caller may then remove the lease files for good; stop() also ends the thread.
function startHeartbeat(ctx, { leaseFile, hbFile, rec, beat }) {
  const none = { stop: () => Promise.resolve(), stopSync() {}, setRecord() {} };
  if (!(ctx.heartbeatMs > 0) || ctx.heartbeat === 'off') return none;
  if (ctx.heartbeat === 'worker') {
    try {
      const flags = new Int32Array(new SharedArrayBuffer(8));
      const w = new Worker(HB_WORKER_SRC, {
        eval: true, workerData: { leaseFile, hbFile, ms: ctx.heartbeatMs, rec, flags: flags.buffer },
      });
      w.on('error', (err) => ctx.log(`ci-budget: heartbeat thread failed (${err.message}); the lease may be reclaimed as stale`));
      w.unref();
      const stopSync = () => {
        Atomics.store(flags, 0, 1);
        const deadline = Date.now() + STOP_WAIT_MS;
        while (Atomics.load(flags, 1) === 1 && Date.now() < deadline) Atomics.wait(flags, 1, 1, 20);
      };
      return {
        stopSync,
        stop: () => { stopSync(); return w.terminate().catch(() => {}); },
        setRecord: (r) => { try { w.postMessage({ ...r }); } catch { /* gone */ } },
      };
    } catch { /* fall through to the timer */ }
  }
  const t = setInterval(beat, ctx.heartbeatMs);
  t.unref();
  return { stop: () => { clearInterval(t); return Promise.resolve(); }, stopSync: () => clearInterval(t), setRecord() {} };
}

function noopLease(ctx, units, kind) {
  const lease = {
    id: 'off', kind, units, heavy: 0, workers: units, charge: units, waitedMs: 0, off: true,
    beat() {}, release() {},
    resize(spec) {
      const s = typeof spec === 'number' ? { units: spec } : spec;
      lease.units = s.units ?? lease.units; lease.heavy = s.heavy ?? lease.heavy;
      lease.workers = lease.units + lease.heavy;
      return { units: lease.units, heavy: lease.heavy };
    },
  };
  return lease;
}

function createLease(ctx, { kind, units, heavy = 0, label = '', waitedMs = 0 }) {
  const id = newId();
  const file = join(ctx.dir, `lease-${id}.json`);
  const hbFile = join(ctx.dir, `lease-${id}.hb`);
  const t0 = ctx.now();
  const rec = {
    id, pid: ctx.pid, startedAt: t0, heartbeatAt: t0, repo: ctx.repo, worktree: ctx.worktree, kind,
    units, heavy, heavyCost: ctx.heavyCost, label,
  };
  writeFileSync(file, JSON.stringify(rec), { flag: 'wx' });
  try { writeFileSync(hbFile, String(t0)); } catch { /* best effort: heartbeatAt in the lease still counts */ }
  let released = false;
  let unmanaged = false;

  const beat = () => {
    if (released) return;
    try { writeFileSync(hbFile, String(ctx.now())); } catch { /* best effort */ }
    if (!existsSync(file)) { // reclaimed while we were frozen (a laptop sleep): put it back
      try { writeFileSync(file, JSON.stringify({ ...rec, heartbeatAt: ctx.now() }), { flag: 'wx' }); } catch { /* raced */ }
    }
  };
  const heartbeat = startHeartbeat(ctx, { leaseFile: file, hbFile, rec: { ...rec }, beat });

  const lease = {
    id, kind, dir: ctx.dir, waitedMs,
    get units() { return rec.units; },
    get heavy() { return rec.heavy; },
    get workers() { return rec.units + rec.heavy; },
    get charge() { return charge(ctx, rec); },
    get released() { return released; },
    beat,
    release() {
      if (released) return;
      released = true;
      unregister();
      // Release wins: first stop the heartbeat thread from ever writing again
      // (waiting out a tick that is already under way), then remove the files.
      // Nothing can put the lease back after this. The thread itself is ended
      // in the background; it has nothing left to do.
      heartbeat.stopSync();
      tryUnlink(file);
      tryUnlink(hbFile);
      heartbeat.stop();
    },
    /**
     * Change this lease's size. `spec` is a number (plain units) or
     * {units, heavy, label}. A shrink applies at once. A grow goes through
     * admission against what is free (external load counted); heavy workers
     * are also bound by the machine-wide heavy cap. A lease never drops below
     * one worker. With {wait: true} it keeps polling until every requested lane
     * (plain, heavy) has at least one worker; without, it takes what it can
     * get now. Returns {units, heavy}, what it now holds.
     */
    resize(spec, { wait = false } = {}) {
      if (released) throw new Error('ci-budget: resize on a released lease');
      const s = typeof spec === 'number' ? { units: spec } : { ...spec };
      const want = {
        units: Math.max(0, Math.trunc(s.units ?? rec.units)),
        heavy: Math.max(0, Math.trunc(s.heavy ?? rec.heavy)),
      };
      if (s.label !== undefined) rec.label = String(s.label);
      if (want.units + want.heavy === 0) want.units = 1;
      if (!unmanaged) {
        try {
          return managedResize(want, wait);
        } catch (err) {
          if (err.code === 'EBUDGETTIMEOUT') throw err;
          degrade(err);
        }
      }
      // Fail open: the ledger broke mid-run. Grant the ask (heavy still capped).
      rec.units = want.units; rec.heavy = Math.min(want.heavy, ctx.heavyMax);
      if (rec.units + rec.heavy === 0) rec.units = 1;
      return { units: rec.units, heavy: rec.heavy };
    },
  };

  // The ledger failed (a read-only directory, EPERM, a throwing sampler): say so
  // once, drop what we wrote, and run unmanaged from here on.
  function degrade(err) {
    if (unmanaged) return;
    unmanaged = true;
    ctx.log(`ci-budget: the ledger failed (${err.code || err.message}); this run goes on without the budget.`);
    try { heartbeat.stopSync(); } catch { /* best effort */ }
    tryUnlink(file);
    tryUnlink(hbFile);
    heartbeat.stop();
  }

  function managedResize(want, wait) {
    const begin = ctx.now();
    let lastAnnounce = -Infinity;
    for (;;) {
      const grows = want.units > rec.units || want.heavy > rec.heavy;
      const external = grows ? measureExternal(ctx) : 0;
      const satisfied = (g) => (want.heavy === 0 || g.heavy >= 1) && (want.units === 0 || g.units >= 1);
      const done = withAdmit(ctx, () => {
        const state = readState(ctx, { reclaim: true });
        const mine = state.leases.find((l) => l.id === id);
        const t = totals(ctx, state);
        const ownCharge = mine ? charge(ctx, mine) : 0;
        const ownHeavy = mine ? mine.heavy : 0;
        const keep = { units: Math.min(want.units, rec.units), heavy: Math.min(want.heavy, rec.heavy) };
        let free = ctx.budget - (t.held - ownCharge) - external - (keep.units + keep.heavy * ctx.heavyCost);
        const heavyRoom = ctx.heavyMax - (t.heavyHeld - ownHeavy) - keep.heavy;
        let addHeavy = 0;
        if (want.heavy > keep.heavy) {
          addHeavy = Math.max(0, Math.min(want.heavy - keep.heavy, heavyRoom, Math.floor(free / ctx.heavyCost)));
          // Alone on the box (nothing else is held), as in acquireFull: always
          // progress, however much outside load there is.
          if (addHeavy === 0 && heavyRoom >= 1 && t.held - ownCharge <= 0) addHeavy = 1;
          free -= addHeavy * ctx.heavyCost;
        }
        let addUnits = 0;
        if (want.units > keep.units) addUnits = Math.max(0, Math.min(want.units - keep.units, free));
        let got = { units: keep.units + addUnits, heavy: keep.heavy + addHeavy };
        if (wait && want.heavy > 0 && got.heavy === 0) {
          // Waiting for a heavy slot: hold NOTHING meanwhile. A waiter that kept
          // its floor unit would starve the other waiters on a small budget
          // (each leaves the other too little room) and none would be granted.
          got = { units: 0, heavy: 0 };
        } else if (got.units + got.heavy === 0) got.units = 1; // never below one worker (<= what it held)
        rec.units = got.units; rec.heavy = got.heavy; rec.heartbeatAt = ctx.now();
        writeAtomic(ctx, file, rec);
        heartbeat.setRecord(rec);
        try { writeFileSync(hbFile, String(ctx.now())); } catch { /* best effort */ }
        return satisfied(got);
      });
      if (done || !wait) return { units: rec.units, heavy: rec.heavy };
      if (ctx.now() - begin >= ctx.heavyMaxWaitMs) { // no unbounded wait: go on with one heavy worker
        withAdmit(ctx, () => {
          rec.heavy = want.heavy > 0 ? 1 : rec.heavy;
          rec.units = want.units > 0 ? Math.max(rec.units, 1) : rec.units;
          if (rec.units + rec.heavy === 0) rec.units = 1;
          rec.heartbeatAt = ctx.now();
          writeAtomic(ctx, file, rec);
          heartbeat.setRecord(rec);
        });
        ctx.log(`ci-budget: waited ${Math.round((ctx.now() - begin) / 1000)} s for a heavy-lane slot; `
          + `running the heavy files with one heavy worker anyway (CI_LOCAL_HEAVY_MAX_WAIT_MS=${ctx.heavyMaxWaitMs}).`);
        return { units: rec.units, heavy: rec.heavy };
      }
      if (ctx.now() - begin >= ctx.timeoutMs) {
        const e = new Error('ci-budget: timed out waiting for a heavy-lane slot');
        e.code = 'EBUDGETTIMEOUT';
        throw e;
      }
      if (ctx.now() - lastAnnounce >= ctx.announceMs) {
        lastAnnounce = ctx.now();
        ctx.log(`ci-budget: waiting for a heavy-lane slot (cap ${ctx.heavyMax} heavy workers machine-wide, `
          + `cost ${ctx.heavyCost} units each); checking every ${(ctx.pollMs / 1000).toFixed(1)} s.`);
      }
      ctx.sleep(ctx.pollMs);
    }
  }
  const unregister = register(ctx, () => lease.release());
  return lease;
}

// ---------------------------------------------------------------- acquire

function timeoutError() {
  const e = new Error('ci-budget: timed out waiting for the budget');
  e.code = 'EBUDGETTIMEOUT';
  return e;
}

function describe(ctx, st, external) {
  const t = totals(ctx, st);
  return `budget ${ctx.budget}, held ${t.held}, outside load ~${external}, free ${Math.max(0, ctx.budget - t.held - external)}`;
}

function acquireFull(ctx, opts) {
  const desired = Math.max(1, Math.trunc(opts.desired ?? ctx.budget));
  const begin = ctx.now();
  const id = newId();
  const ticketFile = join(ctx.dir, `ticket-${id}.json`);
  const ticket = {
    id, pid: ctx.pid, createdAt: begin, heartbeatAt: begin, repo: ctx.repo, worktree: ctx.worktree, kind: 'full', desired,
  };
  writeFileSync(ticketFile, JSON.stringify(ticket), { flag: 'wx' });
  const unregister = register(ctx, () => tryUnlink(ticketFile));
  let lastAnnounce = -Infinity;
  let announced = false;
  let external = 0;
  try {
    for (;;) {
      const state = readState(ctx, { reclaim: true });
      for (const r of state.reclaimed) {
        ctx.log(`ci-budget: reclaimed a stale ${r.type} (${r.why}); it belonged to pid ${r.pid} in ${r.worktree}`);
      }
      let pos = state.tickets.findIndex((t) => t.id === id);
      if (pos < 0) { // our ticket was reclaimed during a freeze: put it back, keeping its place
        try { writeFileSync(ticketFile, JSON.stringify({ ...ticket, heartbeatAt: ctx.now() }), { flag: 'wx' }); } catch { /* raced */ }
        pos = state.tickets.filter((t) => num(t.createdAt) <= ticket.createdAt).length;
      } else if (ctx.now() - ticket.heartbeatAt > ctx.staleMs / 4) {
        ticket.heartbeatAt = ctx.now();
        writeAtomic(ctx, ticketFile, ticket);
      }
      let why = '';
      if (pos === 0) {
        const t = totals(ctx, state);
        if (t.fullCount >= ctx.maxFull) {
          why = `${t.fullCount} full run(s) already going (CI_LOCAL_MAX_PARALLEL=${ctx.maxFull})`;
        } else {
          external = measureExternal(ctx);
          const got = withAdmit(ctx, () => {
            const s = readState(ctx, { reclaim: true });
            if (!s.tickets.length || s.tickets[0].id !== id) return null;
            const tt = totals(ctx, s);
            if (tt.fullCount >= ctx.maxFull) return null;
            let free = ctx.budget - tt.held - external;
            if (tt.held === 0) free = Math.max(free, 1); // alone on the box: always progress
            if (free < 1) return null;
            const units = Math.min(desired, Math.floor(free));
            const lease = createLease(ctx, {
              kind: 'full', units, label: opts.label ?? '', waitedMs: ctx.now() - begin,
            });
            tryUnlink(ticketFile);
            return { lease, free };
          });
          if (got) {
            unregister();
            if (announced || got.lease.units < desired) {
              ctx.log(`ci-budget: starting with ${got.lease.units} of ${desired} workers `
                + `(waited ${Math.round((ctx.now() - begin) / 1000)} s; ${describe(ctx, readState(ctx, { reclaim: false }), external)})`);
            }
            return got.lease;
          }
          why = describe(ctx, state, external);
        }
      } else {
        const head = state.tickets[0] ?? {};
        why = `queue position ${pos + 1} of ${state.tickets.length}; head is pid ${head.pid} in ${head.worktree}`;
      }
      if (ctx.now() - begin >= ctx.queueMaxWaitMs) { // no unbounded wait: go on with one worker, over budget
        const lease = withAdmit(ctx, () => {
          const l = createLease(ctx, { kind: 'full', units: 1, label: opts.label ?? '', waitedMs: ctx.now() - begin });
          tryUnlink(ticketFile);
          return l;
        });
        unregister();
        ctx.log(`ci-budget: waited ${Math.round((ctx.now() - begin) / 1000)} s in the queue (${why}); `
          + `starting with 1 worker, over budget (CI_LOCAL_QUEUE_MAX_WAIT_MS=${ctx.queueMaxWaitMs}).`);
        return lease;
      }
      if (ctx.now() - begin >= ctx.timeoutMs) throw timeoutError();
      if (ctx.now() - lastAnnounce >= ctx.announceMs) {
        lastAnnounce = ctx.now();
        announced = true;
        ctx.log(`ci-budget: waiting (${why}). Checking every ${(ctx.pollMs / 1000).toFixed(1)} s; this line repeats `
          + `every ${Math.round(ctx.announceMs / 1000)} s. CI_LOCAL_LOCK=0 skips the budget.`);
      }
      ctx.sleep(ctx.pollMs);
    }
  } finally {
    tryUnlink(ticketFile);
    unregister();
  }
}

function acquireExpress(ctx, opts) {
  const begin = ctx.now();
  let lastAnnounce = -Infinity;
  for (;;) {
    const lease = withAdmit(ctx, () => {
      const s = readState(ctx, { reclaim: true });
      const t = totals(ctx, s);
      if (t.held + 1 > ctx.budget + ctx.express) return null;
      return createLease(ctx, { kind: 'targeted', units: 1, label: opts.label ?? '', waitedMs: ctx.now() - begin });
    });
    if (lease) return lease;
    if (ctx.now() - begin >= ctx.expressMaxWaitMs) { // no unbounded wait: go on over budget
      const forced = withAdmit(ctx, () => createLease(ctx, {
        kind: 'targeted', units: 1, label: opts.label ?? '', waitedMs: ctx.now() - begin,
      }));
      ctx.log(`ci-budget: waited ${Math.round((ctx.now() - begin) / 1000)} s at the express headroom; `
        + `starting with 1 worker, over budget (CI_LOCAL_EXPRESS_MAX_WAIT_MS=${ctx.expressMaxWaitMs}).`);
      return forced;
    }
    if (ctx.now() - begin >= ctx.timeoutMs) throw timeoutError();
    if (ctx.now() - lastAnnounce >= ctx.announceMs) {
      lastAnnounce = ctx.now();
      ctx.log(`ci-budget: the machine is at its budget plus express headroom (${ctx.express}); a targeted run waits, `
        + `without taking a queue ticket. CI_LOCAL_LOCK=0 skips the budget.`);
    }
    ctx.sleep(ctx.pollMs);
  }
}

/**
 * Take a lease. Blocks (synchronously: ci-local runs its suites with spawnSync)
 * until admitted; never fails.
 *
 * opts: kind 'full' (default) | 'targeted'; desired (full: plain workers wanted,
 * default the whole budget); label; repo (a label shown in status; default
 * $CI_BUDGET_REPO, else the basename of the git top-level directory above the
 * worktree, see repoLabel()); worktree; env; plus overrides and test seams:
 * dir, budget, heavyCost, heavyMax, express, maxFull, pollMs, staleMs, heartbeatMs, heavyMaxWaitMs, queueMaxWaitMs, expressMaxWaitMs,
 * announceMs, now(), sleep(ms), isAlive(pid), sampler() -> busy cores, log(line),
 * pid, timeoutMs, registerExit, heartbeat ('worker' | 'timer' | 'off'), off.
 *
 * Returns a lease: {id, kind, units, heavy, workers, charge, waitedMs,
 * beat(), resize(spec, {wait}), release()}. With CI_LOCAL_LOCK=0 (or off: true) it
 * returns a no-op lease granting `desired` and touches no files.
 */
export function acquire(opts = {}) {
  const ctx = makeCtx(opts);
  const kind = opts.kind === 'targeted' ? 'targeted' : 'full';
  const asked = kind === 'targeted' ? 1 : Math.max(1, Math.trunc(opts.desired ?? ctx.budget));
  if (ctx.off) return noopLease(ctx, asked, kind);
  try {
    mkdirSync(ctx.dir, { recursive: true });
  } catch (err) { // never fail a run over the ledger: say so and run unmanaged
    ctx.log(`ci-budget: the ledger directory ${ctx.dir} is unusable (${err.code || err.message}); running without the budget.`);
    return noopLease(ctx, asked, kind);
  }
  try {
    return kind === 'targeted' ? acquireExpress(ctx, opts) : acquireFull(ctx, opts);
  } catch (err) {
    // Fail open on any ledger or sampler error (a directory that exists but is
    // read-only, EPERM, EACCES, a throwing cpu sampler): one line, no crash.
    if (err.code === 'EBUDGETTIMEOUT') throw err;
    ctx.log(`ci-budget: the ledger failed (${err.code || err.message}); running without the budget.`);
    return noopLease(ctx, asked, kind);
  }
}

// ---------------------------------------------------------------- status

/** Non-mutating snapshot of the ledger. `sample: false` skips the 300 ms cpu sample. */
export function status(opts = {}) {
  const ctx = makeCtx({ ...opts, log: opts.log ?? (() => {}) });
  const state = readState(ctx, { reclaim: false });
  const t = totals(ctx, state);
  const now = ctx.now();
  let busyCores = null; let external = 0;
  if (opts.sample !== false) {
    try {
      busyCores = Number(ctx.sampler());
      external = Math.max(0, Math.round(busyCores - totals(ctx, readState(ctx, { reclaim: false })).held));
    } catch { /* sampling is best effort */ }
  }
  const age = (ms) => Math.max(0, now - num(ms));
  return {
    dir: ctx.dir, cores: ctx.cores, budget: ctx.budget, heavyCost: ctx.heavyCost, heavyMax: ctx.heavyMax,
    express: ctx.express, maxFull: Number.isFinite(ctx.maxFull) ? ctx.maxFull : null,
    held: t.held, heavyHeld: t.heavyHeld, free: Math.max(0, ctx.budget - t.held - external),
    busyCores: busyCores === null ? null : Math.round(busyCores * 10) / 10, external,
    leases: state.leases.map((l) => ({
      id: l.id, kind: l.kind, pid: l.pid, repo: l.repo || '', worktree: l.worktree, units: l.units, heavy: l.heavy,
      workers: l.units + l.heavy, charge: charge(ctx, l), label: l.label || '',
      ageMs: age(l.startedAt), heartbeatAgeMs: age(Math.max(num(l.heartbeatAt), num(l.hbSide))),
    })),
    queue: state.tickets.map((q, i) => ({
      position: i + 1, pid: q.pid, repo: q.repo || '', worktree: q.worktree, desired: q.desired, waitedMs: age(q.createdAt),
    })),
    stale: state.stale.map((s) => ({ type: s.type, pid: s.pid, worktree: s.worktree, why: s.stale })),
    legacy: state.legacy.map((l) => ({ ...l, units: ctx.legacyUnits })),
  };
}

function dur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export function formatStatus(st) {
  const lines = [];
  lines.push(`CI budget: ${st.budget} units (${st.cores} cores); held ${st.held}, free ${st.free}`);
  lines.push(`  heavy lane: ${st.heavyHeld}/${st.heavyMax} heavy workers, ${st.heavyCost} units each; express headroom +${st.express}`
    + (st.maxFull ? `; at most ${st.maxFull} full runs` : ''));
  lines.push(st.busyCores === null
    ? '  outside load: not sampled'
    : `  outside load: ~${st.external} cores (cpu busy ${st.busyCores} cores, minus our held units)`);
  lines.push(`  ledger: ${st.dir}`);
  lines.push('');
  lines.push(`Holders (${st.leases.length}):`);
  if (!st.leases.length) lines.push('  none');
  for (const l of st.leases) {
    lines.push(`  ${l.kind.padEnd(8)} pid ${String(l.pid).padEnd(7)} workers ${l.workers} (plain ${l.units}, heavy ${l.heavy}; cost ${l.charge})`
      + `  age ${dur(l.ageMs)}  heartbeat ${dur(l.heartbeatAgeMs)} ago  ${l.repo ? `${l.repo} ` : ''}${l.worktree}${l.label ? `  [${l.label}]` : ''}`);
  }
  lines.push('');
  lines.push(`Queue (${st.queue.length}):`);
  if (!st.queue.length) lines.push('  empty');
  for (const q of st.queue) {
    lines.push(`  #${q.position} pid ${String(q.pid).padEnd(7)} wants ${q.desired}  waiting ${dur(q.waitedMs)}  ${q.repo ? `${q.repo} ` : ''}${q.worktree}`);
  }
  if (st.stale.length) {
    lines.push('');
    lines.push(`Stale (dropped by the next run): ${st.stale.map((s) => `${s.type} pid ${s.pid} (${s.why})`).join('; ')}`);
  }
  if (st.legacy.length) {
    lines.push('');
    lines.push(`Old run lock still held (a worktree on 0.31.17 or earlier; each counts as ${st.legacy[0].units} units): ${st.legacy.map((l) => `pid ${l.pid} ${l.worktree}`).join('; ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'status' || rest.some((a) => !['--json', '--no-sample'].includes(a))) {
    console.error('usage: node scripts/ci-budget.mjs status [--json] [--no-sample]');
    return 2;
  }
  const st = status({ sample: !rest.includes('--no-sample') });
  console.log(rest.includes('--json') ? JSON.stringify(st, null, 2) : formatStatus(st));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
