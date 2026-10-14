// usage/config.mjs — the three-layer configuration of the daily usage
// analysis (design: daily-analysis-design-detail.md section 3).
//
// LAYERS, highest precedence first:
//   user     <root>/config/usage-analysis.json   (the operator; never committed)
//   project  <main worktree>/.claude/agent-companion/usage-analysis.json
//            (committed in a repo; UNTRUSTED input)
//   shipped  config/usage-analysis.defaults.json (the plugin repo)
//
// WHAT EACH LAYER MAY SET
//   shipped  scenarios (bare ids), defaults.threshold, derived metrics, and
//            environment defaults. Nothing else.
//   user     everything. New scenarios must have ids starting "u."; a change
//            to any other scenario (shipped, "u.", or "project:") goes
//            through `overrides`, field by field.
//   project  ONLY additive, namespaced material: scenarios, windows,
//            exclusions, disable and overrides, every one scoped to the
//            project's own label. Ids, window names and exclusion names are
//            rewritten to "project:<label>/<name>" at load, so a project file
//            can never collide with, shadow or override another layer.
//            It can never set `environment` (plan, session ids, experiment
//            dates, the LLM budget), never hold a regex (titlePattern is
//            refused and word lists may not contain regex metacharacters),
//            and never name a session id.
//
// FAILURE MODEL. A layer that cannot be parsed, has the wrong `schema`, or
// has a HIGHER major `schemaVersion` is ignored whole; the lower layers still
// load (a bad project file never disables the user layer). Inside a loadable
// layer, an invalid scenario/window/exclusion/override is dropped and
// reported (`errors`), and a key the layer is not allowed to set is dropped
// and reported (`refusals`). Unknown keys are kept and ignored. Any problem
// writes `state/usage-analysis-config-invalid.json` under the state root (the
// scout's `usage_analysis_config_invalid` signal reads it); a clean load
// removes it.
//
// Nothing here spawns anything except a read-only, window-hidden
// `git rev-parse` (project discovery), and nothing writes outside `root`.

import { readFileSync, lstatSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitClean } from '../git-env.mjs';
import { normalizeRung } from './rung.mjs';

export const SCHEMA_ID = 'agent-companion/usage-analysis';
export const SUPPORTED_MAJOR = 1;
export const USER_FILE = 'usage-analysis.json';
export const INVALID_SIGNAL_FILE = 'usage-analysis-config-invalid.json';
export const SHIPPED_DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'usage-analysis.defaults.json');

export const CAPS = Object.freeze({
  userBytes: 256 * 1024,
  projectBytes: 64 * 1024,
  shippedBytes: 512 * 1024,
  depth: 8,
  string: 400,
  title: 120,
  why: 300,
  id: 80,
  items: 100,
  projectScenarios: 50,
  regex: 200,
  word: 40,
});

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const BUILTIN_COMPARES = Object.freeze(['prior-day', 'trailing-7', 'same-weekday-4', 'level']);
const CLASSES = ['lead', 'worker', 'routine', 'storm', 'artifact', 'other'];
const SEVERITIES = ['alert', 'info', 'off'];
const CADENCES = ['daily', 'weekly'];
const GROUP_BY = ['effortObserved', 'project', 'model', 'rung'];
const DIRECTIONS = ['up-is-worse', 'down-is-worse'];
const INTERVALS = ['none', 'wilson', 'bootstrap-sessions'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/;
const EVENT_RE = /^(rollout|decision|release|cli|setting|tag|config):[\x21-\x7e]{1,100}$/;
const PROJECT_EVENT_RE = /^(tag|release):[\x21-\x7e]{1,100}$/;
const WORD_RE = /^[^\\^$*+?()[\]{}|]{1,40}$/;
const GLOB_RE = /^!?[A-Za-z0-9._*:-]{1,80}$/;
const COUNTER_RE = /^(units|tokens|count)\.[A-Za-z0-9._-]{1,60}$/;
const WEEK_RE = new RegExp(`^(${WEEKDAYS.join('|')}) ([01]\\d|2[0-3]):[0-5]\\d$`);

// Environment defaults live in code, not in the shipped json (which holds
// only the global scenarios). Every key here is overridable by the user layer.
export const ENVIRONMENT_DEFAULTS = Object.freeze({
  day: { boundaryUtcHour: 8 },
  week: { resetUtc: 'Fri 16:00' },
  projects: { autoload: true },
  routines: { watch: [], cron: {} },
  classes: { storm: { minSpawnsPerHour: 20 } },
  vocabulary: { correction: [] },
  llm: { enabled: false, cadence: 'weekly', maxItemsPerRun: 40, maxUnitsPerRun: 5.0 },
  report: { summaryLines: 3, keepDays: 180 },
});
export const THRESHOLD_DEFAULTS = Object.freeze({ relPct: 25, minSample: 15, minDays: 1 });

const SCENARIO_FIELDS = ['title', 'params', 'cohort', 'excludeSets', 'compare', 'groupBy', 'threshold', 'severity', 'cadence', 'retired', 'aliases'];
const OVERRIDE_FIELDS = ['title', 'params', 'cohort', 'excludeSets', 'compare', 'groupBy', 'threshold', 'severity', 'cadence'];
const COHORT_FIELDS = ['class', 'project', 'model', 'modelFamily', 'rung', 'declaredType', 'role', 'effort', 'effortObserved', 'fit', 'sessionId', 'titleAny', 'titlePattern', 'routineId'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- scanning --

// Prototype-pollution keys, depth and string length, over the whole parsed
// file, before anything reads a field.
function scanStructure(v, depth = 0, path = '$') {
  if (depth > CAPS.depth) return `${path}: nesting deeper than ${CAPS.depth}`;
  if (typeof v === 'string') return v.length > CAPS.string ? `${path}: string longer than ${CAPS.string} characters` : null;
  if (Array.isArray(v)) {
    if (v.length > CAPS.items * 4) return `${path}: array longer than ${CAPS.items * 4}`;
    for (let i = 0; i < v.length; i++) { const r = scanStructure(v[i], depth + 1, `${path}[${i}]`); if (r) return r; }
    return null;
  }
  if (isObj(v)) {
    for (const k of Object.keys(v)) {
      if (BAD_KEYS.has(k)) return `${path}: forbidden key "${k}"`;
      const r = scanStructure(v[k], depth + 1, `${path}.${k}`); if (r) return r;
    }
  }
  return null;
}

export function readLayerFile(path, maxBytes) {
  let st;
  try { st = lstatSync(path); } catch { return { status: 'absent' }; }
  if (st.isSymbolicLink()) return { status: 'invalid', error: 'refusing to read a symbolic link' };
  if (!st.isFile()) return { status: 'invalid', error: 'not a regular file' };
  if (st.size > maxBytes) return { status: 'invalid', error: `file is ${st.size} bytes; the cap is ${maxBytes}` };
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch (e) { return { status: 'invalid', error: `not valid JSON: ${e.message}` }; }
  if (!isObj(raw)) return { status: 'invalid', error: 'top level is not an object' };
  const bad = scanStructure(raw);
  if (bad) return { status: 'invalid', error: bad };
  return { status: 'ok', raw };
}

// --------------------------------------------------------- field validators --

class Sink {
  constructor() { this.errors = []; }
  err(path, msg) { this.errors.push({ path, message: msg }); }
}

// A rung label is `model/effort` (the routing table and the spawn records write it that way, e.g.
// `sonnet/high`). `sonnet-high` is accepted as an alias and normalized to the slash form.
const RUNG_RE = /^[A-Za-z0-9._:-]{1,80}(?:\/[A-Za-z0-9._:-]{1,80})?$/;
export { normalizeRung }; // implemented in ./rung.mjs (dependency-free, so cohort.mjs does not load this module)

function strArr(v, sink, path, { re, max = CAPS.items, maxLen = CAPS.string, values } = {}) {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) { sink.err(path, `must be a non-empty array of at most ${max} strings`); return null; }
  for (const s of v) {
    if (typeof s !== 'string' || !s || s.length > maxLen) { sink.err(path, `entries must be non-empty strings of at most ${maxLen} characters`); return null; }
    if (re && !re.test(s)) { sink.err(path, `entry "${s.slice(0, 40)}" has a disallowed form`); return null; }
    if (values && !values.includes(s)) { sink.err(path, `entry "${s}" must be one of ${values.join(', ')}`); return null; }
  }
  return v.slice();
}

function catastrophicRegex(src) { return /\([^)]*[+*][^)]*\)[+*{]/.test(src); }

