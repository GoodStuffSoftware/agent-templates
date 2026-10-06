// Session budget advisory: how many plan units this WHOLE session has used
// (the lead plus every subagent), and a one-time notice to the lead each time
// that total crosses another multiple of `session_budget_units`.
//
// A notice only. Nothing here blocks or denies; every failure is swallowed
// (callers fail open).
//
// --- Plan units --------------------------------------------------------------
// The plugin's existing plan-usage pricing, not a second table
// (scripts/lib/pricing.mjs planPriceSpecFor, the same function the compaction
// advisor and bench/runner.mjs's plan_usage_index use): every model's tokens
// priced at the BASELINE tier's rates (Sonnet 5, the tier config/model-tiers.json
// planUsageMultipliers defines as 1.0) times the model's own tier multiplier.
// A tier with no measured multiplier (haiku, fable) has no plan figure there;
// for the budget it is counted at its own API list price, which is its
// API-price ratio to the baseline as the multiplier (haiku 0.5, fable 5, the
// same stand-ins the 2026-10-02 usage postmortem used), and the row says how
// many turns were estimated that way. A model with no price at all counts as
// zero and is counted separately.
//
// --- Tracking a whole session cheaply ----------------------------------------
// The lead's transcript is <project>/<session_id>.jsonl and each subagent
// writes <project>/<session_id>/subagents/**/agent-<id>.jsonl (layout checked
// in lib/runaway.mjs). Every call reads only the BYTES APPENDED SINCE THE LAST
// CALL: per file, state/session-budget/<session_id>.json keeps the byte offset
// after the last complete line, the units already settled, and the one request
// still open (a request is written as several assistant lines sharing a
// requestId, whose usage is the field-wise MAX, never a sum: the D1 rule of
// lib/transcripts.mjs and lib/runaway.mjs). So a quiet session costs a few
// stat calls, and a resumed session with a huge history is caught up over
// several calls: the scan stops at a deadline, saves its progress, and the
// total it has is a lower bound that only grows.
//
// --- Crossing ------------------------------------------------------------------
// level = floor(total / threshold) * threshold. A notice fires, once the scan
// is complete, when level is above the level already announced; one notice per call however many
// multiples were skipped, and an exclusive-create claim per level keeps two
// racing hooks from both announcing it. The notice is QUEUED for the lead
// (queueNotice in lib/runaway.mjs) and drained by hooks/runaway-notice.mjs on
// the lead's next UserPromptSubmit or right after a foreground Agent returns:
// the runaway-notice delivery path.

import {
  openSync, fstatSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, statSync, renameSync, rmSync,
} from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, appendLog } from './context.mjs';
import { planPriceSpecFor, priceUsage } from '../../scripts/lib/pricing.mjs';
import { usageOf, queueNotice, safe } from './runaway.mjs';

export const SESSION_BUDGET_DEFAULT_UNITS = 350;
// Shipped default for the weekly allowance when config/session-budget.json is
// unreadable (2026-10-06 recalibration: 1% of the weekly limit = 26.8 units).
export const WEEKLY_PLAN_UNITS_DEFAULT = 2677;
const CHUNK_BYTES = 8 * 1024 * 1024;
export const BUDGET_DEADLINE_MS = 2500;
const RECENT_KEYS = 64;
const MAX_FILES = 2000;
const STATE_TTL_MS = 7 * 86400000;

let _week = null;
export function weeklyPlanUnits() {
  if (_week) return _week;
  let n = WEEKLY_PLAN_UNITS_DEFAULT;
  try {
    const f = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'session-budget.json');
    const v = Number(JSON.parse(readFileSync(f, 'utf8')).weeklyPlanUnits);
    if (Number.isFinite(v) && v > 0) n = v;
  } catch { /* shipped default */ }
  _week = n;
  return n;
}

// Plan units for one usage record (lib/runaway.mjs usageOf shape).
// { units, estimated } or null when the model has no price at all.
export function planUnitsOf(usage, model) {
  const spec = planPriceSpecFor(model);
  if (spec) {
    const w1 = usage.cacheWrite1h || 0;
    const w5 = Math.max(0, (usage.cacheWrite || 0) - w1);
    const base = (usage.input || 0) + w5 * spec.w5 + w1 * spec.w1
      + (usage.cacheRead || 0) * spec.r + (usage.output || 0) * spec.outRatio;
    return { units: base * spec.inUsd * spec.multiplier, estimated: false };
  }
  const priced = priceUsage(usage, model);
  if (!priced) return null;
  return { units: priced.usd, estimated: true };
}

