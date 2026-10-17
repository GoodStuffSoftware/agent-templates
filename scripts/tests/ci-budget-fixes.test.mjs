// scripts/ci-budget.mjs: the 0.31.18 review fixes (heavy-lane deadlock on small budgets, the lone-run
// heavy floor, a bounded heavy wait, fail-open on ledger errors, crash-debris sweep, the repo label).
// Fake work only: every ledger is a fresh temp dir, the clock and the cpu sampler are injected, and no
// ci-local run happens here. The icacls spawn sets windowsHide: true.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire, status, resolveBudgetConfig, repoLabel } from '../../plugins/agent-companion/scripts/ci-budget.mjs';

const T0 = Date.now();
const NO_LEGACY = mkdtempSync(join(tmpdir(), 'ci-budget-fix-no-legacy-'));
const tmp = () => mkdtempSync(join(tmpdir(), 'ci-budget-fix-'));
const rm = (d) => rmSync(d, { recursive: true, force: true });

// A fake world: a clock that only moves when something sleeps, a cpu sampler the test controls.
function world(dir, over = {}) {
  const w = { t: T0, busy: 0, lines: [] };
  w.opts = {
    dir, env: { CI_LOCAL_LOCK_DIR: NO_LEGACY }, legacyDir: NO_LEGACY, budget: 16, heavyCost: 3, heavyMax: 2, express: 2,
    maxFull: Infinity, pollMs: 1500, announceMs: 60_000, staleMs: 86_400_000, heartbeat: 'off', registerExit: false,
    worktree: 'wt-fix', now: () => w.t, sleep: (ms) => { w.t += ms; }, sampler: () => w.busy, reserve: 0, loadPct: Infinity, log: (l) => w.lines.push(l),
    cores: 64, // the guard's threshold is cores - reserve: pinned, never the host's (ci-budget-small-host.test.mjs)
    ...over,
  };
  w.acquire = (extra = {}) => acquire({ ...w.opts, ...extra });
  w.status = (extra = {}) => status({ ...w.opts, ...extra });
  return w;
}

// ---------------------------------------------------------------- F1: no heavy-lane deadlock

test('F1: two runs entering the heavy pass on a small budget (2, 3) both make progress', () => {
  for (const budget of [2, 3]) {
    const t = tmp();
    try {
      const w = world(t, { budget });
      let b = null; let bGot = 0;
      const a = w.acquire({
        desired: 1,
        timeoutMs: 120_000,
        // B reaches its heavy pass while A is still polling (B's own poll is this hook); once B has
        // had its heavy worker it finishes and leaves.
        sleep: (ms) => {
          w.t += ms;
          if (!b || b.released) return;
          if (b.heavy > 0) { bGot += 1; b.release(); return; }
          try { b.resize({ units: 0, heavy: 1 }); } catch { /* ignore */ }
        },
      });
      b = w.acquire({ desired: 1 });
      a.resize({ units: 0, heavy: 1 }, { wait: true }); // must not time out
      assert.ok(a.heavy >= 1, `budget ${budget}: A got no heavy worker`);
      assert.equal(bGot, 1, `budget ${budget}: B got its heavy worker too`);
      assert.deepEqual(w.lines.filter((l) => /anyway/.test(l)), [], 'no fallback needed');
    } finally { rm(t); }
  }
});

