// Decision register: standing decisions, the premises they rest on, and triggers
// that say "look at this decision again". Zero model calls, zero network: the
// register is a JSON file the operator keeps; this module only READS it, tests
// its triggers against data the plugin already collects, and records flags.
//
// Layout of this file (top to bottom):
//   1. constants and paths
//   2. validateRegister / loadRegister          (schema, every rule, never throws)
//   3. state file: read, atomic write, rev sync, seen-set, flags
//   4. changelog triggers: scanChangelog        (kind 'changelog', complete here)
//   5. EVALUATORS: dispatch by trigger kind     (changelog, metric catalog, exercise)
//   6. evaluateTriggers: folds evaluator verdicts into streaks, flags, seen-set
//   7. detail file writer
//   8. what the SessionStart hook calls: pendingFlags, pendingLine, markFlagsSurfaced
//   9. runRegister: the entry point the daily checkup calls
//
// Evaluator contract (section 5). An evaluator receives
//   { decision, trigger, key, history, spawnRows, nowT, state, activeFromMs }
// and returns one of
//   null                                no verdict: state untouched
//   { days: [{ day, qualifies, hit, value?, n? }, ...],   // ascending, one per checkup day
//     ready?: boolean,                  // false withholds a flag (baseline/post window not met)
//     value?, pre?, n? }                // last pooled value, pre pool, sample, for the line + detail
//   { events: [{ suffix, severity, summary, rows? }, ...] }  // flag-at-once facts (exercise)
// A day that does not qualify is a GAP: it neither adds to nor resets a streak. A qualifying
// day without a hit resets the streak. A flag fires when streak >= trigger.minDays (default 2)
// and ready !== false, once per episode (the seen key is "<decision>/<trigger>@<episodeStart>").
//
// Fail open everywhere: nothing here throws to a caller.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { configDir, stateFile as stateFilePath, telemetryDir, rolloutTable, rolloutStartMs, compareVersions } from '../../hooks/lib/context.mjs';
import { readHistory, checkupPaths, nowMs, SURFACE_MAX_AGE_MS, DAY_MS, DAY_OFFSET_MS, dayStartMs, dayKeyOf } from './daily-checkup.mjs';

// --- 1. constants and paths ------------------------------------------------------

export const REGISTER_SCHEMA = 'agent-companion/decision-register';
export const REGISTER_VERSION = 1;
export const STATE_VERSION = 1;
export const SEEN_CAP = 500;
export const SURFACED_CAP = 200;
export const FLAGS_CAP = 200;
export const OPEN_FLAG_DAYS = 30; // E: a flag older than this drops out of the detail file
export const LINE_MAX = 300;
export const ITEM_CHARS = 300;
export const DETAIL_ROWS = 5;
export const SPAWNS_MAX_BYTES = 32 * 1024 * 1024;
export { SURFACE_MAX_AGE_MS, nowMs };

export const TRIGGER_KINDS = ['changelog', 'metric', 'exercise'];
export const OPS = ['>', '<', '>=', '<='];
// The metric catalog: name -> the source it reads. Section 1.3 of the build spec.
export const METRIC_CATALOG = {
  unitsPerSpawn: 'history',
  mainUnitsPerDay: 'history',
  shareOver150kPct: 'history',
  compactionsPer100Spawns: 'history',
  ceilingNudgesPerDay: 'history',
  leadEffortShare: 'spawns',
  reviewsPerWriter: 'spawns',
  haikuSpawns: 'spawns',
};
// Evaluator-defined predicates on an exercise `where` (everything else is a raw row field).
const WHERE_PREDICATES = {
  declaredWriterModel: 'string',
  callerTypeIn: 'stringArray',
  callerTypeNotIn: 'stringArray',
  callerTypeKnown: 'boolean',
  repeatForSameCaller: 'boolean',
  subagentTypeStartsWith: 'string',
};

export function registerPath() { return join(configDir(), 'decision-register.json'); }
export function statePath() { return stateFilePath('decision-register-state.json'); }
export function detailPath() { return stateFilePath('decision-register-details.md'); }
export function spawnsPath() { return join(telemetryDir(), 'spawns.jsonl'); }

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.trim().length > 0;
const isInt = (x) => Number.isInteger(x);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmt = (x) => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : 'n/a');
const tkeyOf = (decisionId, triggerId) => `${decisionId}/${triggerId}`;

// --- 2. validation -----------------------------------------------------------------

// Compile a changelog pattern for .test(): g and y are dropped so lastIndex never leaks
// between items.
export function compilePattern(pattern, flags) {
  const f = String(flags || '').replace(/[gy]/g, '');
  return new RegExp(pattern, f);
}

