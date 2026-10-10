// Daily checkup: yesterday's plan usage, worked out from local transcripts.
//
// No model call, no network. Once per day the scout starts scripts/daily-checkup.mjs
// as a detached, hidden background process; it reads the transcripts under
// <config dir>/projects (main sessions and subagents) that have grown since the
// last run, adds their usage into hourly buckets, and appends ONE JSON line per
// closed day to state/daily-checkup-history.jsonl. The next MAIN session start
// shows one line about the latest day (hooks/scout-surface.mjs); subagents get
// nothing.
//
// --- Days and weeks (UTC) -------------------------------------------------------
//   A checkup DAY runs 08:00Z to 08:00Z and is named by the date of its start
//   ("2026-10-09" = 10-09T08:00Z to 10-10T08:00Z). A plan WEEK resets Friday
//   16:00Z (WEEK0 below is one such reset). Both are fixed UTC instants.
//
// --- Units ----------------------------------------------------------------------
//   The unit model is the one of the usage study's week scan: every request is
//   priced at the BASELINE (Sonnet) price vector (input, output, 5-minute and
//   1-hour cache writes, cache reads) and multiplied by the model's plan weight.
//   Opus and Sonnet take their weight and prices from config/model-tiers.json
//   (planUsageMultipliers) and config/model-pricing.json through
//   scripts/lib/pricing.mjs; Haiku (0.5) and Fable (5) have no entry there, so
//   they use the study's constants below; a model that matches nothing counts as
//   Opus, as the study did. 100% = the weekly limit option (default 2677 units).
//
// --- Incremental scan ------------------------------------------------------------
//   state/daily-checkup.json holds a byte offset per transcript. A run reads only
//   the bytes after it, and only whole lines. A file whose last lines are an
//   assistant request and which was written to in the last 2 minutes holds that
//   trailing run back until the next run (a request is written as several lines
//   and its output count grows). A request is counted once: its id goes into
//   state/daily-checkup-seen.bin (an 8-byte hash and a minute stamp each), which
//   also covers the copies a resumed or forked session writes into a new file
//   (the same request id, the same timestamp). The first run looks back at most
//   8 days. Everything is bucketed by the request's own timestamp.
//
// --- What a day record holds -----------------------------------------------------
//   See buildDayRecord(). Spawns are counted from the subagent transcripts:
//   one spawn = one subagent file whose first prompt is in the day, classed by
//   the TYPE: and ROLE: lines of that prompt and by the agent type from its
//   .meta.json (the rung). Units per spawn = the class's units CONSUMED in the
//   day divided by the class's spawns STARTED in the day.
//
// Fail-open everywhere: unreadable input is skipped, never thrown to a caller
// that is a hook.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync,
  renameSync, appendFileSync, unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateFile, telemetryDir, stateRootPath, modelTiers, opt, rolloutTable } from '../../hooks/lib/context.mjs';
import { briefDeclarations, declarationValue, BRIEF_ROLES } from '../../hooks/lib/brief-directives.mjs';
import {
  discoverTranscripts, transcriptsRoot, usageOf, contextTokensOf, isCompactBoundary, flattenContent,
} from './transcripts.mjs';
import { planPriceSpecFor } from './pricing.mjs';

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const DAY_OFFSET_MS = 8 * HOUR_MS; // a checkup day starts at 08:00Z
export const WEEK0_MS = Date.parse('2026-07-03T16:00:00Z'); // a Friday 16:00Z plan reset
export const LOOKBACK_DAYS = 8;
export const KEEP_DAYS = 16;
export const CEILING_CTX = 150000; // the subagent context line the record reports a share above
export const DEFAULT_LIMIT_UNITS = 2677;
export const DEFAULT_PACE_PCT = 14;
export const HOLD_RECENT_MS = 2 * 60 * 1000;
export const LOCK_STALE_MS = 30 * 60 * 1000;
export const RETRY_MS = 3 * HOUR_MS;
export const SURFACE_MAX_AGE_MS = 72 * HOUR_MS;
export const SCHEMA = 1;