function validateCohort(c, kind, label, sink, path) {
  if (!isObj(c)) { sink.err(path, 'must be an object'); return null; }
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    const p = `${path}.${k}`;
    if (!COHORT_FIELDS.includes(k)) { out[k] = v; continue; } // unknown: kept, ignored
    if (k === 'titlePattern') {
      if (kind !== 'user') { sink.err(p, 'regex refused (titlePattern is user layer only)'); return null; }
      if (typeof v !== 'string' || !v || v.length > CAPS.regex) { sink.err(p, `must be a string of at most ${CAPS.regex} characters`); return null; }
      if (catastrophicRegex(v)) { sink.err(p, 'nested quantifier (possible catastrophic backtracking)'); return null; }
      try { new RegExp(v); } catch (e) { sink.err(p, `does not compile: ${e.message}`); return null; }
      out[k] = v; continue;
    }
    if (k === 'sessionId' && kind === 'project') { sink.err(p, 'session ids are refused in a committed file'); return null; }
    let arr;
    if (k === 'class') arr = strArr(v, sink, p, { values: CLASSES });
    else if (k === 'titleAny') arr = strArr(v, sink, p, { re: WORD_RE, maxLen: CAPS.word });
    else if (k === 'model') arr = strArr(v, sink, p, { re: GLOB_RE });
    else if (k === 'sessionId') arr = strArr(v, sink, p, { re: /^[0-9a-f]{4,64}$/i });
    else if (k === 'rung') { arr = strArr(v, sink, p, { re: RUNG_RE }); if (arr) arr = arr.map(normalizeRung); }
    else arr = strArr(v, sink, p, { re: /^[A-Za-z0-9._:-]{1,80}$/ });
    if (!arr) return null;
    out[k] = arr;
  }
  if (kind === 'project') {
    if (out.project && !(out.project.length === 1 && out.project[0] === label)) { sink.err(`${path}.project`, `a project scenario may only target its own project "${label}"`); return null; }
    out.project = [label];
  }
  return out;
}

function validateThreshold(t, sink, path) {
  if (!isObj(t)) { sink.err(path, 'must be an object'); return null; }
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    const p = `${path}.${k}`;
    if (k === 'direction') { if (!DIRECTIONS.includes(v)) { sink.err(p, `must be one of ${DIRECTIONS.join(', ')}`); return null; } }
    else if (k === 'interval') { if (!INTERVALS.includes(v)) { sink.err(p, `must be one of ${INTERVALS.join(', ')}`); return null; } }
    else if (k === 'relPct') { if (!isNum(v) || v < 0 || v > 1000) { sink.err(p, 'must be a number from 0 to 1000'); return null; } }
    else if (k === 'abs') { if (!isNum(v) || v < 0) { sink.err(p, 'must be a number of at least 0'); return null; } }
    else if (k === 'minSample') { if (!isInt(v) || v < 1 || v > 100000) { sink.err(p, 'must be an integer from 1 to 100000'); return null; } }
    else if (k === 'minDays') { if (!isInt(v) || v < 1 || v > 365) { sink.err(p, 'must be an integer from 1 to 365'); return null; } }
    out[k] = v;
  }
  return out;
}

function validateParams(p, sink, path, metricInfo) {
  if (!isObj(p)) { sink.err(path, 'must be an object'); return null; }
  const keys = Object.keys(p);
  if (keys.length > 20) { sink.err(path, 'at most 20 parameters'); return null; }
  for (const k of keys) {
    const v = p[k];
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) { sink.err(`${path}.${k}`, 'parameter names are letters, digits and underscore'); return null; }
    if (!(isNum(v) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 100))) { sink.err(`${path}.${k}`, 'must be a number, boolean or short string'); return null; }
    const declared = metricInfo?.params?.defaults;
    if (declared && !(k in declared)) { sink.err(`${path}.${k}`, `the metric does not declare parameter "${k}"`); return null; }
  }
  return { ...p };
}

