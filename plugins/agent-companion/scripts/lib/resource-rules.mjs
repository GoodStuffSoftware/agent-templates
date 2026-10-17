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
import { join, dirname } from 'node:path';
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

/** Capacity of a named resource: rules file, then CI_BUDGET_RESOURCES="a=2,b=1", else 1. */
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
 * The rules that can clear a live lease whose pid and heartbeat are fine.
 * Returns { rule, evidence } or null. Pure: it reads the lease record only.
 */
export function liveVerdict(rules, lease, now) {
  const lim = limitsFor(rules, lease);
  const held = now - Number(lease.startedAt || now);
  const mh = ruleOf(rules, 'max-hold');
  if (mh && mh.enabled !== false && (mh.appliesTo ?? ['run']).includes(lease.kind) && lim.maxHoldMs && held > lim.maxHoldMs) {
    return { rule: 'max-hold', evidence: { heldMs: held, maxHoldMs: lim.maxHoldMs } };
  }
  const idle = ruleOf(rules, 'idle');
  const act = lease.act;
  if (idle && idle.enabled !== false && (idle.appliesTo ?? ['run']).includes(lease.kind) && lim.idleMs && act) {
    const sampleMs = idle.sampleMs ?? 30_000;
    const fresh = now - act.sampledAt <= Math.max(3 * sampleMs, 90_000); // a stale probe is "unknown", never "idle"
    const minHold = lim.minHoldMs ?? 0;
    if (fresh && held >= minHold && now - act.activeAt > lim.idleMs) {
      return { rule: 'idle', evidence: { heldMs: held, idleMs: now - act.activeAt, idleLimitMs: lim.idleMs, lastActivityAt: act.activeAt, sampledAt: act.sampledAt } };
    }
  }
  return null;
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
        startedAt: x.s ? Date.parse(String(x.s)) || null : null,
      }));
    }
    if (process.platform === 'linux') {
      const tick = 10; // clock ticks are 100 Hz on every mainstream kernel
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
            cpuMs: (Number(f[11]) + Number(f[12])) * tick, startedAt: null,
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

export function descendants(table, rootPid) {
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
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
 * a listening socket in one of `ports`; a descendant is named in `busyChildren`.
 */
export function sampleTree(rootPid, { prev, minCpuPct = 5, ports = [], busyChildren = [], now = Date.now(), table = processTable, listen = listeningPorts } = {}) {
  const t = table();
  if (!t) return null;
  const tree = [t.find((p) => p.pid === rootPid), ...descendants(t, rootPid)].filter(Boolean);
  const cpuMs = tree.reduce((s, p) => s + p.cpuMs, 0);
  let why = null;
  if (prev && now > prev.at) {
    const pct = ((cpuMs - prev.cpuMs) / (now - prev.at)) * 100;
    if (pct >= minCpuPct) why = `cpu ${pct.toFixed(1)}%`;
  }
  if (!why && busyChildren.length) {
    const names = busyChildren.map((n) => n.toLowerCase());
    const hit = tree.find((p) => p.pid !== rootPid && names.some((n) => p.name.toLowerCase().includes(n)));
    if (hit) why = `child ${hit.name}`;
  }
  if (!why && ports.length) {
    const ls = listen();
    if (ls) {
      const pids = new Set(tree.map((p) => p.pid));
      const hit = ls.find((l) => pids.has(l.pid) && ports.some(([lo, hi]) => l.port >= lo && l.port <= hi));
      if (hit) why = `listening on ${hit.port}`;
    }
  }
  return { cpuMs, at: now, active: Boolean(why), why };
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
