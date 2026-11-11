#!/usr/bin/env node
// Refit config/plan-weights.json from the operator's own data (0.31.47).
//
//   node calibrate-weights.mjs [--apply] [--json] [--projects <dir>] [--samples <file>] [--since <ISO date>] [--days <n>] [--boot <n>]
//
// Inputs: (1) official weekly-% readings: state/plan-meter-samples.jsonl (the get_usage sampler, hooks/plan-meter-sample.mjs,
// and the old statusLine lines) plus every get_usage result found in the transcripts under <claude dir>/projects, deduplicated;
// (2) token sums from ALL local transcripts (main, subagents, workflows), requests deduplicated by requestId|message id with
// the field-wise max of their usage. Model: weekly % = sum over model families of b_f * (Sonnet-priced plan units used by
// that family since the window opened), OLS without intercept. Sonnet is the baseline, so weight_f = b_f / b_sonnet and
// units per 1% = 1 / b_sonnet. Intervals are 90% bootstrap intervals over readings (a rough guide: readings inside a window
// are serially correlated). Unit pricing and the cache-read factor are the ones in plan-weights.json, so the weights are
// only valid for that factor.
//
// Windows the fit cannot explain are left out: a window whose meter went DOWN by more than 2 points (a reset the card does
// not show, as in September 2026), and, after a first fit, a window whose residual is far above the others'.
// --days <n> (default 60; 0 = all) skips transcripts not modified in n days. Default: print the fit. --apply writes <state root>/plan-weights.json (the per-user file read by
// hooks/lib/plan-allowance.mjs), only for figures whose interval is TIGHTER than the one now in force (shipped plus user file).

import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeDir, stateRootPath, stateRoot, configFilePath, classifyModel } from '../hooks/lib/context.mjs';
import { planWeights } from '../hooks/lib/plan-allowance.mjs';
import { parseUsage } from '../hooks/lib/plan-meter.mjs';

const H = 3600e3;
const WEEK = 7 * 86_400_000;
export const FAMILIES = ['sonnet', 'opus', 'haiku', 'fable'];
const SATURATED = 97; // readings at or above this are clipped by the limit, so they say nothing about the scale
const MIN_ROWS = 8;

// --- Reading the data ----------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  let es = [];
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const aliasCache = new Map();
function familyOf(model) {
  let a = aliasCache.get(model);
  if (a === undefined) {
    const c = classifyModel(model);
    a = c.known && FAMILIES.includes(c.alias) ? c.alias : '';
    aliasCache.set(model, a);
  }
  return a;
}

const FIELDS = ['in', 'out', 'cw5', 'cw1', 'cr'];

