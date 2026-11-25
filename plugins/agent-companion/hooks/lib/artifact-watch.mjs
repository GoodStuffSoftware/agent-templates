// Artifact watch alerts (0.31.69). An Artifact watch is the live comment subscription behind ArtifactComments.
// When one fails to arm or drops, nothing is written anywhere until the session lists its watches; the tool result
// then carries { watches: [...], arms: [{ url, state, reason, at }] } (or the same as text). This module reads that
// result, dedupes on session id + url + at, and builds the directive that tells the session to send a desktop push
// notification and say so. Local only: no network, no Discord. Every function fails soft (returns null / []).

import { readFileSync, appendFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, writeTextAtomic } from './context.mjs';
import { codeSessionsDir } from './coordinator-gate.mjs';

export const LIST_CALL = '{"action":"watch"}';
const OK_STATES = new Set(['armed', 'ok', 'connected', 'watching']);
const URL_RE = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;
const MAX_KEYS = 3000;
const META_TTL_MS = 10 * 60 * 1000;

const file = (name) => join(stateDir(), name);
export const ALERTED_FILE = () => file('artifact-watch-alerted.json');
export const ALERTS_LOG = () => file('artifact-watch-alerts.jsonl');
export const SESSIONS_FILE = () => file('artifact-watch-sessions.json');
export const META_FILE = () => file('artifact-watch-meta.json');

function readJson(f, fallback) {
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : fallback;
  } catch { return fallback; }
}
function capped(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const out = {};
  for (const k of keys.slice(keys.length - max)) out[k] = obj[k];
  return out;
}

// --- parsing -----------------------------------------------------------------------------------------------------------

// Every object and every string inside a tool_response, whatever its shape: the structured result object, a JSON
// string of it, a content-block array ([{type:'text',text}]), or plain text.
function walk(v, objs, texts, depth = 0) {
  if (depth > 6 || v == null) return;
  if (typeof v === 'string') {
    texts.push(v);
    const t = v.trim();
    if (t.startsWith('{') && t.includes('"arms"') || t.startsWith('{') && t.includes('"watches"')) {
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

// -> { failures: [{ url, at, reason }], urls: [every artifact url seen as a watch] }
export function parseWatchResult(response, input) {
  const failures = new Map();
  const urls = new Set();
  const objs = [];
  const texts = [];
  try { walk(response, objs, texts); } catch { /* soft */ }
  const add = (f) => { if (f.url) failures.set(`${f.url}|${f.at}`, f); };
  for (const o of objs) {
    if (Array.isArray(o.arms)) {
      for (const a of o.arms) {
        if (!a || typeof a !== 'object' || typeof a.url !== 'string') continue;
        urls.add(a.url);
        const st = String(a.state || '').toLowerCase();
        if (st && !OK_STATES.has(st)) add({ url: a.url, at: Number(a.at) || 0, reason: String(a.reason || st) });
      }
    }
    if (Array.isArray(o.watches)) {
      for (const w of o.watches) {
        if (!w || typeof w !== 'object' || typeof w.url !== 'string') continue;
        urls.add(w.url);
        if (w.connected === false) add({ url: w.url, at: Number(w.since) || 0, reason: 'watch not connected' });
      }
    }
  }
  const fallbackUrl = (input && typeof input.url === 'string' && URL_RE.exec(input.url)?.[0])
    || objs.map((o) => (typeof o.url === 'string' ? URL_RE.exec(o.url)?.[0] : null)).find(Boolean)
    || texts.map((t) => URL_RE.exec(t)?.[0]).find(Boolean) || null;
  for (const t of texts) {
    for (const line of t.split('\n')) {
      if (!/NOT watching|failed to arm/i.test(line)) continue;
      const m = /failed to arm at (\d{4}-\d\d-\d\dT[\d:.]+Z?)\s*(?:[—–-]+\s*(.*))?/i.exec(line);
      const url = URL_RE.exec(line)?.[0] || fallbackUrl;
      if (!url) continue;
      urls.add(url);
      const at = m ? Date.parse(m[1].endsWith('Z') ? m[1] : `${m[1]}Z`) || 0 : 0;
      add({ url, at, reason: reasonOf(m && m[2]) || 'failed to arm' });
    }
  }
  return { failures: [...failures.values()], urls: [...urls] };
}

// --- state -------------------------------------------------------------------------------------------------------------

export const alertKey = (sid, f) => `${sid}|${f.url}|${f.at}`;

// New (not yet alerted) failures; marks them alerted and appends one JSONL record each.
export function claimFailures(sid, failures, { now = Date.now(), source = 'hook', simulated = false } = {}) {
  const alerted = readJson(ALERTED_FILE(), {});
  const fresh = [];
  for (const f of failures) {
    const k = alertKey(sid, f);
    if (alerted[k]) continue;
    alerted[k] = now;
    fresh.push(f);
  }
  if (!fresh.length) return fresh;
  writeTextAtomic(ALERTED_FILE(), JSON.stringify(capped(alerted, MAX_KEYS)));
  try {
    const lines = fresh.map((f) => JSON.stringify({ ts: new Date(now).toISOString(), session: sid, url: f.url, at: f.at, reason: f.reason, source, ...(simulated ? { simulated: true } : {}) })).join('\n');
    appendFileSync(ALERTS_LOG(), `${lines}\n`);
  } catch { /* evidence trail is best effort */ }
  return fresh;
}

export function recordWatches(sid, urls, now = Date.now()) {
  if (!sid || !urls.length) return;
  const s = readJson(SESSIONS_FILE(), {});
  const cur = s[sid] && Array.isArray(s[sid].urls) ? s[sid].urls : [];
  s[sid] = { urls: [...new Set([...cur, ...urls])].slice(-50), ts: now };
  writeTextAtomic(SESSIONS_FILE(), JSON.stringify(capped(s, 400)));
}
export const recordedWatches = (sid) => {
  const e = readJson(SESSIONS_FILE(), {})[sid];
  return e && Array.isArray(e.urls) ? e.urls : [];
};

// --- session metadata (title, published artifacts), cached ---------------------------------------------------------------

function lookupMeta(sid, root, budgetMs = 400) {
  const t0 = Date.now();
  const files = [];
  const walkDir = (d, depth) => {
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walkDir(p, depth + 1); continue; }
      if (!/^local_.*\.json$/.test(e.name)) continue;
      try { files.push({ p, m: statSync(p).mtimeMs }); } catch { /* vanished */ }
    }
  };
  walkDir(root, 0);
  files.sort((a, b) => b.m - a.m);
  const titles = {};
  let title = null;
  let found = false;
  for (const { p } of files.slice(0, 60)) {
    if (Date.now() - t0 > budgetMs) break;
    let text; try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes(sid)) continue;
    let j; try { j = JSON.parse(text); } catch { continue; }
    if (j.cliSessionId !== sid && j.sessionId !== sid) continue;
    found = true;
    if (!title && typeof j.title === 'string') title = j.title;
    for (const a of Array.isArray(j.publishedArtifacts) ? j.publishedArtifacts : []) {
      if (a && typeof a.url === 'string' && typeof a.title === 'string') titles[a.url] = a.title;
    }
  }
  return { title, artifacts: titles, found };
}

