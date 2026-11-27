// State for the post-release watch (scripts/release-watch.mjs), shared with the hooks that show or honour it.
//
// Files, all under <state root>/state/ (fail open on a missing or unparseable file):
//   release-watch-run.json    the schedule for the newest install: T, version, due[], done[], prevT
//   release-watch-flag.json   the open flag: flags[], notifiedAt, ackedAt, clearedAt, cooldown{}
//   release-hold.json         the hold: { since, version, reason, flags, workers, clearedAt }
//   release-hold-sessions.json  sessions shown the hold notice or refused by it: { holdSince, sessions[], clearedAt, noticed{} }
//   release-owner.json          the session that last ran `claude plugin install|update agent-companion`: { session, at, transcriptPath }
//   release-watch-checks.jsonl  one row per check and per clear
// AGENT_COMPANION_FAKE_NOW moves the clock for tests. Nothing here throws.

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, renameSync, mkdirSync, openSync, fstatSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, opt } from './context.mjs';
import { createRequire } from 'node:module';
import { normalizeSignature } from './designed-denies.mjs';

// Every read-modify-write of release-hold-sessions.json and release-hold-message-pending.json runs under the shared lock helper
// (lib/file-lock.mjs): a lead's noteHeld and a worker's denied-call noteHeld, or two clears, would otherwise lose one update.
// Fails open: a lock not taken in 1.5 s runs the write unlocked.
// The helper loads on the first locked write, not at import: every spawn imports this module for the hold check, and a plain spawn must not load the lock helper (tests/premium-window-lock.test.mjs).
let lockHelper;
const locked = (file, fn) => {
  if (!lockHelper) { try { lockHelper = createRequire(import.meta.url)('./file-lock.mjs').withFileLock; } catch { lockHelper = (_f, f) => f(); } }
  return lockHelper(`${file}.lock`, fn, { waitMs: 1500, staleMs: 5000, failOpen: true });
};

export const COOLDOWN_MS = 4 * 3600e3;
export const WORSEN_FACTOR = 2;

export const now = () => {
  const f = process.env.AGENT_COMPANION_FAKE_NOW;
  if (f) { const t = /^\d+$/.test(f) ? Number(f) : Date.parse(f); if (t > 0) return t; }
  return Date.now();
};

export const paths = () => {
  const d = stateDir();
  return {
    run: join(d, 'release-watch-run.json'),
    flag: join(d, 'release-watch-flag.json'),
    hold: join(d, 'release-hold.json'),
    checks: join(d, 'release-watch-checks.jsonl'),
    standing: join(d, 'release-watch-standing.json'),
    heldSessions: join(d, 'release-hold-sessions.json'),
    messagePending: join(d, 'release-hold-message-pending.json'),
    owner: join(d, 'release-owner.json'),
    scopeNotice: join(d, 'release-hold-scope-notice.json'),
  };
};

export function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function writeJson(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 1));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function appendRow(row) {
  try { appendFileSync(paths().checks, JSON.stringify(row) + '\n'); return true; } catch { return false; }
}

const iso = (t) => new Date(t).toISOString();

// Every row of the checks file (checks, holds, clears), oldest first. Fails open to [].
export function readRows() {
  try { return readFileSync(paths().checks, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

// ---- flag ----
export function readFlag() { return readJson(paths().flag); }
export function flagIsOpen(f = readFlag()) { return !!(f && Array.isArray(f.flags) && f.flags.length && !f.clearedAt); }

// A flag the operator answered (reply or clear) stays answered for the rest of that install: its signal level is stored in
// cooldown[name] = { level, T, at }, and the flag comes back only when a later window's level is more than WORSEN_FACTOR
// times the answered level. Levels are rates (per hour, per 100 spawns or a share), so a count that merely grows cannot get around it.
// flags: [{ name, value, level?, detail? }]. Returns the flag object written, or null when nothing new.
// Flags that report on the watch itself, not on the release: they show in the check, the tick and the flag line, but never start a hold
// (a fresh install with no telemetry would otherwise hold all work).
export const NO_HOLD_FLAGS = new Set(['usage-source-empty', 'harness-refusals', 'insufficient-data']);
// Sample floor (0.31.75): a flag starts a hold only when it carries at least release_watch_hold_min_events events AND release_watch_hold_min_n
// samples (n: spawns, workers or finished workers, whatever the flag's rate is over). Below it the flag still notifies, never holds. 0 turns a floor off.
// A flag that carries no count (a legacy v1 row) cannot be judged small and passes. Defaults come from the check history (README, 0.31.75).
export const HOLD_MIN_EVENTS_DEFAULT = 8;
export const HOLD_MIN_N_DEFAULT = 30;
const optNum = (k, d) => { const n = Number(opt(k, d)); return Number.isFinite(n) && n >= 0 ? n : d; };
// Severity flags that are meant to hold on a single event are exempt from the floor (runaway: a runaway session is a real fault even once).
export const FLOOR_EXEMPT_FLAGS = new Set(['runaway']);
// Flags whose n is not a sample count but active hours (guard:*, queue-clears): only the event floor applies to them.
const hoursN = (name) => /^guard:/.test(String(name || '')) || name === 'queue-clears';
export function meetsHoldFloor(x) {
  try {
    if (x && FLOOR_EXEMPT_FLAGS.has(x.name)) return true;
    const minEv = optNum('release_watch_hold_min_events', HOLD_MIN_EVENTS_DEFAULT);
    const minN = optNum('release_watch_hold_min_n', HOLD_MIN_N_DEFAULT);
    if (minEv > 0 && typeof x.events === 'number' && x.events < minEv) return false;
    if (minN > 0 && typeof x.n === 'number' && x.n < minN && !hoursN(x.name)) return false;
    return true;
  } catch { return true; }
}
// What a hold refuses: 'releases' (the default) = only agent-companion release and install actions; 'all' = new agents, resumes, queue
// admissions, heavy commands, and running workers hand off (the 0.31.63 behaviour).
export function holdScope() {
  try { return String(opt('release_watch_hold_scope', 'releases')).trim().toLowerCase() === 'all' ? 'all' : 'releases'; } catch { return 'releases'; }
}
const holdable = (flags) => (Array.isArray(flags) ? flags : []).filter((x) => x && !NO_HOLD_FLAGS.has(x.name) && meetsHoldFloor(x));
export const holdableFlags = holdable;
const levelOf = (f) => (typeof f.level === 'number' ? f.level : typeof f.value === 'number' ? f.value : null);
// 0.31.70 named a hook-signature flag with the raw error text; 0.31.71 collapses paths and numbers first. An answer stored under the old name still holds for the new one, so the upgrade does not raise it again.
const legacySigName = (k) => { const m = /^(hook-signature:\S+ )([\s\S]*)$/.exec(k); return m ? m[1] + normalizeSignature(m[2]).slice(0, 48) : k; };
const answeredFor = (cool, name, T) => {
  let c = cool[name];
  if (!c && name.startsWith('hook-signature:')) { const k = Object.keys(cool).find((x) => x.startsWith('hook-signature:') && legacySigName(x) === name); if (k) c = cool[k]; }
  return c && c.T === T ? c : null;
};
// T is the install time of the release that produced the flags; `chain` (optional) is the key the cooldown uses, so an answer given for one release of a chain holds for the next.
export function openFlag({ version, T, chain, check, flags, at = now() } = {}) {
  try {
    const old = readFlag();
    const cool = (old && old.cooldown) || {};
    const fresh = (Array.isArray(flags) ? flags : []).filter((f) => {
      if (!f || !f.name) return false;
      const c = answeredFor(cool, f.name, chain ?? T ?? null);
      if (!c) return true;
      const l = levelOf(f);
      return l != null && typeof c.level === 'number' && c.level > 0 && l > c.level * WORSEN_FACTOR;
    });
    if (!fresh.length) return null;
    const open = flagIsOpen(old);
    const oldByName = new Map(open ? old.flags.map((o) => [o.name, o]) : []);
    // Renotify (restart the countdown) only for a name not already in the open flag, or one that doubled since it was raised.
    // A watch-health flag (NO_HOLD_FLAGS) joining an answered flag never restarts the countdown: it could not hold, and it must not re-open the hold path of the flag already answered.
    // 0.31.77: also when a flag first notified below the hold floor now meets it (the old copy is not holdable): the grace runs from when the flag first
    // meets the floor, not from the earlier showing. An answered flag (ackedAt) stays answered.
    const renotify = !open || holdable(fresh).some((f) => { const o = oldByName.get(f.name); const lo = o && levelOf(o); const l = levelOf(f); return !o || (lo > 0 && l > lo * WORSEN_FACTOR) || (!old.ackedAt && !holdable([o]).length); });
    const merged = open ? [...old.flags.filter((o) => !fresh.some((f) => f.name === o.name)), ...fresh] : fresh;
    const next = {
      v: 2,
      version: version ?? old?.version ?? null,
      T: T ?? old?.T ?? null,
      chain: chain ?? old?.chain ?? null,
      check: check ?? old?.check ?? null,
      flags: merged,
      openedAt: open ? old.openedAt : iso(at),
      // notifiedAt stays null until a session actually shows the flag (noteShown): the hold countdown starts at that first showing, not at the tick.
      notifiedAt: renotify ? null : (old.notifiedAt ?? null),
      ackedAt: renotify ? null : old.ackedAt ?? null,
      shownTo: (open && !renotify && old.shownTo) || {},
      candidates: (open && !renotify && Array.isArray(old.candidates)) ? old.candidates : [],
      ack: (open && !renotify && old.ack) || null,
      clearedAt: null,
      cooldown: cool,
    };
    return writeJson(paths().flag, next) ? next : null;
  } catch { return null; }
}

const answerLevels = (f, at, cool = {}) => {
  const c = { ...cool };
  for (const x of f.flags || []) c[x.name] = { level: levelOf(x), T: f.chain ?? f.T ?? null, at: iso(at) };
  return c;
};

// ---- human-only replies ----
// A reply counts only when the transcript (or the hook payload) positively identifies a typed prompt: origin.kind === 'human'.
// Scheduled wakeups, task notifications, peer messages and prompts from older builds without an origin never ack.
export const HUMAN_SIGNAL = { transcript: 'transcript-origin-human', payload: 'payload-origin-human' };
export const CANDIDATE_TTL_MS = 10 * 60e3;
const TAIL_BYTES = 256 * 1024;
const MATCH_BEFORE_MS = 10e3;
const MATCH_AFTER_MS = 120e3;

export function isHumanRecord(rec) {
  return !!(rec && typeof rec === 'object' && rec.type === 'user' && rec.origin && rec.origin.kind === 'human'
    && !rec.isMeta && !rec.isSidechain && !rec.isCompactSummary && !rec.toolUseResult && !rec.sourceToolUseID);
}

const recText = (rec) => {
  const c = rec && rec.message && rec.message.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
  return '';
};
export const promptSha = (text) => createHash('sha256').update(String(text ?? '').trim()).digest('hex').slice(0, 12);

// The end of a transcript as lines (first partial line dropped), read back in growing chunks (256 KB, doubling) until the first
// record's timestamp is older than `fromMs` (the scan has passed the time asked for), the whole file is read, or MAX_SCAN_BYTES is
// reached. A busy lead session can write far more than one chunk after a typed prompt. Bounded: never reads more than the cap.
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;
const firstTimestamp = (lines) => {
  for (const l of lines) { const m = l && TS_RE.exec(l); const t = m && Date.parse(m[1]); if (t > 0) return t; }
  return null;
};
function defaultTail(path, fromMs, maxBytes = MAX_SCAN_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    let len = Math.min(size, TAIL_BYTES);
    for (;;) {
      const start = size - len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      if (start === 0 || len >= maxBytes) return lines;
      const first = firstTimestamp(lines);
      if (first != null && fromMs > 0 && first < fromMs) return lines; // passed the candidate's time
      len = Math.min(size, maxBytes, len * 2);
    }
  } catch { return []; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } } }
}

