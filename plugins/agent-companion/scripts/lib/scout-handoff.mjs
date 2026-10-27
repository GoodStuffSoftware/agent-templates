// Scout hand-off: turn the scout's overwrite-only result into something a lead
// can act on, with no model call.
//
// The scout writes scout-latest.json (overwritten) and scout-history.jsonl.
// Neither says what is NEW, what CLEARED, or which signal has repeated for days
// with nobody looking. This module keeps that bookkeeping:
//
//   state/scout-delta-state.json   per-kind run tracking (first day, days repeating,
//                                  last entries) plus what the latest run changed
//   state/scout-acks.json          acknowledgement ledger (a kind, optionally a detail
//                                  match, triaged with a note and an expiry)
//   state/scout-delta.json         the evaluated view (new / cleared / changed /
//   state/scout-delta.md           repeating / unacknowledged), machine and human form
//
// Pure functions first, file I/O at the bottom. Nothing here spawns a process,
// reads the network or calls a model. Every writer fails open: a scout run must
// never be broken by its own bookkeeping.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';

export const STATE_VERSION = 1;
export const DEFAULT_REPEAT_DAYS = 3;
export const DEFAULT_ACK_DAYS = 14;
export const MAX_HISTORY_LINES = 400;

// "Materially changed" thresholds (see materialChange below).
export const MATERIAL_MIN_GROWTH = 2; // at least this many more entries than at ack time
export const MATERIAL_GROWTH_RATIO = 0.5; // and at least this share of the acked count
export const MATERIAL_SIMILARITY = 0.6; // an entry this dissimilar (word-set Jaccard) from every acked entry is new

// ---------- text helpers -----------------------------------------------------