test('F1: a parked heavy waiter holds nothing, so three runs at budget 4 take the heavy pass in turn', () => {
  const t = tmp();
  try {
    const w = world(t, { budget: 4, heavyMax: 1 }); // heavy costs 3 of 4
    const run0 = w.acquire({ desired: 1 });
    const p1 = w.acquire({ desired: 1, timeoutMs: 1 }); // a wait that gives up after one pass leaves the lease as a waiter is
    const p2 = w.acquire({ desired: 1, timeoutMs: 1 });
    assert.equal(w.status({ sample: false }).held, 3, 'three runs, one unit each');
    // p1 cannot get a slot (4 - 2 others = 2 < 3): it parks, holding nothing.
    assert.throws(() => p1.resize({ units: 0, heavy: 1 }, { wait: true }), { code: 'EBUDGETTIMEOUT' });
    assert.equal(p1.workers, 0, 'the parked waiter holds nothing');
    assert.equal(w.status({ sample: false }).held, 2, 'only run0 and p2 hold units');
    // p2 now has the room p1 gave up: 4 - 1 = 3 >= 3.
    assert.deepEqual(p2.resize({ units: 0, heavy: 1 }, { wait: true }), { units: 0, heavy: 1 });
    // p2 finishes its pass; run0 takes its turn, then p1.
    p2.resize({ units: 1, heavy: 0 });
    assert.deepEqual(run0.resize({ units: 0, heavy: 1 }, { wait: true }), { units: 0, heavy: 1 });
    run0.release(); p2.release();
    assert.deepEqual(p1.resize({ units: 0, heavy: 1 }, { wait: true }), { units: 0, heavy: 1 });
    assert.deepEqual(w.lines.filter((l) => /anyway/.test(l)), [], 'nobody needed the max-wait fallback');
    p1.release();
  } finally { rm(t); }
});

test('F1: a non-waiting heavy request keeps the one-worker floor; only a waiter parks at zero', () => {
  const t = tmp();
  try {
    const w = world(t, { budget: 2, heavyMax: 1 });
    const a = w.acquire({ desired: 1 });
    const b = w.acquire({ desired: 1 });
    assert.deepEqual(a.resize({ units: 0, heavy: 1 }), { units: 1, heavy: 0 }, 'no wait: takes what it can get, floor of one worker');
    assert.ok(b.workers >= 1);
  } finally { rm(t); }
});

// ---------------------------------------------------------------- F2: lone-run heavy floor

test('F2: a lone run in the heavy pass gets a heavy worker even when outside load fills the machine', () => {
  const t = tmp();
  try {
    const w = world(t);
    w.busy = 32;
    const lease = w.acquire({ desired: 8, timeoutMs: 60_000 });
    assert.ok(lease.units >= 1);
    const got = lease.resize({ units: 0, heavy: 2 }, { wait: true });
    assert.ok(got.heavy >= 1, JSON.stringify(got));
    assert.deepEqual(w.lines.filter((l) => /waiting|anyway/.test(l)), [], 'no waiting, no fallback line');
  } finally { rm(t); }
});

test('F2: the floor is for a run alone on the box; with another holder the outside load still counts', () => {
  const t = tmp();
  try {
    const w = world(t);
    w.busy = 32;
    const a = w.acquire({ desired: 1 });
    const b = w.acquire({ desired: 1, kind: 'targeted' });
    const got = a.resize({ units: 0, heavy: 1 }); // no wait: takes what it can get
    assert.equal(got.heavy, 0);
    b.release(); a.release();
  } finally { rm(t); }
});

// ---------------------------------------------------------------- bounded heavy wait

test('heavy wait is bounded: after CI_LOCAL_HEAVY_MAX_WAIT_MS the pass runs with one heavy worker and says so once', () => {
  const t = tmp();
  try {
    const w = world(t, { heavyMaxWaitMs: 5 * 60_000, announceMs: 1e9 });
    // A hung but alive holder with both heavy slots, as another process.
    const hungId = 'a'.repeat(12);
    writeFileSync(join(t, `lease-${hungId}.json`), JSON.stringify({
      id: hungId, pid: process.pid, startedAt: T0, heartbeatAt: T0, repo: 'other', worktree: 'wt-hung',
      kind: 'full', units: 0, heavy: 2, heavyCost: 3, label: '',
    }));
    const lease = w.acquire({ desired: 1, pid: process.pid + 1000, isAlive: () => true });
    const before = w.t;
    const got = lease.resize({ units: 0, heavy: 2 }, { wait: true });
    assert.deepEqual(got, { units: 0, heavy: 1 });
    assert.ok(w.t - before >= 5 * 60_000 && w.t - before < 5 * 60_000 + 5000, `waited ${w.t - before} ms of fake time`);
    const lines = w.lines.filter((l) => /one heavy worker anyway/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CI_LOCAL_HEAVY_MAX_WAIT_MS=300000/);
    lease.release();
  } finally { rm(t); }
});