export const HISTORY_FILE = 'daily-checkup-history.jsonl';
const STATE_FILE = 'daily-checkup.json';
const SEEN_FILE = 'daily-checkup-seen.bin';
const STATUS_FILE = 'daily-checkup-status.json';
const SURFACED_FILE = 'daily-checkup-surfaced.json';
const LOCK_FILE = 'daily-checkup.lock';
const CEILING_LOG = 'context-ceiling.jsonl';

// Plan weights the config has no entry for (the usage study's constants).
const FALLBACK_MULT = { haiku: 0.5, fable: 5 };
const UNKNOWN_MULT = 1.5; // a model that matches no family: counted as Opus, as the study did

export function nowMs() {
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  if (fake) { const t = Date.parse(fake); if (Number.isFinite(t)) return t; }
  return Date.now();
}

export const dayStartMs = (ts) => Math.floor((ts - DAY_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_OFFSET_MS;
export const weekStartMs = (ts) => WEEK0_MS + Math.floor((ts - WEEK0_MS) / WEEK_MS) * WEEK_MS;
export const dayKeyOf = (startMs) => new Date(startMs).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export function checkupPaths() {
  return {
    state: stateFile(STATE_FILE),
    seen: stateFile(SEEN_FILE),
    history: stateFile(HISTORY_FILE),
    status: stateFile(STATUS_FILE),
    surfaced: stateFile(SURFACED_FILE),
    lock: stateFile(LOCK_FILE),
  };
}

// --- Units --------------------------------------------------------------------

function family(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('fable')) return 'fable';
  return 'opus';
}

let _unitSpec = null;
export function resetUnitCache() { _unitSpec = null; }

// The price vector and the plan weight for one model, or null when the baseline
// itself cannot be priced (then no unit can be computed at all).
function unitSpecFor(model) {
  const key = String(model || '');
  if (!_unitSpec) _unitSpec = new Map();
  if (_unitSpec.has(key)) return _unitSpec.get(key);
  let spec = null;
  try {
    const own = planPriceSpecFor(key);
    if (own) {
      spec = { inUsd: own.inUsd, outRatio: own.outRatio, r: own.r, w5: own.w5, w1: own.w1, mult: own.multiplier };
    } else {
      const baseModel = modelTiers().tiers?.sonnet?.resolvesTo?.modelId;
      const base = baseModel ? planPriceSpecFor(baseModel) : null;
      if (base) {
        const fam = family(key);
        spec = { inUsd: base.inUsd, outRatio: base.outRatio, r: base.r, w5: base.w5, w1: base.w1, mult: FALLBACK_MULT[fam] ?? UNKNOWN_MULT };
      }
    }
  } catch { spec = null; }
  _unitSpec.set(key, spec);
  return spec;
}

// usage in transcripts.mjs's shape (usageOf). A cache write that carries a
// 5m/1h split is priced by the split; one that carries only the flat total is
// priced as 5m.
export function unitsOf(usage, model) {
  const s = unitSpecFor(model);
  if (!s) return 0;
  const split = (usage.cacheWrite5m || 0) + (usage.cacheWrite1h || 0) > 0;
  const w5 = split ? usage.cacheWrite5m || 0 : usage.cacheWrite || 0;
  const w1 = split ? usage.cacheWrite1h || 0 : 0;
  const usd = (usage.input || 0) * s.inUsd
    + (usage.output || 0) * s.inUsd * s.outRatio
    + w5 * s.inUsd * s.w5
    + w1 * s.inUsd * s.w1
    + (usage.cacheRead || 0) * s.inUsd * s.r;
  return usd * s.mult;
}

// --- The seen store ---------------------------------------------------------------
// 12 bytes per entry: the first 8 bytes of an md5 of the key, then the entry's
// timestamp in minutes (uint32), so old entries can be dropped.

class SeenStore {
  constructor(file) { this.file = file; this.map = new Map(); }
  static hash(key) { return createHash('md5').update(key).digest('hex').slice(0, 16); }
  load() {
    try {
      const b = readFileSync(this.file);
      for (let i = 0; i + 12 <= b.length; i += 12) this.map.set(b.subarray(i, i + 8).toString('hex'), b.readUInt32LE(i + 8));
    } catch { /* none yet, or unreadable: start empty (a request may then be counted twice, never lost) */ }
    return this;
  }
  has(key) { return this.map.has(SeenStore.hash(key)); }
  add(key, tsMs) { this.map.set(SeenStore.hash(key), Math.max(0, Math.floor(tsMs / 60000))); }
  save(pruneBeforeMs) {
    const floor = Math.floor(pruneBeforeMs / 60000);
    const keep = [...this.map].filter(([, m]) => m >= floor);
    const out = Buffer.alloc(keep.length * 12);
    keep.forEach(([h, m], i) => { out.write(h, i * 12, 'hex'); out.writeUInt32LE(m, i * 12 + 8); });
    atomicWrite(this.file, out);
  }
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

// --- Scan state ------------------------------------------------------------------

// States built from scratch (first run, or a lost/unreadable state file). Their
// seen-requests file is stale by definition (it outlives the state and would make
// the rebuilt scan see every request as already counted), so it is not loaded.
const FRESH_STATES = new WeakSet();

function freshState(cutoffMs) {
  const s = { v: SCHEMA, scanFromMs: cutoffMs, files: {}, hours: {}, days: {}, dataThroughMs: 0, lastScanMs: 0 };
  FRESH_STATES.add(s);
  return s;
}

function loadState(nowT) {
  const p = checkupPaths();
  const s = readJsonSafe(p.state);
  if (s && s.v === SCHEMA && s.files && s.hours && s.days && Number.isFinite(s.scanFromMs)) return s;
  // First run (or unreadable state): look back at most LOOKBACK_DAYS, from the
  // first day boundary at or after that point so every scanned day is whole.
  const lookback = nowT - LOOKBACK_DAYS * DAY_MS;
  let cutoff = dayStartMs(lookback);
  if (cutoff < lookback) cutoff += DAY_MS;
  return freshState(cutoff);
}

const dayAcc = (state, key) => (state.days[key] ||= { spawns: 0, compactions: 0, type: {}, role: {}, rung: {}, uType: {}, uRole: {}, uRung: {} });
const bump = (o, k, n) => { o[k] = (o[k] || 0) + n; };

function rungOf(agentType) {
  const t = String(agentType || '').replace(/^agent-companion:/, '');
  const m = /^ac-(sonnet|opus)-(low|medium|high|xhigh|max)$/.exec(t);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^ac-haiku$/.test(t)) return 'haiku';
  return t || '(no meta)';
}

function readMetaType(path) {
  try { return JSON.parse(readFileSync(path.replace(/\.jsonl$/i, '.meta.json'), 'utf8')).agentType || ''; } catch { return ''; }
}

function classOfPrompt(text, rung) {
  const decls = briefDeclarations(text);
  const tm = declarationValue(decls, 'TYPE', '([a-z][a-z0-9-]{0,39})\\b');
  const rm = declarationValue(decls, 'ROLE', `(${BRIEF_ROLES.join('|')})\\b`);
  const type = tm ? tm[1].toLowerCase() : 'none';
  return { t: type, r: rm ? rm[1].toLowerCase() : 'none', g: rung };
}

// --- One file, from its cursor ---------------------------------------------------

const TS_RE = /"timestamp":"([^"]+)"/;