// Validate scenario (or override) fields. `ctx.names` carries the project's
// own window and exclusion names when kind === 'project' (cross-reference check).
function validateScenarioFields(obj, kind, ctx, sink, path, allowed) {
  const out = {};
  const extra = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (k === 'id' || k === 'metric') continue; // handled by the caller
    if (!allowed.includes(k)) { extra[k] = v; continue; }
    if (k === 'title') { if (typeof v !== 'string' || !v || v.length > CAPS.title) { sink.err(p, `must be a string of at most ${CAPS.title} characters`); return null; } out.title = v; }
    else if (k === 'params') { const r = validateParams(v, sink, p, ctx.metricInfo); if (!r) return null; out.params = r; }
    else if (k === 'cohort') { const r = validateCohort(v, kind, ctx.label, sink, p); if (!r) return null; out.cohort = r; }
    else if (k === 'excludeSets') {
      const r = Array.isArray(v) && v.length === 0 ? [] : strArr(v, sink, p, { re: NAME_RE }); if (!r) return null;
      if (kind === 'project') {
        for (const n of r) if (!ctx.names.exclusions.has(n)) { sink.err(p, `"${n}" is not an exclusion defined in this project file`); return null; }
        out.excludeSets = r.map((n) => `project:${ctx.label}/${n}`);
      } else out.excludeSets = r;
    }
    else if (k === 'compare') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 10) { sink.err(p, 'must be a non-empty array of at most 10 comparisons'); return null; }
      const list = [];
      for (const c of v) {
        if (typeof c === 'string' && BUILTIN_COMPARES.includes(c)) { list.push(c); continue; }
        if (isObj(c) && typeof c.window === 'string' && NAME_RE.test(c.window) && typeof c.vs === 'string' && (c.vs === 'pre-window' || NAME_RE.test(c.vs))) {
          let { window: w, vs } = c;
          if (kind === 'project') {
            const okW = ctx.names.windows.has(w);
            const okV = vs === 'pre-window' || ctx.names.windows.has(vs);
            if (!okW || !okV) { sink.err(p, 'a project comparison may only name windows defined in the same project file'); return null; }
            w = `project:${ctx.label}/${w}`; if (vs !== 'pre-window') vs = `project:${ctx.label}/${vs}`;
          }
          list.push({ window: w, vs });
          continue;
        }
        sink.err(p, `each entry is one of ${BUILTIN_COMPARES.join(', ')} or {window, vs}`); return null;
      }
      out.compare = list;
    }
    else if (k === 'groupBy') { if (!GROUP_BY.includes(v)) { sink.err(p, `must be one of ${GROUP_BY.join(', ')}`); return null; } out.groupBy = v; }
    else if (k === 'threshold') { const r = validateThreshold(v, sink, p); if (!r) return null; out.threshold = r; }
    else if (k === 'severity') { if (!SEVERITIES.includes(v)) { sink.err(p, `must be one of ${SEVERITIES.join(', ')}`); return null; } out.severity = v; }
    else if (k === 'cadence') { if (!CADENCES.includes(v)) { sink.err(p, `must be one of ${CADENCES.join(', ')}`); return null; } out.cadence = v; }
    else if (k === 'retired') { if (typeof v !== 'boolean') { sink.err(p, 'must be a boolean'); return null; } out.retired = v; }
    else if (k === 'aliases') { const r = strArr(v, sink, p, { re: ID_RE }); if (!r) return null; out.aliases = r; }
  }
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

function validateWindow(w, kind, sink, path) {
  if (!isObj(w)) { sink.err(path, 'must be an object'); return null; }
  const out = {};
  const evRe = kind === 'project' ? PROJECT_EVENT_RE : EVENT_RE;
  for (const key of ['from', 'to']) {
    if (w[key] === undefined) { if (key === 'from') { sink.err(`${path}.from`, 'is required'); return null; } continue; }
    const v = w[key];
    if (typeof v !== 'string' || !(ISO_RE.test(v) || evRe.test(v))) {
      sink.err(`${path}.${key}`, kind === 'project'
        ? 'a project window takes an ISO date/time, a tag: or a release: reference only'
        : 'must be an ISO date/time or an event reference (rollout:, decision:, release:, cli:, setting:, tag:, config:)');
      return null;
    }
    out[key] = v;
  }
  if (w.label !== undefined) { if (w.label !== 'M' && w.label !== 'E') { sink.err(`${path}.label`, 'must be "M" or "E"'); return null; } out.label = w.label; }
  if (w.why !== undefined) { if (typeof w.why !== 'string' || w.why.length > CAPS.why) { sink.err(`${path}.why`, `must be a string of at most ${CAPS.why} characters`); return null; } out.why = w.why; }
  return out;
}

function validateExclusion(x, kind, sink, path) {
  if (!isObj(x)) { sink.err(path, 'must be an object'); return null; }
  const out = {};
  const projectOk = ['titleAny', 'model', 'declaredType', 'scope', 'why'];
  for (const [k, v] of Object.entries(x)) {
    const p = `${path}.${k}`;
    if (kind === 'project' && !projectOk.includes(k)) { sink.err(p, `"${k}" is refused in a committed file (titleAny, model and declaredType only)`); return null; }
    if (k === 'scope') { if (v !== 'tree' && v !== 'session') { sink.err(p, 'must be "tree" or "session"'); return null; } out.scope = v; }
    else if (k === 'why') { if (typeof v !== 'string' || v.length > CAPS.why) { sink.err(p, `must be a string of at most ${CAPS.why} characters`); return null; } out.why = v; }
    else if (k === 'rule') { if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(v)) { sink.err(p, 'must be a rule name (letters and digits)'); return null; } out.rule = v; }
    else if (k === 'titleAny') { const r = strArr(v, sink, p, { re: WORD_RE, maxLen: CAPS.word }); if (!r) return null; out.titleAny = r; }
    else if (k === 'model') { const r = strArr(v, sink, p, { re: GLOB_RE }); if (!r) return null; out.model = r; }
    else if (k === 'sessionId') { const r = strArr(v, sink, p, { re: /^[0-9a-f]{4,64}$/i }); if (!r) return null; out.sessionId = r; }
    else if (k === 'declaredType' || k === 'class') { const r = strArr(v, sink, p, { re: /^[A-Za-z0-9._-]{1,60}$/ }); if (!r) return null; out[k] = r; }
    else out[k] = v; // unknown: kept
  }
  const selectors = ['titleAny', 'model', 'sessionId', 'declaredType', 'class', 'rule'];
  if (!selectors.some((s) => out[s])) { sink.err(path, 'needs at least one selector'); return null; }
  return out;
}

