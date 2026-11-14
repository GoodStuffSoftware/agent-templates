// Coordinator message gate: the pure and lookup parts.
//
// A child session is one another session started (the desktop app's own session record carries
// spawnedFrom.sessionId, the coordinator's local_<id>). A status-only message from a child wakes the
// coordinator for an expensive turn, so a message from a child to its coordinator must open with one of six
// tags (see TAGS). Everything not positively a child-to-coordinator send passes: this module never decides
// "gated" on a guess, and every lookup returns null on any error (callers fail open).
//
// Parent lookup: the hook payload's session_id is the CLI session id; the app's record
// (<AppData>/Claude/claude-code-sessions/<account>/<org>/local_<id>.json) lists it as cliSessionId (or in
// priorCliSessionIds / lastAssistantCliSessionId) and names the parent in spawnedFrom.sessionId.
// Target forms: a local_<id> session id, or the reply address of an incoming message (a uds:\\.\pipe\...
// pipe name), which the child's own transcript pairs with the sender's session id in the message's
// from / from-session attributes. Anything else (a subagent name, an unknown address) is not resolved.

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { homeRoot, readJson, writeJsonAtomic, stateFile } from './context.mjs';

export const TAGS = Object.freeze(['QUESTION', 'BLOCKED', 'DONE', 'CHANGE', 'FINDING', 'ANSWER']);
export const MODES = Object.freeze(['block', 'warn', 'off']);
export const DEFAULT_MODE = 'block';
export const DENY_REASON = 'Messages to your coordinator start with QUESTION:, BLOCKED:, DONE:, CHANGE:, FINDING: or ANSWER:. Put status on your card or task list. If this needs the coordinator, resend it with the right tag.';
export const WARN_NOTE = 'agent-companion (coordinator message gate, warn): this message to your coordinator has no tag. Start it with QUESTION:, BLOCKED:, DONE:, CHANGE:, FINDING: or ANSWER:, and put status on your card or task list.';
export const STANDING_RULE_TEXT = 'Messages to your coordinator start with QUESTION: (need a decision), BLOCKED: (stuck), DONE: (hand-back), CHANGE: (plan changed), FINDING: (new risk or fact it must act on) or ANSWER: (reply to its request).\nStatus goes on your task card if you use one, otherwise your task list; never message the coordinator just to report progress or acknowledge.';

export function modeFrom(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return MODES.includes(v) ? v : DEFAULT_MODE;
}

const TAG_RE = new RegExp(`^\\s*(?:\\*\\*|__)?\\s*(${TAGS.join('|')})\\s*(?:\\*\\*|__)?\\s*:`, 'i');

// The tag a message opens with (upper case), or null. Case, leading whitespace and markdown bold around the
// tag do not matter: "  **question:** ...", "**Done**: ...".
export function tagOf(message) {
  if (typeof message !== 'string') return null;
  const m = TAG_RE.exec(message);
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// The app's session records.
// ---------------------------------------------------------------------------

export function codeSessionsDir({ env = process.env, platform = process.platform, home = homeRoot() } = {}) {
  if (env.AGENT_COMPANION_CODE_SESSIONS_DIR) return env.AGENT_COMPANION_CODE_SESSIONS_DIR;
  const redirected = resolve(home) !== resolve(homedir());
  if (platform === 'win32') return join((!redirected && env.APPDATA) || join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return join((!redirected && env.XDG_CONFIG_HOME) || join(home, '.config'), 'Claude', 'claude-code-sessions');
}

// Every local_*.json under the dir (<account>/<org>/ levels, found by a bounded walk), newest first.
function recordFiles(root) {
  const out = [];
  const walk = (d, depth) => {
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!/^local_.*\.json$/.test(e.name)) continue;
      try { out.push({ p, m: statSync(p).mtimeMs }); } catch { /* vanished */ }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

// The record of the session whose CLI session id is `cliId`: { sessionId, parent } (parent is the
// coordinator's local_ id or null), or null when no record names that id. The raw text is checked for the id
// before it is parsed, newest files first, so an active session is found without reading the whole folder.
export function sessionRecord(cliId, root = codeSessionsDir()) {
  if (!cliId || typeof cliId !== 'string') return null;
  for (const p of recordFiles(root)) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    if (!text.includes(cliId)) continue;
    let j;
    try { j = JSON.parse(text); } catch { continue; }
    const ids = [j.cliSessionId, j.lastAssistantCliSessionId, ...(Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds : [])];
    if (!ids.includes(cliId)) continue;
    const parent = j.spawnedFrom && typeof j.spawnedFrom.sessionId === 'string' && j.spawnedFrom.sessionId ? j.spawnedFrom.sessionId : null;
    return { sessionId: typeof j.sessionId === 'string' ? j.sessionId : null, parent };
  }
  return null;
}

const CACHE_FILE = 'coordinator-parent.json';
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 400;

// The coordinator's local_ id for a child session, or null (a top-level session, or no record found).
// A found parent never changes, so it is cached for good; "no parent" is cached for ten minutes.
export function parentOf(cliId, { now = Date.now(), root } = {}) {
  if (!cliId) return null;
  let cache = readJson(stateFile(CACHE_FILE), {});
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  const hit = cache[cliId];
  if (hit && typeof hit === 'object') {
    if (hit.parent) return hit.parent;
    if (now - (hit.at || 0) < NEGATIVE_TTL_MS) return null;
  }
  const rec = sessionRecord(cliId, root);
  if (!rec) return null; // not cached: the record may not be written yet
  cache[cliId] = { parent: rec.parent, at: now };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    for (const k of keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - CACHE_MAX)) delete cache[k];
  }
  writeJsonAtomic(stateFile(CACHE_FILE), cache);
  return rec.parent;
}

// ---------------------------------------------------------------------------
// Target addresses.
// ---------------------------------------------------------------------------

const WRAPPER_OPEN = /<cross-session-message\b([^>]*)>/g;
const attr = (s, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s); return m ? m[1] : null; };
const strings = (v, out) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};
const HEAD_BYTES = 16 * 1024 * 1024;

function readWindow(path) {
  const size = statSync(path).size;
  if (size <= 2 * HEAD_BYTES) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const a = Buffer.alloc(HEAD_BYTES);
    const b = Buffer.alloc(HEAD_BYTES);
    readSync(fd, a, 0, HEAD_BYTES, 0);
    readSync(fd, b, 0, HEAD_BYTES, size - HEAD_BYTES);
    return `${a.toString('utf8')}\n${b.toString('utf8')}`;
  } finally { closeSync(fd); }
}

// The sender's local_ id for a reply address, read from the child's own transcript: an incoming message
// carries from="<address>" from-session="local_<id>". Null when the address never appears there.
export function sessionForAddress(address, transcriptPath) {
  if (!address || !transcriptPath) return null;
  let text;
  try { text = readWindow(transcriptPath); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes('from-session=')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    for (const s of strings(rec, [])) {
      for (const m of s.matchAll(WRAPPER_OPEN)) {
        if (attr(m[1], 'from') === address) { const id = attr(m[1], 'from-session'); if (id) return id; }
      }
    }
  }
  return null;
}

// The session a send is addressed to, as a local_ id: the target itself when it is one, the resolved sender
// of a uds: reply address, else null (a name, another address form, an unknown pipe).
export function resolveTargetSession(to, transcriptPath) {
  const t = String(to ?? '').trim();
  if (/^local_[\w-]+$/.test(t)) return t;
  if (/^uds:/i.test(t)) return sessionForAddress(t, transcriptPath);
  return null;
}