test('CI_LOCAL_HEAVY_MAX_WAIT_MS: default 10 minutes, the env var overrides, a bad value warns', () => {
  assert.equal(resolveBudgetConfig({}, { cores: 32 }).heavyMaxWaitMs, 600_000);
  assert.equal(resolveBudgetConfig({ CI_LOCAL_HEAVY_MAX_WAIT_MS: '45000' }, { cores: 32 }).heavyMaxWaitMs, 45_000);
  const bad = resolveBudgetConfig({ CI_LOCAL_HEAVY_MAX_WAIT_MS: 'soon' }, { cores: 32 });
  assert.equal(bad.heavyMaxWaitMs, 600_000);
  assert.match(bad.warnings[0], /CI_LOCAL_HEAVY_MAX_WAIT_MS="soon"/);
});

// ---------------------------------------------------------------- queue and express waits are bounded

function hungHolder(dir, units) {
  const id = 'f'.repeat(12);
  writeFileSync(join(dir, `lease-${id}.json`), JSON.stringify({
    id, pid: process.pid, startedAt: T0, heartbeatAt: T0, repo: 'other', worktree: 'wt-hung',
    kind: 'full', units, heavy: 0, heavyCost: 3, label: '',
  }));
}

test('queue wait is bounded: after CI_LOCAL_QUEUE_MAX_WAIT_MS a full run starts with 1 worker over budget and says so once', () => {
  const t = tmp();
  try {
    const w = world(t, { budget: 2, queueMaxWaitMs: 30 * 60_000, announceMs: 1e9, pollMs: 30_000 });
    hungHolder(t, 2); // a hung but alive holder with the whole budget
    const before = w.t;
    const lease = w.acquire({ desired: 2, pid: process.pid + 1000, isAlive: () => true });
    assert.equal(lease.units, 1);
    assert.ok(w.t - before >= 30 * 60_000 && w.t - before < 30 * 60_000 + 30_000, `waited ${w.t - before} ms of fake time`);
    const lines = w.lines.filter((l) => /over budget/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CI_LOCAL_QUEUE_MAX_WAIT_MS=1800000/);
    assert.deepEqual(readdirSync(t).filter((n) => /^ticket-/.test(n)), [], 'the ticket is gone');
    assert.equal(w.status({ sample: false, isAlive: () => true }).held, 3, 'the forced lease is counted in the ledger');
    lease.release();
  } finally { rm(t); }
});

test('express wait is bounded: after CI_LOCAL_EXPRESS_MAX_WAIT_MS a targeted run starts over budget and says so once', () => {
  const t = tmp();
  try {
    const w = world(t, { budget: 1, express: 0, expressMaxWaitMs: 5 * 60_000, announceMs: 1e9 });
    hungHolder(t, 1);
    const before = w.t;
    const lease = w.acquire({ kind: 'targeted', pid: process.pid + 1000, isAlive: () => true });
    assert.equal(lease.units, 1);
    assert.ok(w.t - before >= 5 * 60_000 && w.t - before < 5 * 60_000 + 5000, `waited ${w.t - before} ms of fake time`);
    const lines = w.lines.filter((l) => /over budget/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CI_LOCAL_EXPRESS_MAX_WAIT_MS=300000/);
    assert.deepEqual(readdirSync(t).filter((n) => /^ticket-/.test(n)), [], 'still no ticket');
    lease.release();
  } finally { rm(t); }
});

