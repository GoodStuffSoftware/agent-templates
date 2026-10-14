// scripts/ci-budget.mjs: the machine-wide shared worker budget. Fake work only:
// the real suite is never run here, and every ledger lives in a fresh temp dir.
// The clock, the sleeper, the pid-liveness check and the cpu sampler are all
// injected, so nothing here waits on real time except the process tests.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquire, status, formatStatus, resolveBudgetConfig, budgetDir, sampleBusyCores, isPidAlive, legacyRunUnits,
} from '../ci-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, '..', 'ci-budget.mjs');
const MODULE_URL = pathToFileURL(MODULE_PATH).href;
const DEAD_PID = 2147483646;
const T0 = Date.now();

// Nothing here may see the real machine's old ci-lock slot files: every
// in-process ledger gets its own legacy dir (world), and child processes and the
// status command inherit an empty one through the environment.
const NO_LEGACY = mkdtempSync(join(tmpdir(), 'ci-budget-no-legacy-'));
process.env.CI_LOCAL_LOCK_DIR = NO_LEGACY;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-budget-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A fake world: a clock that only moves when something sleeps, a log, a set of
// dead pids, and a cpu sampler whose reading the test can change.
function world(dir, over = {}) {
  const w = {
    t: T0, lines: [], dead: new Set([DEAD_PID]), busy: 0, sleeps: 0, onSleep: null,
  };
  w.opts = {
    dir, env: { CI_LOCAL_LOCK_DIR: process.env.CI_LOCAL_LOCK_DIR }, budget: 8, heavyCost: 3, heavyMax: 2, express: 2, maxFull: Infinity,
    pollMs: 1500, announceMs: 60_000, staleMs: 90_000,
    heartbeat: 'off', registerExit: false, worktree: 'wt-test', legacyDir: join(dir, 'no-legacy-here'),
    now: () => w.t,
    sleep: (ms) => { w.t += ms; w.sleeps += 1; if (w.onSleep) w.onSleep(w.sleeps); },
    isAlive: (pid) => !w.dead.has(pid),
    sampler: () => w.busy,
    log: (l) => w.lines.push(l),
    ...over,
  };
  w.acquire = (extra = {}) => acquire({ ...w.opts, ...extra });
  w.status = (extra = {}) => status({ ...w.opts, ...extra });
  return w;
}

function files(dir, re) {
  return readdirSync(dir).filter((n) => re.test(n));
}

function writeLease(dir, {
  pid = process.pid, units = 1, heavy = 0, kind = 'full', startedAt = T0, heartbeatAt = T0,
  worktree = 'wt-other', repo = 'other-repo', hb = null,
}) {
  const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  writeFileSync(join(dir, `lease-${id}.json`), JSON.stringify({
    id, pid, startedAt, heartbeatAt, repo, worktree, kind, units, heavy, heavyCost: 3, label: '',
  }));
  if (hb !== null) writeFileSync(join(dir, `lease-${id}.hb`), String(hb));
  return id;
}

function writeTicket(dir, { pid, createdAt = T0, heartbeatAt = T0, desired = 4, worktree = 'wt-queued' }) {
  const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  writeFileSync(join(dir, `ticket-${id}.json`), JSON.stringify({
    id, pid, createdAt, heartbeatAt, repo: 'other-repo', worktree, kind: 'full', desired,
  }));
  return id;
}

// ---------------------------------------------------------------- config

test('resolveBudgetConfig: defaults scale with the machine, knobs override, bad values warn', () => {
  const d = resolveBudgetConfig({}, { cores: 32 });
  assert.equal(d.budget, 16);
  assert.equal(d.heavyCost, 3);
  assert.equal(d.heavyMax, 2);
  assert.equal(d.express, 2);
  assert.equal(d.maxFull, Infinity);
  assert.equal(d.staleMs, 90_000);
  assert.equal(d.off, false);
  assert.equal(resolveBudgetConfig({}, { cores: 8 }).budget, 4);
  assert.equal(resolveBudgetConfig({}, { cores: 2 }).budget, 2, 'never below 2');
  assert.equal(resolveBudgetConfig({}, { cores: 1 }).budget, 2);
  const o = resolveBudgetConfig({
    CI_LOCAL_BUDGET: '10', CI_LOCAL_HEAVY_COST: '4', CI_LOCAL_HEAVY_MAX: '1', CI_LOCAL_EXPRESS: '0', CI_LOCAL_MAX_PARALLEL: '2',
  }, { cores: 32 });
  assert.deepEqual([o.budget, o.heavyCost, o.heavyMax, o.express, o.maxFull], [10, 4, 1, 0, 2]);
  assert.equal(resolveBudgetConfig({ CI_LOCAL_LOCK: '0' }).off, true);
  assert.equal(resolveBudgetConfig({ CI_LOCAL_LOCK: '1' }).off, false);
  assert.equal(resolveBudgetConfig({ CI_LOCAL_BUDGET: '3', CI_LOCAL_HEAVY_COST: '9' }).heavyCost, 3, 'heavy cost is clamped to the budget');
  const bad = resolveBudgetConfig({ CI_LOCAL_BUDGET: 'lots' }, { cores: 32 });
  assert.equal(bad.budget, 16);
  assert.match(bad.warnings[0], /CI_LOCAL_BUDGET="lots"/);
});

