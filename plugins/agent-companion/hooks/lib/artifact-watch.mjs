// Artifact watch alerts (0.31.69). An Artifact watch is the live comment subscription behind ArtifactComments.
// When one fails to arm or drops, nothing is written anywhere until the session lists its watches; the tool result
// then carries { watches: [...], arms: [{ url, state, reason, at }] }. This module reads those structured fields,
// keeps the last observed state (ok | failed) per session and url, and alerts on a transition into failed: once per
// failure episode (plus one 24 h reminder), never per check. It builds the directive that tells the session to send a
// desktop push notification and say so. Local only: no network, no Discord. Every function fails soft.
//
// State: one file per session (state/artifact-watch/<session>.json), temp file + rename. A file that exists but cannot
// be read is never overwritten (the directive still prints: fail open). AGENT_COMPANION_STATE_DIR relocates all of it,
// which is how `simulate` stays away from real state.

import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './context.mjs';
import { codeSessionsDir, recordFiles } from './coordinator-gate.mjs';

export const LIST_CALL = '{"action":"watch"}';
const OK_STATES = new Set(['armed', 'ok', 'connected', 'watching']);
const FAIL_RE = /fail|error|drop|revok|expir|denied|unauthor/i;
const URL_RE = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;
// The client's subscription line for a watch that did not arm (watch-state-detail.md), anchored per line.
const NOT_WATCHING_RE = /^\s*(?:[-*]\s*)?(?:(https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+)\s*[—–-]+\s*)?NOT watching: the live subscription failed to arm(?: at (\d{4}-\d\d-\d\dT[\d:.]+Z?))?\s*(?:[—–-]+\s*(.*))?$/;
const REMIND_MS = 24 * 3600 * 1000;
const META_TTL_MS = 10 * 60 * 1000;
const INDEX_MAX_RECORDS = 4000; // hard cap on the metadata walk
const INDEX_KEEP = 120; // newest records indexed

const dir = () => join(stateDir(), 'artifact-watch');
export const ALERTS_LOG = () => join(stateDir(), 'artifact-watch-alerts.jsonl');
export const INDEX_FILE = () => join(stateDir(), 'artifact-watch-index.json');
export const sessionFile = (sid) => join(dir(), `${String(sid).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}.json`);

// --- parsing -----------------------------------------------------------------------------------------------------------

// Every object and every string inside a tool_response, whatever its shape: the structured result object, a JSON
// string of it, a content-block array ([{type:'text',text}]), or plain text.
function walk(v, objs, texts, depth = 0) {
  if (depth > 6 || v == null) return;
  if (typeof v === 'string') {
    texts.push(v);
    const t = v.trim();
    if (t.startsWith('{') && (t.includes('"arms"') || t.includes('"watches"'))) {
      try { walk(JSON.parse(t), objs, texts, depth + 1); } catch { /* plain text */ }
    }
    return;
  }
  if (Array.isArray(v)) { for (const x of v.slice(0, 200)) walk(x, objs, texts, depth + 1); return; }
  if (typeof v === 'object') {
    objs.push(v);
    for (const k of ['content', 'text', 'result', 'toolUseResult', 'structuredContent']) if (k in v) walk(v[k], objs, texts, depth + 1);
  }
}

const reasonOf = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^[—–-]\s*/, '').split(/(?<=\.)\s/)[0].slice(0, 160);
export const isFailureState = (s) => FAIL_RE.test(String(s || ''));