// True when the transcript holds a typed (isHumanRecord) prompt with this sha written within [from, to] (epoch ms).
export function matchHumanPrompt(path, sha, from, to, readTail = defaultTail) {
  try {
    if (!path || !sha) return false;
    for (const l of readTail(path, from) || []) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!isHumanRecord(r)) continue;
      const t = Date.parse(r.timestamp);
      if (!(t >= from && t <= to)) continue;
      if (promptSha(recText(r)) === sha) return true;
    }
  } catch { /* fail closed: no match */ }
  return false;
}

// Scans lead transcripts (<projectsDir>/*/*.jsonl, modified since `since`, newest first, at most maxFiles) for a typed (isHumanRecord)
// record written within withinMs of `near` (30 s: a slow hook stamps its ack later than the transcript record). Used once, by the v2
// flag migration, to tell a legacy ack (a bare reply) from a human one. With `sha` (the hash of the reply text) only a record with that
// text counts; without it the human record nearest in time wins. Returns { session, promptAt } or null. Bounded reads; fails closed.
export function findHumanRecordNear({ projectsDir, since = 0, near, withinMs = 30e3, sha = null, maxFiles = 200, readTail = defaultTail } = {}) {
  try {
    if (!projectsDir || !(near > 0)) return null;
    const files = [];
    for (const p of readdirSync(projectsDir)) {
      let ents; try { ents = readdirSync(join(projectsDir, p), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const fp = join(projectsDir, p, e.name);
        try { const m = statSync(fp).mtimeMs; if (m >= since) files.push({ fp, m, id: e.name.slice(0, -6) }); } catch { /* gone */ }
      }
    }
    files.sort((a, b) => b.m - a.m);
    let best = null;
    for (const { fp, id } of files.slice(0, maxFiles)) {
      for (const l of readTail(fp, near - withinMs) || []) {
        if (!l || !l.includes('"human"')) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (!isHumanRecord(r)) continue;
        const t = Date.parse(r.timestamp);
        if (!(t > 0) || Math.abs(t - near) > withinMs) continue;
        if (sha && promptSha(recText(r)) !== sha) continue;
        if (!best || Math.abs(t - near) < best.d) best = { d: Math.abs(t - near), session: r.sessionId || id, promptAt: t };
      }
    }
    if (best) return { session: best.session, promptAt: best.promptAt };
  } catch { /* fail closed */ }
  return null;
}

// The flag was shown to this session on this turn. Only an open, unanswered flag; the first time wins.
export function noteShown(sessionId, at = now()) {
  try {
    if (!sessionId) return false;
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return false;
    const shownTo = { ...(f.shownTo || {}) };
    const first = !f.notifiedAt; // the first real showing of this notification starts the hold countdown
    if (shownTo[sessionId] && !first) return false;
    if (!shownTo[sessionId]) shownTo[sessionId] = iso(at);
    return writeJson(paths().flag, { ...f, shownTo, notifiedAt: f.notifiedAt || iso(at) });
  } catch { return false; }
}

// The operator's words that lift a hold: a short prompt saying "clear hold" or "release hold".
export const CLEAR_WORDS_RE = /^(please\s+)?(clear|release)\s+(the\s+)?hold[.!]*$/i;
// Ack intent: a reply answers the flag only when it SAYS so. The notice asks for "ack" (or "keep it" / "no rollback"); a plain
// equivalent counts too. Every clause of the reply must be an ack phrase or filler, and a question never counts, so "Well analysis
// please" or "why did it flag?" leaves the flag open and the countdown running.
const ACK_CLAUSES = [
  /^ack(s|ed|'d|nowledge[ds]?)?( (it|this|that|the flag|the flags|the watch|the notice|v?\d+\.\d+\.\d+))?$/,
  /^keep (it|this|the release|this release|that|v?\d+\.\d+\.\d+)( as is)?$/,
  /^(it'?s|its|that'?s|this is|all|everything'?s|everything is) (fine|ok|okay|good)$/,
  /^(looks|seems) (fine|ok|okay|good)( to me)?$/,
  /^no roll ?back( needed)?$/,
  /^(do not|don'?t|dont) roll ?back( (it|the release))?$/,
  /^noted$/,
];
const ACK_FILLER = /^(ok|okay|yes|yep|yeah|sure|thanks|thank you|please|well)$/;
const ACK_FILLER_EDGE = /^(?:(?:ok|okay|yes|yep|yeah|sure|thanks|thank you|please)\s+)+|(?:\s+(?:ok|okay|yes|yep|yeah|sure|thanks|thank you|please))+$/g; // filler at either edge of a clause
export function isAckText(text) {
  try {
    const t = String(text ?? '').trim().toLowerCase().replace(/[‘’]/g, "'");
    if (!t || t.length > 120 || t.includes('?')) return false;
    const protectedT = t.replace(/(\d)\.(?=\d)/g, '$1\u0001'); // a version number is not a sentence end
    const clauses = protectedT.split(/[,;.!—–]+|\s+(?:and|then)\s+|\s+-{1,2}\s+/).map((c) => c.replace(/\u0001/g, '.').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(ACK_FILLER_EDGE, '').trim()).filter(Boolean); // brackets and the like around a clause are ignored
    return clauses.length > 0 && clauses.every((c) => ACK_FILLER.test(c) || ACK_CLAUSES.some((re) => re.test(c))) && clauses.some((c) => !ACK_FILLER.test(c));
  } catch { return false; }
}

const ackWrite = (f, { session, promptAt, confirmedAt, signal }) => {
  const ack = { session, promptAt: iso(promptAt), confirmedAt: iso(confirmedAt), signal, shownAt: (f.shownTo || {})[session] ?? null };
  const next = { ...f, ackedAt: iso(promptAt), ack, candidates: [], cooldown: answerLevels(f, promptAt, f.cooldown) };
  return writeJson(paths().flag, next) ? ack : null;
};

// A prompt typed in a session that was shown the flag on an earlier turn. A payload origin of 'human' acks at once; anything else
// becomes a candidate that confirmCandidates() checks against the transcript. During a hold only the clear-hold words are recorded
// (a confirmed typed "clear hold" ends the hold). Never stores prompt text, only a sha.
export function noteCandidate({ sessionId, transcriptPath, prompt, payloadOrigin, at = now() } = {}) {
  try {
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || !sessionId) return false;
    const text = String(prompt ?? '').trim();
    const held = isHoldActive();
    if (held && !CLEAR_WORDS_RE.test(text)) return false;
    if (!held && !isAckText(text)) return false; // a question or a request for analysis is not an ack: the flag stays open
    const shown = Date.parse((f.shownTo || {})[sessionId]);
    if (!(shown > 0) || !(shown < at)) return false;
    if (!held && payloadOrigin && payloadOrigin.kind === 'human') {
      return !!ackWrite(f, { session: sessionId, promptAt: at, confirmedAt: at, signal: HUMAN_SIGNAL.payload });
    }
    const cands = Array.isArray(f.candidates) ? [...f.candidates] : [];
    cands.push({ session: sessionId, transcriptPath: transcriptPath || null, at: iso(at), sha: promptSha(text), len: text.length, ...(held ? { clear: true } : {}) });
    return writeJson(paths().flag, { ...f, candidates: cands.slice(-20) });
  } catch { return false; }
}

// Checks every candidate against its transcript tail. A match acks (ackedAt = the prompt time); a candidate past the TTL with no
// match is dropped and logged. Acts only on an open, unanswered flag. During a hold only a clear-hold candidate is looked at, and a
// match ends the hold. Returns the ack (or the clear result) or null.
export function confirmCandidates({ at = now(), readTail = defaultTail } = {}) {
  try {
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    const held = isHoldActive();
    const cands = Array.isArray(f.candidates) ? f.candidates : [];
    if (!cands.length) return null;
    const ttl = Number(opt('release_watch_ack_ttl_minutes', 10)) * 60e3 || CANDIDATE_TTL_MS;
    const keep = [];
    for (const c of cands) {
      if (c.clear && !held) continue; // the hold it was for is gone
      if (held && !c.clear) { keep.push(c); continue; }
      const ct = Date.parse(c.at);
      if (matchHumanPrompt(c.transcriptPath, c.sha, ct - MATCH_BEFORE_MS, ct + MATCH_AFTER_MS, readTail)) {
        // The lift records the sessions to message (clear -> markHoldCleared, owed); the next lead prompt claims them (takeOwedMessages).
        if (held) { const lifted = clear({ by: 'prompt', at }); return { signal: HUMAN_SIGNAL.transcript, cleared: true, heldSessions: lifted.heldSessions }; }
        return ackWrite(f, { session: c.session, promptAt: ct, confirmedAt: at, signal: HUMAN_SIGNAL.transcript });
      }
      if (at - ct > ttl) appendRow({ at: iso(at), event: 'ack-rejected', session: c.session, reason: 'no human record' });
      else keep.push(c);
    }
    if (keep.length !== cands.length) writeJson(paths().flag, { ...f, candidates: keep });
    return null;
  } catch { return null; }
}

// Kept for one release so an older hook copy loaded in a long-lived session cannot ack: a bare reply no longer counts.
export function noteReply() { return false; }

// ---- hold ----
export function readHold() { return readJson(paths().hold); }
// Held only while the file exists with neither clearedAt nor ackedAt: a failed delete can't leave a stuck hold.
export function isHoldActive() {
  try { const h = readHold(); return !!(h && !h.clearedAt && !h.ackedAt); } catch { return false; }
}

const lastRow = (event) => {
  try {
    const L = readFileSync(paths().checks, 'utf8').split('\n').filter(Boolean);
    for (let k = L.length - 1; k >= 0; k--) { try { const r = JSON.parse(L[k]); if (r && r.event === event) return Date.parse(r.at) || null; } catch { /* skip */ } }
  } catch { /* none */ }
  return null;
};

// Intervals [from, to] (epoch ms) in which a hold was on, from the 'hold' and 'clear' rows plus the hold file. Whatever telemetry
// is written inside them (denials the hold causes, queue refusals) is the hold's own and never counts toward a signal.
export const HOLD_GRACE_MS = 5 * 60e3;
export function holdIntervals(nowMs = now()) {
  const out = [];
  try {
    let from = null;
    try {
      for (const l of readFileSync(paths().checks, 'utf8').split('\n')) {
        if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
        const t = Date.parse(r && r.at);
        if (!(t > 0)) continue;
        if (r.event === 'hold' && from == null) from = t;
        else if (r.event === 'clear' && from != null) { out.push([from, t + HOLD_GRACE_MS]); from = null; }
      }
    } catch { /* no rows */ }
    if (from != null) out.push([from, nowMs + HOLD_GRACE_MS]);
    const h = readHold();
    const hs = h && Date.parse(h.since);
    if (hs > 0 && !out.some(([a]) => a === hs)) { const ce = Date.parse(h.clearedAt || h.ackedAt); out.push([hs, (ce > 0 ? ce : nowMs) + HOLD_GRACE_MS]); }
  } catch { /* fail open: no intervals */ }
  return out;
}

// Writes the hold when: delay > 0, the flag is open and unanswered, no clear is newer than the notification, and notifiedAt + delay has passed.
export function maybeHold({ holdMinutes, at = now() } = {}) {
  try {
    const delay = Number(holdMinutes);
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    // During a hold the tick still confirms a pending "clear hold" candidate, so the operator need not repeat the words.
    if (isHoldActive()) { confirmCandidates({ at }); return null; }
    if (!(delay > 0)) return null;
    if (confirmCandidates({ at })) return null; // a typed reply found in the transcript: answered, no hold
    const hf = holdable(f.flags);
    if (!hf.length) return null; // only watch-health flags (usage-source-empty): report, never hold
    const n = Date.parse(f.notifiedAt);
    if (!(n > 0) || at < n + delay * 60e3) return null;
    const lc = lastRow('clear');
    if (lc && lc >= n) return null; // a clear after the notification: never hold on that flag
    const hold = {
      since: iso(at), version: f.version ?? null,
      reason: `release watch flagged ${hf.map((x) => x.name).join(', ')} and nobody answered within ${delay} min`,
      flags: hf, workers: 'handoff', clearedAt: null,
    };
    if (!writeJson(paths().hold, hold)) return null;
    appendRow({ at: iso(at), event: 'hold', version: hold.version, flags: hf.map((x) => x.name) });
    return hold;
  } catch { return null; }
}

// ---- clear ----
// Writes the cleared state first (atomic temp + rename) and checks it by reading it back; the file delete is best effort.
// The hold reader honours clearedAt, so a failed delete cannot leave the hold stuck or bring it back.
export function clear({ by = 'operator', at = now() } = {}) {
  const out = { flagCleared: false, holdCleared: false, heldSessions: [] };
  try {
    out.heldSessions = withLocalIds(heldSessions());
    const f = readFlag();
    if (f && !f.clearedAt) {
      writeJson(paths().flag, { ...f, clearedAt: iso(at), clearedBy: by, cooldown: answerLevels(f, at, f.cooldown) });
      let back = readFlag();
      if (!(back && back.clearedAt)) { try { unlinkSync(paths().flag); } catch { /* fail open */ } back = readFlag(); }
      out.flagCleared = !flagIsOpen(back);
    }
    const h = readHold();
    if (h && !h.clearedAt) {
      writeJson(paths().hold, { ...h, clearedAt: iso(at), clearedBy: by });
      try { unlinkSync(paths().hold); } catch { /* fail open: the cleared state written above already lifts it */ }
      out.holdCleared = !isHoldActive();
    } else if (existsSync(paths().hold)) {
      try { unlinkSync(paths().hold); } catch { /* fail open */ }
    }
    // A list left by an earlier hold is stale: drop it before the lift records its own. When no hold was lifted here, the list goes too,
    // unless a clear still owes messages from it (unclaimed, inside OWED_TTL_MS).
    const lf = readHeld();
    if (lf) {
      const keepList = !!(lf.clearedAt && at - Date.parse(lf.clearedAt) <= OWED_TTL_MS); // a cleared, recent list stays whether or not the owed messages were claimed: "hold cleared" notices still read it
      if (out.holdCleared ? (h && lf.holdSince !== h.since) : !keepList) { try { unlinkSync(paths().heldSessions); } catch { /* fail open */ } }
    }
    if (out.holdCleared) markHoldCleared(at, by, out.heldSessions);
    if (out.flagCleared || out.holdCleared) appendRow({ at: iso(at), event: 'clear', by, flagCleared: out.flagCleared, holdCleared: out.holdCleared, ...(out.holdCleared ? { clearedAt: iso(at), heldSessions: out.heldSessions } : {}) });
  } catch { /* fail open */ }
  return out;
}

// ---- sessions held by the hold ----
// Every session shown the hold notice or refused by the hold is recorded (a lead by session id; a subagent by session id and agent id),
// so the operator can message each one after the clear and each lead gets a one-time "cleared" notice on its next prompt.
export const HELD_CAP = 200;
const sessionKey = (x) => `${x.sessionId}|${x.agentId || ''}`;
const readHeld = () => { const f = readJson(paths().heldSessions); return f && Array.isArray(f.sessions) ? f : null; };

// p: the hook payload (session_id, cwd, transcript_path, agent_id). Fails open; false when not held or nothing to record.
export function noteHeld(p, at = now()) {
  try {
    if (!p || !p.session_id || !isHoldActive() || holdScope() !== 'all') return false; // releases scope stops no session: nobody is owed a resume message
    const h = readHold();
    return locked(paths().heldSessions, () => {
      let f = readHeld();
      if (!f || f.holdSince !== h.since || f.clearedAt) f = { holdSince: h.since, sessions: [], clearedAt: null, noticed: {} };
      const rec = { sessionId: String(p.session_id), agentId: p.agent_id ? String(p.agent_id) : null, cwd: p.cwd || null, transcriptPath: p.transcript_path || null, firstSeen: iso(at), lastSeen: iso(at) };
      const i = f.sessions.findIndex((x) => sessionKey(x) === sessionKey(rec));
      if (i >= 0) f.sessions[i] = { ...f.sessions[i], cwd: rec.cwd || f.sessions[i].cwd, transcriptPath: rec.transcriptPath || f.sessions[i].transcriptPath, lastSeen: rec.lastSeen };
      else f.sessions.push(rec);
      f.sessions = capHeld(f.sessions);
      return writeJson(paths().heldSessions, f);
    });
  } catch { return false; }
}

// Over the cap, subagent records go first (oldest lastSeen first): a lead that stopped is the one that needs its message.
const byLastSeen = (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen);
export function capHeld(list, cap = HELD_CAP) {
  if (list.length <= cap) return list;
  const leads = list.filter((x) => !x.agentId).sort(byLastSeen).slice(-cap);
  const room = cap - leads.length;
  const subs = room > 0 ? list.filter((x) => x.agentId).sort(byLastSeen).slice(-room) : [];
  return [...leads, ...subs].sort(byLastSeen);
}

// The sessions recorded for the hold now on ([] when none).
export function heldSessions() {
  try {
    if (!isHoldActive()) return [];
    const f = readHeld(); const h = readHold();
    return f && f.holdSince === h.since && !f.clearedAt ? f.sessions : [];
  } catch { return []; }
}

// ---- desktop session ids ----
// The Claude desktop app keeps one JSON file per session under %APPDATA%/Claude/claude-code-sessions/<account>/<org>/local_<uuid>.json
// ({ sessionId: "local_<uuid>", cliSessionId: <the Claude Code session id>, cwd, ... }). Read only. AGENT_COMPANION_DESKTOP_SESSIONS_DIR moves it for tests.
export const desktopStoreDir = () => process.env.AGENT_COMPANION_DESKTOP_SESSIONS_DIR || (process.env.APPDATA ? join(process.env.APPDATA, 'Claude', 'claude-code-sessions') : null);

// Map of Claude Code session id -> desktop session id (local_<uuid>); empty when the store is missing. Never throws.
export function desktopSessionMap(dir = desktopStoreDir()) {
  const m = new Map();
  const walk = (d, depth) => {
    let names; try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!/^local_.+\.json$/.test(e.name)) continue;
      const j = readJson(p);
      if (j && typeof j.cliSessionId === 'string' && /^local_/.test(String(j.sessionId || ''))) m.set(j.cliSessionId, j.sessionId);
    }
  };
  try { if (dir) walk(dir, 0); } catch { /* fail open */ }
  return m;
}

// Each lead entry gets localSessionId (the desktop id, or null when the store has no such session). Subagent entries are left as they are.
export function withLocalIds(list, map = desktopSessionMap()) {
  return list.map((x) => (x.agentId ? x : { ...x, localSessionId: map.get(x.sessionId) || null }));
}

export const MESSAGE_LINE = 'Send each of these sessions a local message now: ';
export const localIdsOf = (list) => list.filter((x) => !x.agentId && x.localSessionId).map((x) => x.localSessionId);

// One text for `held` and `clear`: counts, one line per lead, then the local ids to message and the leads with no desktop id.
export function heldText(list) {
  if (!list.length) return 'held sessions: none recorded';
  const leads = list.filter((x) => !x.agentId); const subs = list.filter((x) => x.agentId);
  const lines = [`held sessions: ${leads.length} lead, ${subs.length} subagent`];
  for (const x of leads) lines.push(`lead ${x.sessionId}  local ${x.localSessionId || 'unmapped'}  cwd ${x.cwd || '?'}  seen ${x.firstSeen} .. ${x.lastSeen}`);
  const ids = localIdsOf(list);
  const un = leads.filter((x) => !x.localSessionId);
  if (ids.length) lines.push(`${MESSAGE_LINE}${ids.join(' ')}`);
  if (un.length) lines.push(`No desktop session found for these (message by hand): ${un.map((x) => `${x.sessionId} (cwd ${x.cwd || '?'})`).join('; ')}`);
  return lines.join('\n');
}

// ---- the local messages owed after a clear ----
// Set by the PostToolUse hook on the clear (or the prompt that lifts the hold) for the session that ran it; the Stop hook reads it.
// { [sessionId]: { ids[], offset (transcript size when set), blocked } }
export function notePendingMessages(sessionId, transcriptPath, ids, at = now()) {
  try {
    if (!sessionId || !ids || !ids.length) return false;
    let offset = 0; try { offset = statSync(transcriptPath).size; } catch { /* no transcript: scan from 0 */ }
    return locked(paths().messagePending, () => {
      const f = readJson(paths().messagePending) || {};
      f[sessionId] = { ids: [...new Set(ids)], offset, blocked: false, at: iso(at) };
      return writeJson(paths().messagePending, f);
    });
  } catch { return false; }
}
export const readPendingMessages = (sessionId) => { const f = readJson(paths().messagePending); return f && f[sessionId] ? f[sessionId] : null; };
export function settlePendingMessages(sessionId, patch) {
  try {
    return locked(paths().messagePending, () => {
      const f = readJson(paths().messagePending) || {};
      if (!f[sessionId]) return false;
      if (patch === null) delete f[sessionId]; else f[sessionId] = { ...f[sessionId], ...patch };
      return writeJson(paths().messagePending, f);
    });
  } catch { return false; }
}

// The lift records who is owed a message (owed: ids = desktop ids of the leads, unmapped = leads with no desktop id, claimedBy = the lead that
// was told to send them). Every path that lifts a hold goes through clear(), so the tick and a confirmed prompt record it like the CLI does.
function markHoldCleared(at, by, list = []) {
  locked(paths().heldSessions, () => {
    const f = readHeld();
    if (!f || f.clearedAt) return;
    const leads = list.filter((x) => !x.agentId);
    const owed = { ids: localIdsOf(list), unmapped: leads.filter((x) => !x.localSessionId).map((x) => ({ sessionId: x.sessionId, cwd: x.cwd || null })), claimedBy: null };
    writeJson(paths().heldSessions, { ...f, clearedAt: iso(at), clearedBy: by, owed });
  });
}

// The lead that claims the owed messages (a lead's next prompt, or the Bash hook that saw the CLI clear) is told to send them. Once only.
// Returns { ids (minus the claimant's own), unmapped } or null (nothing owed, already claimed, still held, or older than OWED_TTL_MS).
export const OWED_TTL_MS = 12 * 3600e3;
export function takeOwedMessages(sessionId, at = now()) {
  try {
    if (!sessionId || isHoldActive()) return null;
    return locked(paths().heldSessions, () => {
      const f = readHeld();
      const o = f && f.clearedAt && f.owed;
      if (!o || o.claimedBy) return null;
      if (at - Date.parse(f.clearedAt) > OWED_TTL_MS) return null;
      if (!writeJson(paths().heldSessions, { ...f, owed: { ...o, claimedBy: String(sessionId), claimedAt: iso(at) } })) return null;
      return { ids: withoutSelf(Array.isArray(o.ids) ? o.ids : [], sessionId), unmapped: (Array.isArray(o.unmapped) ? o.unmapped : []).filter((x) => x.sessionId !== sessionId) };
    });
  } catch { return null; }
}

// The sessions still owed a message after a clear nobody has claimed (for `release-watch.mjs held`); [] when none.
export function owedSessions(at = now()) {
  try {
    if (isHoldActive()) return [];
    const f = readHeld();
    return f && f.clearedAt && f.owed && !f.owed.claimedBy && at - Date.parse(f.clearedAt) <= OWED_TTL_MS ? f.sessions : [];
  } catch { return []; }
}

// The text a lead gets when it claims the owed messages: the send instruction for mapped leads, and the unmapped leads by Claude Code
// session id (each still sees the cleared notice on its next prompt). '' when nothing is owed.
export function owedText(o) {
  if (!o) return '';
  const parts = [];
  if (o.ids.length) parts.push(clearInstruction(o.ids));
  if (o.unmapped.length) parts.push(`These held leads have no desktop session to message (message by hand; each still sees the cleared notice on its next prompt): ${o.unmapped.map((x) => `${x.sessionId} (cwd ${x.cwd || '?'})`).join('; ')}.`);
  return parts.join(' ');
}

// Mark a session as already told (the one whose prompt lifted the hold sees the lift line instead).
export function markNoticed(sessionId, at = now()) {
  try {
    if (!sessionId) return false;
    return locked(paths().heldSessions, () => {
      const f = readHeld();
      if (!f || !f.clearedAt) return false;
      return writeJson(paths().heldSessions, { ...f, noticed: { ...(f.noticed || {}), [sessionId]: iso(at) } });
    });
  } catch { return false; }
}

// After a clear: once per recorded lead session, the line telling it to resume. null for any other session, a second call, or while held.
export function clearedNotice(sessionId, at = now()) {
  try {
    if (!sessionId || isHoldActive()) return null;
    const f = readHeld();
    if (!f || !f.clearedAt) return null;
    if (!f.sessions.some((x) => x.sessionId === sessionId && !x.agentId)) return null;
    if (f.noticed && f.noticed[sessionId]) return null;
    if (!markNoticed(sessionId, at)) return null; // not marked: never repeat
    return `[agent-companion] The post-release hold was cleared at ${f.clearedAt} by the operator. Resume from your handoff or where you stopped.`;
  } catch { return null; }
}

// What a held session is told to do. lead: stop and wait for the local message sent at the clear; subagent: write the handoff and stop; unknown caller: nothing extra.
export function holdWaitText(kind) {
  if (kind === 'lead') return ' Stop and wait: end your turn now. A local message arrives in this session when the hold clears; do not poll.';
  if (kind === 'subagent') return ' Write your handoff and stop; your lead resumes you after the clear.';
  return '';
}
const kindOf = (p) => (p && typeof p === 'object' ? (p.agent_id ? 'subagent' : 'lead') : null);

// ---- standing health line ----
// One line per day, only when the daily standing look has findings; the day it was shown is stored in the standing file (shownOn).
// The caller asks only when the session is attended. Reports only: no flag, no hold.
export function standingLine({ at = now() } = {}) {
  try {
    const f = readJson(paths().standing);
    if (!f || f.verdict !== 'findings' || !Array.isArray(f.findings) || !f.findings.length) return null;
    const day = iso(at).slice(0, 10);
    if (f.shownOn === day) return null;
    writeJson(paths().standing, { ...f, shownOn: day });
    return `[agent-companion] Standing health ${day}: ${f.findings.length} finding(s): ${f.findings.map((x) => x.detail || x.name).join('; ')}. Reported only; it starts no hold. Details: release-watch.mjs status.`;
  } catch { return null; }
}

// ---- the release owner ----
// Who installed the release is the one session that ran `claude plugin install|update agent-companion` (hooks/hold-message.mjs notes it
// after that Bash call). Without that record (an auto-update, an install outside a session) there is no owner and every lead gets the
// notice at once, as before. A known, live owner gets the notice first; other leads only after OWNER_GRACE_MS.
export const INSTALL_CMD_RE = /\bplugin\s+(?:install|update)\s+["']?agent-companion\b/;
export const OWNER_GRACE_MS = 20 * 60e3;
export const OWNER_LIVE_MS = 2 * 3600e3;
export function noteInstaller(sessionId, transcriptPath = null, at = now()) {
  try {
    if (!sessionId) return false;
    return writeJson(paths().owner, { session: String(sessionId), at: iso(at), transcriptPath: transcriptPath || null });
  } catch { return false; }
}
// The owner of the newest install: the recorded installer when it acted within minutes of that install and its transcript is live.
export function releaseOwner(at = now()) {
  try {
    const o = readJson(paths().owner);
    const oa = o && Date.parse(o.at);
    if (!o || !o.session || !(oa > 0) || !o.transcriptPath) return null;
    const rs = readJson(paths().run);
    const rel = rs && Array.isArray(rs.releases) && rs.releases.length ? rs.releases[rs.releases.length - 1] : null;
    const T = rel && Number(rel.T);
    if (T > 0 && !(oa >= T - 5 * 60e3 && oa <= T + 30 * 60e3)) return null; // it noted an older install
    return at - statSync(o.transcriptPath).mtimeMs <= OWNER_LIVE_MS ? { session: o.session, at: o.at } : null;
  } catch { return null; }
}
// True when this session may be shown the open flag now.
export function mayShowFlag(f, sessionId, at = now()) {
  try {
    if (!sessionId) return true;
    const o = releaseOwner(at);
    if (!o || o.session === sessionId) return true;
    const opened = Date.parse(f && f.openedAt);
    return !(opened > 0) || at - opened >= OWNER_GRACE_MS;
  } catch { return true; }
}

// ---- the line shown to lead sessions ----
// Open and unanswered flag: tell the lead to push-notify the operator at once and relay the answer.
// Held: say so and how to lift it. Open and answered: silence. Returns null when there is nothing to say.
export function flagLine({ at = now(), sessionId = null } = {}) {
  try {
    if (isHoldActive()) {
      const h = readHold();
      if (holdScope() !== 'all') return scopedHoldNotice(h, sessionId, at);
      const held = new Set((Array.isArray(h.flags) ? h.flags : []).map((x) => x && x.name));
      const ff = readFlag();
      const later = flagIsOpen(ff) ? ff.flags.filter((x) => x && x.name && !held.has(x.name)) : [];
      const laterTxt = later.length ? ` Later checks also flagged: ${later.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ')}.` : '';
      return `[agent-companion] RELEASE HOLD since ${h.since}: ${h.reason}. New agents and heavy jobs are blocked and running workers hand off. Tell the operator now.${laterTxt} Only the operator lifts it, by saying "clear hold"; run \`node <plugin>/scripts/release-watch.mjs clear --by operator\` only after they have said so.${holdWaitText('lead')}`;
    }
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    if (!mayShowFlag(f, sessionId, at)) return null; // the release owner sees it first
    const names = f.flags.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ');
    let when = '';
    if (holdable(f.flags).length) {
      const d = Number(opt('release_watch_hold_minutes', 30));
      if (d > 0) {
        const n = Date.parse(f.notifiedAt); const start = n > 0 ? n : at; // never shown yet: this showing starts the countdown
        const left = Math.max(0, Math.ceil((start + d * 60e3 - at) / 60e3));
        when = `Hold countdown: ${left} min left; unanswered, ${holdScope() === 'all' ? 'new agents and heavy jobs' : 'agent-companion release and install actions'} are held at ${iso(start + d * 60e3)} (options release_watch_hold_minutes, release_watch_hold_scope). `;
      }
    }
    return `[agent-companion] RELEASE WATCH ${f.version || ''} check ${f.check ?? '?'}: ${names}. Push-notify the operator at once (PushNotification) and relay their answer. The flag is acknowledged only when the operator says so ("ack", "keep it", "no rollback"); a question or a request for analysis leaves it open and the countdown running. ${when || (holdable(f.flags).length ? `Unanswered, ${holdScope() === 'all' ? 'new agents and heavy jobs' : 'agent-companion release and install actions'} are held after the delay (option release_watch_hold_minutes); ` : (f.flags.some((x) => x && !NO_HOLD_FLAGS.has(x.name)) ? 'This flag is below the hold floor (options release_watch_hold_min_events, release_watch_hold_min_n): it notifies but never holds; ' : 'This flag never starts a hold; '))}run \`node <plugin>/scripts/release-watch.mjs status\` for detail.`;
  } catch { return null; }
}

// ---- the hold as seen by the guards ----
// One message for every guard that refuses work while held. null when no hold (or on any read error: fail open).
export function holdDenyMessage(what = 'new work', p = null) {
  try {
    if (!isHoldActive() || holdScope() !== 'all') return null; // releases scope: only release and install commands are refused (releaseActionDeny)
    noteHeld(p);
    const h = readHold() || {};
    const names = Array.isArray(h.flags) && h.flags.length ? h.flags.map((x) => x && x.name).filter(Boolean).join(', ') : 'unspecified';
    return `[agent-companion] A post-release hold is on since ${h.since || '?'} (release ${h.version || '?'}; flags: ${names}), so ${what} is refused. `
      + 'Tell the operator at once. Only the operator lifts it, by saying "clear hold"; do not try to lift it yourself. The lead may still answer the operator; leases already granted keep running.'
      + holdWaitText(kindOf(p));
  } catch { return null; }
}

// ---- hold scope 'releases' ----
// One notice per session while such a hold is on (a stamp file keyed by the hold's start). null for every later call.
function scopedHoldNotice(h, sessionId, at) {
  try {
    const text = `[agent-companion] RELEASE HOLD since ${h.since}: ${h.reason}. Scope "releases" (option release_watch_hold_scope): only agent-companion release and install actions are refused (plugin install or update, plugin marketplace update, pushes or merges to release/* branches); all other work, agents and heavy jobs continue. Tell the operator once. Only the operator lifts it, by saying "clear hold".`;
    if (!sessionId) return text;
    const shown = locked(paths().scopeNotice, () => {
      let f = readJson(paths().scopeNotice);
      if (!f || f.holdSince !== h.since) f = { holdSince: h.since, sessions: {} };
      if (f.sessions[sessionId]) return true;
      f.sessions[sessionId] = iso(at);
      writeJson(paths().scopeNotice, f);
      return false;
    });
    return shown === true ? null : text;
  } catch { return null; }
}
// A Bash/PowerShell command that releases or installs agent-companion: a plugin install/update, a marketplace update, a push to a release/*
// branch, a merge of one (git merge, or gh pr merge of a PR whose head is one), or a PR create naming one. Only these are refused in scope 'releases'.
// One more refusal is kept on purpose: ANY `gh pr merge` that names agent-templates or agent-companion is refused with no lookup, because a
// merge to that repo's main reaches every user through marketplace auto-update, which this hold cannot otherwise stop.
//
// 0.31.77 RULE (read before editing). The command is matched on its real words, never on its text, and anything that cannot be parsed
// with confidence is REFUSED: a false deny costs one retry, a bypass ships a release past the hold.
//  1. commandSegments() splits into segments (; | & && newline, parentheses) and words. Quoted text is ONE word (so an echoed line, a
//     commit message or a PR body never matches). `#` at a word start is a comment to end of line (an apostrophe in it opens nothing).
//     Heredoc and PowerShell here-string bodies are dropped, UNLESS a shell reads them (`bash <<EOF`, `cat <<EOF | bash`): then the body
//     is parsed as commands. `$(...)` and backticks are real commands even inside double quotes: their bodies are parsed too.
//  2. Backslash and backtick mean different things in Bash and PowerShell, so every text is parsed in BOTH modes and refused if either
//     says release (a PowerShell path ending in \" closes its string in PowerShell and not in Bash).
//  3. Wrappers (timeout, xargs, sudo, env, watch, stdbuf, nice ...) take flags and values we cannot tell apart from the command, so the
//     words after a wrapper are tried as a command from every position, up to the first echo/printf-like word.
//  4. A shell -c / -Command / /c / eval / iex argument is a real command and is parsed again (3 levels; deeper, or -EncodedCommand, is
//     refused as unparseable). cmd /c and pwsh -Command take the REST of the line. `bash <<< "text"` and `text | bash|sh|pwsh|iex`
//     parse the text (and, for xargs, the piped words are appended to its command).
//  5. `gh pr merge` looks the PR head up with `gh pr view` in the directory the command will run in (a `cd X &&`, `Set-Location X;` or
//     `pushd` before it, `-R`/`--repo`, GH_REPO, a PR URL). A cd that cannot be resolved with no repo named means the repo is unknown: refused.
//     All lookups in one hook call share one time budget (PR_LOOKUP_MS); once spent, the remaining merges are refused without a spawn.
export const PR_LOOKUP_MS = 2500; // total for every `gh pr view` in one hook call, inside the pre hook's 5 s timeout with margin
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression']);
const SHELL_CMDS = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|eval|iex|invoke-expression)$/;
const PREFIX_WORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const WRAPPERS = new Set(['sudo', 'doas', 'timeout', 'xargs', 'parallel', 'watch', 'stdbuf', 'nice', 'ionice', 'setsid', 'nohup', 'time', 'env', 'command', 'builtin', 'exec', 'call', 'start', 'start-process', 'start-job', 'invoke-command', 'runas', 'chroot', 'unbuffer']);
const PRINT_CMDS = new Set(['echo', 'printf', 'write-host', 'write-output', 'write-error', 'write-warning', 'cat', 'type', 'print']);
const binName = (x) => String(x).replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
const skipPrefix = (words) => { let i = 0; while (i < words.length && (PREFIX_WORDS.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) i++; return words.slice(i); };
// Does this segment feed its stdin (or its heredoc) to a shell?
const isSink = (words) => {
  const w = skipPrefix(words); if (!w.length) return false;
  const c = binName(w[0]);
  return SHELL_NAMES.has(c) || (WRAPPERS.has(c) && w.slice(1).some((x) => SHELL_NAMES.has(binName(x))));
};
const findBacktick = (s, from) => { for (let k = from; k < s.length; k++) { if (s[k] === '\\') { k++; continue; } if (s[k] === '`') return k; } return s.length; };

// ps: PowerShell reading (backslash is a plain character, backtick escapes) instead of Bash (backslash escapes, backtick substitutes).
// The returned segments carry: .pipe (followed by a single |), .sub (found inside a substitution or a shell-read heredoc), .pd (parenthesis depth).
export function commandSegments(cmd, ps = false) {
  const out = [];
  scan(String(cmd ?? ''), 0, false, ps, out, false);
  return out;
}
function scan(s, start, nested, ps, out, sub) {
  const n = s.length; let i = start; let words = []; let w = null; let depth = 0; let lineShell = false; const pend = [];
  const endWord = () => { if (w !== null) { words.push(w); w = null; } };
  const endSeg = (pipe) => {
    endWord();
    if (words.length) { if (isSink(words)) lineShell = true; words.pipe = !!pipe; words.sub = sub; words.pd = depth; out.push(words); }
    words = [];
  };
  while (i < n) {
    const c = s[i];
    if (nested && c === ')' && depth === 0) { endSeg(); return i + 1; }
    if (c === "'") { const j = s.indexOf("'", i + 1); const e = j < 0 ? n : j; w = (w ?? '') + s.slice(i + 1, e); i = e + 1; continue; }
    if (c === '"') {
      let j = i + 1; let buf = '';
      while (j < n && s[j] !== '"') {
        const d = s[j];
        if (!ps && d === '\\' && j + 1 < n && '"\\`$'.includes(s[j + 1])) { buf += s[j + 1]; j += 2; }
        else if (ps && d === '`' && j + 1 < n) { buf += s[j + 1]; j += 2; }
        else if (d === '$' && s[j + 1] === '(') { j = scan(s, j + 2, true, ps, out, true); buf += '$()'; }
        else if (!ps && d === '`') { const e = findBacktick(s, j + 1); scan(s.slice(j + 1, e).replace(/\\([`\\$])/g, '$1'), 0, false, ps, out, true); buf += '``'; j = e + 1; }
        else { buf += d; j++; }
      }
      w = (w ?? '') + buf; i = j + 1; continue;
    }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2))) { // PowerShell here-string: the body is text
      const k = s.indexOf(`\n${s[i + 1]}@`, i + 2); i = k < 0 ? n : k + 3; w = (w ?? '') + 'x'; continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<-?[ \t]*(["']?)([A-Za-z_][\w.-]*)\1/.exec(s.slice(i));
      if (m) { pend.push(m[2]); i += m[0].length; continue; }
    }
    if (c === '\n') {
      endSeg(); i++;
      for (const d of pend.splice(0)) {
        const from = i; let found = false;
        while (i < n) { let e = s.indexOf('\n', i); if (e < 0) e = n; const line = s.slice(i, e).trim(); const at = i; i = e + 1; if (line === d) { found = true; if (lineShell) scan(s.slice(from, at), 0, false, ps, out, true); break; } }
        if (!found && lineShell) scan(s.slice(from), 0, false, ps, out, true); // unterminated: the shell reads to the end
      }
      lineShell = false;
      continue;
    }
    if (c === '#' && w === null) { while (i < n && s[i] !== '\n') i++; continue; } // a comment, outside quotes, to end of line
    if (c === '|') { if (s[i + 1] === '|') { endSeg(); i += 2; } else { endSeg(true); i += s[i + 1] === '&' ? 2 : 1; } continue; }
    if (c === '(') { endSeg(); depth++; i++; continue; }
    if (c === ')') { endSeg(); if (depth > 0) depth--; i++; continue; }
    if (c === ';' || c === '&') { endSeg(); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '{' && w === null && words.length === 0 && i + 1 < n && !/[\s,}]/.test(s[i + 1])) { i++; continue; } // `{git push}`: a group opener glued to the command
    if (c === '\\' && !ps && i + 1 < n) { // Bash: a backslash escapes the next character; backslash-newline is a continuation
      if (s[i + 1] === '\n') { i += 2; continue; }
      if (s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
      w = (w ?? '') + s[i + 1]; i += 2; continue;
    }
    if (c === '`') {
      if (!ps) { endSeg(); i++; continue; } // Bash: a command substitution delimiter
      if (i + 1 < n && (s[i + 1] === '\n' || s[i + 1] === '\r')) { endWord(); i += s[i + 1] === '\r' && s[i + 2] === '\n' ? 3 : 2; continue; }
      if (i + 1 < n) { w = (w ?? '') + s[i + 1]; i += 2; continue; }
      i++; continue;
    }
    w = (w ?? '') + c; i++;
  }
  endSeg();
  return n;
}
// Words that are the value of a text flag (commit message, PR title or body): never a branch name.
const TEXT_FLAGS = new Set(['-m', '--message', '-F', '--file', '-b', '--body', '-t', '--title', '--subject', '--body-file']);
const dropTextValues = (args) => { const o = []; for (let k = 0; k < args.length; k++) { if (TEXT_FLAGS.has(args[k])) { k++; continue; } if (/^--(?:message|body|title|subject)=/.test(args[k])) continue; o.push(args[k]); } return o; };
// The head branch of a PR: only ever called for `gh pr merge` during a hold; null when it cannot be read (timeout, no gh, no network, unknown PR).
// AGENT_COMPANION_GH_BIN replaces `gh` (a .mjs file is run with node): the tests' stand-in, so no test touches the network.
// o.cwd: the directory the command will run in; o.timeoutMs: what is left of the shared budget.
export function prHeadLookup(pr, repo, o = {}) {
  try {
    const { spawnSync } = createRequire(import.meta.url)('node:child_process');
    const bin = process.env.AGENT_COMPANION_GH_BIN || 'gh';
    const a = ['pr', 'view', ...(pr ? [pr] : []), ...(repo ? ['--repo', repo] : []), '--json', 'headRefName', '-q', '.headRefName'];
    const js = /\.m?js$/.test(bin);
    const timeout = Math.max(50, Math.min(Number(o.timeoutMs) || PR_LOOKUP_MS, PR_LOOKUP_MS));
    const r = spawnSync(js ? process.execPath : bin, js ? [bin, ...a] : a, { encoding: 'utf8', timeout, windowsHide: true, ...(o.cwd ? { cwd: o.cwd } : {}) });
    const h = r.status === 0 ? String(r.stdout || '').trim() : '';
    return h || null;
  } catch { return null; }
}
// One budget for every lookup in one hook call; the same PR in the same place is looked up once.
function budgeted(lookup) {
  const t0 = Date.now(); const seen = new Map();
  return (pr, repo, ctx) => {
    const url = !!pr && /^https?:\/\//i.test(pr);
    if (!repo && !url && ctx && ctx.cwd === false) return null; // the directory is unknown, so the repo is
    const key = `${pr}|${repo}|${url || repo ? '' : ctx && ctx.cwd || ''}`;
    if (seen.has(key)) return seen.get(key);
    const left = PR_LOOKUP_MS - (Date.now() - t0);
    if (left < 100) return null; // budget spent: not looked up, so refused
    const h = lookup(pr, repo, { cwd: ctx && ctx.cwd || undefined, timeoutMs: left });
    seen.set(key, h); return h;
  };
}
const toPath = (d) => (process.platform === 'win32' ? String(d).replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : String(d));
// cd / pushd / Set-Location: the new directory, false when it cannot be worked out, undefined when the segment is not one.
function cdTarget(seg, cwd) {
  const w = skipPrefix(seg); if (!w.length) return undefined;
  const c = binName(w[0]);
  if (!/^(?:cd|pushd|chdir|set-location|sl|popd)$/.test(c)) return undefined;
  if (c === 'popd' || cwd === false) return false;
  let t = null;
  for (let k = 1; k < w.length; k++) { if (/^\/d$/i.test(w[k])) continue; if (/^-(?:path|literalpath|p)$/i.test(w[k])) { t = w[k + 1]; break; } if (w[k].startsWith('-') && w[k] !== '-') continue; t = w[k]; break; }
  if (!t || /[$%`*?]|^~|^-$/.test(t)) return false;
  return resolvePath(cwd || process.cwd(), toPath(t));
}
// 'release' | 'unverified' (a gh pr merge whose head could not be looked up) | 'opaque' (cannot be parsed) | null.
function wordsKind(words, lookup, depth, ctx, extra = []) {
  let env = null;
  let i = 0;
  while (i < words.length && (PREFIX_WORDS.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) { const m = /^GH_REPO=(.+)$/.exec(words[i]); if (m) env = m[1]; i++; }
  const w = words.slice(i);
  if (w.length && w[0].length > 1) w[0] = w[0].replace(/^\{+/, '') || w[0]; // `{git`
  if (!w.length) return null;
  const c = binName(w[0]);
  if (WRAPPERS.has(c)) {
    let kind = null;
    const more = /^(?:xargs|parallel)$/.test(c) ? extra : [];
    for (let j = 1; j < w.length && j < 14; j++) {
      const r = wordsKind(w.slice(j).concat(more), lookup, depth, ctx, []);
      if (r === 'release') return r;
      kind = kind || r;
      if (PRINT_CMDS.has(binName(w[j]))) break;
    }
    return kind;
  }
  if (SHELL_CMDS.test(c)) {
    if (depth >= 3) return 'opaque';
    let inner = null;
    if (c === 'eval' || c === 'iex' || c === 'invoke-expression') inner = w.slice(1).join(' ');
    else if (c === 'cmd') { const k = w.findIndex((x, j) => j > 0 && /^\/[ck]$/i.test(x)); if (k > 0) inner = w.slice(k + 1).join(' '); }
    else if (c === 'pwsh' || c === 'powershell') {
      if (w.some((x, j) => j > 0 && /^-e(?:c|nc\w*)?$/i.test(x))) return 'opaque'; // -EncodedCommand: base64, unreadable
      const k = w.findIndex((x, j) => j > 0 && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(x)); if (k > 0) inner = w.slice(k + 1).join(' ');
    } else { const k = w.findIndex((x, j) => j > 0 && /^-[A-Za-z]*c$/.test(x)); if (k > 0) inner = w[k + 1]; }
    if (inner == null) { const h = w.indexOf('<<<'); if (h > 0) inner = w[h + 1]; }
    return inner ? textKind(inner, lookup, depth + 1, ctx) : null;
  }
  if (PRINT_CMDS.has(c)) return null;
  for (let j = 0; j < w.length; j++) {
    if (w[j] !== 'plugin') continue;
    if (/^(?:install|update)$/.test(w[j + 1] || '') && /^agent-companion\b/.test(w[j + 2] || '')) return 'release';
    if (w[j + 1] === 'marketplace' && w[j + 2] === 'update') return 'release';
  }
  if (c === 'git') {
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) k += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(w[k]) ? 2 : 1;
    const sub = w[k]; const args = dropTextValues(w.slice(k + 1));
    if (sub === 'push' && args.some((a) => /\brelease\//.test(a))) return 'release';
    if (sub === 'merge' && args.some((a) => /^(?:[\w.-]+\/)*release\/\S+$/.test(a))) return 'release';
    return null;
  }
  if (c === 'gh' && w[1] === 'pr' && (w[2] === 'merge' || w[2] === 'create')) {
    const raw = w.slice(3); const args = dropTextValues(raw);
    if (args.some((a) => /\brelease\//.test(a))) return 'release';
    if (w[2] !== 'merge') return null;
    // Kept on purpose (see the rule above): a merge naming this repo is refused with no lookup.
    if (args.some((a) => /\b(?:agent-templates|agent-companion)\b/.test(a)) || (env && /\b(?:agent-templates|agent-companion)\b/.test(env))) return 'release';
    let pr = null; let repo = env;
    for (let k = 0; k < raw.length; k++) {
      if (/^(?:-R|--repo)$/.test(raw[k])) { repo = raw[++k] || null; continue; }
      if (TEXT_FLAGS.has(raw[k]) || /^(?:--match-head-commit|-A|--author-email)$/.test(raw[k])) { k++; continue; }
      if (raw[k].startsWith('--repo=')) { repo = raw[k].slice(7); continue; }
      if (!raw[k].startsWith('-') && pr == null) pr = raw[k];
    }
    // Fail closed: a merge whose head cannot be read is refused. gh pr merge needs the same network, so an offline refusal costs nothing real,
    // while letting it through would let a release merge past the hold whenever the lookup fails. Only during a hold, only this command.
    const head = lookup(pr, repo, ctx);
    return head == null ? 'unverified' : /^release\//.test(head) ? 'release' : null;
  }
  return null;
}
const feedTexts = (feed) => { const o = []; for (const seg of feed) { o.push(...seg); const s = skipPrefix(seg); if (s.length > 1 && PRINT_CMDS.has(binName(s[0]))) o.push(s.slice(1).join(' ')); } return o; };
function segsKind(segs, lookup, depth, ctx) {
  let kind = null; let feed = []; let prevPipe = false; const stack = [];
  for (const seg of segs) {
    if (!seg.sub) {
      while (stack.length > (seg.pd || 0)) ctx.cwd = stack.pop();
      while (stack.length < (seg.pd || 0)) stack.push(ctx.cwd);
      if (!prevPipe) feed = [];
    }
    let r = null;
    const cd = cdTarget(seg, ctx.cwd);
    if (cd !== undefined) ctx.cwd = cd;
    else {
      if (feed.length && isSink(seg)) {
        if (depth >= 3) r = 'opaque';
        else for (const t of feedTexts(feed)) { const k = textKind(t, lookup, depth + 1, ctx); if (k === 'release') { r = k; break; } r = r || k; }
      }
      if (r !== 'release') { const k = wordsKind(seg, lookup, depth, ctx, feedTexts(feed)); r = k === 'release' ? k : (k || r); }
    }
    if (r === 'release') return r;
    kind = kind || r;
    if (!seg.sub) { prevPipe = !!seg.pipe; if (seg.pipe) feed.push(seg); }
  }
  return kind;
}
function textKind(text, lookup, depth, ctx, only = null) {
  let kind = null;
  for (const ps of only ? [only === 'ps'] : /[\\`]/.test(text) ? [false, true] : [false]) {
    const r = segsKind(commandSegments(text, ps), lookup, depth, { cwd: ctx.cwd });
    if (r === 'release') return r;
    kind = kind || r;
  }
  return kind;
}
export function releaseActionKind(cmd, lookup = prHeadLookup, opts = {}) {
  // opts.shell 'bash' | 'ps': the tool that runs the command (its own reading only); absent: both readings.
  return textKind(String(cmd ?? ''), budgeted(lookup), 0, { cwd: opts.cwd || null }, opts.shell || null);
}
export function isReleaseAction(cmd, lookup = prHeadLookup) { return releaseActionKind(cmd, lookup) != null; }
// The deny text for a release/install command while a hold in scope 'releases' is on; null otherwise (fails open, except the one
// documented fail-closed case above).
export function releaseActionDeny(cmd, lookup = prHeadLookup, opts = {}) {
  try {
    if (!isHoldActive() || holdScope() !== 'releases') return null;
    const kind = releaseActionKind(cmd, lookup, opts);
    if (!kind) return null;
    const h = readHold() || {};
    const names = Array.isArray(h.flags) && h.flags.length ? h.flags.map((x) => x && x.name).filter(Boolean).join(', ') : 'unspecified';
    const why = kind === 'opaque' ? ' (part of it could not be parsed with confidence, so it is treated as a release command)' : kind === 'unverified' ? ' (the head branch of that PR could not be looked up in time, so it is treated as a release merge)' : '';
    return `[agent-companion] A post-release hold is on since ${h.since || '?'} (release ${h.version || '?'}; flags: ${names}), so this agent-companion release or install command is refused${why}. All other work continues. Tell the operator at once. Only the operator lifts it, by saying "clear hold"; do not try to lift it yourself.`;
  } catch { return null; }
}

// ---- the lead's instruction after a clear ----
export function clearInstruction(ids) {
  return `[agent-companion] The hold is cleared. ${MESSAGE_LINE}${ids.join(' ')}. Send each one SendMessage {to: "<id>"} or mcp__ccd_session_mgmt__send_message {session_id: "<id>"} saying the hold is cleared and it should resume from its handoff. A stopped session never sees another prompt, so this message is how it wakes; your turn is blocked once if any of them is missing.`;
}

// The ids minus the session that ran the clear (it needs no message to itself).
export function withoutSelf(ids, sessionId) {
  const own = desktopSessionMap().get(sessionId);
  return own ? ids.filter((x) => x !== own) : ids;
}
