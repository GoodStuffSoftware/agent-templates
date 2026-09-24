// The per-user ROUTING PROFILE's format, reader and journal arithmetic
// (docs/adr/0003-per-user-routing-profiles.md §1, §6; slice 2).
//
// This module knows the FILE: its schema v1 shape, how to read it without
// ever throwing, and how the append-only journal folds back into any
// revision. It deliberately knows nothing about the routing table — whether
// a row names an available alias or breaks a floor is decided in
// hooks/lib/context.mjs (profileRowRefusal), which owns the tier data. It
// imports nothing from context.mjs, so the hook path loads it without a
// cycle.
//
// Where things live, all under the durable state root (never a repo, never
// the plugin directory — both are checked by tests/routing-profile.test.mjs):
//   <stateRoot>/config/routing-profile.json           the profile (user-authored)
//   <stateRoot>/config/routing-profile.journal.jsonl  append-only change history
//   <stateRoot>/config/routing-profile.lock           writer lock (transient)
//   <stateRoot>/state/routing-profile-invalid.json    marker: last read failed
//
// SCHEMA v1 (fixed here; the ADR's names were indicative):
//   {
//     "schema": "agent-companion/routing-profile",
//     "schemaVersion": 1,         // format major; a reader ignores a HIGHER one whole
//     "revision": 0,              // +1 on every applied change; the journal is keyed on it
//     "basedOn": { "tableVersion": 7, "tableUpdated": "2026-09-23" } | null,
//     "objective": "api-cost" | "plan-usage",
//     "planUsageMultipliers": null | { "<alias>": <number> },
//     "types": { "<name>": { weight: 1-5, kind, consequence, summary?, origin?, createdAt? } },
//     "rows":  { "<taskType>": {
//         state: "trial" | "adopted" | "retired",
//         model: "<tier alias>" | null,    // null only on a parity-sized type (code-review)
//         effort: "<effort>" | null,       // null only when the model takes none
//         cacheTtl: null | "5m" | "1h",    // advisory hint
//         source: "benchmark" | "operator-observed" | "telemetry" | "migrated-trial"
//                 | "grid-derived" | "imported:<label>",
//         since: "YYYY-MM-DD", reviewBy: "YYYY-MM-DD" | null,
//         waivesFloor: null | "elevated",  // honoured only when source is operator-observed
//         note: string | null,             // local free text; never logged, never exported
//         provenance: object | null        // as the ADR §1 block; null for operator rows
//     } }
//   }
// Unknown keys are tolerated and preserved, so a later minor addition within
// major 1 does not invalidate an older reader's view.
//
// JOURNAL LINE: { revision, at, action, type, before, after, by }
//   type  — the row key for a row change; null for a whole-profile change
//   before/after — the row (or null when absent) for a row change; the whole
//                  profile CONTENT (every key but `revision`) for a
//                  whole-profile change (init, rollback --to, adopt).
// rebuildAt(entries, N) folds every line with revision <= N over an empty
// profile, so ANY revision the journal holds can be rebuilt without git.

import { readFileSync, statSync } from 'node:fs';

export const PROFILE_SCHEMA = 'agent-companion/routing-profile';
export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_FILE = 'routing-profile.json';
export const JOURNAL_FILE = 'routing-profile.journal.jsonl';
export const LOCK_FILE = 'routing-profile.lock';
export const INVALID_MARKER_FILE = 'routing-profile-invalid.json';