export function validateEnvironment(env, sink, path = 'environment') {
  if (!isObj(env)) { sink.err(path, 'must be an object'); return null; }
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const p = `${path}.${k}`;
    switch (k) {
      case 'day':
        if (!isObj(v) || (v.boundaryUtcHour !== undefined && !(isInt(v.boundaryUtcHour) && v.boundaryUtcHour >= 0 && v.boundaryUtcHour <= 23))) { sink.err(`${p}.boundaryUtcHour`, 'must be an integer from 0 to 23'); return null; }
        // The usage-facts day files are cut at a fixed 08:00Z (daily-checkup.mjs DAY_OFFSET_MS), so any other
        // boundary would silently misalign them with the analysis days. Refused until the facts cut reads this setting.
        if (v.boundaryUtcHour !== undefined && v.boundaryUtcHour !== 8) { sink.err(`${p}.boundaryUtcHour`, `must be 8 in this release (got ${v.boundaryUtcHour}): the usage-facts day files are cut at a fixed 08:00Z, so another boundary would silently misalign them with the analysis days`); return null; }
        out.day = { ...v }; break;
      case 'week':
        if (!isObj(v) || (v.resetUtc !== undefined && !(typeof v.resetUtc === 'string' && WEEK_RE.test(v.resetUtc)))) { sink.err(`${p}.resetUtc`, 'must look like "Fri 16:00"'); return null; }
        out.week = { ...v }; break;
      case 'plan':
        if (!isObj(v) || (v.weeklyLimitUnits !== undefined && !(isNum(v.weeklyLimitUnits) && v.weeklyLimitUnits > 0))) { sink.err(`${p}.weeklyLimitUnits`, 'must be a positive number'); return null; }
        out.plan = { ...v }; break;
      case 'projects': {
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        const o = {};
        for (const [lk, lv] of Object.entries(v)) {
          if (lk === 'autoload') { if (typeof lv !== 'boolean') { sink.err(`${p}.autoload`, 'must be a boolean'); return null; } o.autoload = lv; continue; }
          if (!LABEL_RE.test(lk)) { sink.err(`${p}.${lk}`, 'project labels are lowercase letters, digits, dot, dash, underscore'); return null; }
          if (!isObj(lv)) { sink.err(`${p}.${lk}`, 'must be an object'); return null; }
          const e = { ...lv };
          if (lv.paths !== undefined) { const r = strArr(lv.paths, sink, `${p}.${lk}.paths`, { max: 8 }); if (!r) return null; e.paths = r; }
          o[lk] = e;
        }
        out.projects = o; break;
      }
      case 'routines': {
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        const o = { ...v };
        if (v.watch !== undefined) { const r = Array.isArray(v.watch) && v.watch.length === 0 ? [] : strArr(v.watch, sink, `${p}.watch`, { re: NAME_RE }); if (!r) return null; o.watch = r; }
        if (v.cron !== undefined) {
          if (!isObj(v.cron)) { sink.err(`${p}.cron`, 'must be an object'); return null; }
          for (const [rk, rv] of Object.entries(v.cron)) if (!NAME_RE.test(rk) || typeof rv !== 'string' || rv.length > 60) { sink.err(`${p}.cron.${rk}`, 'must map a routine name to a cron string'); return null; }
        }
        out.routines = o; break;
      }
      case 'classes':
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        out.classes = { ...v }; break;
      case 'vocabulary': {
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        const o = { ...v };
        if (v.correction !== undefined) { const r = Array.isArray(v.correction) && v.correction.length === 0 ? [] : strArr(v.correction, sink, `${p}.correction`, { maxLen: 60 }); if (!r) return null; o.correction = r; }
        out.vocabulary = o; break;
      }
      case 'llm':
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        if (v.enabled !== undefined && typeof v.enabled !== 'boolean') { sink.err(`${p}.enabled`, 'must be a boolean'); return null; }
        if (v.cadence !== undefined && !['daily', 'weekly'].includes(v.cadence)) { sink.err(`${p}.cadence`, 'must be daily or weekly'); return null; }
        if (v.maxItemsPerRun !== undefined && !(isInt(v.maxItemsPerRun) && v.maxItemsPerRun >= 0 && v.maxItemsPerRun <= 1000)) { sink.err(`${p}.maxItemsPerRun`, 'must be an integer from 0 to 1000'); return null; }
        if (v.maxUnitsPerRun !== undefined && !(isNum(v.maxUnitsPerRun) && v.maxUnitsPerRun >= 0)) { sink.err(`${p}.maxUnitsPerRun`, 'must be a number of at least 0'); return null; }
        out.llm = { ...v }; break;
      case 'report':
        if (!isObj(v)) { sink.err(p, 'must be an object'); return null; }
        if (v.summaryLines !== undefined && !(isInt(v.summaryLines) && v.summaryLines >= 0 && v.summaryLines <= 10)) { sink.err(`${p}.summaryLines`, 'must be an integer from 0 to 10'); return null; }
        if (v.keepDays !== undefined && !(isInt(v.keepDays) && v.keepDays >= 1 && v.keepDays <= 3650)) { sink.err(`${p}.keepDays`, 'must be an integer from 1 to 3650'); return null; }
        out.report = { ...v }; break;
      default: out[k] = v; // unknown: kept, ignored
    }
  }
  return out;
}

function validateDerivedMetrics(m, kind, sink) {
  if (!isObj(m)) { sink.err('metrics', 'must be an object'); return null; }
  const out = {};
  for (const [id, def] of Object.entries(m)) {
    const p = `metrics.${id}`;
    if (!ID_RE.test(id) || (kind === 'user' && !id.startsWith('u.'))) { sink.err(p, kind === 'user' ? 'user metric ids must start with "u."' : 'invalid metric id'); continue; }
    if (!isObj(def) || !Array.isArray(def.ratio) || def.ratio.length !== 2 || !def.ratio.every((c) => typeof c === 'string' && COUNTER_RE.test(c))) {
      sink.err(p, 'must be {ratio: [counter, counter]} over units.*, tokens.* or count.* counters'); continue;
    }
    if (def.scale !== undefined && !(isNum(def.scale) && def.scale > 0)) { sink.err(`${p}.scale`, 'must be a positive number'); continue; }
    if (def.label !== undefined && def.label !== 'M' && def.label !== 'E') { sink.err(`${p}.label`, 'must be "M" or "E"'); continue; }
    out[id] = { ...def };
  }
  return out;
}

