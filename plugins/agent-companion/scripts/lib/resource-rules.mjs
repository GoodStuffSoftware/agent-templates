// Rules, RAM sizes, the clear log, the activity probe and the stray scan for the
// machine-wide resource queue. Pure helpers around scripts/ci-budget.mjs (the
// ledger) and scripts/resource-queue.mjs (the CLI). Spec: docs/resource-queue.md.
//
// Nothing here is on the hook path except loadRules() and the pure verdict
// functions (fs reads only). The two functions that spawn a process, sampleTree()
// and scanStrays(), run only inside a wrapper process or a CLI call, always with
// windowsHide: true.

import {
  readFileSync, appendFileSync, statSync, renameSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join, dirname, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BOX = 'box';
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'resource-rules.json');
const CLEARS_MAX_BYTES = 512 * 1024;

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(env.AGENT_COMPANION_HOME_OVERRIDE || homedir(), '.claude');
}

export function userRulesPath(env = process.env) {
  return env.AC_RESOURCE_RULES || join(claudeHome(env), 'agent-companion', 'config', 'resource-rules.json');
}

function readJsonFile(file) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch { return null; }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeInto(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = mergeInto(out[k], v);
    else out[k] = v;
  }
  return out;
}

function mergeById(a = [], b = []) {
  const out = a.map((x) => ({ ...x }));
  for (const x of b) {
    if (!isObj(x) || !x.id) continue;
    const i = out.findIndex((y) => y.id === x.id);
    if (i >= 0) out[i] = { ...out[i], ...x }; else out.push({ ...x });
  }
  return out;
}

/** Shipped defaults, overridden by the user file. A missing or broken user file is ignored. */
export function loadRules(env = process.env) {
  const shipped = readJsonFile(SHIPPED) ?? { version: 1, resources: {}, classes: [], rules: [] };
  const user = readJsonFile(userRulesPath(env));
  if (!user) return shipped;
  const { rules, classes, ...rest } = user;
  const merged = mergeInto(shipped, rest);
  merged.rules = mergeById(shipped.rules, rules);
  merged.classes = mergeById(shipped.classes, classes);
  return merged;
}

export const ruleOf = (rules, id) => (rules?.rules ?? []).find((r) => r.id === id) ?? null;
export const classOf = (rules, id) => (rules?.classes ?? []).find((c) => c.id === id) ?? null;

/** Capacity of a named resource: CI_BUDGET_RESOURCES="a=2,b=1" (env) first, then the rules file, else 1. */
export function capacityOf(rules, env, name) {
  const fromEnv = {};
  for (const part of String(env.CI_BUDGET_RESOURCES ?? '').split(',')) {
    const m = /^\s*([^=\s]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[2]) >= 1) fromEnv[m[1]] = Number(m[2]);
  }
  const c = fromEnv[name] ?? rules?.resources?.[name]?.capacity;
  return Number.isInteger(c) && c >= 1 ? c : 1;
}