test('CI_LOCAL_QUEUE_MAX_WAIT_MS and CI_LOCAL_EXPRESS_MAX_WAIT_MS: defaults 30 and 5 minutes, env overrides, bad values warn', () => {
  const d = resolveBudgetConfig({}, { cores: 32 });
  assert.equal(d.queueMaxWaitMs, 30 * 60_000);
  assert.equal(d.expressMaxWaitMs, 5 * 60_000);
  const o = resolveBudgetConfig({ CI_LOCAL_QUEUE_MAX_WAIT_MS: '1000', CI_LOCAL_EXPRESS_MAX_WAIT_MS: '2000' }, { cores: 32 });
  assert.deepEqual([o.queueMaxWaitMs, o.expressMaxWaitMs], [1000, 2000]);
  const bad = resolveBudgetConfig({ CI_LOCAL_QUEUE_MAX_WAIT_MS: 'later', CI_LOCAL_EXPRESS_MAX_WAIT_MS: '0' }, { cores: 32 });
  assert.deepEqual([bad.queueMaxWaitMs, bad.expressMaxWaitMs], [30 * 60_000, 5 * 60_000]);
  assert.match(bad.warnings[0], /CI_LOCAL_QUEUE_MAX_WAIT_MS="later"/);
  assert.match(bad.warnings[1], /CI_LOCAL_EXPRESS_MAX_WAIT_MS="0"/);
});

// ---------------------------------------------------------------- F3 / N1: fail open

test('F3: a ledger directory that exists but cannot be written never makes acquire() throw', (ctx) => {
  const t = tmp();
  const dir = join(t, 'ledger');
  mkdirSync(dir);
  const user = process.env.USERNAME || process.env.USER;
  let locked = false;
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [dir, '/deny', `${user}:(WD,AD)`], { windowsHide: true, stdio: 'ignore' });
      locked = true;
    } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      chmodSync(dir, 0o500);
      locked = true;
    }
    if (!locked) { ctx.skip('cannot make a directory read-only here'); return; }
    for (const kind of ['full', 'targeted']) {
      const w = world(dir, { timeoutMs: 3000 });
      let lease = null; let err = null;
      try { lease = w.acquire({ kind, desired: 4 }); } catch (e) { err = e; }
      assert.equal(err, null, `${kind}: acquire threw ${err && err.code}`);
      assert.ok(lease && lease.units >= 1);
      assert.equal(w.lines.length, 1, `${kind}: exactly one line: ${JSON.stringify(w.lines)}`);
      assert.match(w.lines[0], /without the budget/);
      lease.release();
    }
  } finally {
    try {
      if (process.platform === 'win32') execFileSync('icacls', [dir, '/remove:d', user], { windowsHide: true, stdio: 'ignore' });
      else chmodSync(dir, 0o700);
    } catch { /* best effort */ }
    rm(t);
  }
});

test('F3: a ledger that breaks in the middle of a run (resize) goes on unmanaged with one line', () => {
  const t = tmp();
  const dir = join(t, 'ledger');
  try {
    const w = world(dir);
    const lease = w.acquire({ desired: 4 });
    assert.equal(lease.units, 4);
    // The ledger directory is replaced by a plain file: every write now fails.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');
    let got = null;
    assert.doesNotThrow(() => { got = lease.resize({ units: 0, heavy: 2 }, { wait: true }); });
    assert.deepEqual(got, { units: 0, heavy: 2 });
    assert.doesNotThrow(() => { got = lease.resize({ units: 3, heavy: 0 }); });
    assert.deepEqual(got, { units: 3, heavy: 0 });
    assert.equal(w.lines.filter((l) => /without the budget|goes on without/.test(l)).length, 1, JSON.stringify(w.lines));
    assert.doesNotThrow(() => lease.release());
  } finally { rm(t); }
});