// -> { obs: [{ url, status: 'ok'|'failed'|'unknown', at, reason }] } one entry per url; failed beats ok beats unknown.
// Structured arms[] / watches[] first. Text only for the Artifact tool's publish result, only when the result has no
// structured fields, only for the client's subscription line, and the url comes from the result.
export function parseWatchResult(response, toolName = 'ArtifactComments') {
  const byUrl = new Map();
  const rank = { unknown: 0, ok: 1, failed: 2 };
  const put = (o) => { const cur = byUrl.get(o.url); if (!cur || rank[o.status] >= rank[cur.status]) byUrl.set(o.url, o); };
  const objs = [];
  const texts = [];
  try { walk(response, objs, texts); } catch { /* soft */ }
  let structured = false;
  for (const o of objs) {
    if (Array.isArray(o.arms)) {
      structured = true;
      for (const a of o.arms) {
        if (!a || typeof a !== 'object' || typeof a.url !== 'string') continue;
        const st = String(a.state || '').toLowerCase();
        const status = OK_STATES.has(st) ? 'ok' : isFailureState(st) ? 'failed' : 'unknown';
        put({ url: a.url, status, at: Number(a.at) || 0, reason: String(a.reason || st) });
      }
    }
    if (Array.isArray(o.watches)) {
      structured = true;
      for (const w of o.watches) {
        if (!w || typeof w !== 'object' || typeof w.url !== 'string') continue;
        if (w.connected === true) put({ url: w.url, status: 'ok', at: Number(w.since) || 0, reason: '' });
        else if (w.connected === false) put({ url: w.url, status: 'failed', at: Number(w.since) || 0, reason: 'watch not connected' });
        else put({ url: w.url, status: 'unknown', at: 0, reason: '' });
      }
    }
  }
  if (!structured && toolName === 'Artifact') {
    const resultUrl = texts.map((t) => URL_RE.exec(t)?.[0]).find(Boolean) || null;
    for (const t of texts) {
      for (const line of t.split('\n')) {
        const m = NOT_WATCHING_RE.exec(line);
        if (!m) continue;
        const url = m[1] || resultUrl;
        if (!url) continue;
        const at = m[2] ? Date.parse(m[2].endsWith('Z') ? m[2] : `${m[2]}Z`) || 0 : 0;
        put({ url, status: 'failed', at, reason: reasonOf(m[3]) || 'failed to arm' });
      }
    }
  }
  return { obs: [...byUrl.values()] };
}

// --- per-session state ---------------------------------------------------------------------------------------------------

// -> { ok: true, data } (missing file = empty data) | { ok: false } (exists but unreadable or not an object: never overwrite).
export function readSessionState(sid) {
  const f = sessionFile(sid);
  if (!existsSync(f)) return { ok: true, data: { urls: {} } };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j) || (j.urls != null && (typeof j.urls !== 'object' || Array.isArray(j.urls)))) return { ok: false };
    return { ok: true, data: { ...j, urls: j.urls || {} } };
  } catch { return { ok: false }; }
}

function writeSessionState(sid, data) {
  const f = sessionFile(sid);
  const tmp = `${f}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, f);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* none */ }
    return false;
  }
}

// Decide which observations alert, against the stored state. Pure: returns { fresh, next }.
export function transition(prev, obs, now = Date.now()) {
  const urls = { ...(prev.urls || {}) };
  const fresh = [];
  for (const o of obs) {
    const cur = urls[o.url];
    if (o.status === 'ok') { urls[o.url] = { state: 'ok', seen: now }; continue; }
    if (o.status === 'unknown') { if (!cur) urls[o.url] = { state: 'unknown', seen: now }; else urls[o.url] = { ...cur, seen: now }; continue; }
    if (cur && cur.state === 'failed') {
      const due = (cur.alerts || 1) < 2 && now - (cur.alertedAt || 0) >= REMIND_MS;
      urls[o.url] = due ? { ...cur, seen: now, alertedAt: now, alerts: (cur.alerts || 1) + 1 } : { ...cur, seen: now };
      if (due) fresh.push({ ...o, reminder: true });
      continue;
    }
    urls[o.url] = { state: 'failed', seen: now, alertedAt: now, alerts: 1 };
    fresh.push(o);
  }
  const keys = Object.keys(urls);
  if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete urls[k];
  return { fresh, next: { ...prev, urls, ts: now } };
}

function appendLog(sid, fresh, { now, source, simulated }) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const lines = fresh.map((f) => JSON.stringify({ ts: new Date(now).toISOString(), session: sid, url: f.url, at: f.at, reason: f.reason, source, ...(f.reminder ? { reminder: true } : {}), ...(simulated ? { simulated: true } : {}) })).join('\n');
    appendFileSync(ALERTS_LOG(), `${lines}\n`);
  } catch { /* evidence trail is best effort */ }
}

// --- session metadata (title, published artifacts): cached index, hard-capped ----------------------------------------------

function buildIndex(root) {
  const bySession = {};
  const files = recordFiles(root, { maxFiles: INDEX_MAX_RECORDS }).slice(0, INDEX_KEEP);
  for (const p of files) {
    let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const ids = [j.cliSessionId, j.lastAssistantCliSessionId, j.sessionId, ...(Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds : [])].filter((x) => typeof x === 'string');
    const artifacts = {};
    for (const a of Array.isArray(j.publishedArtifacts) ? j.publishedArtifacts : []) {
      if (a && typeof a.url === 'string') artifacts[a.url] = typeof a.title === 'string' ? a.title : '';
    }
    const entry = { title: typeof j.title === 'string' ? j.title : null, artifacts };
    for (const id of ids) if (!bySession[id]) bySession[id] = entry;
  }
  return bySession;
}

// { title, artifacts: {url: title} } for a session from the cached index (rebuilt at most every 10 minutes).
export function sessionMeta(sid, { now = Date.now(), root = codeSessionsDir() } = {}) {
  let idx = null;
  try { idx = JSON.parse(readFileSync(INDEX_FILE(), 'utf8')); } catch { /* none */ }
  if (!idx || typeof idx !== 'object' || !idx.bySession || now - (idx.ts || 0) >= META_TTL_MS || idx.root !== root) {
    let bySession = {};
    try { bySession = buildIndex(root); } catch { /* soft */ }
    idx = { ts: now, root, bySession };
    try { mkdirSync(stateDir(), { recursive: true }); const t = `${INDEX_FILE()}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(idx)); renameSync(t, INDEX_FILE()); } catch { /* soft */ }
  }
  return idx.bySession[sid] || { title: null, artifacts: {} };
}

