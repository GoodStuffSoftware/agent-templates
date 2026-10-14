// Usage facts: the durable per-session-hour record the daily analysis reads.
//
// The checkup scan (scripts/lib/daily-checkup.mjs) feeds one accumulator while it
// reads each transcript once; this module holds the pure parts: the row shape,
// the merge, the prompt and tool classifiers, the day file, and the unit
// recomputation. No file here reads a transcript or calls a model.
//
// A fact row is one (UTC hour, session) pair:
//   { hour, sid, proj, cwd,
//     tok: { <model>: { m: T, s: T } },   m = main thread, s = subagents; T below
//     pr:  { n, len: [b0,b1,b2,b3], corr },   operator prompts: count, length bucket, correction flag
//     ag, sm, gc }                        Agent / SendMessage / git-commit Bash call counts
// Spawn records (day file field `spawns`, keyed by start day) are built in ./spawns.mjs.
// T = [input, output, cacheWrite5m, cacheWrite1h, cacheRead, requests] (raw tokens).
// A cache write that carries no 5m/1h split is folded into cacheWrite5m, which
// is how unitsOf prices it, so units recomputed from T equal the scan's units.
//
// No prompt text and no tool content is stored; only counts and flags.

export const FACTS_VERSION = 1;
export const EXTRACTOR_VERSION = 2; // 2: spawn records (batch 2b); factsVersion stays 1, the field is additive
export const FACTS_SCHEMA = 'agent-companion/usage-facts';
export const SETTLE_MS = 5 * 60 * 1000; // a closed day is final this long after its close

// Prompt length buckets (characters): under 60, 60-199, 200-999, 1000 and up.
// 60 is the lead.unitsPerTask threshold in the design.
export const PROMPT_LEN_EDGES = [60, 200, 1000];

// The shipped correction vocabulary (the user layer may replace it later).
export const DEFAULT_CORRECTION_VOCAB = ['no,', 'wrong', "that's not", 'i said', 'again', 'stop'];

const AUTO_PROMPT_PREFIXES = [
  '<task-notification', '<command-', '<local-command', '<system-reminder', 'caveat:', '[request interrupted',
];

const COMMIT_RE = /\bgit\s+(?:[^\n;&|]*?\s)?commit\b/;

// spawns: open/unlanded spawn accumulators (usage/spawns.mjs); landed: key -> day, so a later request of a landed spawn is not a new spawn
export const newFacts = (fromMs) => ({ fromMs, rows: {}, spawns: {}, landed: {} });

export function lengthBucket(n) {
  let b = 0;
  while (b < PROMPT_LEN_EDGES.length && n >= PROMPT_LEN_EDGES[b]) b += 1;
  return b;
}

// Does `lower` contain `term` as a whole word (or phrase)? Linear scan, no regex built from data.
export function hasTerm(lower, term) {
  const t = String(term || '').toLowerCase();
  if (!t) return false;
  const isW = (c) => /[a-z0-9]/.test(c);
  let from = 0;
  for (;;) {
    const i = lower.indexOf(t, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : lower[i - 1];
    const after = lower[i + t.length] || '';
    const leftOk = !before || !isW(before) || !isW(t[0]);
    const rightOk = !after || !isW(after) || !isW(t[t.length - 1]);
    if (leftOk && rightOk) return true;
    from = i + 1;
  }
}

export function correctionFlag(text, vocab = DEFAULT_CORRECTION_VOCAB) {
  const lower = String(text || '').toLowerCase();
  return vocab.some((t) => hasTerm(lower, t));
}

// The operator's text of a user record from a main transcript, or null when the
// record is not a human prompt (tool result, meta line, system or task notice).
export function operatorPromptText(j) {
  if (!j || j.type !== 'user' || j.isMeta || j.isSidechain || j.toolUseResult) return null;
  const c = j.message && j.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b === 'string') return null;
      if (b.type === 'tool_result') return null;
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    }
  } else return null;
  const t = text.trim();
  if (!t) return null;
  const low = t.slice(0, 40).toLowerCase();
  if (AUTO_PROMPT_PREFIXES.some((p) => low.startsWith(p))) return null;
  return t;
}

// tool_use blocks of one assistant record -> Map(tool_use id -> 'ag' | 'sm' | 'gc')
export function toolKindsOf(content) {
  const out = new Map();
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || !b.id) continue;
    if (b.name === 'Agent' || b.name === 'Task') out.set(b.id, 'ag');
    else if (b.name === 'SendMessage') out.set(b.id, 'sm');
    else if (b.name === 'Bash' && b.input && typeof b.input.command === 'string' && COMMIT_RE.test(b.input.command)) out.set(b.id, 'gc');
  }
  return out;
}

