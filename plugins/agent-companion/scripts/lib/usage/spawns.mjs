// Usage facts, spawn records (0.31.18 batch 2b).
//
// One spawn = one subagent transcript. The checkup scan (scripts/lib/daily-checkup.mjs)
// feeds one accumulator per spawn while it reads the file once; this module holds the pure
// parts: the request-category classifier, the accumulator, and the finished record.
// No file here reads a transcript or calls a model.
//
// Accumulator (persisted in the scan state under facts.spawns[key]; key = "<session>:<agent>"):
//   { key, sid, aid, proj, tu, type, role, rung, start, partial,
//     rk: { d, n, h },              re-spawn key parts, all hashed: description, name stem, brief head
//     model, mixed,                 the first request's model; mixed = a later request used another
//     t0, t1, n,                    first and last request time (ms), request count
//     cat: { <category>: T },       T = [input, output, cacheWrite5m, cacheWrite1h, cacheRead, requests]
//     cb: [T, T, T, T],             tokens by context bucket: <100K, 100-150K, 150-200K, 200K+
//     peak, first,                  peak context; T of the first request (the startup cost)
//     comp, comp0, pc,              compactions, first compaction time, T of requests after it
//     extra, status,                continued-worker turns; parsed STATUS word (last text) or null
//     cont                          time (ms) of the latest human turn that continued the worker (a parent tool_result older than this no longer closes it)
//     done                          the transcript ends in a final end_turn message (a closing signal, not in the record)
//     runs, runReq, runT, cur }     simple runs: runs of >= 4 requests each with output <= 500
//
// No prompt text and no tool content is stored; only counts, hashes and tokens.

import { createHash } from 'node:crypto';
import { parseStatus } from '../../../hooks/lib/status-line.mjs';

export const SPAWN_OPEN_IDLE_MS = 30 * 60 * 1000; // a spawn with no request this long is closed
export const SPAWN_MAX_OPEN_MS = 48 * 3600 * 1000; // an open spawn is closed this long after its start
export const SIMPLE_OUT_MAX = 500; // a "simple" step: output tokens at most this
export const SIMPLE_RUN_MIN = 4;
export const CTX_EDGES = [100000, 150000, 200000];
export const REQ_BUCKET_EDGES = [6, 16, 41];
export const REQ_BUCKET_LABELS = ['1-5', '6-15', '16-40', '41+'];
export const CATEGORIES = ['read', 'bash-read', 'bash-other', 'test', 'git-write', 'wait', 'edit-small', 'edit-large', 'orchestrate', 'mcp', 'meta', 'text'];

// Highest-precedence category wins when one request carries several tool calls.
const PREC = ['orchestrate', 'mcp', 'edit-large', 'wait', 'test', 'git-write', 'bash-other', 'edit-small', 'bash-read', 'read', 'meta'];

