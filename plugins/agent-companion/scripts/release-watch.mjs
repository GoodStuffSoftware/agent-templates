#!/usr/bin/env node
// Post-release watch. Read-only against telemetry and transcripts, no network, no model call.
//
//   release-watch.mjs tick                    run the checks that are due (a local-services job runs this every 10 min);
//                                             also writes the hold when a flag went unanswered. Exits 0 always.
//   release-watch.mjs status                  print the schedule, the flag and the hold
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

export function buildSchedule(T, version, prev) {
  return { T, version, prevT: prev && prev.T !== T ? prev.T : prev?.prevT ?? null, due: CHECK_HOURS.map((h) => T + h * HOUR), done: [], closed: false };
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

// T: the install time; the baseline is always the `days` days before it. winFrom: start of the window measured now (default T;
// the tick passes the previous check's time, so each check is a rate over its own window, not a running count since install).
export function analyze({ T, nowMs = S.now(), winFrom, baseFrom, days = 7, sample = 500, telDir, projectsDir, clearsFiles, holds } = {}) {
  const root = stateRootPath();
  telDir = telDir || join(dataRoot(), 'telemetry');
  projectsDir = projectsDir || join(claudeDir(), 'projects');
  // The machine-wide queue data (LOCALAPPDATA) is read unless this is a sandboxed test process (isolate.mjs sets the home override); a scratch state dir does not hide it.
  clearsFiles = clearsFiles || [...new Set([process.env.CI_BUDGET_DIR && join(process.env.CI_BUDGET_DIR, 'clears.jsonl'), join(dataRoot(), 'ci-budget', 'clears.jsonl'), join(root, 'ci-budget', 'clears.jsonl'),
    !process.env.AGENT_COMPANION_HOME_OVERRIDE && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ci-budget', 'clears.jsonl')].filter(Boolean).map((p) => p.replace(/\\/g, '/')))];
  const B0 = baseFrom > 0 ? baseFrom : T - days * 24 * HOUR;
  const W0 = winFrom > 0 ? Math.max(winFrom, T) : T;
  // What the hold itself caused (denials, refusals, anything logged while it was on) never counts toward a signal.
  const holdIv = holds || S.holdIntervals(nowMs);
  const inHold = (t) => holdIv.some(([a, b]) => t >= a && t <= b);
  const rd = (f) => jsonl(join(telDir, f + '.jsonl'));
  const ts = (r) => (typeof r.at === 'number' ? r.at : Date.parse(r.at || r.ts || 0));
  const win = (r) => { const t = ts(r); if (inHold(t)) return null; return t >= W0 && t <= nowMs ? 'since' : t >= B0 && t < T ? 'base' : null; };
  const N = { since: 0, base: 0 };
  for (const r of rd('spawns')) { const w = win(r); if (w) N[w]++; }
  const span = { since: Math.max((nowMs - W0) / HOUR, 1e-3), base: Math.max((T - B0) / HOUR, 1e-3) };
  const out = { T: new Date(T).toISOString(), now: new Date(nowMs).toISOString(), spawns: { ...N, perHour: { since: +(N.since / span.since).toFixed(1), base: +(N.base / span.base).toFixed(1) } }, telemetry: {}, span };
  const count = (file, keyf, filt = () => true) => {
    const c = {};
    for (const r of rd(file)) { const w = win(r); if (!w || !filt(r)) continue; const k = keyf(r); (c[k] ??= { since: 0, base: 0 })[w]++; }
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
    const c = count('bash-exit', (r) => (r.failed ? 'fail' : 'ok'), (r) => r.caller_is_subagent);
    const f = c.fail || { since: 0, base: 0 }; const o = c.ok || { since: 0, base: 0 };
    out.bash = { since: { n: f.since + o.since, failPct: per(f.since, f.since + o.since) }, base: { n: f.base + o.base, failPct: per(f.base, f.base + o.base) } };
  }
  {
    const c = { since: 0, base: 0 };
    for (const f of clearsFiles) for (const r of jsonl(f)) { if (!isFailureClear(r)) continue; const w = win(r); if (w) c[w]++; }
    out.queueClears = { since: c.since, base: c.base, perHour: { since: +(c.since / span.since).toFixed(2), base: +(c.base / span.base).toFixed(2) } };
  }
  // ---- worker transcripts ----
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
  const pick = [...fresh.slice(0, 2000).map((f) => f.fp), ...old.filter((_, i) => i % step === 0).map((f) => f.fp)];
  const seen = new Set(); const W = { since: [], base: [] }; const sig = { since: {}, base: {} };
  for (const fp of pick) {
    let L; try { L = readFileSync(fp, 'utf8').split('\n'); } catch { continue; }
    let first = null; let u = 0; let peak = 0; let hook = 0; let terr = 0; let api = null; let txt = '';
    for (const l of L) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.timestamp && !first) first = Date.parse(o.timestamp);
      const c = o.message?.content;
      if (o.type === 'assistant' && o.message?.usage && o.message.model !== '<synthetic>') {
        const k = o.requestId || o.message.id || o.uuid;
        if (!seen.has(k)) {
          seen.add(k); const us = o.message.usage; u += units(us, o.message.model || '');
          peak = Math.max(peak, (us.input_tokens || 0) + (us.cache_read_input_tokens || 0) + (us.cache_creation_input_tokens || 0));
        }
      }
      if (o.isApiErrorMessage) api = o.apiError || 'api';
      if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'text' && o.type === 'assistant') txt = b.text;
        if (b.type === 'tool_result' && b.is_error) {
          terr++; const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          const m = /^(PreToolUse:[\w:]+) hook error: (.{0,48})/.exec(t);
          if (m && !/post-release hold/i.test(t) && !inHold(Date.parse(o.timestamp))) { hook++; const w = first >= W0 ? 'since' : first < T ? 'base' : null; const k = `${m[1]} ${m[2]}`; if (w) sig[w][k] = (sig[w][k] || 0) + 1; }
        }
      }
    }
    if (!first || first < B0 || first > nowMs) continue;
    const w = first >= W0 ? 'since' : first < T ? 'base' : null;
    if (!w || inHold(first)) continue;
    const st = /STATUS:\s*(done|partial|blocked)/i.exec(txt);
    let fin = false; try { fin = JSON.parse(readFileSync(fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')).finished === true; } catch { /* none */ }
    W[w].push({ u, peak, hook, terr, api, status: st ? st[1].toLowerCase() : (fin ? 'none' : 'running') });
  }
  out.workers = {};
  for (const w of ['since', 'base']) {
    const a = W[w]; const fin = a.filter((x) => x.status !== 'running');
    out.workers[w] = {
      n: a.length, finished: fin.length,
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

// ---------- thresholds (design section 1) ----------
export const TH = {
  minSpawns: 10, minWorkers: 10, guardFactor: 2, guardMinN: 10, newGuardMin: 3,
  rewritePer100: 3, hookErrorPp: 15, newSigWorkers: 5, over150Pct: 5, handoffHardPer100: 2, handoffEndBlockPer100: 10,
  noStatusPct: 15, noStatusMinFinished: 30, noStatusPp: 10, partialPct: 35, blockedPct: 6, finMin: 10,
  bashFailPct: 7, bashMinN: 20, gateDeniedPer100: 20, clearsFactor: 2, clearsMin: 10, apiWorkers: 3, newGuardPer100: 10,
  struggle100: 2, unitsFactor: 1.5, unitsAbs: 1.9, pollDeny100: 18,
};
const REWRITE_GUARDS = new Set(['fit', 'inherit', 'type-required', 'routing-autofix']);

// opts.first: the first check of an install. A guard key that has no baseline hits is then not flagged as new: the release itself may have introduced it.
export function evaluate(m, opts = {}) {
  // level: the rate the flag is judged on later (per hour, per 100 spawns, a share). A count flag carries count / window hours.
  const flags = []; const f = (name, value, limit, detail, level = value) => flags.push({ name, value, level, limit, detail });
  if (!m) return flags;
  const sp = m.spawns; const ws = m.workers.since; const wb = m.workers.base;
  {
    // The token-bleed half of the watch has nothing to judge when the usage source is empty: that is an error, never a quiet "clean".
    const us = usageOf(m);
    const bad = us.base.empty ? ['baseline', us.base] : sp.since >= TH.minSpawns && us.since.empty ? ['window', us.since] : null;
    if (bad) f('usage-source-empty', 0, 0, `usage source empty (${bad[0]}: ${bad[1].why.join(', ') || 'zero units'}), the usage metric measured nothing`, 0);
  }
  const enough = sp.since >= TH.minSpawns; const wEnough = ws.n >= TH.minWorkers;
  const tel = Object.entries(m.telemetry);
  if (enough) {
    for (const [k, v] of tel) {
      if (!k.startsWith('denial:') || !k.endsWith('/deny')) continue; // only deny outcomes count; warn, autofix and rewrite rows never flag
      const guard = k.slice(7).split('/')[0];
      if (REWRITE_GUARDS.has(guard)) continue;
      if (guard === 'delegation') {
        const hs = v.since / m.span.since; const hb = v.base / m.span.base;
        if (v.since >= TH.guardMinN && hb > 0 && hs > TH.guardFactor * hb) f(`guard:${k.slice(7)}`, +hs.toFixed(1), +(TH.guardFactor * hb).toFixed(1), `per hour ${hs.toFixed(1)} vs ${hb.toFixed(1)}`);
        continue;
      }
      const ps = v.per100spawns.since; const pb = v.per100spawns.base;
      // A key with no baseline hits flags on its deny rate per 100 spawns over a floor, never on mere presence.
      if (v.base === 0) { if (v.since >= TH.newGuardMin && ps > TH.newGuardPer100) f(`guard:${k.slice(7)}`, ps, TH.newGuardPer100, `new guard, ${v.since} hits, ${ps}/100 spawns`); }
      else if (v.since >= TH.guardMinN && pb > 0 && ps > TH.guardFactor * pb) f(`guard:${k.slice(7)}`, ps, +(TH.guardFactor * pb).toFixed(1), `${ps}/100 spawns vs ${pb}`);
    }
    const rw = tel.filter(([k]) => k.startsWith('denial:') && k.endsWith('/deny') && REWRITE_GUARDS.has(k.slice(7).split('/')[0])).reduce((s, [, v]) => s + v.since, 0);
    const rw100 = per(rw, sp.since);
    if (rw100 > TH.rewritePer100) f('spawn-rewrites', rw100, TH.rewritePer100, `${rw} rewrites/denials per ${sp.since} spawns`);
    const gd = tel.filter(([k]) => k.startsWith('gate:') && /denied/.test(k)).reduce((s, [, v]) => s + v.since, 0);
    const gd100 = per(gd, sp.since);
    if (gd100 > TH.gateDeniedPer100) f('queue-denied', gd100, TH.gateDeniedPer100, `${gd} denied`);
    const hard = tel.filter(([k]) => /^handoff:hard\/deny$/.test(k)).reduce((s, [, v]) => s + v.since, 0);
    if (per(hard, sp.since) > TH.handoffHardPer100) f('handoff-hard-deny', per(hard, sp.since), TH.handoffHardPer100, `${hard} hard denials`);
    const eb = tel.filter(([k]) => /^handoff:.*\/end-block$/.test(k)).reduce((s, [, v]) => s + v.since, 0);
    if (per(eb, sp.since) > TH.handoffEndBlockPer100) f('handoff-end-block', per(eb, sp.since), TH.handoffEndBlockPer100, `${eb} end-blocks`);
    const st = tel.filter(([k]) => k.startsWith('struggle:')).reduce((s, [, v]) => s + v.since, 0);
    if (per(st, sp.since) > TH.struggle100) f('struggle', per(st, sp.since), TH.struggle100, `${st} fired`);
    const pd = tel.filter(([k]) => k.startsWith('wait:')).reduce((s, [, v]) => s + v.since, 0);
    if (per(pd, sp.since) > TH.pollDeny100) f('polling-waste', per(pd, sp.since), TH.pollDeny100, `${pd} worker-wait denials`);
  }
  const rn = tel.filter(([k]) => k.startsWith('runaway:')).reduce((s, [, v]) => s + v.since, 0);
  const spanH = m.span.since;
  if (rn > 0) f('runaway', rn, 0, `${rn} runaway row(s)`, +(rn / spanH).toFixed(3));
  {
    // Failure clears per hour against the pooled 7-day rate (floor: one clear in the baseline), never a fixed rate.
    const qc = m.queueClears; const baseRate = Math.max(qc.base, 1) / m.span.base; const lim = TH.clearsFactor * baseRate;
    if (qc.since >= TH.clearsMin && qc.since / spanH > lim) f('queue-clears', +(qc.since / spanH).toFixed(2), +lim.toFixed(2), `${qc.since} failure clears, baseline ${qc.perHour.base}/h`);
  }
  if (m.bash.since.n >= TH.bashMinN && m.bash.since.failPct > TH.bashFailPct) f('worker-bash-fail', m.bash.since.failPct, TH.bashFailPct, `n=${m.bash.since.n}`);
  if (wEnough) {
    if (ws.hookErrorWorkersPct != null && wb.hookErrorWorkersPct != null && ws.hookErrorWorkersPct - wb.hookErrorWorkersPct >= TH.hookErrorPp) f('hook-error-share', ws.hookErrorWorkersPct, wb.hookErrorWorkersPct + TH.hookErrorPp, `vs ${wb.hookErrorWorkersPct}% before`);
    for (const [sg, n] of Object.entries(m.hookSignatures.since)) if (n >= TH.newSigWorkers && !m.hookSignatures.base[sg]) f(`hook-signature:${sg}`, n, TH.newSigWorkers, 'new hook-error signature', +(n / spanH).toFixed(3));
    { const lim150 = Math.max(TH.over150Pct, wb.n >= TH.minWorkers ? 1.5 * (wb.over150kPct || 0) : 0); if (ws.over150kPct > lim150) f('context-over-150k', ws.over150kPct, +lim150.toFixed(1), `p90 ${ws.peakCtxP90}, baseline ${wb.over150kPct}%`); }
    if (ws.finished >= TH.noStatusMinFinished && (ws.noStatusPct > TH.noStatusPct || (wb.noStatusPct != null && ws.noStatusPct - wb.noStatusPct > TH.noStatusPp))) f('no-final-status', ws.noStatusPct, TH.noStatusPct, `vs ${wb.noStatusPct}% before`);
    if (ws.finished >= TH.finMin && ws.partialPct > TH.partialPct) f('partial-share', ws.partialPct, TH.partialPct);
    if (ws.finished >= TH.finMin && ws.blockedPct > TH.blockedPct) f('blocked-share', ws.blockedPct, TH.blockedPct);
    if (ws.apiNonUsageWorkers >= 1 || ws.apiErrorWorkers >= TH.apiWorkers) f('api-errors', ws.apiErrorWorkers, TH.apiWorkers, `${ws.apiNonUsageWorkers} non-usage-limit`, +(ws.apiErrorWorkers / spanH).toFixed(3));
    const lim = wb.n >= TH.minWorkers ? TH.unitsFactor * wb.unitsPerWorker.mean : TH.unitsAbs;
    if (ws.unitsPerWorker.mean > lim) f('units-per-worker', ws.unitsPerWorker.mean, +lim.toFixed(2), `mean, baseline ${wb.unitsPerWorker.mean}`);
    if (wb.n >= TH.minWorkers && wb.unitsPerWorker.p90 && ws.unitsPerWorker.p90 > TH.unitsFactor * wb.unitsPerWorker.p90) f('units-p90', ws.unitsPerWorker.p90, +(TH.unitsFactor * wb.unitsPerWorker.p90).toFixed(2), 'p90 per worker');
  }
  return flags;
}

// ---------- tick ----------
export function tick({ at = S.now(), installed, holdMinutes, run = analyze } = {}) {
  const res = { ran: false, checks: [], flagged: [], held: false, installed: false };
  try {
    const P = S.paths();
    if (!installed) installed = S.readJson(join(claudeDir(), 'plugins', 'installed_plugins.json'));
    const inst = newestInstall(installed);
    if (!inst) return res;
    res.installed = true;
    let sch = S.readJson(P.run);
    if (!sch || sch.T !== inst.T || !Array.isArray(sch.due) || !Array.isArray(sch.done)) { sch = buildSchedule(inst.T, inst.version, sch); S.writeJson(P.run, sch); }
    const due = dueIndexes(sch, at);
    if (due.length) {
      const last = due[due.length - 1];
      let metrics = null; let flags = [];
      try {
        // Window = since the previous check (a rate per window); baseline = always the 7 days before the install time T.
        metrics = run({ T: sch.T, nowMs: at, winFrom: sch.lastAt || sch.T });
        flags = evaluate(metrics);
      } catch (e) { flags = []; metrics = { error: String(e && e.message || e) }; }
      const late = at - sch.due[last] > LATE_MS;
      sch.done = [...sch.done, ...due];
      sch.lastAt = at;
      const everFlagged = sch.everFlagged || flags.length > 0;
      sch.everFlagged = everFlagged;
      if (sch.done.length >= sch.due.length) sch.closed = true;
      S.writeJson(P.run, sch);
      S.appendRow({ at: new Date(at).toISOString(), event: 'check', T: new Date(sch.T).toISOString(), version: sch.version, check: last + 1, covered: due.map((i) => i + 1), late, flags, metrics: metrics && metrics.spawns ? { spawns: metrics.spawns, workers: metrics.workers } : metrics });
      res.ran = true; res.checks = due.map((i) => i + 1); res.flagged = flags.map((x) => x.name);
      if (flags.length) S.openFlag({ version: sch.version, T: new Date(sch.T).toISOString(), check: `+${CHECK_HOURS[last]}h`, flags, at });
    }
    const hm = holdMinutes ?? opt('release_watch_hold_minutes', 30);
    res.held = !!S.maybeHold({ holdMinutes: hm, at });
  } catch { /* never throws */ }
  return res;
}

export function status(at = S.now()) {
  const sch = S.readJson(S.paths().run); const flag = S.readFlag(); const hold = S.readHold();
  const lines = [];
  if (!sch) lines.push('no watch armed (no tick has seen an install yet)');
  else {
    lines.push(`install ${new Date(sch.T).toISOString()} version ${sch.version || '?'}${sch.closed ? ' (watch closed' + (sch.everFlagged ? ', flags were raised' : ', clean') + ')' : ''}`);
    sch.due.forEach((d, i) => lines.push(`  check ${i + 1} (+${CHECK_HOURS[i]}h) ${new Date(d).toISOString()} ${sch.done.includes(i) ? 'done' : d <= at ? 'DUE' : 'pending'}`));
  }
  lines.push(S.flagIsOpen(flag) ? `flag open since ${flag.openedAt}, notified ${flag.notifiedAt}, ${flag.ackedAt ? 'answered ' + flag.ackedAt : 'unanswered'}: ${flag.flags.map((x) => `${x.name}=${x.value}${x.detail ? ' (' + x.detail + ')' : ''}`).join('; ')}` : 'no open flag');
  lines.push(hold && !hold.clearedAt ? `HOLD since ${hold.since}: ${hold.reason}` : 'no hold');
  return lines.join('\n');
}

function argOf(A, n) { const i = A.indexOf(n); return i >= 0 ? A[i + 1] : undefined; }

export function main(A = process.argv.slice(2)) {
  const cmd = A[0];
  try {
    if (cmd === 'tick') { const r = tick(); if (A.includes('--json')) console.log(JSON.stringify(r)); return 0; }
    if (cmd === 'status') { console.log(status()); return 0; }
    if (cmd === 'clear') { const r = S.clear({ by: argOf(A, '--by') || 'operator' }); console.log(r.flagCleared || r.holdCleared ? `cleared (flag ${r.flagCleared}, hold ${r.holdCleared})` : 'nothing to clear'); return 0; }
    if (cmd === 'check') {
      const T = Date.parse(argOf(A, '--since')); if (!(T > 0)) { console.error('check needs --since <ISO>'); return 2; }
      const bf = argOf(A, '--base-from');
      const m = analyze({ T, baseFrom: bf ? Date.parse(bf) : undefined, days: Number(argOf(A, '--days')) || 7, sample: Number(argOf(A, '--sample')) || 500 });
      const flags = evaluate(m);
      const verdict = flags.length ? `FLAG ${flags.map((x) => x.name).join(', ')}` : 'clean';
      console.log(JSON.stringify({ ...m, verdict, flags }, null, 1)); return 0;
    }
    console.error('usage: release-watch.mjs tick | status | clear [--by <who>] | check --since <ISO> [--base-from <ISO>] [--days N] [--sample N]');
    return 2;
  } catch (e) { console.error(String(e && e.message || e)); return cmd === 'tick' ? 0 : 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
