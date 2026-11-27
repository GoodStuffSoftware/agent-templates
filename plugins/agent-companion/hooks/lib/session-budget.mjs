// Session budget advisory: how many plan units this WHOLE session has used
// (the lead plus every subagent), and a one-time notice to the lead each time
// that total crosses another multiple of `session_budget_units`.
//
// A notice only. Nothing here blocks or denies; every failure is swallowed
// (callers fail open).
//
// --- Plan units --------------------------------------------------------------
// One source of truth: config/plan-weights.json (shipped, plus the per-user file
// <state root>/config/plan-weights.json that scripts/calibrate-weights.mjs writes), read through
// hooks/lib/plan-allowance.mjs. Every model's tokens are priced at the Sonnet 5 vector
// times the model's weight, and 1% of the weekly limit is that file's unitsPerPercent
// (so the week is 100 x that). Nothing here holds a number of its own. A turn on a
// model whose weight is not measured (status assumed or estimated: haiku, fable today)
// is counted all the same and the row says how many such turns there were. A model
// the file does not know falls back to its API list price in dollars (counted as
// estimated); a model with no price at all counts as zero and is counted separately.
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
import { stateDir, appendLog, classifyModel } from './context.mjs';
import { priceUsage } from '../../scripts/lib/pricing.mjs';
import { usageOf, queueNotice, safe } from './runaway.mjs';
import { requestUnits, modelWeight, weeklyLimitUnits, currentRate, rateLabel } from './plan-allowance.mjs';
import { currentConfiguredAccount, accountLimitAt, configuredAccounts, accountHistory, accountAt } from './account.mjs';

export const SESSION_BUDGET_DEFAULT_UNITS = 350;
const CHUNK_BYTES = 4 * 1024 * 1024; // the deadline is checked between chunks, so one big file overruns it by one 4 MB read at most
export const BUDGET_DEADLINE_MS = 2500;
const RECENT_KEYS = 64;
const MAX_FILES = 2000;
const STATE_TTL_MS = 7 * 86400000;

// The weekly limit in plan units: 100 x the units per 1% of the account in use (hooks/lib/plan-allowance.mjs currentRate(): the
// account's own rate, else its plan's, else the shipped default in config/plan-weights.json plus the user file). The plan units
// themselves are the same for every account; only the size of the week differs. An account the plugin cannot tell uses the default.
// With the option claude_accounts set and the signed-in account listed there, the week is THAT account's limit now (its limit
// changes by date applied); otherwise exactly the single-account figure.
export function weeklyPlanUnits(rate = currentRate(), now = Date.now()) {
  const a = currentConfiguredAccount();
  const base = weeklyLimitUnits(rate.value);
  return a ? accountLimitAt(a, now, base) : base;
}

// Plan units for one usage record (lib/runaway.mjs usageOf shape).
// { units, estimated } or null when the model has no price at all.
export function planUnitsOf(usage, model) {
  const alias = classifyModel(model).alias;
  const m = modelWeight(alias);
  if (m.known) return { units: requestUnits(usage, model), estimated: m.status !== 'measured' && m.status !== 'baseline' };
  const priced = priceUsage(usage, model);
  if (!priced) return null;
  return { units: priced.usd, estimated: true };
}

// --- Per-file state ---------------------------------------------------------------

function freshFile() {
  return { off: 0, settled: 0, estTurns: 0, unpriced: 0, pend: null, recent: [] };
}

// Option claude_accounts: which account sent a message, by its timestamp (accountAt over the switch history). '' = no listed account
// (no history covers that time, an uncertain interval, or an account the option does not list). null = the option is unset.
function acctKeyOf(ac, ts) {
  if (!ac) return null;
  const a = accountAt(ac.history, ts);
  return a && ac.ids.has(a) ? a : '';
}