const HOUR_MS = 3600000;

export function rowFor(facts, hour, sid, meta = {}) {
  const key = `${hour}|${sid}`;
  let r = facts.rows[key];
  if (!r) r = facts.rows[key] = { hour, sid, proj: meta.proj || null, cwd: meta.cwd || null, tok: {}, pr: { n: 0, len: [0, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0 };
  if (!r.proj && meta.proj) r.proj = meta.proj;
  if (!r.cwd && meta.cwd) r.cwd = meta.cwd;
  return r;
}

// One counted request. `usage` is transcripts.mjs's usageOf shape; `tools` the toolKindsOf map.
export function addRequest(facts, { tsMs, sid, proj, cwd, model, sub, usage, tools }) {
  const hour = Math.floor(tsMs / HOUR_MS);
  const r = rowFor(facts, hour, sid, { proj, cwd });
  const split = (usage.cacheWrite5m || 0) + (usage.cacheWrite1h || 0) > 0;
  const m = (r.tok[model] ||= { m: [0, 0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0, 0] });
  const t = sub ? m.s : m.m;
  t[0] += usage.input || 0;
  t[1] += usage.output || 0;
  t[2] += split ? usage.cacheWrite5m || 0 : usage.cacheWrite || 0;
  t[3] += split ? usage.cacheWrite1h || 0 : 0;
  t[4] += usage.cacheRead || 0;
  t[5] += 1;
  if (tools) for (const k of tools.values()) r[k] += 1;
}

export function addPrompt(facts, { tsMs, sid, proj, cwd, text, vocab }) {
  const hour = Math.floor(tsMs / HOUR_MS);
  const r = rowFor(facts, hour, sid, { proj, cwd });
  r.pr.n += 1;
  r.pr.len[lengthBucket(text.length)] += 1;
  if (correctionFlag(text, vocab)) r.pr.corr += 1;
}

export function pruneFacts(facts, keepFromMs) {
  for (const [k, r] of Object.entries(facts.rows)) if (r.hour * HOUR_MS < keepFromMs) delete facts.rows[k];
}

// Units of one token vector T under a price spec {inUsd,outRatio,r,w5,w1,mult}.
export function unitsFromTokens(t, spec, multOverride) {
  if (!spec) return 0;
  const usd = t[0] * spec.inUsd + t[1] * spec.inUsd * spec.outRatio + t[2] * spec.inUsd * spec.w5
    + t[3] * spec.inUsd * spec.w1 + t[4] * spec.inUsd * spec.r;
  return usd * (multOverride ?? spec.mult);
}

// Units of a facts file (or a subset of its rows), recomputed from the stored
// raw tokens. `weights` maps model -> multiplier to use instead of the recorded one.
export function unitsOfFacts(facts, { weights = {}, kind = null } = {}) {
  const used = facts.weightsUsed || {};
  let total = 0;
  const rows = Array.isArray(facts.rows) ? facts.rows : Object.values(facts.rows || {});
  for (const r of rows) {
    for (const [model, mt] of Object.entries(r.tok || {})) {
      const spec = used[model];
      if (!spec) continue;
      const mult = Object.prototype.hasOwnProperty.call(weights, model) ? weights[model] : undefined;
      if (kind !== 's') total += unitsFromTokens(mt.m, spec, mult);
      if (kind !== 'm') total += unitsFromTokens(mt.s, spec, mult);
    }
  }
  return total;
}

// The day file: every row inside [startMs, endMs), sorted so output is deterministic.
export function buildFactsFile(facts, { day, startMs, endMs, weightsFor, dataThroughMs, scanFromMs, computedAtMs, spawns = [] }) {
  const rows = Object.values(facts.rows)
    .filter((r) => r.hour * HOUR_MS >= startMs && r.hour * HOUR_MS < endMs)
    .sort((a, b) => a.hour - b.hour || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  const weightsUsed = {};
  for (const r of rows) for (const model of Object.keys(r.tok)) if (!weightsUsed[model]) weightsUsed[model] = weightsFor(model);
  for (const sp of spawns) if (sp.model && !weightsUsed[sp.model]) weightsUsed[sp.model] = weightsFor(sp.model);
  const iso = (ms) => new Date(ms).toISOString();
  return {
    schema: FACTS_SCHEMA,
    factsVersion: FACTS_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    day,
    from: iso(startMs),
    to: iso(endMs),
    dataThrough: dataThroughMs ? iso(dataThroughMs) : null,
    scanFrom: iso(scanFromMs),
    computedAt: iso(computedAtMs),
    weightsUsed,
    rows: rows.map((r) => ({ ...r, hour: iso(r.hour * HOUR_MS) })),
    spawns,
  };
}