// --- Per-file state ---------------------------------------------------------------

function freshFile() {
  return { off: 0, settled: 0, estTurns: 0, unpriced: 0, pend: null, recent: [] };
}

function settle(f) {
  if (!f.pend) return;
  const r = planUnitsOf(f.pend.usage, f.pend.model);
  if (r) { f.settled += r.units; if (r.estimated) f.estTurns += 1; } else f.unpriced += 1;
  f.recent.push(f.pend.key);
  if (f.recent.length > RECENT_KEYS) f.recent.shift();
  f.pend = null;
}

function feedLine(f, line, anon) {
  if (!line.includes('"type":"assistant"')) return anon;
  let rec;
  try { rec = JSON.parse(line); } catch { return anon; }
  if (!rec || rec.type !== 'assistant') return anon;
  const msg = rec.message || {};
  if (msg.model === '<synthetic>') return anon;
  const key = rec.requestId || msg.id || `anon-${f.off}-${anon + 1}`;
  const u = usageOf(msg.usage);
  if (f.pend && f.pend.key === key) {
    for (const k of Object.keys(u)) f.pend.usage[k] = Math.max(f.pend.usage[k] || 0, u[k]);
    if (msg.model) f.pend.model = msg.model;
    return anon;
  }
  if (f.recent.includes(key)) return anon; // a request already settled: never counted twice
  settle(f);
  f.pend = { key, usage: u, model: msg.model || '' };
  return key.startsWith('anon-') ? anon + 1 : anon;
}

// Read what is new in one file. Returns true when the file was read to its
// end, false when the deadline stopped it first.
function advanceFile(path, f, deadline) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size < f.off) Object.assign(f, freshFile()); // truncated or replaced: start over
    let anon = 0;
    while (f.off < size) {
      if (Date.now() > deadline) return false;
      const len = Math.min(CHUNK_BYTES, size - f.off);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, f.off);
      let end = buf.lastIndexOf(10); // last newline
      let consumed;
      if (end >= 0) consumed = end + 1;
      else if (f.off + len < size) consumed = len; // one line longer than a chunk: skip it
      else break; // a partial last line still being written: next call
      const text = buf.toString('utf8', 0, end >= 0 ? end : consumed);
      for (const line of text.split('\n')) anon = feedLine(f, line, anon);
      f.off += consumed;
    }
    return true;
  } catch {
    return true; // unreadable: leave the file's state as is
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Units, estimated turns and unpriced turns for one file, the open request included.
function totalsOfFile(f) {
  let units = f.settled;
  let est = f.estTurns;
  let unpriced = f.unpriced;
  if (f.pend) {
    const r = planUnitsOf(f.pend.usage, f.pend.model);
    if (r) { units += r.units; if (r.estimated) est += 1; } else unpriced += 1;
  }
  return { units, est, unpriced };
}

// Every *.jsonl under <dir>, a few levels deep (workflow agents live under
// subagents/workflows/<id>/). Bounded.
function listTranscripts(dir, out = [], depth = 0) {
  if (depth > 3 || out.length >= MAX_FILES) return out;
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory()) listTranscripts(p, out, depth + 1);
    else if (d.isFile() && d.name.endsWith('.jsonl') && out.length < MAX_FILES) out.push(p);
  }
  return out;
}

function budgetDir() { return join(stateDir(), 'session-budget'); }
function stateFileOf(sessionId) { return join(budgetDir(), `${safe(sessionId)}.json`); }

function loadState(sessionId) {
  try {
    const s = JSON.parse(readFileSync(stateFileOf(sessionId), 'utf8'));
    if (s && typeof s === 'object' && s.files && typeof s.files === 'object') return { ...s, fresh: false };
  } catch { /* none yet */ }
  return { files: {}, level: 0, fresh: true };
}

function saveState(sessionId, s) {
  try {
    mkdirSync(budgetDir(), { recursive: true });
    const f = stateFileOf(sessionId);
    const tmp = `${f}.${process.pid}.tmp`;
    const { fresh, ...rest } = s;
    writeFileSync(tmp, JSON.stringify(rest));
    renameSync(tmp, f);
  } catch { /* best effort */ }
}

