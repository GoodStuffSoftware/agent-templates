// The reaper: kills the processes a finished (or dead) queue lease left behind, and nothing else.
// Spec: docs/resource-queue.md "Reaping a lease's children". Pure selection plus injected seams
// ({table, kill}); the real adapters (processSnapshot, realKill) are the only code that spawns, always
// with windowsHide: true. This code kills processes on the operator's machine, so every rule below is a
// refusal first:
//
//  - A process is a target only if it was RECORDED in the lease's tree (pid + creation time), or is found
//    live under a matched recorded process (or the matched recorded root) at reap time. The pid AND the
//    creation time must match the record (pid reuse is real); a missing creation time on either side
//    means "cannot verify", so the process is spared.
//  - Never killed, even when recorded or a descendant: this process and its ancestors, any claude /
//    claude.exe, StreamDeck.exe and anything under \Elgato\StreamDeck\, anything matching reap_never,
//    and anything running under one of those (between the target and the tree root).
//  - Explicit vetted pids, children before parents. No `taskkill /T` on a tree.
//  - A process in no recorded tree is never a target.

import {
  readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendRotatingJsonl } from './resource-rules.mjs';

export const REAP_POLICIES = ['off', 'dry-run', 'on'];
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 3600_000;
export const reapsFile = (dir) => join(dir, 'reaps.jsonl');
export const treeFile = (dir, id) => join(dir, `lease-${id}.tree`);

/** reap_policy: unset or empty -> 'on' (the default); a value we do not know -> 'dry-run' (the safe direction). */
export function normalizePolicy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'on';
  return REAP_POLICIES.includes(s) ? s : 'dry-run';
}

/**
 * reap_never: a comma-separated string (or an array) of patterns. `/regex/flags` is a regular expression;
 * anything else is a plain case-insensitive substring. Matched against a process's name, exe path and
 * command line. Returns [{src, test(row)}].
 */
