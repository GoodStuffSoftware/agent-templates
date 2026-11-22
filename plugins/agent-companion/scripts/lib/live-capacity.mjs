// Live capacity (resource queue leg 4a): what a held lease really costs, from measured tree usage.
// Pure helpers plus the small sidecar / history files; the ledger (ci-budget.mjs) calls these.
//   lease-<id>.use   {v, at, n, win[], cpu, ramMb, ramPeakMb}  written by the wrapper's tree timer
//   usage.jsonl      one row per finished, measured lease (key, cpuP90, ramMaxMb, n, durMs, ...)

import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendRotatingJsonl } from './resource-rules.mjs';

export const LIVE_DEFAULTS = Object.freeze({
  warmN: 3, // valid cpu samples before a lease's charge follows its measure (~80 s of 25 s ticks)
  winN: 4, // the charge is the max over this many latest samples
  staleMs: 150_000, // a measure older than this is not trusted: declared charge again
  floor: 1, // a holder never costs less than this many units
  minRuns: 3, // history rows needed before a job is "known"
  histRuns: 20, // newest rows read per key
  pct: 0.9, // high percentile used over samples and over runs
  warmingMs: 150_000, // how long a young lease counts as "still ramping" (its load is not in the busy sample yet)
});

export const usageFile = (dir) => join(dir, 'usage.jsonl');
export const useFile = (dir, id) => join(dir, `lease-${id}.use`);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** `live_capacity` option text -> boolean. Only an explicit off/false/0/no turns it off. */
export function normalizeLive(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return !(s === 'off' || s === 'false' || s === '0' || s === 'no');
}

/** Nearest-rank percentile of a list of numbers (0 for an empty list). */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

/** Usage key of a job: class | repo | label (digits and long hex folded, 100 chars). Second key: class | repo. */
export function usageKeys(cls, repo, label) {
  const fold = (s) => String(s ?? '').toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100);
  const c = String(cls ?? '');
  const r = String(repo ?? '').toLowerCase();
  const exact = `${c}|${r}|${fold(label)}`;
  return { exact, coarse: c ? `${c}|${r}` : '' };
}

// ---------------------------------------------------------------- the .use sidecar