test('N1: a throwing cpu sampler never fails a run or a resize', () => {
  const t = tmp();
  try {
    const w = world(t, { sampler: () => { throw new Error('cpu counters unavailable'); } });
    let lease = null;
    assert.doesNotThrow(() => { lease = w.acquire({ desired: 4 }); });
    assert.ok(lease && lease.units >= 1);
    assert.equal(w.lines.length, 1);
    assert.match(w.lines[0], /without the budget/);
    // a lease taken while the sampler works, which then starts to throw
    const w2 = world(t, {});
    const l2 = w2.acquire({ desired: 2 });
    w2.opts.sampler = () => { throw new Error('boom'); };
    const l3 = acquire({ ...w2.opts, desired: 1, sampler: () => { throw new Error('boom'); } });
    assert.ok(l3.units >= 1);
    assert.doesNotThrow(() => l2.resize({ units: 4, heavy: 0 }));
  } finally { rm(t); }
});

// ---------------------------------------------------------------- N2: crash debris

test('N2: crash debris (*.tmp-*, *.stale-*) older than 10 minutes is swept when a lease is acquired; young debris stays', () => {
  const t = tmp();
  try {
    const w = world(t);
    const old = new Date(Date.now() - 2 * 3600e3);
    const hex = (c) => c.repeat(12);
    const olds = [`lease-${hex('a')}.json.tmp-${hex('e')}`, `lease-${hex('b')}.json.stale-${hex('e')}`, `ticket-${hex('c')}.json.tmp-${hex('e')}`];
    for (const n of olds) { writeFileSync(join(t, n), '{'); utimesSync(join(t, n), old, old); }
    const young = `lease-${hex('d')}.json.tmp-${hex('e')}`;
    writeFileSync(join(t, young), '{'); // just written: may be in flight
    w.acquire({ desired: 1 }).release();
    assert.deepEqual(readdirSync(t).filter((n) => /\.(tmp|stale)-/.test(n)), [young]);
  } finally { rm(t); }
});

// ---------------------------------------------------------------- N3: repo label

test('N3: the repo label defaults to the basename of the git top-level directory above the worktree', () => {
  const t = tmp(); const other = tmp();
  try {
    const top = join(other, 'other-repo');
    mkdirSync(join(top, '.git'), { recursive: true });
    mkdirSync(join(top, 'sub', 'dir'), { recursive: true });
    assert.equal(repoLabel(top), 'other-repo');
    assert.equal(repoLabel(join(top, 'sub', 'dir')), 'other-repo', 'walks up from a subdirectory');
    // a linked worktree has a .git FILE
    const linked = join(other, 'linked-wt');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), 'gitdir: elsewhere');
    assert.equal(repoLabel(linked), 'linked-wt');
    // no .git anywhere above: the basename of the directory itself
    const loose = join(other, 'loose');
    mkdirSync(loose);
    const w = world(t);
    const lease = w.acquire({ desired: 1, worktree: top });
    const rec = JSON.parse(readFileSync(join(t, readdirSync(t).find((n) => /^lease-.*\.json$/.test(n))), 'utf8'));
    lease.release();
    assert.equal(rec.repo, 'other-repo');
  } finally { rm(t); rm(other); }
});

test('N3: CI_BUDGET_REPO and the repo option still override the label', () => {
  const t = tmp(); const other = tmp();
  try {
    mkdirSync(join(other, '.git'));
    const read = () => JSON.parse(readFileSync(join(t, readdirSync(t).find((n) => /^lease-.*\.json$/.test(n))), 'utf8')).repo;
    const w = world(t, { env: { CI_LOCAL_LOCK_DIR: NO_LEGACY, CI_BUDGET_REPO: 'from-env' } });
    let lease = w.acquire({ desired: 1, worktree: other });
    assert.equal(read(), 'from-env');
    lease.release();
    lease = w.acquire({ desired: 1, worktree: other, repo: 'from-option' });
    assert.equal(read(), 'from-option');
    lease.release();
  } finally { rm(t); rm(other); }
});

after(() => { rm(NO_LEGACY); });