// One pass over every transcript: { reqs: [{t, fam, in, out, cw5, cw1, cr}] sorted, readings: [...], files }.
// A reading from a transcript is the get_usage result: { t, weekly, fable, fiveHour, resetMs, source: 'transcript' }.
// `days` > 0 skips transcripts not modified in that many days (a weekly window is 7 days, so older files cannot matter to a
// recent fit and the scan of a large history takes many minutes).
export function scanTranscripts(projectsDir, { days = 0 } = {}) {
  const recs = new Map();
  const readings = [];
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const files = walk(projectsDir).filter((f) => { if (!cutoff) return true; try { return statSync(f).mtimeMs >= cutoff; } catch { return false; } });
  for (const f of files) {
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }
    const uses = new Map(); // tool_use id -> timestamp
    let pos = 0;
    while (pos < txt.length) {
      let nl = txt.indexOf('\n', pos);
      if (nl < 0) nl = txt.length;
      const l = txt.slice(pos, nl);
      pos = nl + 1;
      if (!l) continue;
      const isAsst = l.includes('"output_tokens"');
      const isUse = l.includes('get_usage');
      const isRes = !isAsst && uses.size > 0 && l.includes('"tool_result"');
      if (!isAsst && !isUse && !isRes) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (!o || typeof o !== 'object') continue;
      const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
      if (isUse && content) {
        for (const b of content) if (b && b.type === 'tool_use' && /get_usage$/.test(String(b.name || ''))) uses.set(b.id, o.timestamp);
      }
      if (isRes && content) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || !uses.has(b.tool_use_id)) continue;
          const r = parseUsage(b.content);
          if (!r) continue;
          const t = Date.parse(uses.get(b.tool_use_id) || o.timestamp);
          if (Number.isFinite(t)) readings.push({ t, weekly: r.weekly, fable: r.fable, fiveHour: r.fiveHour, resetMs: r.weeklyResetsAt ? Date.parse(r.weeklyResetsAt) : NaN, source: 'transcript' });
        }
      }
      if (isAsst && o.type === 'assistant') {
        const m = o.message;
        if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
        const u = m.usage;
        const cc = u.cache_creation || {};
        const cw1 = cc.ephemeral_1h_input_tokens || 0;
        const cw5 = cc.ephemeral_5m_input_tokens || (cw1 ? 0 : (u.cache_creation_input_tokens || 0));
        const r = { t: Date.parse(o.timestamp), m: m.model, in: u.input_tokens || 0, out: u.output_tokens || 0, cw5, cw1, cr: u.cache_read_input_tokens || 0 };
        if (!Number.isFinite(r.t)) continue;
        const key = `${o.requestId || ''}|${m.id || o.uuid}`;
        const p = recs.get(key);
        if (!p) recs.set(key, r);
        else {
          for (const k of FIELDS) if (r[k] > p[k]) p[k] = r[k];
          if (r.t < p.t) p.t = r.t;
        }
      }
    }
  }
  const reqs = [];
  for (const r of recs.values()) {
    const fam = familyOf(r.m);
    if (fam) reqs.push({ t: r.t, fam, in: r.in, out: r.out, cw5: r.cw5, cw1: r.cw1, cr: r.cr });
  }
  reqs.sort((a, b) => a.t - b.t);
  return { reqs, readings, files: files.length };
}

// Readings from the samples file: the get_usage sampler's lines and the statusLine wrapper's (rate_limits.seven_day).
export function readSamples(file) {
  const out = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const t = Date.parse(j && j.ts);
    if (!Number.isFinite(t)) continue;
    if (j.source === 'get_usage' || typeof j.weekly_pct === 'number') {
      if (typeof j.weekly_pct !== 'number') continue;
      out.push({ t, weekly: j.weekly_pct, fable: j.fable_weekly_pct ?? null, fiveHour: j.five_hour_pct ?? null, resetMs: Date.parse(j.weekly_resets_at), source: 'samples' });
    } else if (j.rate_limits && j.rate_limits.seven_day && typeof j.rate_limits.seven_day.used_percentage === 'number') {
      const ra = j.rate_limits.seven_day.resets_at;
      out.push({ t, weekly: j.rate_limits.seven_day.used_percentage, fable: null, fiveHour: null, resetMs: typeof ra === 'number' ? ra * 1000 : NaN, source: 'samples' });
    }
  }
  return out;
}

// Same reading from two places (the sampler's hook time vs the transcript's tool_use time): same values, same window, within 3 minutes.
export function dedupeReadings(list) {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  const last = new Map();
  const out = [];
  for (const r of sorted) {
    const key = `${r.weekly}|${r.fable}|${r.fiveHour}|${Number.isFinite(r.resetMs) ? Math.round(r.resetMs / H) : ''}`;
    const prev = last.get(key);
    if (prev !== undefined && r.t - prev <= 3 * 60e3) continue;
    last.set(key, r.t);
    out.push(r);
  }
  return out;
}

// --- The fit -------------------------------------------------------------------------------------------------------

function invert(A) {
  const n = A.length;
  const M = A.map((r, i) => { const x = new Float64Array(2 * n); for (let j = 0; j < n; j++) x[j] = r[j]; x[n + i] = 1; return x; });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r) => [...r.slice(n)]);
}

