// Read dedupe: rules and per-agent state for hooks/read-dedupe.mjs.
//
// THE GAP THIS COVERS. Claude Code's own Read already stubs a repeat read
// ("File unchanged since last read ...", verified in the 2.1.283 binary), but
// only when ALL of these hold: the file's mtime is unchanged, the request's
// offset and limit are EXACTLY those of the most recent read of that path, and
// that read was a clean view. It keeps ONE (offset, limit) per path, so:
//   - a range inside an earlier, larger read is not caught (read 1-400, then
//     120-180);
//   - after reading A then B, a repeat of A is not caught (only B is kept);
//   - two adjacent reads do not add up to a covered third.
// A 7-day measurement (2026-10-04) found 654 re-reads of unchanged files, 551
// of them partial, and only 26 stub-sized: those are the gap. This module
// remembers every COVERED LINE RANGE per (session, agent, path) and leaves the
// built-in's own case (the exact range just read) to the built-in.
//
// Contract, in the order the hook applies it (each is a hard requirement):
//   1. State is per agent: session_id + agent_id ("main" when absent), one
//      state file and one lock per agent, so agents never contend. A subagent
//      has its own context; one agent's read never suppresses another's.
//   2. A read is recorded only after it succeeds (PostToolUse), from what the
//      tool actually returned: the line range, the file's line count, and the
//      mtime, size and ctime seen BEFORE the read ran (a file that changed
//      while it was being read is not recorded).
//   3. A repeat is denied only when the request is fully inside recorded
//      ranges, mtime, size and ctime are unchanged, the record is younger than
//      MAX_AGE_MS, and the read would cost at least MIN_CHARS.
//   4. A denied request, repeated, runs (its effective range is remembered in
//      `denied` until it runs). Never a trap.
//   5. Records are cleared by an edit of the path by that agent, any mtime,
//      size or ctime change, and compaction (PreCompact / SessionStart compact|clear:
//      the whole session).
//   6. Any failure allows the read.

import { statSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, readJson, writeJsonAtomic, normalizePath } from './context.mjs';
import { withFileLock } from './file-lock.mjs';

export const TELEMETRY_STREAM = 'read-dedupe.jsonl';

// A denial is only worth its cost when the read it replaces is bigger than
// the denial. A denial puts ~190 characters of text in context (the deny
// message) and costs the model a turn; a repeat of the same content costs its
// size now AND on every later turn of that agent (it is re-read from the
// prompt cache each time). 2,000 characters is about 500 tokens, ten times
// the denial's own text, so the denial wins even when one denial in five is
// retried (0.8 x 500 tokens saved against 0.2 x ~160 tokens of retry), and
// the measured average re-read was 9.5 KB. Below it a tiny re-read passes:
// the denial would cost about what it saves.
export const MIN_CHARS = 2000;

// A recorded read is trusted this long. Claude Code can clear OLD tool results
// from context without compacting (time-based microcompaction) and no hook
// fires for it; this bounds how stale the "it is already in your context"
// claim can get. The retry escape hatch covers the rest.
export const MAX_AGE_MS = 30 * 60 * 1000;

// Read's own default: no `limit` means up to this many lines.
export const DEFAULT_LIMIT = 2000;
// Characters Read adds per line ("%6d\t"): the line number prefix.
export const LINE_PREFIX_CHARS = 7;

const MAX_FILES_PER_AGENT = 150;
const MAX_DENIED_PER_FILE = 8;
const MAX_PENDING = 60;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export function denyText(a, b) {
  return `Unchanged since your earlier read (lines ${a}-${b}). If that content is no longer in your context, repeat this call and it will run.`;
}

// --- identifiers ------------------------------------------------------------

export function agentOf(p) {
  const id = p && typeof p === 'object' ? p.agent_id : undefined;
  return typeof id === 'string' && id ? id : 'main';
}

// One key per path, whatever its spelling: absolute, relative to the call's
// cwd, backslashes, case on Windows.
export function pathKeyOf(filePath, cwd) {
  const raw = String(filePath || '');
  if (!raw) return '';
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  return normalizePath(resolve(base, raw));
}

// The telemetry never carries the path itself.
export function pathHash(pathKey) {
  return createHash('sha256').update(String(pathKey)).digest('hex').slice(0, 12);
}