test('budgetDir: repo-neutral, CI_BUDGET_DIR wins', () => {
  assert.equal(budgetDir({ CI_BUDGET_DIR: '/x/y' }), '/x/y');
  const d = budgetDir({});
  assert.match(d, /ci-budget$/);
  assert.doesNotMatch(d, /agent-templates/);
  assert.equal(resolveBudgetConfig({ CI_BUDGET_DIR: '/x/y' }).dir, '/x/y');
});

test('CI_LOCAL_LOCK=0 bypasses: a no-op lease that grants what was asked and writes nothing', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { env: { CI_LOCAL_LOCK: '0' } });
    writeLease(t.dir, { units: 8 }); // a full budget held by someone else
    const l = w.acquire({ desired: 5 });
    assert.equal(l.units, 5);
    assert.equal(l.resize(3).units, 3);
    l.release();
    assert.equal(w.sleeps, 0);
    assert.equal(files(t.dir, /ticket-/).length, 0);
    assert.equal(files(t.dir, /lease-/).length, 1, 'only the pre-existing lease');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- admission

test('admission under the budget: granted at once, recorded in the ledger, never past the budget', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const a = w.acquire({ desired: 4, pid: 101, worktree: 'wt-A', repo: 'repo-A' });
    const b = w.acquire({ desired: 3, pid: 102, worktree: 'wt-B' });
    assert.equal(a.units, 4);
    assert.equal(b.units, 3);
    assert.equal(w.sleeps, 0, 'no waiting');
    assert.deepEqual(w.lines, []);
    const rec = JSON.parse(readFileSync(join(t.dir, `lease-${a.id}.json`), 'utf8'));
    assert.equal(rec.pid, 101);
    assert.equal(rec.kind, 'full');
    assert.equal(rec.units, 4);
    assert.equal(rec.heavy, 0);
    assert.equal(rec.worktree, 'wt-A');
    assert.equal(rec.repo, 'repo-A');
    assert.equal(typeof rec.startedAt, 'number');
    assert.equal(typeof rec.heartbeatAt, 'number');
    assert.equal(w.status({ sample: false }).held, 7);
    a.release(); b.release();
    assert.equal(files(t.dir, /^(lease|ticket)-/).length, 0, 'release leaves no file behind');
  } finally { t.cleanup(); }
});

test('share of free: grant = min(desired, free) with a floor of 1; no free unit means wait', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const a = w.acquire({ desired: 6, pid: 101 });
    const b = w.acquire({ desired: 8, pid: 102 });
    assert.equal(b.units, 2, 'gets its share of what is free, not what it asked for');
    assert.match(w.lines.join('\n'), /starting with 2 of 8 workers/);
    // 8 of 8 held: a third full run waits (and does not fail until its own timeout)
    assert.throws(() => w.acquire({ desired: 2, pid: 103, timeoutMs: 5000 }), { code: 'EBUDGETTIMEOUT' });
    b.release();
    a.release();
    const c = w.acquire({ desired: 1, pid: 104 });
    const d = w.acquire({ desired: 5, pid: 105 });
    const e = w.acquire({ desired: 5, pid: 106 });
    assert.deepEqual([c.units, d.units, e.units], [1, 5, 2]);
    c.release(); d.release(); e.release();
    // floor 1: 7 of 8 held, ask for 5, get the 1 that is free
    const f = w.acquire({ desired: 7, pid: 107 });
    const g = w.acquire({ desired: 5, pid: 108 });
    assert.deepEqual([f.units, g.units], [7, 1]);
  } finally { t.cleanup(); }
});

test('external load: busy cores that our held units do not explain count against the budget', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    w.busy = 5; // nothing of ours is held, so all 5 are outside load
    const a = w.acquire({ desired: 8, pid: 101 });
    assert.equal(a.units, 3, 'budget 8 minus 5 outside');
    // 3 held explains 3 of the 8 busy cores; the other 5 still count: free = 8 - 3 - 5 = 0
    w.busy = 8;
    assert.throws(() => w.acquire({ desired: 2, pid: 102, timeoutMs: 4000 }), { code: 'EBUDGETTIMEOUT' });
    // 4 busy, 3 held: outside = 1, free = 8 - 3 - 1 = 4
    w.busy = 4;
    const b = w.acquire({ desired: 9, pid: 103 });
    assert.equal(b.units, 4);
    a.release(); b.release();
    // alone on a saturated box: a run still starts with one worker rather than starving
    w.busy = 40;
    const c = w.acquire({ desired: 8, pid: 104 });
    assert.equal(c.units, 1);
  } finally { t.cleanup(); }
});