// ------------------------------------------------------------ layer checks --

const ALLOWED_TOP = {
  shipped: ['schema', 'schemaVersion', 'revision', 'environment', 'defaults', 'scenarios', 'metrics'],
  user: ['schema', 'schemaVersion', 'revision', 'environment', 'defaults', 'windows', 'exclusions', 'scenarios', 'metrics', 'disable', 'overrides'],
  project: ['schema', 'schemaVersion', 'revision', 'windows', 'exclusions', 'scenarios', 'disable', 'overrides'],
};
const KNOWN_TOP = ALLOWED_TOP.user;

function emptyLayer(layer, extra = {}) {
  return { layer, status: 'absent', path: null, label: null, errors: [], refusals: [], unknown: {}, scenarios: [], windows: {}, exclusions: {}, overrides: {}, disable: [], metrics: {}, environment: null, defaults: null, ...extra };
}

const layerName = (rec) => (rec.layer === 'project' ? `project ${rec.label}` : rec.layer);
const tag = (list, id) => list.map((e) => ({ ...e, id }));

/**
 * Validate one parsed layer; returns the layer record (see emptyLayer). A
 * whole-layer failure sets status 'invalid' or 'higher-major' and leaves the
 * content empty; item-level failures are in `errors`, key-level refusals in
 * `refusals`.
 */
export function validateLayer(raw, layer, { label = null, path = null, metrics: metricRegistry = null } = {}) {
  const rec = emptyLayer(layer, { path, label, status: 'ok' });
  const fail = (status, msg) => { rec.status = status; rec.errors.push({ path: '$', message: msg }); return rec; };
  if (raw.schema !== SCHEMA_ID) return fail('invalid', `schema must be "${SCHEMA_ID}"`);
  if (!isInt(raw.schemaVersion) || raw.schemaVersion < 1) return fail('invalid', 'schemaVersion must be a positive integer');
  if (raw.schemaVersion > SUPPORTED_MAJOR) return fail('higher-major', `schemaVersion ${raw.schemaVersion} is newer than this plugin understands (${SUPPORTED_MAJOR}); layer ignored`);
  if (raw.revision !== undefined && !isInt(raw.revision)) rec.errors.push({ path: 'revision', message: 'must be an integer' });
  if (layer === 'project' && !LABEL_RE.test(label || '')) return fail('invalid', 'project label is not a valid label');

  const allowedTop = ALLOWED_TOP[layer];
  for (const [k, v] of Object.entries(raw)) {
    if (allowedTop.includes(k)) continue;
    if (KNOWN_TOP.includes(k)) {
      rec.refusals.push({
        path: k,
        message: layer === 'project'
          ? (k === 'environment' ? 'environment key in committed file' : `"${k}" is not allowed in a project file`)
          : `"${k}" is not allowed in the shipped file`,
      });
    } else rec.unknown[k] = v;
  }

  const projectNs = (n) => `project:${label}/${n}`;
  const ownIds = new Set((Array.isArray(raw.scenarios) ? raw.scenarios : []).filter(isObj).map((x) => x.id));
  const names = { windows: new Set(), exclusions: new Set() };

  if (raw.environment !== undefined && allowedTop.includes('environment')) {
    const s = new Sink(); const env = validateEnvironment(raw.environment, s);
    if (env) rec.environment = env; else rec.errors.push(...s.errors);
  }
  if (raw.defaults !== undefined && allowedTop.includes('defaults')) {
    if (!isObj(raw.defaults)) rec.errors.push({ path: 'defaults', message: 'must be an object' });
    else {
      const d = { ...raw.defaults };
      if (raw.defaults.threshold !== undefined) {
        const s = new Sink(); const t = validateThreshold(raw.defaults.threshold, s, 'defaults.threshold');
        if (t) d.threshold = t; else { rec.errors.push(...s.errors); delete d.threshold; }
      }
      rec.defaults = d;
    }
  }
  if (raw.metrics !== undefined && allowedTop.includes('metrics')) {
    const s = new Sink(); const m = validateDerivedMetrics(raw.metrics, layer, s);
    rec.errors.push(...s.errors); if (m) rec.metrics = m;
  }
  if (raw.windows !== undefined && allowedTop.includes('windows')) {
    if (!isObj(raw.windows)) rec.errors.push({ path: 'windows', message: 'must be an object' });
    else for (const [name, w] of Object.entries(raw.windows)) {
      const p = `windows.${name}`;
      if (!NAME_RE.test(name)) { rec.errors.push({ path: p, message: 'invalid window name' }); continue; }
      const s = new Sink(); const v = validateWindow(w, layer, s, p);
      if (v) { rec.windows[layer === 'project' ? projectNs(name) : name] = v; names.windows.add(name); }
      else (layer === 'project' ? rec.refusals : rec.errors).push(...s.errors);
    }
  }
  if (raw.exclusions !== undefined && allowedTop.includes('exclusions')) {
    if (!isObj(raw.exclusions)) rec.errors.push({ path: 'exclusions', message: 'must be an object' });
    else for (const [name, x] of Object.entries(raw.exclusions)) {
      const p = `exclusions.${name}`;
      if (!NAME_RE.test(name)) { rec.errors.push({ path: p, message: 'invalid exclusion name' }); continue; }
      const s = new Sink(); const v = validateExclusion(x, layer, s, p);
      if (v) { rec.exclusions[layer === 'project' ? projectNs(name) : name] = v; names.exclusions.add(name); }
      else (layer === 'project' ? rec.refusals : rec.errors).push(...s.errors);
    }
  }
  if (raw.scenarios !== undefined) {
    if (!Array.isArray(raw.scenarios)) rec.errors.push({ path: 'scenarios', message: 'must be an array' });
    else if (layer === 'project' && raw.scenarios.length > CAPS.projectScenarios) rec.errors.push({ path: 'scenarios', message: `a project file may hold at most ${CAPS.projectScenarios} scenarios` });
    else {
      const seen = new Set();
      raw.scenarios.forEach((sc, i) => {
        const p = `scenarios[${i}]`;
        const s = new Sink();
        if (!isObj(sc) || typeof sc.id !== 'string' || !ID_RE.test(sc.id)) { rec.errors.push({ path: p, message: 'needs a valid string id' }); return; }
        const bad = (msg) => rec.errors.push({ path: p, id: sc.id, message: msg });
        if (layer === 'user' && !sc.id.startsWith('u.')) return bad(`user scenario ids must start with "u." (use overrides to change "${sc.id}")`);
        if (layer === 'shipped' && sc.id.startsWith('u.')) return bad('shipped ids are bare and must not start with "u."');
        if (layer === 'project' && /[:/]/.test(sc.id)) return bad('project ids are bare; the project: prefix is added at load');
        if (seen.has(sc.id)) return bad(`duplicate id "${sc.id}"`);
        seen.add(sc.id);
        if (typeof sc.metric !== 'string' || !ID_RE.test(sc.metric)) return bad('needs a metric id');
        const metricInfo = metricRegistry ? metricRegistry[sc.metric] : null;
        if (metricRegistry && !metricInfo && !rec.metrics[sc.metric]) return bad(`unknown metric "${sc.metric}"`);
        const fields = validateScenarioFields(sc, layer, { label, names, metricInfo }, s, p, SCENARIO_FIELDS);
        if (!fields) { (layer === 'project' ? rec.refusals : rec.errors).push(...tag(s.errors, sc.id)); return; }
        // A project scenario is always scoped to its own project, whether or not it names a cohort (spec 3.3):
        // without this a committed scenario with no cohort key would evaluate over every project's data.
        if (layer === 'project') fields.cohort = { ...(fields.cohort || {}), project: [label] };
        rec.scenarios.push({ id: layer === 'project' ? projectNs(sc.id) : sc.id, layer, label, declaredId: sc.id, metric: sc.metric, ...fields });
      });
    }
  }
  if (raw.disable !== undefined && allowedTop.includes('disable')) {
    const s = new Sink();
    const r = Array.isArray(raw.disable) && raw.disable.length === 0 ? [] : strArr(raw.disable, s, 'disable', { re: /^[A-Za-z0-9:/._-]{1,120}$/ });
    if (!r) rec.errors.push(...s.errors);
    else if (layer === 'project') {
      for (const id of r) {
        if (ownIds.has(id)) rec.disable.push(projectNs(id));
        else rec.refusals.push({ path: 'disable', id, message: `"${id}" is not a scenario of this project file (a project may disable only its own)` });
      }
    } else rec.disable = r;
  }
  if (raw.overrides !== undefined && allowedTop.includes('overrides')) {
    if (!isObj(raw.overrides)) rec.errors.push({ path: 'overrides', message: 'must be an object' });
    else for (const [id, ov] of Object.entries(raw.overrides)) {
      const p = `overrides.${id}`;
      if (!isObj(ov)) { rec.errors.push({ path: p, id, message: 'must be an object' }); continue; }
      let targetId = id;
      if (layer === 'project') {
        if (!ownIds.has(id)) { rec.refusals.push({ path: p, id, message: `"${id}" is not a scenario of this project file (a project may override only its own)` }); continue; }
        targetId = projectNs(id);
      }
      if (ov.id !== undefined || ov.metric !== undefined) { rec.errors.push({ path: p, id, message: 'id and metric cannot be overridden' }); continue; }
      const s = new Sink();
      const fields = validateScenarioFields(ov, layer, { label, names, metricInfo: null }, s, p, OVERRIDE_FIELDS);
      if (!fields) { (layer === 'project' ? rec.refusals : rec.errors).push(...tag(s.errors, id)); continue; }
      delete fields.extra;
      rec.overrides[targetId] = fields;
    }
  }
  return rec;
}

