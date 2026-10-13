// Three advisory notes for a lead session (release 0.31.15). None blocks, none
// starts a child process, every reader is bounded and fails open.
//   F9  live sessions    other sessions touched in the last 2 h, in this repo
//                        and the repos named by the option related_repos.
//   F10 peer message     SendMessage to a target that is not one of this
//                        session's own subagents, while some are running.
//   F14 overdue worker   a background subagent running past
//                        overdue_worker_minutes (default 22), once per worker.
// A small ledger (state/worker-ledger/<session>.jsonl, written on SubagentStart
// and SubagentStop) says which workers are running. Start times come from the
// spawn telemetry row when there is one, else from the ledger row.

import {
  readdirSync, readFileSync, statSync, mkdirSync, appendFileSync, writeFileSync,
  openSync, readSync, closeSync, fstatSync, existsSync, rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, telemetryDir, claudeDir, tailRecords } from './context.mjs';
import { crossSessionSenders, startsWithCrossSessionMessage, TAGS } from './cross-session.mjs';

export const LIVE_WINDOW_MS = 2 * 3600 * 1000;
export const MAX_LISTED = 6;
export const OVERDUE_DEFAULT_MINUTES = 22;
const STATE_TTL_MS = 7 * 86400000;

const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
const slugify = (p) => String(p || '').replace(/[^A-Za-z0-9]/g, '-');

function sub(name) {
  const d = join(stateDir(), name);
  mkdirSync(d, { recursive: true });
  return d;
}