test('the sampler: busy cores over a window from two os.cpus() reads, no spawn', () => {
  const mk = (rows) => rows.map(([user, sys, idle]) => ({ times: { user, nice: 0, sys, idle, irq: 0 } }));
  const reads = [mk([[0, 0, 0], [0, 0, 0], [0, 0, 0]]), mk([[50, 0, 50], [100, 0, 0], [0, 0, 100]])];
  let slept = 0;
  const busy = sampleBusyCores({ ms: 300, sleep: (ms) => { slept = ms; }, read: () => reads.shift() });
  assert.equal(slept, 300);
  assert.equal(busy, 1.5); // half busy + fully busy + idle
});

test('maxFull (CI_LOCAL_MAX_PARALLEL) caps concurrent full runs, not targeted ones', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { maxFull: 1 });
    const a = w.acquire({ desired: 2, pid: 101 });
    assert.throws(() => w.acquire({ desired: 2, pid: 102, timeoutMs: 3000 }), { code: 'EBUDGETTIMEOUT' });
    const x = w.acquire({ kind: 'targeted', pid: 103 });
    assert.equal(x.units, 1);
    a.release();
    assert.equal(w.acquire({ desired: 2, pid: 104 }).units, 2);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- fair queue

test('queue: only the head ticket is admitted, a later arrival never jumps it', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const aTicket = writeTicket(t.dir, { pid: 201, createdAt: T0 - 5000, desired: 4, worktree: 'wt-first' });
    // Plenty of budget is free, but pid 201 queued first and is alive: we wait behind it.
    assert.throws(() => w.acquire({ desired: 2, pid: 202, timeoutMs: 4000 }), { code: 'EBUDGETTIMEOUT' });
    assert.match(w.lines[0], /queue position 2 of 2; head is pid 201 in wt-first/);
    assert.equal(files(t.dir, /^ticket-/).length, 1, 'a timed-out waiter takes its ticket with it');
    w.lines.length = 0;
    w.onSleep = (n) => { if (n === 2) rmSync(join(t.dir, `ticket-${aTicket}.json`)); };
    const b = w.acquire({ desired: 2, pid: 202 });
    assert.equal(b.units, 2);
    assert.equal(w.sleeps >= 2, true);
    assert.equal(files(t.dir, /^ticket-/).length, 0, 'the admitted run holds a lease, not a ticket');
  } finally { t.cleanup(); }
});

test('queue order is (createdAt, pid): same time breaks on the lower pid', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeTicket(t.dir, { pid: 9, createdAt: T0 + 5 });
    writeTicket(t.dir, { pid: 5, createdAt: T0 + 5 });
    writeTicket(t.dir, { pid: 7, createdAt: T0 });
    const q = w.status({ sample: false }).queue;
    assert.deepEqual(q.map((e) => [e.position, e.pid]), [[1, 7], [2, 5], [3, 9]]);
  } finally { t.cleanup(); }
});

test('queue: the full head waits for free budget; the next ticket is admitted after it', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const hog = w.acquire({ desired: 8, pid: 301 });
    const t1 = writeTicket(t.dir, { pid: 302, createdAt: T0 - 100 });
    // we are #2 behind a live head; the budget frees up, but the head is still first
    w.onSleep = (n) => { if (n === 1) hog.release(); if (n === 3) rmSync(join(t.dir, `ticket-${t1}.json`)); };
    const b = w.acquire({ desired: 3, pid: 303 });
    assert.equal(b.units, 3);
    assert.equal(w.sleeps, 3, 'waited exactly until the head ticket was gone');
  } finally { t.cleanup(); }
});