function validateTrigger(t, where, decision, rollout, errors, premiseIds) {
  const err = (m) => errors.push(`${where}: ${m}`);
  if (!isObj(t)) { err('trigger must be an object'); return; }
  if (!isStr(t.id) || !KEBAB.test(t.id)) err(`trigger id must be kebab-case (got ${JSON.stringify(t.id)})`);
  if (!isStr(t.premise)) err('premise is required (a premise id of this decision)');
  else if (!premiseIds.has(t.premise)) err(`premise "${t.premise}" names no premise of this decision`);
  if (t.minDays !== undefined && !(isInt(t.minDays) && t.minDays >= 1)) err('minDays must be an integer >= 1');
  if (t.note !== undefined && typeof t.note !== 'string') err('note must be a string');
  const needsRollout = (why) => {
    if (!isStr(decision.rolloutId)) err(`${why} requires the decision to name a rolloutId`);
    else if (!Object.prototype.hasOwnProperty.call(rollout, decision.rolloutId)) err(`rolloutId "${decision.rolloutId}" is not in the rollout table (${why})`);
  };
  switch (t.kind) {
    case 'changelog': {
      if (!isStr(t.pattern)) err('pattern is required');
      else {
        try { compilePattern(t.pattern, t.flags); } catch (e) { err(`pattern does not compile: ${String((e && e.message) || e).slice(0, 120)}`); }
      }
      if (t.flags !== undefined && typeof t.flags !== 'string') err('flags must be a string');
      if (!isStr(t.sinceVersion) || compareVersions(t.sinceVersion, t.sinceVersion) === null) err('sinceVersion must be a version such as 2.1.296');
      if (t.minHits !== undefined && !(isInt(t.minHits) && t.minHits >= 1)) err('minHits must be an integer >= 1');
      break;
    }
    case 'metric': {
      if (!Object.prototype.hasOwnProperty.call(METRIC_CATALOG, t.metric)) err(`unknown metric ${JSON.stringify(t.metric)} (catalog: ${Object.keys(METRIC_CATALOG).join(', ')})`);
      else if (t.source !== METRIC_CATALOG[t.metric]) err(`metric ${t.metric} reads source "${METRIC_CATALOG[t.metric]}", not ${JSON.stringify(t.source)}`);
      if (!OPS.includes(t.op)) err(`op must be one of ${OPS.join(' ')}`);
      if (!Number.isFinite(t.threshold)) err('threshold must be a finite number');
      if (!(Number.isFinite(t.minSample) && t.minSample >= 0)) err('minSample must be a finite number >= 0');
      if (t.params !== undefined && !isObj(t.params)) err('params must be an object');
      const p = isObj(t.params) ? t.params : {};
      if (t.metric === 'unitsPerSpawn' && !(isStr(p.type) || isStr(p.rung))) err('unitsPerSpawn needs params.type or params.rung');
      if (t.metric === 'leadEffortShare' && !(Array.isArray(p.levels) && p.levels.length && p.levels.every(isStr))) err('leadEffortShare needs params.levels (non-empty list of effort names)');
      if (t.metric === 'reviewsPerWriter' && !isStr(p.writerType)) err('reviewsPerWriter needs params.writerType');
      if (t.baseline !== undefined) {
        const b = t.baseline;
        if (!isObj(b)) err('baseline must be an object');
        else {
          if (b.mode !== 'pre-window') err('baseline.mode must be "pre-window"');
          if (typeof b.ratio !== 'boolean') err('baseline.ratio must be true or false');
          if (b.preDays !== undefined && !(isInt(b.preDays) && b.preDays >= 1)) err('baseline.preDays must be an integer >= 1');
          if (!(Number.isFinite(b.minPerDay) && b.minPerDay >= 0)) err('baseline.minPerDay must be a finite number >= 0');
        }
        needsRollout('a baseline');
      }
      if (t.post !== undefined) {
        if (!isObj(t.post) || !(isInt(t.post.minDays) && t.post.minDays >= 1)) err('post.minDays must be an integer >= 1');
        if (t.baseline === undefined) needsRollout('a post window');
      }
      break;
    }
    case 'exercise': {
      if (t.source !== 'spawns') err('exercise source must be "spawns"');
      if (!(Number.isFinite(t.afterDays) && t.afterDays > 0)) err('afterDays must be a number > 0');
      if (!isObj(t.where)) err('where must be an object');
      else {
        for (const [k, v] of Object.entries(t.where)) {
          const want = WHERE_PREDICATES[k];
          if (want === 'string' && typeof v !== 'string') err(`where.${k} must be a string`);
          else if (want === 'boolean' && typeof v !== 'boolean') err(`where.${k} must be true or false`);
          else if (want === 'stringArray' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) err(`where.${k} must be a list of strings`);
          else if (!want && !['string', 'number', 'boolean'].includes(typeof v)) err(`where.${k} must be a string, number or boolean`);
        }
      }
      if (!isObj(t.expect)) err('expect must be an object (may be empty)');
      else for (const [k, v] of Object.entries(t.expect)) if (!['string', 'number', 'boolean'].includes(typeof v)) err(`expect.${k} must be a string, number or boolean`);
      needsRollout('an exercise trigger');
      break;
    }
    default:
      err(`unknown trigger kind ${JSON.stringify(t.kind)} (one of ${TRIGGER_KINDS.join(', ')})`);
  }
}

// { ok, errors[] }. Never throws. `rollout` is the id -> instant table (default: the live
// rolloutTable(); tests inject one).
export function validateRegister(obj, { rollout } = {}) {
  const errors = [];
  try {
    let table = rollout;
    if (!isObj(table)) { try { table = rolloutTable(); } catch { table = {}; } }
    if (!isObj(obj)) return { ok: false, errors: ['register must be a JSON object'] };
    if (obj.schema !== REGISTER_SCHEMA) errors.push(`schema must be "${REGISTER_SCHEMA}"`);
    if (obj.version !== REGISTER_VERSION) errors.push(`unsupported version ${JSON.stringify(obj.version)} (this plugin reads version ${REGISTER_VERSION})`);
    if (!Array.isArray(obj.decisions)) { errors.push('decisions must be a list'); return { ok: false, errors }; }
    const seenIds = new Set();
    obj.decisions.forEach((d, i) => {
      const tag = isObj(d) && isStr(d.id) ? `decision "${d.id}"` : `decisions[${i}]`;
      const err = (m) => errors.push(`${tag}: ${m}`);
      if (!isObj(d)) { err('must be an object'); return; }
      if (!isStr(d.id) || !KEBAB.test(d.id)) err(`id must be kebab-case (got ${JSON.stringify(d.id)})`);
      else if (seenIds.has(d.id)) err('duplicate decision id');
      else seenIds.add(d.id);
      if (!isStr(d.title)) err('title is required');
      else if (d.title.length > 60) err(`title is ${d.title.length} chars (max 60)`);
      if (!['active', 'retired'].includes(d.status)) err('status must be "active" or "retired"');
      if (!(typeof d.decided === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.decided))) err('decided must be a UTC date YYYY-MM-DD');
      if (!isStr(d.decision)) err('decision text is required');
      if (!isStr(d.reverse)) err('reverse text is required');
      if (d.rolloutId !== undefined && !isStr(d.rolloutId)) err('rolloutId must be a string');
      if (d.evidence !== undefined && !(Array.isArray(d.evidence) && d.evidence.every((x) => typeof x === 'string'))) err('evidence must be a list of path strings');
      const premiseIds = new Set();
      if (!Array.isArray(d.premises) || d.premises.length === 0) err('premises must be a non-empty list');
      else {
        d.premises.forEach((p, j) => {
          if (!isObj(p)) { err(`premises[${j}] must be an object`); return; }
          if (!isStr(p.id)) err(`premises[${j}] needs an id`);
          else if (premiseIds.has(p.id)) err(`duplicate premise id "${p.id}"`);
          else premiseIds.add(p.id);
          if (!isStr(p.text)) err(`premise "${p.id}" needs text`);
          if (!['M', 'E'].includes(p.label)) err(`premise "${p.id}" label must be M (measured) or E (estimated)`);
        });
      }
      if (!Array.isArray(d.triggers)) err('triggers must be a list');
      else {
        const tids = new Set();
        d.triggers.forEach((t, j) => {
          const where = `${tag} trigger ${isObj(t) && isStr(t.id) ? `"${t.id}"` : `[${j}]`}`;
          if (isObj(t) && isStr(t.id)) {
            if (tids.has(t.id)) errors.push(`${where}: duplicate trigger id within the decision`);
            tids.add(t.id);
          }
          validateTrigger(t, where, d, table, errors, premiseIds);
        });
      }
    });
  } catch (e) {
    errors.push(`validator failed: ${String((e && e.message) || e).slice(0, 160)}`);
  }
  return { ok: errors.length === 0, errors };
}