export function parseNever(spec) {
  const parts = Array.isArray(spec) ? spec : String(spec ?? '').split(',');
  const out = [];
  for (const raw of parts) {
    const src = String(raw).trim();
    if (!src) continue;
    let re = null;
    const m = /^\/(.+)\/([a-z]*)$/.exec(src);
    if (m) { try { re = new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`); } catch { re = null; } }
    const low = src.toLowerCase();
    out.push({
      src,
      test: (row) => [row.name, row.exe, row.cmd].some((f) => {
        if (!f) return false;
        return re ? re.test(String(f)) : String(f).toLowerCase().includes(low);
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- pure selection

const baseOf = (p) => basename(String(p ?? '').replace(/\\/g, '/'));
const slashless = (s) => String(s ?? '').replace(/\//g, '\\').toLowerCase();

const isClaude = (r) => /^claude/i.test(String(r.name ?? '')) || /^claude/i.test(baseOf(r.exe))
  || /@anthropic-ai[\\/]+claude-code/i.test(String(r.cmd ?? ''));
const isStreamDeck = (r) => /^streamdeck/i.test(String(r.name ?? '')) || /^streamdeck/i.test(baseOf(r.exe))
  || slashless(r.exe).includes('\\elgato\\streamdeck\\') || slashless(r.cmd).includes('\\elgato\\streamdeck\\');

/** Why a process is never killed (not counting the ancestry rule), or null. */
export function protectedReason(row, never = []) {
  if (!row) return 'unknown';
  if (!Number.isInteger(row.pid) || row.pid <= 4) return 'system';
  if (isClaude(row)) return 'claude';
  if (isStreamDeck(row)) return 'streamdeck';
  const hit = never.find((n) => n.test(row));
  return hit ? `reap_never:${hit.src}` : null;
}

// parent -> child link, guarded against pid reuse: a child cannot have started before its parent.
const linked = (parent, child) => child.ppid === parent.pid && child.pid !== parent.pid
  && !(parent.creationTime != null && child.creationTime != null && child.creationTime < parent.creationTime);

function parentOf(table, byPid, row) {
  const p = byPid.get(row.ppid);
  return p && linked(p, row) ? p : null;
}

/** Pids of `pid` and every live ancestor (guarded chain). */
export function ancestorPids(table, pid) {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const out = new Set([pid]);
  let cur = byPid.get(pid);
  for (let i = 0; cur && i < 128; i += 1) {
    const p = parentOf(table, byPid, cur);
    if (!p || out.has(p.pid)) break;
    out.add(p.pid);
    cur = p;
  }
  return out;
}

/** Record a lease's process tree: the live descendants of `rootPid`, unioned with `prev` procs still alive (same pid + creation time). */
export function recordTree(table, rootPid, { prev = null, now = Date.now(), costMs = null } = {}) {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root || root.creationTime == null) return null;
  const kids = new Map();
  for (const r of table) {
    const p = byPid.get(r.ppid);
    if (p && linked(p, r)) { if (!kids.has(p.pid)) kids.set(p.pid, []); kids.get(p.pid).push(r); }
  }
  const procs = new Map();
  const add = (r) => { if (r.pid !== rootPid && r.creationTime != null) procs.set(r.pid, r); };
  const walk = [root];
  const seen = new Set([rootPid]);
  while (walk.length) {
    const cur = walk.pop();
    for (const k of kids.get(cur.pid) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid); add(k); walk.push(k);
    }
  }
  for (const p of prev?.procs ?? []) { // reparented grandchildren are unreachable by ppid once their parent died
    const live = byPid.get(p.pid);
    if (live && live.creationTime != null && live.creationTime === p.creationTime) add(live);
  }
  return {
    v: 1, root: { pid: rootPid, creationTime: root.creationTime }, at: now, costMs,
    procs: [...procs.values()].map((r) => ({ pid: r.pid, creationTime: r.creationTime, image: r.name, parentPid: r.ppid })),
  };
}

/**
 * Select what to kill. `tree` is a recorded tree ({root, procs}); `table` a fresh snapshot
 * ([{pid, ppid, name, exe, cmd, creationTime, memMb}]). Returns
 * {rootAlive, targets, spared, stale}: targets deepest first, each {pid, creationTime, image, parentPid,
 * memMb, depth, how: 'recorded'|'descendant'}; spared {pid, image, why}; stale {pid, image, why:'gone'|'pid-reused'|'no-creation-time'}.
 */
export function planReap({ table, tree, selfPid = process.pid, never = [] }) {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const matches = (rec) => {
    const r = byPid.get(rec.pid);
    return r && rec.creationTime != null && r.creationTime != null && r.creationTime === rec.creationTime ? r : null;
  };
  const selfChain = ancestorPids(table, selfPid);
  // A spared process (ours, claude, Stream Deck, reap_never) is never an anchor either: its descendants are not
  // ours to find. The recorded root is the one exception to the self-chain rule (the wrapper is usually "self").
  const expandable = (r, isRoot = false) => (isRoot || !selfChain.has(r.pid)) && !protectedReason(r, never);
  const stale = [];
  const anchors = [];
  const cand = new Map(); // pid -> {row, how}
  const rootRow = tree.root ? matches(tree.root) : null;
  if (rootRow && expandable(rootRow, true)) anchors.push(rootRow);
  for (const rec of tree.procs ?? []) {
    const r = matches(rec);
    if (r) { if (expandable(r)) anchors.push(r); cand.set(r.pid, { row: r, how: 'recorded' }); continue; }
    const other = byPid.get(rec.pid);
    stale.push({
      pid: rec.pid, image: rec.image ?? '',
      why: rec.creationTime == null || (other && other.creationTime == null) ? 'no-creation-time' : (other ? 'pid-reused' : 'gone'),
    });
  }
  const kids = new Map();
  for (const r of table) {
    const p = byPid.get(r.ppid);
    if (p && linked(p, r)) { if (!kids.has(p.pid)) kids.set(p.pid, []); kids.get(p.pid).push(r); }
  }
  const stack = [...anchors];
  const seenAnchor = new Set(anchors.map((a) => a.pid));
  while (stack.length) {
    const cur = stack.pop();
    for (const k of kids.get(cur.pid) ?? []) {
      if (k.creationTime == null) continue; // cannot be verified later: leave it
      if (!cand.has(k.pid)) cand.set(k.pid, { row: k, how: 'descendant' });
      if (!seenAnchor.has(k.pid) && expandable(k)) { seenAnchor.add(k.pid); stack.push(k); }
    }
  }
  const rootPid = tree.root?.pid;
  const depthOf = (row) => {
    let d = 0; let cur = row;
    for (; d < 128; d += 1) { const p = parentOf(table, byPid, cur); if (!p) break; cur = p; }
    return d;
  };
  const targets = [];
  const spared = [];
  for (const { row, how } of cand.values()) {
    let why = null;
    if (selfChain.has(row.pid)) why = 'self-or-ancestor';
    else if (row.pid === rootPid) why = 'tree-root';
    else why = protectedReason(row, never);
    if (!why) { // running under a protected process, between the target and the tree root
      let cur = row;
      for (let i = 0; i < 128; i += 1) {
        const p = parentOf(table, byPid, cur);
        if (!p || p.pid === rootPid) break;
        const pr = protectedReason(p, never);
        if (pr) { why = `under:${pr}`; break; }
        cur = p;
      }
    }
    if (why) { spared.push({ pid: row.pid, image: row.name, why }); continue; }
    targets.push({
      pid: row.pid, creationTime: row.creationTime, image: row.name, parentPid: row.ppid,
      memMb: row.memMb ?? null, depth: depthOf(row), how,
    });
  }
  targets.sort((a, b) => b.depth - a.depth || a.pid - b.pid);
  return { rootAlive: Boolean(rootRow), targets, spared, stale };
}

// ---------------------------------------------------------------- execute

/**
 * Plan and (policy 'on') kill. Seams: `table` (array, or () => array|null), `kill(target) -> boolean | {ok, gone?, error?}`.
 * policy 'off' does nothing; 'dry-run' returns the same plan and kills nothing. One log row per target when
 * `logDir` is set (mode 'kill' | 'would-kill'; skipped when `quietLog`, e.g. a dry-run already logged for this tree).
 * Returns the result object: {policy, why, lease, ts, tableOk, rootAlive, targets: [{..., ok, gone, error}], spared, stale, done}.
 * `done` = nothing recorded is left alive (every target killed or already gone).
 */
export function reapTree({
  table, tree, selfPid = process.pid, policy = 'on', never = [], kill, why = 'release', lease = null,
  logDir = null, quietLog = false, now = Date.now(),
}) {
  const pol = normalizePolicy(policy);
  const res = { policy: pol, why, lease, ts: now, tableOk: true, rootAlive: false, targets: [], spared: [], stale: [], done: false };
  if (pol === 'off') { res.done = false; return res; }
  const rows = typeof table === 'function' ? table() : table;
  if (!Array.isArray(rows)) { res.tableOk = false; return res; }
  const plan = planReap({ table: rows, tree, selfPid, never });
  res.rootAlive = plan.rootAlive; res.spared = plan.spared; res.stale = plan.stale;
  for (const t of plan.targets) {
    const out = { ...t, ok: null, gone: false, error: null };
    if (pol === 'on') {
      let r;
      try { r = kill(t); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
      if (typeof r === 'boolean') r = { ok: r };
      out.ok = Boolean(r?.ok); out.gone = Boolean(r?.gone); out.error = r?.error ?? null;
    }
    res.targets.push(out);
    if (logDir && !quietLog) {
      appendReap(logDir, {
        ts: now, mode: pol === 'on' ? 'kill' : 'would-kill', why, lease, pid: t.pid, image: t.image,
        creationTime: t.creationTime, parentPid: t.parentPid, memMb: t.memMb, how: t.how, ok: out.ok,
      });
    }
  }
  res.done = pol === 'on' && res.targets.every((t) => t.ok || t.gone);
  return res;
}

/** Append one reaps.jsonl row; rotates at 512 KB exactly like grants.jsonl (shared appendRotatingJsonl). Never throws. */
export function appendReap(dir, rec) { appendRotatingJsonl(reapsFile(dir), rec); }

// ---------------------------------------------------------------- tree files (lease-<id>.tree)

export function writeTree(dir, id, tree) {
  try {
    const file = treeFile(dir, id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tree));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}
export function readTree(dir, id) {
  try { const t = JSON.parse(readFileSync(treeFile(dir, id), 'utf8')); return t && t.v === 1 && t.root ? t : null; } catch { return null; }
}
export function removeTree(dir, id) { try { unlinkSync(treeFile(dir, id)); } catch { /* already gone */ } }
export function listTrees(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^lease-(.+)\.tree$/.exec(n);
    if (!m) continue;
    const tree = readTree(dir, m[1]);
    let mtime = 0;
    try { mtime = statSync(join(dir, n)).mtimeMs; } catch { /* gone */ }
    out.push({ id: m[1], tree, mtime });
  }
  return out;
}

/**
 * The orphan pass: every recorded tree whose lease file is gone (`leaseExists(id)` false) AND whose root wrapper
 * is not running gets the same selection and kill rules. A tree whose wrapper still runs is not an orphan (a
 * hand-released lease leaves its process untouched). The tree file is deleted when nothing recorded is alive
 * (and after 7 days regardless); in dry-run it is kept and flagged `dryLogged` so the would-kill rows are logged once.
 * Returns [{id, result|null, skipped?}]. One table read: pass `table` (array or function).
 */
export function reapOrphans({
  dir, table, leaseExists, selfPid = process.pid, policy = 'on', never = [], kill, now = Date.now(), why = 'orphan',
}) {
  const pol = normalizePolicy(policy);
  if (pol === 'off') return [];
  const rows = typeof table === 'function' ? table() : table;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const { id, tree, mtime } of listTrees(dir)) {
    if (!tree) { if (now - mtime > ORPHAN_MAX_AGE_MS) removeTree(dir, id); continue; }
    if (leaseExists(id)) continue;
    const old = now - (tree.at ?? mtime) > ORPHAN_MAX_AGE_MS;
    // The wrapper still runs (same pid + creation time): not an orphan. Checked BEFORE any kill.
    const rootLive = rows.find((r) => r.pid === tree.root.pid);
    if (rootLive && tree.root.creationTime != null && rootLive.creationTime === tree.root.creationTime) {
      out.push({ id, result: null, skipped: 'wrapper-running' });
      continue;
    }
    const res = reapTree({
      table: rows, tree, selfPid, policy: pol, never, kill, why, lease: id, logDir: dir, quietLog: pol === 'dry-run' && Boolean(tree.dryLogged), now,
    });
    out.push({ id, result: res });
    if (pol === 'on') {
      if (res.done || old) removeTree(dir, id);
    } else if (!res.targets.length) {
      removeTree(dir, id);
    } else if (!tree.dryLogged) {
      writeTree(dir, id, { ...tree, dryLogged: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------- real adapters (the only code that spawns)

// Windows PowerShell 5.1 ConvertTo-Json writes a DateTime (Win32_Process CreationDate) as "/Date(<epoch ms>)/".
function parseCimDate(s) {
  if (!s) return null;
  const m = /Date\((-?\d+)/.exec(String(s));
  if (m) return Number(m[1]);
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}

/** Windows: the JSON of one Get-CimInstance Win32_Process pass -> table rows. */
export function parseWinJson(text) {
  const arr = [].concat(JSON.parse(text));
  return arr.map((x) => {
    const row = {
      pid: x.p, ppid: x.pp, name: String(x.n ?? ''), exe: x.e ? String(x.e) : '', cmd: String(x.c ?? ''),
      creationTime: parseCimDate(x.s), memMb: x.w == null ? null : Math.round(Number(x.w) / 1048576),
    };
    // k = Kernel+User mode time in 100 ns units -> cpu ms (live capacity measures tree usage from it)
    if (x.k != null && Number.isFinite(Number(x.k))) row.cpuMs = Math.round(Number(x.k) / 10000);
    return row;
  });
}

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** ps cpu time [DD-][HH:]MM:SS(.ss) -> ms, or null. */
export function parsePsTime(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(t));
  if (!m) return null;
  return Math.round(((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000);
}

/**
 * Linux/macOS: `ps -A -o pid=,ppid=,rss=,time=,lstart=,args=` text -> table rows (the time column is optional). lstart is "Sat Nov 21 10:00:00 2026"
 * (fixed field order under LC_ALL=C, whitespace padded; resolution 1 s, local time: only ever compared with itself).
 */
export function parsePsOutput(text) {
  const rows = [];
  for (const l of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d[\d:.-]*)\s+)?[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s*(.*)$/.exec(l);
    if (!m) continue;
    const mon = MON[m[5]];
    if (mon === undefined) continue;
    const cmd = m[11];
    const first = cmd.startsWith('/') ? cmd.split(/\s+/)[0] : '';
    const row = {
      pid: Number(m[1]), ppid: Number(m[2]), name: baseOf(cmd.split(/\s+/)[0]), exe: first, cmd,
      creationTime: new Date(Number(m[10]), mon, Number(m[6]), Number(m[7]), Number(m[8]), Number(m[9])).getTime(),
      memMb: Math.round(Number(m[3]) / 1024),
    };
    const cpuMs = m[4] ? parsePsTime(m[4]) : null;
    if (cpuMs !== null) row.cpuMs = cpuMs;
    rows.push(row);
  }
  return rows;
}

/** One real snapshot of the process table, or null on failure. Hidden window; ~0.4-1 s of cpu on Windows. */
export function processSnapshot({ platform = process.platform, spawn = spawnSync } = {}) {
  try {
    if (platform === 'win32') {
      const ps = '$ErrorActionPreference="Stop";Get-CimInstance Win32_Process | ForEach-Object { '
        + '[pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;n=$_.Name;e=$_.ExecutablePath;c=$_.CommandLine;'
        + 'w=[int64]$_.WorkingSetSize;k=[int64]$_.KernelModeTime+[int64]$_.UserModeTime;s=$_.CreationDate} } | ConvertTo-Json -Compress';
      const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status !== 0 || !r.stdout) return null;
      return parseWinJson(r.stdout);
    }
    const r = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,lstart=,args='], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
    });
    if (r.status !== 0 || !r.stdout) return null;
    return parsePsOutput(r.stdout);
  } catch { return null; }
}

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } }

/**
 * Kill ONE vetted pid (never a tree). Windows: `taskkill /F /PID <pid>` (no /T: the caller kills children first
 * and only vetted pids); exit 128 = no such process (gone). POSIX: SIGTERM, wait, one fresh snapshot, SIGKILL only
 * if the same pid + creation time is still running. Seams: spawn, kill (process.kill), snapshot, sleep.
 */
export function realKill(target, {
  platform = process.platform, spawn = spawnSync, kill = process.kill.bind(process), snapshot = processSnapshot,
  sleep = sleepSync, graceMs = 2000,
} = {}) {
  if (!Number.isInteger(target?.pid) || target.pid <= 4) return { ok: false, error: 'refused pid' };
  if (platform === 'win32') {
    const r = spawn('taskkill', ['/F', '/PID', String(target.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status === 0) return { ok: true };
    if (r.status === 128) return { ok: true, gone: true };
    return { ok: false, error: String(r.stderr || r.stdout || r.error || `exit ${r.status}`).trim().slice(0, 200) };
  }
  try { kill(target.pid, 'SIGTERM'); } catch (e) { return e?.code === 'ESRCH' ? { ok: true, gone: true } : { ok: false, error: String(e?.message ?? e) }; }
  sleep(graceMs);
  const rows = snapshot();
  if (!Array.isArray(rows)) return { ok: true }; // cannot re-verify: do not escalate
  const still = rows.find((r) => r.pid === target.pid && r.creationTime != null && r.creationTime === target.creationTime);
  if (!still) return { ok: true };
  try { kill(target.pid, 'SIGKILL'); return { ok: true, escalated: true }; } catch (e) { return e?.code === 'ESRCH' ? { ok: true } : { ok: false, error: String(e?.message ?? e) }; }
}
