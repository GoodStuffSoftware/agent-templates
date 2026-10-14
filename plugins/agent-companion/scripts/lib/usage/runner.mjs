// usage/runner.mjs: the daily usage analysis runner core (design section 4; 0.31.18 batch 5a).
//
// What it does, in one pass over a state root:
//   1. list the facts days (state/usage-facts/<day>.json, written once per closed and settled day)
//   2. load the three config layers, journal changed scenario digests, build the event sources
//   3. decide which closed days to compute: a day whose facts are missing, partial or not settled is
//      DEFERRED (recorded in the status file, computed by a later run, never zero-filled)
//   4. for each day, oldest first: hash every input; same digest as the stored result = skip;
//      otherwise evaluate every enabled scenario with the batch 4 library and write the results
//      file, the report and (for the newest day) the latest summary
//   5. write the status file
//
// IDEMPOTENT. A results file is a pure function of its inputs: the day's facts and the facts of the
// days its comparisons read, the resolved config, the resolved window boundaries, the checkup history
// record, the weekly limit, the session attribute inputs and RUNNER_VERSION. `inputsDigest` hashes
// them. Same digest = the run skips the day. A different digest writes `revision + 1` with the reason
// (which input changed). Nothing time-dependent is written into a results file or a report; clocks and
// costs live in the status file.
//
// BUDGET. `maxSeconds` is checked after each day (the first day always runs, so a run always makes
// progress). Days not reached are deferred ("time-budget") and the next run resumes with them.
//
// NO LOCK HERE. The caller (scripts/usage-analysis.mjs, or the checkup CLI) holds the shared checkup
// lock around the scan and this stage. Nothing in this file spawns a process or calls a model; every
// write goes below `root` (the report directory defaults to <root>/reports/usage).

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync, appendFileSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig, normalizeRung } from './config.mjs';
import { loadEventSources, diffConfigDigests, resolveWindow, CONFIG_JOURNAL_FILE } from './events.mjs';
import {
  makeFactsLoader, readFactsDay, factsFilePath, excludedShare, COUNTS_EVERYTHING,
} from './cohort.mjs';
import { evaluateScenario } from './compare.mjs';
import {
  addDays, dayRange, dayStartMs, dayEndMs, dayKeyOfMs, daysOverlapping, isDayKey, WEEKDAYS, DAY_MS, DEFAULT_BOUNDARY_UTC_HOUR,
} from './days.mjs';
import { unitsOfFacts, unitsFromTokens, SETTLE_MS } from './facts.mjs';
import { getMetric, configMetricRegistry } from './metrics/index.mjs';
import { readTelemetry, telemetryRecords, versionFirstSeen } from './telemetry.mjs';
import { makeRoutineSource } from './routines.mjs';
import { sessionRecordRoot } from '../routine-model-drift.mjs';
import { homeRoot, claudeDir } from '../../../hooks/lib/context.mjs';
import {
  renderReport, summaryLines, regressionsOf, regressionIdsOf, r4,
} from './report.mjs';

export const RUNNER_VERSION = 3; // 3: worker/routine metrics (batch 6b): richer spawn records, slash rung labels, telemetry and routine records; 2: day records, byModel, spawn start and re-spawn keys
export const RESULT_SCHEMA = 'agent-companion/usage-analysis-result';
export const LATEST_SCHEMA = 'agent-companion/usage-analysis-latest';
export const STATUS_SCHEMA = 'agent-companion/usage-analysis-status';
export const REVISE_WINDOW_DAYS = 8; // a default run revises (recomputes after an input change) only this recent
export const DEFER_LOOKBACK_DAYS = 8; // older missing days are not listed one by one
export const BASELINE_DAYS = 28; // the farthest baseline a built-in comparison reads (same-weekday-4)
export const WINDOW_DEP_DAYS = 60; // window spans are followed this far back when hashing a day's inputs
export const MAX_REVISIONS_KEPT = 20;
export const DEFAULT_LIMIT_UNITS = 2677;
export const DEFAULT_KEEP_DAYS = 180;
export const STATUS_DAYS_KEPT = 60;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (data) => createHash('sha256').update(data).digest('hex');

// ------------------------------------------------------------------ files --

/** Every path the runner reads or writes, below `root`. */
export function usagePaths(root, reportDir = null) {
  return {
    factsDir: join(root, 'state', 'usage-facts'),
    openFile: join(root, 'state', 'usage-facts', 'open.json'),
    resultsDir: join(root, 'state', 'usage-analysis'),
    latest: join(root, 'state', 'usage-analysis-latest.json'),
    status: join(root, 'state', 'usage-analysis-status.json'),
    surfaced: join(root, 'state', 'usage-analysis-surfaced.json'), // written by the SessionStart hook (batch 5b)
    history: join(root, 'state', 'daily-checkup-history.jsonl'),
    meter: join(root, 'state', 'plan-meter-samples.jsonl'), // statusline samples of the plan meter (read only)
    routinePins: join(root, 'config', 'routine-pins.json'),
    reportsDir: reportDir || join(root, 'reports', 'usage'),
  };
}

export const resultPath = (root, day) => join(usagePaths(root).resultsDir, `${day}.json`);
export const reportPathFor = (root, day, reportDir = null) => join(usagePaths(root, reportDir).reportsDir, `usage-${day}.md`);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]);
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

/** JSON with sorted keys and no non-finite numbers: the same value always gives the same bytes. */
export function stableStringify(v, indent = 2) { return JSON.stringify(sortKeys(v), null, indent); }

const h12 = (v) => sha(stableStringify(v, 0)).slice(0, 12);

/** Atomic write (temp file in the same directory, then rename), skipped when the bytes are unchanged. Returns true when written. */
export function writeIfChanged(path, text) {
  let cur = null;
  try { cur = readFileSync(path, 'utf8'); } catch { /* absent */ }
  if (cur === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return true;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

function listDays(dir, ext) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(ext) && isDayKey(n.slice(0, -ext.length))).map((n) => n.slice(0, -ext.length)).sort();
  } catch { return []; }
}