// Missing file -> { ok:false, absent:true } (silent). Unreadable or invalid -> { ok:false, errors }.
export function loadRegister(file = registerPath(), opts = {}) {
  try {
    if (!existsSync(file)) return { ok: false, absent: true };
    let obj;
    try { obj = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
      return { ok: false, errors: [`not valid JSON: ${String((e && e.message) || e).slice(0, 160)}`] };
    }
    const v = validateRegister(obj, opts);
    return v.ok ? { ok: true, register: obj } : { ok: false, errors: v.errors };
  } catch (e) {
    return { ok: false, errors: [`unreadable: ${String((e && e.message) || e).slice(0, 160)}`] };
  }
}

const activeDecisions = (register) => (register && Array.isArray(register.decisions) ? register.decisions.filter((d) => d && d.status === 'active') : []);

// Hash of a trigger's definition (the note is commentary and does not count). A changed
// rev means the rule was edited and is judged fresh.
export function triggerRev(trigger) {
  const { note, ...rest } = trigger || {};
  return createHash('sha1').update(stableJson(rest)).digest('hex').slice(0, 12);
}

// JSON with object keys sorted at every depth, so equal definitions hash equally.
function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x) ?? 'null';
}

// --- 3. the state file ---------------------------------------------------------------

export function emptyState() {
  return {
    v: STATE_VERSION, lastEvalDay: null, lastEvalAt: null, registerRev: null,
    triggers: {}, baselines: {}, changelogHits: {}, flags: {}, seen: [], surfaced: [],
  };
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
}

// A missing, corrupt or wrong-shaped file reads as an empty state; fields of the wrong type
// are replaced one by one.
export function readState(file = statePath()) {
  const base = emptyState();
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!isObj(j) || j.v !== STATE_VERSION) return base;
    for (const k of ['triggers', 'baselines', 'changelogHits', 'flags']) if (isObj(j[k])) base[k] = j[k];
    for (const k of ['seen', 'surfaced']) if (Array.isArray(j[k])) base[k] = j[k].filter((x) => typeof x === 'string');
    for (const k of ['lastEvalDay', 'lastEvalAt', 'registerRev']) if (typeof j[k] === 'string') base[k] = j[k];
  } catch { /* absent or corrupt: fresh state */ }
  return base;
}

export function writeState(state, file = statePath()) {
  try { atomicWrite(file, JSON.stringify(state, null, 1)); return true; } catch { return false; }
}

// Three writers share the state file (the detached checkup, the scout's changelog scan and the
// SessionStart hook) and none locks. A writer that read the file before another one wrote it
// would drop that writer's additions on its own write. snapshotState() records the keys present
// at read time; writeStateMerged() re-reads the file just before the write and carries over
// whatever another writer ADDED meanwhile (flags, hits, seen and surfaced keys), so a lost write
// can neither re-surface a line nor lose a seen key. Keys this writer deleted on purpose (a
// pruned flag, a cleared trigger) were in the snapshot, so they are not carried back.
export function snapshotState(state) {
  return {
    flags: new Set(Object.keys(state.flags)), changelogHits: new Set(Object.keys(state.changelogHits)),
    seen: new Set(state.seen), surfaced: new Set(state.surfaced),
  };
}

export function writeStateMerged(state, snap, file = statePath()) {
  try {
    const disk = readState(file);
    for (const k of ['flags', 'changelogHits']) {
      for (const key of Object.keys(disk[k])) if (!snap[k].has(key) && !(key in state[k])) state[k][key] = disk[k][key];
    }
    for (const k of ['seen', 'surfaced']) {
      for (const key of disk[k]) if (!snap[k].has(key) && !state[k].includes(key)) state[k].push(key);
    }
    state.seen = state.seen.slice(-SEEN_CAP);
    state.surfaced = state.surfaced.slice(-SURFACED_CAP);
  } catch { /* fall through: write what we have */ }
  return writeState(state, file);
}

export function markSeen(state, key) {
  if (!state.seen.includes(key)) state.seen.push(key);
  while (state.seen.length > SEEN_CAP) state.seen.shift();
}

function blankTrigger(rev) {
  return { rev, streak: 0, lastDay: null, episodeStart: null, value: null, pre: null, n: null, flagged: null, flagKey: null };
}

// Drop everything recorded for one trigger: streak, hits, flags, seen and surfaced keys.
function clearTrigger(state, tkey, rev) {
  state.triggers[tkey] = blankTrigger(rev);
  const pre = `${tkey}@`;
  for (const k of Object.keys(state.changelogHits)) if (k.startsWith(pre)) delete state.changelogHits[k];
  for (const k of Object.keys(state.flags)) if (k.startsWith(pre)) delete state.flags[k];
  state.seen = state.seen.filter((k) => !k.startsWith(pre));
  state.surfaced = state.surfaced.filter((k) => !k.startsWith(pre));
}

// Bring the state in line with the register: new triggers get a record, an edited trigger
// (rev changed) is cleared and judged fresh, entries for removed or retired decisions and
// removed triggers are dropped. Frozen baselines survive an edit (history prunes after 16
// days, so a recomputed pre-window could not be rebuilt); only a removal drops them.
export function syncState(state, register) {
  const live = new Set();
  for (const d of activeDecisions(register)) {
    for (const t of Array.isArray(d.triggers) ? d.triggers : []) {
      if (!t || !t.id) continue;
      const tkey = tkeyOf(d.id, t.id);
      live.add(tkey);
      const rev = triggerRev(t);
      const rec = state.triggers[tkey];
      if (!isObj(rec)) state.triggers[tkey] = blankTrigger(rev);
      else if (rec.rev !== rev) clearTrigger(state, tkey, rev);
    }
  }
  const keep = (k) => live.has(k.split('@')[0]);
  for (const k of Object.keys(state.triggers)) if (!live.has(k)) delete state.triggers[k];
  for (const k of Object.keys(state.baselines)) if (!live.has(k)) delete state.baselines[k];
  for (const k of Object.keys(state.changelogHits)) if (!keep(k)) delete state.changelogHits[k];
  for (const k of Object.keys(state.flags)) if (!keep(k)) delete state.flags[k];
  state.surfaced = state.surfaced.filter(keep).slice(-SURFACED_CAP);
  return state;
}

// Store a frozen pre-window baseline once; a later call for the same key is ignored.
// `baseline` = { days:[day keys], pooled, n }. Returns the stored baseline.
export function freezeBaseline(state, tkey, baseline, nowT = nowMs()) {
  if (!isObj(state.baselines[tkey])) {
    state.baselines[tkey] = { days: baseline.days || [], pooled: baseline.pooled, n: baseline.n, frozenAt: new Date(nowT).toISOString() };
  }
  return state.baselines[tkey];
}