// Exclusive create: true for the one process that creates the marker.
export function claimOnce(dirName, sessionId, key) {
  try {
    const dir = join(sub(dirName), safe(sessionId));
    mkdirSync(dir, { recursive: true });
    const h = createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
    writeFileSync(join(dir, `${safe(key).slice(0, 40)}-${h}.seen`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function pruneOld(dirName) {
  try {
    const dir = sub(dirName);
    const now = Date.now();
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// --- Worker ledger -----------------------------------------------------------
export function ledgerFile(sessionId) {
  return join(sub('worker-ledger'), `${safe(sessionId)}.jsonl`);
}

export function ledgerWrite(sessionId, ev, p, now = Date.now()) {
  if (!sessionId || !p || !p.agent_id) return;
  appendFileSync(ledgerFile(sessionId), `${JSON.stringify({
    at: new Date(now).toISOString(), ev, agent_id: String(p.agent_id), agent_type: p.agent_type || null,
  })}\n`);
  if (ev === 'start') { pruneOld('worker-ledger'); pruneOld('peer-warned'); pruneOld('overdue-flagged'); pruneOld('live-sessions'); }
}

// Last event per agent id: Map agent_id -> { running, startedAt (ms), agent_type }.
export function readWorkers(sessionId) {
  const out = new Map();
  if (!sessionId) return out;
  const f = join(stateDir(), 'worker-ledger', `${safe(sessionId)}.jsonl`);
  if (!existsSync(f)) return out;
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.agent_id) continue;
    const t = Date.parse(r.at);
    if (r.ev === 'start') out.set(r.agent_id, { running: true, startedAt: t, agent_type: r.agent_type || null });
    else if (r.ev === 'stop') {
      const prev = out.get(r.agent_id);
      out.set(r.agent_id, { ...(prev || { startedAt: t, agent_type: r.agent_type || null }), running: false });
    }
  }
  return out;
}

// Latest spawn-telemetry start time per agent id for this session.
function telemetryStarts(sessionId) {
  const m = new Map();
  try {
    const sid = JSON.stringify(String(sessionId));
    const rows = tailRecords(join(telemetryDir(), 'subagent-starts.jsonl'), {
      bytes: 1024 * 1024, filter: (l) => l.includes(sid),
    });
    for (const r of rows) {
      if (r.session_id !== sessionId || !r.agent_id) continue;
      const t = Date.parse(r.at);
      if (Number.isFinite(t)) m.set(r.agent_id, t);
    }
  } catch { /* fail open */ }
  return m;
}

// agent_id -> name, from the sidecars next to each subagent transcript. The
// real layout is <project>/<session>/subagents; the test-fixture layout used
// by the resume guard is <dir>/subagents.
export function agentNames(transcriptPath, sessionId) {
  const names = new Map();
  if (!transcriptPath) return names;
  const base = dirname(String(transcriptPath));
  for (const dir of [join(base, safe(sessionId), 'subagents'), join(base, 'subagents')]) {
    let entries; try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.meta.json')) continue;
      const stem = f.slice(0, -'.meta.json'.length);
      const id = stem.startsWith('agent-') ? stem.slice(6) : stem;
      try {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (meta && typeof meta.name === 'string' && meta.name) names.set(id, meta.name);
      } catch { /* skip */ }
    }
  }
  return names;
}

// --- F14 ---------------------------------------------------------------------
export function overdueNotices(p, { minutes = OVERDUE_DEFAULT_MINUTES, now = Date.now() } = {}) {
  if (!(minutes > 0)) return [];
  const workers = readWorkers(p.session_id);
  if (!workers.size) return [];
  const tel = telemetryStarts(p.session_id);
  let names = null;
  const out = [];
  for (const [id, w] of workers) {
    if (!w.running) continue;
    const start = tel.get(id) ?? w.startedAt;
    if (!Number.isFinite(start)) continue;
    const ran = (now - start) / 60000;
    if (!(ran > minutes)) continue;
    if (!claimOnce('overdue-flagged', p.session_id, `${id}@${start}`)) continue;
    if (!names) names = agentNames(p.transcript_path, p.session_id);
    const label = names.get(id) || w.agent_type || id;
    out.push(`${label} has run ${Math.round(ran)} min, past 1.5x the 15-minute worker size. Probe its output file or worktree now and tell the operator what it is doing.`);
  }
  return out;
}

// --- F10 ---------------------------------------------------------------------
const stripRef = (to) => String(to || '').trim().replace(/\s*\[[^\]]*\]\s*$/, '');

const PEER_SCAN_BYTES = 4 * 1024 * 1024;
const norm = (s) => String(s || '').trim().toLowerCase();

// Parse the known_peers option: a JSON array of names. Anything else is empty.
export function parseKnownPeers(raw) {
  try {
    const v = JSON.parse(String(raw || '').trim() || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map(norm) : [];
  } catch { return []; }
}

// Senders of cross-session messages this session has received (the `from` and
// `name` attributes), read from the tail of its transcript. A target that is in
// this set is a reply, not a stray message to a stranger.
export function receivedPeers(transcriptPath) {
  const out = new Set();
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - PEER_SCAN_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!TAGS.some((tg) => line.includes(tg))) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || rec.type !== 'user') continue;
      const c = rec.message && rec.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('\n') : '';
      if (!startsWithCrossSessionMessage(text)) continue;
      for (const s of crossSessionSenders(text)) out.add(norm(s));
    }
  } catch { /* fail open: unknown */ } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
  return out;
}

export function peerMessageNote(p, { knownPeers = [] } = {}) {
  const to = stripRef((p.tool_input || {}).to || (p.tool_input || {}).recipient);
  if (!to || to === '*' || to.toLowerCase() === 'main') return null;
  if (knownPeers.includes(norm(to))) return null; // (b) listed in known_peers
  const workers = readWorkers(p.session_id);
  const running = [...workers].filter(([, w]) => w.running).map(([id]) => id);
  if (!running.length) return null;
  const names = agentNames(p.transcript_path, p.session_id);
  // Own subagent, running or not: not a peer session.
  for (const id of workers.keys()) if (id === to || names.get(id) === to) return null;
  for (const n of names.values()) if (n === to) return null;
  // (a) the target wrote to this session: sending to it is a reply.
  if (p.transcript_path && receivedPeers(p.transcript_path).has(norm(to))) return null;
  if (!claimOnce('peer-warned', p.session_id, to)) return null;
  const list = running.map((id) => names.get(id) || workers.get(id).agent_type || id);
  return `This message goes to another session ("${to}"), not your own workers (${[...new Set(list)].join(', ')}). Fine if it is meant for a peer or coordinator; to reach a worker, use its name.`;
}

