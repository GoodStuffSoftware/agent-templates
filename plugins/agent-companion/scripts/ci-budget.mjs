#!/usr/bin/env node
// plugins/agent-companion/scripts/ci-budget.mjs: the machine-wide shared budget and
// resource queue. One implementation, shared by the repo's scripts/ci-local.mjs
// (kinds 'full' and 'targeted'; box units) and the cross-project CLI
// scripts/resource-queue.mjs (kind 'run': box units, named resources, RAM).
// Spec: docs/resource-queue.md (the one spec of the ledger format, the queue, the
// status schema and the sweep rules).
//
// Below is the original design note for ci-local.
//
// Replaces the one-run mutex (scripts/ci-lock.mjs, removed). Several ci-local and
// pre-push runs may go at once; the TOTAL number of test workers across all of
// them, plus load from outside our runs, stays under one budget that scales
// with the machine. A run that finds the box busy starts with fewer workers or
// waits in a fair queue. It never fails.
//
// The lease format and protocol (file names, fields, atomic rules, stale rules,
// units) are specified ONCE, in docs/resource-queue.md (CONTRIBUTING.md, "Shared
// CI budget", points there); other repos follow that spec. Ledger: budgetDir() below (machine-wide, repo-neutral,
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
// Load guard (reserve and re-sample). busy = the sampled busy cores, ours
//   included. The machine is "loaded" when busy > min(cores - reserve, cores *
//   loadPct / 100): fewer than `reserve` cores idle (interactive work and hooks
//   need them), or over loadPct percent busy. A loaded machine admits slowly: a
//   new full lease gets one worker, and a resize grants at most one worker per lane
//   (a lease already larger is cut to one). Every grow re-samples, and a resize
//   with {resample: true} re-samples even when it asks for no more than it holds,
//   which ci-local does between slices of a long pass. Not loaded: admission is
//   as above. See also lowerOwnPriority().
// Transition: a worktree on 0.31.17 or earlier still takes the old mutex's slot
//   files and never asks this budget. Each live holder counts as one full run at
//   the default concurrency (legacyRunUnits), read-only. See readLegacy().
// Reclaim: a lease or ticket is stale when its pid is not alive OR its
//   heartbeat (the newer of heartbeatAt and the sidecar) is older than staleMs
//   (90 s). Stale entries are removed by whoever notices.

import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, existsSync,
} from 'node:fs';
import {
  BOX, loadRules, capacityOf, ramReserveMb, liveVerdict, appendClear, recentClears, scanStrays, NAME_RE,
} from './lib/resource-rules.mjs';
import { join, basename, dirname, resolve } from 'node:path';
import {
  tmpdir, availableParallelism, cpus, constants as osConstants, getPriority, setPriority, freemem, totalmem,
} from 'node:os';
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
export const DEFAULT_LOAD_PCT = 90; // busy share of the cores above which admission slows
export const DEFAULT_SLICE_FILES = 6; // test files per worker in one slice of a long pass
export const DEFAULT_QUEUE_MAX_WAIT_MS = 30 * 60_000; // a full run's queue wait
export const DEFAULT_EXPRESS_MAX_WAIT_MS = 5 * 60_000; // a targeted run's wait
const LEGACY_MAX_AGE_MS = 45 * 60 * 1000; // the old mutex's own age cap
const ADMIT_STALE_MS = 10_000;
const DEBRIS_MAX_AGE_MS = 600_000; // *.tmp-* / *.stale-* left by a crash between write and rename
const ADMIT_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
export const MAX_RESERVATION_MS = 4 * 3600_000; // a reservation never lasts longer than this
export const MAX_PAUSE_MS = 4 * 3600_000; // nor does a hold on one's own queued entries

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

// The project a path belongs to: like repoLabel, but a linked worktree (its .git
// is a file reading "gitdir: <main>/.git/worktrees/<name>") names the MAIN
// checkout, so every worktree of one repo shows the same project. Only fs calls.
export function projectLabel(start) {
  const from = resolve(start || process.cwd());
  for (let d = from; ;) {
    const g = join(d, '.git');
    if (existsSync(g)) {
      try {
        if (statSync(g).isFile()) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(g, 'utf8'));
          if (m) {
            const gd = resolve(d, m[1]).split(/[\\/]/);
            const i = gd.lastIndexOf('worktrees');
            if (i > 1 && gd[i - 1] === '.git') return gd[i - 2] || basename(d);
          }
        }
      } catch { /* fall back to the directory name */ }
      return basename(d) || 'unknown';
    }
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

// Cores kept idle for interactive work and hooks: an eighth of the machine, at least one.
export function defaultReserve(cores) {
  return Math.max(1, Math.round(cores / 8));
}

// The busy-core count above which the machine counts as loaded and admission
// slows: the tighter of "fewer than `reserve` cores idle" and "more than
// `loadPct` percent busy".
export function overloadThreshold({ cores, reserve, loadPct }) {
  return Math.min(cores - reserve, (cores * loadPct) / 100);
}

// Run the calling process, and so every child it spawns, below normal priority
// (children inherit the class on Windows and the nice value elsewhere), so that
// interactive work and hooks win the cpu when tests compete with them. Never
// raises a process that is already nicer, never throws, logs nothing.
// Returns 'lowered' | 'kept' | 'failed'. `os` is a test seam.
export function lowerOwnPriority(os = { getPriority, setPriority, constants: osConstants }) {
  try {
    const target = os.constants.priority.PRIORITY_BELOW_NORMAL;
    if (!Number.isInteger(target)) return 'failed';
    if (os.getPriority(0) >= target) return 'kept';
    os.setPriority(0, target);
    return 'lowered';
  } catch {
    return 'failed';
  }
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
  const reserve = Math.min(posInt(env, 'CI_LOCAL_RESERVE', defaultReserve(cores), warnings, { min: 0 }), Math.max(0, cores - 1));
  const loadPct = Math.min(100, posInt(env, 'CI_LOCAL_LOAD_PCT', DEFAULT_LOAD_PCT, warnings));
  const sliceFactor = posInt(env, 'CI_LOCAL_SLICE', DEFAULT_SLICE_FILES, warnings, { min: 0 });
  return {
    off, cores, budget, heavyCost, heavyMax, express, maxFull, pollMs, staleMs, heavyMaxWaitMs, queueMaxWaitMs, expressMaxWaitMs,
    reserve, loadPct, sliceFactor,
    heartbeatMs: DEFAULT_HEARTBEAT_MS, announceMs: DEFAULT_ANNOUNCE_MS, sampleMs: DEFAULT_SAMPLE_MS,
    dir: budgetDir(env), warnings,
  };
}

const CTX_KEYS = [
  'dir', 'budget', 'heavyCost', 'heavyMax', 'express', 'maxFull', 'pollMs', 'staleMs',
  'heartbeatMs', 'announceMs', 'sampleMs', 'off', 'legacyDir', 'legacyUnits', 'heavyMaxWaitMs',
  'queueMaxWaitMs', 'expressMaxWaitMs', 'reserve', 'loadPct', 'sliceFactor', 'rules', 'session', 'project', 'freemem', 'totalmem', 'delay',
];