export function pruneBudgetState(now = Date.now()) {
  let names = [];
  try { names = readdirSync(budgetDir()); } catch { return; }
  const old = (f) => { try { return now - statSync(f).mtimeMs > STATE_TTL_MS; } catch { return false; } };
  for (const n of names) {
    const f = join(budgetDir(), n);
    if (n === 'claims') { // claims are files inside a directory whose own mtime tracks the newest one
      let cs = [];
      try { cs = readdirSync(f); } catch { /* none */ }
      for (const c of cs) { try { if (old(join(f, c))) rmSync(join(f, c), { force: true }); } catch { /* best effort */ } }
    } else {
      try { if (old(f)) rmSync(f, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// Exclusive create: the one process whose create wins announces the level.
function claimLevel(sessionId, level) {
  try {
    const dir = join(budgetDir(), 'claims');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safe(sessionId)}.${level}.seen`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// Total plan units for the session, advancing the saved scan. { total, files,
// complete, estTurns, unpriced, state }. `state` is mutated and must be saved.
export function scanSession({ sessionId, transcriptPath, deadline, state }) {
  const lead = String(transcriptPath);
  const subDirs = [];
  const stem = basename(lead).replace(/\.jsonl$/i, '');
  for (const id of [...new Set([sessionId, stem])]) {
    const d = join(dirname(lead), id, 'subagents');
    try { if (statSync(d).isDirectory()) subDirs.push(d); } catch { /* none */ }
  }
  const paths = [lead];
  for (const d of subDirs) listTranscripts(d, paths);
  let complete = true;
  for (const p of paths) {
    const key = p === lead ? '(lead)' : relative(dirname(lead), p).replace(/\\/g, '/');
    const f = state.files[key] || (state.files[key] = freshFile());
    let size = -1;
    try { size = statSync(p).size; } catch { continue; }
    if (size === f.off) continue;
    if (!advanceFile(p, f, deadline)) { complete = false; break; }
  }
  let total = 0;
  let estTurns = 0;
  let unpriced = 0;
  for (const f of Object.values(state.files)) {
    const t = totalsOfFile(f);
    total += t.units; estTurns += t.est; unpriced += t.unpriced;
  }
  return { total, files: paths.length, complete, estTurns, unpriced };
}

export function budgetNoticeText(total) {
  const n = Math.round(total);
  const pct = Math.round((total / weeklyPlanUnits()) * 100);
  return `[agent-companion] This session, including its subagents, has used about ${n} plan units (~${pct}% of a ~${weeklyPlanUnits().toLocaleString('en-US')}-unit week). `
    + 'At the next phase boundary, finish the phase, update SESSION-STATE.md, and offer the operator a hand-off to a fresh session. '
    + 'Do not hand off mid-release or while agents are running.';
}

// The hook's whole job, for one lead payload. Never throws. Returns what it
// did, for tests: { fired, total, level, ... } or { skipped: why }.
export function checkSessionBudget(p, { threshold, now = Date.now(), deadlineMs = BUDGET_DEADLINE_MS, notify = queueNotice } = {}) {
  try {
    if (!(threshold > 0)) return { skipped: 'off' };
    if (!p || !p.session_id || !p.transcript_path) return { skipped: 'no-transcript' };
    const state = loadState(p.session_id);
    const r = scanSession({
      sessionId: p.session_id, transcriptPath: p.transcript_path, deadline: now + deadlineMs, state,
    });
    const level = Math.floor(r.total / threshold) * threshold;
    const prior = state.level || 0;
    let fired = false;
    // An incomplete scan (deadline hit while catching up on a long history) is a lower
    // bound: announcing it would understate the total and then announce again once the
    // scan finishes. Save the progress and announce when it is complete.
    if (r.complete && level > 0 && level > prior) {
      state.level = level;
      if (claimLevel(p.session_id, level)) {
        fired = true;
        appendLog('session-budget.jsonl', {
          at: new Date(now).toISOString(),
          session_id: p.session_id,
          event: 'crossing',
          units: Math.round(r.total * 100) / 100,
          level,
          threshold,
          week_pct: Math.round((r.total / weeklyPlanUnits()) * 1000) / 10,
          transcripts: r.files,
          scan_complete: r.complete,
          estimated_turns: r.estTurns,
          unpriced_turns: r.unpriced,
        });
        notify(p.session_id, budgetNoticeText(r.total));
      }
    }
    saveState(p.session_id, state);
    if (state.fresh) pruneBudgetState(now);
    return { fired, total: r.total, level, complete: r.complete, files: r.files, estTurns: r.estTurns, unpriced: r.unpriced };
  } catch {
    return { skipped: 'error' };
  }
}