test('the waiting line prints once at the start and then every 60 s', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { staleMs: 1e9 }); // the holder has no heartbeat in this fake world
    w.acquire({ desired: 8, pid: 401 });
    assert.throws(() => w.acquire({ desired: 1, pid: 402, timeoutMs: 125_000 }), { code: 'EBUDGETTIMEOUT' });
    const waiting = w.lines.filter((l) => /^ci-budget: waiting/.test(l));
    assert.equal(waiting.length, 3, 'at 0 s, 60 s and 120 s');
    assert.match(waiting[0], /budget 8, held 8/);
    assert.match(waiting[0], /CI_LOCAL_LOCK=0 skips the budget/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- reclaim

test('reclaim: a lease whose pid is dead is dropped and its units come back', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeLease(t.dir, { pid: DEAD_PID, units: 8, worktree: 'wt-ghost' });
    writeTicket(t.dir, { pid: DEAD_PID, createdAt: T0 - 1000 });
    const a = w.acquire({ desired: 8, pid: 501 });
    assert.equal(a.units, 8, 'the ghost held the whole budget and its ticket was first in line');
    assert.equal(w.sleeps, 0);
    assert.match(w.lines.join('\n'), /reclaimed a stale lease \(process is gone\).*wt-ghost/);
    assert.match(w.lines.join('\n'), /reclaimed a stale ticket \(process is gone\)/);
    assert.equal(files(t.dir, /^lease-.*\.json$/).length, 1);
  } finally { t.cleanup(); }
});

test('reclaim: a live pid with a stale heartbeat is dropped; a fresh heartbeat, in the file or in the sidecar, is not', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeLease(t.dir, { pid: 601, units: 2, heartbeatAt: T0 - 100_000, startedAt: T0 - 100_000, worktree: 'wt-hung' });
    writeLease(t.dir, { pid: 602, units: 2, heartbeatAt: T0 - 10_000, startedAt: T0 - 500_000, worktree: 'wt-fresh' });
    writeLease(t.dir, { pid: 603, units: 2, heartbeatAt: T0 - 500_000, startedAt: T0 - 500_000, hb: T0 - 5_000, worktree: 'wt-side' });
    const st = w.status({ sample: false });
    assert.equal(st.held, 4, 'status excludes the hung lease');
    assert.deepEqual(st.stale.map((s) => [s.pid, s.why]), [[601, 'heartbeat is stale']]);
    assert.equal(files(t.dir, /^lease-.*\.json$/).length, 3, 'status never deletes');
    const a = w.acquire({ desired: 8, pid: 604 });
    assert.equal(a.units, 4);
    assert.equal(files(t.dir, /^lease-.*\.json$/).length, 3, 'two survivors and ours');
    assert.match(w.lines.join('\n'), /reclaimed a stale lease \(heartbeat is stale\).*wt-hung/);
  } finally { t.cleanup(); }
});

test('reclaim: a stale queue ticket (live pid, old heartbeat) does not block the run behind it', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeTicket(t.dir, { pid: 701, createdAt: T0 - 200_000, heartbeatAt: T0 - 200_000 });
    const a = w.acquire({ desired: 2, pid: 702 });
    assert.equal(a.units, 2);
    assert.equal(w.sleeps, 0);
  } finally { t.cleanup(); }
});

test('reclaim: a dead admission mutex is broken, not waited on forever', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeFileSync(join(t.dir, 'admit.lock'), JSON.stringify({ pid: DEAD_PID, at: T0, token: 'x' }));
    const a = w.acquire({ desired: 2, pid: 801 });
    assert.equal(a.units, 2);
    assert.equal(existsSync(join(t.dir, 'admit.lock')), false, 'released after admission');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- heavy lane

test('heavy workers cost heavyCost units each and are capped machine-wide', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { budget: 16 });
    const a = w.acquire({ desired: 4, pid: 901 });
    assert.deepEqual(a.resize({ units: 0, heavy: 2 }), { units: 0, heavy: 2 });
    assert.equal(a.charge, 6, '2 heavy workers x 3 units');
    assert.equal(w.status({ sample: false }).held, 6);
    assert.equal(w.status({ sample: false }).heavyHeld, 2);
    // the cap is reached: a second run's heavy request is refused; it keeps one plain worker
    const b = w.acquire({ desired: 4, pid: 902, timeoutMs: 5000 });
    assert.deepEqual(b.resize({ units: 0, heavy: 1 }), { units: 1, heavy: 0 });
    // waiting for the lane blocks until the holder drops back (the timeout proves it waited)
    assert.throws(() => b.resize({ units: 0, heavy: 1 }, { wait: true }), { code: 'EBUDGETTIMEOUT' });
  } finally { t.cleanup(); }
});

test('heavy lane: a waiter gets a slot as soon as a holder shrinks', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { budget: 16, heavyMax: 1 });
    const a = w.acquire({ desired: 2, pid: 911 });
    a.resize({ units: 0, heavy: 1 });
    const b = w.acquire({ desired: 2, pid: 912 });
    w.onSleep = (n) => { if (n === 2) a.resize({ units: 2, heavy: 0 }); };
    assert.deepEqual(b.resize({ units: 0, heavy: 1 }, { wait: true }), { units: 0, heavy: 1 });
    assert.match(w.lines.join('\n'), /waiting for a heavy-lane slot/);
  } finally { t.cleanup(); }
});

