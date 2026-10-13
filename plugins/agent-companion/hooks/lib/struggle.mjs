// Struggle detector: scores each operator prompt for corrections and repeats,
// and says when 2 of the last 6 prompts scored 2 or more. Pure text work, no
// model call, no child process. The hook (hooks/struggle-detector.mjs) owns
// the I/O; everything here is exported so tests can drive it directly.
//
// The shipped patterns are the generic set: written without reading any
// labelled data. Extra patterns come from the user-scope file
// <config>/struggle-patterns.json (example: config/struggle-patterns.example.json).
import { createHash } from 'node:crypto';
import { isCrossSessionMessage } from './cross-session.mjs';
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { classifyEffort, configDir, stateDir } from './context.mjs';

export const WINDOW = 6;        // prompts looked at
export const MIN_FLAGGED = 2;   // flagged prompts in the window that fire
export const FLAG_SCORE = 2;    // a prompt this score or higher is flagged
export const COOLDOWN = 6;      // prompts after a fire before the next one
export const MAX_FIRES = 2;     // per session
const MAX_SENTENCES = 200;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_STATE_FILES = 300;

// Strong corrections (+2).
export const STRONG = [
  /\bnot true\b/i,
  /\bthat'?s not (what|right|it)\b/i,
  /\bis not what\b/i,
  /\bnot what i\b/i,
  /\bi (meant|wanted you to|said|told you|asked you)\b/i,
  /\balready (approved|said|told|answered|decided|have|did)\b/i,
  /\bnot allowed\b/i,
  /\bwhy (are|did|didn'?t|can'?t|would|is) (you|it|we)\b/i,
  /\byou (just )?said\b/i,
  /\byourself\b/i,
  /\bshould just\b/i,
  /\bdoesn'?t (have|need) to\b/i,
  /^\s*no[,.]?\s+(use|a|the|we|it|that|not)\b/i,
  /\bwe should not\b/i,
];

// Weak corrections (+1 for two or more, or one when there is no strong one).
export const WEAK = [
  /\bmake sure\b/i, /\byou need to\b/i, /\bstill\b/i, /\bagain\b/i, /\bdidn'?t\b/i,
  /\bdon'?t see\b/i, /\binstead\b/i, /\bwhat about\b/i, /\bcan we see if\b/i,
  /\balways\b/i, /\bnever\b/i, /\bwe need to\b/i,
];

const LEAD_ASKED = /(\?\s*$|\b(want me to|should i|do you want|shall i|which (one|do you)|or (should|would) (i|you)|approve|ok to)\b)/i;

const STOP = new Set('the a an and or to of in on for is it that this we you i be are with as at by from so if not do our your my me can will just have has was all any'.split(' '));

// --- user patterns ----------------------------------------------------------
export const USER_PATTERN_FILE = 'struggle-patterns.json';
const MAX_USER_PATTERNS = 40;
const MAX_PATTERN_LEN = 200;

// Cheap ReDoS guard: skip a pattern with a quantified group that itself holds a
// quantifier, such as (a+)+ or (.*)* or (a|b*){2,}. The scored text is already
// capped at 1500 characters.
export const NESTED_QUANT = /\([^()]*[+*}][^()]*\)\s*[+*{]|\([^()]*\([^()]*[+*}][^()]*\)[^()]*\)\s*[+*{]/;
function compileList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const src of list.slice(0, MAX_USER_PATTERNS)) {
    if (typeof src !== 'string' || !src || src.length > MAX_PATTERN_LEN || NESTED_QUANT.test(src)) continue;
    try { out.push(new RegExp(src, 'i')); } catch { /* bad pattern: skip it */ }
  }
  return out;
}

// { strong: RegExp[], weak: RegExp[] } from the user-scope file; empty when
// the file is absent or unreadable.
export function loadUserPatterns(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir || configDir(), USER_PATTERN_FILE), 'utf8'));
    return { strong: compileList(j && j.strong), weak: compileList(j && j.weak) };
  } catch {
    return { strong: [], weak: [] };
  }
}