// --- directive ----------------------------------------------------------------------------------------------------------

const when = (at) => (at ? new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown time');

export function buildDirective(sid, fresh, meta = {}) {
  const title = meta.title || `session ${String(sid).slice(0, 8)}`;
  const label = (f) => (meta.artifacts && meta.artifacts[f.url]) || f.url;
  const items = fresh.map((f) => `- ${label(f)}${label(f) === f.url ? '' : ` (${f.url})`}, failed ${when(f.at)}: ${f.reason}`).join('\n');
  const short = fresh.map((f) => `${label(f)} (${f.reason})`).join('; ').slice(0, 220);
  const reminder = fresh.every((f) => f.reminder) ? ' (reminder: still failing 24 h after the first alert)' : '';
  return [
    `ARTIFACT WATCH FAILED in "${title}"${reminder}. ${fresh.length === 1 ? 'This artifact watch is' : `These ${fresh.length} artifact watches are`} not live, so comments on ${fresh.length === 1 ? 'it' : 'them'} will not reach this session:`,
    items,
    'Do these now, in this order:',
    `1. Call PushNotification ONCE with a short text like: "${title}: artifact watch failed: ${short}". Local desktop push only; no Discord, no other send.`,
    '2. Say the same in your next reply to the user (session, artifact, reason).',
    '3. Give the fix: switch back to the account that owns the artifact; a watch cannot run from another organization's account, even with editor access. Re-sharing may help only for an artifact in this account's own organization (unverified).',
    'Do not call PushNotification again for this same failure.',
  ].join('\n');
}

// PostToolUse payload -> { text, commit } or null. The caller prints `text` FIRST, then calls commit() to record the
// state and the alert (so a timeout cannot lose an alert). Never throws.
export function planPostToolUse(p, { now = Date.now() } = {}) {
  try {
    if (!p || typeof p !== 'object') return null;
    if (p.tool_name !== 'ArtifactComments' && p.tool_name !== 'Artifact') return null;
    const sid = typeof p.session_id === 'string' ? p.session_id : '';
    if (!sid) return null;
    const { obs } = parseWatchResult(p.tool_response, p.tool_name);
    if (!obs.length) return null;
    const st = readSessionState(sid);
    const { fresh, next } = transition(st.ok ? st.data : { urls: {} }, obs, now);
    let text = null;
    if (fresh.length) {
      let meta = {};
      try { meta = { ...sessionMeta(sid) }; } catch { /* soft */ }
      if (p.tool_name === 'Artifact' && p.tool_input && typeof p.tool_input.title === 'string') {
        meta.artifacts = { ...Object.fromEntries(fresh.map((f) => [f.url, p.tool_input.title])), ...(meta.artifacts || {}) };
      }
      text = buildDirective(sid, fresh, meta);
    }
    const commit = () => {
      try {
        if (st.ok) writeSessionState(sid, next); // corrupt existing file: leave it untouched
        if (fresh.length) appendLog(sid, fresh, { now, source: 'hook', simulated: !!p.simulated });
      } catch { /* soft */ }
    };
    if (!text && !st.ok) return null;
    return { text, commit, fresh };
  } catch { return null; }
}

// SessionStart (resume|compact): does this session hold watches? Own per-session state first; then the capped, cached
// metadata index.
export function sessionHoldsWatches(sid) {
  try {
    if (!sid) return false;
    const st = readSessionState(sid);
    if (st.ok && Object.keys(st.data.urls).length) return true;
    return Object.keys(sessionMeta(sid).artifacts || {}).length > 0;
  } catch { return false; }
}

export const startLine = () => `Artifact watches may have dropped on resume. Call ArtifactComments once with ${LIST_CALL} (no url) to list this session's artifact watches; if any failed to arm you will get the alert directive.`;

export const hasLog = () => existsSync(ALERTS_LOG());