test('heavy cost is checked against free budget, not just the cap', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { budget: 6 });
    const a = w.acquire({ desired: 4, pid: 921 });
    const b = w.acquire({ desired: 2, pid: 922 });
    assert.deepEqual([a.units, b.units], [4, 2]);
    // b swaps its 2 plain units for a heavy lane: 6 - 4 held by a = 2 free, a heavy worker needs 3.
    // The cap (2) has room, the budget does not, so b keeps one plain worker.
    assert.deepEqual(b.resize({ units: 0, heavy: 1 }), { units: 1, heavy: 0 });
    a.resize(1); // a shrinks: 6 - 1 held by a = 5 free, so the heavy worker fits
    assert.deepEqual(b.resize({ units: 0, heavy: 1 }), { units: 0, heavy: 1 });
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- express

test('express: a targeted run is admitted at once, with no ticket, up to budget + express', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const full = w.acquire({ desired: 8, pid: 1001 });
    writeTicket(t.dir, { pid: 1002, createdAt: T0 - 9000 }); // a full run is queued and the budget is spent
    const x1 = w.acquire({ kind: 'targeted', pid: 1003, worktree: 'wt-x1' });
    const x2 = w.acquire({ kind: 'targeted', pid: 1004 });
    assert.equal(w.sleeps, 0, 'neither waited');
    assert.deepEqual([x1.units, x2.units, x1.kind], [1, 1, 'targeted']);
    assert.equal(files(t.dir, /^ticket-/).length, 1, 'only the queued full run has a ticket');
    assert.equal(w.status({ sample: false }).held, 10);
    // headroom is spent (8 + 2 = 10 of 10): a third waits, still without a ticket
    assert.throws(() => w.acquire({ kind: 'targeted', pid: 1005, timeoutMs: 3000 }), { code: 'EBUDGETTIMEOUT' });
    assert.equal(files(t.dir, /^ticket-/).length, 1);
    x1.release();
    const x3 = w.acquire({ kind: 'targeted', pid: 1006 });
    assert.equal(x3.units, 1);
    full.release();
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- resize

test('resize: a shrink applies at once, a grow is limited to what is free, never below one worker', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const a = w.acquire({ desired: 6, pid: 1101 });
    const b = w.acquire({ desired: 2, pid: 1102 });
    assert.equal(a.resize(2).units, 2);
    assert.equal(JSON.parse(readFileSync(join(t.dir, `lease-${a.id}.json`), 'utf8')).units, 2);
    assert.equal(w.status({ sample: false }).held, 4);
    assert.equal(a.resize(20).units, 6, 'grows to the 4 that are free, no further');
    assert.equal(a.resize(0).units, 1, 'floor of one');
    assert.equal(a.workers, 1);
    assert.equal(b.resize(3).units, 3);
    w.busy = 12; // outside load makes a grow shrink the grant too: free = 8 - 4 - (12 - 4)
    assert.equal(b.resize(7).units, 3, 'no free units, so the grow is refused');
    a.release();
    assert.throws(() => a.resize(2), /released/);
  } finally { t.cleanup(); }
});

test('resize can carry a label that status shows', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    const a = w.acquire({ desired: 2, pid: 1201, label: 'unit tests' });
    a.resize({ units: 1, label: 'git-heavy files' });
    assert.equal(w.status({ sample: false }).leases[0].label, 'git-heavy files');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- status

test('status: budget, held, free, outside load, every lease (any repo) and the queue', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { budget: 16 });
    const a = w.acquire({ desired: 4, pid: 1301, worktree: 'wt-run', repo: 'agent-templates' });
    a.resize({ units: 2, heavy: 1 });
    writeLease(t.dir, { pid: 1302, units: 1, kind: 'targeted', worktree: 'wt-elsewhere', repo: 'sibling-repo', startedAt: T0 - 65_000, heartbeatAt: T0 - 15_000 });
    writeTicket(t.dir, { pid: 1303, desired: 6, createdAt: T0 - 125_000, worktree: 'wt-waiting' });
    w.busy = 9;
    const st = w.status();
    assert.equal(st.budget, 16);
    assert.equal(st.held, 6, '2 plain + 1 heavy x 3 + 1 targeted');
    assert.equal(st.heavyHeld, 1);
    assert.equal(st.busyCores, 9);
    assert.equal(st.external, 3, '9 busy minus 6 held');
    assert.equal(st.free, 7);
    assert.equal(st.leases.length, 2);
    const mine = st.leases.find((l) => l.pid === 1301);
    assert.deepEqual(
      [mine.kind, mine.repo, mine.worktree, mine.units, mine.heavy, mine.workers, mine.charge],
      ['full', 'agent-templates', 'wt-run', 2, 1, 3, 5],
    );
    const other = st.leases.find((l) => l.pid === 1302);
    assert.deepEqual([other.kind, other.repo, other.ageMs, other.heartbeatAgeMs], ['targeted', 'sibling-repo', 65_000, 15_000]);
    assert.deepEqual(st.queue.map((q) => [q.position, q.pid, q.desired, q.waitedMs, q.repo]), [[1, 1303, 6, 125_000, 'other-repo']]);
    const text = formatStatus(st);
    assert.match(text, /CI budget: 16 units.*held 6, free 7/);
    assert.match(text, /1\/2 heavy workers/);
    assert.match(text, /outside load: ~3 cores/);
    assert.match(text, /full +pid 1301 +workers 3 \(plain 2, heavy 1; cost 5\).*agent-templates wt-run/);
    assert.match(text, /targeted +pid 1302 .*age 1m05s +heartbeat 15s ago +sibling-repo wt-elsewhere/);
    assert.match(text, /#1 pid 1303 +wants 6 +waiting 2m05s +other-repo wt-waiting/);
    assert.equal(w.status({ sample: false }).busyCores, null);
    assert.match(formatStatus(w.status({ sample: false })), /not sampled/);
  } finally { t.cleanup(); }
});