// --- the request ------------------------------------------------------------

// The lines a Read request asks for, or null when it is not a plain text range
// this module reasons about (a PDF page range, a non-integer or non-positive
// offset or limit). `raw` is the built-in's own identity for the request.
export function requestOf(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.pages !== undefined && input.pages !== null && input.pages !== '') return null;
  const off = input.offset;
  const lim = input.limit;
  if (off !== undefined && off !== null && !(Number.isInteger(off) && off >= 1)) return null;
  if (lim !== undefined && lim !== null && !(Number.isInteger(lim) && lim >= 1)) return null;
  const start = off ?? 1;
  const limit = lim ?? DEFAULT_LIMIT;
  return { start, end: start + limit - 1, raw: `${start}:${lim ?? ''}` };
}

// --- ranges -----------------------------------------------------------------

// Add [a, b] to a sorted, disjoint, non-adjacent list of ranges.
export function addRange(ranges, a, b) {
  const out = [];
  let lo = a;
  let hi = b;
  for (const [x, y] of ranges) {
    if (y < lo - 1 || x > hi + 1) out.push([x, y]);
    else { lo = Math.min(lo, x); hi = Math.max(hi, y); }
  }
  out.push([lo, hi]);
  out.sort((m, n) => m[0] - n[0]);
  return out;
}

export function covers(ranges, a, b) {
  return ranges.some(([x, y]) => x <= a && b <= y);
}

// --- state ------------------------------------------------------------------

function blankState() {
  return { v: 1, agents: {}, pending: {} };
}

function sanitize(s) {
  return s && typeof s === 'object' && s.v === 1 && s.agents && typeof s.agents === 'object'
    && s.pending && typeof s.pending === 'object' ? s : blankState();
}

function dirOf() {
  const d = join(stateDir(), 'read-dedupe');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

const sha1 = (v, n) => createHash('sha1').update(String(v)).digest('hex').slice(0, n);

// One state file per (session, agent): `<session>-<agent>.json`. Agents of one
// session read in parallel (a lead and several subagents), and a single shared
// file made every one of them queue on one lock (waitMs 800), a timeout letting
// the read run unrecorded. Nothing in the state crosses agents (every key and
// record is already per agent), so splitting loses nothing, and only two
// processes of the SAME agent (its PreToolUse and PostToolUse, one after the
// other) can ever meet at a lock.
function sessionPrefix(sessionId) {
  return sha1(sessionId, 20);
}

function stateFileFor(sessionId, agent) {
  return join(dirOf(), `${sessionPrefix(sessionId)}-${sha1(agent || 'main', 12)}.json`);
}

// Drop sessions' files nobody has touched in days. Cheap (one readdir), and run
// only when a session's file is first created.
function pruneOldFiles(now) {
  try {
    const d = dirOf();
    for (const f of readdirSync(d)) {
      try {
        if (now - statSync(join(d, f)).mtimeMs > STATE_KEEP_MS) unlinkSync(join(d, f));
      } catch { /* raced or gone */ }
    }
  } catch { /* no dir */ }
}

const LOCK_OPTS = { waitMs: 800, staleMs: 3000 };

// Run fn(state) under the agent's lock; fn returns { value, dirty }. The state
// is saved when dirty. Returns { locked, value, wait_ms }; wait_ms is how long
// the lock took to get (or to give up on), so contention is measurable. A lock
// that cannot be taken (or any error) returns { locked: false } and never
// throws: the caller then allows the read.
export function withState(sessionId, agent, fn, now = Date.now()) {
  const t0 = Date.now();
  let out = { locked: false, value: undefined, wait_ms: 0 };
  try {
    const file = stateFileFor(sessionId, agent);
    withFileLock(`${file}.lock`, ({ locked }) => {
      out.wait_ms = Date.now() - t0;
      if (!locked) return;
      const existing = readJson(file, null);
      const state = sanitize(existing);
      const r = fn(state) || {};
      if (r.dirty) {
        if (existing === null) pruneOldFiles(now);
        writeJsonAtomic(file, state);
      }
      out = { locked: true, value: r.value, wait_ms: out.wait_ms };
    }, LOCK_OPTS);
  } catch {
    out = { locked: false, value: undefined, wait_ms: Date.now() - t0 };
  }
  return out;
}

// Compaction or /clear. With an agent id, only that agent forgets (another
// agent's context is not touched by it); without one the payload cannot say
// whose context shrank, so the whole session forgets. Over-clearing only costs
// a dedupe, never a wrong denial. Returns { locked, wait_ms }.
export function resetAgent(sessionId, agent) {
  if (!agent || agent === 'main') return clearSession(sessionId);
  return withState(sessionId, agent, (state) => {
    delete state.agents[agent];
    for (const k of Object.keys(state.pending)) if (k.startsWith(`${agent}|`)) delete state.pending[k];
    return { dirty: true };
  });
}

// Every shard of the session (and a pre-split `<session>.json`), each under its
// own lock.
function clearSession(sessionId) {
  const t0 = Date.now();
  let all = true;
  try {
    const dir = dirOf();
    const prefix = sessionPrefix(sessionId);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || !(name === `${prefix}.json` || name.startsWith(`${prefix}-`))) continue;
      const file = join(dir, name);
      let got = false;
      withFileLock(`${file}.lock`, ({ locked }) => {
        if (!locked) return;
        try { unlinkSync(file); } catch { /* gone */ }
        got = true;
      }, LOCK_OPTS);
      if (!got) all = false;
    }
  } catch {
    all = false;
  }
  return { locked: all, wait_ms: Date.now() - t0 };
}