// Calls onLine(offset, Buffer) for every WHOLE line from `start`; returns the
// offset just after the last whole line.
function eachLine(path, start, size, onLine) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return start; }
  try {
    const CH = 16 * 1024 * 1024;
    let pos = start;
    let carry = null;
    let carryOff = start;
    let consumed = start;
    while (pos < size) {
      const n = Math.min(CH, size - pos);
      const b = Buffer.allocUnsafe(n);
      const got = readSync(fd, b, 0, n, pos);
      if (!got) break;
      const chunk = got < n ? b.subarray(0, got) : b;
      const base = carry ? carryOff : pos;
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      pos += got;
      let from = 0;
      let i;
      while ((i = buf.indexOf(10, from)) >= 0) {
        if (i > from) onLine(base + from, buf.subarray(from, i));
        from = i + 1;
        consumed = base + from;
      }
      carry = from < buf.length ? Buffer.from(buf.subarray(from)) : null;
      carryOff = base + from;
    }
    return consumed;
  } catch {
    return start;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function scanFile(f, fileState, ctx) {
  const { state, seen, cutoffMs } = ctx;
  const isSub = f.kind === 'subagent';
  const pending = new Map(); // request id -> { off, ts, model, usage }
  let trailStart = -1; // offset of the first line of the trailing run of assistant lines
  let cls = fileState.c || null;
  let rung = null;

  const end = eachLine(f.path, fileState.o || 0, f.size, (off, buf) => {
    const s = buf.toString('utf8');
    const isAssistant = s.includes('"type":"assistant"');
    if (isAssistant) { if (trailStart < 0) trailStart = off; } else trailStart = -1;

    if (isAssistant) {
      if (!s.includes('"usage"')) return;
      const tm = TS_RE.exec(s);
      const ts0 = tm ? Date.parse(tm[1]) : NaN;
      if (Number.isFinite(ts0) && ts0 < cutoffMs) return;
      let j;
      try { j = JSON.parse(s); } catch { return; }
      const m = j.message;
      const ts = Date.parse(j.timestamp);
      if (!ts || ts < cutoffMs || !m || !m.usage || !m.model || m.model === '<synthetic>') return;
      const id = j.requestId || m.id || j.uuid;
      if (!id) return;
      const u = usageOf(m.usage);
      const cur = pending.get(id);
      if (!cur) { pending.set(id, { off, ts, model: m.model, usage: u }); return; }
      cur.ts = Math.min(cur.ts, ts);
      for (const k of Object.keys(u)) cur.usage[k] = Math.max(cur.usage[k], u[k]);
      return;
    }

    if (isSub && s.includes('"subtype":"compact_boundary"')) {
      let j;
      try { j = JSON.parse(s); } catch { return; }
      if (!isCompactBoundary(j)) return;
      const ts = Date.parse(j.timestamp);
      if (!ts || ts < cutoffMs) return;
      const key = `c:${j.uuid || `${f.path}@${off}`}`;
      if (seen.has(key)) return;
      seen.add(key, ts);
      dayAcc(state, dayKeyOf(dayStartMs(ts))).compactions += 1;
      return;
    }

    if (isSub && !cls && s.includes('"type":"user"')) {
      let j;
      try { j = JSON.parse(s); } catch { return; }
      if (j.type !== 'user') return;
      const text = flattenContent(j.message && j.message.content);
      if (!text) return;
      rung = rung || rungOf(readMetaType(f.path));
      cls = classOfPrompt(text, rung);
      const ts = Date.parse(j.timestamp);
      if (ts && ts >= cutoffMs) {
        const key = `u:${j.uuid || `${f.path}@${off}`}`;
        if (!seen.has(key)) {
          seen.add(key, ts);
          const d = dayAcc(state, dayKeyOf(dayStartMs(ts)));
          d.spawns += 1;
          bump(d.type, cls.t, 1);
          bump(d.role, cls.r, 1);
          bump(d.rung, cls.g, 1);
        }
      }
    }
  });

  // A request still being written: leave its lines for the next run.
  let newOffset = end;
  if (trailStart >= 0 && ctx.holdMs > 0 && f.mtimeMs >= Date.now() - ctx.holdMs) {
    newOffset = trailStart;
    for (const [id, r] of pending) if (r.off >= trailStart) pending.delete(id);
  }

  if (isSub && !cls) cls = { t: 'none', r: 'none', g: rung || rungOf(readMetaType(f.path)) };

  for (const [id, r] of pending) {
    if (seen.has(`r:${id}`)) continue;
    seen.add(`r:${id}`, r.ts);
    const units = unitsOf(r.usage, r.model);
    if (!(units > 0)) continue;
    const h = Math.floor(r.ts / HOUR_MS);
    const b = (state.hours[h] ||= [0, 0, 0]);
    if (r.ts > state.dataThroughMs) state.dataThroughMs = r.ts;
    if (!isSub) { b[0] += units; continue; }
    b[1] += units;
    if (contextTokensOf(r.usage) > CEILING_CTX) b[2] += units;
    const d = dayAcc(state, dayKeyOf(dayStartMs(r.ts)));
    bump(d.uType, cls.t, units);
    bump(d.uRole, cls.r, units);
    bump(d.uRung, cls.g, units);
  }

  fileState.o = newOffset;
  if (cls) fileState.c = cls;
}

// --- The scan ------------------------------------------------------------------------

export function scanTranscripts({ root = transcriptsRoot(), nowT = nowMs(), holdMs = HOLD_RECENT_MS, state = null, seen = null } = {}) {
  const p = checkupPaths();
  const st = state || loadState(nowT);
  const sn = seen || (FRESH_STATES.has(st) ? new SeenStore(p.seen) : new SeenStore(p.seen).load());
  const ctx = { state: st, seen: sn, cutoffMs: st.scanFromMs, holdMs };
  const found = discoverTranscripts(root, { sinceMs: Math.max(st.scanFromMs, nowT - KEEP_DAYS * DAY_MS), main: true, subagents: true, workflows: true, meta: false });
  let read = 0;
  let bytes = 0;
  for (const f of found.files) {
    const rel = relative(root, f.path).split('\\').join('/');
    const fst = (st.files[rel] ||= { o: 0 });
    if (fst.o > f.size) fst.o = 0; // the file shrank: a different file under the same name
    if (fst.o === f.size) continue;
    const before = fst.o;
    try { scanFile(f, fst, ctx); } catch { /* one unreadable file never stops the scan */ }
    read += 1;
    bytes += Math.max(0, f.size - before);
  }
  st.lastScanMs = nowT;
  // Forget what can no longer matter.
  const keepFrom = nowT - KEEP_DAYS * DAY_MS;
  for (const h of Object.keys(st.hours)) if (Number(h) * HOUR_MS < keepFrom) delete st.hours[h];
  for (const d of Object.keys(st.days)) if (Date.parse(`${d}T08:00:00Z`) < keepFrom) delete st.days[d];
  for (const [rel, v] of Object.entries(st.files)) {
    try {
      const mt = statSync(join(root, rel)).mtimeMs;
      if (mt < keepFrom) delete st.files[rel];
    } catch { delete st.files[rel]; void v; }
  }
  return { state: st, seen: sn, filesRead: read, bytesRead: bytes, filesSeen: found.files.length, truncated: !!found.truncated };
}

// --- Rollout schedule and nudge log (read-only here) ---------------------------------

export function readRollout() {
  // The same reading as the config gate (hooks/lib/context.mjs rolloutTable), so
  // a record never lists a change as active that the gate treats as off.
  return Object.entries(rolloutTable()).map(([id, activeFrom]) => ({ id, activeFrom }))
    .sort((x, y) => x.activeFrom - y.activeFrom || x.id.localeCompare(y.id));
}

// Rows of context-ceiling.jsonl (UTC `at`) inside [fromMs, toMs). A missing or
// unreadable log is 0.
export function countCeilingNudges(fromMs, toMs) {
  for (const dir of [telemetryDir(), stateRootPath(), stateFile('.')]) {
    let text;
    try { text = readFileSync(join(dir, CEILING_LOG), 'utf8'); } catch { continue; }
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = Date.parse(JSON.parse(line).at);
        if (t >= fromMs && t < toMs) n += 1;
      } catch { /* corrupt row: skipped */ }
    }
    return n;
  }
  return 0;
}