// OLS without intercept: { beta, rss, n } or null when singular.
export function ols(X, y) {
  const n = X.length;
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  const inv = invert(A);
  if (!inv) return null;
  const beta = new Array(p).fill(0);
  for (let j = 0; j < p; j++) for (let k = 0; k < p; k++) beta[j] += inv[j][k] * b[k];
  if (beta.some((v) => !Number.isFinite(v))) return null;
  let rss = 0;
  for (let i = 0; i < n; i++) { let f = 0; for (let j = 0; j < p; j++) f += beta[j] * X[i][j]; rss += (y[i] - f) ** 2; }
  return { beta, rss, n, p };
}

function priceOf() {
  const w = planWeights();
  const u = w.unit || {};
  const rho = typeof w.cacheReadFactor?.value === 'number' ? w.cacheReadFactor.value : 1;
  const k = (typeof u.inPerMTok === 'number' ? u.inPerMTok : 2) / 1e6;
  const out = typeof u.outRatio === 'number' ? u.outRatio : 5;
  const w5 = typeof u.w5 === 'number' ? u.w5 : 1.25;
  const w1 = typeof u.w1 === 'number' ? u.w1 : 2;
  const rd = (typeof u.readRatio === 'number' ? u.readRatio : 0.1) * rho;
  return { rho, units: (r) => (r.in + out * r.out + w5 * r.cw5 + w1 * r.cw1 + rd * r.cr) * k };
}

// Rows for the fit: one per weekly reading inside its window, with the Sonnet-priced units each family used since the window
// opened. Also the per-window verdicts. A window whose meter fell by more than 2 points is excluded.
export function buildRows(readings, reqs, { since = NaN } = {}) {
  const { units } = priceOf();
  const n = reqs.length;
  const t = new Float64Array(n);
  const cum = {};
  const cnt = {};
  for (const f of FAMILIES) { cum[f] = new Float64Array(n + 1); cnt[f] = new Float64Array(n + 1); }
  for (let i = 0; i < n; i++) {
    const r = reqs[i];
    t[i] = r.t;
    const u = units(r);
    for (const f of FAMILIES) { cum[f][i + 1] = cum[f][i] + (r.fam === f ? u : 0); cnt[f][i + 1] = cnt[f][i] + (r.fam === f ? 1 : 0); }
  }
  const lb = (x) => { let lo = 0; let hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
  const byWin = new Map();
  for (const r of readings) {
    if (!Number.isFinite(r.resetMs) || !(r.weekly >= 0)) continue;
    if (Number.isFinite(since) && r.t < since) continue;
    const reset = Math.round(r.resetMs / H) * H;
    const start = reset - WEEK;
    if (r.t < start || r.t > reset + 60e3) continue;
    if (!byWin.has(reset)) byWin.set(reset, []);
    byWin.get(reset).push({ ...r, reset, start });
  }
  const rows = [];
  const windows = [];
  for (const [reset, list] of [...byWin].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.t - b.t);
    let max = -Infinity;
    let drop = null;
    for (const r of list) {
      if (max - r.weekly > 2 && !drop) drop = `meter went down ${max} -> ${r.weekly}`;
      if (r.weekly > max) max = r.weekly;
    }
    const w = { reset: new Date(reset).toISOString(), readings: list.length, used: 0, excluded: drop };
    windows.push(w);
    if (drop) continue;
    for (const r of list) {
      if (r.weekly < 1 || r.weekly >= SATURATED) continue;
      const i0 = lb(r.start);
      const i1 = lb(r.t);
      const U = {};
      const C = {};
      for (const f of FAMILIES) { U[f] = cum[f][i1] - cum[f][i0]; C[f] = cnt[f][i1] - cnt[f][i0]; }
      rows.push({ t: r.t, y: r.weekly, win: reset, U, C });
      w.used += 1;
    }
  }
  return { rows, windows };
}