// Environment config, then explicit options on top, plus the injectable seams.
function makeCtx(o = {}) {
  const cfg = resolveBudgetConfig(o.env ?? process.env, { cores: o.cores ?? availableParallelism() });
  const ctx = { ...cfg };
  for (const k of CTX_KEYS) if (o[k] !== undefined) ctx[k] = o[k];
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
  ctx.env = o.env ?? process.env;
  ctx.rules ??= loadRules(ctx.env);
  ctx.session = o.session ?? (ctx.env.CLAUDE_CODE_SESSION_ID || '');
  ctx.project = o.project ?? projectLabel(ctx.worktree);
  ctx.freemem = o.freemem ?? freemem;
  ctx.totalmem = o.totalmem ?? totalmem;
  ctx.delay = o.delay ?? ((ms) => new Promise((r) => { setTimeout(r, ms); }));
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

// One fresh sample of the machine: `busy` cores (ours included), `external` (the
// busy cores our held units do not explain) and `over` (busy is above the load
// threshold: fewer than `reserve` cores idle, or more than `loadPct` percent busy).
function measureLoad(ctx) {
  const busy = Number(ctx.sampler());
  const held = totals(ctx, readState(ctx, { reclaim: false })).held;
  if (!Number.isFinite(busy)) return { busy: NaN, external: 0, over: false };
  const at = overloadThreshold(ctx);
  return { busy, external: Math.max(0, Math.round(busy - held)), over: busy > at };
}

function measureExternal(ctx) {
  return measureLoad(ctx).external;
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
  // A pid-bound lease (a daemon such as an emulator) lives exactly as long as the
  // bound pid: its wrapper has gone, so there is no heartbeat to expire.
  if (e.boundPid > 0) return ctx.isAlive(e.boundPid) ? null : 'process is gone';
  if (!ctx.isAlive(e.pid)) return 'process is gone';
  const hb = Math.max(num(e.heartbeatAt), num(e.hbSide), num(e.startedAt), num(e.createdAt));
  if (ctx.now() - hb > ctx.staleMs) return 'heartbeat is stale';
  return null;
}

// Named resources of a record: { name: units }, only valid names and units >= 1.
function normResources(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) {
      const u = Math.trunc(num(n));
      if (k !== BOX && NAME_RE.test(k) && u >= 1) out[k] = u;
    }
  }
  return out;
}

// The activity sidecar of a monitored run lease: "<sampledAt> <activeAt>" in epoch ms.
function readAct(file) {
  try {
    const [a, b] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
    return Number.isFinite(a) && Number.isFinite(b) ? { sampledAt: a, activeAt: b } : null;
  } catch { return null; }
}

function ruleFor(why, type) {
  if (why === 'process is gone') return type === 'ticket' ? 'requester-gone' : 'pid-dead';
  return type === 'ticket' ? 'ticket-heartbeat-stale' : 'heartbeat-stale';
}

// One record per cleared entry: the rules (data: config/resource-rules.json) say
// which entries are dead; this writes the evidence down. Never kills anything.
function noteClear(ctx, e, type, rule, evidence) {
  appendClear(ctx.dir, {
    at: Date.now(), rule, type, id: e.id, pid: e.pid, label: e.label || '', project: e.project || '',
    repo: e.repo || '', worktree: e.worktree || '', session: e.session || '',
    resources: { ...(e.units > 0 ? { [BOX]: e.units } : {}), ...(e.resources ?? {}) }, evidence,
  });
}

const charge = (ctx, l) => l.units + l.heavy * (l.heavyCost ?? ctx.heavyCost);

// ---------------------------------------------------------------- reservations and holds

// reservation-<id>.json: {id, resource, forGroup, owner:{pid, session}, createdAt, expiresAt, reason}.
// Valid only with a resource, a group, a creation time and an expiry; the effective
// end is min(expiresAt, createdAt + 4 h), so no file can reserve for longer than 4 h.
function readReservation(ctx, id, file, d) {
  const created = num(d.createdAt); const expires = num(d.expiresAt);
  const owner = d.owner && typeof d.owner === 'object' ? d.owner : {};
  const r = {
    id, file, resource: typeof d.resource === 'string' ? d.resource : '', forGroup: typeof d.forGroup === 'string' ? d.forGroup : '',
    owner: { pid: Math.max(0, Math.trunc(num(owner.pid))), session: typeof owner.session === 'string' ? owner.session : '' },
    createdAt: created, expiresAt: expires, reason: typeof d.reason === 'string' ? d.reason : '',
  };
  r.endsAt = created > 0 && expires > 0 ? Math.min(expires, created + MAX_RESERVATION_MS) : 0;
  let rule = null;
  if (!(r.resource === BOX || NAME_RE.test(r.resource)) || !NAME_RE.test(r.forGroup) || !r.endsAt) rule = 'reservation-invalid';
  else if (ctx.now() >= r.endsAt) rule = 'reservation-expired';
  else if (r.owner.pid > 0 && !ctx.isAlive(r.owner.pid)) rule = 'reservation-owner-gone';
  return { r, rule };
}

function noteReservationClear(ctx, r, rule, by = null, extra = null) {
  appendClear(ctx.dir, {
    at: Date.now(), rule, type: 'reservation', id: r.id, pid: r.owner.pid, label: `reserve ${r.resource} for ${r.forGroup}`,
    project: '', repo: '', worktree: '', session: r.owner.session, resources: r.resource ? { [r.resource]: 0 } : {},
    evidence: { forGroup: r.forGroup, createdAt: r.createdAt, expiresAt: r.expiresAt, endsAt: r.endsAt, ...(by ? { by } : {}), ...(extra ?? {}) },
  });
}

// Use-it-or-lose-it: a reservation lapses when no job of its group has held or waited for the
// resource for reservationIdleLapseMinutes (config; default 20; 0 or null = off). The last matching
// activity lives in reservation-<id>.active ({lastMatchAt}), so it survives the wrapper exiting.
export const DEFAULT_RESERVATION_IDLE_LAPSE_MINUTES = 20;
function idleLapseMs(rules) {
  const v = rules?.reservationIdleLapseMinutes;
  const m = v === undefined ? DEFAULT_RESERVATION_IDLE_LAPSE_MINUTES : Number(v);
  return Number.isFinite(m) && m > 0 ? m * 60_000 : 0;
}
const activeFile = (dir, id) => join(dir, `reservation-${id}.active`);
function readLastMatch(dir, id) {
  const d = readJson(activeFile(dir, id));
  return d ? num(d.lastMatchAt) : 0;
}
function writeLastMatch(ctx, id, at) {
  try { writeAtomic(ctx, activeFile(ctx.dir, id), { lastMatchAt: at }); } catch { /* best effort */ }
}
// A job of `group` that used `names` just ended: restart the idle clock of the matching reservations.
function touchReservations(ctx, group, names) {
  if (!group) return;
  let files = [];
  try { files = readdirSync(ctx.dir); } catch { return; }
  for (const name of files) {
    const m = /^reservation-([0-9a-f]+)\.json$/.exec(name);
    const d = m ? readJson(join(ctx.dir, name)) : null;
    if (d && d.forGroup === group && names.includes(d.resource)) writeLastMatch(ctx, m[1], ctx.now());
  }
}
const namesOfLease = (l) => [...(l.units > 0 ? [BOX] : []), ...Object.keys(l.resources ?? {})];

// ticket-<id>.paused: {by, at, until}. A sidecar, so the waiter's own ticket rewrites cannot undo it.
function readPause(ctx, file) {
  const d = readJson(file);
  if (!d) return null;
  const until = Math.min(num(d.until), num(d.at) + MAX_PAUSE_MS);
  return until > ctx.now() ? { by: typeof d.by === 'string' ? d.by : '', at: num(d.at), until } : null;
}

// The reservation (if any) that keeps a request with `group` from taking one of `names` now.
function reservedAgainst(reservations, names, group) {
  for (const n of names) {
    const rs = reservations.filter((r) => r.resource === n);
    if (rs.length && !rs.some((r) => group && r.forGroup === group)) return rs[0];
  }
  return null;
}
const namesOfTicket = (t) => [...(usesBox(t) ? [BOX] : []), ...Object.keys(t.resources ?? {})];
// A ticket that cannot be admitted now for a reason of policy (a hold, or someone else's reservation).
const passedOver = (state, t) => Boolean(t.paused) || Boolean(reservedAgainst(state.reservations ?? [], namesOfTicket(t), t.group));

/**
 * Read the ledger. With reclaim, stale leases and tickets are removed (and
 * returned in `reclaimed`); without it they are listed with a `stale` reason and
 * left alone, and are excluded from the live lists either way.
 */