// Record a flag (idempotent per key). The key is also the seen-set key.
function addFlag(state, key, info, nowT) {
  if (state.seen.includes(key) || state.flags[key]) return false;
  state.flags[key] = { ...info, key, at: new Date(nowT).toISOString(), day: isoDay(nowT), closed: null };
  markSeen(state, key);
  const keys = Object.keys(state.flags);
  if (keys.length > FLAGS_CAP) {
    keys.sort((a, b) => String(state.flags[a].at).localeCompare(String(state.flags[b].at)));
    for (const k of keys.slice(0, keys.length - FLAGS_CAP)) delete state.flags[k];
  }
  return true;
}

// --- 4. changelog triggers (kind 1) ----------------------------------------------------

// The part of a changelog item the pattern matched, with some context on each side, cut at word
// boundaries (CLAUSE_CHARS or fewer, "..." where cut). The SessionStart line shows this instead
// of the item's first characters, so it says what changed.
export const CLAUSE_CHARS = 72;
export function clauseAround(item, re) {
  const text = String(item).replace(/\s+/g, ' ').trim();
  let m = null;
  try { m = re.exec(text); } catch { m = null; }
  if (!m || text.length <= CLAUSE_CHARS) return text.slice(0, CLAUSE_CHARS);
  const mlen = Math.min(m[0].length, CLAUSE_CHARS);
  const pad = Math.min(Math.floor((CLAUSE_CHARS - mlen) / 2), 14); // little left context: the line is cut from the right
  let start = Math.max(0, m.index - pad);
  let end = Math.min(text.length, start + CLAUSE_CHARS);
  start = Math.max(0, end - CLAUSE_CHARS);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < m.index) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > m.index + mlen) end = sp; }
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

// `parsed` is parseChangelog() output: [{ version, items:[full text] }]. Tests EVERY item (not
// the topic-filtered ones) of releases strictly newer than sinceVersion. A hit is a fact: it
// flags at once, once per (trigger, release version). Returns the new flag keys.
export function scanChangelog(parsed, register, state, { nowT = nowMs() } = {}) {
  const fresh = [];
  try {
    syncState(state, register);
    const releases = Array.isArray(parsed) ? parsed : [];
    for (const d of activeDecisions(register)) {
      for (const t of Array.isArray(d.triggers) ? d.triggers : []) {
        if (!t || t.kind !== 'changelog') continue;
        let re;
        try { re = compilePattern(t.pattern, t.flags); } catch { continue; }
        const tkey = tkeyOf(d.id, t.id);
        const minHits = isInt(t.minHits) && t.minHits >= 1 ? t.minHits : 1;
        for (const r of releases) {
          if (!r || typeof r.version !== 'string' || !Array.isArray(r.items)) continue;
          if (compareVersions(r.version, t.sinceVersion) !== 1) continue;
          const key = `${tkey}@${r.version}`;
          if (state.changelogHits[key] || state.seen.includes(key)) continue;
          const matches = r.items.filter((it) => typeof it === 'string' && re.test(it));
          if (matches.length < minHits) continue;
          const item = matches[0].slice(0, ITEM_CHARS);
          const clause = clauseAround(matches[0], re);
          state.changelogHits[key] = { version: r.version, item, count: matches.length, firstSeen: new Date(nowT).toISOString(), flagged: isoDay(nowT) };
          const made = addFlag(state, key, {
            decision: d.id, title: d.title, trigger: t.id, premise: t.premise, kind: 'changelog', severity: 'changelog',
            summary: `"${clause}" in ${r.version}`, detail: { version: r.version, item, count: matches.length },
          }, nowT);
          if (made) fresh.push(key);
        }
      }
    }
  } catch { /* fail open */ }
  return fresh;
}

// --- 5. evaluators (dispatch by trigger kind) ------------------------------------------
// See the contract at the top of this file.

// Changelog hits are recorded at fetch time by scanChangelog (one fetch = one observation),
// not by a daily evaluation.
export function evalChangelog() { return null; }

const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const nonEmpty = (x) => (typeof x === 'string' && x.trim() !== '' ? x : null);
const dayStartOfKey = (day) => Date.parse(`${day}T00:00:00Z`) + DAY_OFFSET_MS; // a checkup day starts at 08:00Z
const PRE_LOOKBACK_DAYS = 8; // closed days looked at before the switch (spec 1.4)
const PRE_MIN_DAYS = 3; // a baseline needs at least this many qualifying pre days
const PER_DAY_TOTALS = new Set(['mainUnitsPerDay', 'ceilingNudgesPerDay']); // a limit-hit day is a gap for these

function cmp(v, op, thr) {
  switch (op) {
    case '>': return v > thr;
    case '<': return v < thr;
    case '>=': return v >= thr;
    case '<=': return v <= thr;
    default: return false;
  }
}

// Spawn rows with a parseable `at`, grouped by checkup day key.
function rowsByDay(spawnRows) {
  const by = new Map();
  for (const r of Array.isArray(spawnRows) ? spawnRows : []) {
    const ts = r && typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(ts)) continue;
    const k = dayKeyOf(dayStartMs(ts));
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return by;
}