export const ROW_STATES = Object.freeze(['trial', 'adopted', 'retired']);
export const ACTIVE_STATES = Object.freeze(new Set(['trial', 'adopted']));
export const ROW_SOURCES = Object.freeze(['benchmark', 'operator-observed', 'telemetry', 'migrated-trial', 'grid-derived']);
export const OBJECTIVES = Object.freeze(['api-cost', 'plan-usage']);
export const CACHE_TTLS = Object.freeze(['5m', '1h']);
export const WAIVABLE_FLOORS = Object.freeze(['elevated']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrOrNull = (v) => v === null || v === undefined || typeof v === 'string';

export function isKnownSource(s) {
  return typeof s === 'string' && (ROW_SOURCES.includes(s) || /^imported:[A-Za-z0-9._-]{1,64}$/.test(s));
}

// The content of a brand-new profile at revision 0. `basedOn` records the
// shipped table the profile was created against.
export function emptyProfile(basedOn = null) {
  return {
    schema: PROFILE_SCHEMA,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    revision: 0,
    basedOn: basedOn ?? null,
    objective: 'api-cost',
    planUsageMultipliers: null,
    types: {},
    rows: {},
  };
}

// Whole-file checks. Any hit invalidates the profile AS A WHOLE (ADR §2: "A
// profile file that fails to parse or validate is ignored as a whole").
// Messages name fields, never values, so the invalid marker cannot carry a
// row's content.
export function profileErrors(p) {
  if (!isObj(p)) return ['the profile is not a JSON object'];
  const e = [];
  if (p.schema !== PROFILE_SCHEMA) e.push(`schema must be "${PROFILE_SCHEMA}"`);
  if (!Number.isInteger(p.schemaVersion) || p.schemaVersion < 1) e.push('schemaVersion must be a positive integer');
  if (!Number.isInteger(p.revision) || p.revision < 0) e.push('revision must be a non-negative integer');
  if (!isObj(p.rows)) e.push('rows must be an object');
  if (p.types !== undefined && !isObj(p.types)) e.push('types must be an object');
  if (p.objective !== undefined && !OBJECTIVES.includes(p.objective)) e.push(`objective must be one of ${OBJECTIVES.join(', ')}`);
  if (p.basedOn !== undefined && p.basedOn !== null && !isObj(p.basedOn)) e.push('basedOn must be an object or null');
  if (p.planUsageMultipliers !== undefined && p.planUsageMultipliers !== null) {
    if (!isObj(p.planUsageMultipliers) || Object.values(p.planUsageMultipliers).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      e.push('planUsageMultipliers must be null or an object of numbers');
    }
  }
  return e;
}

// Per-row SHAPE checks (no tier knowledge). A row that fails is skipped on
// its own; the rest of the profile still applies.
export function rowShapeErrors(row) {
  if (!isObj(row)) return ['row is not an object'];
  const e = [];
  if (!ROW_STATES.includes(row.state)) e.push(`state must be one of ${ROW_STATES.join(', ')}`);
  if (!(row.model === null || row.model === undefined || (typeof row.model === 'string' && row.model))) e.push('model must be a tier alias or null');
  if (!(row.effort === null || row.effort === undefined || typeof row.effort === 'string')) e.push('effort must be a string or null');
  if (!(row.cacheTtl === null || row.cacheTtl === undefined || CACHE_TTLS.includes(row.cacheTtl))) e.push('cacheTtl must be null, "5m" or "1h"');
  if (!isKnownSource(row.source)) e.push('source is not a known source');
  if (typeof row.since !== 'string' || !DATE.test(row.since)) e.push('since must be YYYY-MM-DD');
  if (!(row.reviewBy === null || row.reviewBy === undefined || (typeof row.reviewBy === 'string' && DATE.test(row.reviewBy)))) e.push('reviewBy must be YYYY-MM-DD or null');
  if (!(row.waivesFloor === null || row.waivesFloor === undefined || WAIVABLE_FLOORS.includes(row.waivesFloor))) e.push('waivesFloor may only be null or "elevated"');
  if (!isStrOrNull(row.note)) e.push('note must be a string or null');
  if (!(row.provenance === null || row.provenance === undefined || isObj(row.provenance))) e.push('provenance must be an object or null');
  return e;
}

// Per-local-type SHAPE checks. Membership of kind/consequence in the shipped
// table is checked by context.mjs, which has the table.
export function typeShapeErrors(def) {
  if (!isObj(def)) return ['type is not an object'];
  const e = [];
  if (!Number.isInteger(def.weight) || def.weight < 1 || def.weight > 5) e.push('weight must be an integer 1-5');
  if (typeof def.kind !== 'string' || !def.kind) e.push('kind must be a string');
  if (typeof def.consequence !== 'string' || !def.consequence) e.push('consequence must be a string');
  if (!isStrOrNull(def.summary)) e.push('summary must be a string');
  return e;
}

// Nesting depth, measured without recursion (a deeply nested value must not
// blow the stack here, the thing the check exists to prevent). S2 review P7:
// a hand-edited profile nesting 20000 levels made the writer throw an
// uncaught RangeError in JSON.stringify.
export const MAX_PROFILE_DEPTH = 64;
export function nestingDepth(v) {
  let max = 0;
  const stack = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (!x || typeof x !== 'object') continue;
    if (d > max) max = d;
    if (max > MAX_PROFILE_DEPTH) return max;
    for (const k of Object.keys(x)) stack.push([x[k], d + 1]);
  }
  return max;
}