// ------------------------------------------------------------------ merge --

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) {
    if (BAD_KEYS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

// Dotted leaf paths; arrays and empty objects are leaves.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && Object.keys(v).length) flatten(v, p, out); else out[p] = v;
  }
  return out;
}

/**
 * Merge layer records into one resolved configuration.
 *   layers = { shipped, user, projects: [rec...] }   (records from validateLayer)
 * Precedence per field: user overrides > project (its own ids only) > shipped.
 * Arrays and scalars are replaced, objects merge, `disable` is a union.
 */
export function resolveLayers({ shipped, user, projects = [] }) {
  const usable = (r) => r && r.status === 'ok';
  const S = usable(shipped) ? shipped : emptyLayer('shipped');
  const U = usable(user) ? user : emptyLayer('user');
  const P = projects.filter(usable);

  let environment = clone(ENVIRONMENT_DEFAULTS);
  const envSources = {};
  for (const k of Object.keys(flatten(ENVIRONMENT_DEFAULTS))) envSources[k] = 'default';
  for (const rec of [S, U]) {
    if (!rec.environment) continue;
    environment = deepMerge(environment, rec.environment);
    for (const k of Object.keys(flatten(rec.environment))) envSources[k] = rec.layer;
  }
  const thresholdDefaults = deepMerge(deepMerge(clone(THRESHOLD_DEFAULTS), S.defaults?.threshold || {}), U.defaults?.threshold || {});

  const windows = { ...U.windows };
  const exclusions = { ...U.exclusions };
  const metrics = { ...S.metrics, ...U.metrics };
  for (const rec of P) { Object.assign(windows, rec.windows); Object.assign(exclusions, rec.exclusions); }
  const disabled = new Set([...U.disable, ...P.flatMap((r) => r.disable)]);

  const scenarios = new Map();
  const hists = new Map();
  const add = (rec) => {
    for (const sc of rec.scenarios) {
      if (scenarios.has(sc.id)) continue; // ids are prefix-disjoint by construction; first wins defensively
      const hist = {};
      const push = (p, value, source) => { (hist[p] ||= []).push({ value: clone(value), source }); };
      for (const [k, v] of Object.entries(thresholdDefaults)) push(`threshold.${k}`, v, 'defaults.threshold');
      const base = { ...sc };
      for (const k of ['id', 'layer', 'label', 'declaredId', 'metric', 'extra']) delete base[k];
      const src = layerName(rec);
      for (const [p, v] of Object.entries(flatten(base))) push(p, v, src);
      scenarios.set(sc.id, { id: sc.id, layer: rec.layer, label: rec.label, metric: sc.metric, extra: sc.extra || {} });
      hists.set(sc.id, hist);
    }
  };
  add(S); for (const rec of P) add(rec); add(U);

  const missing = [];
  const applyOverride = (id, ov, source) => {
    const hist = hists.get(id);
    if (!hist) return false;
    for (const [p, v] of Object.entries(flatten(ov))) (hist[p] ||= []).push({ value: clone(v), source });
    return true;
  };
  for (const rec of P) for (const [id, ov] of Object.entries(rec.overrides)) if (!applyOverride(id, ov, `${layerName(rec)} overrides`)) missing.push({ id, layer: layerName(rec) });
  for (const [id, ov] of Object.entries(U.overrides)) if (!applyOverride(id, ov, 'user overrides')) missing.push({ id, layer: 'user' });

  for (const [id, s] of scenarios) {
    const hist = hists.get(id);
    s.fields = {};
    const def = {};
    for (const [path, h] of Object.entries(hist)) {
      const last = h[h.length - 1];
      s.fields[path] = { value: last.value, source: last.source, shadowed: h.slice(0, -1) };
      const parts = path.split('.'); let o = def;
      for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] = isObj(o[parts[i]]) ? o[parts[i]] : {});
      o[parts[parts.length - 1]] = last.value;
    }
    def.severity ||= 'info'; def.cadence ||= 'daily';
    s.def = def;
  }

  const warnings = [];
  for (const id of disabled) if (!scenarios.has(id)) warnings.push(`disable names unknown scenario "${id}"`);
  for (const m of missing) warnings.push(`${m.layer} overrides name unknown scenario "${m.id}"`);
  for (const s of scenarios.values()) {
    const gaps = [];
    for (const x of s.def.excludeSets || []) if (!exclusions[x]) gaps.push(`exclusion "${x}" is not defined`);
    for (const c of s.def.compare || []) {
      if (!isObj(c)) continue;
      if (!windows[c.window]) gaps.push(`window "${c.window}" is not defined`);
      if (c.vs !== 'pre-window' && !windows[c.vs]) gaps.push(`window "${c.vs}" is not defined`);
    }
    s.gaps = gaps;
    s.state = disabled.has(s.id) ? 'disabled' : s.def.retired ? 'retired' : s.def.severity === 'off' ? 'disabled' : gaps.length ? 'gap' : 'enabled';
    for (const g of gaps) warnings.push(`${s.id}: ${g}`);
  }

  return { environment, envSources, thresholdDefaults, windows, exclusions, metrics, disabled, scenarios, warnings };
}

