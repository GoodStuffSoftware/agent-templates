// usage/cohort.mjs: records, the cohort filter and exclusions of the daily usage analysis
// (design section 3.2: `cohort`, `excludeSets`, `exclusions`, `scope: "tree"`).
//
// RECORDS. A record is a plain object with a `kind` and a `sid`. The session records built here
// from a facts day file (one per session, rows pooled over the hours asked for):
//   { kind:'session', sid, proj, cwd, hours, tok:{model:{m,s}}, pr, ag, sm, gc,
//     models:[main-thread models], model:<dominant main model>, units:{main, sub, total} }
// Facts hold the workers' tokens inside their lead's row (tok[model].s), so a session record
// already carries its tree. Fields facts do not hold come from hooks, never from a guess:
//   hooks.sessionAttrs(record) -> { class, title, routineId, hasDesktopRecord, effortObserved, ... }
//   hooks.spawnRecords(day, range) -> spawn records (batch 2b): { kind:'spawn', sid, rung, declaredType,
//                                      role, effort, fit, model, ... }   (the spawn hook)
// A field nobody supplied is `undefined`, which means UNOBSERVABLE: a record whose cohort field is
// undefined is never matched and is counted, and a cohort on a field no record has at all is a gap
// that names the hook. An exclusion that cannot be evaluated does not exclude (it is counted too).
//
// EXCLUSIONS. A selector kind is OR within its list and AND across kinds. scope:
//   tree    the matched session record is removed whole (main thread and workers), and so is every
//           other record of that sid (its spawn records)
//   session (default) only the session's own main thread goes: its main tokens, prompts and counts
//           are zeroed, its workers (tok[model].s and spawn records) stay
// Exclusions apply to cohort scenarios only. day.units, week.pace and meter.reconcile always count
// everything (COUNTS_EVERYTHING); day.excludedShare reports what each rule removed.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRung } from './rung.mjs';
import { hasTerm, unitsFromTokens, FACTS_SCHEMA, FACTS_VERSION } from './facts.mjs';