// --- A day's record ------------------------------------------------------------------

function sumHours(state, fromMs, toMs) {
  let m = 0;
  let s = 0;
  let o = 0;
  for (let h = Math.floor(fromMs / HOUR_MS); h * HOUR_MS < toMs; h += 1) {
    const b = state.hours[h];
    if (b) { m += b[0]; s += b[1]; o += b[2]; }
  }
  return { m, s, o };
}

function classTable(spawns, units) {
  const out = {};
  for (const k of new Set([...Object.keys(spawns), ...Object.keys(units)])) {
    const n = spawns[k] || 0;
    const u = units[k] || 0;
    out[k] = { n, units: r1(u), unitsPerSpawn: n ? r2(u / n) : null };
  }
  return out;
}

export function buildDayRecord(state, startMs, { limit = DEFAULT_LIMIT_UNITS, target = DEFAULT_PACE_PCT, computedAt = nowMs() } = {}) {
  const endMs = startMs + DAY_MS;
  const day = sumHours(state, startMs, endMs);
  const pct = (u) => r2((u / limit) * 100);
  const total = day.m + day.s;
  const wStart = weekStartMs(endMs - 1);
  const week = sumHours(state, wStart, endMs);
  const weekUnits = week.m + week.s;
  const elapsed = (endMs - wStart) / WEEK_MS;
  const acc = state.days[dayKeyOf(startMs)] || { spawns: 0, compactions: 0, type: {}, role: {}, rung: {}, uType: {}, uRole: {}, uRung: {} };
  const rollout = readRollout();
  return {
    v: SCHEMA,
    day: dayKeyOf(startMs),
    from: iso(startMs),
    to: iso(endMs),
    computedAt: iso(computedAt),
    dataThrough: state.dataThroughMs ? iso(state.dataThroughMs) : null,
    limitUnits: limit,
    targetPct: target,
    units: { main: r1(day.m), subagent: r1(day.s), total: r1(total) },
    pct: { main: pct(day.m), subagent: pct(day.s), total: pct(total) },
    vsTargetPct: r2(pct(total) - target),
    week: {
      start: iso(wStart),
      units: r1(weekUnits),
      pctSoFar: pct(weekUnits),
      elapsedPct: r1(elapsed * 100),
      paceAtResetPct: r1(elapsed > 0 ? pct(weekUnits) / elapsed : 0),
      partial: wStart < state.scanFromMs,
    },
    spawns: {
      total: acc.spawns,
      byType: classTable(acc.type, acc.uType),
      byRole: classTable(acc.role, acc.uRole),
      byRung: classTable(acc.rung, acc.uRung),
    },
    subagent: {
      compactions: acc.compactions,
      compactionsPer100Spawns: acc.spawns ? r1((acc.compactions / acc.spawns) * 100) : null,
      unitsOver150k: r1(day.o),
      shareOver150kPct: day.s > 0 ? r1((day.o / day.s) * 100) : null,
    },
    ceilingNudges: countCeilingNudges(startMs, endMs),
    changes: {
      active: rollout.filter((c) => c.activeFrom < endMs).map((c) => ({ id: c.id, activeFrom: iso(c.activeFrom) })),
      switchedOn: rollout.filter((c) => c.activeFrom >= startMs && c.activeFrom < endMs).map((c) => c.id),
    },
    scanFrom: iso(state.scanFromMs),
  };
}