export function readState(ctx, { reclaim = true } = {}) {
  let names = [];
  try { names = readdirSync(ctx.dir); } catch { /* no ledger yet */ }
  const leases = []; const tickets = []; const staleEntries = []; const reclaimed = []; const reservations = [];
  const leaseIds = new Set(); const ticketIds = new Set(); const endedLeases = [];
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
        project: typeof d.project === 'string' ? d.project : '',
        session: typeof d.session === 'string' ? d.session : '',
        group: typeof d.group === 'string' ? d.group : '', boundPid: Math.max(0, Math.trunc(num(d.boundPid))),
        resources: normResources(d.resources), ramMb: Math.max(0, Math.trunc(num(d.ramMb))),
        units: Math.max(0, Math.trunc(num(d.units))), heavy: Math.max(0, Math.trunc(num(d.heavy))),
        heavyCost: hc >= 1 ? hc : ctx.heavyCost,
      };
      if (e.kind === 'full' && d.kind === 'run') e.kind = 'run';
      e.actFile = join(ctx.dir, `lease-${m[1]}.act`);
      e.act = readAct(e.actFile);
      const why = staleReason(ctx, e);
      leaseIds.add(m[1]);
      if (why) {
        staleEntries.push({ ...e, type: 'lease', stale: why });
        if (reclaim) {
          dropFile(file, hbFile, e.actFile);
          endedLeases.push(e);
          reclaimed.push({ type: 'lease', pid: e.pid, worktree: e.worktree, why });
          noteClear(ctx, e, 'lease', ruleFor(why, 'lease'), { why, pid: e.pid });
        }
      } else {
        // Live pid, fresh heartbeat: the config rules (max-hold, idle) may still clear it.
        // A kept verdict (max-hold on a live, active or unmeasured holder of an exclusive
        // resource) only flags the lease "over time"; it is never released for it.
        const v = liveVerdict(ctx.rules, e, ctx.now());
        if (v?.keep) e.overTime = v.evidence;
        if (v && !v.keep && reclaim) {
          // The tombstone first, so the owner's heartbeat does not put the lease back.
          try { writeFileSync(join(ctx.dir, `lease-${m[1]}.cleared`), String(ctx.now()), { flag: 'wx' }); } catch { /* already marked */ }
          dropFile(file, hbFile, e.actFile);
          endedLeases.push(e);
          reclaimed.push({ type: 'lease', pid: e.pid, worktree: e.worktree, why: `rule ${v.rule}` });
          noteClear(ctx, e, 'lease', v.rule, v.evidence);
          ctx.log(`resource-queue: cleared the lease of pid ${e.pid} (${e.label || e.worktree}) by rule ${v.rule}; the process is not touched.`);
        } else leases.push(e);
      }
      continue;
    }
    m = /^ticket-([0-9a-f]+)\.json$/.exec(name);
    if (m) {
      const file = join(ctx.dir, name);
      const d = readJson(file);
      if (!d) continue;
      const e = {
        ...d, id: m[1], file, pid: num(d.pid),
        kind: d.kind === 'run' ? 'run' : 'full',
        repo: typeof d.repo === 'string' ? d.repo : '',
        worktree: typeof d.worktree === 'string' ? d.worktree : '',
        label: typeof d.label === 'string' ? d.label : '',
        project: typeof d.project === 'string' ? d.project : '',
        session: typeof d.session === 'string' ? d.session : '',
        resources: normResources(d.resources), ramMb: Math.max(0, Math.trunc(num(d.ramMb))),
        boxUnits: Math.max(0, Math.trunc(num(d.boxUnits))),
        desired: Math.max(1, Math.trunc(num(d.desired)) || 1),
        group: typeof d.group === 'string' ? d.group : '',
      };
      delete e.boundPid;
      ticketIds.add(m[1]);
      e.pausedFile = join(ctx.dir, `ticket-${m[1]}.paused`);
      const pause = readPause(ctx, e.pausedFile);
      e.paused = Boolean(pause); e.pausedBy = pause ? pause.by : ''; e.pausedUntil = pause ? pause.until : null;
      const why = staleReason(ctx, e);
      if (why) {
        staleEntries.push({ ...e, type: 'ticket', stale: why });
        if (reclaim) {
          dropFile(file, e.pausedFile); reclaimed.push({ type: 'ticket', pid: e.pid, worktree: e.worktree, why });
          noteClear(ctx, e, 'ticket', ruleFor(why, 'ticket'), { why, pid: e.pid });
        }
      } else tickets.push(e);
      continue;
    }
    m = /^reservation-([0-9a-f]+)\.json$/.exec(name);
    if (m) {
      const file = join(ctx.dir, name);
      const d = readJson(file);
      if (!d) continue;
      const { r, rule } = readReservation(ctx, m[1], file, d);
      if (!rule) { reservations.push(r); continue; }
      staleEntries.push({ ...r, type: 'reservation', stale: rule });
      if (reclaim) {
        dropFile(file, activeFile(ctx.dir, r.id));
        reclaimed.push({ type: 'reservation', pid: r.owner.pid, worktree: '', why: rule });
        noteReservationClear(ctx, r, rule);
      }
    }
  }
  if (reclaim && reservations.length) {
    const lapseMs = idleLapseMs(ctx.rules);
    const now = ctx.now();
    for (const r of [...reservations]) {
      const holdsIt = (e, names) => e.group === r.forGroup && names(e).includes(r.resource);
      let last = readLastMatch(ctx.dir, r.id);
      const live = leases.some((l) => holdsIt(l, namesOfLease)) || tickets.some((t) => holdsIt(t, namesOfTicket));
      const ended = endedLeases.some((l) => holdsIt(l, namesOfLease));
      if (live || ended) {
        if (now - last >= 5000 || now < last) { writeLastMatch(ctx, r.id, now); last = now; }
        continue;
      }
      if (!lapseMs) continue;
      const since = Math.max(r.createdAt, last);
      if (now - since < lapseMs) continue;
      dropFile(r.file, activeFile(ctx.dir, r.id));
      reservations.splice(reservations.indexOf(r), 1);
      reclaimed.push({ type: 'reservation', pid: r.owner.pid, worktree: '', why: 'reservation-idle-lapse' });
      noteReservationClear(ctx, r, 'reservation-idle-lapse', null, {
        idleMinutes: Math.round(((now - since) / 60_000) * 10) / 10, lastMatchAt: since, lapseMinutes: lapseMs / 60_000,
      });
    }
  }
  if (reclaim) {
    for (const name of names) {
      const am = /^reservation-([0-9a-f]+)\.active$/.exec(name);
      if (am && !reservations.some((r) => r.id === am[1])) tryUnlink(join(ctx.dir, name));
    }
    for (const name of names) {
      // Crash debris: a temp file from a crash between write and rename, or a
      // file moved aside and never unlinked. Young ones may be in flight.
      if (/\.(?:tmp|stale)-[0-9a-f]+$/.test(name)) {
        try { if (Date.now() - statSync(join(ctx.dir, name)).mtimeMs > DEBRIS_MAX_AGE_MS) tryUnlink(join(ctx.dir, name)); } catch { /* gone */ }
        continue;
      }
      // Orphan sidecars (a worker tick landing after its lease was removed).
      const pm = /^ticket-([0-9a-f]+)\.paused$/.exec(name);
      if (pm && !ticketIds.has(pm[1])) { // a hold left behind by a ticket that is gone
        try { if (Date.now() - statSync(join(ctx.dir, name)).mtimeMs > 60_000) tryUnlink(join(ctx.dir, name)); } catch { /* gone */ }
        continue;
      }
      const m = /^lease-([0-9a-f]+)\.(?:hb|act|cleared)$/.exec(name);
      if (!m || leaseIds.has(m[1])) continue;
      try { if (Date.now() - statSync(join(ctx.dir, name)).mtimeMs > 300_000) tryUnlink(join(ctx.dir, name)); } catch { /* gone */ }
    }
  }
  leases.sort((a, b) => num(a.startedAt) - num(b.startedAt) || num(a.pid) - num(b.pid));
  tickets.sort((a, b) => num(a.createdAt) - num(b.createdAt) || num(a.pid) - num(b.pid) || (a.id < b.id ? -1 : 1));
  reservations.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return { leases, tickets, stale: staleEntries, reclaimed, legacy, reservations };
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