// One checkup day of one metric: { num, den, scale, sample } (value = num/den*scale; sample =
// the day's n for minSample) or { gap:true }. A zero-unit day (usage lockout) is a gap, and so
// is a limit-hit day (history `limit.hits > 0`) for the per-day total metrics; ratio metrics
// keep a limit-hit day when it meets the sample.
function metricDayStat(t, rec, rows) {
  const p = isObj(t.params) ? t.params : {};
  if (rec) {
    const total = rec.units ? finite(rec.units.total) : null;
    if (total === 0) return { gap: true };
    if (PER_DAY_TOTALS.has(t.metric) && rec.limit && finite(rec.limit.hits) > 0) return { gap: true };
  }
  switch (t.metric) {
    case 'unitsPerSpawn': {
      if (!rec || !rec.spawns) return { gap: true };
      const cls = nonEmpty(p.type) ? (rec.spawns.byType || {})[p.type] : (rec.spawns.byRung || {})[p.rung];
      const units = cls ? finite(cls.units) : null;
      const n = cls ? finite(cls.n) : null;
      if (units === null || n === null || n <= 0) return { gap: true };
      return { num: units, den: n, scale: 1, sample: n };
    }
    case 'mainUnitsPerDay': {
      const main = rec && rec.units ? finite(rec.units.main) : null;
      const total = rec && rec.units ? finite(rec.units.total) : null;
      if (main === null || total === null) return { gap: true };
      return { num: main, den: 1, scale: 1, sample: total };
    }
    case 'shareOver150kPct': {
      const over = rec && rec.subagent ? finite(rec.subagent.unitsOver150k) : null;
      const sub = rec && rec.units ? finite(rec.units.subagent) : null;
      if (over === null || sub === null || sub <= 0) return { gap: true };
      return { num: over, den: sub, scale: 100, sample: sub };
    }
    case 'compactionsPer100Spawns': {
      const comp = rec && rec.subagent ? finite(rec.subagent.compactions) : null;
      const sp = rec && rec.spawns ? finite(rec.spawns.total) : null;
      if (comp === null || sp === null || sp <= 0) return { gap: true };
      return { num: comp, den: sp, scale: 100, sample: sp };
    }
    case 'ceilingNudgesPerDay': {
      const nud = rec ? finite(rec.ceilingNudges) : null;
      const sp = rec && rec.spawns ? finite(rec.spawns.total) : null;
      if (nud === null || sp === null) return { gap: true };
      return { num: nud, den: 1, scale: 1, sample: sp };
    }
    case 'leadEffortShare': {
      const lead = (rows || []).filter((r) => r.caller_is_subagent === false && nonEmpty(r.caller_effort));
      const levels = Array.isArray(p.levels) ? p.levels : [];
      const hit = lead.filter((r) => levels.includes(r.caller_effort)).length;
      return { num: hit, den: lead.length, scale: 1, sample: lead.length };
    }
    case 'reviewsPerWriter': {
      const reviews = (rows || []).filter((r) => r.declared_type === 'code-review' && nonEmpty(r.caller_tool_use_id)).length;
      const writers = (rows || []).filter((r) => r.declared_type === p.writerType).length;
      return { num: reviews, den: writers, scale: 1, sample: writers };
    }
    case 'haikuSpawns': {
      const all = rows || [];
      return { num: all.filter((r) => r.model === 'haiku').length, den: 1, scale: 1, sample: all.length };
    }
    default: return { gap: true };
  }
}

const qualifying = (ds, min) => !ds.gap && ds.den > 0 && ds.sample >= min;
const valueOf = (ds) => (ds.num / ds.den) * ds.scale;

// The metric catalog (spec 1.3) over the checkup history and spawns.jsonl, with the staged-change
// comparison of spec 1.4. Returns the days-style verdict of the contract, or null when it cannot
// judge (a baseline/post trigger whose rollout is unknown or not yet reached).
//   Without `baseline`: each qualifying day (sample >= minSample) is a hit when its value `op`
//   threshold. With `baseline` (pre-window, frozen once into state.baselines): a day's value is the
//   post window pooled up to and including that day, as a ratio to the pre pool when baseline.ratio
//   (else as an absolute); a day qualifies at baseline.minPerDay, in both windows, and minSample
//   is then the pooled post sample the flag needs. A flag waits (ready:false) for >= 3 pre days
//   and post.minDays (default 2) qualifying post days.
export function evalMetric(ctx) {
  try {
    const t = ctx && ctx.trigger;
    if (!isObj(t) || t.kind !== 'metric' || !Array.isArray(ctx.history)) return null;
    const { state, key, nowT } = ctx;
    const af = Number.isFinite(ctx.activeFromMs) ? ctx.activeFromMs : null;
    const staged = isObj(t.baseline) || isObj(t.post);
    if (staged && af === null) return null;
    if (isObj(t.baseline) && !(nowT >= af)) return null;

    // Day table, ascending. History metrics: history days. Spawns metrics: closed days of
    // either source (a history record, when there is one, supplies the gap rules).
    const recs = new Map();
    for (const r of ctx.history) if (r && typeof r.day === 'string') recs.set(r.day, r);
    const rows = t.source === 'spawns' ? rowsByDay(ctx.spawnRows) : new Map();
    const keys = new Set(recs.keys());
    if (t.source === 'spawns') for (const k of rows.keys()) if (dayStartOfKey(k) + DAY_MS <= nowT) keys.add(k);
    const stat = new Map();
    for (const k of [...keys].sort()) stat.set(k, metricDayStat(t, recs.get(k) || null, rows.get(k)));

    const minSample = finite(t.minSample) ?? 0;
    const b = isObj(t.baseline) ? t.baseline : null;
    const trec = state && state.triggers ? state.triggers[key] : null;

    if (!b) {
      const days = [];
      // Days before the switch (rollout) or, with no rollout, before the decision date are not
      // evidence about the decision (e.g. haiku spawns from before haiku was retired).
      const decidedMs = af === null && ctx.decision && typeof ctx.decision.decided === 'string' ? Date.parse(`${ctx.decision.decided}T00:00:00Z`) : NaN;
      for (const [k, ds] of stat) {
        if (af !== null && dayStartOfKey(k) < af) continue;
        if (Number.isFinite(decidedMs) && dayStartOfKey(k) < decidedMs) continue;
        if (!qualifying(ds, minSample)) { days.push({ day: k, qualifies: false, hit: false }); continue; }
        const v = valueOf(ds);
        days.push({ day: k, qualifies: true, hit: cmp(v, t.op, t.threshold), value: v, n: ds.sample });
      }
      const q = days.filter((d) => d.qualifies);
      const need = isObj(t.post) ? t.post.minDays : 1;
      const out = { days, ready: q.length >= need };
      if (q.length) { out.value = q[q.length - 1].value; out.n = q[q.length - 1].n; }
      return out;
    }

    // Staged comparison: freeze the pre window once.
    const minPer = finite(b.minPerDay) ?? 0;
    let base = state && state.baselines ? state.baselines[key] : null;
    if (!isObj(base)) {
      const s0 = dayStartMs(af);
      const cand = [...stat.keys()].filter((k) => {
        const s = dayStartOfKey(k);
        return s >= s0 - PRE_LOOKBACK_DAYS * DAY_MS && s + DAY_MS <= af;
      }).filter((k) => qualifying(stat.get(k), minPer));
      const pick = cand.slice(-(isInt(b.preDays) && b.preDays >= 1 ? b.preDays : 5));
      let sn = 0; let sd = 0; let ss = 0; let scale = 1;
      for (const k of pick) { const ds = stat.get(k); sn += ds.num; sd += ds.den; ss += ds.sample; scale = ds.scale; }
      const pooled = sd > 0 ? (sn / sd) * scale : null;
      if (pick.length < PRE_MIN_DAYS || pooled === null || (b.ratio && !(pooled > 0))) {
        if (trec) trec.baselineStatus = 'insufficient';
        return { days: [], ready: false };
      }
      base = freezeBaseline(state, key, { days: pick, pooled, n: ss }, nowT);
    }
    if (trec) delete trec.baselineStatus;
    if (!(base.days && base.days.length >= PRE_MIN_DAYS) || !Number.isFinite(base.pooled) || (b.ratio && !(base.pooled > 0))) {
      if (trec) trec.baselineStatus = 'insufficient';
      return { days: [], ready: false };
    }

    const days = [];
    let cn = 0; let cd = 0; let cs = 0; let last = null; let qDays = 0;
    for (const [k, ds] of stat) {
      if (dayStartOfKey(k) < af) continue;
      if (!qualifying(ds, minPer)) { days.push({ day: k, qualifies: false, hit: false }); continue; }
      cn += ds.num; cd += ds.den; cs += ds.sample; qDays += 1;
      const pooled = (cn / cd) * ds.scale;
      const x = b.ratio ? pooled / base.pooled : pooled;
      last = x;
      days.push({ day: k, qualifies: true, hit: cmp(x, t.op, t.threshold), value: x, n: cs });
    }
    const postNeed = isObj(t.post) ? t.post.minDays : 2;
    const out = { days, ready: qDays >= postNeed && cs >= minSample, pre: base.pooled, n: cs };
    if (last !== null) out.value = last;
    return out;
  } catch { return null; }
}