function solve(rows, fams) {
  const X = rows.map((r) => fams.map((f) => r.U[f]));
  const o = ols(X, rows.map((r) => r.y));
  if (!o || !(o.beta[0] > 0)) return null;
  return { o, weights: Object.fromEntries(fams.map((f, i) => [f, o.beta[i] / o.beta[0]])), upp: 1 / o.beta[0] };
}

function rng(seed) { // mulberry32: a fixed seed keeps the intervals the same run to run
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const quant = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];

// The fit over rows: { n, windows, rms, models: {alias: {weight, interval, readings, calls}}, upp: {value, interval}, excludedWindows }.
export function fit(readings, reqs, { boot = 400, since = NaN } = {}) {
  let { rows, windows } = buildRows(readings, reqs, { since });
  // a window the others cannot explain: residual far above the rest (after a first fit)
  for (let pass = 0; pass < 2; pass++) {
    const fams0 = FAMILIES.filter((f) => rows.reduce((s, r) => s + r.U[f], 0) > 0);
    if (rows.length < MIN_ROWS || !fams0.includes('sonnet')) break;
    const s = solve(rows, fams0);
    if (!s) break;
    const wins = [...new Set(rows.map((r) => r.win))];
    const rmsOf = (w) => {
      const rs = rows.filter((r) => r.win === w);
      return Math.sqrt(rs.reduce((a, r) => a + (r.y - fams0.reduce((q, f, i) => q + s.o.beta[i] * r.U[f], 0)) ** 2, 0) / rs.length);
    };
    const rms = wins.map((w) => ({ w, rms: rmsOf(w) }));
    if (rms.length < 3) break;
    const sorted = rms.map((x) => x.rms).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const bad = rms.filter((x) => x.rms > Math.max(3, 4 * med));
    if (!bad.length) break;
    for (const b of bad) {
      const w = windows.find((x) => Date.parse(x.reset) === b.w);
      if (w) { w.excluded = `residual ${b.rms.toFixed(1)} points against a median of ${med.toFixed(1)}`; w.used = 0; }
    }
    rows = rows.filter((r) => !bad.some((b) => b.w === r.win));
  }
  if (rows.length < MIN_ROWS) return { n: rows.length, windows, enough: false };
  const fams = FAMILIES.filter((f) => rows.reduce((s, r) => s + r.U[f], 0) > 0);
  if (!fams.includes('sonnet')) return { n: rows.length, windows, enough: false };
  const base = solve(rows, fams);
  if (!base) return { n: rows.length, windows, enough: false };
  const draws = Object.fromEntries(fams.map((f) => [f, []]));
  const uppDraws = [];
  const rand = rng(20261103);
  for (let b = 0; b < boot; b++) {
    const s = [];
    for (let i = 0; i < rows.length; i++) s.push(rows[Math.floor(rand() * rows.length)]);
    const r = solve(s, fams);
    if (!r) continue;
    for (const f of fams) draws[f].push(r.weights[f]);
    uppDraws.push(r.upp);
  }
  const iv = (a) => (a.length >= 20 ? (a.sort((x, y) => x - y), [quant(a, 0.05), quant(a, 0.95)]) : null);
  const calls = (f) => [...new Set(rows.map((r) => r.win))].reduce((s, w) => {
    const rs = rows.filter((r) => r.win === w);
    return s + Math.max(...rs.map((r) => r.C[f]));
  }, 0);
  const models = {};
  for (const f of fams) {
    models[f] = { weight: base.weights[f], interval: f === 'sonnet' ? null : iv(draws[f]), readings: rows.filter((r) => r.U[f] > 0).length, calls: calls(f) };
  }
  return {
    n: rows.length,
    enough: true,
    windows,
    rms: Math.sqrt(base.o.rss / Math.max(1, base.o.n - base.o.p)),
    models,
    upp: { value: base.upp, interval: iv(uppDraws) },
    omitted: FAMILIES.filter((f) => !fams.includes(f)),
  };
}