// day.excludedShare applies the resolved exclusions itself (it reports what each removed), so the provider must not.
export const COUNTS_EVERYTHING = new Set(['day.units', 'week.pace', 'meter.reconcile', 'day.excludedShare']);
export const SPAWN_FIELDS = Object.freeze(['rung', 'declaredType', 'role', 'effort', 'fit']);
export const SPAWN_HOOK = 'hooks.spawnRecords';
const MAX_FACTS_BYTES = 64 * 1024 * 1024;
const RESERVED = new Set(['kind', 'sid', 'tok', 'units', 'byModel', 'pr', 'models', 'model']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ facts reading --

export function factsFilePath(root, day) { return join(root, 'state', 'usage-facts', `${day}.json`); }

/** Read one day's facts file below `root`. { facts } or { gap: true, why }. A missing day is a gap, never zero. */
export function readFactsDay(root, day) {
  const file = factsFilePath(root, day);
  let size;
  try { size = statSync(file).size; } catch { return { gap: true, why: `no facts for ${day}` }; }
  if (size > MAX_FACTS_BYTES) return { gap: true, why: `facts file for ${day} is larger than ${MAX_FACTS_BYTES} bytes` };
  let f;
  try { f = JSON.parse(readFileSync(file, 'utf8')); } catch { return { gap: true, why: `facts for ${day} are unreadable` }; }
  if (!isObj(f) || f.schema !== FACTS_SCHEMA || !Array.isArray(f.rows)) return { gap: true, why: `facts for ${day} are not a facts file` };
  if (!(f.factsVersion <= FACTS_VERSION)) return { gap: true, why: `facts for ${day} are version ${f.factsVersion}, newer than this reader (${FACTS_VERSION})` };
  return { facts: f };
}

const zeroT = () => [0, 0, 0, 0, 0, 0];

/**
 * Session records from a facts file. `range` { fromMs, toMs } keeps only rows whose hour lies in
 * [fromMs, toMs) (a window that starts mid-day); omit it for the whole day. Sorted by sid.
 * `weights` maps model -> multiplier replacing the recorded one (units recompute, no rescan).
 */
export function sessionRecords(facts, { range = null, hooks = {}, weights = {} } = {}) {
  const used = facts.weightsUsed || {};
  const bySid = new Map();
  for (const row of facts.rows) {
    const hourMs = Date.parse(row.hour);
    if (!Number.isFinite(hourMs)) continue;
    if (range && !(hourMs >= range.fromMs && hourMs < range.toMs)) continue;
    let r = bySid.get(row.sid);
    if (!r) {
      r = { kind: 'session', sid: row.sid, proj: row.proj || null, cwd: row.cwd || null, hours: 0, tok: {}, pr: { n: 0, len: [0, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0 };
      bySid.set(row.sid, r);
    }
    if (!r.proj && row.proj) r.proj = row.proj;
    if (!r.cwd && row.cwd) r.cwd = row.cwd;
    r.hours += 1;
    for (const [model, mt] of Object.entries(row.tok || {})) {
      const t = (r.tok[model] ||= { m: zeroT(), s: zeroT() });
      for (let i = 0; i < 6; i += 1) { t.m[i] += (mt.m && mt.m[i]) || 0; t.s[i] += (mt.s && mt.s[i]) || 0; }
    }
    if (row.pr) {
      r.pr.n += row.pr.n || 0; r.pr.corr += row.pr.corr || 0;
      for (let i = 0; i < 4; i += 1) r.pr.len[i] += (row.pr.len && row.pr.len[i]) || 0;
    }
    r.ag += row.ag || 0; r.sm += row.sm || 0; r.gc += row.gc || 0;
  }
  const out = [...bySid.values()].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  for (const r of out) {
    finishRecord(r, used, weights);
    if (typeof hooks.sessionAttrs === 'function') {
      const attrs = hooks.sessionAttrs(r);
      if (isObj(attrs)) for (const [k, v] of Object.entries(attrs)) if (!RESERVED.has(k) && v !== undefined) r[k] = v;
    }
  }
  return out;
}

// units and the model list of a session record, from its tokens
function finishRecord(r, used, weights) {
  let main = 0; let sub = 0;
  const mainUnits = {};
  const byModel = {};
  for (const [model, mt] of Object.entries(r.tok)) {
    const spec = used[model];
    const mult = Object.prototype.hasOwnProperty.call(weights, model) ? weights[model] : undefined;
    const um = unitsFromTokens(mt.m, spec, mult);
    const us = unitsFromTokens(mt.s, spec, mult);
    main += um; sub += us;
    byModel[model] = { m: um, s: us };
    if (mt.m.some((x) => x > 0)) mainUnits[model] = um;
  }
  r.units = { main, sub, total: main + sub };
  r.byModel = byModel; // units per model: main thread (m) and workers (s)
  r.models = Object.keys(mainUnits).sort();
  r.model = r.models.slice().sort((a, b) => mainUnits[b] - mainUnits[a] || (a < b ? -1 : 1))[0];
}

/**
 * The loader a scenario provider calls: loadDay(day, range?) -> { records } | { gap, why }.
 * Session records come from the facts file; spawn records from hooks.spawnRecords (the batch 2b
 * hook, optional) and inherit missing class/proj/title/routineId from the session of the same sid.
 * Facts files are parsed once.
 */
export function makeFactsLoader({ root, hooks = {}, weights = {} }) {
  const cache = new Map();
  return function loadDay(day, range = null) {
    if (!cache.has(day)) cache.set(day, readFactsDay(root, day));
    const f = cache.get(day);
    if (f.gap) return f;
    const sessions = sessionRecords(f.facts, { range, hooks, weights });
    let spawns = [];
    if (typeof hooks.spawnRecords === 'function') {
      const bySid = new Map(sessions.map((s) => [s.sid, s]));
      spawns = (hooks.spawnRecords(day, range) || []).filter(isObj).map((x) => {
        const s = bySid.get(x.sid);
        const rec = { kind: 'spawn', ...x };
        if (s) for (const k of ['proj', 'class', 'title', 'routineId', 'effortObserved']) if (rec[k] === undefined && s[k] !== undefined && s[k] !== null) rec[k] = s[k];
        if (rec.model !== undefined && rec.models === undefined) rec.models = [rec.model];
        return rec;
      });
    }
    // Day records (hooks.dayRecords): one per day with the history record, the plan-meter sample and the hourly units.
    // Day-level metrics read them (recordKinds ['day']); session metrics never see them.
    let days = [];
    if (typeof hooks.dayRecords === 'function') days = (hooks.dayRecords(day, range) || []).filter(isObj).map((x) => ({ kind: 'day', sid: '(day)', ...x }));
    // Telemetry rows (hooks.telemetryRecords) and scheduled-run records (hooks.routineRecords), batch 6b: day-level, never pooled
    // into sessions. A hook that is not wired adds nothing, and the metric that needs them says so.
    const extra = [];
    for (const name of ['telemetryRecords', 'routineRecords']) {
      if (typeof hooks[name] === 'function') extra.push(...(hooks[name](day, range) || []).filter(isObj));
    }
    return { records: [...sessions, ...spawns, ...days, ...extra] };
  };
}

// ------------------------------------------------------------------ matching --

const globRe = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

function matchModels(globs, models) {
  if (!models || !models.length) return null;
  const pos = globs.filter((g) => !g.startsWith('!')).map(globRe);
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => globRe(g.slice(1)));
  if (models.some((m) => neg.some((re) => re.test(m)))) return false;
  return pos.length ? models.some((m) => pos.some((re) => re.test(m))) : true;
}

export function familyOf(model) {
  const m = String(model || '').toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f;
  return null;
}

const oneOf = (list, v) => (v === undefined || v === null ? null : list.map(String).includes(String(v)));

/** Is `field` of a cohort or exclusion satisfied by `rec`? true | false | null (unobservable). */
export function matchField(field, list, rec) {
  switch (field) {
    case 'class': return oneOf(list, rec.class);
    case 'project': return oneOf(list, rec.proj);
    case 'model': return matchModels(list, rec.models || (rec.model ? [rec.model] : null));
    case 'modelFamily': {
      const fams = (rec.models || (rec.model ? [rec.model] : [])).map(familyOf).filter(Boolean);
      return fams.length ? fams.some((f) => list.includes(f)) : null;
    }
    case 'rung': return oneOf(list.map(normalizeRung), rec.rung === undefined || rec.rung === null ? rec.rung : normalizeRung(rec.rung));
    case 'declaredType': case 'role': case 'effort': case 'effortObserved': case 'fit': case 'routineId':
      return oneOf(list, rec[field]);
    case 'sessionId': return typeof rec.sid === 'string' ? list.some((p) => rec.sid.toLowerCase().startsWith(String(p).toLowerCase())) : null;
    case 'titleAny': return typeof rec.title === 'string' ? list.some((w) => hasTerm(rec.title.toLowerCase(), w)) : null;
    default: return null;
  }
}

function matchTitlePattern(src, rec) {
  if (typeof rec.title !== 'string') return null;
  try { return new RegExp(src, 'i').test(rec.title.slice(0, 400)); } catch { return false; }
}

/** Named exclusion rules. Each returns true | false | null (unobservable). */
export const RULES = {
  // A session with no desktop record and at most one operator prompt: a stray test or probe.
  noDesktopRecordAndPromptsAtMost1: (rec) => {
    if (rec.kind !== 'session' || typeof rec.hasDesktopRecord !== 'boolean') return null;
    return rec.hasDesktopRecord === false && (rec.pr ? rec.pr.n : 0) <= 1;
  },
};

// AND across the fields of `def`, ignoring the fields in `skip`; null when nothing could be decided.
function matchAll(def, rec, fields, skip = new Set()) {
  let unknown = false;
  const missing = [];
  for (const f of fields) {
    if (skip.has(f) || def[f] === undefined) continue;
    const r = f === 'titlePattern' ? matchTitlePattern(def[f], rec) : f === 'rule' ? (RULES[def.rule] ? RULES[def.rule](rec) : null) : matchField(f, def[f], rec);
    if (r === false) return { match: false, unknown: false, missing: [] };
    if (r === null) { unknown = true; missing.push(f); }
  }
  return { match: !unknown, unknown, missing };
}

const COHORT_FIELDS = ['class', 'project', 'model', 'modelFamily', 'rung', 'declaredType', 'role', 'effort', 'effortObserved', 'fit', 'sessionId', 'titleAny', 'titlePattern', 'routineId'];
const EXCLUSION_FIELDS = ['sessionId', 'model', 'class', 'declaredType', 'titleAny', 'rule'];

/**
 * Apply a cohort to records. Returns { kept, unknown: {field: n}, dropped } and, when a field the
 * cohort names is unobservable on EVERY record, { gap: true, why } naming the field (and the spawn
 * hook for spawn fields). An empty cohort keeps everything.
 */
export function applyCohort(records, cohort) {
  const c = isObj(cohort) ? cohort : {};
  const fields = COHORT_FIELDS.filter((f) => c[f] !== undefined);
  if (!fields.length) return { kept: records.slice(), unknown: {}, dropped: 0 };
  const kept = []; const unknown = {};
  const seenKnown = new Set();
  for (const rec of records) {
    const r = matchAll(c, rec, fields);
    for (const f of fields) if (!r.missing.includes(f)) seenKnown.add(f);
    if (r.match) kept.push(rec);
    else if (r.unknown) for (const f of r.missing) unknown[f] = (unknown[f] || 0) + 1;
  }
  if (records.length) {
    const dead = fields.filter((f) => !seenKnown.has(f));
    if (dead.length) {
      const f = dead[0];
      const hook = SPAWN_FIELDS.includes(f) ? ` (fed by ${SPAWN_HOOK}, batch 2b)` : f === 'class' || f === 'title' || f === 'titleAny' || f === 'routineId' || f === 'effortObserved' ? ' (fed by hooks.sessionAttrs)' : '';
      return { kept: [], unknown, dropped: records.length, gap: true, why: `cohort field "${f}" is unobservable: no record carries it${hook}` };
    }
  }
  return { kept, unknown, dropped: records.length - kept.length };
}

// the main-thread part of a session record, zeroed: workers stay
function stripMain(rec) {
  const tok = {};
  for (const [model, mt] of Object.entries(rec.tok)) tok[model] = { m: zeroT(), s: mt.s.slice() };
  const byModel = {};
  for (const [model, u] of Object.entries(rec.byModel || {})) byModel[model] = { m: 0, s: u.s };
  return { ...rec, tok, byModel, pr: { n: 0, len: [0, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0, models: [], model: undefined, units: { main: 0, sub: rec.units.sub, total: rec.units.sub }, mainExcluded: true };
}

/**
 * Apply the named exclusions to records. `names` is the scenario's excludeSets, `table` the
 * resolved exclusions. Returns
 *   { kept, removed: [{rec, rule, scope, units}], report: {name: {records, units, scope, why?}},
 *     unobservable: {name: n}, undefinedRules: [name] }
 * A record is attributed to one rule (a tree-scoped match wins), so the report never double counts:
 * sum(report units) + kept units = input units. An undefined name is listed, not ignored silently.
 */
export function applyExclusions(records, names, table = {}) {
  const defs = [];
  const undefinedRules = [];
  for (const n of names || []) { if (isObj(table[n])) defs.push([n, table[n]]); else undefinedRules.push(n); }
  const report = {}; const unobservable = {};
  for (const [n, d] of defs) report[n] = { records: 0, units: 0, scope: d.scope === 'tree' ? 'tree' : 'session', ...(d.why ? { why: d.why } : {}) };
  if (!defs.length) return { kept: records.slice(), removed: [], report, unobservable, undefinedRules };

  const hit = new Map(); // record -> [name, def]; a tree-scoped match wins over an earlier session-scoped one
  const treeSids = new Map(); // sid -> [name, def]
  for (const rec of records) {
    let pick = null;
    for (const [n, d] of defs) {
      const fields = EXCLUSION_FIELDS.filter((f) => d[f] !== undefined);
      if (!fields.length) continue;
      const r = matchAll(d, rec, fields);
      if (r.unknown) unobservable[n] = (unobservable[n] || 0) + 1;
      if (!r.match) continue;
      if (!pick || (d.scope === 'tree' && pick[1].scope !== 'tree')) pick = [n, d];
    }
    if (!pick) continue;
    hit.set(rec, pick);
    if (rec.kind === 'session' && pick[1].scope === 'tree' && !treeSids.has(rec.sid)) treeSids.set(rec.sid, pick);
  }
  const kept = []; const removed = [];
  const take = (rec, name, scope, units) => { removed.push({ rec, rule: name, scope, units }); report[name].records += 1; report[name].units += units; };
  for (const rec of records) {
    const direct = hit.get(rec);
    const tree = treeSids.get(rec.sid) || (rec.rootSid !== undefined ? treeSids.get(rec.rootSid) : undefined);
    // Scope "session" removes that session's own record (its main thread) and nothing else: the worker (spawn) records of the
    // same sid stay; scope "tree" is what removes them. A non-session record is removed on a direct match only when the rule is
    // tree-scoped, or when it names a field only that record kind carries (declaredType: a spawn's own field).
    const whole = tree || (direct && rec.kind !== 'session' && (direct[1].scope === 'tree' || SPAWN_FIELDS.some((f) => direct[1][f] !== undefined)));
    if (whole) { // the whole record goes: its tree is excluded, or the rule is about this record kind itself
      const [name, def] = direct && direct[1].scope === 'tree' ? direct : tree || direct;
      take(rec, name, def.scope === 'tree' ? 'tree' : 'session', rec.units ? rec.units.total : 0);
    } else if (direct && rec.kind === 'session') { // session scope: the main thread goes, workers stay
      take(rec, direct[0], 'session', rec.units.main);
      const left = stripMain(rec);
      if (left.units.total > 0) kept.push(left);
    } else kept.push(rec);
  }
  return { kept, removed, report, unobservable, undefinedRules };
}

/**
 * day.excludedShare: units each exclusion removed and their share of the weekly limit.
 * `limitUnits` is the plan's weekly limit in units (null: no share). Pure over records.
 */
export function excludedShare(records, names, table, limitUnits = null) {
  const ex = applyExclusions(records, names, table);
  const total = records.filter((r) => r.kind === 'session').reduce((s, r) => s + (r.units ? r.units.total : 0), 0);
  const rows = Object.entries(ex.report).map(([name, v]) => ({
    name, ...v, pctOfWeeklyLimit: limitUnits > 0 ? (v.units / limitUnits) * 100 : null,
  }));
  const removedUnits = rows.reduce((s, r) => s + r.units, 0);
  return { rows, removedUnits, totalUnits: total, pctOfDay: total > 0 ? (removedUnits / total) * 100 : null, unobservable: ex.unobservable, undefinedRules: ex.undefinedRules };
}