// --- History -------------------------------------------------------------------------

export function readHistory(file = checkupPaths().history) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j && typeof j.day === 'string') out.push(j); } catch { /* corrupt line: skipped */ }
  }
  return out;
}

export function checkupOptions() {
  const limit = Number(opt('weekly_limit_units', DEFAULT_LIMIT_UNITS));
  const target = Number(opt('daily_pace_target_pct', DEFAULT_PACE_PCT));
  return {
    limit: limit > 0 ? limit : DEFAULT_LIMIT_UNITS,
    target: target > 0 ? target : DEFAULT_PACE_PCT,
  };
}

// The whole run: scan, then append a record for every closed day not yet in the
// history. Returns what it did.
export function runCheckup({ root = transcriptsRoot(), nowT = nowMs(), holdMs = HOLD_RECENT_MS } = {}) {
  const p = checkupPaths();
  const { limit, target } = checkupOptions();
  const scan = scanTranscripts({ root, nowT, holdMs });
  const { state, seen } = scan;
  const have = new Set(readHistory(p.history).map((r) => r.day));
  const lastClosedStart = dayStartMs(nowT) - DAY_MS;
  const written = [];
  for (let s = dayStartMs(state.scanFromMs); s <= lastClosedStart; s += DAY_MS) {
    if (s < state.scanFromMs || have.has(dayKeyOf(s))) continue;
    const rec = buildDayRecord(state, s, { limit, target, computedAt: nowT });
    mkdirSync(dirname(p.history), { recursive: true });
    appendFileSync(p.history, `${JSON.stringify(rec)}\n`);
    written.push(rec.day);
  }
  // Write the cursor and the seen set together, after the history line: a crash
  // before this point re-reads the same bytes and the history guard stops a duplicate line.
  seen.save(nowT - KEEP_DAYS * DAY_MS);
  atomicWrite(p.state, JSON.stringify(state));
  atomicWrite(p.status, JSON.stringify({
    lastRunMs: nowT, lastAttemptMs: nowT, lastDay: dayKeyOf(lastClosedStart), written,
  }));
  return { written, filesRead: scan.filesRead, bytesRead: scan.bytesRead, filesSeen: scan.filesSeen, dataThrough: state.dataThroughMs ? iso(state.dataThroughMs) : null };
}