function run(args, env) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    const c = spawn(process.execPath, [MODULE_PATH, ...args], {
      windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { c.kill(); reject(new Error('status command hung')); }, 20_000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('status command: node scripts/ci-budget.mjs status [--json] reads the ledger from CI_BUDGET_DIR', async () => {
  const t = tmp();
  try {
    writeLease(t.dir, { pid: process.pid, units: 3, worktree: 'wt-cli', repo: 'cli-repo', startedAt: Date.now(), heartbeatAt: Date.now() });
    const env = { CI_BUDGET_DIR: t.dir, CI_LOCAL_BUDGET: '12', CI_LOCAL_LOCK: '' };
    const plain = await run(['status', '--no-sample'], env);
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out, /CI budget: 12 units/);
    assert.match(plain.out, new RegExp(`pid ${process.pid}`));
    assert.match(plain.out, /cli-repo wt-cli/);
    const json = await run(['status', '--json', '--no-sample'], env);
    const st = JSON.parse(json.out);
    assert.equal(st.budget, 12);
    assert.equal(st.held, 3);
    assert.equal(st.free, 9);
    assert.equal(st.leases[0].worktree, 'wt-cli');
    const bad = await run(['nonsense'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /usage: node scripts\/ci-budget.mjs status/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------- processes

function runChild(code, args, env = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
      windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => { c.kill(); reject(new Error('child hung')); }, 30_000);
    c.stdout.on('data', (d) => { stdout += d; });
    c.on('error', reject);
    c.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
  });
}

test('two processes racing for the same budget never over-admit', async () => {
  const code = `
    import { acquire } from ${JSON.stringify(MODULE_URL)};
    import { appendFileSync } from 'node:fs';
    const [id, goAt, dir, out] = process.argv.slice(1);
    while (Date.now() < Number(goAt)) { /* start together */ }
    const l = acquire({ dir, env: { CI_LOCAL_LOCK_DIR: process.env.CI_LOCAL_LOCK_DIR }, budget: 6, desired: 4, repo: 'race', worktree: 'wt-' + id,
      heartbeat: 'off', sampler: () => 0, log: () => {}, pollMs: 25 });
    appendFileSync(out, id + ' start ' + l.units + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    appendFileSync(out, id + ' end ' + l.units + '\\n');
    l.release();
  `;
  for (let round = 0; round < 3; round += 1) {
    const t = tmp();
    try {
      const out = join(t.dir, 'events.log');
      const dir = join(t.dir, 'ledger');
      const goAt = String(Date.now() + 700);
      const results = await Promise.all(['A', 'B'].map((id) => runChild(code, [id, goAt, dir, out])));
      assert.deepEqual(results.map((r) => r.status), [0, 0]);
      let held = 0; let peak = 0;
      const grants = [];
      for (const line of readFileSync(out, 'utf8').trim().split('\n')) {
        const [, kind, units] = line.split(' ');
        if (kind === 'start') { held += Number(units); grants.push(Number(units)); } else held -= Number(units);
        peak = Math.max(peak, held);
      }
      assert.equal(grants.length, 2);
      assert.ok(peak <= 6, `peak ${peak} of 6 (round ${round})`);
      assert.ok(grants.every((g) => g >= 1));
      assert.equal(files(dir, /^(lease|ticket)-/).length, 0);
    } finally { t.cleanup(); }
  }
});

test('release on exit: a process that exits or throws without releasing leaves no lease behind', async () => {
  for (const how of ['process.exit(0)', "throw new Error('boom')"]) {
    const t = tmp();
    try {
      const code = `
        import { acquire } from ${JSON.stringify(MODULE_URL)};
        const [dir] = process.argv.slice(1);
        const l = acquire({ dir, env: { CI_LOCAL_LOCK_DIR: process.env.CI_LOCAL_LOCK_DIR }, budget: 4, desired: 2, sampler: () => 0, log: () => {},
          heartbeat: 'worker', heartbeatMs: 5000 });
        process.stdout.write('held ' + l.units);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // let the worker's first tick land
        ${how};
      `;
      const r = await runChild(code, [t.dir]);
      assert.equal(r.stdout, 'held 2');
      assert.equal(r.status, how.startsWith('throw') ? 1 : 0);
      assert.deepEqual(files(t.dir, /^(lease|ticket)-/), [], how);
    } finally { t.cleanup(); }
  }
});

test('release on SIGTERM: the handler frees the lease and exits 143', { skip: process.platform === 'win32' }, async () => {
  const t = tmp();
  try {
    const code = `
      import { acquire } from ${JSON.stringify(MODULE_URL)};
      acquire({ dir: process.argv[1], env: { CI_LOCAL_LOCK_DIR: process.env.CI_LOCAL_LOCK_DIR }, budget: 4, desired: 2, sampler: () => 0, log: () => {}, heartbeat: 'off' });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `;
    const status = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code, t.dir], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.on('data', () => c.kill('SIGTERM'));
      c.on('error', reject);
      c.on('exit', (s) => resolve(s));
    });
    assert.equal(status, 143);
    assert.deepEqual(files(t.dir, /^(lease|ticket)-/), []);
  } finally { t.cleanup(); }
});

