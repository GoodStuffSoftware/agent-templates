// Shared fixture for the resource-queue tests: a fake world with a clock that only
// moves when something waits, an injectable cpu sampler, RAM and liveness, and a
// fresh ledger directory. Not a test file (the suite globs *.test.mjs).

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireResources } from '../scripts/ci-budget.mjs';

export const GB = 1024 * 1024 * 1024;
export const T0 = Date.now();

export const tick = () => new Promise((r) => { setImmediate(r); });
export async function settle(n = 6) { for (let i = 0; i < n; i += 1) await tick(); }

export const baseRules = () => ({
  version: 1,
  ram: { reserveMb: 1000, rampMs: 60_000 },
  resources: {
    box: {},
    'app-e2e': { capacity: 1 },
    pool: { capacity: 2 },
  },
  classes: [],
  rules: [
    { id: 'max-hold', enabled: true, appliesTo: ['run'] },
    { id: 'idle', enabled: true, appliesTo: ['run'], sampleMs: 30_000, minCpuPct: 5 },
  ],
  legacyLocks: [],
  strays: [],
});

/** A fresh world. `w.acq(extra)` is acquireResources with the world's seams. Call w.done() to remove the temp dirs. */
export function makeWorld(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-ledger-'));
  const legacy = mkdtempSync(join(tmpdir(), 'rq-legacy-'));
  const cfg = mkdtempSync(join(tmpdir(), 'rq-cfg-'));
  const w = {
    t: T0, busy: 0, lines: [], dead: new Set(), dir, legacy, cfg, free: 48 * GB, total: 64 * GB, polls: 0,
  };
  w.opts = {
    dir, env: { CI_LOCAL_LOCK_DIR: legacy, CLAUDE_CONFIG_DIR: cfg }, legacyDir: legacy,
    budget: 16, heavyCost: 3, heavyMax: 2, express: 2, pollMs: 1500, announceMs: 60_000, staleMs: 86_400_000,
    heartbeat: 'off', registerExit: false, worktree: 'wt-rq', cores: 64, reserve: 0, loadPct: Infinity,
    now: () => w.t,
    sleep: (ms) => { w.t += ms; },
    delay: async (ms) => { w.polls += 1; w.t += ms; await tick(); },
    isAlive: (pid) => !w.dead.has(pid),
    sampler: () => w.busy,
    freemem: () => w.free,
    totalmem: () => w.total,
    log: (l) => w.lines.push(l),
    maxWaitMs: 1e12,
    rules: baseRules(),
    ...over,
  };
  w.acq = (extra = {}) => acquireResources({ ...w.opts, ...extra });
  w.files = (re) => readdirSync(dir).filter((n) => re.test(n));
  w.leases = () => w.files(/^lease-[0-9a-f]+\.json$/).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
  w.tickets = () => w.files(/^ticket-[0-9a-f]+\.json$/).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
  w.clears = () => {
    const f = join(dir, 'clears.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  w.done = () => { for (const d of [dir, legacy, cfg]) rmSync(d, { recursive: true, force: true }); };
  return w;
}