// One tool_use block -> a request category. Ported from the granularity extractor (g-extract.mjs).
export function classTool(b) {
  const n = String((b && b.name) || '');
  const i = (b && b.input) || {};
  if (['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'WebFetch', 'WebSearch'].includes(n)) return 'read';
  if (n === 'Bash' || n === 'PowerShell') {
    const c = String(i.command || '').trim();
    if (/\bsleep\b|gh\s+(run|pr)\s+(watch|checks)|\buntil\b|Start-Sleep|\bwatch\b/.test(c)) return 'wait';
    if (/\bgit(\s+-[Cc]\s+\S+)*\s+(commit|push|add|merge|tag|checkout|switch|stash|rebase|reset|pull|fetch|cherry-pick|worktree)\b|\bgh\s+(pr|release)\s+(create|merge)/.test(c)) return 'git-write';
    if (/\b(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|check|ci)\b|node\s+--test|\bvitest\b|\bjest\b|\bpytest\b|\btsc\b|\beslint\b|\bgradlew\b|\bdotnet\s+(test|build)|\bcargo\s+(test|build|check)/.test(c)) return 'test';
    if (/^(cat|ls|head|tail|grep|rg|find|wc|pwd|echo|stat|du|file|date|which|type)\b/.test(c)
      || /^git(\s+-[Cc]\s+\S+)*\s+(status|diff|log|show|branch|rev-parse|ls-files|remote|config|blame)\b/.test(c)
      || /^cd\s+\S+\s*(&&|;)\s*(ls|cat|git\s+(status|diff|log)|grep|rg|head|tail|find)\b/.test(c)
      || /^(Get-Content|Get-ChildItem|Select-String|Test-Path|Get-Item)/i.test(c)) return 'bash-read';
    return 'bash-other';
  }
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') {
    const l = String(i.new_string || JSON.stringify(i.edits || '') || '').length;
    return l <= 400 ? 'edit-small' : 'edit-large';
  }
  if (n === 'Write') return String(i.content || '').length <= 500 ? 'edit-small' : 'edit-large';
  if (n === 'Agent' || n === 'Task' || n === 'SendMessage' || n === 'TeamCreate') return 'orchestrate';
  if (n.startsWith('mcp__')) return 'mcp';
  return 'meta';
}

// tool_use blocks of one assistant record -> Map(tool_use id -> category)
export function classToolsOf(content) {
  const out = new Map();
  if (!Array.isArray(content)) return out;
  for (const b of content) if (b && b.type === 'tool_use' && b.id) out.set(b.id, classTool(b));
  return out;
}

// The category of one request from the categories of its tool calls ('text' when it has none).
export function requestCategory(cats) {
  const cs = cats ? [...(cats instanceof Map ? cats.values() : cats)] : [];
  if (!cs.length) return 'text';
  return PREC.find((p) => cs.includes(p)) || 'meta';
}

// The visible text of one assistant record's content (text blocks only).
export function assistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

export const statusOf = (text) => parseStatus(text);

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

// The name with its trailing counter or retry word removed: "w-0-31-18-u2" and "w-0-31-18-u2-retry" share a stem.
export function nameStem(name) {
  let s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  for (let k = 0; k < 4; k += 1) {
    const t = s.replace(/[-_.]?(?:\d+|v\d+|retry|redo|fix|again|resume|r\d+|[a-z]\d)$/, '');
    if (t === s || !t) break;
    s = t;
  }
  return s;
}

export const briefHead = (text) => String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

// The re-spawn key parts: description hash, name-stem hash and brief-head hash; null for an absent part.
export function respawnKey({ description, name, brief }) {
  const d = String(description || '').trim();
  const n = nameStem(name);
  const h = briefHead(brief);
  return { d: d ? sha(d) : null, n: n ? sha(n) : null, h: h ? sha(h) : null };
}

export const requestBucket = (n) => {
  let b = 0;
  while (b < REQ_BUCKET_EDGES.length && n >= REQ_BUCKET_EDGES[b]) b += 1;
  return b;
};
export const contextBucket = (ctx) => {
  let b = 0;
  while (b < CTX_EDGES.length && ctx >= CTX_EDGES[b]) b += 1;
  return b;
};

const zero = () => [0, 0, 0, 0, 0, 0];
function tAdd(t, u) {
  const split = (u.cacheWrite5m || 0) + (u.cacheWrite1h || 0) > 0;
  t[0] += u.input || 0;
  t[1] += u.output || 0;
  t[2] += split ? u.cacheWrite5m || 0 : u.cacheWrite || 0;
  t[3] += split ? u.cacheWrite1h || 0 : 0;
  t[4] += u.cacheRead || 0;
  t[5] += 1;
  return t;
}
const tPlus = (a, b) => { for (let i = 0; i < 6; i += 1) a[i] += b[i]; };

export function newSpawn({ key, sid, aid, proj, tu = null, rk = null, rung = null, start = null, partial = false }) {
  return {
    key, sid, aid, proj: proj || null, tu, type: null, role: 'none', rung,
    start, partial, rk: rk || { d: null, n: null, h: null },
    model: null, mixed: false, t0: 0, t1: 0, n: 0,
    cat: {}, cb: [zero(), zero(), zero(), zero()], peak: 0, first: null,
    comp: 0, comp0: 0, pc: zero(), extra: 0, status: null, done: false,
    runs: 0, runReq: 0, runT: zero(), cur: { len: 0, T: zero() },
  };
}

// One counted request, in time order. `usage` is transcripts.mjs's usageOf shape; `ctx` its context tokens.
export function addSpawnRequest(acc, { ts, model, usage, ctx, cats }) {
  if (!acc.model) acc.model = model;
  else if (acc.model !== model) acc.mixed = true;
  if (!acc.t0 || ts < acc.t0) acc.t0 = ts;
  if (ts > acc.t1) acc.t1 = ts;
  acc.n += 1;
  const c = requestCategory(cats);
  tAdd((acc.cat[c] ||= zero()), usage);
  tAdd(acc.cb[contextBucket(ctx)], usage);
  if (ctx > acc.peak) acc.peak = ctx;
  if (!acc.first) acc.first = tAdd(zero(), usage);
  if (acc.comp0 && ts > acc.comp0) tAdd(acc.pc, usage);
  if ((usage.output || 0) <= SIMPLE_OUT_MAX) {
    acc.cur.len += 1;
    tAdd(acc.cur.T, usage);
  } else closeRun(acc);
}

function closeRun(acc) {
  if (acc.cur.len >= SIMPLE_RUN_MIN) {
    acc.runs += 1;
    acc.runReq += acc.cur.len;
    tPlus(acc.runT, acc.cur.T);
  }
  acc.cur = { len: 0, T: zero() };
}

export function noteCompaction(acc, ts) {
  acc.comp += 1;
  if (!acc.comp0 || ts < acc.comp0) acc.comp0 = ts;
}

export const startDayOf = (acc, dayStartMs, dayKeyOf) => dayKeyOf(dayStartMs(acc.start || acc.t0 || 0));

// Still being worked: a request within the idle window, and not past the 48 h cap from its start.
// A spawn whose completion is visible is closed at once (acc.done: its transcript ends in a final
// end_turn message; `completed`: the parent transcript holds the tool_result for its Agent call).
// The idle window and the 48 h cap are only the fallback for spawns that never show completion.
export function isOpen(acc, nowT, completed = false) {
  if (completed || acc.done) return false;
  const last = acc.t1 || acc.start || 0;
  if (!last) return false;
  const start = acc.start || acc.t0 || last;
  return nowT - last < SPAWN_OPEN_IDLE_MS && nowT - start < SPAWN_MAX_OPEN_MS;
}

const iso = (ms) => new Date(ms).toISOString();

// The finished record written to usage-facts/<start day>.json. Pure: does not change `acc`.
// `type` is the declared task type from the spawn telemetry row (joined by tool_use_id, like `fit`). Without one the brief's
// own TYPE token stands (known task-type names only, kept in acc.type); with neither it is null (unknown), never 'none'.
export function spawnRecord(acc, { fit = null, type = null } = {}) {
  const a = JSON.parse(JSON.stringify(acc));
  closeRun(a);
  const cat = {};
  for (const c of CATEGORIES) if (a.cat[c]) cat[c] = a.cat[c];
  return {
    id: a.tu || a.key,
    sid: a.sid,
    aid: a.aid,
    proj: a.proj,
    type: type || (a.type && a.type !== 'none' ? a.type : null),
    role: a.role,
    rung: a.rung,
    fit,
    model: a.model,
    mixed: a.mixed,
    start: iso(a.start || a.t0),
    end: iso(a.t1),
    partial: !!a.partial,
    req: { n: a.n, bucket: REQ_BUCKET_LABELS[requestBucket(a.n)], cat },
    ctx: { buckets: a.cb, peak: a.peak },
    startup: a.first,
    comp: { n: a.comp, after: a.comp ? a.pc : null },
    extraTurns: a.extra,
    status: a.status,
    simple: { runs: a.runs, req: a.runReq, tok: a.runT },
    rk: a.rk,
  };
}