// Units held per named resource across live leases.
export function namedHeld(state) {
  const out = {};
  for (const l of state.leases) for (const [k, n] of Object.entries(l.resources ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}

// Does a queued ticket need the box? (An old 'full' ticket always does.)
export const usesBox = (t) => t.kind !== 'run' || t.boxUnits > 0;

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
    if (!fs.existsSync(workerData.leaseFile) && !fs.existsSync(workerData.clearedFile)) {
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
function startHeartbeat(ctx, { leaseFile, hbFile, clearedFile, rec, beat }) {
  const none = { stop: () => Promise.resolve(), stopSync() {}, setRecord() {} };
  if (!(ctx.heartbeatMs > 0) || ctx.heartbeat === 'off') return none;
  if (ctx.heartbeat === 'worker') {
    try {
      const flags = new Int32Array(new SharedArrayBuffer(8));
      const w = new Worker(HB_WORKER_SRC, {
        eval: true, workerData: { leaseFile, hbFile, clearedFile, ms: ctx.heartbeatMs, rec, flags: flags.buffer },
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

function createLease(ctx, {
  kind, units, heavy = 0, label = '', waitedMs = 0, resources = {}, ramMb = 0, limits = null, monitored = false,
  group = '', bindPid = 0,
}) {
  const id = newId();
  const file = join(ctx.dir, `lease-${id}.json`);
  const hbFile = join(ctx.dir, `lease-${id}.hb`);
  const clearedFile = join(ctx.dir, `lease-${id}.cleared`);
  const actFile = join(ctx.dir, `lease-${id}.act`);
  const t0 = ctx.now();
  const rec = {
    id, pid: bindPid > 0 ? bindPid : ctx.pid, startedAt: t0, heartbeatAt: t0, repo: ctx.repo, worktree: ctx.worktree, kind,
    units, heavy, heavyCost: ctx.heavyCost, label,
  };
  // A pid-bound lease (a daemon): it lives as long as `bindPid`, whoever wrote it. The wrapper's own
  // pid is kept for the record; no heartbeat is written and none is needed.
  if (bindPid > 0) { rec.boundPid = bindPid; rec.wrapperPid = ctx.pid; }
  if (group) rec.group = group;
  // Additive fields (docs/resource-queue.md): written only when there is something to say.
  if (ctx.project) rec.project = ctx.project;
  if (ctx.session) rec.session = ctx.session;
  if (Object.keys(resources).length) rec.resources = { ...resources };
  if (ramMb > 0) rec.ramMb = ramMb;
  if (limits && Object.keys(limits).length) rec.limits = { ...limits };
  if (monitored) rec.monitored = true;
  writeFileSync(file, JSON.stringify(rec), { flag: 'wx' });
  try { writeFileSync(hbFile, String(t0)); } catch { /* best effort: heartbeatAt in the lease still counts */ }
  if (monitored) { try { writeFileSync(actFile, `${t0} ${t0}`); } catch { /* best effort */ } }
  let released = false;
  let unmanaged = false;

  const beat = () => {
    if (released) return;
    try { writeFileSync(hbFile, String(ctx.now())); } catch { /* best effort */ }
    if (!existsSync(file) && !existsSync(clearedFile)) { // reclaimed while we were frozen (a laptop sleep): put it back
      try { writeFileSync(file, JSON.stringify({ ...rec, heartbeatAt: ctx.now() }), { flag: 'wx' }); } catch { /* raced */ }
    }
  };
  const heartbeat = bindPid > 0
    ? { stop: () => Promise.resolve(), stopSync() {}, setRecord() {} }
    : startHeartbeat(ctx, { leaseFile: file, hbFile, clearedFile, rec: { ...rec }, beat });

  const lease = {
    id, kind, dir: ctx.dir, waitedMs, file, clearedFile, actFile,
    get cleared() { return existsSync(clearedFile); },
    get units() { return rec.units; },
    get heavy() { return rec.heavy; },
    get workers() { return rec.units + rec.heavy; },
    get charge() { return charge(ctx, rec); },
    get released() { return released; },
    bound: bindPid > 0, boundPid: bindPid,
    beat,
    /** Record a probe result: sampledAt = when it ran, activeAt = the last time the holder was seen working. */
    recordActivity(sampledAt, activeAt) {
      if (released) return;
      try { writeFileSync(actFile, `${Math.trunc(sampledAt)} ${Math.trunc(activeAt)}`); } catch { /* best effort */ }
    },
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
      tryUnlink(actFile);
      tryUnlink(clearedFile);
      // A group's job ending restarts the idle clock of its reservations (survives this process).
      try { touchReservations(ctx, group, Object.keys(resources).concat(units > 0 ? [BOX] : [])); } catch { /* best effort */ }
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
    resize(spec, { wait = false, resample = false } = {}) {
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
          return managedResize(want, wait, resample);
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

  // One line when this lease first sees the machine loaded, one when it clears.
  let lastOver = false;
  function noteLoad(load) {
    if (load.over === lastOver) return;
    lastOver = load.over;
    ctx.log(load.over
      ? `ci-budget: the machine is loaded (${load.busy.toFixed(1)} of ${ctx.cores} cores busy, over ${overloadThreshold(ctx).toFixed(1)}; `
        + `${ctx.reserve} kept idle for interactive work and hooks): admitting workers slowly, `
        + 'one per lane until it eases (CI_LOCAL_RESERVE, CI_LOCAL_LOAD_PCT).'
      : 'ci-budget: the machine load is back under the threshold; admitting workers normally.');
  }

  function managedResize(want, wait, resample) {
    const begin = ctx.now();
    let lastAnnounce = -Infinity;
    for (;;) {
      const grows = want.units > rec.units || want.heavy > rec.heavy;
      // Re-sample the machine on every grow, and on request (resample: a lease that
      // is already full size asks again between slices of a long pass).
      const load = grows || resample ? measureLoad(ctx) : { external: 0, over: false, busy: NaN };
      const { external } = load;
      if (grows || resample) noteLoad(load);
      // Loaded machine: admit new workers slowly. The lease keeps (or is cut to)
      // one worker per lane; a later request admits more once the load is down.
      const ask = load.over ? { units: Math.min(want.units, 1), heavy: Math.min(want.heavy, 1) } : want;
      const satisfied = (g) => (want.heavy === 0 || g.heavy >= 1) && (want.units === 0 || g.units >= 1);
      const done = withAdmit(ctx, () => {
        const state = readState(ctx, { reclaim: true });
        const mine = state.leases.find((l) => l.id === id);
        const t = totals(ctx, state);
        const ownCharge = mine ? charge(ctx, mine) : 0;
        const ownHeavy = mine ? mine.heavy : 0;
        const keep = { units: Math.min(ask.units, rec.units), heavy: Math.min(ask.heavy, rec.heavy) };
        let free = ctx.budget - (t.held - ownCharge) - external - (keep.units + keep.heavy * ctx.heavyCost);
        const heavyRoom = ctx.heavyMax - (t.heavyHeld - ownHeavy) - keep.heavy;
        let addHeavy = 0;
        if (ask.heavy > keep.heavy) {
          addHeavy = Math.max(0, Math.min(ask.heavy - keep.heavy, heavyRoom, Math.floor(free / ctx.heavyCost)));
          // Alone on the box (nothing else is held), as in acquireFull: always
          // progress, however much outside load there is.
          if (addHeavy === 0 && heavyRoom >= 1 && t.held - ownCharge <= 0) addHeavy = 1;
          free -= addHeavy * ctx.heavyCost;
        }
        let addUnits = 0;
        if (ask.units > keep.units) addUnits = Math.max(0, Math.min(ask.units - keep.units, free));
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
  // A pid-bound lease belongs to the bound pid: this process ending must not release it.
  const unregister = bindPid > 0 ? () => {} : register(ctx, () => lease.release());
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
    ...(ctx.project ? { project: ctx.project } : {}), ...(ctx.session ? { session: ctx.session } : {}),
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
      // The box queue: full runs and resource-queue runs that need box units. A
      // ticket for a named resource only does not order (or block) a full run.
      const boxQueue = state.tickets.filter(usesBox);
      let pos = boxQueue.findIndex((t) => t.id === id);
      if (pos < 0) { // our ticket was reclaimed during a freeze: put it back, keeping its place
        try { writeFileSync(ticketFile, JSON.stringify({ ...ticket, heartbeatAt: ctx.now() }), { flag: 'wx' }); } catch { /* raced */ }
        pos = boxQueue.filter((t) => num(t.createdAt) <= ticket.createdAt).length;
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
          const load = measureLoad(ctx);
          external = load.external;
          const got = withAdmit(ctx, () => {
            const s = readState(ctx, { reclaim: true });
            const sq = s.tickets.filter(usesBox);
            if (!sq.length || sq[0].id !== id) return null;
            const tt = totals(ctx, s);
            if (tt.fullCount >= ctx.maxFull) return null;
            let free = ctx.budget - tt.held - external;
            if (tt.held === 0) free = Math.max(free, 1); // alone on the box: always progress
            if (free < 1) return null;
            // A loaded machine (reserve not idle, or over the load threshold) gets one worker.
            const units = Math.min(load.over ? 1 : desired, Math.floor(free));
            const lease = createLease(ctx, {
              kind: 'full', units, label: opts.label ?? '', waitedMs: ctx.now() - begin,
            });
            tryUnlink(ticketFile);
            return { lease, free };
          });
          if (got) {
            unregister();
            if (announced || got.lease.units < desired) {
              ctx.log(`ci-budget: starting with ${got.lease.units} of ${desired} workers${load.over ? ' (machine loaded)' : ''} `
                + `(waited ${Math.round((ctx.now() - begin) / 1000)} s; ${describe(ctx, readState(ctx, { reclaim: false }), external)})`);
            }
            return got.lease;
          }
          why = describe(ctx, state, external);
        }
      } else {
        const head = boxQueue[0] ?? {};
        why = `queue position ${pos + 1} of ${boxQueue.length}; head is pid ${head.pid} in ${head.worktree}`;
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
 * worktree, see repoLabel()); worktree; env; plus option keys and test seams:
 * dir, budget, heavyCost, heavyMax, express, maxFull, pollMs, staleMs, heartbeatMs, heavyMaxWaitMs, queueMaxWaitMs, expressMaxWaitMs,
 * reserve, loadPct, sliceFactor, cores,
 * announceMs, now(), sleep(ms), isAlive(pid), sampler() -> busy cores, log(line),
 * pid, timeoutMs, registerExit, heartbeat ('worker' | 'timer' | 'off'), off.
 *
 * Returns a lease: {id, kind, units, heavy, workers, charge, waitedMs,
 * beat(), resize(spec, {wait, resample}), release()}. With CI_LOCAL_LOCK=0 (or off: true) it
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
  let busyCores = null; let external = 0; let loaded = null;
  if (opts.sample !== false) {
    try {
      busyCores = Number(ctx.sampler());
      external = Math.max(0, Math.round(busyCores - totals(ctx, readState(ctx, { reclaim: false })).held));
      loaded = busyCores > overloadThreshold(ctx);
    } catch { /* sampling is best effort */ }
  }
  const age = (ms) => Math.max(0, now - num(ms));
  return {
    dir: ctx.dir, cores: ctx.cores, budget: ctx.budget, heavyCost: ctx.heavyCost, heavyMax: ctx.heavyMax,
    express: ctx.express, reserve: ctx.reserve, loadPct: ctx.loadPct, loadThreshold: Math.round(overloadThreshold(ctx) * 10) / 10,
    loaded, maxFull: Number.isFinite(ctx.maxFull) ? ctx.maxFull : null,
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
  if (st.loadThreshold !== undefined) {
    lines.push(`  load guard: ${st.reserve} cores kept idle for interactive work and hooks; admission slows above ${st.loadThreshold} busy cores`
      + (st.loaded === null ? '' : st.loaded ? ' (loaded now: new workers admitted one per lane)' : ' (not loaded now)'));
  }
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

// ---------------------------------------------------------------- resource queue (kind 'run')

const MB = 1024 * 1024;
export const STATUS_SCHEMA_VERSION = 1;
export const REENTRY_ENV = 'AC_RESOURCE_LEASE';

// Resources, wanted amounts, clamped to what can ever be free: a request for more
// than the whole box (or a resource's capacity) would wait for ever.
function normalizeRequest(ctx, opts) {
  const warnings = [];
  let box = Math.max(0, Math.trunc(num(opts.box)));
  if (box > ctx.budget) { warnings.push(`resource-queue: box:${box} is more than the whole budget (${ctx.budget}); asking for ${ctx.budget}.`); box = ctx.budget; }
  const named = {};
  for (const [name, n] of Object.entries(opts.resources ?? {})) {
    if (name === BOX || !NAME_RE.test(name)) continue;
    const cap = capacityOf(ctx.rules, ctx.env, name);
    let u = Math.max(1, Math.trunc(num(n)) || 1);
    if (u > cap) { warnings.push(`resource-queue: ${name}:${u} is more than its capacity (${cap}); asking for ${cap}.`); u = cap; }
    named[name] = u;
  }
  const group = typeof opts.group === 'string' && NAME_RE.test(opts.group) ? opts.group : '';
  const bindPid = Math.max(0, Math.trunc(num(opts.bindPid)));
  return { box, named, ramMb: Math.max(0, Math.trunc(num(opts.ramMb))), group, bindPid, warnings };
}

function legacyBlock(ctx, name) {
  for (const l of ctx.rules?.legacyLocks ?? []) {
    if (l?.resource !== name || !l.dir) continue;
    try {
      // No yield file is read: a file that stops every waiter is the incident that "reserve --for" replaces.
      if (statSync(l.dir).isDirectory()) return `the old lock ${l.dir} is held`;
    } catch { /* absent */ }
  }
  return '';
}

const holdersOf = (state, name) => state.leases.filter((l) => (name === BOX ? l.units > 0 : l.resources?.[name] > 0));
const who = (l, now) => `pid ${l.pid}${l.label ? ` "${l.label}"` : ''} for ${Math.round((now - num(l.startedAt)) / 1000)} s`;

/**
 * Does request `req` fit right now, behind the tickets ahead of `id`? Pure on
 * (ctx, state). `external` is the sampled outside load (null: not sampled, the
 * box check is skipped and `needsSample` says so). Returns {ok, reasons[{resource, text}], needsSample}.
 */
function evaluateFit(ctx, state, req, id, external) {
  const reasons = [];
  const now = ctx.now();
  const t = totals(ctx, state);
  const held = namedHeld(state);
  const me = state.tickets.findIndex((q) => q.id === id);
  const ahead = me < 0 ? state.tickets : state.tickets.slice(0, me);
  let policy = false; // held or passed over for a reservation: a time that does not count toward the bounded wait
  const mine = me < 0 ? null : state.tickets[me];
  if (mine?.paused) {
    reasons.push({ resource: 'hold', kind: 'paused', text: `paused by "hold" (${mine.pausedBy ? `session ${mine.pausedBy.slice(0, 8)}; ` : ''}resume with "resume")` });
    policy = true;
  }
  // Someone else's reservation: passed over for that resource, place kept (the ticket stays where it is).
  const names = [...(req.box > 0 ? [BOX] : []), ...Object.keys(req.named)];
  const resv = reservedAgainst(state.reservations ?? [], names, req.group);
  if (resv) {
    reasons.push({
      resource: resv.resource, kind: 'reserved',
      text: `${resv.resource} is reserved for group "${resv.forGroup}" until ${new Date(resv.endsAt).toISOString().slice(11, 16)}Z`
        + `${resv.reason ? ` (${resv.reason})` : ''}; this request ${req.group ? `is in group "${req.group}"` : 'names no group'} and keeps its place`,
    });
    policy = true;
  }
  for (const e of ahead) {
    // A ticket ahead that is itself held or passed over cannot take anything now, so it blocks no one.
    if (passedOver(state, e)) continue;
    const shared = [];
    if (req.box > 0 && usesBox(e)) shared.push(BOX);
    for (const n of Object.keys(req.named)) if (e.resources?.[n]) shared.push(n);
    if (shared.length) { reasons.push({ resource: shared[0], text: `queued behind pid ${e.pid} (${shared.join(', ')})` }); break; }
  }
  for (const [name, u] of Object.entries(req.named)) {
    const cap = capacityOf(ctx.rules, ctx.env, name);
    if (u > cap - (held[name] ?? 0)) {
      const h = holdersOf(state, name)[0];
      reasons.push({ resource: name, text: `${name} ${held[name] ?? 0}/${cap} held${h ? ` by ${who(h, now)}` : ''}` });
    }
    const lb = legacyBlock(ctx, name);
    if (lb) reasons.push({ resource: name, text: lb });
  }
  let needsSample = false;
  if (req.box > 0 && t.held > 0) { // alone on the box: always progress
    if (external === null) needsSample = true;
    else if (req.box > ctx.budget - t.held - external) {
      reasons.push({ resource: BOX, text: `box:${req.box} needed, ${Math.max(0, ctx.budget - t.held - external)} free of ${ctx.budget} (${t.held} held, outside load ~${external})` });
    }
  }
  if (req.ramMb > 0 && (state.leases.length > 0 || state.legacy.length > 0)) {
    const total = ctx.totalmem() / MB;
    const reserve = ramReserveMb(ctx.rules, total);
    const ramp = ctx.rules?.ram?.rampMs ?? 60_000;
    const committed = state.leases.filter((l) => now - num(l.startedAt) < ramp).reduce((a, l) => a + l.ramMb, 0);
    const free = Math.round(ctx.freemem() / MB) - reserve - committed;
    if (free < req.ramMb) reasons.push({ resource: 'ram', text: `RAM ${req.ramMb} MB needed, ${Math.max(0, free)} MB free after a ${reserve} MB reserve and ${committed} MB still ramping up` });
  }
  return { ok: reasons.length === 0, reasons, needsSample, policy };
}

function wantsText(req) {
  return [...(req.box ? [`box:${req.box}`] : []), ...Object.entries(req.named).map(([n, u]) => `${n}:${u}`), ...(req.ramMb ? [`ram:${req.ramMb}M`] : [])].join(' ');
}

function noopRunLease(req) {
  return {
    id: 'off', kind: 'run', off: true, units: req.box, resources: { ...req.named }, waitedMs: 0, cleared: false,
    release() {}, recordActivity() {}, beat() {},
  };
}

/**
 * Wait, in FIFO order, until every resource in the request is free at once, then
 * take them all in one lease (kind 'run'). Never holds part of a request while
 * waiting. Bounded: after maxWaitMs (default CI_LOCAL_QUEUE_MAX_WAIT_MS, 30 min)
 * it takes the lease over budget and says so. Fails open: a broken ledger returns
 * a no-op lease. Async only so a signal can be handled while queued.
 *
 * opts: box (units), resources {name: units}, ramMb, label, limits {maxHoldMs,
 * idleMs, minHoldMs}, monitored, maxWaitMs, plus the makeCtx option keys and seams
 * (dir, budget, now, sleep, delay, isAlive, sampler, freemem, totalmem, rules, ...).
 */
export async function acquireResources(opts = {}) {
  const ctx = makeCtx(opts);
  const req = normalizeRequest(ctx, opts);
  for (const w of req.warnings) ctx.log(w);
  if (ctx.off) return noopRunLease(req);
  try {
    mkdirSync(ctx.dir, { recursive: true });
  } catch (err) {
    ctx.log(`resource-queue: the ledger directory ${ctx.dir} is unusable (${err.code || err.message}); running without the queue.`);
    return noopRunLease(req);
  }
  const label = String(opts.label ?? '');
  const begin = ctx.now();
  const maxWait = opts.maxWaitMs ?? ctx.queueMaxWaitMs;
  const id = newId();
  const ticketFile = join(ctx.dir, `ticket-${id}.json`);
  const dropTicket = () => { tryUnlink(ticketFile); tryUnlink(join(ctx.dir, `ticket-${id}.paused`)); };
  const ticket = {
    id, pid: ctx.pid, createdAt: begin, heartbeatAt: begin, repo: ctx.repo, worktree: ctx.worktree, kind: 'run',
    desired: Math.max(1, req.box), boxUnits: req.box, resources: { ...req.named }, ramMb: req.ramMb, label,
    ...(ctx.project ? { project: ctx.project } : {}), ...(ctx.session ? { session: ctx.session } : {}),
    ...(req.group ? { group: req.group } : {}),
  };
  const grant = (units) => {
    const alive = req.bindPid > 0 && ctx.isAlive(req.bindPid);
    if (req.bindPid > 0 && !alive) ctx.log(`resource-queue: the bound pid ${req.bindPid} is not running any more; the lease belongs to this process instead.`);
    return createLease(ctx, {
      kind: 'run', units, label, waitedMs: ctx.now() - begin, resources: req.named, ramMb: req.ramMb,
      limits: opts.limits ?? null, monitored: Boolean(opts.monitored), group: req.group, bindPid: alive ? req.bindPid : 0,
    });
  };
  try {
    writeFileSync(ticketFile, JSON.stringify(ticket), { flag: 'wx' });
  } catch (err) {
    ctx.log(`resource-queue: the ledger failed (${err.code || err.message}); running without the queue.`);
    return noopRunLease(req);
  }
  const unregister = register(ctx, dropTicket);
  let lastAnnounce = -Infinity; let lastPos = -1; let announced = false;
  let excluded = 0; let lastTick = begin; let lastPolicy = false; // time held or passed over does not count toward the bounded wait
  try {
    for (;;) {
      // The sweep: every join and every poll evaluates the rules over every holder and ticket.
      const state = readState(ctx, { reclaim: true });
      for (const r of state.reclaimed) {
        if (!String(r.why).startsWith('rule ')) ctx.log(`resource-queue: cleared a stale ${r.type} (${r.why}); it belonged to pid ${r.pid} in ${r.worktree}`);
      }
      let pos = state.tickets.findIndex((q) => q.id === id);
      if (pos < 0) { // reclaimed during a freeze: put it back, keeping its place
        try { writeFileSync(ticketFile, JSON.stringify({ ...ticket, heartbeatAt: ctx.now() }), { flag: 'wx' }); } catch { /* raced */ }
        pos = state.tickets.filter((q) => num(q.createdAt) <= ticket.createdAt).length;
      } else if (ctx.now() - ticket.heartbeatAt > ctx.staleMs / 4) {
        ticket.heartbeatAt = ctx.now();
        writeAtomic(ctx, ticketFile, ticket);
      }
      const fit = evaluateFit(ctx, state, req, id, null);
      let reasons = fit.reasons; let policy = fit.policy;
      if (!reasons.length) {
        const external = req.box > 0 ? measureLoad(ctx).external : 0;
        const got = withAdmit(ctx, () => {
          const s = readState(ctx, { reclaim: true });
          const f = evaluateFit(ctx, s, req, id, external);
          if (!f.ok) return { reasons: f.reasons, policy: f.policy };
          const lease = grant(req.box);
          dropTicket();
          return { lease };
        });
        if (got.lease) {
          unregister();
          if (announced) ctx.log(`resource-queue: granted ${wantsText(req)} after ${Math.round((ctx.now() - begin) / 1000)} s.`);
          return got.lease;
        }
        reasons = got.reasons; policy = got.policy;
      }
      const tickAt = ctx.now();
      if (lastPolicy) excluded += tickAt - lastTick;
      lastTick = tickAt; lastPolicy = policy;
      const waited = tickAt - begin - excluded;
      // Held or passed over by a reservation: the wait is the policy's, not the queue's, so it neither
      // goes over budget nor times out here; a hold and a reservation both end by their own clock (4 h at most).
      if (!policy && waited >= maxWait) { // no unbounded wait: go on over budget
        const lease = withAdmit(ctx, () => { const l = grant(req.box); dropTicket(); return l; });
        unregister();
        ctx.log(`resource-queue: waited ${Math.round(waited / 1000)} s (${reasons.map((r) => r.text).join('; ')}); `
          + `running over budget (CI_LOCAL_QUEUE_MAX_WAIT_MS=${ctx.queueMaxWaitMs}).`);
        return lease;
      }
      if (!policy && waited >= ctx.timeoutMs) throw timeoutError();
      if (pos !== lastPos || ctx.now() - lastAnnounce >= ctx.announceMs) {
        lastPos = pos; lastAnnounce = ctx.now(); announced = true;
        ctx.log(`resource-queue: waiting, position ${pos + 1} of ${state.tickets.length || 1} (needs ${wantsText(req)}): ${reasons.map((r) => r.text).join('; ')}`);
      }
      await ctx.delay(ctx.pollMs);
    }
  } catch (err) {
    if (err.code === 'EBUDGETTIMEOUT') throw err;
    ctx.log(`resource-queue: the ledger failed (${err.code || err.message}); running without the queue.`);
    return noopRunLease(req);
  } finally {
    dropTicket();
    unregister();
  }
}

/** A live lease by id (the re-entrancy token): its resources, or null. Reads only. */
export function inspectLease(id, opts = {}) {
  try {
    if (!/^[0-9a-f]{12}$/.test(String(id))) return null;
    const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
    const l = readState(ctx, { reclaim: false }).leases.find((x) => x.id === id);
    return l ? { id: l.id, pid: l.pid, box: l.units, resources: l.resources, ramMb: l.ramMb } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- resource status (schema v1)

function holderOut(ctx, l, units, stale, now) {
  const hb = Math.max(num(l.heartbeatAt), num(l.hbSide), num(l.startedAt));
  return {
    id: l.id, kind: l.kind, pid: l.pid, alive: ctx.isAlive(l.pid), label: l.label || '',
    project: l.project || l.repo || '', repo: l.repo || '', worktree: l.worktree || '', session: l.session || '',
    units, ramMb: l.ramMb || 0, startedAt: num(l.startedAt) || null, heartbeatAt: hb || null,
    ageMs: Math.max(0, now - num(l.startedAt)), heartbeatAgeMs: Math.max(0, now - hb),
    lastActivityAt: l.act ? l.act.activeAt : null, idleMs: l.act ? Math.max(0, now - l.act.activeAt) : null,
    stale: stale || null, group: l.group || '', bound: l.boundPid > 0, boundPid: l.boundPid > 0 ? l.boundPid : null,
    overTime: l.overTime ? { heldMs: l.overTime.heldMs, maxHoldMs: l.overTime.maxHoldMs, activity: l.overTime.activity } : null,
  };
}

/**
 * The status object (schema in docs/resource-queue.md). Reads the ledger and the
 * clear log only: no cpu sample (unless opts.sample), no spawned process (unless
 * opts.strays). Cheap enough for a hook. Never throws: on failure it returns
 * { schemaVersion, ok: false, error, resources: [], queue: [], ... }.
 */
export function resourceStatus(opts = {}) {
  const generatedAt = Date.now();
  const base = { schema: 'resource-queue-status', schemaVersion: STATUS_SCHEMA_VERSION, ok: true, generatedAt };
  try {
    const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
    const state = readState(ctx, { reclaim: false });
    const now = ctx.now();
    const t = totals(ctx, state);
    const held = namedHeld(state);
    const totalMb = Math.round(ctx.totalmem() / MB);
    let busyCores = null; let external = null; let loaded = null;
    if (opts.sample === true) {
      try {
        busyCores = Number(ctx.sampler());
        external = Math.max(0, Math.round(busyCores - t.held));
        loaded = busyCores > overloadThreshold(ctx);
      } catch { /* best effort */ }
    }
    const staleLeases = state.stale.filter((s) => s.type === 'lease');
    const names = new Set([...Object.keys(ctx.rules?.resources ?? {}).filter((n) => n !== BOX && ctx.rules.resources[n]?.capacity), ...Object.keys(held)]);
    for (const q of state.tickets) for (const n of Object.keys(q.resources ?? {})) names.add(n);
    for (const l of staleLeases) for (const n of Object.keys(l.resources ?? {})) names.add(n);
    const boxHolders = [
      ...state.leases.filter((l) => l.units > 0).map((l) => holderOut(ctx, l, l.units + l.heavy * l.heavyCost, null, now)),
      ...state.legacy.map((l) => ({
        id: `legacy-${l.pid}`, kind: 'legacy', pid: l.pid, alive: true, label: 'old run lock', project: '', repo: '', worktree: l.worktree,
        session: '', units: ctx.legacyUnits, ramMb: 0, startedAt: l.startedAt || null, heartbeatAt: null,
        ageMs: Math.max(0, now - num(l.startedAt)), heartbeatAgeMs: null, lastActivityAt: null, idleMs: null, stale: null,
      })),
      ...staleLeases.filter((l) => l.units > 0).map((l) => holderOut(ctx, l, l.units, l.stale, now)),
    ];
    const resources = [{
      name: BOX, capacity: ctx.budget, held: t.held, free: Math.max(0, ctx.budget - t.held), holders: boxHolders,
    }];
    for (const name of [...names].sort()) {
      const cap = capacityOf(ctx.rules, ctx.env, name);
      resources.push({
        name, capacity: cap, held: held[name] ?? 0, free: Math.max(0, cap - (held[name] ?? 0)),
        holders: [
          ...state.leases.filter((l) => l.resources?.[name] > 0).map((l) => holderOut(ctx, l, l.resources[name], null, now)),
          ...staleLeases.filter((l) => l.resources?.[name] > 0).map((l) => holderOut(ctx, l, l.resources[name], l.stale, now)),
        ],
      });
    }
    const queue = state.tickets.map((q, i) => {
      const req = { box: q.kind === 'run' ? q.boxUnits : 1, named: q.resources ?? {}, ramMb: q.ramMb || 0, group: q.group || '' };
      const fit = evaluateFit(ctx, state, req, q.id, null);
      const hb = Math.max(num(q.heartbeatAt), num(q.createdAt));
      return {
        position: i + 1, id: q.id, kind: q.kind, pid: q.pid, alive: ctx.isAlive(q.pid), label: q.label || '',
        project: q.project || q.repo || '', repo: q.repo || '', worktree: q.worktree || '', session: q.session || '',
        wants: { ...(req.box ? { [BOX]: q.kind === 'run' ? q.boxUnits : q.desired } : {}), ...req.named },
        ramMb: req.ramMb, createdAt: num(q.createdAt) || null, heartbeatAt: hb || null,
        waitedMs: Math.max(0, now - num(q.createdAt)), blockedBy: [...new Set(fit.reasons.map((r) => r.resource))],
        group: q.group || '', paused: Boolean(q.paused), pausedBy: q.pausedBy || '', pausedUntil: q.pausedUntil ?? null,
        passedOver: fit.policy,
      };
    });
    const reservations = state.reservations.map((r) => ({
      id: r.id, resource: r.resource, forGroup: r.forGroup, owner: { pid: r.owner.pid, session: r.owner.session },
      ownerAlive: r.owner.pid > 0 ? ctx.isAlive(r.owner.pid) : null, createdAt: r.createdAt, expiresAt: r.endsAt,
      remainingMs: Math.max(0, r.endsAt - now), reason: r.reason,
    }));
    const legacyLocks = (ctx.rules?.legacyLocks ?? []).filter((l) => l?.resource && l.dir).map((l) => {
      let present = false;
      try { present = statSync(l.dir).isDirectory(); } catch { /* absent */ }
      return { resource: l.resource, dir: l.dir, present };
    });
    let strays = null;
    if (opts.strays === true) {
      const heldNames = new Set([...Object.keys(held), ...(t.held > 0 ? [BOX] : [])]);
      strays = scanStrays(ctx.rules, heldNames);
    }
    return {
      ...base, dir: ctx.dir,
      machine: {
        cores: ctx.cores, totalRamMb: totalMb, freeRamMb: Math.round(ctx.freemem() / MB), ramReserveMb: ramReserveMb(ctx.rules, totalMb),
        busyCores: busyCores === null ? null : Math.round(busyCores * 10) / 10, externalCores: external, loaded,
      },
      resources, queue, reservations, recentClears: recentClears(ctx.dir, { now }), legacyLocks, strays,
    };
  } catch (err) {
    return {
      ...base, ok: false, error: String(err && err.message || err), dir: null, machine: null,
      resources: [], queue: [], reservations: [], recentClears: [], legacyLocks: [], strays: null,
    };
  }
}

/** The text form of resourceStatus() (what `status` prints without --json). */
export function formatResourceStatus(st) {
  if (!st.ok) return `resource queue: status unavailable (${st.error})`;
  const lines = [];
  const m = st.machine;
  lines.push(`Resource queue (ledger ${st.dir})`);
  lines.push(`  machine: ${m.cores} cores, RAM ${m.freeRamMb} MB free of ${m.totalRamMb} (reserve ${m.ramReserveMb} MB)`
    + (m.busyCores === null ? '' : `, cpu busy ${m.busyCores} cores, outside load ~${m.externalCores}${m.loaded ? ', LOADED' : ''}`));
  for (const r of st.resources) {
    lines.push('');
    lines.push(`${r.name}: ${r.held}/${r.capacity} held, ${r.free} free`);
    if (!r.holders.length) lines.push('  free');
    for (const h of r.holders) {
      const flags = [h.bound ? 'BOUND to this pid' : '', h.group ? `group ${h.group}` : '', h.stale ? `STALE (${h.stale})` : '', h.kind !== 'legacy' && !h.alive ? 'PID DEAD' : '',
        h.overTime ? `OVER TIME (${dur(h.overTime.heldMs)} > ${dur(h.overTime.maxHoldMs)} limit, ${h.overTime.activity}: kept, not released)` : ''].filter(Boolean).join(' ');
      lines.push(`  ${h.kind.padEnd(8)} pid ${String(h.pid).padEnd(7)} ${h.units}u  age ${dur(h.ageMs)}  heartbeat ${h.heartbeatAgeMs === null ? 'n/a' : `${dur(h.heartbeatAgeMs)} ago`}`
        + `${h.idleMs !== null ? `  idle ${dur(h.idleMs)}` : ''}  ${h.project || ''} ${h.worktree}${h.label ? `  [${h.label}]` : ''}${h.session ? `  session ${h.session.slice(0, 8)}` : ''}${flags ? `  ${flags}` : ''}`);
    }
  }
  if (st.reservations?.length) {
    lines.push('');
    lines.push(`Reservations (${st.reservations.length}):`);
    for (const r of st.reservations) {
      lines.push(`  ${r.resource} for group "${r.forGroup}", ${dur(r.remainingMs)} left${r.reason ? `  (${r.reason})` : ''}`
        + `  owner pid ${r.owner.pid || 'n/a'}${r.owner.session ? ` session ${r.owner.session.slice(0, 8)}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`Queue (${st.queue.length}):`);
  if (!st.queue.length) lines.push('  empty');
  for (const q of st.queue) {
    lines.push(`  #${q.position} pid ${String(q.pid).padEnd(7)} wants ${Object.entries(q.wants).map(([n, u]) => `${n}:${u}`).join(' ')}  waiting ${dur(q.waitedMs)}`
      + `  ${q.project || ''} ${q.worktree}${q.label ? `  [${q.label}]` : ''}${q.group ? `  group ${q.group}` : ''}${q.paused ? '  PAUSED' : ''}`
      + `${q.blockedBy.length ? `  blocked on ${q.blockedBy.join(', ')}` : ''}${q.alive ? '' : '  PID DEAD'}`);
  }
  if (st.recentClears.length) {
    lines.push('');
    lines.push(`Recent clears (${st.recentClears.length}):`);
    for (const c of st.recentClears.slice(0, 10)) lines.push(`  ${new Date(c.at).toISOString()} ${c.rule} ${c.type} pid ${c.pid} ${c.label ? `[${c.label}] ` : ''}${c.worktree || ''}`);
  }
  if (st.strays && st.strays.length) {
    lines.push('');
    lines.push(`Leftover processes holding no lease (reported, never touched; ${st.strays.length}):`);
    for (const s of st.strays) lines.push(`  pid ${s.pid} ${s.name}${s.orphan ? ' (orphan)' : ''} - ${s.why}`);
  }
  for (const l of st.legacyLocks) if (l.present) lines.push(`\nOld lock held: ${l.resource} at ${l.dir}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- reservations and hold

/**
 * Step aside for a named group on one resource. opts: resource, forGroup, until (epoch ms,
 * required), reason, ownerPid (default CLAUDE_PID, else 0 = no owner check), ownerSession
 * (default CLAUDE_CODE_SESSION_ID), plus the makeCtx option keys. The end is clamped to 4 h from now.
 * Returns {ok, reservation, clamped} or {ok: false, error}. Replaces an earlier reservation of the
 * same group on the same resource. Never blocks anyone but the waiters outside `forGroup`, for this
 * resource only, until the end, the owner's pid is gone, or anyone runs unreserve.
 */
export function reserveResource(opts = {}) {
  const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
  const resource = String(opts.resource ?? '');
  const forGroup = String(opts.forGroup ?? '');
  if (!(resource === BOX || NAME_RE.test(resource))) return { ok: false, error: `bad resource "${resource}"` };
  if (!NAME_RE.test(forGroup)) return { ok: false, error: `bad group "${forGroup}" (names are letters, digits, . _ -)` };
  const until = Number(opts.until);
  if (!Number.isFinite(until)) return { ok: false, error: 'an expiry is required (--until)' };
  const now = ctx.now();
  if (until <= now) return { ok: false, error: 'the expiry is already in the past' };
  const endsAt = Math.min(until, now + MAX_RESERVATION_MS);
  const ownerPid = Math.max(0, Math.trunc(num(opts.ownerPid ?? ctx.env.CLAUDE_PID)));
  const rec = {
    id: newId(), resource, forGroup, owner: { pid: ownerPid, session: String(opts.ownerSession ?? ctx.session ?? '') },
    createdAt: now, expiresAt: endsAt, reason: String(opts.reason ?? '').slice(0, 200),
  };
  try {
    mkdirSync(ctx.dir, { recursive: true });
    for (const old of readState(ctx, { reclaim: false }).reservations) {
      if (old.resource === resource && old.forGroup === forGroup) dropFile(old.file, activeFile(ctx.dir, old.id));
    }
    writeAtomic(ctx, join(ctx.dir, `reservation-${rec.id}.json`), rec);
  } catch (err) {
    return { ok: false, error: `the ledger is not writable (${err.code || err.message})` };
  }
  return { ok: true, reservation: { ...rec, endsAt }, clamped: until > endsAt };
}

/** Remove reservations on `resource` (all of them, or only `forGroup`'s). Anyone may; each is logged. */
export function unreserveResource(opts = {}) {
  const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
  const removed = [];
  try {
    for (const r of readState(ctx, { reclaim: false }).reservations) {
      if (r.resource !== opts.resource || (opts.forGroup && r.forGroup !== opts.forGroup)) continue;
      dropFile(r.file, activeFile(ctx.dir, r.id));
      noteReservationClear(ctx, r, 'unreserved', { session: ctx.session, pid: num(ctx.env.CLAUDE_PID) });
      removed.push({ id: r.id, resource: r.resource, forGroup: r.forGroup });
    }
  } catch { /* nothing to remove */ }
  return { ok: true, removed };
}

/**
 * Pause the caller's own queued entries (matched by session): each keeps its place but is
 * passed over until resume or the end of the hold (default and cap 4 h). Nobody else's entries change.
 */
export function holdMine(opts = {}) {
  const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
  if (!ctx.session) return { ok: false, error: 'no session id (CLAUDE_CODE_SESSION_ID is not set), so there is nothing to match "mine" against' };
  const now = ctx.now();
  const until = Math.min(Number.isFinite(Number(opts.until)) && Number(opts.until) > now ? Number(opts.until) : now + MAX_PAUSE_MS, now + MAX_PAUSE_MS);
  const ids = [];
  try {
    for (const t of readState(ctx, { reclaim: false }).tickets) {
      if (t.session !== ctx.session) continue;
      writeAtomic(ctx, t.pausedFile, { by: ctx.session, at: now, until });
      ids.push(t.id);
    }
  } catch (err) {
    return { ok: false, error: `the ledger is not writable (${err.code || err.message})` };
  }
  return { ok: true, ids, until };
}

/** Undo holdMine for the caller's session. */
export function resumeMine(opts = {}) {
  const ctx = makeCtx({ ...opts, log: () => {}, registerExit: false });
  if (!ctx.session) return { ok: false, error: 'no session id (CLAUDE_CODE_SESSION_ID is not set)' };
  const ids = [];
  try {
    for (const t of readState(ctx, { reclaim: false }).tickets) {
      if (t.session !== ctx.session || !t.paused) continue;
      tryUnlink(t.pausedFile);
      ids.push(t.id);
    }
  } catch { /* nothing to resume */ }
  return { ok: true, ids };
}

/** Apply the sweep rules to the ledger now (what every acquire does). Returns the cleared entries. */
export function sweepLedger(opts = {}) {
  const ctx = makeCtx({ ...opts, registerExit: false });
  return readState(ctx, { reclaim: true }).reclaimed;
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'status' || rest.some((a) => !['--json', '--no-sample'].includes(a))) {
    console.error('usage: node plugins/agent-companion/scripts/ci-budget.mjs status [--json] [--no-sample]');
    return 2;
  }
  const st = status({ sample: !rest.includes('--no-sample') });
  console.log(rest.includes('--json') ? JSON.stringify(st, null, 2) : formatStatus(st));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