// --- Apply ---------------------------------------------------------------------------------------------------------

const width = (iv) => (Array.isArray(iv) && iv.length === 2 && iv.every(Number.isFinite) ? iv[1] - iv[0] : Infinity);
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

// The figures --apply would write: only those whose new interval is tighter than the one in force (shipped plus user file).
// --apply only TIGHTENS: a figure replaces the one in force only when its interval is narrower, it overlaps the interval in force (a
// fit that lands far outside what is in force is shown, not applied) and the fit rests on at least MIN_APPLY_WINDOWS weekly windows
// (rows inside one window are serially correlated, so their bootstrap interval is too tight).
export const MIN_APPLY_WINDOWS = 3;
const overlaps = (a, b) => !Array.isArray(b) || b.length < 2 || (Array.isArray(a) && a.length >= 2 && a[0] <= b[1] && b[0] <= a[1]);
export function applyPlan(result, current = planWeights(), today = new Date().toISOString().slice(0, 10)) {
  const rho = typeof current.cacheReadFactor?.value === 'number' ? current.cacheReadFactor.value : 1;
  const source = `calibrate-weights.mjs ${today}: ${result.n} official weekly readings in ${result.windows.filter((w) => w.used).length} windows against local transcripts, cache reads at ${rho} x API price; 90% bootstrap interval.`;
  const decisions = [];
  const patch = { models: {} };
  const usedWindows = result.windows.filter((w) => w.used).length;
  const verdict = (newI, curI) => {
    if (usedWindows < MIN_APPLY_WINDOWS) return { apply: false, reason: `only ${usedWindows} window(s) behind the fit (need ${MIN_APPLY_WINDOWS})` };
    if (!(width(newI) < width(curI))) return { apply: false, reason: 'interval not tighter than the one in force' };
    if (!overlaps(newI, curI)) return { apply: false, reason: 'interval does not overlap the one in force' };
    return { apply: true, reason: 'interval tighter' };
  };
  for (const [alias, m] of Object.entries(result.models)) {
    if (alias === 'sonnet') continue;
    const cur = current.models?.[alias];
    const v = verdict(m.interval, cur?.interval);
    decisions.push({ what: `models.${alias}`, ...v });
    if (v.apply) {
      patch.models[alias] = { weight: r2(m.weight), interval: m.interval.map(r2), status: 'measured', date: today, n: m.readings, source };
    }
  }
  const curU = current.unitsPerPercent;
  const vu = verdict(result.upp.interval, curU?.interval);
  decisions.push({ what: 'unitsPerPercent', ...vu });
  if (vu.apply) patch.unitsPerPercent = { value: r1(result.upp.value), interval: result.upp.interval.map(r1), status: 'measured', date: today, source };
  if (!Object.keys(patch.models).length) delete patch.models;
  return { patch, decisions };
}

