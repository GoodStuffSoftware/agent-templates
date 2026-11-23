#!/usr/bin/env node
// Post-release watch. Read-only against telemetry and transcripts, no network, no model call.
//
//   release-watch.mjs tick                    run the checks that are due (a local-services job runs this every 10 min);
//                                             also writes the hold when a flag went unanswered. Exits 0 always.
//   release-watch.mjs status [--all] [--json]  print the schedule, each check's verdict and metrics, the flag and the hold
//   release-watch.mjs clear [--by <who>]      clear the flag and lift the hold
//   release-watch.mjs check --since <ISO> [--base-from <ISO>] [--days 7] [--sample 500]   one-shot, prints JSON + flags
//
// Schedule: +1, +2, +4, +8, +12, +16, +20, +24 h after the install time (installed_plugins.json lastUpdated) of the
// newest installed agent-companion copy. After sleep, every due check is covered by ONE run and marked done.
// Hold: option release_watch_hold_minutes (default 30; 0 = notify only).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeDir, stateRootPath, opt } from '../hooks/lib/context.mjs';
import * as S from '../hooks/lib/release-watch-state.mjs';
import { unitsPerPercent } from '../hooks/lib/plan-allowance.mjs';

// Session ids that only the install's live check writes (it feeds the guards invented commands and logs the denials). Exact ids, nothing guessed.
export const SYNTHETIC_SESSIONS = new Set(['live-check']);
export const CHECK_HOURS = [1, 2, 4, 8, 12, 16, 20, 24];
export const LATE_MS = 2 * 3600e3;
const HOUR = 3600e3;

// ---------- schedule ----------
export function newestInstall(installed) {
  let best = null;
  for (const [k, arr] of Object.entries((installed && installed.plugins) || {})) {
    if (!k.startsWith('agent-companion@') || !Array.isArray(arr)) continue;
    for (const e of arr) {
      const t = Date.parse(e && e.lastUpdated);
      if (t > 0 && (!best || t > best.T)) best = { T: t, version: e.version || null };
    }
  }
  return best;
}

export function buildSchedule(T, version) {
  return { version: version ?? null, T, due: CHECK_HOURS.map((h) => T + h * HOUR), done: [], lastAt: null, lastConclusiveAt: null, verdicts: [], status: 'watching' };
}

// Indexes of checks due at `at` and not done.
export function dueIndexes(sch, at) {
  return sch.due.map((d, i) => (d <= at && !sch.done.includes(i) ? i : -1)).filter((i) => i >= 0);
}

// ---------- analysis (port of the one-shot recipe) ----------
// Where the measured data lives: telemetry rows and queue clears are the machine's, never the watch's. AGENT_COMPANION_STATE_DIR moves only
// the watch's own run, flag, hold and checks files (S.paths()). Before 0.31.63 a scratch state dir also pointed the telemetry read at an empty
// dir, so a check counted zero spawns and reported zero usage while the transcripts (read from the claude dir) still showed workers.
export const dataRoot = () => join(claudeDir(), 'agent-companion');
const per = (a, b) => (b ? +(100 * a / b).toFixed(1) : null);
const jsonl = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const MULT = (m) => (/opus/.test(m) ? 1.29 : /haiku/.test(m) ? 0.5 : 1);
const units = (u, m) => 2e-6 * MULT(m) * ((u.input_tokens || 0) + 5 * (u.output_tokens || 0)
  + 1.25 * (u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0)
  + 2 * (u.cache_creation?.ephemeral_1h_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0));