// mtime AND size AND ctime: a change that keeps the size and restores the mtime
// (a build tool, `touch -r`, an editor that preserves times) still moves the
// change time, which no ordinary write can set back.
export function statOf(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs } : null;
  } catch {
    return null;
  }
}

export function sameStat(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs;
}

function pendingKey(agent, pk, raw) {
  return `${agent}|${pk}|${raw}`;
}

function prunePending(state, now) {
  const keys = Object.keys(state.pending);
  for (const k of keys) {
    if (!(now - state.pending[k].at <= PENDING_MAX_AGE_MS)) delete state.pending[k];
  }
  const left = Object.keys(state.pending);
  if (left.length > MAX_PENDING) {
    left.sort((a, b) => state.pending[a].at - state.pending[b].at);
    for (const k of left.slice(0, left.length - MAX_PENDING)) delete state.pending[k];
  }
}

function evictOld(files) {
  const keys = Object.keys(files);
  if (keys.length <= MAX_FILES_PER_AGENT) return;
  keys.sort((a, b) => files[a].t - files[b].t);
  for (const k of keys.slice(0, keys.length - MAX_FILES_PER_AGENT)) delete files[k];
}

// --- PreToolUse -------------------------------------------------------------

// Decide one Read. Mutates `state` (and says so with `dirty`). Returns
//   { action: 'allow' }
//   { action: 'allow', why, a, b, est, age_ms }
//                                    a repeat-eligible read (the file was read
//                                    before and is unchanged) that ran, and why:
//                                    'builtin-last' | 'aged' | 'uncovered' | 'small'
//   { action: 'deny',  a, b, est, age_ms }   the request is covered: deny it
//   { action: 'retry', a, b, est, age_ms, deny_at }
//                                    a denied request repeated: it runs
// Every result past the first guard also carries `idx`, the number of Reads
// this agent has made (it counts how deep into the session the event is).
// `age_ms` is the time since the original read of the file was recorded.
// `stat` is the file's stat now (null when unreadable: allow).
export function decide(state, { agent, pk, input, stat, now = Date.now() }) {
  const req = requestOf(input);
  if (!req || !stat || !pk) return { value: { action: 'allow' }, dirty: false };
  const idx = (state.reads | 0) + 1;
  state.reads = idx;
  const allow = (extra = {}) => ({ value: { action: 'allow', idx, ...extra }, dirty: true });

  // The stat goes with this call to PostToolUse, which records only a read
  // whose file was unchanged across it. Stored on every allowed read.
  const remember = () => {
    state.pending[pendingKey(agent, pk, req.raw)] = { at: now, mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs };
    prunePending(state, now);
  };

  const files = state.agents[agent]?.files;
  const rec = files?.[pk];
  if (!rec) { remember(); return allow(); }

  if (!sameStat(rec, stat)) {
    delete files[pk]; // changed on disk (Bash, another agent, git): forget it
    remember();
    return allow();
  }
  if (!(rec.total >= 1) || req.start > rec.total) { remember(); return allow(); }

  const a = req.start;
  const b = Math.min(req.end, rec.total);
  const eff = `${a}-${b}`;
  const lines = b - a + 1;
  const est = Math.round(lines * (rec.cpl + LINE_PREFIX_CHARS));
  const age_ms = now - rec.since;
  const eligible = (why) => { remember(); return allow({ why, a, b, est, age_ms }); };

  // A request that was denied and is repeated runs, whatever else is true.
  const di = Array.isArray(rec.denied) ? rec.denied.indexOf(eff) : -1;
  if (di >= 0) {
    rec.denied.splice(di, 1);
    const deny_at = rec.deniedAt?.[eff];
    if (rec.deniedAt) delete rec.deniedAt[eff];
    remember();
    return { value: { action: 'retry', idx, a, b, est, age_ms, deny_at }, dirty: true };
  }

  // The exact range just read is the built-in's case (it stubs it itself).
  if (rec.last === req.raw) return eligible('builtin-last');

  if (age_ms > MAX_AGE_MS) return eligible('aged');
  if (!covers(rec.ranges, a, b)) return eligible('uncovered');
  if (est < MIN_CHARS) return eligible('small');

  rec.denied = [...(rec.denied || []), eff].slice(-MAX_DENIED_PER_FILE);
  // When each outstanding denial was issued, so a retry can say how long the
  // agent took to retry it.
  rec.deniedAt = { ...(rec.deniedAt || {}), [eff]: now };
  for (const k of Object.keys(rec.deniedAt)) if (!rec.denied.includes(k)) delete rec.deniedAt[k];
  return { value: { action: 'deny', idx, a, b, est, age_ms }, dirty: true };
}