export function writeUse(dir, id, rec) {
  try {
    const file = useFile(dir, id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function readUse(dir, id) {
  try {
    const u = JSON.parse(readFileSync(useFile(dir, id), 'utf8'));
    if (!u || u.v !== 1 || !Number.isFinite(Number(u.at))) return null;
    return {
      at: num(u.at), n: Math.max(0, Math.trunc(num(u.n))), cpu: num(u.cpu), ramMb: num(u.ramMb), ramPeakMb: num(u.ramPeakMb),
      win: Array.isArray(u.win) ? u.win.map(num) : [],
    };
  } catch { return null; }
}

export function removeUse(dir, id) { try { unlinkSync(useFile(dir, id)); } catch { /* gone */ } }

/**
 * The lease's measure as the ledger reads it: {warm, fresh, charge|null, cpu, ramMb, n, ageMs}.
 * charge = clamp(ceil(max of the last winN samples), floor, declared) once warm and fresh; else null (declared stays).
 */
export function measureOf(use, declared, now, cfg = LIVE_DEFAULTS) {
  if (!use) return null;
  const ageMs = Math.max(0, now - use.at);
  const fresh = ageMs <= cfg.staleMs;
  const warm = use.n >= cfg.warmN;
  let charge = null;
  if (fresh && warm && declared > 0) {
    const peak = Math.max(0, ...use.win.slice(-cfg.winN), 0);
    charge = Math.min(declared, Math.max(Math.min(cfg.floor, declared), Math.ceil(peak - 1e-9)));
  }
  return { warm, fresh, charge, cpu: use.cpu, ramMb: use.ramMb, n: use.n, ageMs };
}

// ---------------------------------------------------------------- tree sampling

/**
 * One reading of the lease's tree from a process-table snapshot (`table` rows {pid, creationTime, memMb, cpuMs})
 * and the recorded tree ({procs:[{pid, creationTime}]}). `prev` is the last reading of this lease or null.
 * Returns null when the table carries no cpu time at all; else {at, cpuMap, ramMb, cores}. `cores` is null on the
 * first reading (no baseline). A pid with no earlier reading counts its whole cpu time only when it started after
 * the previous reading (so its work is all inside the interval); an old pid with no baseline counts 0.
 */
export function sampleUse(prev, tree, table, now) {
  if (!tree || !Array.isArray(table) || !table.some((r) => Number.isFinite(r.cpuMs))) return null;
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const cpuMap = {}; let ramMb = 0;
  for (const p of tree.procs ?? []) {
    const r = byPid.get(p.pid);
    if (!r || (r.creationTime != null && p.creationTime != null && r.creationTime !== p.creationTime)) continue;
    ramMb += num(r.memMb);
    if (Number.isFinite(r.cpuMs)) cpuMap[p.pid] = r.cpuMs;
  }
  let cores = null;
  if (prev && now - prev.at >= 2000) {
    let used = 0;
    for (const [pid, ms] of Object.entries(cpuMap)) {
      const before = prev.cpuMap[pid];
      if (before !== undefined) used += Math.max(0, ms - before);
      else {
        const born = byPid.get(Number(pid))?.creationTime;
        if (born != null && born >= prev.at - 1000) used += ms;
      }
    }
    cores = used / (now - prev.at);
  }
  return { at: now, cpuMap, ramMb, cores };
}

/** Accumulates one lease's readings; `use()` is the sidecar record, `row()` the history row. */
export function makeUseTracker(cfg = LIVE_DEFAULTS) {
  let prev = null; let n = 0; let ramPeak = 0; let last = null;
  const win = []; const cpus = [];
  return {
    get n() { return n; },
    /** Feed one snapshot. Returns the .use record to write, or null (no cpu data: nothing to record). */
    add(tree, table, now) {
      const s = sampleUse(prev, tree, table, now);
      if (!s) return null;
      prev = s;
      ramPeak = Math.max(ramPeak, s.ramMb);
      if (s.cores !== null) {
        n += 1; win.push(s.cores); cpus.push(s.cores);
        if (win.length > cfg.winN) win.shift();
        if (cpus.length > 2000) cpus.shift();
      }
      if (n === 0) return null; // still the baseline reading
      last = { v: 1, at: now, n, win: win.map((x) => Math.round(x * 100) / 100), cpu: Math.round(win[win.length - 1] * 100) / 100, ramMb: Math.round(s.ramMb), ramPeakMb: Math.round(ramPeak) };
      return last;
    },
    /** History row of this run, or null when it was too short to trust. */
    row(meta, now) {
      if (n < cfg.warmN) return null;
      return {
        ts: now, ...meta, cpuP90: Math.round(percentile(cpus, cfg.pct) * 100) / 100, cpuMax: Math.round(Math.max(...cpus) * 100) / 100,
        ramMaxMb: Math.round(ramPeak), n,
      };
    },
  };
}

// ---------------------------------------------------------------- history

export function appendUsage(dir, row) { appendRotatingJsonl(usageFile(dir), row); }

const cache = new Map(); // file -> {sig, rows}
function readRows(dir) {
  const rows = [];
  for (const f of [`${usageFile(dir)}.1`, usageFile(dir)]) {
    let sig = '';
    try { const st = statSync(f); sig = `${st.size}:${st.mtimeMs}`; } catch { continue; }
    let hit = cache.get(f);
    if (!hit || hit.sig !== sig) {
      const parsed = [];
      try {
        for (const l of readFileSync(f, 'utf8').split('\n')) {
          if (!l) continue;
          try { const r = JSON.parse(l); if (r && typeof r.key === 'string') parsed.push(r); } catch { /* torn line */ }
        }
      } catch { /* unreadable */ }
      hit = { sig, rows: parsed };
      cache.set(f, hit);
    }
    rows.push(...hit.rows);
  }
  return rows;
}

/**
 * Expected usage of a job from its history: {cpu, ramMb, runs, basis} or null (unknown: declared stays).
 * The exact key first; else the class key; each needs minRuns rows, the newest histRuns are used.
 * cpu / ramMb = the pct percentile over runs of the runs' own cpuP90 / peak RAM.
 */
export function expectedFor(dir, keys, cfg = LIVE_DEFAULTS) {
  const rows = readRows(dir);
  for (const [basis, k] of [['exact', keys.exact], ['class', keys.coarse]]) {
    if (!k) continue;
    const mine = rows.filter((r) => (basis === 'exact' ? r.key : r.key2) === k).slice(-cfg.histRuns);
    if (mine.length >= cfg.minRuns) {
      return { cpu: percentile(mine.map((r) => num(r.cpuP90)), cfg.pct), ramMb: percentile(mine.map((r) => num(r.ramMaxMb)), cfg.pct), runs: mine.length, basis };
    }
  }
  return null;
}

/** Charge a request would take on the box: expected cpu rounded up, within [floor, declared]; declared when unknown. */
export function effectiveBox(declared, expCpu, cfg = LIVE_DEFAULTS) {
  if (!(declared > 0) || !(expCpu >= 0) || expCpu === undefined || expCpu === null) return declared;
  return Math.min(declared, Math.max(Math.min(cfg.floor, declared), Math.ceil(expCpu - 1e-9)));
}