// Exercise triggers (spec 2.4, 4.3) over spawns.jsonl rows at or after the rollout instant.
// Outcomes: `wrong` (flag at once on the first matching row whose `expect` differs) and
// `unexercised` (no matching row once now >= activeFrom + afterDays; flagged once, and closed
// again if a matching row shows up later).
export function matchesWhere(row, where, ctx = {}) {
  for (const [k, v] of Object.entries(isObj(where) ? where : {})) {
    switch (k) {
      case 'declaredWriterModel': {
        const w = String(row.declared_writer || '');
        if (!(w === v || w.startsWith(`${v}/`))) return false;
        break;
      }
      case 'callerTypeIn': if (!v.includes(row.caller_declared_type)) return false; break;
      case 'callerTypeNotIn': if (v.includes(row.caller_declared_type)) return false; break;
      case 'callerTypeKnown': if ((nonEmpty(row.caller_declared_type) !== null) !== v) return false; break;
      case 'subagentTypeStartsWith': {
        const eff = String(row.subagent_type_rewritten_to || row.subagent_type || '');
        if (!eff.startsWith(v)) return false;
        break;
      }
      case 'repeatForSameCaller': {
        const id = nonEmpty(row.caller_tool_use_id);
        const rep = row.declared_type === 'code-review' && id !== null && (ctx.reviewCounts?.get(id) || 0) >= 2;
        if (rep !== v) return false;
        break;
      }
      default: if (row[k] !== v) return false;
    }
  }
  return true;
}

export function evalExercise(ctx) {
  try {
    const t = ctx && ctx.trigger;
    if (!isObj(t) || t.kind !== 'exercise' || !Array.isArray(ctx.spawnRows)) return null;
    const af = Number.isFinite(ctx.activeFromMs) ? ctx.activeFromMs : null;
    if (af === null || !(ctx.nowT >= af)) return null;
    const after = ctx.spawnRows.filter((r) => {
      const ts = r && typeof r.at === 'string' ? Date.parse(r.at) : NaN;
      return Number.isFinite(ts) && ts >= af;
    });
    const reviewCounts = new Map();
    for (const r of after) {
      const id = r.declared_type === 'code-review' ? nonEmpty(r.caller_tool_use_id) : null;
      if (id) reviewCounts.set(id, (reviewCounts.get(id) || 0) + 1);
    }
    const hits = after.filter((r) => matchesWhere(r, t.where, { reviewCounts }));
    const expect = isObj(t.expect) ? t.expect : {};
    const wrongOf = (r) => Object.entries(expect).find(([f, want]) => r[f] !== want);
    const wrong = hits.filter((r) => wrongOf(r));
    const events = [];
    const uKey = `${ctx.key}@unexercised`;
    if (hits.length && ctx.state && ctx.state.flags && ctx.state.flags[uKey] && !ctx.state.flags[uKey].closed) {
      ctx.state.flags[uKey].closed = new Date(ctx.nowT).toISOString().slice(0, 10);
    }
    if (wrong.length) {
      const [field, want] = wrongOf(wrong[0]);
      events.push({
        suffix: `wrong-${wrong[0].at}`, severity: 'wrong',
        summary: `${field} ${wrong[0][field] === undefined ? '(none)' : wrong[0][field]} not ${want} (${wrong.length} row${wrong.length === 1 ? '' : 's'})`,
        rows: wrong.slice(0, DETAIL_ROWS),
      });
    }
    if (!hits.length && ctx.nowT >= af + t.afterDays * DAY_MS) {
      events.push({ suffix: 'unexercised', severity: 'unexercised', summary: `unexercised after ${t.afterDays} days` });
    }
    return { events };
  } catch { return null; }
}

export const EVALUATORS = { changelog: evalChangelog, metric: evalMetric, exercise: evalExercise };

// --- 6. folding verdicts into streaks, flags and the seen-set -----------------------------

// Fold ascending day observations into a trigger record. Only qualifying days newer than
// rec.lastDay count; a non-qualifying day is a gap. Returns true when a streak was reset.
export function foldDays(rec, days) {
  let reset = false;
  for (const d of Array.isArray(days) ? days : []) {
    if (!d || typeof d.day !== 'string' || !d.qualifies) continue;
    if (rec.lastDay && d.day <= rec.lastDay) continue;
    rec.lastDay = d.day;
    if (Number.isFinite(d.value)) rec.value = d.value;
    if (Number.isFinite(d.n)) rec.n = d.n;
    if (d.hit) {
      if (!rec.streak) rec.episodeStart = d.day;
      rec.streak = (rec.streak || 0) + 1;
    } else {
      if (rec.streak) reset = true;
      rec.streak = 0;
      rec.episodeStart = null;
    }
  }
  return reset;
}

function metricSummary(t, rec) {
  return `${t.metric} ${fmt(rec.value)} vs ${t.op} ${fmt(t.threshold)} over ${rec.streak} days (n=${rec.n === null ? 'n/a' : fmt(rec.n)})`;
}

