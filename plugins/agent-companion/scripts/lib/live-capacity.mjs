// Live capacity (resource queue leg 4a): what a held lease really costs, from measured tree usage.
// Pure helpers plus the small sidecar / history files; the ledger (ci-budget.mjs) calls these.
//   lease-<id>.use   {v, at, n, win[], cpu, ramMb, ramPeakMb}  written by the wrapper's tree timer
//   usage.jsonl      one row per finished, measured lease (key, cpuP90, ramMaxMb, n, durMs, ...)
//   lease-<id>.prog  progress of the tree (cpu, io, spawn, output): the stuck-holder detector (section "progress")

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
  rampDownPerS: 1 / 25, // the held charge falls at most this many units per second (1 unit per 25 s tick), so a quiet phase cannot free the box for a burst
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
      win: Array.isArray(u.win) ? u.win.map(num) : [], hold: u.hold == null ? null : num(u.hold),
    };
  } catch { return null; }
}

export function removeUse(dir, id) { try { unlinkSync(useFile(dir, id)); } catch { /* gone */ } }

/**
 * The lease's measure as the ledger reads it: {warm, fresh, charge|null, cpu, ramMb, n, ageMs}.
 * charge = clamp(ceil(max of the last winN samples and the ramped hold), max(floor, expCpu), declared) once warm and fresh;
 * else null (declared stays). The hold (use.hold, written by the tracker) falls at most rampDownPerS units per second from
 * the declared size, so the charge does not drop to the floor during one quiet phase. A job with a history never charges
 * below its own expected cpu (expCpu, its history cpuP90).
 */