// --- Lock, launch ----------------------------------------------------------------------

export function takeLock(nowT = Date.now()) {
  const f = checkupPaths().lock;
  try {
    mkdirSync(dirname(f), { recursive: true });
    try {
      const age = nowT - statSync(f).mtimeMs;
      if (age > LOCK_STALE_MS) unlinkSync(f);
    } catch { /* no lock */ }
    closeSync(openSync(f, 'wx'));
    writeFileSync(f, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function dropLock() {
  try { unlinkSync(checkupPaths().lock); } catch { /* already gone */ }
}

// Is a run due: the latest closed day is not yet covered by a finished run, and
// the last attempt was not within RETRY_MS.
export function checkupDue(nowT = nowMs()) {
  const status = readJsonSafe(checkupPaths().status, {}) || {};
  const latestClosed = dayKeyOf(dayStartMs(nowT) - DAY_MS);
  if (status.lastDay === latestClosed) return false;
  if (Number.isFinite(status.lastAttemptMs) && nowT - status.lastAttemptMs < RETRY_MS && nowT >= status.lastAttemptMs) return false;
  return true;
}

export function checkupScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'daily-checkup.mjs');
}

// Start the checkup as a detached, hidden background process and return at
// once. The scout and the main-session SessionStart hook both call this; the
// attempt stamp and the lock keep two callers from running it twice.
export function launchCheckup({ nowT = nowMs(), spawnFn = spawn } = {}) {
  if (process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH) return { launched: false, reason: 'disabled-by-env' };
  if (!opt('daily_checkup', true)) return { launched: false, reason: 'option-off' };
  if (!checkupDue(nowT)) return { launched: false, reason: 'not-due' };
  const p = checkupPaths();
  const prev = readJsonSafe(p.status, {}) || {};
  try { atomicWrite(p.status, JSON.stringify({ ...prev, lastAttemptMs: nowT })); } catch { return { launched: false, reason: 'state-unwritable' }; }
  try {
    const child = spawnFn(process.execPath, [checkupScriptPath()], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return { launched: true };
  } catch {
    return { launched: false, reason: 'spawn-failed' };
  }
}

// --- The SessionStart line --------------------------------------------------------------

function fmtPct(x) { return Number.isFinite(x) ? `${r1(x)}%` : 'n/a'; }

export function formatLine(rec, historyPath) {
  const sw = rec.changes && Array.isArray(rec.changes.switchedOn) && rec.changes.switchedOn.length
    ? `; switched on that day: ${rec.changes.switchedOn.join(', ')}` : '';
  const delta = rec.vsTargetPct >= 0 ? `+${r1(rec.vsTargetPct)}` : `${r1(rec.vsTargetPct)}`;
  return `[agent-companion] Daily checkup ${rec.day} (08:00Z to 08:00Z): ${fmtPct(rec.pct.total)} of the weekly limit `
    + `against the ${fmtPct(rec.targetPct)} target (${delta}); week so far ${fmtPct(rec.week.pctSoFar)}, pace at reset ${fmtPct(rec.week.paceAtResetPct)}${sw}. `
    + `History: ${historyPath}`;
}

// The line for the latest day not yet shown, or null. Never throws.
export function pendingSurface({ nowT = nowMs() } = {}) {
  try {
    const p = checkupPaths();
    const hist = readHistory(p.history);
    if (!hist.length) return null;
    const rec = hist[hist.length - 1];
    if (!rec.pct || !rec.week || !Number.isFinite(rec.pct.total)) return null;
    const shown = (readJsonSafe(p.surfaced, {}) || {}).day;
    if (typeof shown === 'string' && rec.day <= shown) return null;
    const endMs = Date.parse(rec.to);
    if (!Number.isFinite(endMs) || nowT - endMs > SURFACE_MAX_AGE_MS) return null;
    return { rec, line: formatLine(rec, p.history) };
  } catch {
    return null;
  }
}

export function markSurfaced(day) {
  try { atomicWrite(checkupPaths().surfaced, JSON.stringify({ day })); } catch { /* fail open */ }
}