// Digits become '#': "462 spawns/24h" and "471 spawns/24h" are the same thing
// moving; "bounded-feature routing trial" and "integration routing trial" are not.
export function normalizeDetail(detail) {
  return String(detail ?? '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function wordSet(normalized) {
  return new Set(String(normalized).split(/[^a-z0-9_#.\-/]+/).filter(Boolean));
}

export function similarity(a, b) {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function dayOf(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function daysBetween(dayA, dayB) {
  return Math.round((Date.parse(`${dayB}T00:00:00Z`) - Date.parse(`${dayA}T00:00:00Z`)) / 86400000);
}

// A signal unacknowledged for more than this many days stops being repeated in the
// SessionStart line: the scout's decide step (scripts/intake-decide.mjs) turns it
// into a "decide" finding for the morning brief.
export const STALE_DAYS = 7;

// Whole days from an entry's firstDay to the day of `atIso`; null when unreadable.
export function ageDaysOf(entry, atIso) {
  const from = entry && /^\d{4}-\d{2}-\d{2}$/.test(String(entry.firstDay)) ? entry.firstDay : null;
  const to = dayOf(atIso);
  return from && to ? daysBetween(from, to) : null;
}

// ---------- grouping a scout result by kind ---------------------------------

export function groupByKind(signals) {
  const out = {};
  for (const s of Array.isArray(signals) ? signals : []) {
    const kind = String((s && s.kind) || 'unknown');
    (out[kind] ||= []).push({ detail: String((s && s.detail) ?? ''), dispatch: String((s && s.dispatch) ?? '') });
  }
  return out;
}

function entriesKey(entries) {
  return entries.map((e) => e.detail).sort().join('\u0001');
}

function normKey(entries) {
  return entries.map((e) => normalizeDetail(e.detail)).sort().join('\u0001');
}

// A hand-edited or damaged state file can hold a kind that is not an object or has
// no entries array. Such a kind is dropped here, so no reader throws on it.
export function sanitizeKinds(kinds) {
  const out = {};
  if (!kinds || typeof kinds !== 'object') return out;
  for (const [k, g] of Object.entries(kinds)) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.entries)) continue;
    const entries = g.entries.filter((e) => e && typeof e === 'object').map((e) => ({ ...e, detail: String(e.detail ?? '') }));
    out[k] = { ...g, entries, days: Number.isFinite(g.days) ? g.days : 1, count: Number.isFinite(g.count) ? g.count : entries.length };
  }
  return out;
}

// ---------- one run: update the per-kind tracking and derive the delta -------

export function emptyState() {
  return { version: STATE_VERSION, checkedAt: null, day: null, kinds: {}, lastRun: { new: [], cleared: [], changed: [] } };
}

// state + one scout result -> { state, delta }. A second run on the same UTC day
// does not add a repeating day (the days counter counts calendar days, not runs).
// A kind absent from a run is cleared: its streak ends and a later return starts a
// new one.
export function applyRun(state, result) {
  const prev = state && state.kinds ? { ...state, kinds: sanitizeKinds(state.kinds) } : emptyState();
  const checkedAt = result && result.checkedAt ? result.checkedAt : new Date().toISOString();
  const day = dayOf(checkedAt) || new Date().toISOString().slice(0, 10);
  const current = groupByKind(result && result.signals);
  const kinds = {};
  const run = { new: [], cleared: [], changed: [] };

  for (const [kind, entries] of Object.entries(current)) {
    const before = prev.kinds[kind];
    if (!before) {
      kinds[kind] = { firstDay: day, lastDay: day, days: 1, count: entries.length, entries };
      run.new.push({ kind, count: entries.length, detail: firstDetail(entries) });
      continue;
    }
    const sameDay = before.lastDay === day;
    kinds[kind] = {
      firstDay: before.firstDay,
      lastDay: day,
      days: sameDay ? before.days : before.days + 1,
      count: entries.length,
      entries,
    };
    if (before.count !== entries.length) {
      run.changed.push({ kind, change: 'count', from: before.count, to: entries.length, detail: firstDetail(entries) });
    } else if (entriesKey(before.entries) !== entriesKey(entries)) {
      const material = normKey(before.entries) !== normKey(entries);
      run.changed.push({ kind, change: material ? 'detail' : 'numbers', from: before.count, to: entries.length, detail: firstDetail(entries) });
    }
  }
  for (const [kind, before] of Object.entries(prev.kinds)) {
    if (!current[kind]) run.cleared.push({ kind, days: before.days, count: before.count });
  }
  return { state: { version: STATE_VERSION, checkedAt, day, kinds, lastRun: run }, delta: run };
}

function firstDetail(entries) {
  const d = (entries[0] && entries[0].detail) || '';
  return d.length > 200 ? `${d.slice(0, 197)}...` : d;
}

// Replay history rows (oldest first) through applyRun so a fresh install, or one
// whose delta state was lost, starts with the real "days repeating" instead of
// day 1 for everything.
export function replayHistory(rows) {
  let state = emptyState();
  for (const r of rows) {
    if (r && Array.isArray(r.signals) && r.checkedAt) state = applyRun(state, r).state;
  }
  return state;
}

// ---------- acknowledgements --------------------------------------------------

export function emptyAcks() {
  return { version: STATE_VERSION, acks: [] };
}

function matchesAck(ack, entry) {
  if (!ack.match) return true;
  return entry.detail.toLowerCase().includes(String(ack.match).toLowerCase());
}

function coveredEntries(ack, kinds) {
  const group = kinds[ack.kind];
  return group ? group.entries.filter((e) => matchesAck(ack, e)) : [];
}

// What an ack remembers about the thing it triaged.
export function snapshotFor(ack, kinds) {
  const covered = coveredEntries(ack, kinds);
  return { count: covered.length, details: covered.map((e) => normalizeDetail(e.detail)) };
}

// Has the signal an ack covers changed enough that the triage no longer holds?
//   1. it GREW: at least MATERIAL_MIN_GROWTH more entries than at ack time AND at
//      least MATERIAL_GROWTH_RATIO of the acked count (4 -> 6 re-raises; 10 -> 11
//      does not; 1 -> 3 does). Shrinking never re-raises: that is improvement.
//   2. a NEW thing appeared: some current entry shares less than MATERIAL_SIMILARITY
//      (digit-normalised word-set overlap) with every entry the ack saw. Numbers
//      moving ("462 spawns" -> "471 spawns") or one name in a long list changing is
//      not new; a different trial, a different release line, a different sentence is.
// A covered set that is empty now is not material (nothing to raise).
export function materialChange(ack, kinds) {
  const raw = ack.snapshot && typeof ack.snapshot === 'object' ? ack.snapshot : {};
  const snap = { count: Number.isFinite(raw.count) ? raw.count : 0, details: Array.isArray(raw.details) ? raw.details : [] };
  const covered = coveredEntries(ack, kinds);
  if (covered.length === 0) return false;
  const growth = covered.length - snap.count;
  if (growth >= MATERIAL_MIN_GROWTH && growth >= Math.ceil(snap.count * MATERIAL_GROWTH_RATIO)) return true;
  for (const e of covered) {
    const n = normalizeDetail(e.detail);
    let best = 0;
    for (const d of snap.details) best = Math.max(best, similarity(n, d));
    if (best < MATERIAL_SIMILARITY) return true;
  }
  return false;
}

// An ack with no readable expiry counts as expired: the safe direction is to show
// the signal again, never to hide it for good.
export function ackIsExpired(ack, nowMs) {
  const t = Date.parse(ack && ack.expires);
  return !Number.isFinite(t) || nowMs > t;
}

// "2026-11-01" -> end of that UTC day; a full timestamp is kept as given.
export function parseExpiry(value, nowMs, { days } = {}) {
  if (value) {
    const s = String(value).trim();
    const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59.999Z`) : Date.parse(s);
    if (!Number.isFinite(t)) return { error: `cannot read expiry "${s}" (use YYYY-MM-DD)` };
    if (t <= nowMs) return { error: `expiry ${s} is not in the future` };
    return { iso: new Date(t).toISOString() };
  }
  const n = days === undefined ? DEFAULT_ACK_DAYS : Number(days);
  if (!Number.isFinite(n) || n <= 0) return { error: `--days must be a positive number` };
  return { iso: new Date(nowMs + n * 86400000).toISOString() };
}

export function addAck(acks, { kind, match, note, expires, kinds, nowMs }) {
  const base = { kind: String(kind), ...(match ? { match: String(match) } : {}) };
  const id = `a${nowMs.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const ack = {
    id, ...base, note: String(note), expires, createdAt: new Date(nowMs).toISOString(),
    snapshot: snapshotFor(base, kinds),
  };
  // A new ack on the same kind+match replaces the old one (renewal).
  const rest = acks.acks.filter((a) => !(a.kind === ack.kind && String(a.match || '').toLowerCase() === String(ack.match || '').toLowerCase()));
  return { acks: { ...acks, acks: [...rest, ack] }, ack };
}

export function removeAck(acks, id) {
  const hit = acks.acks.filter((a) => a.id === id);
  if (hit.length === 0) return { acks, removed: null };
  return { acks: { ...acks, acks: acks.acks.filter((a) => a.id !== id) }, removed: hit[0] };
}

// ---------- evaluating the view ----------------------------------------------

// state + acks + clock -> the evaluated hand-off. Per kind:
//   unacked entries  = entries no live ack covers (expired or materially-changed acks do not cover)
//   acknowledged     = kinds where every entry is covered
//   repeating        = days >= threshold and at least one unacked entry
export function evaluate(state, acks, { nowMs = Date.now(), threshold = DEFAULT_REPEAT_DAYS } = {}) {
  const kinds = sanitizeKinds(state.kinds);
  const ledger = Array.isArray(acks && acks.acks) ? acks.acks.filter((a) => a && typeof a === 'object') : [];
  const live = [];
  const expired = [];
  const reRaised = [];
  for (const a of ledger) {
    if (ackIsExpired(a, nowMs)) { expired.push(a); continue; }
    if (materialChange(a, kinds)) { reRaised.push(a); continue; }
    live.push(a);
  }

  const unacknowledged = [];
  const acknowledged = [];
  for (const [kind, g] of Object.entries(kinds)) {
    const open = g.entries.filter((e) => !live.some((a) => a.kind === kind && matchesAck(a, e)));
    const base = { kind, days: g.days, firstDay: g.firstDay, count: g.count, actionable: g.entries.some((e) => e.dispatch && e.dispatch !== 'none') };
    if (open.length === 0) {
      const a = live.find((x) => x.kind === kind);
      acknowledged.push({ ...base, ackId: a ? a.id : null, note: a ? a.note : '', expires: a ? a.expires : null });
    } else {
      unacknowledged.push({ ...base, open: open.length, detail: firstDetail(open), repeating: g.days >= threshold });
    }
  }
  // Action first (a signal with a dispatch), then the longest streak, then size.
  unacknowledged.sort((x, y) => (Number(y.actionable) - Number(x.actionable)) || (y.days - x.days) || (y.count - x.count) || x.kind.localeCompare(y.kind));
  acknowledged.sort((x, y) => x.kind.localeCompare(y.kind));
  const lr = state.lastRun || { new: [], cleared: [], changed: [] };
  return {
    version: STATE_VERSION,
    checkedAt: state.checkedAt,
    evaluatedAt: new Date(nowMs).toISOString(),
    thresholdDays: threshold,
    new: lr.new,
    cleared: lr.cleared,
    changed: lr.changed,
    repeating: unacknowledged.filter((u) => u.repeating),
    unacknowledged,
    acknowledged,
    expiredAcks: expired.map((a) => ({ id: a.id, kind: a.kind, match: a.match || null, note: a.note, expires: a.expires })),
    reRaisedAcks: reRaised.map((a) => ({ id: a.id, kind: a.kind, match: a.match || null, note: a.note })),
  };
}

// ---------- the human file -----------------------------------------------------

export function renderMarkdown(view, { ackCommand = 'node <plugin>/scripts/scout-ack.mjs' } = {}) {
  const L = [];
  L.push(`# Scout hand-off (${String(view.checkedAt || '').slice(0, 16).replace('T', ' ')} UTC)`);
  L.push('');
  L.push(`Written by the scout with no model call. Repeating = ${view.thresholdDays}+ days in a row (option scout_repeat_days).`);
  L.push('');
  const section = (title, items, fmt) => {
    L.push(`## ${title} (${items.length})`);
    if (items.length === 0) L.push('- none');
    else for (const i of items) L.push(`- ${fmt(i)}`);
    L.push('');
  };
  section('Needs triage: unacknowledged', view.unacknowledged, (u) =>
    `${u.kind}: day ${u.days}, ${u.open}/${u.count} open${u.actionable ? '' : ' (informational)'}. ${u.detail}`);
  section('New this run', view.new, (n) => `${n.kind} x${n.count}: ${n.detail}`);
  section('Cleared this run', view.cleared, (c) => `${c.kind} (was day ${c.days}, x${c.count})`);
  section('Changed this run', view.changed, (c) =>
    `${c.kind}: ${c.change === 'count' ? `count ${c.from} -> ${c.to}` : c.change === 'detail' ? 'detail changed' : 'numbers moved'}`);
  section('Acknowledged', view.acknowledged, (a) => `${a.kind}: ${a.note} (until ${String(a.expires).slice(0, 10)}, ${a.ackId})`);
  if (view.expiredAcks.length) section('Acks that expired', view.expiredAcks, (a) => `${a.kind}${a.match ? ` [${a.match}]` : ''}: ${a.note} (${a.id})`);
  if (view.reRaisedAcks.length) section('Acks voided by a material change', view.reRaisedAcks, (a) => `${a.kind}${a.match ? ` [${a.match}]` : ''}: ${a.note} (${a.id})`);
  L.push('## Acknowledge a triaged signal');
  L.push('');
  L.push('```');
  L.push(`${ackCommand} add <kind> --note "<decision reference>" [--match "<detail text>"] [--days 14 | --expires YYYY-MM-DD]`);
  L.push(`${ackCommand} list`);
  L.push(`${ackCommand} remove <id>`);
  L.push('```');
  L.push('');
  L.push('An ack holds until it expires, or the signal grows (at least 2 more entries and half again as many) or shows a new kind of entry (under 60% word overlap with everything acked). Then it is raised again.');
  L.push('');
  return L.join('\n');
}

// ---------- file I/O (fail open) -----------------------------------------------

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function paths(dir) {
  return {
    state: join(dir, 'scout-delta-state.json'),
    acks: join(dir, 'scout-acks.json'),
    delta: join(dir, 'scout-delta.json'),
    md: join(dir, 'scout-delta.md'),
    history: join(dir, 'scout-history.jsonl'),
    latest: join(dir, 'scout-latest.json'),
  };
}

export function readAcks(dir) {
  const j = readJsonSafe(paths(dir).acks, null);
  return j && Array.isArray(j.acks) ? { ...j, acks: j.acks.filter((a) => a && typeof a === 'object') } : emptyAcks();
}

// true when the ledger file exists but is not a readable ledger (truncated, not
// JSON, or JSON of another shape). readAcks reads such a file as empty.
export function ledgerUnreadable(dir) {
  const file = paths(dir).acks;
  try {
    if (!existsSync(file)) return false;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return !(j && Array.isArray(j.acks));
  } catch { return true; }
}

// An unreadable ledger is copied aside (scout-acks.json.bad, then .bad.1, ...)
// before it is replaced, so a write never destroys what a person could repair.
function backUpUnreadableLedger(dir) {
  if (!ledgerUnreadable(dir)) return null;
  const file = paths(dir).acks;
  let bak = `${file}.bad`;
  for (let i = 1; existsSync(bak); i += 1) bak = `${file}.bad.${i}`;
  copyFileSync(file, bak);
  return bak;
}

export function writeAcks(dir, acks) {
  backUpUnreadableLedger(dir);
  writeAtomic(paths(dir).acks, `${JSON.stringify(acks, null, 2)}\n`);
}

// Read-modify-write of the ledger under one lock, so two parallel writers
// (two `scout-ack add`, or an add beside a scout run) do not lose an ack.
// failOpen true (the scout): on a lock timeout the change still runs, unlocked.
export function withAcksLock(dir, fn, { failOpen = true, waitMs = 5000 } = {}) {
  const p = paths(dir);
  return withFileLock(`${p.acks}.lock`, fn, { waitMs, failOpen, debris: [p.acks] });
}

export function readState(dir) {
  const j = readJsonSafe(paths(dir).state, null);
  return j && j.kinds && typeof j.kinds === 'object' ? { ...j, kinds: sanitizeKinds(j.kinds) } : null;
}

function readHistoryRows(file) {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_HISTORY_LINES);
    const rows = [];
    for (const l of lines) { try { rows.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
    return rows;
  } catch { return []; }
}

// Write the evaluated view (json + md) from the stored state and acks.
export function refreshView(dir, { nowMs = Date.now(), threshold = DEFAULT_REPEAT_DAYS, ackCommand } = {}) {
  const p = paths(dir);
  const state = readState(dir);
  if (!state) return null;
  const view = evaluate(state, readAcks(dir), { nowMs, threshold });
  writeAtomic(p.delta, `${JSON.stringify(view, null, 2)}\n`);
  writeAtomic(p.md, renderMarkdown(view, ackCommand ? { ackCommand } : undefined));
  return view;
}

// The scout's hook: called by detect.mjs right after it writes scout-latest.json
// and appends the history row. `result` is that same object. With no stored state
// (first run, or the state file was lost) the history is replayed first, minus the
// row just appended for this run, so days repeating is real from the start.
export function recordRun(dir, result, { nowMs = Date.now(), threshold = DEFAULT_REPEAT_DAYS, ackCommand } = {}) {
  const p = paths(dir);
  let prev = readState(dir);
  if (!prev) {
    const rows = readHistoryRows(p.history).filter((r) => r && r.checkedAt !== result.checkedAt);
    prev = replayHistory(rows);
  }
  const { state, delta } = applyRun(prev, result);
  writeAtomic(p.state, `${JSON.stringify(state, null, 2)}\n`);
  // An ack must not outlive its signal: a kind this run no longer reports loses
  // its acks, so a return (even a new version pair) shows again.
  if (delta.cleared.length > 0) {
    const gone = new Set(delta.cleared.map((c) => c.kind));
    try {
      withAcksLock(dir, () => {
        const cur = readAcks(dir);
        const kept = cur.acks.filter((a) => !gone.has(a.kind));
        if (kept.length !== cur.acks.length) writeAcks(dir, { ...cur, acks: kept });
      });
    } catch { /* the scout never fails on its bookkeeping */ }
  }
  return refreshView(dir, { nowMs, threshold, ackCommand });
}

// The command a lead runs to ack, anchored at the plugin copy that wrote the file.
export function ackCommandFor(pluginRoot) {
  return `node "${String(pluginRoot).replace(/\\/g, '/')}/scripts/scout-ack.mjs"`;
}

// ---------- triage-session matching -----------------------------------------------

function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/').trim();
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s); // /c/Users/x -> c:/Users/x
  if (m) s = `${m[1]}:/${m[2]}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

// Patterns are separated by commas, semicolons or newlines (never spaces: paths
// have them). A pattern is a path prefix: it matches that directory and anything
// below it (so a repo path also covers its .claude/worktrees/*). `*` matches any
// run of characters. Case-insensitive; backslashes and /c/ forms are normalised.
export function parseTriagePatterns(raw) {
  return String(raw ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

export function isTriageCwd(cwd, patterns) {
  const list = Array.isArray(patterns) ? patterns : parseTriagePatterns(patterns);
  if (list.length === 0 || !cwd) return false;
  const target = normPath(cwd);
  for (const pat of list) {
    const n = normPath(pat);
    if (!n) continue;
    const re = new RegExp(`^${n.split('*').map(escapeRe).join('.*')}(/.*)?$`);
    if (re.test(target)) return true;
  }
  return false;
}

// ---------- the SessionStart line for a triage session -------------------------------

// Returns null when there is nothing unacknowledged to say (the caller then shows
// nothing from the scout for this session). Two lines at most.
export function triageLine(view, { mdPath, ackHint, skipKinds = [], staleDays = STALE_DAYS } = {}) {
  const skip = new Set(skipKinds);
  const all = (view.unacknowledged || []).filter((u) => !skip.has(u.kind));
  if (all.length === 0) return null;
  // Signals open past STALE_DAYS are decisions in the morning brief, not a repeated line.
  const isStale = (u) => { const a = ageDaysOf(u, view.evaluatedAt || view.checkedAt); return a !== null && a > staleDays; };
  const open = all.filter((u) => !isStale(u));
  const stale = all.length - open.length;
  const briefNote = stale > 0 ? `${stale} open over ${staleDays} days: decision in the morning brief` : '';
  const top = open.slice(0, 3).map((u) => `${u.kind} (day ${u.days}${u.count > 1 ? `, x${u.count}` : ''})`).join('; ');
  const more = open.length > 3 ? ` +${open.length - 3} more` : '';
  const first = open.length === 0
    ? `[agent-companion] Scout triage: ${briefNote}. Delta: ${mdPath}`
    : `[agent-companion] Scout triage: ${open.length} unacknowledged signal(s): ${top}${more}${briefNote ? `; ${briefNote}` : ''}. Delta: ${mdPath}`;
  return [
    first,
    `For the plugin owner, not other tasks. Ack: ${ackHint}`,
  ].join('\n');
}
