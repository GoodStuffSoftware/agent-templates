// scripts/ci-budget.mjs headroom for hooks: the below-normal priority call, the
// reserve of idle cores, and the re-sample that slows admission on a loaded
// machine. Fake work only: every ledger is a fresh temp dir, the clock and the
// cpu sampler are injected, and nothing here loads the cpu.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, constants as osConstants } from 'node:os';
import { join } from 'node:path';
import {
  acquire, status, formatStatus, resolveBudgetConfig, defaultReserve, overloadThreshold, lowerOwnPriority,
} from '../../plugins/agent-companion/scripts/ci-budget.mjs';

const NO_LEGACY = mkdtempSync(join(tmpdir(), 'ci-budget-headroom-legacy-'));
const T0 = Date.now();
const BELOW = osConstants.priority.PRIORITY_BELOW_NORMAL;

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-budget-headroom-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A 32-core machine with 4 cores reserved: loaded when more than 28 cores are busy.
function world(dir, over = {}) {
  const w = { t: T0, busy: 0, samples: 0, lines: [] };
  w.opts = {
    dir, env: { CI_LOCAL_LOCK_DIR: NO_LEGACY }, legacyDir: NO_LEGACY, cores: 32, reserve: 4, loadPct: 100,
    budget: 64, heavyCost: 3, heavyMax: 2, express: 2, maxFull: Infinity, pollMs: 1500, announceMs: 60_000, staleMs: 86_400_000,
    heartbeat: 'off', registerExit: false, worktree: 'wt-headroom',
    now: () => w.t, sleep: (ms) => { w.t += ms; },
    sampler: () => { w.samples += 1; return w.busy; },
    log: (l) => w.lines.push(l),
    ...over,
  };
  w.acquire = (extra = {}) => acquire({ ...w.opts, ...extra });
  w.status = (extra = {}) => status({ ...w.opts, ...extra });
  return w;
}

// ---------------------------------------------------------------- priority

test('lowerOwnPriority: sets the calling process to PRIORITY_BELOW_NORMAL', () => {
  const calls = [];
  const os = {
    constants: osConstants,
    getPriority: (pid) => { calls.push(['get', pid]); return 0; },
    setPriority: (pid, p) => { calls.push(['set', pid, p]); },
  };
  assert.equal(lowerOwnPriority(os), 'lowered');
  assert.deepEqual(calls, [['get', 0], ['set', 0, BELOW]], 'pid 0 is this process');
});

test('lowerOwnPriority: never raises a process that is already nicer', () => {
  const calls = [];
  const os = {
    constants: osConstants,
    getPriority: () => BELOW + 9,
    setPriority: (...a) => { calls.push(a); },
  };
  assert.equal(lowerOwnPriority(os), 'kept');
  assert.deepEqual(calls, []);
});

test('lowerOwnPriority: a throwing call is swallowed and nothing is logged', () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a); console.error = (...a) => logged.push(a); console.warn = (...a) => logged.push(a);
  try {
    const denied = { constants: osConstants, getPriority: () => 0, setPriority: () => { throw new Error('EACCES'); } };
    assert.equal(lowerOwnPriority(denied), 'failed');
    const broken = { constants: osConstants, getPriority: () => { throw new Error('boom'); }, setPriority: () => {} };
    assert.equal(lowerOwnPriority(broken), 'failed');
    assert.equal(lowerOwnPriority({ constants: {} }), 'failed', 'a platform without the constant');
  } finally { Object.assign(console, orig); }
  assert.deepEqual(logged, []);
});

// ---------------------------------------------------------------- config

test('config: the reserve defaults to an eighth of the cores (at least 1), and the knobs parse', () => {
  assert.equal(defaultReserve(32), 4);
  assert.equal(defaultReserve(16), 2);
  assert.equal(defaultReserve(4), 1);
  assert.equal(defaultReserve(2), 1);
  const d = resolveBudgetConfig({}, { cores: 32 });
  assert.deepEqual([d.reserve, d.loadPct, d.sliceFactor], [4, 90, 6]);
  const c = resolveBudgetConfig({ CI_LOCAL_RESERVE: '6', CI_LOCAL_LOAD_PCT: '75', CI_LOCAL_SLICE: '0' }, { cores: 32 });
  assert.deepEqual([c.reserve, c.loadPct, c.sliceFactor], [6, 75, 0]);
  assert.equal(resolveBudgetConfig({ CI_LOCAL_RESERVE: '0' }, { cores: 32 }).reserve, 0, '0 is allowed: no reserve');
  assert.equal(resolveBudgetConfig({ CI_LOCAL_LOAD_PCT: '250' }, { cores: 32 }).loadPct, 100, 'clamped to 100');
  assert.equal(resolveBudgetConfig({ CI_LOCAL_RESERVE: '99' }, { cores: 8 }).reserve, 7, 'at least one core stays usable');
  const bad = resolveBudgetConfig({ CI_LOCAL_RESERVE: 'lots', CI_LOCAL_LOAD_PCT: '0', CI_LOCAL_SLICE: '-2' }, { cores: 32 });
  assert.deepEqual([bad.reserve, bad.loadPct, bad.sliceFactor], [4, 90, 6]);
  assert.equal(bad.warnings.length, 3);
});

test('overloadThreshold: the tighter of "fewer than reserve cores idle" and "over loadPct percent busy"', () => {
  assert.equal(overloadThreshold({ cores: 32, reserve: 4, loadPct: 100 }), 28);
  assert.equal(overloadThreshold({ cores: 32, reserve: 4, loadPct: 90 }), 28);
  assert.equal(overloadThreshold({ cores: 32, reserve: 0, loadPct: 50 }), 16);
  assert.equal(overloadThreshold({ cores: 4, reserve: 1, loadPct: 90 }), 3);
  assert.equal(overloadThreshold({ cores: 32, reserve: 0, loadPct: 100 }), 32, 'a fully busy box is never "over": the guard is off');
});