// --- scoring ----------------------------------------------------------------
// Stems are stored as short hashes, so the state file holds no readable words; the repeat
// check only needs set intersection.
const stemHash = (w) => createHash('sha256').update(w).digest('hex').slice(0, 6);
const stems = (t) => new Set((String(t).toLowerCase().match(/[a-z][a-z']{2,}/g) || [])
  .filter((w) => !STOP.has(w)).map((w) => stemHash(w.slice(0, 5))));
// Sentences of 4-20 content words, as stem arrays.
export function sentenceStems(text) {
  return String(text).split(/[.!?\n]+/).map(stems).filter((w) => w.size >= 4 && w.size <= 20).map((w) => [...w]);
}
function repeatOf(mine, earlier) {
  return mine.some((a) => earlier.some((b) => {
    const bs = new Set(b);
    let n = 0;
    for (const w of a) if (bs.has(w)) n++;
    return n >= 4 && n / Math.min(a.length, bs.size) >= 0.6;
  }));
}

// Score one prompt. `earlier` is an array of stem arrays from earlier prompts
// of this session; `prevLead` the lead's previous text (may be empty).
export function scorePrompt(text, { prevLead = '', earlier = [], user = { strong: [], weak: [] } } = {}) {
  const raw = String(text || '');
  // task notification, scheduled task, pasted block, or a message from another session
  if (/^\s*</.test(raw) || isCrossSessionMessage(raw)) return { n: 0, skipped: true, sentences: [] };
  const t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, ' ').slice(0, 1500);
  const strong = STRONG.some((r) => r.test(t)) || user.strong.some((r) => r.test(t));
  const weak = WEAK.filter((r) => r.test(t)).length + user.weak.filter((r) => r.test(t)).length;
  const sentences = sentenceStems(t);
  const repeat = sentences.length > 0 && repeatOf(sentences, earlier);
  const leadAsked = LEAD_ASKED.test(String(prevLead).slice(-400));
  let n = 0;
  if (strong) n += 2;
  if (weak >= 2) n += 1; else if (weak === 1 && !strong) n += 1;
  if (repeat) n += 2;
  if (leadAsked && (strong || weak)) n += 1;
  return { n, skipped: false, strong, weak, repeat, leadAsked, sentences };
}

// --- per-session state ------------------------------------------------------
export function emptyState() { return { count: 0, scores: [], fires: [], lastFire: -1, sentences: [] }; }

// Fold one scored prompt into the state and decide whether to fire. Mutates
// `state`. Skipped prompts are not operator prompts and do not enter the
// window. Returns { fire, flagged, window }.
export function step(state, scored) {
  if (scored.skipped) return { fire: false, flagged: 0, window: 0 };
  state.count += 1;
  state.scores.push(scored.n);
  if (state.scores.length > WINDOW) state.scores = state.scores.slice(-WINDOW);
  state.sentences = state.sentences.concat(scored.sentences).slice(-MAX_SENTENCES);
  const flagged = state.scores.filter((s) => s >= FLAG_SCORE).length;
  const sinceFire = state.lastFire < 0 ? Infinity : state.count - state.lastFire;
  const fire = flagged >= MIN_FLAGGED && sinceFire >= COOLDOWN && state.fires.length < MAX_FIRES;
  if (fire) { state.fires.push(state.count); state.lastFire = state.count; }
  return { fire, flagged, window: state.scores.length };
}

const sidFile = (sid) => `${createHash('sha256').update(String(sid)).digest('hex').slice(0, 16)}.json`;
const dirOf = () => join(stateDir(), 'struggle');

export function loadState(sid) {
  try {
    const j = JSON.parse(readFileSync(join(dirOf(), sidFile(sid)), 'utf8'));
    if (j && Array.isArray(j.scores) && Array.isArray(j.fires) && Array.isArray(j.sentences)) return { ...emptyState(), ...j };
  } catch { /* none yet */ }
  return emptyState();
}

export function saveState(sid, state) {
  try {
    const dir = dirOf();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, sidFile(sid));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
    prune(dir);
  } catch { /* fail open */ }
}

function prune(dir) {
  try {
    const now = Date.now();
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return { f, t: statSync(join(dir, f)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    files.forEach((x, i) => {
      if (i >= MAX_STATE_FILES || now - x.t > KEEP_MS) { try { unlinkSync(join(dir, x.f)); } catch { /* ignore */ } }
    });
  } catch { /* fail open */ }
}

// --- inputs read from disk --------------------------------------------------
function tailLines(file, tailBytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally { closeSync(fd); }
}

// The lead's last text, from the tail of the transcript (never the whole file).
export function lastLeadText(transcriptPath, tailBytes = 131072) {
  try {
    if (!transcriptPath) return '';
    const lines = tailLines(transcriptPath, tailBytes);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l || l[0] !== '{') continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r || r.type !== 'assistant') continue;
      const c = r.message && r.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
      if (text.trim()) return text;
    }
  } catch { /* fail open */ }
  return '';
}

// Live lead effort: the payload's effort.level when present, else the last
// lead_effort_live the spawn guard recorded for this session, else null.
export function liveEffort(payload, telemetryFile, sid, tailBytes = 262144) {
  try {
    const lvl = payload && payload.effort && payload.effort.level;
    if (typeof lvl === 'string' && lvl) return lvl.toLowerCase();
  } catch { /* fall through */ }
  try {
    const lines = tailLines(telemetryFile, tailBytes);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('lead_effort_live')) continue;
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r && r.session_id === sid && typeof r.lead_effort_live === 'string' && r.lead_effort_live) return r.lead_effort_live.toLowerCase();
    }
  } catch { /* none */ }
  return null;
}

// --- messages ---------------------------------------------------------------
// Operator-facing (systemMessage). Below xhigh: effort may help. At xhigh or
// above, or unknown: more effort is not the lever.
export function operatorMessage(k, m, effort) {
  const e = effort ? classifyEffort(effort) : null;
  const known = !!(e && e.known);
  const label = known ? e.level : 'unknown';
  const head = `agent-companion: this session needed ${k} corrections in the last ${m} prompts (lead effort: ${label})`;
  if (known && e.rank < classifyEffort('xhigh').rank) {
    return `${head}; raising effort to xhigh may help. If it lacks a fact or a rule, tell it where that lives instead.`;
  }
  return `${head}. More effort is unlikely to help: it may be a missing fact or rule, or a fresh session with a handoff may help.`;
}

// Lead-facing (additionalContext), one line.
export function leadMessage(k, m) {
  return `Struggle signal: ${k} of the last ${m} operator prompts corrected or repeated something. Answer every question asked, re-ask nothing already answered, check your own work before replying, and do not change effort or ask about it.`;
}