// --- F9 ----------------------------------------------------------------------
export function repoRootOf(cwd) {
  return String(cwd || '').replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '').replace(/[\\/]+$/, '');
}

export function parseRelated(raw) {
  if (!raw) return {};
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, list] of Object.entries(v)) if (Array.isArray(list)) out[k] = list.filter((x) => typeof x === 'string' && x);
    return out;
  } catch { return {}; }
}

function readChunk(file, from, len) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, from < 0 ? size + from : from);
    const n = Math.min(len, size - start);
    if (n <= 0) return '';
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, start);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

export function titleOf(file) {
  const tail = readChunk(file, -65536, 65536);
  let title = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"custom-title"')) continue;
    try { const r = JSON.parse(line); if (r.type === 'custom-title' && r.customTitle) title = String(r.customTitle); } catch { /* torn */ }
  }
  if (title) return title.slice(0, 60);
  const head = readChunk(file, 0, 65536);
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.type !== 'user') continue;
      const c = r.message && r.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text : '';
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (t && !t.startsWith('<')) return t.slice(0, 60);
    } catch { /* torn */ }
  }
  return null;
}

// Newest record timestamp in the file tail, ms; null if none found. The mtime alone
// is not proof of life: the desktop app and orphaned CLIs touch idle transcripts.
export function lastRecordMs(file) {
  for (const len of [65536, 1048576]) { // second pass for a giant last record
    const lines = readChunk(file, -len, len).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /"timestamp":"([^"]+)"/.exec(lines[i]);
      if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
    }
  }
  return null;
}

function ageOf(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

// Live sessions other than this one: [{ id, file, repo, mtime }] newest first.
export function liveSessions({ sessionId, cwd, related = {}, now = Date.now() }) {
  const root = repoRootOf(cwd);
  if (!root) return [];
  const repo = basename(root);
  const mine = slugify(root);
  const relSlugs = new Map((related[repo] || []).map((n) => [slugify(n), n]));
  const projects = join(claudeDir(), 'projects');
  let dirs; try { dirs = readdirSync(projects); } catch { return []; }
  const found = [];
  for (const d of dirs) {
    const base = d.replace(/--claude-worktrees-.*$/i, '');
    let label = null;
    if (base === mine) label = repo;
    else for (const [slug, name] of relSlugs) if (base === slug || base.endsWith(`-${slug}`)) { label = name; break; }
    if (!label) continue;
    let files; try { files = readdirSync(join(projects, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (id === sessionId) continue;
      const file = join(projects, d, f);
      let m; try { m = statSync(file).mtimeMs; } catch { continue; }
      if (now - m > LIVE_WINDOW_MS) continue; // cheap pre-filter
      const last = lastRecordMs(file);
      if (last === null || now - last > LIVE_WINDOW_MS) continue;
      found.push({ id, file, repo: label, mtime: last }); // mtime field = last record time
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

// mode 'start' always reports a non-empty set; 'change' only when the set of
// ids differs from the last one reported for this session.
export function liveSessionsNote(p, { related, mode, now = Date.now() }) {
  const live = liveSessions({ sessionId: p.session_id, cwd: p.cwd || process.cwd(), related, now });
  const sig = live.map((s) => s.id).sort().join(',');
  const f = join(sub('live-sessions'), `${safe(p.session_id)}.sig`);
  let prev = null; try { prev = readFileSync(f, 'utf8'); } catch { /* none */ }
  if (prev !== sig) { try { writeFileSync(f, sig); } catch { /* ignore */ } }
  if (!live.length) return null;
  if (mode === 'change' && prev === sig) return null;
  const shown = live.slice(0, MAX_LISTED).map((s) => `"${titleOf(s.file) || s.id.slice(0, 8)}" (${s.repo}, ${ageOf(now - s.mtime)})`);
  const more = live.length > MAX_LISTED ? ` (+${live.length - MAX_LISTED} more)` : '';
  return `Other live sessions (last 2 h): ${shown.join(', ')}${more}. Before you change something one of them works on or depends on (a routine, a design, a shared file), message it and say what changes.`;
}