// --- PostToolUse (Read) ------------------------------------------------------

// Record a successful read from what the tool returned. `stat` is the file's
// stat now. Returns { dirty }.
export function record(state, { agent, pk, input, response, stat, now = Date.now() }) {
  const req = requestOf(input);
  const pkey = req ? pendingKey(agent, pk, req.raw) : '';
  const pend = pkey ? state.pending[pkey] : undefined;
  if (pend) delete state.pending[pkey];
  // Only a plain text read whose file did not change while it was read.
  if (!req || !pend || !stat || !sameStat(pend, stat)) return { dirty: !!pend };
  const f = response && typeof response === 'object' && response.type === 'text' ? response.file : null;
  if (!f || typeof f !== 'object') return { dirty: true };
  const { content, numLines, startLine, totalLines } = f;
  if (typeof content !== 'string' || !Number.isInteger(numLines) || numLines < 1
    || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(totalLines) || totalLines < 1) return { dirty: true };
  // A page cut short by the token cap, or a partial view, is not "the lines".
  if (f.truncatedByTokenCap || content.includes('[Truncated: PARTIAL view')) return { dirty: true };

  const agentState = state.agents[agent] ?? (state.agents[agent] = { files: {} });
  const files = agentState.files;
  let rec = files[pk];
  const fresh = !rec || !sameStat(rec, stat) || now - rec.since > MAX_AGE_MS;
  const cpl = content.length / numLines;
  if (fresh) {
    rec = { mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, total: totalLines, since: now, ranges: [], cpl, lines: 0, last: '', denied: [], t: now };
    files[pk] = rec;
  } else {
    rec.cpl = (rec.cpl * rec.lines + content.length) / (rec.lines + numLines);
  }
  rec.lines = (rec.lines || 0) + numLines;
  rec.total = totalLines;
  rec.ranges = addRange(rec.ranges, startLine, startLine + numLines - 1);
  rec.last = req.raw;
  rec.t = now;
  evictOld(files);
  return { dirty: true };
}

// --- invalidation -------------------------------------------------------------

// An edit of `pk` by `agent`: forget it for that agent.
export function invalidate(state, { agent, pk }) {
  let dirty = false;
  const files = state.agents[agent]?.files;
  if (files && files[pk]) { delete files[pk]; dirty = true; }
  for (const k of Object.keys(state.pending)) {
    if (k.startsWith(`${agent}|${pk}|`)) { delete state.pending[k]; dirty = true; }
  }
  return { dirty };
}