// { title, artifacts: {url: title} } for a session, cached 10 minutes (a miss is cached too).
export function sessionMeta(sid, { now = Date.now(), root = codeSessionsDir() } = {}) {
  const cache = readJson(META_FILE(), {});
  const hit = cache[sid];
  if (hit && now - (hit.ts || 0) < META_TTL_MS) return hit;
  let m;
  try { m = lookupMeta(sid, root); } catch { m = { title: null, artifacts: {}, found: false }; }
  const entry = { ts: now, title: m.title, artifacts: m.artifacts };
  cache[sid] = entry;
  writeTextAtomic(META_FILE(), JSON.stringify(capped(cache, 200)));
  return entry;
}

// --- directive ----------------------------------------------------------------------------------------------------------

const when = (at) => (at ? new Date(at).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown time');

export function buildDirective(sid, fresh, meta = {}) {
  const title = meta.title || `session ${String(sid).slice(0, 8)}`;
  const label = (f) => (meta.artifacts && meta.artifacts[f.url]) || (meta.fallbackTitle && meta.fallbackTitle[f.url]) || f.url;
  const items = fresh.map((f) => `- ${label(f)}${label(f) === f.url ? '' : ` (${f.url})`}, failed ${when(f.at)}: ${f.reason}`).join('\n');
  const short = fresh.map((f) => `${label(f)} (${f.reason})`).join('; ').slice(0, 220);
  return [
    `ARTIFACT WATCH FAILED in "${title}". ${fresh.length === 1 ? 'This artifact watch is' : `These ${fresh.length} artifact watches are`} not live, so comments on ${fresh.length === 1 ? 'it' : 'them'} will not reach this session:`,
    items,
    'Do these now, in this order:',
    `1. Call PushNotification ONCE with a short text like: "${title}: artifact watch failed: ${short}". Local desktop push only; no Discord, no other send.`,
    '2. Say the same in your next reply to the user (session, artifact, reason).',
    '3. Give the fix: share the artifact to this account as an editor (session-sync:share-artifacts), or switch back to the account that owns it.',
    'Do not call PushNotification again for this same failure.',
  ].join('\n');
}

// PostToolUse payload -> { text } or null. Never throws.
export function handlePostToolUse(p) {
  try {
    if (!p || typeof p !== 'object') return null;
    if (p.tool_name !== 'ArtifactComments' && p.tool_name !== 'Artifact') return null;
    const sid = typeof p.session_id === 'string' ? p.session_id : '';
    if (!sid) return null;
    const { failures, urls } = parseWatchResult(p.tool_response, p.tool_input);
    if (urls.length) recordWatches(sid, urls);
    if (!failures.length) return null;
    const fresh = claimFailures(sid, failures, { simulated: !!p.simulated });
    if (!fresh.length) return null;
    const meta = { ...sessionMeta(sid) };
    if (p.tool_name === 'Artifact' && p.tool_input && typeof p.tool_input.title === 'string') {
      meta.fallbackTitle = Object.fromEntries(fresh.map((f) => [f.url, p.tool_input.title]));
    }
    return { text: buildDirective(sid, fresh, meta), fresh };
  } catch { return null; }
}

// SessionStart (resume|compact): does this session hold watches? Recorded state first, then cached metadata.
export function sessionHoldsWatches(sid) {
  try {
    if (!sid) return false;
    if (recordedWatches(sid).length) return true;
    const m = sessionMeta(sid);
    return Object.keys(m.artifacts || {}).length > 0;
  } catch { return false; }
}

export const startLine = () => `Artifact watches may have dropped on resume. Call ArtifactComments once with ${LIST_CALL} (no url) to list this session's artifact watches; if any failed to arm you will get the alert directive.`;

export const hasLog = () => existsSync(ALERTS_LOG());