// Run every active trigger's evaluator and fold the verdicts into `state`. Pure over its
// inputs (no I/O). Returns { newFlags: [key, ...] }.
export function evaluateTriggers({ register, history = [], spawnRows = [], nowT = nowMs(), state, evaluators = EVALUATORS }) {
  const newFlags = [];
  syncState(state, register);
  for (const d of activeDecisions(register)) {
    for (const t of Array.isArray(d.triggers) ? d.triggers : []) {
      try {
        if (!t || !t.id) continue;
        const fn = evaluators[t.kind];
        if (typeof fn !== 'function') continue;
        const tkey = tkeyOf(d.id, t.id);
        const rec = state.triggers[tkey];
        const ms = d.rolloutId ? rolloutStartMs(d.rolloutId) : null;
        const v = fn({ decision: d, trigger: t, key: tkey, history, spawnRows, nowT, state, activeFromMs: Number.isFinite(ms) ? ms : null });
        if (!isObj(v)) continue;
        if (Array.isArray(v.days)) {
          const reset = foldDays(rec, v.days);
          if (Number.isFinite(v.value)) rec.value = v.value;
          if (Number.isFinite(v.pre)) rec.pre = v.pre;
          if (Number.isFinite(v.n)) rec.n = v.n;
          if (reset && rec.flagKey && state.flags[rec.flagKey]) { state.flags[rec.flagKey].closed = isoDay(nowT); rec.flagKey = null; rec.flagged = null; }
          const need = isInt(t.minDays) && t.minDays >= 1 ? t.minDays : 2;
          if (rec.streak >= need && v.ready !== false && rec.episodeStart) {
            const key = `${tkey}@${rec.episodeStart}`;
            const made = addFlag(state, key, {
              decision: d.id, title: d.title, trigger: t.id, premise: t.premise, kind: t.kind, severity: 'metric',
              summary: metricSummary(t, rec),
              detail: { metric: t.metric, op: t.op, threshold: t.threshold, value: rec.value, pre: rec.pre, n: rec.n, days: rec.streak, episodeStart: rec.episodeStart },
            }, nowT);
            if (made) { rec.flagged = isoDay(nowT); rec.flagKey = key; newFlags.push(key); }
          }
        }
        if (Array.isArray(v.events)) {
          for (const e of v.events) {
            if (!e || typeof e.suffix !== 'string') continue;
            const key = `${tkey}@${e.suffix}`;
            const made = addFlag(state, key, {
              decision: d.id, title: d.title, trigger: t.id, premise: t.premise, kind: t.kind,
              severity: e.severity === 'wrong' ? 'wrong' : 'unexercised',
              summary: String(e.summary || e.suffix).slice(0, 200),
              detail: { afterDays: t.afterDays, rows: Array.isArray(e.rows) ? e.rows.slice(0, DETAIL_ROWS) : [] },
            }, nowT);
            if (made) { rec.flagged = isoDay(nowT); rec.flagKey = key; newFlags.push(key); }
          }
        }
      } catch { /* one bad trigger never stops the rest */ }
    }
  }
  return { newFlags };
}

// --- 7. the detail file -----------------------------------------------------------------

const TRIGGER_DESC = (t) => {
  if (!t) return '(trigger no longer in the register)';
  if (t.kind === 'changelog') return `changelog, pattern /${t.pattern}/${t.flags || ''}, newer than ${t.sinceVersion}`;
  if (t.kind === 'metric') return `metric ${t.metric} ${t.op} ${t.threshold} (minSample ${t.minSample}, minDays ${t.minDays || 2})`;
  return `exercise, after ${t.afterDays} days, where ${JSON.stringify(t.where)}, expect ${JSON.stringify(t.expect)}`;
};

// Flags that count as open now: not closed, fresh enough, decision still active.
export function openFlags(state, register, nowT = nowMs()) {
  const active = new Map(activeDecisions(register).map((d) => [d.id, d]));
  return Object.values(state.flags || {}).filter((f) => {
    if (!f || f.closed || !active.has(f.decision)) return false;
    const at = Date.parse(f.at);
    return Number.isFinite(at) && nowT - at <= OPEN_FLAG_DAYS * DAY_MS;
  });
}

export function detailMarkdown(state, register, nowT = nowMs()) {
  const flags = openFlags(state, register, nowT);
  if (!flags.length) return null;
  const order = new Map(activeDecisions(register).map((d, i) => [d.id, i]));
  const byDecision = new Map();
  for (const f of flags) { if (!byDecision.has(f.decision)) byDecision.set(f.decision, []); byDecision.get(f.decision).push(f); }
  const out = ['# Decision register: reviews due', '', `Written ${new Date(nowT).toISOString()}. No model call has been made to produce this file.`, ''];
  for (const id of [...byDecision.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    const d = activeDecisions(register).find((x) => x.id === id);
    out.push(`## ${d.title} (${d.id})`, '', `- Status: ${d.status}, decided ${d.decided}`, `- Decision: ${d.decision}`, `- To reverse: ${d.reverse}`, '');
    for (const f of byDecision.get(id)) {
      const t = (d.triggers || []).find((x) => x && x.id === f.trigger);
      const p = (d.premises || []).find((x) => x && x.id === f.premise);
      out.push(`### Trigger ${f.trigger} (${f.kind}, ${f.severity}), flagged ${f.day}`, '');
      if (p) out.push(`- Premise ${p.id} [${p.label}]: ${p.text}`);
      out.push(`- Trigger: ${TRIGGER_DESC(t)}`, `- What happened: ${f.summary}`);
      const x = f.detail || {};
      if (f.kind === 'changelog') out.push(`- Matched changelog item (${x.version}, ${x.count} matching item(s)): ${x.item}`);
      if (f.kind === 'metric') out.push(`- Value ${fmt(x.value)}, pre pool ${fmt(x.pre)}, sample n=${x.n === null || x.n === undefined ? 'n/a' : fmt(x.n)}, ${x.days} qualifying day(s) since ${x.episodeStart}`);
      if (Array.isArray(x.rows) && x.rows.length) {
        out.push('- Offending spawn rows (up to 5):');
        for (const r of x.rows.slice(0, DETAIL_ROWS)) out.push(`  - at ${r.at}, subagent_type ${r.subagent_type}, effective_effort ${r.effective_effort}, caller_declared_type ${r.caller_declared_type || '(none)'}`);
      }
      out.push('');
    }
    if (Array.isArray(d.evidence) && d.evidence.length) { out.push('Evidence:', ...d.evidence.map((e) => `- ${e}`), ''); }
    out.push('To review, ask for one worker on this file (no model call has been made).', '');
  }
  const thin = Object.entries(state.triggers || {}).filter(([k, r]) => r && r.baselineStatus === 'insufficient' && order.has(k.split('/')[0])).map(([k]) => k);
  if (thin.length) out.push('Baselines not usable yet (fewer than 3 qualifying pre-switch days, so these triggers stay silent): ' + thin.join(', '), '');
  return out.join('\n');
}

// Writes the file when a flag is open; removes it when none is. Returns the path or null.
export function writeDetail(state, register, file = detailPath(), nowT = nowMs()) {
  try {
    const md = detailMarkdown(state, register, nowT);
    if (md === null) { try { unlinkSync(file); } catch { /* absent */ } return null; }
    atomicWrite(file, md);
    return file;
  } catch { return null; }
}

// --- 8. what the SessionStart hook calls -------------------------------------------------

const SEVERITY_RANK = { wrong: 0, metric: 1, changelog: 2, unexercised: 3 };

// Unsurfaced open flags, fresh within 72 h, ordered: wrong > metric > changelog > unexercised,
// then by decision order in the register.
export function pendingFlags({ state, register, nowT = nowMs() }) {
  const order = new Map(activeDecisions(register).map((d, i) => [d.id, i]));
  const shown = new Set(state.surfaced || []);
  return openFlags(state, register, nowT)
    .filter((f) => !shown.has(f.key) && nowT - Date.parse(f.at) <= SURFACE_MAX_AGE_MS)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
      || (order.get(a.decision) ?? 0) - (order.get(b.decision) ?? 0) || String(a.at).localeCompare(String(b.at)));
}