const quant = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null; };
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
// A Bash tool_result error that is the harness refusing the command (isolation, a form it cannot verify), not the command failing.
// Safety limit on worker transcripts read per analysis (files are chosen by mtime inside the window, newest first).
export const WORKER_SCAN_CAP = 12000;
// Agent types that are not on the reporting contract (no STATUS line, own report format): left out of the worker status and Bash metrics, counted by name in workers.excluded.
export const NON_CONTRACT_TYPES = new Set(['Explore', 'Plan', 'web-fetch', 'claude-code-guide', 'statusline-setup']);
// A hook-verification spawn says so in its brief (first 400 chars of its first message): synthetic, not work.
export const PROBE_RE = /^[\s\S]{0,400}?hook verification spawn, not real work/i;
const STATUS_RE = /STATUS:\s*(done|partial|blocked)/i;
const STATUS_LINE_RE = /^[\s>*_`#-]*STATUS:\s*(done|partial|blocked)/im;
export const HARNESS_REFUSAL_RE =/isolated in the worktree|too complex to verify|names git in a form too complex|changes directory to the shared tree/i;

// Queue clears that mean something went wrong: a lease whose holder died or went stale, a holder past the ceiling, a stuck release.
// Waiting tickets whose requester left, idle clears, the operator's manual clear, and rows written by test runs are routine.
export const CLEAR_FAILURE_RULES = new Set(['pid-dead', 'heartbeat-stale', 'live-holder-ceiling', 'stuck-holder', 'stuck-release']);
export function isFailureClear(r) {
  if (!r || !CLEAR_FAILURE_RULES.has(r.rule)) return false;
  if (r.type && r.type !== 'lease') return false;
  const lab = String(r.label || ''); const wt = String(r.worktree || '').replace(/\\/g, '/').toLowerCase();
  if (/\.test\.m?js\b|node --test|\btests?\//i.test(lab)) return false;
  if (/\/(tmp|temp)\//.test(wt) || /\/appdata\/local\/temp\//.test(wt)) return false;
  return true;
}

// T: the install time of the newest release; the baseline is the `days` days before baseTo (default T; a chain passes its first install time, so
// the baseline never moves when a later release joins). winFrom: start of the window measured now (default baseTo; the tick passes the last
// conclusive check's time, so each check is a rate over its own window, not a running count since install). releases: [{version, T}] of a
// chain (two or more): the result then carries byVersion[version], one full metrics object per release with only the since side split by version.
export function analyze({ T, nowMs = S.now(), winFrom, baseFrom, baseTo, releases, days = 7, sample = 500, scanCap = WORKER_SCAN_CAP, telDir, projectsDir, clearsFiles, holds } = {}) {
  const root = stateRootPath();
  telDir = telDir || join(dataRoot(), 'telemetry');
  projectsDir = projectsDir || join(claudeDir(), 'projects');
  // The machine-wide queue data (LOCALAPPDATA) is read unless this is a sandboxed test process (isolate.mjs sets the sandbox home switch); a scratch state dir does not hide it.
  clearsFiles = clearsFiles || [...new Set([process.env.CI_BUDGET_DIR && join(process.env.CI_BUDGET_DIR, 'clears.jsonl'), join(dataRoot(), 'ci-budget', 'clears.jsonl'), join(root, 'ci-budget', 'clears.jsonl'),
    !process.env.AGENT_COMPANION_HOME_OVERRIDE && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ci-budget', 'clears.jsonl')].filter(Boolean).map((p) => p.replace(/\\/g, '/')))];
  const BT = baseTo > 0 ? baseTo : T;
  const B0 = baseFrom > 0 ? baseFrom : BT - days * 24 * HOUR;
  const W0 = winFrom > 0 ? Math.max(winFrom, BT) : BT;
  // What the hold itself caused (denials, refusals, anything logged while it was on) never counts toward a signal.
  const holdIv = holds || S.holdIntervals(nowMs);
  const inHold = (t) => holdIv.some(([a, b]) => t >= a && t <= b);
  // Rows the install's live check writes (session_id "live-check") are synthetic: they never count in any telemetry metric.
  const rows = {};
  const rd = (f) => (rows[f] ??= jsonl(join(telDir, f + '.jsonl')).filter((r) => !SYNTHETIC_SESSIONS.has(r && r.session_id)));
  const ts = (r) => (typeof r.at === 'number' ? r.at : Date.parse(r.at || r.ts || 0));
  // The release a since-side row belongs to: a spawn row says so itself (guard_version) when that is a chain version, else the newest release installed by then.
  const rel = Array.isArray(releases) && releases.length >= 2 ? releases.map((r) => ({ v: r.version || iso(r.T), T: r.T })).sort((a, b) => a.T - b.T) : null;
  const verAt = (t) => { let v = rel[0].v; for (const r of rel) if (r.T <= t) v = r.v; return v; };
  const verOf = (r, t) => (r && rel.some((x) => x.v === r.guard_version) ? r.guard_version : verAt(t));
  const win = (r, vf) => {
    const t = ts(r); if (inHold(t)) return null;
    if (t >= W0 && t <= nowMs) return vf == null || verOf(r, t) === vf ? 'since' : null;
    return t >= B0 && t < BT ? 'base' : null;
  };
  // ---- worker transcripts (read once; every version's block is built from the same records) ----
  const files = [];
  let projs = [];
  try { projs = readdirSync(projectsDir); } catch { /* none */ }
  for (const p of projs) {
    const d = join(projectsDir, p); let ss;
    try { ss = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ss) {
      if (!e.isDirectory()) continue;
      const sd = join(d, e.name, 'subagents'); let l;
      try { l = readdirSync(sd); } catch { continue; }
      for (const f of l) {
        if (!/^agent-.*\.jsonl$/.test(f)) continue;
        const fp = join(sd, f);
        try { const m = statSync(fp).mtimeMs; if (m >= B0) files.push({ fp, m }); } catch { /* gone */ }
      }
    }
  }
  const fresh = files.filter((f) => f.m >= W0); const old = files.filter((f) => f.m < W0);
  const step = Math.max(1, Math.ceil(old.length / sample));
  // Newest first: the safety cap (WORKER_SCAN_CAP, above a full busy week: 5676 files seen) then drops the oldest files, never whole projects.
  fresh.sort((a, b) => b.m - a.m);
  const pick = [...fresh.slice(0, scanCap).map((f) => f.fp), ...old.filter((_, i) => i % step === 0).map((f) => f.fp)];
  const seen = new Set(); const WR = [];
  for (const fp of pick) {
    let L; try { L = readFileSync(fp, 'utf8').split('\n'); } catch { continue; }
    let first = null; let u = 0; let peak = 0; let hook = 0; let terr = 0; let api = null; let txt = ''; let stLine = null; let probe = false; let seenUser = false;
    const bashIds = new Set(); let bash = 0; let refusal = 0; let bashFail = 0; const sigs = [];
    for (const l of L) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.timestamp && !first) first = Date.parse(o.timestamp);
      const c = o.message?.content;
      if (o.type === 'user' && !seenUser) { seenUser = true; const t0 = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : ''; probe = PROBE_RE.test(String(t0 || '')); }
      if (o.type === 'assistant' && o.message?.usage && o.message.model !== '<synthetic>') {
        const k = o.requestId || o.message.id || o.uuid;
        if (!seen.has(k)) {
          seen.add(k); const us = o.message.usage; u += units(us, o.message.model || '');
          peak = Math.max(peak, (us.input_tokens || 0) + (us.cache_read_input_tokens || 0) + (us.cache_creation_input_tokens || 0));
        }
      }
      if (o.isApiErrorMessage) api = o.apiError || 'api';
      if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'tool_use' && b.name === 'Bash' && o.type === 'assistant' && b.id && !bashIds.has(b.id)) { bashIds.add(b.id); if (!inHold(Date.parse(o.timestamp))) bash++; }
        if (b.type === 'tool_result' && b.is_error && bashIds.has(b.tool_use_id) && !inHold(Date.parse(o.timestamp))) {
          const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          if (HARNESS_REFUSAL_RE.test(t)) refusal++; else if (!/^PreToolUse:/.test(t)) bashFail++;
        }
        // The report is the last assistant text or the SubagentHandback call's message (the harness delivers it as the result); a STATUS given earlier still counts when the worker was woken and answered without one.
        if (o.type === 'assistant' && (b.type === 'text' || (b.type === 'tool_use' && b.name === 'SubagentHandback'))) {
          const tx = b.type === 'text' ? b.text : b.input && b.input.message;
          if (typeof tx === 'string') { txt = tx; const m = STATUS_LINE_RE.exec(tx); if (m) stLine = m[1].toLowerCase(); }
        }
        if (b.type === 'tool_result' && b.is_error) {
          terr++; const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          const m = /^(PreToolUse:[\w:]+) hook error: (.{0,48})/.exec(t);
          if (m && !/post-release hold/i.test(t) && !inHold(Date.parse(o.timestamp))) { hook++; sigs.push(`${m[1]} ${m[2]}`); }
        }
      }
    }
    if (!first || first < B0 || first > nowMs) continue;
    const w = first >= W0 ? 'since' : first < BT ? 'base' : null;
    if (!w || inHold(first)) continue;
    const st = STATUS_RE.exec(txt);
    const status0 = st ? st[1].toLowerCase() : stLine;
    let fin = false; let atype = ''; try { const mt = JSON.parse(readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')); fin = mt.finished === true; atype = String(mt.agentType || ''); } catch { /* none */ }
    const ex = probe ? 'probe' : NON_CONTRACT_TYPES.has(atype) ? atype : null;
    WR.push({ w, first, sigs, u, peak, hook, terr, api, bash, refusal, bashFail, ex, status: status0 || (fin ? 'none' : 'running') });
  }
  // The whole result for the since side restricted to release `vf` (null = the whole chain); the baseline side is always the shared one.
  const build = (vf) => {
    const N = { since: 0, base: 0 };
    for (const r of rd('spawns')) { const w = win(r, vf); if (w) N[w]++; }
    const span = { since: Math.max((nowMs - W0) / HOUR, 1e-3), base: Math.max((BT - B0) / HOUR, 1e-3) };
    const out = { T: new Date(T).toISOString(), now: new Date(nowMs).toISOString(), spawns: { ...N, perHour: { since: +(N.since / span.since).toFixed(1), base: +(N.base / span.base).toFixed(1) } }, telemetry: {}, span };
    const count = (file, keyf, filt = () => true) => {
      const c = {};
      for (const r of rd(file)) { const w = win(r, vf); if (!w || !filt(r)) continue; const k = keyf(r); (c[k] ??= { since: 0, base: 0 })[w]++; }
      return c;
    };
    const add = (name, c) => {
      for (const [k, v] of Object.entries(c)) out.telemetry[`${name}:${k}`] = { since: v.since, base: v.base, per100spawns: { since: per(v.since, N.since), base: per(v.base, N.base) } };
    };
    add('denial', count('denials', (r) => `${r.guard}/${r.outcome}`));
    add('handoff', count('handoff-limit', (r) => `${r.limit}/${r.action}`));
    add('ctx', count('subagent-context', (r) => `${r.kind}/${r.phase}`));
    add('gate', count('resource-gate', (r) => r.event));
    add('wait', count('worker-wait', (r) => `${r.kind}/${r.action}`, (r) => r.action === 'deny'));
    add('struggle', count('struggle', () => 'fired', (r) => r.fired));
    add('runaway', count('runaway', () => 'fired'));
    {
      // bash-exit.jsonl rows do not say which failures were harness refusals; the worker transcripts do (out.bash, below). Kept for information only.
      const c = count('bash-exit', (r) => (r.failed ? 'fail' : 'ok'), (r) => r.caller_is_subagent);
      const f = c.fail || { since: 0, base: 0 }; const o = c.ok || { since: 0, base: 0 };
      out.bashExit = { since: { n: f.since + o.since, failPct: per(f.since, f.since + o.since) }, base: { n: f.base + o.base, failPct: per(f.base, f.base + o.base) } };
    }
    {
      // Heavy-command denials split by reason when the row carries one: a command that changes directory after its first step cannot be queued.
      const q = { since: { n: 0, cdPrefix: 0 }, base: { n: 0, cdPrefix: 0 } };
      for (const r of rd('resource-gate')) {
        const w = win(r, vf); if (!w || !/denied/.test(String(r.event || ''))) continue;
        q[w].n++; if (r.reason === 'cd-prefix' || /changes directory after its first step/.test(String(r.reason || r.detail || ''))) q[w].cdPrefix++;
      }
      out.queueDenied = q;
      // Active hours: distinct clock hours of the window that hold at least one spawn row. Active days: distinct UTC days (the standing trend's history check).
      const hrs = { since: new Set(), base: new Set() }; const days = { since: new Set(), base: new Set() };
      for (const r of rd('spawns')) { const w = win(r, vf); if (w) { hrs[w].add(Math.floor(ts(r) / HOUR)); days[w].add(new Date(ts(r)).toISOString().slice(0, 10)); } }
      out.activeHours = { since: hrs.since.size, base: hrs.base.size };
      out.activeDays = { since: days.since.size, base: days.base.size };
    }
    {
      const c = { since: 0, base: 0 };
      for (const f of clearsFiles) for (const r of jsonl(f)) { if (!isFailureClear(r)) continue; const w = win(r, vf); if (w) c[w]++; }
      out.queueClears = { since: c.since, base: c.base, perHour: { since: +(c.since / span.since).toFixed(2), base: +(c.base / span.base).toFixed(2) } };
    }
    const W = { since: [], base: [] }; const sig = { since: {}, base: {} };
    for (const x of WR) {
      if (x.w === 'since' && vf != null && verAt(x.first) !== vf) continue;
      W[x.w].push(x); for (const k of x.sigs) sig[x.w][k] = (sig[x.w][k] || 0) + 1;
    }
    out.workers = {}; out.bash = {};
    for (const w of ['since', 'base']) {
      const cw = W[w].filter((x) => !x.ex);
      const bn = sum(cw, (x) => x.bash); const rf = sum(cw, (x) => x.refusal); const bf = sum(cw, (x) => x.bashFail);
      out.bash[w] = { n: bn, realFails: bf, realFailPct: per(bf, bn), refusals: rf, refusalPer100: per(rf, bn) };
    }
    for (const w of ['since', 'base']) {
      const a = W[w]; const fin = a.filter((x) => x.status !== 'running' && !x.ex);
      // Workers left out of the status and Bash metrics (types off the reporting contract, hook-verification probes), named, never dropped silently.
      const excluded = { probes: 0, byType: {} };
      for (const x of a) if (x.ex === 'probe') excluded.probes++; else if (x.ex) excluded.byType[x.ex] = (excluded.byType[x.ex] || 0) + 1;
      out.workers[w] = {
        n: a.length, finished: fin.length, excluded,
        unitsPerWorker: { mean: +(sum(a, (x) => x.u) / Math.max(1, a.length)).toFixed(2), p50: quant(a.map((x) => x.u), 0.5), p90: quant(a.map((x) => x.u), 0.9) },
        peakCtxP90: quant(a.map((x) => x.peak), 0.9),
        over110kPct: per(a.filter((x) => x.peak > 110000).length, a.length), over150kPct: per(a.filter((x) => x.peak > 150000).length, a.length),
        noStatusPct: per(fin.filter((x) => x.status === 'none').length, fin.length),
        partialPct: per(fin.filter((x) => x.status === 'partial').length, fin.length),
        blockedPct: per(fin.filter((x) => x.status === 'blocked').length, fin.length),
        hookErrorWorkersPct: per(a.filter((x) => x.hook > 0).length, a.length),
        apiErrorWorkers: a.filter((x) => x.api).length,
        apiNonUsageWorkers: a.filter((x) => x.api && !/usage_limit/.test(String(x.api))).length,
      };
    }
    out.estUnitsPerHour = { since: +(out.spawns.perHour.since * out.workers.since.unitsPerWorker.mean).toFixed(2), base: +(out.spawns.perHour.base * out.workers.base.unitsPerWorker.mean).toFixed(2) };
    out.usage = usageOf(out);
    out.hookSignatures = { since: sig.since, base: sig.base };
    return out;
  };
  const out = build(null);
  if (rel) { out.byVersion = {}; for (const r of rel) out.byVersion[r.v] = build(r.v); }
  return out;
}

// Worker usage as a share of the weekly limit: plan units per hour divided by the units that are 1% of the week (28.6 shipped,
// plan-allowance.mjs). `src` names why a side is empty: no spawn rows (telemetry) or no worker transcripts.
export function usageOf(m, unitsPerPct = unitsPerPercent()) {
  const side = (w) => {
    const sp = m.spawns.perHour[w]; const wk = m.workers[w];
    const u = +(sp * wk.unitsPerWorker.mean).toFixed(2);
    const why = [m.spawns[w] === 0 ? 'no spawn rows in telemetry' : null, wk.n === 0 ? 'no worker transcripts' : null].filter(Boolean);
    return { unitsPerHour: u, pctPerHour: +(u / unitsPerPct).toFixed(3), empty: !(u > 0), why };
  };
  return { unitsPerPercent: unitsPerPct, since: side('since'), base: side('base') };
}

// ---------- thresholds (design section 1; v2 floors in docs/adr/0008-release-watch-v2.md) ----------
// Every metric has a denominator floor (min) and an event floor (minEv): below the denominator floor it is INCONCLUSIVE, below the
// event floor it is ok. The three core floors (spawns, worker transcripts, worker Bash calls) are options (release_watch_min_*).
export const TH = {
  minSpawns: 30, minWorkers: 20, minBash: 200, guardFactor: 2, guardMinN: 10, newGuardMin: 5,
  rewritePer100: 3, rewriteMinEv: 3, hookErrorPp: 15, newSigWorkers: 5, over150Pct: 5, over150MinEv: 3, handoffHardPer100: 2, handoffHardMinEv: 3, handoffEndBlockPer100: 10, handoffEndBlockMinEv: 5,
  noStatusPct: 15, noStatusMinFinished: 30, noStatusPp: 10, noStatusMinEv: 5, partialPct: 35, partialMinFinished: 20, partialMinEv: 5, blockedPct: 6, blockedMinEv: 5,
  bashFailPct: 7, bashFailMinEv: 10, refusalPer100: 10, refusalMinEv: 10, gateDeniedPer100: 20, gateDeniedMinEv: 5, clearsFactor: 2, clearsMin: 10, minActiveHours: 2,
  apiWorkers: 3, apiNonUsage: 2, newGuardPer100: 10, hookErrorMinEv: 5,
  struggle100: 2, struggleMinEv: 3, unitsFactor: 1.5, unitsAbs: 1.9, unitsMinEv: 5, pollDeny100: 18, pollMinEv: 5,
};
const REWRITE_GUARDS = new Set(['fit', 'inherit', 'type-required', 'routing-autofix']);

const nOpt = (key, fallback) => { const v = Number(opt(key, fallback)); return v > 0 ? v : fallback; };
// The core floors in force: opts (tests, one-shot checks) over options over the shipped defaults.
export function floors(opts = {}) {
  return {
    spawns: opts.minSpawns ?? nOpt('release_watch_min_spawns', TH.minSpawns),
    workers: opts.minWorkers ?? nOpt('release_watch_min_workers', TH.minWorkers),
    bash: opts.minBash ?? nOpt('release_watch_min_bash', TH.minBash),
  };
}

// Returns { verdict: 'flag'|'clean'|'inconclusive', metrics: [...], flags: [...] }.
//   metric: { name, value, limit, base, n, events, status: 'flag'|'ok'|'inconclusive', hold, unit, detail, level }
//   flags:  the metrics with status 'flag', in the shape callers (tick, the flag file) always had, plus n, events, base.
// opts.first (the first check of an install) is accepted and unused.
export function evaluate(m, opts = {}) {
  const metrics = [];
  if (!m || !m.spawns || !m.workers) return { verdict: 'inconclusive', metrics, flags: [] };
  const FL = floors(opts);
  const sp = m.spawns; const ws = m.workers.since; const wb = m.workers.base;
  const spanH = m.span.since;
  const bs = (m.bash && m.bash.since) || { n: 0, realFails: 0, realFailPct: null, refusals: 0, refusalPer100: null }; const bb = (m.bash && m.bash.base) || {};
  const active = m.activeHours ? m.activeHours.since : Math.round(spanH);
  const cnt = (pct, n) => Math.round((pct || 0) * (n || 0) / 100);
  // level: the rate the flag is judged on later (per hour, per 100 spawns, a share). A count flag carries count / window hours.
  const add = (name, { value, limit = null, base = null, n, minN = 0, events, minEv = 0, over, unit = '', detail = '', level = value, hold = !S.NO_HOLD_FLAGS.has(name) }) => {
    const status = n < minN ? 'inconclusive' : (events < minEv || value == null) ? 'ok' : over ? 'flag' : 'ok';
    metrics.push({ name, value, limit, base, n, events, status, hold, unit, detail: status === 'flag' || detail ? detail : '', level });
  };
  {
    // The token-bleed half of the watch has nothing to judge when the usage source is empty: that is an error, never a quiet "clean".
    const us = usageOf(m);
    const bad = us.base.empty ? ['baseline', us.base] : sp.since >= FL.spawns && us.since.empty ? ['window', us.since] : null;
    add('usage-source-empty', { value: 0, limit: 0, n: sp.since, events: bad ? 1 : 0, minEv: 1, over: !!bad, level: 0, unit: 'flag',
      detail: bad ? `usage source empty (${bad[0]}: ${bad[1].why.join(', ') || 'zero units'}), the usage metric measured nothing` : '' });
  }
  const tel = Object.entries(m.telemetry);
  const sumTel = (re) => tel.filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v.since, 0);
  const sumTelBase = (re) => tel.filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v.base, 0);
  const n30 = sp.since; // spawn denominator
  for (const [k, v] of tel) {
    if (!k.startsWith('denial:') || !k.endsWith('/deny')) continue; // only deny outcomes count; warn, autofix and rewrite rows never flag
    const guard = k.slice(7).split('/')[0];
    if (REWRITE_GUARDS.has(guard)) continue;
    if (guard === 'delegation') {
      const hs = v.since / spanH; const hb = v.base / m.span.base;
      add(`guard:${k.slice(7)}`, { value: +hs.toFixed(1), limit: +(TH.guardFactor * hb).toFixed(1), base: +hb.toFixed(1), n: active, minN: TH.minActiveHours, events: v.since, minEv: TH.guardMinN,
        over: hb > 0 && hs > TH.guardFactor * hb, unit: '/h', detail: `per hour ${hs.toFixed(1)} vs ${hb.toFixed(1)}` });
      continue;
    }
    const ps = v.per100spawns.since; const pb = v.per100spawns.base;
    // A key with no baseline hits flags on its deny rate per 100 spawns over a floor, never on mere presence.
    if (v.base === 0) add(`guard:${k.slice(7)}`, { value: ps, limit: TH.newGuardPer100, base: pb, n: n30, minN: FL.spawns, events: v.since, minEv: TH.newGuardMin, over: ps > TH.newGuardPer100, unit: '/100', detail: `new guard, ${v.since} hits, ${ps}/100 spawns` });
    else add(`guard:${k.slice(7)}`, { value: ps, limit: +(TH.guardFactor * pb).toFixed(1), base: pb, n: n30, minN: FL.spawns, events: v.since, minEv: TH.guardMinN, over: pb > 0 && ps > TH.guardFactor * pb, unit: '/100', detail: `${ps}/100 spawns vs ${pb}` });
  }
  const per100 = (cnt100, minEv, name, limit, detail, baseCount) => {
    const v = per(cnt100, sp.since);
    add(name, { value: v, limit, base: baseCount == null ? null : per(baseCount, m.spawns.base), n: n30, minN: FL.spawns, events: cnt100, minEv, over: v > limit, unit: '/100', detail });
  };
  {
    const rw = tel.filter(([k]) => k.startsWith('denial:') && k.endsWith('/deny') && REWRITE_GUARDS.has(k.slice(7).split('/')[0]));
    const c = rw.reduce((s, [, v]) => s + v.since, 0); const cb = rw.reduce((s, [, v]) => s + v.base, 0);
    per100(c, TH.rewriteMinEv, 'spawn-rewrites', TH.rewritePer100, `${c} rewrites/denials per ${sp.since} spawns`, cb);
  }
  {
    const gd = sumTel(/^gate:.*denied/); const gb = sumTelBase(/^gate:.*denied/);
    const baseRate = per(gb, sp.base) || 0; const lim = Math.max(TH.gateDeniedPer100, TH.guardFactor * baseRate);
    const cd = m.queueDenied ? m.queueDenied.since.cdPrefix : 0;
    add('queue-denied', { value: per(gd, sp.since), limit: +lim.toFixed(1), base: per(gb, sp.base), n: n30, minN: FL.spawns, events: gd, minEv: TH.gateDeniedMinEv, over: per(gd, sp.since) > lim, unit: '/100', detail: `${gd} denied${cd ? `, ${cd} cd-prefix` : ''}` });
  }
  per100(sumTel(/^handoff:hard\/deny$/), TH.handoffHardMinEv, 'handoff-hard-deny', TH.handoffHardPer100, `${sumTel(/^handoff:hard\/deny$/)} hard denials`, sumTelBase(/^handoff:hard\/deny$/));
  per100(sumTel(/^handoff:.*\/end-block$/), TH.handoffEndBlockMinEv, 'handoff-end-block', TH.handoffEndBlockPer100, `${sumTel(/^handoff:.*\/end-block$/)} end-blocks`, sumTelBase(/^handoff:.*\/end-block$/));
  per100(sumTel(/^struggle:/), TH.struggleMinEv, 'struggle', TH.struggle100, `${sumTel(/^struggle:/)} fired`, sumTelBase(/^struggle:/));
  per100(sumTel(/^wait:/), TH.pollMinEv, 'polling-waste', TH.pollDeny100, `${sumTel(/^wait:/)} worker-wait denials`, sumTelBase(/^wait:/));
  {
    // Deliberately no denominator or event floor (minN 0, minEv 1): a runaway session is a real fault even once, not a rate that needs a sample
    // to be believed, and it is holdable. This is the one metric that stays a one-event trigger (docs/adr/0008-release-watch-v2.md).
    const rn = sumTel(/^runaway:/);
    add('runaway', { value: rn, limit: 0, base: sumTelBase(/^runaway:/), n: sp.since, events: rn, minEv: 1, over: rn > 0, unit: 'count', detail: `${rn} runaway row(s)`, level: +(rn / spanH).toFixed(3) });
  }
  {
    // Failure clears per hour against the pooled 7-day rate (floor: one clear in the baseline), never a fixed rate.
    const qc = m.queueClears; const baseRate = Math.max(qc.base, 1) / m.span.base; const lim = TH.clearsFactor * baseRate;
    add('queue-clears', { value: +(qc.since / spanH).toFixed(2), limit: +lim.toFixed(2), base: +baseRate.toFixed(2), n: active, minN: TH.minActiveHours, events: qc.since, minEv: TH.clearsMin, over: qc.since / spanH > lim, unit: '/h', detail: `${qc.since} failure clears, baseline ${qc.perHour.base}/h` });
  }
  {
    const baseFail = bb.realFailPct ?? 0; const lim = Math.max(TH.bashFailPct, TH.guardFactor * baseFail);
    add('worker-bash-fail', { value: bs.realFailPct, limit: +lim.toFixed(1), base: bb.realFailPct ?? null, n: bs.n, minN: FL.bash, events: bs.realFails, minEv: TH.bashFailMinEv, over: bs.realFailPct > lim, unit: '%', detail: `n=${bs.n}, ${bs.realFails} real failures` });
    add('harness-refusals', { value: bs.refusalPer100, limit: TH.refusalPer100, base: bb.refusalPer100 ?? null, n: bs.n, minN: FL.bash, events: bs.refusals, minEv: TH.refusalMinEv, over: bs.refusalPer100 > TH.refusalPer100, unit: '/100 bash', detail: `${bs.refusals} refusals in ${bs.n} Bash calls` });
  }
  const wn = ws.n; const bothN = Math.min(ws.n, wb.n);
  {
    const lim = (wb.hookErrorWorkersPct ?? 0) + TH.hookErrorPp;
    add('hook-error-share', { value: ws.hookErrorWorkersPct, limit: lim, base: wb.hookErrorWorkersPct, n: bothN, minN: FL.workers, events: cnt(ws.hookErrorWorkersPct, wn), minEv: TH.hookErrorMinEv,
      over: ws.hookErrorWorkersPct != null && wb.hookErrorWorkersPct != null && ws.hookErrorWorkersPct - wb.hookErrorWorkersPct >= TH.hookErrorPp, unit: '%', detail: `vs ${wb.hookErrorWorkersPct}% before` });
  }
  for (const [sg, n] of Object.entries(m.hookSignatures.since)) {
    add(`hook-signature:${sg}`, { value: n, limit: TH.newSigWorkers, base: m.hookSignatures.base[sg] || 0, n: wn, minN: FL.workers, events: n, minEv: TH.newSigWorkers, over: !m.hookSignatures.base[sg], unit: 'workers', detail: 'new hook-error signature', level: +(n / spanH).toFixed(3) });
  }
  {
    const lim150 = Math.max(TH.over150Pct, wb.n >= FL.workers ? 1.5 * (wb.over150kPct || 0) : 0);
    add('context-over-150k', { value: ws.over150kPct, limit: +lim150.toFixed(1), base: wb.over150kPct, n: wn, minN: FL.workers, events: cnt(ws.over150kPct, wn), minEv: TH.over150MinEv, over: ws.over150kPct > lim150, unit: '%', detail: `p90 ${ws.peakCtxP90}, baseline ${wb.over150kPct}%` });
  }
  add('no-final-status', { value: ws.noStatusPct, limit: TH.noStatusPct, base: wb.noStatusPct, n: ws.finished, minN: TH.noStatusMinFinished, events: cnt(ws.noStatusPct, ws.finished), minEv: TH.noStatusMinEv,
    over: ws.noStatusPct > TH.noStatusPct || (wb.noStatusPct != null && ws.noStatusPct - wb.noStatusPct > TH.noStatusPp), unit: '%', detail: `vs ${wb.noStatusPct}% before` });
  add('partial-share', { value: ws.partialPct, limit: TH.partialPct, base: wb.partialPct, n: ws.finished, minN: TH.partialMinFinished, events: cnt(ws.partialPct, ws.finished), minEv: TH.partialMinEv, over: ws.partialPct > TH.partialPct, unit: '%' });
  add('blocked-share', { value: ws.blockedPct, limit: TH.blockedPct, base: wb.blockedPct, n: ws.finished, minN: TH.partialMinFinished, events: cnt(ws.blockedPct, ws.finished), minEv: TH.blockedMinEv, over: ws.blockedPct > TH.blockedPct, unit: '%' });
  add('api-errors', { value: ws.apiErrorWorkers, limit: TH.apiWorkers, base: wb.apiErrorWorkers ?? null, n: wn, minN: FL.workers, events: ws.apiErrorWorkers, minEv: 1,
    over: ws.apiNonUsageWorkers >= TH.apiNonUsage || ws.apiErrorWorkers >= TH.apiWorkers, unit: 'workers', detail: `${ws.apiNonUsageWorkers} non-usage-limit`, level: +(ws.apiErrorWorkers / spanH).toFixed(3) });
  {
    const lim = wb.n >= FL.workers ? TH.unitsFactor * wb.unitsPerWorker.mean : TH.unitsAbs;
    add('units-per-worker', { value: ws.unitsPerWorker.mean, limit: +lim.toFixed(2), base: wb.unitsPerWorker.mean, n: wn, minN: FL.workers, events: wn, minEv: TH.unitsMinEv, over: ws.unitsPerWorker.mean > lim, unit: 'units', detail: `mean, baseline ${wb.unitsPerWorker.mean}` });
    const bp = wb.unitsPerWorker.p90;
    add('units-p90', { value: ws.unitsPerWorker.p90, limit: bp ? +(TH.unitsFactor * bp).toFixed(2) : null, base: bp, n: bothN, minN: FL.workers, events: wn, minEv: TH.unitsMinEv, over: !!bp && ws.unitsPerWorker.p90 > TH.unitsFactor * bp, unit: 'units', detail: 'p90 per worker' });
  }
  const flags = metrics.filter((x) => x.status === 'flag').map((x) => ({ name: x.name, value: x.value, level: x.level, limit: x.limit, detail: x.detail, n: x.n, events: x.events, base: x.base }));
  const conclusive = sp.since >= FL.spawns && wn >= FL.workers && bs.n >= FL.bash;
  return { verdict: flags.length ? 'flag' : conclusive ? 'clean' : 'inconclusive', metrics, flags };
}

// ---------- run state v2 ----------
// release-watch-run.json: { v: 2, baseAnchor, status: 'watching'|'finished'|'insufficient-data', extendedTo, everFlagged, standing: { lastAt },
//   releases: [{ version, T, due[], done[], lastAt, lastConclusiveAt, verdicts[], status: 'watching'|'waiting-chain'|'finished'|'insufficient-data' }] }.
// A chain is the run of releases installed while the last one was still being watched: one baseline (the 7 days before the FIRST install,
// baseAnchor), one analysis per tick. A run file written before 0.31.64 (one release, no v) is read as a chain of one and written back on the next tick.
export function migrateRun(old) {
  if (!old || typeof old !== 'object') return null;
  if (old.v === 2 && Array.isArray(old.releases) && old.baseAnchor > 0) return old;
  if (!(old.T > 0) || !Array.isArray(old.due) || !Array.isArray(old.done)) return null;
  const status = old.closed ? 'finished' : 'watching';
  return { v: 2, baseAnchor: old.T, status, extendedTo: null, everFlagged: !!old.everFlagged, standing: { lastAt: null },
    releases: [{ version: old.version ?? null, T: old.T, due: old.due, done: old.done, lastAt: old.lastAt ?? null,
      lastConclusiveAt: 'lastConclusiveAt' in old ? (old.lastConclusiveAt ?? null) : (old.lastAt ?? null), verdicts: [], status }] };
}
const newestOf = (rs) => rs.releases.reduce((a, b) => (b.T > a.T ? b : a));
// The window a check measures starts at the last CONCLUSIVE check of any release of the chain (an inconclusive window rolls forward into the next one).
const chainWinFrom = (rs) => Math.max(0, ...rs.releases.map((r) => r.lastConclusiveAt || 0)) || rs.baseAnchor;
const iso = (t) => new Date(t).toISOString();
const D7 = 7 * 24 * HOUR;
const hoursOf = (r, i) => Math.round((r.due[i] - r.T) / HOUR);
const mrow = (x) => ({ name: x.name, value: x.value, limit: x.limit, base: x.base, n: x.n, events: x.events, status: x.status, unit: x.unit, hold: x.hold, ...(x.status === 'flag' && x.detail ? { detail: x.detail } : {}) });
// Per-version rows keep only what carries a signal: a conclusive metric with events or a flag, never the watch-health or noisy-by-nature ones.
const keepForVersion = (x) => x.status !== 'inconclusive' && (x.events > 0 || x.status === 'flag') && x.name !== 'usage-source-empty' && x.name !== 'queue-clears' && !x.name.startsWith('hook-signature:');

function checkRow({ at, rs, newest, lead, last, due, late, verdict, flags, evald, metrics, winFrom, byVersion }) {
  const row = { at: iso(at), event: 'check', T: iso(newest.T), chain: iso(rs.baseAnchor), version: newest.version, check: last + 1, label: `+${hoursOf(lead, last)}h`, covered: due.find((d) => d.r === lead).idx.map((i) => i + 1), late, verdict, flags,
    releases: due.map((d) => ({ version: d.r.version, covered: d.idx.map((i) => i + 1) })), window: { from: iso(winFrom), to: iso(at) } };
  if (byVersion) row.byVersion = byVersion;
  if (evald) row.metrics = evald.metrics.map(mrow);
  if (metrics && metrics.spawns) {
    row.sample = { spawns: metrics.spawns.since, workers: metrics.workers && metrics.workers.since && metrics.workers.since.n, bash: metrics.bash && metrics.bash.since && metrics.bash.since.n };
    row.baseline = { from: iso(metrics.span ? rs.baseAnchor - metrics.span.base * HOUR : rs.baseAnchor - D7), to: iso(rs.baseAnchor), spawns: metrics.spawns.base };
    try {
      const u = metrics.usage || usageOf(metrics);
      row.usage = { pctPerHour: { since: u.since.pctPerHour, base: u.base.pctPerHour }, pctWindow: +(u.since.pctPerHour * metrics.span.since).toFixed(3) };
    } catch { /* no usage block */ }
  } else if (metrics && metrics.error) row.error = metrics.error;
  return row;
}

// The finish rule (design 2.3), run once the newest release has all its checks done: the chain finishes together when the last verdict is
// clean, no flag is open and the activity since the newest install reached the floors; otherwise one more check is added 4 h later, up to 72 h
// after that install, and then the chain stops as insufficient-data (a flag that never holds).
export function finishFloors() {
  return { spawns: nOpt('release_watch_finish_spawns', 100), workers: nOpt('release_watch_finish_workers', 60), bash: nOpt('release_watch_finish_bash', 600), activeHours: nOpt('release_watch_finish_active_hours', 6) };
}
function finishStep({ rs, at, verdict, analyzeFn }) {
  const N = newestOf(rs);
  for (const r of rs.releases) if (r !== N && r.status === 'watching' && r.done.length >= r.due.length) r.status = 'waiting-chain';
  if (N.status !== 'watching' || N.done.length < N.due.length) return { event: null };
  const FL = finishFloors();
  let act = null;
  try {
    const fm = analyzeFn({ T: N.T, nowMs: at, baseFrom: rs.baseAnchor - D7, baseTo: rs.baseAnchor, winFrom: N.T });
    act = { spawns: fm.spawns.since, workers: fm.workers.since.n, bash: fm.bash.since.n, activeHours: fm.activeHours ? fm.activeHours.since : 0 };
  } catch { /* no activity read: not enough to finish */ }
  const met = !!act && act.spawns >= FL.spawns && act.workers >= FL.workers && act.bash >= FL.bash && act.activeHours >= FL.activeHours;
  // An answered flag does not block a finish: a conclusive clean check clears it first (clearAnswered). An unanswered open flag does.
  const f0 = S.readFlag(); const blocked = S.flagIsOpen(f0) && !f0.ackedAt;
  if (met && verdict === 'clean' && !blocked) {
    for (const r of rs.releases) r.status = 'finished';
    rs.status = 'finished';
    return { event: 'finished', act, FL, N };
  }
  // Why this check did not finish, kept for the closing text: the status must not blame the floors when they were reached.
  const why = !met ? 'floors' : blocked ? 'open-flag' : 'not-clean';
  const hours = nOpt('release_watch_extend_hours', 4) * HOUR; const cap = N.T + nOpt('release_watch_cap_hours', 72) * HOUR;
  const lastDue = N.due[N.due.length - 1];
  const newDue = lastDue + hours <= at ? at + hours : lastDue + hours;
  if (newDue <= cap) { N.due.push(newDue); rs.extendedTo = newDue; return { event: null, extendedTo: newDue }; }
  for (const r of rs.releases) r.status = 'insufficient-data';
  rs.status = 'insufficient-data'; rs.insufficientBecause = why;
  return { event: 'insufficient-data', act, FL, N, why };
}
// A human-acknowledged flag is cleared by the next conclusive clean check ("clean after ack"): the operator answered it and the release has since
// measured clean, so it must not hold the chain open to the cap. An unanswered flag stays open (it still blocks the finish and the hold path).
// The hold, if one is on, is never touched here: only the operator's clear lifts it.
function clearAnswered(P, at) {
  try {
    const f = S.readFlag();
    if (!S.flagIsOpen(f) || !f.ackedAt || Date.parse(f.ackedAt) > at) return false;
    S.writeJson(P.flag, { ...f, clearedAt: iso(at), clearedBy: 'v2-watch', clearedReason: 'clean after ack' });
    S.appendRow({ at: iso(at), event: 'flag-cleared', version: f.version ?? null, flags: f.flags.map((x) => x.name), reason: 'clean after ack', ackedAt: f.ackedAt });
    return true;
  } catch { return false; }
}
const lackText = (act, FL) => (act
  ? [['spawns', act.spawns, FL.spawns], ['workers', act.workers, FL.workers], ['Bash calls', act.bash, FL.bash], ['active hours', act.activeHours, FL.activeHours]].map(([k, a, f]) => `${k} ${a}/${f}${a >= f ? '' : ' short'}`).join(', ')
  : 'activity could not be read');

function chainChecks({ rs, P, at, analyzeFn, res }) {
  if (rs.status !== 'watching') return;
  const due = rs.releases.filter((r) => r.status === 'watching').map((r) => ({ r, idx: dueIndexes(r, at) })).filter((x) => x.idx.length);
  if (!due.length) return;
  const lead = due.reduce((a, b) => (b.r.T > a.r.T ? b : a)).r;
  const last = Math.max(...due.find((d) => d.r === lead).idx);
  const newest = newestOf(rs);
  const winFrom = chainWinFrom(rs);
  const split = rs.releases.length >= 2;
  let metrics = null; let evald = { verdict: 'inconclusive', metrics: [], flags: [] };
  const verOf = {}; let byVersion = null;
  try {
    // Window = since the last conclusive check (a rate per window); baseline = always the 7 days before the chain's FIRST install.
    metrics = analyzeFn({ T: newest.T, nowMs: at, baseFrom: rs.baseAnchor - D7, baseTo: rs.baseAnchor, winFrom, ...(split ? { releases: rs.releases.map((r) => ({ version: r.version, T: r.T })) } : {}) });
    evald = evaluate(metrics);
    if (split && metrics && metrics.byVersion) {
      byVersion = {};
      for (const [v, m] of Object.entries(metrics.byVersion)) {
        const e = evaluate(m);
        byVersion[v] = { verdict: e.verdict, metrics: e.metrics.filter(keepForVersion).map(mrow) };
        for (const x of e.metrics) if (x.status !== 'inconclusive') (verOf[x.name] ??= {})[v] = x.value;
      }
    }
  } catch (e) { evald = { verdict: 'inconclusive', metrics: [], flags: [] }; metrics = { error: String(e && e.message || e) }; byVersion = null; }
  const flags = evald.flags.map((f) => (verOf[f.name] ? { ...f, versions: verOf[f.name] } : f)); const verdict = evald.verdict;
  const late = at - lead.due[last] > LATE_MS;
  for (const { r, idx } of due) {
    r.done = [...r.done, ...idx]; r.lastAt = at;
    r.lastConclusiveAt = verdict === 'inconclusive' ? (r.lastConclusiveAt ?? null) : at;
    (r.verdicts ??= []).push({ at: iso(at), check: Math.max(...idx) + 1, verdict });
  }
  rs.everFlagged = !!rs.everFlagged || flags.length > 0;
  if (verdict === 'clean') { const c = clearAnswered(P, at); if (c) res.flagCleared = true; }
  const fin = finishStep({ rs, at, verdict, analyzeFn });
  S.writeJson(P.run, rs);
  const row = checkRow({ at, rs, newest, lead, last, due, late, verdict, flags, evald, metrics, winFrom, byVersion });
  if (fin.extendedTo) row.extendedTo = iso(fin.extendedTo);
  S.appendRow(row);
  res.ran = true; res.checks = due.find((d) => d.r === lead).idx.map((i) => i + 1); res.flagged = flags.map((x) => x.name); res.verdict = verdict;
  if (flags.length) S.openFlag({ version: newest.version, T: iso(rs.baseAnchor), check: row.label, flags, at });
  if (fin.event === 'finished') {
    S.appendRow({ at: iso(at), event: 'finished', T: iso(fin.N.T), chain: iso(rs.baseAnchor), version: fin.N.version, releases: rs.releases.map((r) => r.version), activity: fin.act });
  } else if (fin.event === 'insufficient-data') {
    S.appendRow({ at: iso(at), event: 'insufficient-data', T: iso(fin.N.T), chain: iso(rs.baseAnchor), version: fin.N.version, activity: fin.act, floors: fin.FL });
    const detail = `no finish by +${Math.round((at - fin.N.T) / HOUR)}h: ${fin.why === 'floors' ? lackText(fin.act, fin.FL) : fin.why === 'open-flag' ? 'the activity floors were reached, an unanswered flag blocked the finish' : 'the activity floors were reached, the last check was not clean'}`;
    if (!S.flagIsOpen(S.readFlag())) S.openFlag({ version: newest.version, T: iso(rs.baseAnchor), check: `+${Math.round((at - fin.N.T) / HOUR)}h`, at,
      flags: [{ name: 'insufficient-data', value: 0, level: 0, limit: 0, detail, n: fin.act ? fin.act.spawns : 0, events: 1, base: null }] });
  }
}

// ---------- standing health (design 2.4) ----------
// A daily look at the last 7 days against fixed ceilings and against the 28 days before them, independent of any release. It REPORTS only:
// it writes the standing file and a 'standing' row, never the flag, the hold or the chain. Floors are event counts (bash, refusals, denials)
// or denominators (workers, finished workers), as the spec lists them.
const STANDING_CEILINGS = { 'queue-denied': 5, 'worker-bash-fail': 5, 'harness-refusals': 3, 'hook-error-share': 50, 'no-final-status': 15, 'partial-share': 30, 'units-per-worker': 1.9, 'worker-usage': 25 };
const STANDING_TREND = 1.5; const STANDING_MIN_EV = 20; const STANDING_HISTORY_DAYS = 14;
export function standingDue(rs, at = S.now()) {
  if (!opt('release_watch_standing', true)) return false;
  const f = S.readJson(S.paths().standing);
  const rl = rs && rs.standing && rs.standing.lastAt;
  const last = Math.max(0, typeof rl === 'number' ? rl : Date.parse(rl) || 0, f && Date.parse(f.at) || 0);
  return at - last >= nOpt('release_watch_standing_hours', 24) * HOUR;
}
export function standing({ at = S.now(), run = analyze } = {}) {
  try {
    const m = run({ T: at - D7, winFrom: at - D7, baseFrom: at - 5 * D7, nowMs: at, sample: 300 });
    if (!m || !m.spawns || !m.workers) return null;
    const cnt = (p, n) => Math.round((p || 0) * (n || 0) / 100);
    const ws = m.workers.since; const wb = m.workers.base || {};
    const bs = (m.bash && m.bash.since) || {}; const bb = (m.bash && m.bash.base) || {};
    const qd = evaluate(m).metrics.find((x) => x.name === 'queue-denied');
    let usage = null; try { usage = usageOf(m); } catch { /* no usage block */ }
    const rows = [
      { name: 'queue-denied', value: qd && qd.value, ok: qd && qd.events >= STANDING_MIN_EV, events: qd ? qd.events : 0, prior: qd && qd.base, priorEvents: qd && qd.base != null ? Math.round(qd.base * (m.spawns.base || 0) / 100) : 0, unit: '/100 spawns', detail: qd && qd.detail },
      { name: 'worker-bash-fail', value: bs.realFailPct, ok: bs.realFails >= 50, events: bs.realFails || 0, prior: bb.realFailPct, priorEvents: bb.realFails || 0, unit: '%' },
      { name: 'harness-refusals', value: bs.refusalPer100, ok: bs.refusals >= 50, events: bs.refusals || 0, prior: bb.refusalPer100, priorEvents: bb.refusals || 0, unit: '/100 bash' },
      { name: 'hook-error-share', value: ws.hookErrorWorkersPct, ok: ws.n >= 30, events: cnt(ws.hookErrorWorkersPct, ws.n), prior: wb.hookErrorWorkersPct, priorEvents: cnt(wb.hookErrorWorkersPct, wb.n), unit: '%' },
      { name: 'no-final-status', value: ws.noStatusPct, ok: ws.finished >= 30, events: cnt(ws.noStatusPct, ws.finished), prior: wb.noStatusPct, priorEvents: cnt(wb.noStatusPct, wb.finished), unit: '%' },
      { name: 'partial-share', value: ws.partialPct, ok: ws.finished >= 30, events: cnt(ws.partialPct, ws.finished), prior: wb.partialPct, priorEvents: cnt(wb.partialPct, wb.finished), unit: '%' },
      { name: 'units-per-worker', value: ws.unitsPerWorker && ws.unitsPerWorker.mean, ok: ws.n >= 30, events: ws.n || 0, prior: wb.unitsPerWorker && wb.unitsPerWorker.mean, priorEvents: wb.n || 0, unit: 'units' },
      { name: 'worker-usage', value: usage && +(usage.since.pctPerHour * 24).toFixed(1), ok: ws.n >= 30, events: ws.n || 0, prior: usage && +(usage.base.pctPerHour * 24).toFixed(1), priorEvents: wb.n || 0, unit: '%/day' },
    ];
    const shortHistory = !(m.activeDays && m.activeDays.base >= STANDING_HISTORY_DAYS);
    const findings = [];
    for (const r of rows) {
      if (typeof r.value !== 'number') continue;
      const ceiling = STANDING_CEILINGS[r.name];
      if (r.ok && r.value > ceiling) findings.push({ name: r.name, kind: 'ceiling', value: r.value, ceiling, events: r.events, unit: r.unit, ...(r.detail ? { detail: r.detail } : {}) });
      else if (!shortHistory && r.events >= STANDING_MIN_EV && r.priorEvents >= STANDING_MIN_EV && typeof r.prior === 'number' && r.prior > 0 && r.value > STANDING_TREND * r.prior) {
        findings.push({ name: r.name, kind: 'trend', value: r.value, prior: r.prior, events: r.events, unit: r.unit });
      }
    }
    const trend = shortHistory ? 'inconclusive (history short)' : 'judged';
    const verdict = findings.length ? 'findings' : shortHistory ? 'inconclusive' : 'ok';
    const text = (x) => `${x.name} ${x.value}${x.unit ? ' ' + x.unit : ''} (${x.kind === 'ceiling' ? `ceiling ${x.ceiling}` : `was ${x.prior}`})`;
    const out = { at: iso(at), verdict, trend, findings: findings.map((x) => ({ ...x, detail: text(x) })), workers: { n: ws.n, finished: ws.finished, excluded: ws.excluded || null }, shownOn: null };
    S.writeJson(S.paths().standing, out);
    S.appendRow({ at: out.at, event: 'standing', verdict, trend, findings: out.findings });
    return out;
  } catch { return null; }
}

// ---------- legacy flag migration (once, at tick start) ----------
// A flag opened before v2 has no `v`. The question for each item is: would v2 have raised it? Two steps answer it.
//  1. Re-run the v2 analysis and evaluation over the flag's own window (install time T to the check that raised it; baseline = the 7 days before T,
//     the one v1 used). That is the exact answer, and it handles metrics whose v1 value mixed in harness refusals (worker-bash-fail). It counts only
//     when the re-run found activity (at least half the spawns the v1 check row recorded): telemetry that has since rotated away is no answer.
//  2. Otherwise the stored v1 shapes give the sample size n. v1 items are {name, value, level, limit, detail} with no n; v1 check rows carry
//     metrics: {spawns: {since}, workers: {since: {n}}}. The spawns class reads metrics.spawns.since (or "per N spawns" in the detail), the
//     workers class metrics.workers.since.n, the Bash class the "n=N" in the detail. Below the v2 floor of its class the item would not flag now.
// All items below -> the flag is closed as "superseded by v2 evidence rules" (the ack stays, no countdown). Some still flag -> those stay; a
// non-human ack on them is revoked and the countdown restarts, unless a typed record in the lead transcripts sits at the ack time.
// An item whose sample size is unknown, or whose name is in no class, is kept. A hold is never touched.
const SPAWN_CLASS = /^(guard:|spawn-rewrites$|queue-denied$|handoff-|struggle$|polling-waste$|runaway$)/;
const WORKER_CLASS = /^(hook-error-share$|hook-signature:|context-over-150k$|api-errors$|units-|no-final-status$|partial-share$|blocked-share$)/;
const BASH_CLASS = /^(worker-bash-fail$|harness-refusals$)/;
const classOf = (name) => (SPAWN_CLASS.test(name) ? 'spawns' : WORKER_CLASS.test(name) ? 'workers' : BASH_CLASS.test(name) ? 'bash' : null);
// The sample size of a v1 item, from the shapes v1 really wrote (never from an `n` on the item: v1 wrote none).
function storedN(item, row, cls) {
  const det = String(item && item.detail || ''); const m = row && row.metrics;
  if (cls === 'spawns') {
    const v = m && m.spawns && m.spawns.since; if (typeof v === 'number') return v;
    const d = /per (\d+) spawns/.exec(det); return d ? +d[1] : null;
  }
  if (cls === 'workers') { const v = m && m.workers && m.workers.since && m.workers.since.n; return typeof v === 'number' ? v : null; }
  const d = /\bn=(\d+)/.exec(det); return d ? +d[1] : null;
}
export function legacyStillFlags(item, row, FL = floors()) {
  const cls = classOf(String(item && item.name || ''));
  if (!cls) return true;
  const n = storedN(item, row, cls);
  return n == null ? true : n >= FL[cls];
}
export function migrateFlag({ at = S.now(), projectsDir, run = analyze } = {}) {
  try {
    const f = S.readFlag();
    if (!S.flagIsOpen(f) || f.v != null) return null;
    const FL = floors();
    const fT = Date.parse(f.T); const openedAt = Date.parse(f.openedAt) || null;
    const checks = S.readRows().filter((r) => r.event === 'check' && (Date.parse(r.chain) === fT || Date.parse(r.T) === fT));
    // The check row that raised an item: the latest one carrying the same name and value (items can come from different checks of one flag).
    const rowOf = (x) => checks.filter((r) => Array.isArray(r.flags) && r.flags.some((y) => y.name === x.name && y.value === x.value)).pop()
      || checks.filter((r) => openedAt == null || Date.parse(r.at) <= openedAt + 60e3).pop() || null;
    const evals = new Map();
    const reanalyzed = (x, row) => {
      const raisedAt = row ? Date.parse(row.at) : openedAt;
      if (!(raisedAt > fT)) return null;
      if (!evals.has(raisedAt)) {
        let ev = null;
        try {
          const m = run({ T: fT, nowMs: raisedAt, winFrom: fT, baseFrom: fT - D7, baseTo: fT });
          const got = m && m.spawns && m.spawns.since; const had = row && row.metrics && row.metrics.spawns && row.metrics.spawns.since;
          if (m && m.workers && typeof got === 'number' && got > 0 && !(typeof had === 'number' && got < had / 2)) ev = evaluate(m);
        } catch { /* no re-run: the stored shapes decide */ }
        evals.set(raisedAt, ev);
      }
      const ev = evals.get(raisedAt); const mt = ev && ev.metrics.find((y) => y.name === x.name);
      return mt ? mt.status === 'flag' : null;
    };
    const kept = f.flags.filter((x) => { const row = rowOf(x); const re = reanalyzed(x, row); return re != null ? re : legacyStillFlags(x, row, FL); });
    if (!kept.length) {
      S.writeJson(S.paths().flag, { ...f, v: 2, clearedAt: iso(at), clearedBy: 'v2-migration', supersededReason: 'superseded by v2 evidence rules' });
      S.appendRow({ at: iso(at), event: 'flag-superseded', version: f.version ?? null, flags: f.flags.map((x) => x.name), reason: 'superseded by v2 evidence rules', ackKept: !!f.ackedAt });
      return { superseded: true };
    }
    const next = { ...f, v: 2, flags: kept };
    let out = { kept: kept.map((x) => x.name) };
    if (f.ackedAt && !f.ack) {
      const ackAt = Date.parse(f.ackedAt);
      const hit = S.findHumanRecordNear({ projectsDir: projectsDir || join(claudeDir(), 'projects'), since: Date.parse(f.notifiedAt) || 0, near: ackAt });
      if (hit) next.ack = { session: hit.session, promptAt: f.ackedAt, confirmedAt: iso(at), signal: S.HUMAN_SIGNAL.transcript, shownAt: (f.shownTo || {})[hit.session] ?? null };
      else {
        next.ackedAt = null; next.ack = null; next.notifiedAt = iso(at); next.candidates = [];
        S.appendRow({ at: iso(at), event: 'ack-revoked', version: f.version ?? null, reason: 'legacy ack without human record' });
        out = { ...out, revoked: true };
      }
    }
    S.writeJson(S.paths().flag, next);
    return out;
  } catch { return null; }
}

export function tick({ at = S.now(), installed, holdMinutes, run: analyzeFn = analyze, standingRun = analyze } = {}) {
  const res = { ran: false, checks: [], flagged: [], held: false, installed: false, verdict: null };
  try {
    const P = S.paths();
    const mig = migrateFlag({ at, run: analyzeFn });
    if (mig) res.migrated = mig;
    // Standing health: independent of any install, reports only (never the flag, the hold or the chain).
    try {
      const rs0 = migrateRun(S.readJson(P.run));
      if (standingDue(rs0, at)) {
        const st = standing({ at, run: standingRun });
        if (st) { res.standing = st.verdict; if (rs0) S.writeJson(P.run, { ...rs0, standing: { lastAt: at } }); }
      }
    } catch { /* reporting only */ }
    if (!installed) installed = S.readJson(join(claudeDir(), 'plugins', 'installed_plugins.json'));
    const inst = newestInstall(installed);
    if (!inst) return res;
    res.installed = true;
    const raw = S.readJson(P.run);
    let rs = migrateRun(raw);
    if (!rs || !rs.releases.some((r) => r.T === inst.T)) {
      const rel = buildSchedule(inst.T, inst.version);
      // An install while the chain is still being watched joins it (same baseline); after a finish it starts a new chain.
      if (rs && rs.status === 'watching') rs.releases.push(rel);
      else rs = { v: 2, baseAnchor: inst.T, status: 'watching', extendedTo: null, everFlagged: false, standing: (rs && rs.standing) || { lastAt: null }, releases: [rel] };
      S.writeJson(P.run, rs);
    } else if (!raw || raw.v !== 2) S.writeJson(P.run, rs);
    chainChecks({ rs, P, at, analyzeFn, res });
    const hm = holdMinutes ?? opt('release_watch_hold_minutes', 30);
    res.held = !!S.maybeHold({ holdMinutes: hm, at });
  } catch { /* never throws */ }
  return res;
}

// ---------- status ----------
const f1 = (x) => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : x == null ? '-' : String(x));
const hhmm = (t) => iso(t).slice(11, 16) + 'Z';
const metricLine = (x) => {
  const why = x.status === 'inconclusive' ? 'INCONCLUSIVE (n<min)' : x.status === 'flag' ? 'FLAG' : 'ok';
  return `       ${String(x.name).padEnd(20)} ${f1(x.value)}${x.unit && x.unit !== 'flag' ? ' ' + x.unit : ''}  limit ${f1(x.limit)}  base ${f1(x.base)}  n=${x.n} ev=${x.events}  ${why}`;
};
const checkRows = (anchor) => S.readRows().filter((r) => r.event === 'check' && (anchor == null || Date.parse(r.chain || r.T) === anchor));
const verdictWord = (r) => String(r.verdict || (r.flags && r.flags.length ? 'flag' : 'clean')).toUpperCase();

export function status(at = S.now(), { all = false, json = false } = {}) {
  const rs = migrateRun(S.readJson(S.paths().run)); const flag = S.readFlag(); const hold = S.readHold();
  const rows = rs ? checkRows(rs.baseAnchor) : [];
  const standing = S.readJson(S.paths().standing);
  if (json) return JSON.stringify({ run: rs, checks: rows.slice(-20), flag: S.flagIsOpen(flag) ? flag : null, hold: hold && !hold.clearedAt ? hold : null, standing: standing || null }, null, 1);
  const lines = [];
  if (!rs) lines.push('no watch armed (no tick has seen an install yet)');
  else {
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.baseline) lines.push(`chain base ${lastRow.baseline.from.slice(0, 16)}Z..${lastRow.baseline.to.slice(0, 16)}Z (7 d, ${lastRow.baseline.spawns} spawns)`);
    for (const r of rs.releases) {
      const nextI = r.due.findIndex((d, i) => !r.done.includes(i));
      const state = r.status === 'finished' ? 'closed' + (rs.everFlagged ? ', flags were raised' : ', clean')
        : r.status === 'insufficient-data' ? (rs.insufficientBecause === 'open-flag' ? 'closed without finishing: an unanswered flag was still open at the cap (the activity floors were reached)'
          : rs.insufficientBecause === 'not-clean' ? 'closed without finishing: the last check was not clean (the activity floors were reached)'
            : 'closed, insufficient data (the activity floors were not reached in time)')
          : r.status === 'waiting-chain' ? 'checks done, waiting for the newer release of its chain to finish'
            : nextI < 0 ? 'watching (all checks done, no clean verdict yet)' : `watching (check ${nextI + 1} of ${r.due.length} next at ${iso(r.due[nextI]).slice(0, 16)}Z)`;
      lines.push(`release ${r.version || '?'} installed ${iso(r.T)}: ${state}`);
    }
    for (const r of rows) {
      const s = r.sample || {}; const u = r.usage;
      const us = u ? `  usage ${f1(u.pctPerHour.since)} %/h (base ${f1(u.pctPerHour.base)}), ${(+u.pctWindow).toFixed(2)} % window` : '';
      lines.push(`  ${r.label || `+${CHECK_HOURS[r.check - 1] ?? '?'}h`}  ${hhmm(Date.parse(r.at))}  ${verdictWord(r).padEnd(12)} spawns ${s.spawns ?? '-'}  workers ${s.workers ?? '-'}  bash ${s.bash ?? '-'}${us}${r.late ? '  (late)' : ''}`);
      // A v1 check row carries `metrics` as the old analysis object, not the v2 metric rows: it has no rows to print.
      for (const x of (Array.isArray(r.metrics) ? r.metrics : []).filter((y) => all || y.status !== 'ok' || y.events > 0)) lines.push(metricLine(x));
      for (const [v, b] of Object.entries(r.byVersion || {})) {
        const sig = (b.metrics || []).filter((y) => y.status === 'flag');
        lines.push(`     ${v}: ${String(b.verdict).toUpperCase()}${sig.length ? ' ' + sig.map((y) => `${y.name}=${f1(y.value)}`).join(', ') : ''}`);
      }
    }
  }
  if (S.flagIsOpen(flag)) {
    const a = flag.ack;
    const who = flag.ackedAt ? `answered ${flag.ackedAt}${a ? ` in session ${String(a.session || '').slice(0, 8)} (signal ${a.signal}, shown ${a.shownAt || '?'})` : ''}`
      : `unanswered${(() => { const d = Number(opt('release_watch_hold_minutes', 30)); const n = Date.parse(flag.notifiedAt); return d > 0 && n > 0 ? `, hold at ${iso(n + d * 60e3)}` : ''; })()}`;
    lines.push(`flag open since ${flag.openedAt}, notified ${flag.notifiedAt}, ${who}: ${flag.flags.map((x) => `${x.name}=${x.value}${x.detail ? ' (' + x.detail + ')' : ''}`).join('; ')}`);
  } else lines.push('no open flag');
  lines.push(hold && !hold.clearedAt ? `HOLD since ${hold.since}: ${hold.reason}` : 'hold: none');
  if (hold && !hold.clearedAt && flag && flag.clearedBy === 'v2-migration') lines.push('the hold stays for the operator: its flag was closed as superseded by v2 evidence rules, and a hold is never lifted by the migration (run: release-watch.mjs clear)');
  if (standing && standing.verdict) lines.push(`standing: ${standing.at || ''} ${standing.verdict} ${(standing.findings || []).map((x) => (typeof x === 'string' ? x : x.detail || x.name)).join('; ')}`.trim());
  return lines.join('\n');
}

function argOf(A, n) { const i = A.indexOf(n); return i >= 0 ? A[i + 1] : undefined; }

export function main(A = process.argv.slice(2)) {
  const cmd = A[0];
  try {
    if (cmd === 'tick') { const r = tick(); if (A.includes('--json')) console.log(JSON.stringify(r)); return 0; }
    if (cmd === 'status') { console.log(status(S.now(), { all: A.includes('--all'), json: A.includes('--json') })); return 0; }
    if (cmd === 'clear') { const r = S.clear({ by: argOf(A, '--by') || 'operator' }); console.log(r.flagCleared || r.holdCleared ? `cleared (flag ${r.flagCleared}, hold ${r.holdCleared})` : 'nothing to clear'); return 0; }
    if (cmd === 'check') {
      const T = Date.parse(argOf(A, '--since')); if (!(T > 0)) { console.error('check needs --since <ISO>'); return 2; }
      const bf = argOf(A, '--base-from');
      const m = analyze({ T, baseFrom: bf ? Date.parse(bf) : undefined, days: Number(argOf(A, '--days')) || 7, sample: Number(argOf(A, '--sample')) || 500 });
      const e = evaluate(m);
      const verdict = e.verdict === 'flag' ? `FLAG ${e.flags.map((x) => x.name).join(', ')}` : e.verdict;
      console.log(JSON.stringify({ ...m, verdict, flags: e.flags, metrics: e.metrics }, null, 1)); return 0;
    }
    console.error('usage: release-watch.mjs tick | status [--all] [--json] | clear [--by <who>] | check --since <ISO> [--base-from <ISO>] [--days N] [--sample N]');
    return 2;
  } catch (e) { console.error(String(e && e.message || e)); return cmd === 'tick' ? 0 : 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
