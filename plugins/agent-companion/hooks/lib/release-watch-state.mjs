// State for the post-release watch (scripts/release-watch.mjs), shared with the hooks that show or honour it.
//
// Files, all under <state root>/state/ (fail open on a missing or unparseable file):
//   release-watch-run.json    the schedule for the newest install: T, version, due[], done[], prevT
//   release-watch-flag.json   the open flag: flags[], notifiedAt, ackedAt, clearedAt, cooldown{}
//   release-hold.json         the hold: { since, version, reason, flags, workers, clearedAt }
//   release-watch-checks.jsonl  one row per check and per clear
// AGENT_COMPANION_FAKE_NOW moves the clock for tests. Nothing here throws.

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, renameSync, mkdirSync, openSync, fstatSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir, opt } from './context.mjs';

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
const holdable = (flags) => (Array.isArray(flags) ? flags : []).filter((x) => x && !NO_HOLD_FLAGS.has(x.name));
const levelOf = (f) => (typeof f.level === 'number' ? f.level : typeof f.value === 'number' ? f.value : null);
const answeredFor = (cool, name, T) => { const c = cool[name]; return c && c.T === T ? c : null; };
export function openFlag({ version, T, check, flags, at = now() } = {}) {
  try {
    const old = readFlag();
    const cool = (old && old.cooldown) || {};
    const fresh = (Array.isArray(flags) ? flags : []).filter((f) => {
      if (!f || !f.name) return false;
      const c = answeredFor(cool, f.name, T ?? null);
      if (!c) return true;
      const l = levelOf(f);
      return l != null && typeof c.level === 'number' && c.level > 0 && l > c.level * WORSEN_FACTOR;
    });
    if (!fresh.length) return null;
    const open = flagIsOpen(old);
    const oldByName = new Map(open ? old.flags.map((o) => [o.name, o]) : []);
    // Renotify (restart the countdown) only for a name not already in the open flag, or one that doubled since it was raised.
    // A watch-health flag (NO_HOLD_FLAGS) joining an answered flag never restarts the countdown: it could not hold, and it must not re-open the hold path of the flag already answered.
    const renotify = !open || holdable(fresh).some((f) => { const o = oldByName.get(f.name); const lo = o && levelOf(o); const l = levelOf(f); return !o || (lo > 0 && l > lo * WORSEN_FACTOR); });
    const merged = open ? [...old.flags.filter((o) => !fresh.some((f) => f.name === o.name)), ...fresh] : fresh;
    const next = {
      v: 2,
      version: version ?? old?.version ?? null,
      T: T ?? old?.T ?? null,
      check: check ?? old?.check ?? null,
      flags: merged,
      openedAt: open ? old.openedAt : iso(at),
      notifiedAt: renotify ? iso(at) : old.notifiedAt,
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
  for (const x of f.flags || []) c[x.name] = { level: levelOf(x), T: f.T ?? null, at: iso(at) };
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

// The last 256 KB of a transcript as lines (first partial line dropped). Bounded: never reads a whole transcript.
function defaultTail(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch { return []; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } } }
}

// True when the transcript tail holds a typed (isHumanRecord) prompt with this sha written within [from, to] (epoch ms).
export function matchHumanPrompt(path, sha, from, to, readTail = defaultTail) {
  try {
    if (!path || !sha) return false;
    for (const l of readTail(path) || []) {
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
// record written within withinMs of `near`. Used once, by the v2 flag migration, to tell a legacy ack (a bare reply) from a human one.
// Returns { session, promptAt } or null. Tail reads only; fails closed.
export function findHumanRecordNear({ projectsDir, since = 0, near, withinMs = 2000, maxFiles = 200, readTail = defaultTail } = {}) {
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
    for (const { fp, id } of files.slice(0, maxFiles)) {
      for (const l of readTail(fp) || []) {
        if (!l || !l.includes('"human"')) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (!isHumanRecord(r)) continue;
        const t = Date.parse(r.timestamp);
        if (t > 0 && Math.abs(t - near) <= withinMs) return { session: r.sessionId || id, promptAt: t };
      }
    }
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
    if (shownTo[sessionId]) return false;
    shownTo[sessionId] = iso(at);
    return writeJson(paths().flag, { ...f, shownTo });
  } catch { return false; }
}

// The operator's words that lift a hold: a short prompt saying "clear hold" or "release hold".
export const CLEAR_WORDS_RE = /^(please\s+)?(clear|release)\s+(the\s+)?hold[.!]*$/i;
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
        if (held) { clear({ by: 'prompt', at }); return { signal: HUMAN_SIGNAL.transcript, cleared: true }; }
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
    if (!(delay > 0)) return null;
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || isHoldActive()) return null;
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
  const out = { flagCleared: false, holdCleared: false };
  try {
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
    if (out.flagCleared || out.holdCleared) appendRow({ at: iso(at), event: 'clear', by, ...out });
  } catch { /* fail open */ }
  return out;
}

// ---- the line shown to lead sessions ----
// Open and unanswered flag: tell the lead to push-notify the operator at once and relay the answer.
// Held: say so and how to lift it. Open and answered: silence. Returns null when there is nothing to say.
export function flagLine() {
  try {
    if (isHoldActive()) {
      const h = readHold();
      const held = new Set((Array.isArray(h.flags) ? h.flags : []).map((x) => x && x.name));
      const ff = readFlag();
      const later = flagIsOpen(ff) ? ff.flags.filter((x) => x && x.name && !held.has(x.name)) : [];
      const laterTxt = later.length ? ` Later checks also flagged: ${later.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ')}.` : '';
      return `[agent-companion] RELEASE HOLD since ${h.since}: ${h.reason}. New agents and heavy jobs are blocked and running workers hand off. Tell the operator now.${laterTxt} Only the operator lifts it, by saying "clear hold"; run \`node <plugin>/scripts/release-watch.mjs clear --by operator\` only after they have said so.`;
    }
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    const names = f.flags.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ');
    return `[agent-companion] RELEASE WATCH ${f.version || ''} check ${f.check ?? '?'}: ${names}. Push-notify the operator at once (PushNotification) and relay their answer. ${holdable(f.flags).length ? 'Unanswered, new agents and heavy jobs are held after the delay (option release_watch_hold_minutes); ' : 'This flag never starts a hold; '}run \`node <plugin>/scripts/release-watch.mjs status\` for detail.`;
  } catch { return null; }
}

// ---- the hold as seen by the guards ----
// One message for every guard that refuses work while held. null when no hold (or on any read error: fail open).
export function holdDenyMessage(what = 'new work') {
  try {
    if (!isHoldActive()) return null;
    const h = readHold() || {};
    const names = Array.isArray(h.flags) && h.flags.length ? h.flags.map((x) => x && x.name).filter(Boolean).join(', ') : 'unspecified';
    return `[agent-companion] A post-release hold is on since ${h.since || '?'} (release ${h.version || '?'}; flags: ${names}), so ${what} is refused. `
      + 'Tell the operator at once. Only the operator lifts it, by saying "clear hold"; do not try to lift it yourself. The lead may still answer the operator; leases already granted keep running.';
  } catch { return null; }
}