export function measureOf(use, declared, now, cfg = LIVE_DEFAULTS, expCpu = null) {
  if (!use) return null;
  const ageMs = Math.max(0, now - use.at);
  const fresh = ageMs <= cfg.staleMs;
  const warm = use.n >= cfg.warmN;
  let charge = null;
  if (fresh && warm && declared > 0) {
    const peak = Math.max(0, ...use.win.slice(-cfg.winN), Number.isFinite(use.hold) ? use.hold : 0, Number.isFinite(expCpu) ? expCpu : 0);
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
  let hold = null; let holdAt = 0; // ramped peak: rises at once, falls rampDownPerS per second
  const win = []; const cpus = [];
  return {
    get n() { return n; },
    /** Feed one snapshot (`declared` = the lease's size, where the hold starts). Returns the .use record to write, or null (no cpu data: nothing to record). */
    add(tree, table, now, declared = null) {
      const s = sampleUse(prev, tree, table, now);
      if (!s) return null;
      prev = s;
      ramPeak = Math.max(ramPeak, s.ramMb);
      if (s.cores !== null) {
        n += 1; win.push(s.cores); cpus.push(s.cores);
        if (win.length > cfg.winN) win.shift();
        if (hold === null) { hold = Number.isFinite(declared) && declared > 0 ? declared : s.cores; holdAt = now; }
        hold = Math.max(s.cores, Math.max(...win), hold - Math.max(0, now - holdAt) / 1000 * cfg.rampDownPerS);
        if (Number.isFinite(declared) && declared > 0) hold = Math.min(hold, declared); // a burst past the declared size does not lengthen the ramp
        holdAt = now;
        if (cpus.length > 2000) cpus.shift();
      }
      if (n === 0) return null; // still the baseline reading
      last = { v: 1, at: now, n, win: win.map((x) => Math.round(x * 100) / 100), cpu: Math.round(win[win.length - 1] * 100) / 100, hold: Math.round((hold ?? 0) * 100) / 100, ramMb: Math.round(s.ramMb), ramPeakMb: Math.round(ramPeak) };
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

// ---------------------------------------------------------------- progress (stuck-holder detector, leg 4b)
//
// The wrapper spawns the child with inherited stdio, so it cannot see output bytes. Progress is therefore read from
// the tree: cpu time (cpuMs), I/O transfer counters (ioBytes: Win32_Process Read+Write+Other, /proc/<pid>/io on
// Linux), a pid appearing or disappearing, and (for a future piped path) noteOutput(bytes). A lease is STUCK only
// when none of these moved for the rule's quiet window AND it is past its expected hold; tree cpu alone never
// counts (a verdict needs the io counters or output bytes as a second witness). Written to lease-<id>.prog.
//   lease-<id>.prog  {v, at, n, lastAt, sig:{cpu,io,spawn,out}, cpuMs, ioBytes, outBytes}  (sig = last time each moved)

export const PROG_DEFAULTS = Object.freeze({
  cpuMinFrac: 0.005, // tree cpu delta that counts as progress: 0.5% of one core over the interval
  ioMinBytes: 1024, // tree I/O transfer delta that counts as progress
  staleMs: 150_000, // a progress record older than this is not trusted (the wrapper stopped ticking)
  quietMs: 15 * 60_000, // default quiet window (rule "stuck": quietMs)
  defaultHoldMs: 30 * 60_000, // default expected hold when the lease has no limit (rule "stuck": defaultHoldMs)
});

export const progFile = (dir, id) => join(dir, `lease-${id}.prog`);

export function writeProg(dir, id, rec) {
  try {
    const file = progFile(dir, id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function readProg(dir, id) {
  try {
    const p = JSON.parse(readFileSync(progFile(dir, id), 'utf8'));
    if (!p || p.v !== 1 || !Number.isFinite(Number(p.at))) return null;
    const sig = p.sig && typeof p.sig === 'object' ? p.sig : {};
    return {
      at: num(p.at), n: Math.max(0, Math.trunc(num(p.n))), lastAt: num(p.lastAt),
      sig: { cpu: num(sig.cpu), io: num(sig.io), spawn: num(sig.spawn), out: num(sig.out) },
      cpuMs: p.cpuMs == null ? null : num(p.cpuMs), ioBytes: p.ioBytes == null ? null : num(p.ioBytes), outBytes: num(p.outBytes),
    };
  } catch { return null; }
}

export function removeProg(dir, id) { try { unlinkSync(progFile(dir, id)); } catch { /* gone */ } }

/** Cumulative I/O bytes of one pid on Linux (rchar + wchar of /proc/<pid>/io), or null. Seam: read(path) -> text. */
export function procIo(pid, { platform = process.platform, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (platform !== 'linux') return null;
  try {
    const t = read(`/proc/${pid}/io`);
    const r = /^rchar:\s*(\d+)/m.exec(t); const w = /^wchar:\s*(\d+)/m.exec(t);
    return r || w ? num(r?.[1]) + num(w?.[1]) : null;
  } catch { return null; }
}

// The process snapshot is taken by a child of the wrapper (a PowerShell or ps), which is in the table that tick and
// gone the next: it must not read as a pid appearing and disappearing.
const isSnapshotProbe = (r) => /Get-CimInstance Win32_Process/i.test(String(r.cmd ?? '')) || /^ps\s+-A\s+-o\s/.test(String(r.cmd ?? ''));

/**
 * One progress reading of the lease's tree (the wrapper itself is not in `tree.procs`). Returns null when the table
 * carries neither cpu time nor io counters; else {at, pids[], cpuMap, ioMap, cpuDelta, ioDelta, cpu, io, spawn, haveCpu, haveIo}.
 * The first reading has no baseline (no deltas, all flags false). ioOf(pid) is the fallback io reader (Linux /proc).
 */
export function sampleProgress(prev, tree, table, now, { ioOf = null, cfg = PROG_DEFAULTS } = {}) {
  if (!tree || !Array.isArray(table)) return null;
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const pids = []; const cpuMap = {}; const ioMap = {};
  for (const p of tree.procs ?? []) {
    const r = byPid.get(p.pid);
    if (!r || (r.creationTime != null && p.creationTime != null && r.creationTime !== p.creationTime)) continue;
    if (isSnapshotProbe(r)) continue;
    pids.push(p.pid);
    if (Number.isFinite(r.cpuMs)) cpuMap[p.pid] = r.cpuMs;
    let io = Number.isFinite(r.ioBytes) ? r.ioBytes : null;
    if (io === null && ioOf) { try { io = ioOf(p.pid); } catch { io = null; } }
    if (Number.isFinite(io)) ioMap[p.pid] = io;
  }
  const haveCpu = table.some((r) => Number.isFinite(r.cpuMs));
  // io counters of THIS tree's live pids, not of the whole table: an elevated or protected child has none, and that is not "io never moves".
  const haveIo = Object.keys(ioMap).length > 0;
  if (!haveCpu && !haveIo) return null;
  const s = { at: now, pids, cpuMap, ioMap, cpuDelta: 0, ioDelta: 0, cpu: false, io: false, spawn: false, haveCpu, haveIo };
  if (prev && now - prev.at >= 1000) {
    const before = new Set(prev.pids);
    s.spawn = pids.some((p) => !before.has(p)) || prev.pids.some((p) => !pids.includes(p));
    for (const [pid, ms] of Object.entries(cpuMap)) {
      const b = prev.cpuMap[pid];
      if (b !== undefined) s.cpuDelta += Math.max(0, ms - b);
      else if ((byPid.get(Number(pid))?.creationTime ?? 0) >= prev.at - 1000) s.cpuDelta += ms;
    }
    for (const [pid, v] of Object.entries(ioMap)) {
      const b = prev.ioMap[pid];
      if (b !== undefined) s.ioDelta += Math.max(0, v - b);
      else if ((byPid.get(Number(pid))?.creationTime ?? 0) >= prev.at - 1000) s.ioDelta += v;
    }
    s.cpu = s.cpuDelta / (now - prev.at) >= cfg.cpuMinFrac;
    s.io = s.ioDelta >= cfg.ioMinBytes;
  }
  return s;
}

/** Accumulates one lease's progress; add() returns the .prog record to write (or null: no signal available). */
export function makeProgressTracker(cfg = PROG_DEFAULTS, { ioOf = null } = {}) {
  let prev = null; let n = 0; let lastAt = 0; let outBytes = 0;
  const sig = { cpu: 0, io: 0, spawn: 0, out: 0 };
  let cpuMs = null; let ioBytes = null;
  return {
    get n() { return n; },
    /** The wrapper saw `bytes` of the child's output (unused by the inherited-stdio wrapper; for a piped path). */
    noteOutput(bytes, now = Date.now()) {
      if (!(bytes > 0)) return;
      outBytes += Math.trunc(bytes); sig.out = now; lastAt = Math.max(lastAt, now);
    },
    add(tree, table, now) {
      const s = sampleProgress(prev, tree, table, now, { ioOf, cfg });
      if (!s) return null;
      const first = prev === null;
      prev = s; n += 1;
      if (first) { lastAt = Math.max(lastAt, now); } // the baseline reading counts as progress: the clock starts here
      if (s.cpu) sig.cpu = now;
      if (s.io) sig.io = now;
      if (s.spawn) sig.spawn = now;
      if (s.cpu || s.io || s.spawn) lastAt = Math.max(lastAt, now);
      cpuMs = s.haveCpu ? Object.values(s.cpuMap).reduce((a, b) => a + b, 0) : null;
      ioBytes = s.haveIo ? Object.values(s.ioMap).reduce((a, b) => a + b, 0) : null;
      return { v: 1, at: now, n, lastAt, sig: { ...sig }, cpuMs, ioBytes, outBytes };
    },
  };
}

/**
 * The stuck verdict for one lease. `prog` is readProg(), `act` the idle-probe sidecar ({sampledAt, activeAt}) or null,
 * `maxHoldMs` the lease's expected hold (limitsFor) or null, `rule` the "stuck" rule ({quietMs, defaultHoldMs}).
 * Returns null when there is no fresh progress record with two readings; else
 * {stuck, quietMs, quietLimitMs, heldMs, expectedHoldMs, signals[], by}. `by` names the signal that moved last.
 * Stuck needs quiet >= quietLimit AND held > expected hold AND a second witness besides tree cpu (io counters or output).
 */
export function stuckOf({ prog, act = null, startedAt = 0, maxHoldMs = null, rule = null, now, cfg = PROG_DEFAULTS }) {
  if (!prog || prog.n < 2 || now - prog.at > cfg.staleMs) return null;
  const quietLimitMs = Number.isFinite(rule?.quietMs) && rule.quietMs > 0 ? rule.quietMs : cfg.quietMs;
  const expectedHoldMs = maxHoldMs > 0 ? maxHoldMs : (Number.isFinite(rule?.defaultHoldMs) && rule.defaultHoldMs > 0 ? rule.defaultHoldMs : cfg.defaultHoldMs);
  const probeAt = act && now - num(act.sampledAt) <= cfg.staleMs ? num(act.activeAt) : 0;
  const times = { ...prog.sig, probe: probeAt };
  let by = ''; let last = Math.max(prog.lastAt, num(startedAt));
  for (const [k, v] of Object.entries(times)) if (v > 0 && v >= last) { last = v; by = k; }
  const quietMs = Math.max(0, now - last);
  const heldMs = Math.max(0, now - (num(startedAt) || now));
  const signals = [...(prog.cpuMs !== null ? ['cpu'] : []), ...(prog.ioBytes !== null ? ['io'] : []), 'spawn', ...(prog.outBytes > 0 ? ['output'] : []), ...(act ? ['probe'] : [])];
  const witness = prog.ioBytes !== null || prog.outBytes > 0;
  return { stuck: witness && quietMs >= quietLimitMs && heldMs > expectedHoldMs, quietMs, quietLimitMs, heldMs, expectedHoldMs, signals, by };
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