// Parse + validate raw text. Never throws. Returns one of
//   { status: 'ok', profile }
//   { status: 'invalid', reason: 'parse' | 'schema' | 'version', errors: [...] }
export function parseProfileText(text) {
  let raw = String(text ?? '');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let p;
  try { p = JSON.parse(raw); } catch {
    // The engine's message can quote a slice of the file; do not keep it.
    return { status: 'invalid', reason: 'parse', errors: ['the file is not valid JSON'] };
  }
  if (isObj(p) && Number.isInteger(p.schemaVersion) && p.schemaVersion > PROFILE_SCHEMA_VERSION) {
    return {
      status: 'invalid', reason: 'version',
      errors: [`schemaVersion ${p.schemaVersion} is newer than this reader (${PROFILE_SCHEMA_VERSION}); the whole profile is ignored`],
      schemaVersion: p.schemaVersion,
    };
  }
  if (nestingDepth(p) > MAX_PROFILE_DEPTH) {
    return { status: 'invalid', reason: 'schema', errors: [`the profile nests deeper than ${MAX_PROFILE_DEPTH} levels`] };
  }
  const errors = profileErrors(p);
  if (errors.length) return { status: 'invalid', reason: 'schema', errors };
  return { status: 'ok', profile: p };
}

// Read the profile at `file`. Never throws. Cached per path by (mtimeMs,
// size), the same invalidation the settings reader uses, so an edit is seen
// on the very next call and an unchanged file is parsed once per process.
// Returns { status: 'absent' } in addition to parseProfileText()'s shapes,
// each carrying the stat it was read at ({ mtimeMs, size }).
const _cache = new Map();
export function readProfile(file) {
  let st;
  try { st = statSync(file); } catch { return { status: 'absent' }; }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
  let result;
  try {
    result = parseProfileText(readFileSync(file, 'utf8'));
  } catch {
    result = { status: 'invalid', reason: 'parse', errors: ['the file could not be read'] };
  }
  result = { ...result, mtimeMs: st.mtimeMs, size: st.size };
  _cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// Tests only: drop the per-process cache (the timing test measures a cold read).
export function _resetProfileCache() { _cache.clear(); }

// --- Journal arithmetic ------------------------------------------------------

// The profile minus `revision`: what a whole-profile journal line stores.
export function profileContent(p) {
  const { revision, ...rest } = p || {};
  return rest;
}

// Stable stringify (sorted keys) for equality: two profiles are the same
// revision content exactly when these match.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// Parse journal text. Returns { entries, errors }. A line that is not a JSON
// object with an integer revision is an error (named by line number): a
// journal that cannot be folded cannot promise an exact rebuild.
export function parseJournal(text) {
  const entries = [];
  const errors = [];
  String(text || '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (!isObj(e) || !Number.isInteger(e.revision) || e.revision < 0) throw new Error('shape');
      if (nestingDepth(e) > MAX_PROFILE_DEPTH + 2) throw new Error('depth');
      if (!(e.type === null || typeof e.type === 'string')) throw new Error('shape');
      entries.push(e);
    } catch {
      errors.push(`journal line ${i + 1} is not a valid entry`);
    }
  });
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].revision <= entries[i - 1].revision) {
      errors.push(`journal revisions are not increasing at revision ${entries[i].revision}`);
      break;
    }
  }
  return { entries, errors };
}

export function journalMaxRevision(entries) {
  return entries.length ? entries[entries.length - 1].revision : -1;
}

// Fold one entry over a profile (returns a new object).
export function applyEntry(p, e) {
  if (e.type === null) {
    return { ...JSON.parse(JSON.stringify(e.after || profileContent(emptyProfile()))), revision: e.revision };
  }
  const rows = { ...(p.rows || {}) };
  if (e.after === null || e.after === undefined) delete rows[e.type];
  else rows[e.type] = JSON.parse(JSON.stringify(e.after));
  return { ...p, rows, revision: e.revision };
}

// The profile exactly as it stood at `revision`, or null when the journal
// holds no entry at that revision.
export function rebuildAt(entries, revision) {
  if (!entries.some((e) => e.revision === revision)) return null;
  let p = emptyProfile();
  for (const e of entries) {
    if (e.revision > revision) break;
    p = applyEntry(p, e);
  }
  return p;
}