/** "4G", "512M", "4096" (MB), "1.5G" -> megabytes, or null when unparsable. */
export function parseRam(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { '': 1, k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[m[2].toLowerCase()];
  const mb = Math.round(n * mult);
  return mb >= 0 ? mb : null;
}

/**
 * RAM kept free for interactive work and hooks: ram.reserveMb when it is a number,
 * else max(ram.reserveMinMb, ram.reserveFraction * total), by default
 * max(2 GB, 12.5% of total RAM): 8 GB on a 64 GB machine.
 */
export function ramReserveMb(rules, totalMb) {
  const ram = rules?.ram ?? {};
  if (Number.isFinite(ram.reserveMb) && ram.reserveMb >= 0) return ram.reserveMb;
  const min = Number.isFinite(ram.reserveMinMb) && ram.reserveMinMb >= 0 ? ram.reserveMinMb : 2048;
  const frac = Number.isFinite(ram.reserveFraction) && ram.reserveFraction >= 0 ? ram.reserveFraction : 0.125;
  return Math.max(min, Math.round(totalMb * frac));
}

// ---------------------------------------------------------------- limits and verdicts

/**
 * Limits that apply to one lease: its own (copied from its class when it was
 * granted) win; else, over the resources it holds, the smallest maxHoldMs / idleMs.
 */
export function limitsFor(rules, lease) {
  const own = lease.limits && typeof lease.limits === 'object' ? lease.limits : {};
  const pick = (key) => {
    if (Number.isFinite(own[key]) && own[key] > 0) return own[key];
    let best = null;
    const names = [...Object.keys(lease.resources ?? {}), ...(lease.units > 0 ? [BOX] : [])];
    for (const n of names) {
      const v = rules?.resources?.[n]?.[key];
      if (Number.isFinite(v) && v > 0 && (best === null || v < best)) best = v;
    }
    return best;
  };
  return { maxHoldMs: pick('maxHoldMs'), idleMs: pick('idleMs'), minHoldMs: pick('minHoldMs') };
}

/**
 * The rules that can clear or flag a lease whose pid and heartbeat are fine.
 * Returns { rule, evidence, keep? } or null. Pure: it reads the lease record only.
 *
 * Live-holder guard: while the holder is alive (opts.alive, default true: unknown means
 * alive) max-hold and idle do not clear it, up to the ceiling below. A verdict that would clear it comes back with keep: true,
 * a flag the sweep records (holder field overTime for max-hold, idleFlag for idle) and
 * status shows (OVER TIME, IDLE?). A dead holder is cleared by the sweep itself (pid-dead,
 * heartbeat-stale) before this runs; { alive: false } keeps the plain clears for a caller
 * that has proved the holder gone.
 *
 * Ceiling: a live holder is flagged only up to the live-holder-ceiling rule's ceilingMs from its
 * grant (default 4 h; null or 0 turns it off). Past it, a flagged live holder comes back as
 * { rule: 'live-holder-ceiling' } with no keep, so the sweep releases it and logs the flag that
 * held it (evidence.flaggedBy). A hung holder cannot hold its resources for ever.
 *
 * Evidence carries the last probe sample (act.ev: tree size, cpu delta, ports, busy-child
 * matches, sample count) and its age, so a false reading can be replayed.
 */
export const DEFAULT_LIVE_CEILING_MS = 4 * 3600_000;

/** The hard ceiling (ms) on how long a live holder may be flagged before it is released; 0 = off. */
export function liveCeilingMs(rules) {
  const r = ruleOf(rules, 'live-holder-ceiling');
  if (r && r.enabled === false) return 0;
  const v = r && r.ceilingMs !== undefined ? r.ceilingMs : DEFAULT_LIVE_CEILING_MS;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function liveVerdict(rules, lease, now, env = {}, { alive = true } = {}) {
  const v = rawVerdict(rules, lease, now, env, { alive });
  if (!v?.keep || !alive) return v;
  const ceilingMs = liveCeilingMs(rules);
  const heldMs = now - Number(lease.startedAt || now);
  if (!ceilingMs || heldMs <= ceilingMs) return v;
  return { rule: 'live-holder-ceiling', evidence: { heldMs, ceilingMs, flaggedBy: v.rule, ...v.evidence } };
}

function rawVerdict(rules, lease, now, env, { alive }) {
  const lim = limitsFor(rules, lease);
  const held = now - Number(lease.startedAt || now);
  const idle = ruleOf(rules, 'idle');
  const sampleMs = idle?.sampleMs ?? 30_000;
  const act = lease.act;
  // A stale or missing probe is "unknown", never "idle".
  const fresh = Boolean(act) && now - act.sampledAt <= Math.max(3 * sampleMs, 90_000);
  const sample = act ? { sampleAgeMs: Math.max(0, now - act.sampledAt), ...(act.ev ? { sample: act.ev } : {}) } : {};
  const flag = (v) => (alive ? { ...v, keep: true } : v);
  // The idle rule's reading, or null. Set beside a max-hold flag too, so a holder that is both
  // over time and quiet carries both flags (IDLE? and OVER TIME), not just the first one.
  const idleEvidence = () => {
    if (!(idle && idle.enabled !== false && (idle.appliesTo ?? ['run']).includes(lease.kind) && lim.idleMs && act)) return null;
    const minHold = lim.minHoldMs ?? 0;
    if (fresh && held >= minHold && now - act.activeAt > lim.idleMs) {
      return { heldMs: held, idleMs: now - act.activeAt, idleLimitMs: lim.idleMs, lastActivityAt: act.activeAt, sampledAt: act.sampledAt, ...sample };
    }
    return null;
  };
  const withIdle = (v) => { const ie = alive ? idleEvidence() : null; return ie ? { ...v, alsoIdle: ie } : v; };
  const mh = ruleOf(rules, 'max-hold');
  if (mh && mh.enabled !== false && (mh.appliesTo ?? ['run']).includes(lease.kind) && lim.maxHoldMs && held > lim.maxHoldMs) {
    const evidence = { heldMs: held, maxHoldMs: lim.maxHoldMs };
    const quietMs = lim.idleMs ?? 300_000;
    const measuredIdle = fresh && now - act.activeAt > quietMs;
    const activity = measuredIdle ? 'idle' : fresh ? 'active' : 'unknown';
    // An exclusive resource (any named one; capacity 1 by default) is cleared only from a
    // holder measured idle; a box-only lease has the plain clear. A live holder of either is
    // flagged "over time" and kept (keep: true), whatever the probe says.
    if (holdsExclusive(rules, lease, env)) {
      if (!measuredIdle) return withIdle({ rule: 'max-hold', keep: true, evidence: { ...evidence, activity, ...(act ? { lastActivityAt: act.activeAt } : {}), ...sample } });
      return withIdle(flag({ rule: 'max-hold', evidence: { ...evidence, activity, idleMs: now - act.activeAt, lastActivityAt: act.activeAt, sampledAt: act.sampledAt, ...sample } }));
    }
    return withIdle(flag({ rule: 'max-hold', evidence: { ...evidence, activity, ...sample } }));
  }
  const ie = idleEvidence();
  if (ie) return flag({ rule: 'idle', evidence: ie });
  return null;
}

/**
 * True when the lease holds a named resource of capacity 1: CI_BUDGET_RESOURCES in `env`, else the
 * rules' capacity, else 1 (the order capacityOf uses). The default env {} reads the rules only.
 */
export function holdsExclusive(rules, lease, env = {}) {
  return Object.keys(lease.resources ?? {}).some((n) => n !== BOX && capacityOf(rules, env, n) <= 1);
}

// ---------------------------------------------------------------- clear log

export const clearsFile = (dir) => join(dir, 'clears.jsonl');

/** Append one clear record: { at, rule, type, id, pid, label, project, resources, evidence }. Never throws. */
export function appendClear(dir, rec) {
  try {
    const file = clearsFile(dir);
    try {
      if (statSync(file).size > CLEARS_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    appendFileSync(file, `${JSON.stringify(rec)}\n`);
  } catch { /* a log failure never blocks the queue */ }
}

/** The newest `limit` clears no older than `sinceMs`, newest first. */
export function recentClears(dir, { limit = 20, sinceMs = 24 * 3600_000, now = Date.now() } = {}) {
  let raw = '';
  try { raw = readFileSync(clearsFile(dir), 'utf8'); } catch { return []; }
  const out = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (!lines[i]) continue;
    try {
      const r = JSON.parse(lines[i]);
      if (r && Number(r.at) >= now - sinceMs) out.push(r);
    } catch { /* torn line */ }
  }
  return out;
}

// ---------------------------------------------------------------- process table (spawns; never on the hook path)

/**
 * One snapshot of the process table: [{pid, ppid, name, cmd, cpuMs, startedAt}].
 * Windows: one hidden PowerShell Get-CimInstance Win32_Process call, about 0.4 to
 * 1 s of cpu per call. Linux: /proc, no spawn. Elsewhere: ps. Returns null on failure.
 */
export function processTable() {
  try {
    if (process.platform === 'win32') {
      const ps = '$ErrorActionPreference="Stop";Get-CimInstance Win32_Process | ForEach-Object { '
        + '[pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;n=$_.Name;c=$_.CommandLine;'
        + 'k=[int64]$_.KernelModeTime+[int64]$_.UserModeTime;s=$_.CreationDate} } | ConvertTo-Json -Compress';
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
      });
      if (r.status !== 0 || !r.stdout) return null;
      const arr = [].concat(JSON.parse(r.stdout));
      return arr.map((x) => ({
        pid: x.p, ppid: x.pp, name: String(x.n ?? ''), cmd: String(x.c ?? ''),
        cpuMs: Math.round(Number(x.k) / 10_000), // 100 ns units
        startedAt: parseCimDate(x.s),
      }));
    }
    if (process.platform === 'linux') {
      const tick = 10; // clock ticks are 100 Hz on every mainstream kernel
      // Process start = boot time (/proc/stat btime, s) + starttime (stat field 22, ticks since boot).
      let btimeMs = null;
      try { const m = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8')); if (m) btimeMs = Number(m[1]) * 1000; } catch { /* unreadable: no start times */ }
      const out = [];
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const st = readFileSync(`/proc/${d}/stat`, 'utf8');
          const close = st.lastIndexOf(')');
          const f = st.slice(close + 2).split(' ');
          let cmd = '';
          try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { /* gone */ }
          out.push({
            pid: Number(d), ppid: Number(f[1]), name: st.slice(st.indexOf('(') + 1, close), cmd,
            cpuMs: (Number(f[11]) + Number(f[12])) * tick,
            startedAt: btimeMs !== null && Number.isFinite(Number(f[19])) ? btimeMs + Number(f[19]) * tick : null,
          });
        } catch { /* exited while reading */ }
      }
      return out;
    }
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status !== 0) return null;
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(\d+):(\d+):?(\d+)?\s+(.*)$/.exec(l);
      if (!m) return null;
      const secs = (Number(m[3] || 0) * 86400) + (m[6] ? Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]) : Number(m[4]) * 60 + Number(m[5]));
      return { pid: Number(m[1]), ppid: Number(m[2]), name: m[7], cmd: m[7], cpuMs: secs * 1000, startedAt: null };
    }).filter(Boolean);
  } catch { return null; }
}