function settle(f, ac) {
  if (!f.pend) return;
  const r = planUnitsOf(f.pend.usage, f.pend.model);
  if (r) {
    f.settled += r.units; if (r.estimated) f.estTurns += 1;
    if (ac) { const k = acctKeyOf(ac, f.pend.ts); const m = (f.acct ||= {}); m[k] = (m[k] || 0) + r.units; }
  } else f.unpriced += 1;
  f.recent.push(f.pend.key);
  if (f.recent.length > RECENT_KEYS) f.recent.shift();
  f.pend = null;
}

function feedLine(f, line, anon, ac) {
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
  settle(f, ac);
  const ts = Date.parse(rec.timestamp);
  f.pend = { key, usage: u, model: msg.model || '', ...(ac ? { ts: Number.isFinite(ts) ? ts : Date.now() } : {}) };
  return key.startsWith('anon-') ? anon + 1 : anon;
}

// Read what is new in one file. Returns true when the file was read to its
// end, false when the deadline stopped it first.
function advanceFile(path, f, deadline, ac) {
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
      for (const line of text.split('\n')) anon = feedLine(f, line, anon, ac);
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
function totalsOfFile(f, ac) {
  let units = f.settled;
  let est = f.estTurns;
  let unpriced = f.unpriced;
  const by = ac ? { ...(f.acct || {}) } : null;
  if (f.pend) {
    const r = planUnitsOf(f.pend.usage, f.pend.model);
    if (r) {
      units += r.units; if (r.estimated) est += 1;
      if (by) { const k = acctKeyOf(ac, f.pend.ts); by[k] = (by[k] || 0) + r.units; }
    } else unpriced += 1;
  }
  return { units, est, unpriced, by };
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
    const { fresh, dirty, ...rest } = s;
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
  // Option claude_accounts set: each message's units are also kept by the account active when it was sent (so a session across an account
  // switch splits at the switch time). Unset: no history read, nothing extra saved, nothing extra returned.
  const listed = configuredAccounts();
  const ac = listed.length ? { history: accountHistory(), ids: new Set(listed.map((a) => a.id)) } : null;
  const paths = [lead];
  for (const d of subDirs) listTranscripts(d, paths);
  let complete = true;
  for (const p of paths) {
    const key = p === lead ? '(lead)' : relative(dirname(lead), p).replace(/\\/g, '/');
    if (Date.now() > deadline) { complete = false; break; } // the stat of a thousand files is bounded too
    const f = state.files[key] || (state.files[key] = freshFile());
    let size = -1;
    try { size = statSync(p).size; } catch { continue; }
    if (size === f.off) continue;
    Object.defineProperty(state, 'dirty', { value: true, writable: true, enumerable: false }); // not enumerable: the state's JSON stays as it was; // something to read: the state file is saved (an idle prompt does not rewrite it)
    if (!advanceFile(p, f, deadline, ac)) { complete = false; break; }
  }
  let total = 0;
  let estTurns = 0;
  let unpriced = 0;
  const byAcct = ac ? {} : null;
  for (const f of Object.values(state.files)) {
    const t = totalsOfFile(f, ac);
    total += t.units; estTurns += t.est; unpriced += t.unpriced;
    if (byAcct) for (const [k, u] of Object.entries(t.by)) byAcct[k] = (byAcct[k] || 0) + u;
  }
  // Units counted before the option was set (or by a scan without it) belong to no account's record: they stay in the unattributed part.
  if (byAcct) {
    const rest = total - Object.values(byAcct).reduce((x, y) => x + y, 0);
    if (rest > 1e-6) byAcct[''] = (byAcct[''] || 0) + rest;
  }
  return { total, files: paths.length, complete, estTurns, unpriced, ...(byAcct ? { byAcct } : {}) };
}

// `byAcct` ({ <account id>: units, '': units no listed account owns }, scanSession's result with the option claude_accounts set): each
// account's part is measured against that account's own limit at `now`. One listed account only: the usual sentence with that account's
// week and label. Several, or a part no listed account owns: one clause per account. Null, or no listed account in it: the usual
// sentence for the account signed in now.
export function budgetNoticeText(total, rate = currentRate(), byAcct = null, now = Date.now()) {
  const n = Math.round(total);
  const listed = byAcct ? configuredAccounts() : [];
  const parts = listed.filter((a) => byAcct[a.id] > 0);
  if (parts.length) {
    const base = weeklyLimitUnits(rate.value);
    const clause = (a) => {
      const lim = accountLimitAt(a, now, base);
      return { lim, pct: Math.round((byAcct[a.id] / lim) * 100) };
    };
    const unowned = byAcct[''] > 0.5 ? Math.round(byAcct['']) : 0;
    const tail = ' A hand-off to a fresh session does not save usage; let auto-compaction handle context. '
      + 'What cuts spend is fewer and smaller spawns: pick the lowest rung that fits, brief tightly, cap fan-out, and do not re-spawn for work a live worker can continue. '
      + 'Hand over only when a fresh session is required (a plugin version change) or the job ends.';
    if (parts.length === 1 && !unowned) {
      const a = parts[0];
      const { lim, pct } = clause(a);
      // The measured rate is named only when it is the figure the week came from: the signed-in account's, with no limit of its own.
      const cur = currentConfiguredAccount();
      const own = !!a.weeklyLimitUnits || a.limitChanges.some((c) => c.fromMs <= now);
      const basis = (rate.basis === 'default' || own || !cur || cur.id !== a.id ? '' : `, at ${rateLabel(rate)}`) + `, account ${a.label}`;
      return `[agent-companion] This session, including its subagents, has used about ${n} plan units (~${pct}% of a ~${lim.toLocaleString('en-US')}-unit week${basis}).${tail}`;
    }
    const each = parts.map((a) => { const { lim, pct } = clause(a); return `account ${a.label} ${Math.round(byAcct[a.id])} units, ~${pct}% of its ~${lim.toLocaleString('en-US')}-unit week`; });
    if (unowned) each.push(`${unowned} units not attributed to a listed account`);
    return `[agent-companion] This session, including its subagents, has used about ${n} plan units across accounts (${each.join('; ')}).${tail}`;
  }
  const week = weeklyPlanUnits(rate);
  const pct = Math.round((total / week) * 100);
  // The rate is named only when it is not the shipped default (the default week is what the text always said).
  const acct = currentConfiguredAccount();
  const basis = (rate.basis === 'default' ? '' : `, at ${rateLabel(rate)}`) + (acct ? `, account ${acct.label}` : '');
  return `[agent-companion] This session, including its subagents, has used about ${n} plan units (~${pct}% of a ~${week.toLocaleString('en-US')}-unit week${basis}). `
    + 'A hand-off to a fresh session does not save usage; let auto-compaction handle context. '
    + 'What cuts spend is fewer and smaller spawns: pick the lowest rung that fits, brief tightly, cap fan-out, and do not re-spawn for work a live worker can continue. '
    + 'Hand over only when a fresh session is required (a plugin version change) or the job ends.';
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
        const rate = currentRate();
        appendLog('session-budget.jsonl', {
          at: new Date(now).toISOString(),
          session_id: p.session_id,
          event: 'crossing',
          units: Math.round(r.total * 100) / 100,
          level,
          threshold,
          week_pct: Math.round((r.total / weeklyPlanUnits(rate)) * 1000) / 10,
          units_per_pct: rate.value,
          rate_basis: rate.basis,
          transcripts: r.files,
          scan_complete: r.complete,
          estimated_turns: r.estTurns,
          unpriced_turns: r.unpriced,
          ...(r.byAcct ? { by_account: Object.entries(r.byAcct).map(([id, u]) => ({ id: id || null, units: Math.round(u * 100) / 100 })) } : {}),
        });
        notify(p.session_id, budgetNoticeText(r.total, rate, r.byAcct || null, now));
      }
    }
    if (state.dirty || state.fresh || fired || state.level !== prior) saveState(p.session_id, state);
    if (state.fresh) pruneBudgetState(now);
    return { fired, total: r.total, level, complete: r.complete, files: r.files, estTurns: r.estTurns, unpriced: r.unpriced };
  } catch {
    return { skipped: 'error' };
  }
}