test('the heartbeat keeps ticking while the main thread is blocked (ci-local sits in spawnSync)', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { heartbeat: 'worker', heartbeatMs: 50, now: Date.now });
    const a = w.acquire({ desired: 2, pid: process.pid });
    const hb = join(t.dir, `lease-${a.id}.hb`);
    const first = Number(readFileSync(hb, 'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // block this thread
    const later = Number(readFileSync(hb, 'utf8'));
    assert.ok(later - first >= 500, `heartbeat moved ${later - first} ms while blocked`);
    a.release();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // let the worker thread finish dying
    assert.equal(existsSync(join(t.dir, `lease-${a.id}.json`)), false);
  } finally { t.cleanup(); }
});

test('release wins over the heartbeat thread: a released lease is never restored (interleaving loop)', () => {
  // The thread restores a lease whose file is missing. release() removes the file
  // while a tick may be in flight; before the fix a tick could land after the
  // unlink and put the lease back. Hammer the interleaving with a 1 ms tick and
  // a random delay between acquire and release, blocking this thread the whole
  // time (as ci-local does in spawnSync), and look at the directory straight away
  // and again after the thread has had time to tick.
  const t = tmp();
  try {
    const w = world(t.dir, { heartbeat: 'worker', heartbeatMs: 1, now: Date.now });
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const rounds = 60;
    for (let i = 0; i < rounds; i += 1) {
      const a = w.acquire({ desired: 2, pid: process.pid });
      pause(i % 6 === 0 ? 0 : (i * 7) % 45); // from "before the thread's first tick" to "well into its ticking"
      a.release();
      assert.deepEqual(files(t.dir, /^lease-/), [], `round ${i}: lease files right after release()`);
      pause(i % 4 === 0 ? 15 : 3);
      assert.deepEqual(files(t.dir, /^lease-/), [], `round ${i}: lease files after the thread had time to tick`);
    }
  } finally { t.cleanup(); }
});

test('a live lease that was reclaimed during a freeze is put back by the heartbeat thread, with its latest size', () => {
  const t = tmp();
  try {
    const w = world(t.dir, { heartbeat: 'worker', heartbeatMs: 50, now: Date.now });
    const a = w.acquire({ desired: 5, pid: process.pid });
    const file = join(t.dir, `lease-${a.id}.json`);
    rmSync(file); // someone judged it stale while this process slept
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).units, 5);
    a.resize(2);
    rmSync(file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).units, 2, 'the thread restores the resized record, not the first one');
    assert.equal(w.status({ sample: false }).held, 2);
    a.release();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    assert.deepEqual(files(t.dir, /^lease-/), [], 'a released lease is not revived by a late tick');
  } finally { t.cleanup(); }
});