export function readStatus(root) { return readJson(usagePaths(root).status); }
export function readLatest(root) { return readJson(usagePaths(root).latest); }
export function readResult(root, day) {
  const j = readJson(resultPath(root, day));
  return isObj(j) && j.schema === RESULT_SCHEMA ? j : null;
}

/** The key that changes exactly when the set of regression ids changes (the SessionStart hook re-surfaces on a new key). */
export const regressionSetKey = (ids) => sha([...new Set(ids || [])].sort().join('|')).slice(0, 12);

// ------------------------------------------------------------ facts store --

function makeFactsStore(root) {
  const parsed = new Map();
  const hashes = new Map();
  return {
    read(day) {
      if (!parsed.has(day)) parsed.set(day, readFactsDay(root, day));
      return parsed.get(day);
    },
    hash(day) {
      if (!hashes.has(day)) {
        let h = null;
        try { h = sha(readFileSync(factsFilePath(root, day))).slice(0, 12); } catch { /* absent */ }
        hashes.set(day, h);
      }
      return hashes.get(day);
    },
    /** null when the day's facts cover the whole day, else why they do not. */
    partial(day) {
      const f = this.read(day);
      if (f.gap) return null;
      const from = Date.parse(f.facts.from);
      const scanFrom = Date.parse(f.facts.scanFrom);
      if (Number.isFinite(from) && Number.isFinite(scanFrom) && scanFrom > from) return `the scan began at ${f.facts.scanFrom}, after the day started`;
      return null;
    },
  };
}

// ------------------------------------------------------------------ hooks --