// One line, LINE_MAX chars or fewer in total. The path is the last element; the head is
// truncated with "..." to make room.
export function formatRegisterLine(flags, detailFile) {
  const f = flags[0];
  const more = flags.length > 1 ? ` +${flags.length - 1} more.` : '';
  let tail = ` Details: ${detailFile}`;
  if (tail.length > 150) tail = ` Details: ...${String(detailFile).slice(-130)}`;
  const lead = `[agent-companion] Decision review due: ${f.title} (${f.decision}), premise ${f.premise} hit: `;
  const end = `.${more}`;
  const room = LINE_MAX - tail.length;
  // Shorten the trigger summary first; only a lead that is itself too long is cut.
  const sumRoom = room - lead.length - end.length;
  let head;
  if (String(f.summary).length <= sumRoom) head = `${lead}${f.summary}${end}`;
  else if (sumRoom >= 12) head = `${lead}${String(f.summary).slice(0, sumRoom - 3)}...${end}`;
  else head = `${lead}${f.summary}${end}`.slice(0, Math.max(0, room - 3)) + '...';
  return `${head}${tail}`;
}

// { line, keys, count } or null. Reads only the state file and the (small) register; no scan,
// no network. keys = the flag key the line shows (mark it with markFlagsSurfaced, last, so a
// hook that dies has not marked anything). The other pending flags stay unsurfaced and show
// on later session starts.
export function pendingLine({ nowT = nowMs(), stateFile = statePath(), registerFile = registerPath(), detailFile = detailPath() } = {}) {
  try {
    const loaded = loadRegister(registerFile);
    if (!loaded.ok) return null;
    const state = readState(stateFile);
    const flags = pendingFlags({ state, register: loaded.register, nowT });
    if (!flags.length) return null;
    return { line: formatRegisterLine(flags, detailFile), keys: [flags[0].key], count: flags.length };
  } catch { return null; }
}

export function markFlagsSurfaced(keys, stateFile = statePath()) {
  try {
    const state = readState(stateFile);
    const snap = snapshotState(state);
    for (const k of keys || []) if (typeof k === 'string' && !state.surfaced.includes(k)) state.surfaced.push(k);
    state.surfaced = state.surfaced.slice(-SURFACED_CAP);
    return writeStateMerged(state, snap, stateFile);
  } catch { return false; }
}

// --- 9. the entry point the daily checkup calls ----------------------------------------------

// Rows of spawns.jsonl; corrupt lines are skipped; a file over SPAWNS_MAX_BYTES is read from
// its tail.
export function readSpawnRows(file = spawnsPath()) {
  try {
    const size = statSync(file).size;
    let text;
    if (size <= SPAWNS_MAX_BYTES) text = readFileSync(file, 'utf8');
    else {
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(SPAWNS_MAX_BYTES);
        readSync(fd, buf, 0, SPAWNS_MAX_BYTES, size - SPAWNS_MAX_BYTES);
        text = buf.toString('utf8').split('\n').slice(1).join('\n');
      } finally { closeSync(fd); }
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (isObj(j)) rows.push(j); } catch { /* corrupt row: skipped */ }
    }
    return rows;
  } catch { return []; }
}

// The scout's changelog hook (release-watch `onParsed`): scan a freshly parsed changelog and
// record the hits, without evaluating the metric triggers (no history or spawns read). Writes
// the state and the detail file only when a new flag appeared. Never throws.
export function scanChangelogToState(parsed, { nowT = nowMs(), registerFile, stateFile, detailFile } = {}) {
  try {
    const loaded = loadRegister(registerFile || registerPath());
    if (!loaded.ok) return { ok: false };
    const sFile = stateFile || statePath();
    const state = readState(sFile);
    const snap = snapshotState(state);
    const fresh = scanChangelog(parsed, loaded.register, state, { nowT });
    if (fresh.length) {
      writeStateMerged(state, snap, sFile);
      writeDetail(state, loaded.register, detailFile || detailPath(), nowT);
    }
    return { ok: true, newFlags: fresh };
  } catch { return { ok: false }; }
}

// Loads the register, evaluates, writes the state and the detail file. Never throws.
// Skips when nothing is new: same latest history day, same register, no fresh changelog
// (`parsed`) and no `force`. Returns a small summary.
export function runRegister({
  nowT = nowMs(), historyFile, spawnsFile, registerFile, stateFile, detailFile, parsed = null, force = false, evaluators = EVALUATORS,
} = {}) {
  try {
    const loaded = loadRegister(registerFile || registerPath());
    if (!loaded.ok) return loaded.absent ? { ok: false, absent: true } : { ok: false, invalid: true, errors: loaded.errors };
    const register = loaded.register;
    const sFile = stateFile || statePath();
    const state = readState(sFile);
    const snap = snapshotState(state);
    const history = readHistory(historyFile || checkupPaths().history);
    const lastDay = history.length ? history[history.length - 1].day : null;
    const regRev = createHash('sha1').update(stableJson(register)).digest('hex').slice(0, 12);
    if (!force && !parsed && lastDay === state.lastEvalDay && regRev === state.registerRev) return { ok: true, skipped: 'nothing new' };
    const fresh = parsed ? scanChangelog(parsed, register, state, { nowT }) : [];
    const spawnRows = readSpawnRows(spawnsFile || spawnsPath());
    const { newFlags } = evaluateTriggers({ register, history, spawnRows, nowT, state, evaluators });
    state.lastEvalDay = lastDay;
    state.lastEvalAt = new Date(nowT).toISOString();
    state.registerRev = regRev;
    writeStateMerged(state, snap, sFile);
    const detail = writeDetail(state, register, detailFile || detailPath(), nowT);
    return { ok: true, evaluated: true, newFlags: [...fresh, ...newFlags], open: openFlags(state, register, nowT).length, detail };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}