// ------------------------------------------------------ project discovery --

const gitCache = new Map();

const normPath = (p) => {
  const s = resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** Main worktree of the repository containing `cwd`, or null. Cached per cwd. */
export function mainWorktreeOf(cwd, { cache = gitCache, git = gitClean } = {}) {
  const key = normPath(cwd);
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const common = String(git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim().replace(/\\/g, '/');
    if (common && basename(common) === '.git') out = dirname(common);
  } catch { out = null; }
  cache.set(key, out);
  return out;
}

export function sanitizeLabel(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '').slice(0, 40);
  return LABEL_RE.test(s) ? s : null;
}

/**
 * Which projects have a project layer to load. A project is labelled either by
 * the user layer's environment.projects.<label>.paths, or (autoload, default
 * true) by the main worktree's folder name. Several worktrees of one repo map
 * to one main worktree and one label.
 * Returns { projects: [{label, mainWorktree, file, via}], skipped: [{cwd, reason}] }.
 */
export function discoverProjects({ cwds = [], environment = ENVIRONMENT_DEFAULTS, git, cache } = {}) {
  const envProjects = environment.projects || {};
  const autoload = envProjects.autoload !== false;
  const byPath = new Map();
  const configured = [];
  for (const [label, v] of Object.entries(envProjects)) {
    if (label === 'autoload' || !isObj(v)) continue;
    for (const p of v.paths || []) { byPath.set(normPath(p), label); configured.push({ cwd: p, label }); }
  }
  const found = new Map();
  const skipped = [];
  const note = (cwd, label, root, via) => {
    const prior = found.get(label);
    if (prior) {
      if (normPath(prior.mainWorktree) !== normPath(root)) skipped.push({ cwd, reason: `label "${label}" already used by another worktree` });
      return;
    }
    found.set(label, { label, mainWorktree: root, file: `${root}/.claude/agent-companion/usage-analysis.json`, via });
  };
  for (const { cwd, label } of configured) {
    const root = mainWorktreeOf(cwd, { git, cache }) || (existsSync(cwd) ? String(cwd).replace(/\\/g, '/') : null);
    if (root) note(cwd, label, root, 'configured'); else skipped.push({ cwd, reason: 'configured path does not exist' });
  }
  for (const cwd of cwds) {
    const root = mainWorktreeOf(cwd, { git, cache });
    if (!root) { skipped.push({ cwd, reason: 'not inside a git repository' }); continue; }
    const label = byPath.get(normPath(root)) || (autoload ? sanitizeLabel(basename(root)) : null);
    if (!label) { skipped.push({ cwd, reason: autoload ? 'folder name is not a usable label' : 'no label (autoload is off)' }); continue; }
    note(cwd, label, root, byPath.has(normPath(root)) ? 'configured' : 'autoload');
  }
  return { projects: [...found.values()], skipped };
}

// ----------------------------------------------------------------- loader --

export function userConfigPath(root) { return join(root, 'config', USER_FILE); }
export function invalidSignalPath(root) { return join(root, 'state', INVALID_SIGNAL_FILE); }