const normPath = (p) => {
  if (typeof p !== 'string' || !p) return null;
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** The plan meter's seven-day samples (state/plan-meter-samples.jsonl), oldest first: { tMs, pct, resetsAtMs }. A missing file: none. */
export function readMeterSamples(root) {
  if (!root) return [];
  const file = usagePaths(root).meter;
  let text;
  try {
    if (statSync(file).size > 32 * 1024 * 1024) return [];
    text = readFileSync(file, 'utf8');
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('seven_day')) continue;
    try {
      const j = JSON.parse(line);
      const sd = j && j.rate_limits && j.rate_limits.seven_day;
      const tMs = Date.parse(j.ts);
      if (sd && Number.isFinite(sd.used_percentage) && Number.isFinite(tMs)) {
        out.push({ tMs, pct: sd.used_percentage, resetsAtMs: Number.isFinite(sd.resets_at) ? sd.resets_at * 1000 : NaN });
      }
    } catch { /* torn line */ }
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/** Folders routines run from (config/routine-pins.json `folders`), normalised. */
export function readRoutineFolders(root) {
  const j = readJson(usagePaths(root).routinePins);
  const f = j && isObj(j.folders) ? j.folders : {};
  return Object.values(f).filter((v) => typeof v === 'string' && v && !v.includes('{{')).map(normPath).filter(Boolean).sort();
}

const rungLabel = (rung) => (typeof rung === 'string' && rung ? normalizeRung(rung) : undefined); // canonical `model/effort`

const effortOfRung = (rung) => {
  const m = /^(?:sonnet|opus)\/(low|medium|high|xhigh|max)$/.exec(String(rung || ''));
  return m ? m[1] : undefined;
};

// The worker metrics' view of one facts spawn: units and requests by category, units by context bucket, the first request,
// compactions, extra turns and the runs of simple steps. T = [input, output, cache write 5m, cache write 1h, cache read, requests].
function detailOf(s, spec) {
  const u = (T) => (Array.isArray(T) ? unitsFromTokens(T, spec) : 0);
  const catUnits = {}; const catReq = {};
  for (const [c, T] of Object.entries((s.req && s.req.cat) || {})) {
    if (!Array.isArray(T)) continue;
    catUnits[c] = u(T); catReq[c] = T[5] || 0;
  }
  const buckets = (s.ctx && Array.isArray(s.ctx.buckets) ? s.ctx.buckets : []).slice(0, 4);
  const ctxUnits = [0, 1, 2, 3].map((i) => u(buckets[i]));
  const ctxReq = [0, 1, 2, 3].map((i) => (buckets[i] && buckets[i][5]) || 0);
  const outTok = buckets.reduce((a, b) => a + ((b && b[1]) || 0), 0);
  return {
    bucket: s.req && s.req.bucket ? s.req.bucket : undefined,
    catUnits, catReq, ctxUnits, ctxReq, outTok,
    peakCtx: s.ctx && Number.isFinite(s.ctx.peak) ? s.ctx.peak : undefined,
    startupUnits: Array.isArray(s.startup) ? u(s.startup) : undefined,
    comp: { n: (s.comp && s.comp.n) || 0, afterUnits: s.comp && Array.isArray(s.comp.after) ? u(s.comp.after) : 0 },
    extraTurns: Number.isFinite(s.extraTurns) ? s.extraTurns : 0,
    simple: { runs: (s.simple && s.simple.runs) || 0, req: (s.simple && s.simple.req) || 0, units: s.simple && Array.isArray(s.simple.tok) ? u(s.simple.tok) : 0 },
  };
}

/**
 * The batch 4 hooks, wired from what the checkup already knows.
 *   sessionAttrs(record): class only, from the facts row (cwd in a routine folder = routine; many
 *     spawns per active hour = storm; at least one operator prompt = lead; else other). title,
 *     routineId, hasDesktopRecord and effortObserved need the desktop session records and stay
 *     unobservable. The classes worker and artifact cannot be derived from facts and are never set.
 *   spawnRecords(day, range): the day file's spawn records, mapped to the cohort field names.
 * `sources.cliVersions` is not wired: no shipped feed exists, so `cli:` stays a gap.
 */
export function makeHooks({
  store, environment = {}, routineFolders = [], root = null, boundary = DEFAULT_BOUNDARY_UTC_HOUR,
  nowT = Date.now(), sessionsRoot = null, claudeDirPath = null,
}) {
  const minPerHour = environment.classes && environment.classes.storm && Number.isFinite(environment.classes.storm.minSpawnsPerHour)
    ? environment.classes.storm.minSpawnsPerHour : 20;
  const sessionAttrs = (r) => {
    const cwd = normPath(r.cwd);
    if (cwd && routineFolders.some((f) => cwd === f || cwd.startsWith(`${f}/`))) return { class: 'routine' };
    if (r.hours > 0 && r.ag / r.hours >= minPerHour) return { class: 'storm' };
    if (r.pr && r.pr.n >= 1) return { class: 'lead' };
    return { class: 'other' };
  };
  const spawnRecords = (day, range) => {
    const f = store.read(day);
    if (f.gap) return [];
    const used = f.facts.weightsUsed || {};
    const out = [];
    for (const s of f.facts.spawns || []) {
      const startMs = Date.parse(s.start);
      if (range && !(startMs >= range.fromMs && startMs < range.toMs)) continue;
      const t = [0, 0, 0, 0, 0, 0];
      for (const b of (s.ctx && s.ctx.buckets) || []) for (let i = 0; i < 6; i += 1) t[i] += (b && b[i]) || 0;
      const spec = used[s.model];
      out.push({
        sid: s.sid,
        id: s.id,
        startMs,
        rk: s.rk || undefined,
        proj: s.proj || undefined,
        rung: rungLabel(s.rung), // canonical `model/effort`, as in the routing table; the config cohort pattern accepts it
        declaredType: s.type && s.type !== 'none' ? s.type : undefined, // a day file written before 0.31.18 says 'none' for no TYPE: unknown
        role: s.role || undefined,
        effort: effortOfRung(s.rung),
        fit: s.fit || undefined,
        model: s.model || undefined,
        mixedModels: s.mixed === true,
        requests: s.req ? s.req.n : undefined,
        status: s.status || undefined,
        ...(spec ? { units: { total: unitsFromTokens(t, spec) } } : {}),
        ...(spec ? detailOf(s, spec) : {}),
      });
    }
    return out;
  };
  // One record per day for the day-level metrics: the history figures, the plan-meter sample nearest the day's end
  // (and the plan percentage used after it, so the local figure can be taken at the sample's time) and units per hour.
  const histMemo = new Map();
  const histOf = (day) => {
    if (!root) return null;
    if (!histMemo.has(day)) histMemo.set(day, historyRecord(root, day));
    return histMemo.get(day);
  };
  let meterSamples = null;
  const samples = () => {
    if (!meterSamples) meterSamples = readMeterSamples(root);
    return meterSamples;
  };
  const dayRecords = (day, range) => {
    const f = store.read(day);
    if (f.gap) return [];
    const used = f.facts.weightsUsed || {};
    const rowUnits = (row) => {
      let u = 0;
      for (const [model, mt] of Object.entries(row.tok || {})) { const spec = used[model]; if (spec) u += unitsFromTokens(mt.m, spec) + unitsFromTokens(mt.s, spec); }
      return u;
    };
    const hours = {};
    for (const row of f.facts.rows || []) {
      const h = Date.parse(row.hour);
      if (!Number.isFinite(h) || (range && !(h >= range.fromMs && h < range.toMs))) continue;
      hours[row.hour] = (hours[row.hour] || 0) + rowUnits(row);
    }
    const h = histOf(day);
    const hist = h ? {
      week: h.week || null, limit: h.limit || null, limitUnits: Number.isFinite(h.limitUnits) ? h.limitUnits : null,
      ceilingNudges: Number.isFinite(h.ceilingNudges) ? h.ceilingNudges : null,
    } : null;
    let meter = null;
    if (root) {
      const a = dayStartMs(day, boundary); const b = a + DAY_MS;
      const inDay = samples().filter((x) => x.tMs >= a && x.tMs < b);
      const m = inDay[inDay.length - 1];
      if (m) {
        const nextHour = Math.floor(m.tMs / 3600000) * 3600000 + 3600000;
        let after = 0;
        for (const row of f.facts.rows || []) { const t = Date.parse(row.hour); if (Number.isFinite(t) && t >= nextHour) after += rowUnits(row); }
        const limit = hist && hist.limitUnits > 0 ? hist.limitUnits : 0;
        const weekStart = hist && hist.week ? Date.parse(hist.week.start) : NaN;
        const otherWeek = !Number.isFinite(weekStart) || !Number.isFinite(m.resetsAtMs) || Math.abs(m.resetsAtMs - (weekStart + 7 * DAY_MS)) > 3600000;
        meter = {
          pct: m.pct, at: new Date(m.tMs).toISOString(), resetsAt: Number.isFinite(m.resetsAtMs) ? new Date(m.resetsAtMs).toISOString() : null,
          pctAfterSample: limit > 0 ? (after / limit) * 100 : 0, otherWeek,
        };
      }
    }
    return [{ day, hist, meter, hours, spawns: (f.facts.spawns || []).length }];
  };
  // Telemetry rows (spawn guard, denials, struggle) and scheduled-run records, read once per run; both read only.
  let tel = null; let first = null;
  const telemetryOf = () => {
    if (!root) return null;
    if (!tel) { tel = readTelemetry(root); first = versionFirstSeen(tel); }
    return tel;
  };
  const telemetryHook = (day) => {
    const t = telemetryOf();
    return t ? telemetryRecords(t, day, boundary, { first }) : [];
  };
  let routineSource = null;
  const routineHook = (day) => {
    if (!routineSource) {
      routineSource = makeRoutineSource({
        sessionsRoot: sessionsRoot || sessionRecordRoot({ home: homeRoot() }),
        claudeDirPath: claudeDirPath || claudeDir(),
        nowMs: nowT,
      });
    }
    return routineSource.records(day, boundary, environment);
  };
  return { sessionAttrs, spawnRecords, dayRecords, telemetryRecords: telemetryHook, routineRecords: routineHook };
}

// ---------------------------------------------------------------- metrics --

/** The metric adapters the runner can evaluate: registry entries that carry a stat(records, ctx). Others are gaps. */
export function defaultMetrics(id) {
  const m = getMetric(id);
  return m && typeof m.stat === 'function' ? m : null;
}

// ------------------------------------------------------------ week / cadence --

/** Does the plan-week reset ("Fri 16:00", UTC) fall inside the checkup day? Then a weekly scenario is due. */
export function weekResetInDay(day, boundary, resetUtc) {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{2}):(\d{2})$/.exec(String(resetUtc || ''));
  if (!m) return false;
  const wd = WEEKDAYS.indexOf(m[1]);
  const s = dayStartMs(day, boundary);
  const e = s + DAY_MS;
  for (let d = Math.floor(s / DAY_MS) * DAY_MS; d < e; d += DAY_MS) {
    const at = d + (+m[2]) * 3600000 + (+m[3]) * 60000;
    if (new Date(d).getUTCDay() === wd && at >= s && at < e) return true;
  }
  return false;
}

// ----------------------------------------------------------- config parts --

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

function configParts(cfg) {
  const r = cfg.resolved;
  const scenarios = {};
  for (const s of r.scenarios.values()) scenarios[s.id] = h12({ metric: s.metric, def: s.def, state: s.state, gaps: s.gaps });
  return {
    environment: h12(pick(r.environment, ['day', 'week', 'projects', 'classes', 'vocabulary'])),
    windows: h12(r.windows),
    exclusions: h12(r.exclusions),
    thresholds: h12(r.thresholdDefaults),
    scenarios,
  };
}

function windowStates(cfg, sources) {
  const out = {};
  for (const [name, def] of Object.entries(cfg.resolved.windows || {})) {
    const w = resolveWindow(def, sources);
    out[name] = w.gap ? { gap: true, why: w.why } : { fromMs: w.fromMs, toMs: w.toMs, label: w.label };
  }
  return out;
}

function depDays(day, boundary, wstates) {
  const set = new Set(dayRange(addDays(day, -BASELINE_DAYS), day));
  const endMs = dayEndMs(day, boundary);
  const floorMs = dayStartMs(day, boundary) - WINDOW_DEP_DAYS * DAY_MS;
  for (const w of Object.values(wstates)) {
    if (w.gap || w.fromMs >= endMs) continue;
    const to = Math.min(w.toMs === null ? Infinity : w.toMs, endMs);
    // a window compared with "pre-window" reads an equally long stretch before it
    const from = Math.max(floorMs, w.fromMs - (to - w.fromMs));
    for (const d of daysOverlapping(from, to, boundary)) set.add(d);
  }
  return [...set].sort();
}

// ----------------------------------------------------------------- inputs --

function historyRecord(root, day) {
  try {
    for (const line of readFileSync(usagePaths(root).history, 'utf8').split('\n')) {
      if (!line.includes(`"day":"${day}"`)) continue;
      try { const j = JSON.parse(line); if (j && j.day === day) return j; } catch { /* torn line */ }
    }
  } catch { /* no history */ }
  return null;
}

function reasonOf(prior, parts) {
  if (!isObj(prior) || !isObj(prior.inputs)) return 'the previous result could not be read';
  const a = prior.inputs;
  const out = [];
  if (a.runner !== parts.runner) out.push(`runner version ${a.runner} -> ${parts.runner}`);
  if (a.limitUnits !== parts.limitUnits) out.push(`weekly limit ${a.limitUnits} -> ${parts.limitUnits}`);
  const ac = a.config || {}; const bc = parts.config;
  for (const k of ['environment', 'windows', 'exclusions', 'thresholds']) if (ac[k] !== bc[k]) out.push(`config ${k} changed`);
  const as = ac.scenarios || {};
  for (const id of Object.keys(bc.scenarios).sort()) {
    if (!(id in as)) out.push(`config: scenario ${id} added`);
    else if (as[id] !== bc.scenarios[id]) out.push(`config: scenario ${id} changed`);
  }
  for (const id of Object.keys(as).sort()) if (!(id in bc.scenarios)) out.push(`config: scenario ${id} removed`);
  const aw = a.windows || {};
  for (const n of Object.keys({ ...aw, ...parts.windows }).sort()) if (aw[n] !== parts.windows[n]) out.push(`window ${n} boundary changed`);
  const af = a.facts || {};
  for (const d of Object.keys({ ...af, ...parts.facts }).sort()) {
    if (af[d] === parts.facts[d]) continue;
    out.push(af[d] === undefined ? `facts for ${d} appeared` : parts.facts[d] === undefined ? `facts for ${d} removed` : `facts for ${d} changed`);
  }
  if (a.history !== parts.history) out.push('checkup history record changed');
  if (a.attrs !== parts.attrs) out.push('routine folders changed');
  if (a.meter !== parts.meter) out.push('plan meter sample changed');
  if (a.telemetry !== parts.telemetry) out.push('spawn telemetry changed');
  if (a.routines !== parts.routines) out.push('scheduled-run records changed');
  return (out.join('; ') || 'inputs changed').slice(0, 300);
}

// ----------------------------------------------------------- day planning --

function planDays(ctx) {
  const { nowT, boundary, store, paths, explicit } = ctx;
  const factsDays = listDays(paths.factsDir, '.json');
  const factsSet = new Set(factsDays);
  const openStarts = new Set();
  const openJson = readJson(paths.openFile);
  if (isObj(openJson) && Array.isArray(openJson.spawns)) for (const s of openJson.spawns) if (isObj(s) && isDayKey(s.startDay)) openStarts.add(s.startDay);
  const first = [...factsDays, ...openStarts].sort()[0];
  const lastClosed = addDays(dayKeyOfMs(nowT, boundary), -1);
  const deferred = [];
  const have = [];
  if (!first) return { have, deferred, lastClosed, factsDays };
  const keepFrom = addDays(lastClosed, -(ctx.keepDays - 1));
  const lookbackFrom = addDays(lastClosed, -(DEFER_LOOKBACK_DAYS - 1));
  for (const day of dayRange(first > keepFrom ? first : keepFrom, lastClosed)) {
    const report = !explicit || ctx.explicit.has(day);
    const recent = day >= lookbackFrom;
    if (!factsSet.has(day)) {
      if (!recent || !report) continue;
      if (nowT < dayEndMs(day, boundary) + SETTLE_MS) deferred.push({ day, kind: 'settling', reason: 'the day closed less than 5 minutes ago' });
      else if (openStarts.has(day)) deferred.push({ day, kind: 'open-spawns', reason: 'worker spawns that started this day are still open' });
      else deferred.push({ day, kind: 'no-facts', reason: 'the facts file is not written yet (the checkup scan has not settled the day)' });
      continue;
    }
    if (nowT < dayEndMs(day, boundary) + SETTLE_MS) { if (report) deferred.push({ day, kind: 'settling', reason: 'the day closed less than 5 minutes ago' }); continue; }
    const why = store.partial(day);
    if (why) { if (recent && report) deferred.push({ day, kind: 'partial', reason: `partial data: ${why}` }); continue; }
    if (!explicit || ctx.explicit.has(day)) have.push(day);
  }
  return { have, deferred, lastClosed, factsDays };
}

// ------------------------------------------------------------ one day --

function whyOf(entry) {
  if (entry.skipped) return entry.why || entry.skipped;
  const c = (entry.comparisons || []).find((x) => x.why) || ((entry.groups || []).flatMap((g) => g.comparisons || [])).find((x) => x.why);
  return c ? c.why : '';
}

function computeDay(ctx, day, parts, prior, force) {
  const { cfg, store, loadDay, sources, boundary, limit } = ctx;
  const f = store.read(day).facts;
  const resolved = cfg.resolved;

  // totals, from the stored raw tokens
  const used = f.weightsUsed || {};
  const byModel = {};
  for (const row of f.rows || []) {
    for (const [model, mt] of Object.entries(row.tok || {})) {
      const spec = used[model];
      if (!spec) continue;
      byModel[model] = (byModel[model] || 0) + unitsFromTokens(mt.m, spec) + unitsFromTokens(mt.s, spec);
    }
  }
  const total = unitsOfFacts(f);
  const main = unitsOfFacts(f, { kind: 'm' });
  const sub = unitsOfFacts(f, { kind: 's' });
  let estimated = 0;
  const weights = {};
  for (const model of Object.keys(used).sort()) {
    const w = used[model];
    weights[model] = { mult: w.mult, source: w.source || '', label: w.label === 'E' ? 'E' : 'M', units: r4(byModel[model] || 0) };
    if (w.label === 'E') estimated += byModel[model] || 0;
  }
  const totals = {
    units: r4(total), main: r4(main), subagent: r4(sub), limitUnits: limit,
    pctOfWeeklyLimit: limit > 0 ? r4((total / limit) * 100) : null,
    sessions: new Set((f.rows || []).map((r) => r.sid)).size,
    spawns: (f.spawns || []).length,
    shareEstimated: total > 0 ? r4((estimated / total) * 100) : 0,
  };

  // the checkup's own week figures for the day
  const hist = historyRecord(ctx.root, day);
  const week = hist && hist.week && Number.isFinite(hist.week.pctSoFar)
    ? { pctSoFar: hist.week.pctSoFar, elapsedPct: hist.week.elapsedPct, paceAtResetPct: hist.week.paceAtResetPct, partial: !!hist.week.partial } : null;

  // the day against the mean of the previous 7 settled days (totals only; scenarios do the rest)
  const prev = [];
  for (let i = 1; i <= 7; i += 1) {
    const d = addDays(day, -i);
    const g = store.read(d);
    if (g.gap || store.partial(d)) continue;
    prev.push(unitsOfFacts(g.facts));
  }
  const vsTrailing7 = prev.length >= 4
    ? (() => { const mean = prev.reduce((a, b) => a + b, 0) / prev.length; return mean > 0 ? { pct: r4(((total - mean) / mean) * 100), days: prev.length } : { why: 'the baseline days have no usage' }; })()
    : { why: `${prev.length} usable of 7 baseline days; 4 needed` };

  // scenarios
  const scenarios = [];
  const gaps = [];
  const exclusionNames = new Set();
  const list = [...resolved.scenarios.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const sc of list) {
    if (ctx.only && !ctx.only.has(sc.id)) continue;
    const base = { id: sc.id, metric: sc.metric, severity: sc.def.severity, title: sc.def.title || sc.id };
    if (sc.state !== 'enabled') {
      scenarios.push({ ...base, skipped: sc.state, ...(sc.gaps && sc.gaps.length ? { why: sc.gaps.join('; ') } : {}) });
      continue;
    }
    // The metric lookup comes before the cadence: a scenario whose metric has no stat() adapter is a gap on every day,
    // not only on the day its weekly cadence would have made it due.
    const metric = ctx.metrics(sc.metric);
    if (!metric) {
      scenarios.push({ ...base, skipped: 'gap', why: `metric "${sc.metric}" is not implemented in this plugin version` });
      continue;
    }
    if (sc.def.cadence === 'weekly' && !weekResetInDay(day, boundary, resolved.environment.week && resolved.environment.week.resetUtc)) {
      scenarios.push({ ...base, skipped: 'not-due', why: 'weekly: computed on the first close after the week reset' });
      continue;
    }
    for (const n of sc.def.excludeSets || []) if (!COUNTS_EVERYTHING.has(sc.metric)) exclusionNames.add(n);
    if (sc.metric === 'day.excludedShare') for (const n of Object.keys(resolved.exclusions || {})) exclusionNames.add(n); // it applies every defined rule
    let r;
    try { r = evaluateScenario({ scenario: sc, resolved, day, loadDay, metric, sources }); } catch (e) {
      r = { id: sc.id, metric: sc.metric, day, status: 'gap', why: `evaluation failed: ${String((e && e.message) || e).slice(0, 80)}` };
    }
    scenarios.push({ ...base, ...r });
  }
  for (const e of scenarios) {
    if (e.skipped === 'gap' || e.status === 'gap' || e.status === 'no-data') gaps.push({ id: e.id, why: whyOf(e) || 'no value' });
  }

  // what each exclusion removed, over the whole day
  let exclusions = null;
  if (exclusionNames.size) {
    const L = loadDay(day);
    if (!L.gap) {
      const x = excludedShare(L.records, [...exclusionNames].sort(), resolved.exclusions, limit);
      exclusions = {
        rows: x.rows.map((row) => ({
          name: row.name, scope: row.scope, records: row.records, units: r4(row.units), pctOfWeeklyLimit: r4(row.pctOfWeeklyLimit), why: row.why || '',
        })),
        removedUnits: r4(x.removedUnits), unobservable: x.unobservable, undefinedRules: x.undefinedRules,
      };
    }
  }

  // windows as they stood for this day
  const endMs = dayEndMs(day, boundary);
  const windows = {};
  for (const [name, w] of Object.entries(ctx.wstates)) {
    if (w.gap) { windows[name] = { gap: true, why: w.why }; continue; }
    const state = w.fromMs >= endMs ? 'not started' : w.toMs !== null && w.toMs <= endMs ? 'ended' : 'running';
    windows[name] = { state, from: new Date(w.fromMs).toISOString(), to: w.toMs === null ? null : new Date(w.toMs).toISOString(), label: w.label };
  }

  const regressions = regressionsOf(scenarios);
  const digest = sha(stableStringify(parts, 0)).slice(0, 32);
  const same = prior && prior.inputsDigest === digest;
  let revisions = prior && Array.isArray(prior.revisions) ? prior.revisions.slice() : [];
  let revision;
  if (same) revision = prior.revision;
  else if (prior) {
    revision = (Number.isInteger(prior.revision) ? prior.revision : 0) + 1;
    revisions.push({ revision, reason: reasonOf(prior, parts) });
  } else {
    revision = 1;
    revisions = [{ revision: 1, reason: 'first computation' }];
  }
  void force;
  if (revisions.length > MAX_REVISIONS_KEPT) revisions = revisions.slice(-MAX_REVISIONS_KEPT);

  const res = {
    schema: RESULT_SCHEMA,
    schemaVersion: 1,
    runnerVersion: RUNNER_VERSION,
    day,
    revision,
    revisions,
    inputsDigest: digest,
    inputs: parts,
    facts: {
      factsVersion: f.factsVersion, extractorVersion: f.extractorVersion, from: f.from, to: f.to, dataThrough: f.dataThrough || null, scanFrom: f.scanFrom || null,
    },
    totals,
    weights,
    week,
    vsTrailing7,
    scenarios,
    exclusions,
    windows,
    gaps,
    regressions,
  };
  const lines = summaryLines(res);
  res.summary = { lines, regressionIds: regressionIdsOf(regressions) };
  return res;
}

// ----------------------------------------------------------------- latest --

function buildLatest(res, reportPath) {
  const ids = res.summary.regressionIds;
  return {
    schema: LATEST_SCHEMA,
    day: res.day,
    revision: res.revision,
    inputsDigest: res.inputsDigest,
    lines: [...res.summary.lines, `report: ${String(reportPath).replace(/\\/g, '/')}`],
    regressionIds: ids,
    regressions: res.regressions,
    surfaceKey: regressionSetKey(ids),
    report: String(reportPath).replace(/\\/g, '/'),
  };
}

// ----------------------------------------------------------- the entry --

/**
 * Run the analysis stage. Never throws: a failure comes back as { error }.
 *   root         state root (required)
 *   nowT         the clock (ms)
 *   limitUnits   weekly limit in plan units (default 2677)
 *   days | from,to   explicit selection (YYYY-MM-DD);
 *   scenarios    restrict to these scenario ids; a restricted run is never persisted
 *   maxSeconds   wall-clock budget; the first day always runs
 *   force        recompute days whose digest is unchanged (the output is byte-identical)
 *   dryRun       compute, write nothing
 *   reportDir    where reports go (default <root>/reports/usage)
 *   metrics      id -> adapter | null (default: the registry entries that carry stat())
 *   config       a loaded config (test seam)
 *   cwds         session working directories for project-file discovery (default: those in the newest facts)
 *   git          test seam for config project discovery
 *   clock        () => ms, monotonic (test seam)
 */
export function runAnalysis(opts = {}) {
  const t0 = (opts.clock || (() => performance.now()))();
  const clock = opts.clock || (() => performance.now());
  try { return runAnalysisUnsafe(opts, t0, clock); } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 300), computed: [], skipped: [], deferred: [] };
  }
}