// ---------------------------------------------------------------- admission

test('a full run is admitted with one worker when fewer than `reserve` cores are idle', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir);
    w.busy = 27; // 5 idle: not loaded
    let l = w.acquire({ desired: 8 });
    assert.equal(l.units, 8);
    l.release();
    w.busy = 28; // exactly the reserve idle: still fine
    l = w.acquire({ desired: 8 });
    assert.equal(l.units, 8, 'exactly the reserve idle is not loaded');
    l.release();
    w.busy = 29; // 3 idle, under the reserve of 4
    l = w.acquire({ desired: 8 });
    assert.equal(l.units, 1);
    assert.match(w.lines.join('\n'), /starting with 1 of 8 workers \(machine loaded\)/);
    l.release();
  } finally { cleanup(); }
});

test('the load percent trips the guard too, with no reserve', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir, { reserve: 0, loadPct: 50 }); // over 16 busy cores
    w.busy = 16;
    let l = w.acquire({ desired: 6 });
    assert.equal(l.units, 6);
    l.release();
    w.busy = 17;
    l = w.acquire({ desired: 6 });
    assert.equal(l.units, 1);
    l.release();
  } finally { cleanup(); }
});

test('a loaded machine never starves a run: it always gets its one worker', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir, { budget: 4 });
    w.busy = 32;
    const l = w.acquire({ desired: 4 });
    assert.equal(l.units, 1);
    assert.equal(l.released, false);
    l.release();
  } finally { cleanup(); }
});

test('a targeted (express) run is not slowed: it is one worker already', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir);
    w.busy = 31;
    const l = w.acquire({ kind: 'targeted' });
    assert.equal(l.units, 1);
    assert.equal(l.waitedMs, 0);
    l.release();
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- re-sample while a lease is held

test('resize with resample: a lease at full size is cut to one worker when the machine gets loaded, and regrows when it eases', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir);
    const l = w.acquire({ desired: 6 });
    assert.equal(l.units, 6);
    const before = w.samples;
    w.busy = 30; // outside load rose while the lease was held
    assert.deepEqual(l.resize({ units: 6, heavy: 0 }), { units: 6, heavy: 0 }, 'no resample requested: not looked at');
    assert.equal(w.samples, before, 'a resize that grows nothing does not sample');
    assert.deepEqual(l.resize({ units: 6, heavy: 0 }, { resample: true }), { units: 1, heavy: 0 });
    assert.equal(w.samples, before + 1);
    assert.equal(w.status({ sample: false }).leases[0].units, 1, 'the ledger shows the cut');
    assert.match(w.lines.join('\n'), /the machine is loaded \(30\.0 of 32 cores busy, over 28\.0; 4 kept idle/);
    w.busy = 3;
    assert.deepEqual(l.resize({ units: 6, heavy: 0 }, { resample: true }), { units: 6, heavy: 0 });
    assert.match(w.lines.join('\n'), /back under the threshold/);
    assert.equal(w.lines.filter((x) => /machine is loaded/.test(x)).length, 1, 'one line per change, not per sample');
    l.release();
  } finally { cleanup(); }
});

test('a grow on a loaded machine admits one worker per lane; the heavy lane gets its one heavy worker', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir);
    const l = w.acquire({ desired: 1 });
    w.busy = 30;
    assert.deepEqual(l.resize({ units: 8, heavy: 0 }), { units: 1, heavy: 0 }, 'wanted 8, loaded: stays at 1');
    const h = l.resize({ units: 0, heavy: 2 }, { wait: true });
    assert.deepEqual(h, { units: 0, heavy: 1 }, 'wanted 2 heavy, loaded: 1 heavy, and the wait ends');
    w.busy = 2;
    assert.deepEqual(l.resize({ units: 0, heavy: 2 }), { units: 0, heavy: 2 }, 'eased: both heavy workers');
    l.release();
  } finally { cleanup(); }
});

test('a sampler that reads NaN is no load signal: the run is admitted as before', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir, { sampler: () => NaN });
    const l = w.acquire({ desired: 5 });
    assert.equal(l.units, 5);
    assert.deepEqual(l.resize({ units: 5, heavy: 0 }, { resample: true }), { units: 5, heavy: 0 });
    l.release();
  } finally { cleanup(); }
});

test('the guard is off with reserve 0 and loadPct 100, so existing budgets behave as before', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir, { reserve: 0, loadPct: 100 });
    w.busy = 32;
    const l = w.acquire({ desired: 8 });
    assert.equal(l.units, 8, 'external load 32 against a budget of 64 leaves 32');
    l.release();
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- status

test('status names the load guard and whether the machine is loaded now', () => {
  const { dir, cleanup } = tmp();
  try {
    const w = world(dir);
    w.busy = 30;
    let st = w.status();
    assert.deepEqual([st.reserve, st.loadPct, st.loadThreshold, st.loaded], [4, 100, 28, true]);
    assert.match(formatStatus(st), /load guard: 4 cores kept idle .*above 28 busy cores \(loaded now/);
    w.busy = 5;
    st = w.status();
    assert.equal(st.loaded, false);
    assert.match(formatStatus(st), /\(not loaded now\)/);
    assert.equal(w.status({ sample: false }).loaded, null);
  } finally { cleanup(); }
});