// Windows PowerShell 5.1 ConvertTo-Json writes a DateTime as "/Date(<epoch ms>)/".
function parseCimDate(s) {
  if (!s) return null;
  const m = /Date\((\d+)/.exec(String(s));
  if (m) return Number(m[1]);
  return Date.parse(String(s)) || null;
}

/**
 * Git Bash (msys) parent links, as [{pid, ppid}] in Windows pids, or null when
 * the msys process list cannot be read. Why it is needed: when an msys process
 * (the pre-push hook's sh, a bash running an npm or npx shim) forks and the
 * child execs another msys program, the exec'd program is a new Windows process
 * whose Windows parent is the forked child, and that child exits at once. The
 * Windows table then shows the exec'd program, and everything under it, with a
 * dead parent: a walk over Windows parent pids never reaches it. msys keeps the
 * real chain in its own pids (`ps -a -l`: PID PPID PGID WINPID ...); this maps
 * it back to Windows pids. One hidden spawn of Git's ps.exe, wrapper side only.
 * `near`: directories of the msys programs seen in the tree; the ps.exe beside
 * them is tried first (another msys on PATH cannot see this install's processes).
 * Then Git for Windows is found the way the plugin finds Git Bash, never through
 * PATH alone (a hook or gate may run with a stripped PATH): msysBinCandidates(),
 * and last `git --exec-path` (one spawn, only when nothing else matched).
 * `gitExecPath` is a test seam: () => the git-core dir, or null.
 * Called only when the tree holds an msys process, so a missing ps.exe is null
 * ("unknown"), not "no links". Returns [] off Windows.
 */
export function msysLinks({ env = process.env, near = [], gitExecPath, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const ps = findMsysPs(env, near, gitExecPath);
  if (!ps) return null;
  try {
    const r = spawnSync(ps, ['-a', '-l'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return null;
    return parseMsysPs(r.stdout);
  } catch { return null; }
}

/** `ps -a -l` text -> [{pid, ppid}] in Windows pids (rows whose msys parent is listed). */
export function parseMsysPs(text) {
  const rows = [];
  for (const l of String(text).split('\n')) {
    const m = /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(l);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), win: Number(m[4]) });
  }
  const winOf = new Map(rows.map((r) => [r.pid, r.win]));
  const out = [];
  for (const r of rows) {
    const parentWin = winOf.get(r.ppid);
    if (parentWin && parentWin !== r.win) out.push({ pid: r.win, ppid: parentWin });
  }
  return out;
}

// `git --exec-path` (<Git>/mingw64/libexec/git-core), or null. Runs with this
// process's own environment, so a stripped `env` argument cannot hide git.
function gitExecPathOf() {
  try {
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
}

/**
 * The dirs that may hold Git's ps.exe, in lookup order (no spawn): the tree's own
 * msys dirs, then CLAUDE_CODE_GIT_BASH_PATH's install, then the standard install
 * dirs (C:\Program Files when the env names none), then PATH. Git's install comes
 * before PATH because another msys (MSYS2, Cygwin) cannot see Git Bash's processes.
 */
export function msysBinCandidates(env = process.env, near = []) {
  const dirs = [...near];
  const bash = env.CLAUDE_CODE_GIT_BASH_PATH; // <Git>\bin\bash.exe or <Git>\usr\bin\bash.exe
  if (bash) dirs.push(dirname(bash), join(dirname(bash), '..', 'usr', 'bin'));
  const roots = [env.ProgramFiles ?? env.ProgramW6432 ?? 'C:\\Program Files', env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')];
  for (const p of roots.filter(Boolean)) dirs.push(join(p, 'Git', 'usr', 'bin'));
  dirs.push(...String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean));
  return dirs;
}

const isMsysBin = (d) => {
  try { statSync(join(d, 'msys-2.0.dll')); statSync(join(d, 'ps.exe')); return true; } catch { return false; }
};
const msysPsCache = new Map();
function findMsysPs(env, near = [], gitExecPath = gitExecPathOf) {
  const dirs = msysBinCandidates(env, near);
  const key = dirs.join(';');
  const seam = gitExecPath !== gitExecPathOf;
  if (!seam && msysPsCache.has(key)) return msysPsCache.get(key);
  const hit = dirs.find(isMsysBin);
  let found = hit ? join(hit, 'ps.exe') : null;
  if (!found) { // last: ask git where it lives (<Git>/mingw64/libexec/git-core -> <Git>/usr/bin)
    const core = gitExecPath();
    const d = core && join(core, '..', '..', '..', 'usr', 'bin');
    if (d && isMsysBin(d)) found = join(d, 'ps.exe');
  }
  if (seam) return found; // a test seam is never cached
  if (msysPsCache.size > 16) msysPsCache.clear();
  msysPsCache.set(key, found);
  return found;
}

// The directory of a process's program, from its command line (quoted or bare), or null.
// A process command line is a Windows path whatever host runs this code, so it is split with
// win32 rules: the host's dirname would not split backslashes on Linux (0.31.26 CI failure).
export function exeDir(p) {
  const cmd = String(p.cmd ?? '').trim();
  const m = /^"([^"]+)"/.exec(cmd) ?? /^(.+?\.exe)(?:\s|$)/i.exec(cmd);
  return m && /[\\/]/.test(m[1]) ? win32.dirname(m[1]) : null;
}