function runAnalysisUnsafe(opts, t0, clock) {
  const root = opts.root;
  if (!root) throw new Error('runAnalysis: root is required');
  const nowT = Number.isFinite(opts.nowT) ? opts.nowT : Date.now();
  const limit = opts.limitUnits > 0 ? opts.limitUnits : DEFAULT_LIMIT_UNITS;
  const restricted = Array.isArray(opts.scenarios) && opts.scenarios.length > 0;
  const persist = !opts.dryRun && !restricted;
  const paths = usagePaths(root, opts.reportDir || null);
  const store = makeFactsStore(root);
  const maxMs = Number.isFinite(opts.maxSeconds) ? opts.maxSeconds * 1000 : Infinity;

  // explicit selection
  let explicit = null;
  if (Array.isArray(opts.days) && opts.days.length) explicit = new Set(opts.days);
  else if (opts.from || opts.to) {
    const from = opts.from || opts.to; const to = opts.to || opts.from;
    explicit = new Set(dayRange(from, to).slice(0, 400));
  }
  if (explicit) for (const d of explicit) if (!isDayKey(d)) throw new Error(`not a day: ${d}`);

  // config: the layers, with project discovery from the working directories the newest facts saw
  const early = listDays(paths.factsDir, '.json');
  let cwds = opts.cwds;
  if (!cwds) {
    const set = new Set();
    for (const d of early.slice(-REVISE_WINDOW_DAYS)) {
      const g = store.read(d);
      if (g.gap) continue;
      for (const r of g.facts.rows || []) if (typeof r.cwd === 'string' && r.cwd && set.size < 50) set.add(r.cwd);
    }
    cwds = [...set].sort();
  }
  // Scenario metrics are validated against the real registry, unless the caller injected its own metric lookup (tests).
  const cfg = opts.config || loadConfig({ root, cwds, writeSignal: persist, now: new Date(nowT), git: opts.git, metrics: opts.metrics ? null : configMetricRegistry() });
  const env = cfg.resolved.environment;
  const boundary = env.day && Number.isInteger(env.day.boundaryUtcHour) ? env.day.boundaryUtcHour : DEFAULT_BOUNDARY_UTC_HOUR;
  const keepDays = env.report && Number.isInteger(env.report.keepDays) ? env.report.keepDays : DEFAULT_KEEP_DAYS;

  // event sources, with the config digest journal (a change of a scenario's series is itself an event)
  const sources = loadEventSources(root, { environment: env, git: opts.git });
  const priorRows = typeof sources.configRows === 'function' ? sources.configRows() : [];
  const newRows = diffConfigDigests(priorRows, [...cfg.resolved.scenarios.values()], cfg.resolved.exclusions, nowT);
  if (persist && newRows.length) {
    const jf = join(root, 'state', CONFIG_JOURNAL_FILE);
    mkdirSync(dirname(jf), { recursive: true });
    appendFileSync(jf, newRows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
  const merged = priorRows.concat(newRows);
  sources.configRows = () => merged;

  const routineFolders = readRoutineFolders(root);
  const hooks = makeHooks({
    store, environment: env, routineFolders, root, boundary, nowT, sessionsRoot: opts.sessionsRoot || null, claudeDirPath: opts.claudeDirPath || null,
  });
  const base = makeFactsLoader({ root, hooks });
  // a partial day is never a baseline either
  const loadDay = (day, range) => {
    const why = store.partial(day);
    return why ? { gap: true, why: `partial data: ${why}` } : base(day, range);
  };

  const wstates = windowStates(cfg, sources);
  const plan = planDays({ nowT, boundary, store, paths, explicit, keepDays });
  const cparts = configParts(cfg);
  const wparts = {};
  for (const [n, w] of Object.entries(wstates)) wparts[n] = w.gap ? `gap` : h12(w);
  const attrs = h12(routineFolders);

  const ctx = {
    root, cfg, store, loadDay, sources, boundary, limit, wstates, metrics: opts.metrics || defaultMetrics,
    only: restricted ? new Set(opts.scenarios) : null,
  };

  // order: days with no result yet (oldest first), then recent days that may need a revision (oldest first)
  const lastClosed = plan.lastClosed;
  const reviseFrom = addDays(lastClosed, -(REVISE_WINDOW_DAYS - 1));
  const fresh = []; const stale = [];
  for (const d of plan.have) (readResult(root, d) ? stale : fresh).push(d);
  const order = explicit ? [...fresh, ...stale] : [...fresh, ...stale.filter((d) => d >= reviseFrom)];
  const limitDays = Number.isInteger(opts.maxDays) && opts.maxDays > 0 ? opts.maxDays : Infinity;

  const meterSamplesOf = (day) => {
    const a = dayStartMs(day, boundary);
    const inDay = readMeterSamples(root).filter((x) => x.tMs >= a && x.tMs < a + DAY_MS);
    return inDay.length ? inDay[inDay.length - 1] : null;
  };
  const inputsFor = (day) => {
    const facts = {};
    for (const d of depDays(day, boundary, wstates)) { const h = store.hash(d); if (h) facts[d] = h; }
    const hist = historyRecord(root, day);
    const parts = {
      runner: RUNNER_VERSION, limitUnits: limit, config: cparts, windows: wparts, facts, attrs,
      history: hist ? h12({ w: hist.week, p: hist.pct && hist.pct.total, l: hist.limit }) : null,
    };
    // the plan-meter sample the day's meter figure reads (only when there is one, so a day without samples keeps its digest)
    const ms = meterSamplesOf(day);
    if (ms) parts.meter = h12(ms);
    // telemetry rows and scheduled-run records of the days the day depends on (only when there are any, so a root without them keeps its digest)
    const tparts = {}; const rparts = {};
    for (const d of depDays(day, boundary, wstates)) {
      const t = hooks.telemetryRecords(d);
      if (t.length) tparts[d] = h12(t);
      const r = hooks.routineRecords(d).filter((x) => x.kind === 'routine' || x.dr);
      if (r.length) rparts[d] = h12(r);
    }
    if (Object.keys(tparts).length) parts.telemetry = h12(tparts);
    if (Object.keys(rparts).length) parts.routines = h12(rparts);
    return { parts, digest: sha(stableStringify(parts, 0)).slice(0, 32) };
  };

  const computed = []; const skipped = []; const deferred = plan.deferred.slice(); const results = {};
  let budgetHit = false; let remaining = 0;
  for (const day of order) {
    const prior = readResult(root, day);
    const { parts, digest } = inputsFor(day);
    if (prior && prior.inputsDigest === digest && prior.runnerVersion === RUNNER_VERSION && !opts.force) {
      skipped.push(day);
      if (restricted || opts.dryRun) results[day] = prior;
      if (persist) writeIfChanged(reportPathFor(root, day, opts.reportDir || null), renderReport(prior)); // restores a deleted report
      continue;
    }
    if (computed.length >= limitDays) {
      remaining += 1;
      deferred.push({ day, kind: 'run-limit', reason: `the run computes at most ${limitDays} day(s); the next run resumes here` });
      continue;
    }
    if (computed.length > 0 && clock() - t0 >= maxMs) {
      budgetHit = true;
      remaining += 1;
      deferred.push({ day, kind: 'time-budget', reason: `the run budget of ${opts.maxSeconds} s was used; the next run resumes here` });
      continue;
    }
    const res = computeDay(ctx, day, parts, prior, !!opts.force);
    computed.push(day);
    results[day] = res;
    if (persist) {
      writeIfChanged(resultPath(root, day), `${stableStringify(res)}\n`);
      writeIfChanged(reportPathFor(root, day, opts.reportDir || null), renderReport(res));
    }
  }

  // latest: the newest day with a stored result
  let latest = null;
  if (persist) {
    const stored = listDays(paths.resultsDir, '.json');
    const newest = stored[stored.length - 1];
    if (newest) {
      const res = results[newest] || readResult(root, newest);
      if (res) {
        latest = buildLatest(res, reportPathFor(root, newest, opts.reportDir || null));
        writeIfChanged(paths.latest, `${stableStringify(latest)}\n`);
      }
    }
    prune(root, paths, opts.reportDir || null, keepDays);
  } else if (!restricted) {
    const dates = Object.keys(results).sort();
    if (dates.length) latest = buildLatest(results[dates[dates.length - 1]], reportPathFor(root, dates[dates.length - 1], opts.reportDir || null));
  }

  return {
    computed, skipped, deferred, remaining, partial: remaining > 0,
    budgetHit, results, latest,
    configProblems: cfg.problems.length, persisted: persist,
    durationMs: Math.round(clock() - t0),
    lastClosed,
  };
}

function prune(root, paths, reportDir, keepDays) {
  try {
    const stored = listDays(paths.resultsDir, '.json');
    if (!stored.length) return;
    const cut = addDays(stored[stored.length - 1], -keepDays);
    for (const d of stored) if (d < cut) { try { unlinkSync(resultPath(root, d)); } catch { /* gone */ } }
    for (const n of readdirSync(paths.reportsDir)) {
      const m = /^usage-(\d{4}-\d{2}-\d{2})\.md$/.exec(n);
      if (m && m[1] < cut) { try { unlinkSync(join(paths.reportsDir, n)); } catch { /* gone */ } }
    }
  } catch { /* no report dir yet */ }
}

// ----------------------------------------------------------------- status --

/**
 * Write the status file: this run's outcome plus a per-day state map that survives runs.
 * `run` carries the numbers only the caller knows (scheduled, durations, bytes read, RSS).
 */
export function writeStatus(root, { out, run, nowT, errors = [] }) {
  const paths = usagePaths(root);
  const prior = readStatus(root);
  const days = isObj(prior && prior.days) ? { ...prior.days } : {};
  for (const d of out.computed || []) days[d] = { state: 'computed' };
  for (const d of out.skipped || []) days[d] = { state: 'computed', unchanged: true };
  const nowDeferred = new Set((out.deferred || []).map((x) => x.day));
  for (const [d, v] of Object.entries(days)) {
    // a day deferred by an earlier run and not deferred now: computed since, or no longer listed
    if (v && v.state === 'deferred' && !nowDeferred.has(d)) { if (readResult(root, d)) days[d] = { state: 'computed' }; else delete days[d]; }
  }
  for (const x of out.deferred || []) days[x.day] = { state: 'deferred', kind: x.kind, reason: x.reason };
  for (const d of Object.keys(days).sort().slice(0, Math.max(0, Object.keys(days).length - STATUS_DAYS_KEPT))) delete days[d];
  for (const d of [...(out.computed || []), ...(out.skipped || [])]) {
    const r = readResult(root, d);
    if (r) days[d] = { state: 'computed', revision: r.revision, inputsDigest: r.inputsDigest };
  }
  const status = {
    schema: STATUS_SCHEMA,
    runnerVersion: RUNNER_VERSION,
    lastRun: {
      at: new Date(nowT).toISOString(),
      scheduled: !!run.scheduled,
      durationMs: run.durationMs ?? out.durationMs ?? null,
      bytesRead: run.bytesRead ?? null,
      peakRssMb: run.peakRssMb ?? null,
      scanned: !!run.scanned,
      computed: out.computed || [],
      unchanged: out.skipped || [],
      deferred: out.deferred || [],
      remaining: out.remaining || 0,
      partial: !!out.partial,
      budgetHit: !!out.budgetHit,
      configProblems: out.configProblems || 0,
      errors,
      llm: { enabled: false, units: 0 },
    },
    deferred: (out.deferred || []).map((x) => ({ day: x.day, kind: x.kind, reason: x.reason })),
    latestDay: (readLatest(root) || {}).day || null,
    days,
  };
  mkdirSync(dirname(paths.status), { recursive: true });
  writeIfChanged(paths.status, `${stableStringify(status)}\n`);
  return status;
}

/** Re-render the report of `day` from its stored result (no scan, no evaluation). { path, written } or { error }. */
export function rerenderReport(root, day, { reportDir = null, dryRun = false } = {}) {
  const res = readResult(root, day);
  if (!res) return { error: `no stored result for ${day}` };
  const path = reportPathFor(root, day, reportDir);
  const text = renderReport(res);
  if (dryRun) return { path, text, written: false };
  return { path, written: writeIfChanged(path, text) };
}