test('transition: a live holder of the old ci-lock mutex counts as one full run at the default concurrency', () => {
  const t = tmp();
  try {
    const legacy = join(t.dir, 'legacy');
    mkdirSync(legacy);
    const slot = (n, over = {}) => writeFileSync(join(legacy, `slot-${n}.lock`), JSON.stringify({
      pid: 4242, worktree: 'wt-old', startedAt: T0, token: 'x', ...over,
    }));
    slot(0);
    const w = world(t.dir, { budget: 16, legacyDir: legacy, cores: 32 });
    assert.equal(legacyRunUnits(32), 8);
    assert.equal(legacyRunUnits(2), 1);
    assert.equal(legacyRunUnits(64), 8, 'capped at 8, the old default');
    let st = w.status({ sample: false });
    assert.equal(st.held, 8);
    assert.equal(st.free, 8);
    assert.deepEqual(st.legacy.map((l) => [l.pid, l.worktree, l.units]), [[4242, 'wt-old', 8]]);
    assert.match(formatStatus(st), /Old run lock still held.*8 units.*wt-old/);
    const a = w.acquire({ desired: 12, pid: 1501 });
    assert.equal(a.units, 8, 'a new run gets only what the old run leaves');
    // two old holders fill the budget: a new run waits for one of them to go
    slot(1, { pid: 4343 });
    w.dead.add(4242);
    st = w.status({ sample: false });
    assert.equal(st.legacy.length, 1, 'a dead holder does not count');
    assert.equal(st.held, 8 + 8);
    w.dead.add(4343);
    slot(2, { pid: 4444, startedAt: T0 - 46 * 60_000 });
    assert.equal(w.status({ sample: false }).legacy.length, 0, 'older than the old 45 min cap does not count');
    a.release();
    assert.equal(w.acquire({ desired: 12, pid: 1502 }).units, 12);
  } finally { t.cleanup(); }
});

test('a sparse or mistyped lease from another writer cannot break totals or status', () => {
  const t = tmp();
  try {
    const w = world(t.dir);
    writeFileSync(join(t.dir, 'lease-000000000042.json'), JSON.stringify({
      pid: process.pid, units: 2, heavy: 1, heavyCost: 'abc', heartbeatAt: T0, startedAt: T0,
    }));
    const st = w.status({ sample: false });
    assert.equal(st.held, 2 + 3, 'a bad heavyCost falls back to the local one');
    assert.equal(st.leases[0].kind, 'full');
    assert.doesNotThrow(() => formatStatus(st));
    const a = w.acquire({ desired: 8, pid: 1401 });
    assert.equal(a.units, 3);
    assert.ok(Number.isFinite(a.units));
  } finally { t.cleanup(); }
});

test('an unusable ledger directory never fails a run: it runs unmanaged and says so', () => {
  const t = tmp();
  try {
    const blocker = join(t.dir, 'a-file');
    writeFileSync(blocker, 'x');
    const w = world(join(blocker, 'ledger'));
    const a = w.acquire({ desired: 4 });
    assert.equal(a.units, 4);
    assert.match(w.lines.join('\n'), /ledger directory .* is unusable/);
  } finally { t.cleanup(); }
});

test('targeted runs racing at the edge of the headroom never over-admit (this is the race admit.lock exists for)', async () => {
  const code = `
    import { acquire } from ${JSON.stringify(MODULE_URL)};
    import { appendFileSync } from 'node:fs';
    const [id, goAt, dir, out] = process.argv.slice(1);
    while (Date.now() < Number(goAt)) { /* start together */ }
    const l = acquire({ dir, env: { CI_LOCAL_LOCK_DIR: process.env.CI_LOCAL_LOCK_DIR }, budget: 1, express: 0, kind: 'targeted', repo: 'race', worktree: 'wt-' + id,
      heartbeat: 'off', log: () => {}, pollMs: 20 });
    appendFileSync(out, id + ' start\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    appendFileSync(out, id + ' end\\n');
    l.release();
  `;
  for (let round = 0; round < 4; round += 1) {
    const t = tmp();
    try {
      const out = join(t.dir, 'events.log');
      const goAt = String(Date.now() + 700);
      const results = await Promise.all(['A', 'B', 'C'].map((id) => runChild(code, [id, goAt, join(t.dir, 'ledger'), out])));
      assert.deepEqual(results.map((r) => r.status), [0, 0, 0]);
      let open = 0; let peak = 0; let starts = 0;
      for (const line of readFileSync(out, 'utf8').trim().split('\n')) {
        if (line.endsWith('start')) { open += 1; starts += 1; } else open -= 1;
        peak = Math.max(peak, open);
      }
      assert.equal(starts, 3, 'all three ran, one after another');
      assert.equal(peak, 1, `round ${round}: budget 1 and no headroom admits one at a time`);
    } finally { t.cleanup(); }
  }
});

test('isPidAlive: this process is, an absurd pid is not', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(DEAD_PID), false);
  assert.equal(isPidAlive(0), false);
});

after(() => rmSync(NO_LEGACY, { recursive: true, force: true }));