export function writeUserFile(patch, file = configFilePath('plan-weights.json', stateRoot())) { // where the file already is (config/ first, then the old top-level place); config/ when new
  let cur = {};
  try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
  const next = { ...cur, ...(patch.unitsPerPercent ? { unitsPerPercent: { ...(cur.unitsPerPercent || {}), ...patch.unitsPerPercent } } : {}) };
  if (patch.models) {
    next.models = { ...(cur.models || {}) };
    for (const [a, v] of Object.entries(patch.models)) next.models[a] = { ...(next.models[a] || {}), ...v };
  }
  if (typeof next.version !== 'number') next.version = 1;
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

// --- CLI -----------------------------------------------------------------------------------------------------------

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export function main(argv = process.argv.slice(2)) {
  const projects = argOf(argv, '--projects') || join(claudeDir(), 'projects');
  const samplesFile = argOf(argv, '--samples') || join(stateRootPath(), 'state', 'plan-meter-samples.jsonl'); // a read: never creates the state root
  const since = argOf(argv, '--since') ? Date.parse(argOf(argv, '--since')) : NaN;
  const boot = Number(argOf(argv, '--boot')) > 0 ? Number(argOf(argv, '--boot')) : 400;
  const days = Number(argOf(argv, '--days')) >= 0 && argOf(argv, '--days') !== null ? Number(argOf(argv, '--days')) : 60;
  const scan = scanTranscripts(projects, { days });
  const fromSamples = readSamples(samplesFile);
  const readings = dedupeReadings([...fromSamples, ...scan.readings]);
  const result = fit(readings, scan.reqs, { boot, since });
  const current = planWeights();
  const out = {
    sources: { transcripts: scan.files, requests: scan.reqs.length, samples: fromSamples.length, transcriptReadings: scan.readings.length, readings: readings.length },
    cacheReadFactor: current.cacheReadFactor?.value ?? 1,
    result,
  };
  if (!result.enough) {
    if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else console.log(`Not enough usable weekly readings to fit (${result.n} rows, need ${MIN_ROWS}; ${readings.length} readings found, ${scan.reqs.length} requests). Nothing changed.`);
    return 1;
  }
  const plan = applyPlan(result, current);
  out.apply = plan;
  if (argv.includes('--apply') && (plan.patch.models || plan.patch.unitsPerPercent)) out.written = writeUserFile(plan.patch);
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return 0; }

  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const ivs = (iv, d = 2) => (iv ? `[${f(iv[0], d)}, ${f(iv[1], d)}]` : '-');
  const win = result.windows;
  console.log(`Plan weights fit: ${result.n} weekly readings in ${win.filter((w) => w.used).length} windows (${readings.length} distinct readings found: ${fromSamples.length} in the samples file, ${scan.readings.length} in transcripts; ${scan.reqs.length} requests from ${scan.files} transcript files). Residual sd ${f(result.rms)} points. Cache reads at ${out.cacheReadFactor} x API price.`);
  for (const w of win.filter((x) => x.excluded)) console.log(`Left out: window ending ${w.reset.slice(0, 16)}Z (${w.readings} readings): ${w.excluded}.`);
  console.log('');
  console.log('model   weight   90% interval     readings  calls      in force (interval, status)       change');
  for (const [alias, m] of Object.entries(result.models)) {
    const cur = current.models?.[alias];
    const d = plan.decisions.find((x) => x.what === `models.${alias}`);
    const inForce = cur ? `${cur.weight} ${ivs(cur.interval, 2)} ${cur.status || ''}` : '-';
    console.log(`${alias.padEnd(7)} ${f(m.weight).padEnd(8)} ${ivs(m.interval).padEnd(16)} ${String(m.readings).padEnd(9)} ${String(m.calls).padEnd(10)} ${inForce.padEnd(33)} ${alias === 'sonnet' ? 'baseline' : d && d.apply ? 'tighter' : 'no'}`);
  }
  for (const a of result.omitted) console.log(`${a.padEnd(7)} no usage in the fitted windows: weight left as it is`);
  const cu = current.unitsPerPercent;
  const du = plan.decisions.find((x) => x.what === 'unitsPerPercent');
  console.log('');
  console.log(`Units per 1% of the weekly limit (Sonnet-priced): ${f(result.upp.value, 1)} ${ivs(result.upp.interval, 1)}; in force ${cu ? `${cu.value} ${ivs(cu.interval, 1)}` : '-'}; ${du && du.apply ? 'tighter' : 'not tighter'}.`);
  if (argv.includes('--apply')) console.log(out.written ? `Wrote the tighter figures to ${out.written}.` : 'Nothing is tighter than what is in force: no file written.');
  else if (plan.patch.models || plan.patch.unitsPerPercent) console.log('Run again with --apply to write the tighter figures to the per-user file.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); } catch (e) { console.log(`calibrate-weights failed: ${e && e.message}`); process.exitCode = 1; }
}