const MSYS_RE = /^(?:sh|bash|dash|zsh)\.exe$/i;
const isMsys = (p) => MSYS_RE.test(p.name) || /[\\/]usr[\\/]bin[\\/]/i.test(String(p.cmd ?? ''));

/**
 * Clock slack for start-time evidence: Windows CreationDate and Linux starttime come at other
 * resolutions than Date.now(). Slack only loosens a rejection; it never makes one easier.
 */
const START_SLACK_MS = 2000;
const hasStart = (p) => p?.startedAt != null && Number.isFinite(Number(p.startedAt));

/**
 * A real child starts no earlier than its parent. A start time on both sides that puts the
 * "child" before its "parent" means the parent's pid was reused: the link is a stale ppid, not
 * membership. A start time missing on either side is no evidence, and the link stands (keep).
 */
function startsAfter(child, parent) {
  if (!hasStart(child) || !hasStart(parent)) return true;
  return Number(child.startedAt) >= Number(parent.startedAt) - START_SLACK_MS;
}

/** Every process under rootPid: Windows parent pids plus any extra {pid, ppid} links. */
export function descendants(table, rootPid, links = []) {
  const kids = new Map();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const add = (ppid, p) => {
    const parent = byPid.get(ppid);
    if (parent && !startsAfter(p, parent)) return; // older than its parent: a reused pid
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(p);
  };
  for (const p of table) add(p.ppid, p);
  for (const l of links) {
    const p = byPid.get(l.pid);
    if (p && l.ppid !== p.ppid) add(l.ppid, p);
  }
  const out = []; const seen = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid); out.push(k); stack.push(k.pid);
    }
  }
  return out;
}