function loadLayer(layer, path, maxBytes, opts) {
  const r = readLayerFile(path, maxBytes);
  if (r.status === 'absent') return emptyLayer(layer, { path, label: opts.label || null, status: 'absent' });
  if (r.status === 'invalid') return emptyLayer(layer, { path, label: opts.label || null, status: 'invalid', errors: [{ path: '$', message: r.error }] });
  return validateLayer(r.raw, layer, { ...opts, path });
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Every problem across the layers (for `check` and the scout signal). */
export function problemsOf(layers) {
  const out = [];
  for (const rec of layers) {
    if (rec.status === 'absent') continue;
    if (rec.status !== 'ok') { out.push({ layer: layerName(rec), path: rec.path, kind: rec.status, messages: rec.errors.map((e) => e.message) }); continue; }
    if (rec.errors.length) out.push({ layer: layerName(rec), path: rec.path, kind: 'errors', messages: rec.errors.map((e) => `${e.path}: ${e.message}`) });
    if (rec.refusals.length) out.push({ layer: layerName(rec), path: rec.path, kind: 'refusals', messages: rec.refusals.map((e) => `${e.path}: ${e.message}`) });
  }
  return out;
}

/**
 * Load and resolve all three layers.
 *   root          state root (required; the CLI passes stateRootPath())
 *   cwds          session working directories seen (project discovery)
 *   shippedPath   test seam
 *   writeSignal   write/remove state/usage-analysis-config-invalid.json (default true)
 *   metrics       optional metric registry {id: {params:{defaults}}}; with it, an unknown metric is an error
 */
export function loadConfig({ root, cwds = [], shippedPath = SHIPPED_DEFAULTS_PATH, writeSignal = true, now = new Date(), metrics = null, git, cache } = {}) {
  if (!root) throw new Error('loadConfig: root is required');
  const shipped = loadLayer('shipped', shippedPath, CAPS.shippedBytes, { metrics });
  const user = loadLayer('user', userConfigPath(root), CAPS.userBytes, { metrics });
  let env = clone(ENVIRONMENT_DEFAULTS);
  if (shipped.status === 'ok' && shipped.environment) env = deepMerge(env, shipped.environment);
  if (user.status === 'ok' && user.environment) env = deepMerge(env, user.environment);
  const discovery = discoverProjects({ cwds, environment: env, git, cache });
  const projects = discovery.projects.map((p) => loadLayer('project', p.file, CAPS.projectBytes, { label: p.label, metrics }));
  const layers = [shipped, user, ...projects];
  const resolved = resolveLayers({ shipped, user, projects });
  const problems = problemsOf(layers);
  if (writeSignal) {
    try {
      const sp = invalidSignalPath(root);
      if (problems.length) writeAtomic(sp, `${JSON.stringify({ signal: 'usage_analysis_config_invalid', at: new Date(now).toISOString(), problems }, null, 2)}\n`);
      else if (existsSync(sp)) unlinkSync(sp);
    } catch { /* fail open: the marker is advisory */ }
  }
  return { shipped, user, projects, layers, resolved, problems, discovery };
}

// ---------------------------------------------------------- explain, list --

const fmt = (v) => JSON.stringify(v);

export function listScenarios(cfg) {
  const rows = [];
  for (const s of cfg.resolved.scenarios.values()) {
    rows.push({ id: s.id, layer: s.layer === 'project' ? `project ${s.label}` : s.layer, metric: s.metric, severity: s.def.severity, cadence: s.def.cadence, state: s.state, ...(s.gaps.length ? { why: s.gaps.join('; ') } : {}) });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function layerNotes(cfg, pred) {
  return cfg.layers.flatMap((rec) => [
    ...rec.refusals.map((x) => ({ ...x, kind: 'refusal' })),
    ...rec.errors.map((x) => ({ ...x, kind: 'error' })),
  ].filter((x) => pred(rec, x)).map((x) => ({ layer: layerName(rec), kind: x.kind, path: x.path, message: x.message })));
}

/** Per-field winning layer, shadowed values and refusals for one scenario id, or "environment[.path]". */
export function explain(cfg, id) {
  const r = cfg.resolved;
  if (id === 'environment' || id.startsWith('environment.')) {
    const sub = id === 'environment' ? '' : id.slice('environment.'.length);
    const fields = Object.entries(flatten(r.environment))
      .filter(([p]) => !sub || p === sub || p.startsWith(`${sub}.`))
      .map(([path, value]) => ({ path, value, source: r.envSources[path] || 'default' }));
    return { id, kind: 'environment', fields, refusals: layerNotes(cfg, (rec, x) => String(x.path).startsWith('environment')) };
  }
  const s = r.scenarios.get(id);
  const bare = id.replace(/^project:[^/]+\//, '');
  const notes = layerNotes(cfg, (rec, x) => x.id === bare && (!id.startsWith('project:') || id.startsWith(`project:${rec.label}/`)));
  if (!s) return { id, kind: 'missing', refusals: notes, message: `no scenario "${id}"` };
  const fields = Object.entries(s.fields).map(([path, f]) => ({ path, value: f.value, source: f.source, shadowed: f.shadowed }));
  return {
    id, kind: 'scenario', layer: s.layer === 'project' ? `project ${s.label}` : s.layer, metric: s.metric,
    state: s.state, gaps: s.gaps, params: s.def.params || {}, fields, refusals: notes, extra: s.extra,
  };
}

export function renderExplain(e) {
  if (e.kind === 'missing') return [e.message, ...e.refusals.map((x) => `  ${x.layer}: ${x.path} ${x.kind} (${x.message})`)].join('\n');
  const head = e.kind === 'environment'
    ? 'environment'
    : `${e.id}  [${e.layer}]  metric ${e.metric}  state ${e.state}${e.gaps?.length ? ` (${e.gaps.join('; ')})` : ''}`;
  const lines = [head];
  for (const f of e.fields) {
    // The generic threshold default is only worth naming when nothing more specific was shadowed.
    let shadowed = f.shadowed || [];
    if (shadowed.some((x) => x.source !== 'defaults.threshold')) shadowed = shadowed.filter((x) => x.source !== 'defaults.threshold');
    const sh = shadowed.length ? `; ${shadowed.map((x) => `${x.source} ${fmt(x.value)}`).join('; ')}` : '';
    lines.push(`  ${f.path} = ${fmt(f.value)} (${f.source}${sh})`);
  }
  for (const x of e.refusals) lines.push(`  ${x.layer}: ${x.path} ${x.kind} (${x.message})`);
  return lines.join('\n');
}