/** Listening TCP ports with owner pids (netstat -ano), as [{port, pid}]. One hidden spawn. */
export function listeningPorts() {
  try {
    const r = spawnSync('netstat', process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-lnt'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (r.status !== 0) return null;
    const out = [];
    for (const l of r.stdout.split('\n')) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l);
      if (m) out.push({ port: Number(m[1]), pid: Number(m[2]) });
    }
    return out;
  } catch { return null; }
}

/**
 * Sample the activity of a wrapped command's process tree. `prev` is the last
 * result ({ cpuMs, at }). Returns { cpuMs, at, active, why } or null when the
 * process table could not be read (the caller then leaves the sidecar alone, so
 * the lease reads "unknown", never "idle").
 * Active when any of: the tree used >= minCpuPct of one core since prev; it owns
 * a listening socket in one of `ports`; a descendant is named in `busyChildren`
 * (its image name, or its command line); or the tree's parent chain cannot be
 * read (an msys process in the tree while the msys list is unreadable): unknown
 * means keep, never idle.
 *
 * The tree is the Windows parent walk plus the msys links (see msysLinks()), plus
 * the children of any pid an earlier sample saw in the tree that has since died
 * (an orphaned subtree stays ours). CPU is summed per pid against the previous
 * sample, so a process that exits between samples cannot hide the work of the rest.
 */
const SEEN_MAX = 4096;

const BUSY_EXT = '(?:exe|cmd|bat|ps1|sh|[cm]?[jt]s|config)';
const BUSY_EXT_END = new RegExp(`\\.${BUSY_EXT}$`, 'i');
const busyRes = new Map();
/**
 * The regex for one busy-child name: the name as a whole token of a command line. A token starts
 * at the line start, whitespace, a quote, a path separator (either kind), = : ; , @ ( or a hyphen
 * (ms-playwright), and ends at the line end, whitespace, a quote, a path separator, = : ; , ), an
 * extension (java.exe, vitest.mjs, vitest.config.ts) or -core (playwright-core). So "java" does
 * not match "javascript", and "vitest" does not match the branch name in "git push origin fix/vitest-flake".
 */
function busyRe(name) {
  let re = busyRes.get(name);
  if (!re) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?:^|[\\s"'\\\\/=:;,@(-])${esc}(?=$|[\\s"'\\\\/=:;,)]|\\.${BUSY_EXT}(?![A-Za-z0-9])|-core(?![A-Za-z0-9]))`, 'i');
    busyRes.set(name, re);
  }
  return re;
}
/** True when the process's image name or command line names one of `names` (see busyRe). */
export function isBusyChild(p, names) {
  const image = String(p.name ?? '').replace(BUSY_EXT_END, '').toLowerCase();
  const cmd = String(p.cmd ?? '');
  return names.some((raw) => {
    const n = String(raw).toLowerCase();
    // The image is the name itself, or the name + "w" (java, javaw).
    return image === n || image === `${n}w` || busyRe(n).test(cmd);
  });
}
export function sampleTree(rootPid, {
  prev, minCpuPct = 5, ports = [], busyChildren = [], now = Date.now(), table = processTable, listen = listeningPorts, msys = table === processTable ? msysLinks : () => [],
} = {}) {
  const t = table();
  if (!t) return null;
  const alive = new Set(t.map((p) => p.pid));
  const extra = [];
  // Orphans of a pid we saw in the tree before it died are still ours, but only a process that
  // could have been that pid's child: it started no earlier than the dead pid did (its recorded
  // start, else the root's), and no later than the first sample that found the pid dead (a real
  // orphan was made while its parent lived). A process outside that window carries a stale ppid
  // left by a reused pid. A start time missing on either side is no evidence: adopt (keep).
  const rootStart = t.find((p) => p.pid === rootPid)?.startedAt ?? prev?.rootStart ?? null;
  const gone = { ...(prev?.gone ?? {}) };
  for (const pid of prev?.seen ?? []) {
    if (pid === rootPid) continue;
    if (alive.has(pid)) { delete gone[pid]; continue; } // reused and running again: its next death is a new one
    gone[pid] ??= now;
    const lo = prev?.born?.[pid] ?? rootStart;
    for (const p of t) {
      if (p.ppid !== pid) continue;
      if (hasStart(p)) {
        if (lo != null && Number(p.startedAt) < Number(lo) - START_SLACK_MS) continue;
        if (Number(p.startedAt) > gone[pid] + START_SLACK_MS) continue;
      }
      extra.push({ pid: p.pid, ppid: rootPid });
    }
  }
  // A pid seen in the tree stays a member while it is the same process (same recorded start): a
  // later holder of its parent's pid cannot drop it through the stale-ppid check in descendants().
  const seenBefore = new Set(prev?.seen ?? []);
  const byPidT = new Map(t.map((p) => [p.pid, p]));
  for (const p of t) {
    if (p.pid === rootPid || !seenBefore.has(p.pid)) continue;
    const par = byPidT.get(p.ppid);
    if (!par || startsAfter(p, par)) continue; // only the stale-ppid check can have dropped it
    const b0 = prev?.born?.[p.pid];
    if (b0 != null && Math.abs(Number(p.startedAt) - Number(b0)) <= START_SLACK_MS) extra.push({ pid: p.pid, ppid: rootPid });
  }
  const walk = (more) => [t.find((p) => p.pid === rootPid), ...descendants(t, rootPid, more)].filter(Boolean);
  let tree = walk(extra);
  // msys links are read only when an msys process is in the tree (the hook's sh stays alive
  // while it runs), so a missing or unreadable list there is "unknown", never "no links".
  const shells = tree.filter(isMsys);
  let links = [];
  if (shells.length) {
    links = msys({ near: [...new Set(shells.map(exeDir).filter(Boolean))] });
    if (links?.length) tree = walk([...extra, ...links]);
  }
  const cpu = {};
  for (const p of tree) cpu[p.pid] = p.cpuMs;
  const cpuMs = tree.reduce((s, p) => s + p.cpuMs, 0);
  const seen = [...new Set([...(prev?.seen ?? []), ...tree.map((p) => p.pid)])].slice(-SEEN_MAX);
  const inSeen = new Set(seen);
  const born = {};
  for (const [pid, at] of Object.entries(prev?.born ?? {})) if (inSeen.has(Number(pid))) born[pid] = at;
  for (const p of tree) if (hasStart(p)) born[p.pid] = p.startedAt;
  for (const pid of Object.keys(gone)) if (!inSeen.has(Number(pid))) delete gone[pid];
  // `ev` is the replay record of this reading (it goes to the lease's .act sidecar, small):
  // n samples so far, tree size, msys shells / links read (null = unreadable), summed cpu delta
  // in ms over dt ms (null on the first sample), busy-child matches, ports seen (null = not
  // checked because an earlier test already said active, [] = checked, none).
  const ev = {
    n: (prev?.ev?.n ?? 0) + 1, size: tree.length, shells: shells.length, links: links === null ? null : links.length,
    cpuMs: null, dtMs: null, pct: null, kids: 0, ports: null,
  };
  let why = null;
  if (prev && now > prev.at) {
    const before = prev.cpu ?? {};
    let used = 0;
    for (const p of tree) used += Math.max(0, p.cpuMs - (before[p.pid] ?? 0));
    const pct = (used / (now - prev.at)) * 100;
    ev.cpuMs = Math.round(used); ev.dtMs = now - prev.at; ev.pct = Math.round(pct * 10) / 10;
    if (pct >= minCpuPct) why = `cpu ${pct.toFixed(1)}%`;
  }
  if (busyChildren.length) {
    const hits = tree.filter((p) => p.pid !== rootPid && isBusyChild(p, busyChildren));
    ev.kids = hits.length;
    if (!why && hits.length) why = `child ${hits[0].name}`;
  }
  if (!why && links === null && tree.some(isMsys)) why = 'unknown: msys parent chain unreadable';
  if (!why && ports.length) {
    const ls = listen();
    if (ls) {
      const pids = new Set(tree.map((p) => p.pid));
      const hits = ls.filter((l) => pids.has(l.pid) && ports.some(([lo, hi]) => l.port >= lo && l.port <= hi));
      ev.ports = hits.slice(0, 4).map((l) => l.port);
      if (hits.length) why = `listening on ${hits[0].port}`;
    }
  }
  return { cpuMs, cpu, seen, born, gone, rootStart, size: tree.length, at: now, active: Boolean(why), why, ev: { ...ev, why } };
}

/**
 * Live processes that match a configured stray pattern while nothing holds that
 * resource. Reported by `status --strays`, never touched. `heldNames` is the set
 * of resources with a live holder. One process-table call (see processTable()).
 */
export function scanStrays(rules, heldNames, { table = processTable } = {}) {
  const t = table();
  if (!t) return null;
  const pids = new Set(t.map((p) => p.pid));
  const out = [];
  for (const rule of rules?.strays ?? []) {
    if (!rule?.resource || heldNames.has(rule.resource)) continue;
    let re;
    try { re = new RegExp(rule.cmdlineMatch || '.', 'i'); } catch { continue; }
    const want = String(rule.name || '').toLowerCase();
    for (const p of t) {
      if (!p.name.toLowerCase().includes(want) || !re.test(p.cmd || p.name)) continue;
      out.push({
        resource: rule.resource, pid: p.pid, ppid: p.ppid, name: p.name, orphan: !pids.has(p.ppid),
        startedAt: p.startedAt, why: rule.why || '', cmd: String(p.cmd).slice(0, 160),
      });
    }
  }
  return out;
}

export function mkdirp(dir) {
  try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}
