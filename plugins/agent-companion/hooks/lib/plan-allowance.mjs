// Percent allowance (0.31.47): a brief line `BUDGET: 3%` gives a helper an allowance of 3% of the WEEKLY plan limit.
// There is NO soft budget behind it: the helper gets ONE short note at its first tool call (this file builds it;
// hooks/subagent-context.mjs delivers it), a command to check its own spend (scripts/allowance.mjs) and, when its own
// spend (its transcript plus the agents it spawned) crosses 80% and again 100% of the allowance, ONE notice each
// (allowanceWatch below; option allowance_notice_pct, 0 = off) that asks it to send whoever briefed it a short status
// and keep going. Nothing stops or denies it, whatever it spends.
//
// Why a conversion, not the live meter. Several agents run at once, so the account's usage % cannot be told apart per
// agent. A helper's own tokens are converted to % instead: plan units (tokens priced at the Sonnet 5 vector, times the
// model's weight) over unitsPerPercent. All figures are data in config/plan-weights.json (user file: <state root>/
// plan-weights.json, merged one level deep), each with its date, source, interval and measured/assumed status.
//
// Which agent. The note carries the agent id in the command; the first call also writes
// state/allowance/<agent_id>.json (transcript path, allowance, rung), so the script finds the transcript without a
// scan. Without that file the script looks for agent-<id>.jsonl under the projects folder. Subagents the agent spawned
// are found through the parentAgentId in the agent-<id>.meta.json files that sit next to the transcripts.

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, openSync, readSync, closeSync, fstatSync, existsSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRootPath, opt, classifyModel } from './context.mjs';
import { briefAllowancePct } from './brief-directives.mjs';
import { readBrief } from './step-budget.mjs';
import { usageOf, safe } from './runaway.mjs';
import { claimOnce } from './subagent-context.mjs';

const STATE_TTL_MS = 7 * 86400000;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const NOTE_MAX_CHARS = 330; // "about 300": the text plus a typical plugin path and an agent id

// --- Weights (data) ----------------------------------------------------------------------------------------------

let _weights = null;
export function _resetPlanWeightsForTests() { _weights = null; }

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function planWeights() {
  if (_weights) return _weights;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'plan-weights.json');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(shipped, 'utf8')); } catch { /* defaults below */ }
  let over = null;
  try { over = JSON.parse(readFileSync(join(stateRootPath(), 'plan-weights.json'), 'utf8')); } catch { /* no user file: expected; a read never creates the state root (a dry run writes nothing) */ }
  if (plain(over)) {
    const merged = { ...cfg };
    for (const [k, v] of Object.entries(over)) merged[k] = plain(v) && plain(cfg[k]) ? { ...cfg[k], ...v } : v;
    // models.<alias> merges one level deeper, so a file naming only models.opus.weight keeps the rest of opus
    if (plain(over.models) && plain(cfg.models)) {
      merged.models = { ...cfg.models };
      for (const [a, v] of Object.entries(over.models)) merged.models[a] = plain(v) && plain(cfg.models[a]) ? { ...cfg.models[a], ...v } : v;
    }
    cfg = merged;
  }
  _weights = cfg;
  return _weights;
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
export function unitsPerPercent() { return num(planWeights().unitsPerPercent?.value, 28.6); }

// What 100% of the weekly plan limit is, in plan units: 100 x units per 1% (2860 shipped). The ONE place the weekly limit comes from:
// the session budget notice, the daily checkup and the usage analysis all call this; the option `weekly_limit_units` replaces it when set above 0.
export function weeklyLimitUnits() {
  const o = opt('weekly_limit_units', 0);
  return o > 0 ? o : Math.round(100 * unitsPerPercent() * 1e6) / 1e6;
}

// The model's weight vs Sonnet, and whether it is a measured figure. alias '' (an unrecognised model) counts as Sonnet.
export function modelWeight(alias) {
  const m = planWeights().models?.[alias];
  return { weight: num(m?.weight, 1), status: m ? (m.status || 'assumed') : 'unknown', known: !!m };
}

// Plan units for one usage record (lib/runaway.mjs usageOf shape) of `model`.
export function requestUnits(usage, model) {
  const w = planWeights();
  const u = w.unit || {};
  const w1 = usage.cacheWrite1h || 0;
  const w5 = Math.max(0, (usage.cacheWrite || 0) - w1);
  const tokens = (usage.input || 0) + w5 * num(u.w5, 1.25) + w1 * num(u.w1, 2)
    + (usage.cacheRead || 0) * num(u.readRatio, 0.1) * num(w.cacheReadFactor?.value, 1)
    + (usage.output || 0) * num(u.outRatio, 5);
  return tokens * (num(u.inPerMTok, 2) / 1e6) * modelWeight(classifyModel(model).alias).weight;
}

// --- Calls per allowance -----------------------------------------------------------------------------------------

// Median plan cost of one call at this model and effort, as a percent of the weekly limit: { pct, estimated }.
// The cell is rescaled by weight / basisWeight; a missing cell uses the model's nearest effort and says estimated.
export function perCallPct(alias, effort) {
  const pc = planWeights().perCall || {};
  const c = pickCell(pc.medianPct, alias, effort);
  if (!c) return null;
  const basis = num(pc.basisWeight?.[c.useAlias], 1);
  const pct = c.value * (modelWeight(c.useAlias).weight / basis);
  const listed = Array.isArray(pc.estimated) && pc.estimated.includes(`${c.useAlias}.${c.pick}`);
  return { pct, estimated: c.pick !== c.want || c.useAlias !== alias || listed };
}

// The cell of a { model: { effort: number } } table for this model and effort: the same effort when it has one, else the
// model's nearest effort (ties go to the higher); a model with no table uses Sonnet's. null when the table has no cell.
function pickCell(table, alias, effort) {
  const cells = table?.[alias] || table?.sonnet || {};
  const useAlias = table?.[alias] ? alias : 'sonnet';
  const want = EFFORTS.find((e) => e === String(effort || '').toLowerCase()); // undefined when not an effort
  const have = EFFORTS.filter((e) => typeof cells[e] === 'number');
  if (!have.length) return null;
  let pick = want && have.includes(want) ? want : null;
  if (!pick) {
    const target = want ? EFFORTS.indexOf(want) : EFFORTS.indexOf('high');
    pick = have.slice().sort((a, b) => Math.abs(EFFORTS.indexOf(a) - target) - Math.abs(EFFORTS.indexOf(b) - target)
      || EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0];
  }
  return { value: cells[pick], pick, useAlias, want };
}

// Median TOTAL tokens (input, output, cache write and cache read) of one call at this model and effort, or null.
export function perCallTokens(alias, effort) {
  const c = pickCell(planWeights().perCall?.medianTokens, alias, effort);
  return c ? c.value : null;
}

// What an allowance of pct% is in tokens at the model's typical mix: the calls it buys times the median tokens of a call. null without data.
export function allowanceTokens(pct, alias, effort) {
  const per = perCallPct(alias, effort);
  const tok = perCallTokens(alias, effort);
  return per && per.pct > 0 && tok ? (pct / per.pct) * tok : null;
}

// Two significant figures: 2609 -> 2600, 87.3 -> 87.
function sig2(n) {
  if (!(n > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}
const fmt = (n) => (n >= 1000 ? sig2(n).toLocaleString('en-US') : String(sig2(n)));
// A token count in words: "1.1 billion", "270 million", "570 thousand". digits = significant figures (2 for "about", 3 for a count).
export function fmtTokens(n, digits = 2) {
  const sig = (x) => String(Number(x.toPrecision(digits)));
  if (!(n > 0)) return '0';
  if (n >= 1e9) return `${sig(n / 1e9)} billion`;
  if (n >= 1e6) return `${sig(n / 1e6)} million`;
  if (n >= 1e3) return `${sig(n / 1e3)} thousand`;
  return String(Math.round(n));
}
const trimNum = (n) => String(Math.round(n * 100) / 100);

// --- Which model and effort --------------------------------------------------------------------------------------

const RUNG = /(?:^|:)ac-(haiku|sonnet|opus)(?:-(low|medium|high|xhigh|max))?$/i;
// { alias, effort, assumed } for a helper: a ladder rung from its agent_type; otherwise the model of its last
// transcript request and the payload's effort; what is not known is assumed (sonnet / high) and flagged.
export function rungOf(agentType, { model = '', effort = '' } = {}) {
  const t = String(agentType || '');
  const m = RUNG.exec(t);
  if (m) return { alias: m[1].toLowerCase(), effort: (m[2] || (m[1].toLowerCase() === 'haiku' ? 'medium' : 'high')).toLowerCase(), assumed: false };
  if (/(?:^|:)ac-browser-opus$/i.test(t)) return { alias: 'opus', effort: 'medium', assumed: false };
  if (/(?:^|:)ac-browser$/i.test(t)) return { alias: 'sonnet', effort: 'high', assumed: false };
  const c = model ? classifyModel(model) : null;
  const alias = c && c.known ? c.alias : '';
  const e = EFFORTS.includes(String(effort || '').toLowerCase()) ? String(effort).toLowerCase() : '';
  return { alias: alias || 'sonnet', effort: e || 'high', assumed: !alias || !e };
}

// --- The note ----------------------------------------------------------------------------------------------------

// noticePct: the first notice line (option allowance_notice_pct); 0 = no notices, and the note says nothing will warn it.
export function allowanceNoteText({ pct, alias, effort, assumed = false, root, agentId, noticePct = 80 }) {
  const units = pct * unitsPerPercent();
  const per = perCallPct(alias, effort);
  const toks = allowanceTokens(pct, alias, effort);
  const est = assumed || (per && per.estimated) ? ' (est.)' : '';
  const size = toks
    ? `about ${fmtTokens(toks)} tokens at ${alias}/${effort}'s usual mix${est}`
    : (per && per.pct > 0 ? `about ${fmt(pct / per.pct)} calls at ${alias}/${effort}${est}` : '');
  const notices = noticePct > 0
    ? `You get a notice at ${noticePct >= 100 ? '' : `${trimNum(noticePct)}% and `}100%; nothing stops you.`
    : 'Nothing will warn or stop you.';
  return `Allowance: ${trimNum(pct)}% of the weekly limit (${trimNum(units)} units)${size ? `, ${size}` : ''}. Plan your work to fit. ${notices} `
    + `Spend: node "${root}/scripts/allowance.mjs" ${agentId}`;
}

function pluginRoot() {
  return (process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..')).replace(/\\/g, '/');
}

const allowDir = () => join(stateRootPath(), 'state', 'allowance'); // paths only: a read (scripts/allowance.mjs) never creates the state root; the writer makes the dir
export const allowanceFile = (agentId) => join(allowDir(), `${safe(agentId)}.json`);

function pruneAllowanceState(now = Date.now()) {
  let names = [];
  try { names = readdirSync(allowDir()); } catch { return; }
  for (const n of names) {
    const f = join(allowDir(), n);
    try { if (now - statSync(f).mtimeMs > STATE_TTL_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

// The hook side. On a helper's FIRST tool call: read its brief; write its record (always, so the brief is read once);
// return the note text when the brief declares a `BUDGET: N%`, else null. Never denies, never throws.
export function allowanceNote(p, { transcript, sig = null, noticePct = 80 } = {}) {
  try {
    if (!p || !p.agent_id || !transcript) return null;
    const file = allowanceFile(p.agent_id);
    if (existsSync(file)) return null;
    const brief = readBrief(transcript);
    if (!brief) return null; // brief unreadable: try again on the next call
    const pct = briefAllowancePct(brief);
    mkdirSync(allowDir(), { recursive: true });
    const rung = rungOf(p.agent_type, { model: sig && sig.model, effort: p.effort && p.effort.level });
    try {
      writeFileSync(file, JSON.stringify({
        agent_id: p.agent_id, session_id: p.session_id, transcript, pct, ...(pct ? { model: rung.alias, effort: rung.effort } : {}),
        at: new Date().toISOString(),
      }), { flag: 'wx' });
    } catch { return null; } // another call of this agent won the claim
    pruneAllowanceState();
    if (!pct) return null;
    return allowanceNoteText({ pct, alias: rung.alias, effort: rung.effort, assumed: rung.assumed, root: pluginRoot(), agentId: p.agent_id, noticePct });
  } catch {
    return null;
  }
}

// --- Notices near the allowance ----------------------------------------------------------------------------------

// On every later tool call of an agent that has an allowance: how much has it spent? Its own transcript plus the agents it spawned
// (the same set as scripts/allowance.mjs; agents running in parallel are never read), kept incrementally in
// state/allowance/<agent_id>.meter.json: a byte offset per transcript, the units of the finished requests and the one request
// still being written (a request is written as several adjacent lines; later lines raise its usage). A call reads only the bytes
// added since the last one. The spawned agents are found through parentAgentId in their meta files, each read once
// (a directory whose mtime did not change is not listed again). Once the last notice has gone, a call reads the state file and nothing else.
// At noticePct% of the allowance and again at 100% (noticePct 0 = none) it returns ONE notice, once per threshold per agent
// (an exclusive-create claim, so parallel tool calls of one agent cannot send it twice). Never denies, never throws.
const METER_CHUNK = 8 * 1024 * 1024;
const METER_BUDGET_MS = 1500; // the hook timeout is 5 s; past this the rest is read on the next call
const meterFile = (agentId) => join(allowDir(), `${safe(agentId)}.meter.json`);
const freshMeter = () => ({ off: 0, units: 0, open: null });

function meterFinish(m) {
  if (m.open) { m.units += requestUnits(m.open.usage, m.open.model); m.open = null; }
}

function meterFeed(m, line) {
  if (!line.includes('"type":"assistant"')) return;
  let rec;
  try { rec = JSON.parse(line); } catch { return; }
  if (!rec || rec.type !== 'assistant') return;
  const msg = rec.message || {};
  if (msg.model === '<synthetic>') return;
  const key = rec.requestId || msg.id || null;
  const u = usageOf(msg.usage);
  if (key && m.open && m.open.key === key) {
    for (const k of Object.keys(m.open.usage)) m.open.usage[k] = Math.max(m.open.usage[k], u[k]);
    if (msg.model) m.open.model = msg.model;
    return;
  }
  meterFinish(m);
  m.open = { key, usage: u, model: msg.model || '' };
}

// Read what was appended to `path` since m.off (whole lines only). true when m changed.
function meterAdvance(m, path, deadline) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    let changed = false;
    if (size < m.off) { m.off = 0; m.units = 0; m.open = null; changed = true; } // replaced or truncated: start again
    let pos = m.off;
    let carry = Buffer.alloc(0);
    while (pos < size && Date.now() < deadline) {
      const len = Math.min(METER_CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      pos += len;
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) { carry = data; continue; }
      for (const l of data.subarray(0, nl).toString('utf8').split('\n')) meterFeed(m, l);
      carry = data.subarray(nl + 1);
      m.off = pos - carry.length;
      changed = true;
    }
    return changed;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Find the agents below agentId that are not known yet. true when the state changed.
function meterKids(st, transcript, agentId, deadline) {
  const dir = dirname(transcript);
  let mtime = 0;
  try { mtime = statSync(dir).mtimeMs; } catch { return false; }
  if (st.dirMtime === mtime && Date.now() - mtime > 3000) return false; // nothing added since the last listing
  let names = [];
  try { names = readdirSync(dir); } catch { return false; }
  const skip = new Set(st.skip);
  const fresh = new Map(); // child id -> parent id, for metas not seen before
  let complete = true;
  for (const n of names) {
    if (!n.startsWith('agent-') || !n.endsWith('.meta.json')) continue;
    const id = n.slice('agent-'.length, -'.meta.json'.length);
    if (id === agentId || st.kids[id] || skip.has(id) || !idOk(id)) continue;
    if (Date.now() >= deadline) { complete = false; break; }
    try {
      const m = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      if (m && typeof m.parentAgentId === 'string') fresh.set(id, m.parentAgentId);
      else st.skip.push(id); // a lead's helper: not below anyone we watch
    } catch { complete = false; } // unreadable now (being written): try again next time
  }
  let grew = true;
  while (grew) { // a grandchild can sort before its parent: resolve until nothing more joins
    grew = false;
    for (const [id, parent] of fresh) {
      if (parent === agentId || st.kids[parent]) { st.kids[id] = freshMeter(); fresh.delete(id); grew = true; }
    }
  }
  for (const id of fresh.keys()) st.skip.push(id);
  st.dirMtime = complete ? mtime : 0;
  return true;
}

export function allowanceNoticeText(mark, pct) {
  const head = mark >= 100
    ? `[agent-companion] You have used your whole ${trimNum(pct)}% allowance.`
    : `[agent-companion] You have used ${trimNum(mark)}% of your ${trimNum(pct)}% allowance.`;
  return `${head} Send whoever briefed you ONE short status (what is done, what is left, how much more you need), `
    + 'a subagent by SendMessage to "main", then keep going. Nothing stops you.';
}

// The notice text for this tool call of the agent, or null. See above.
export function allowanceWatch(p, { noticePct = 80 } = {}) {
  try {
    if (!(noticePct > 0) || !p || !p.agent_id) return null;
    const id = p.agent_id;
    let rec;
    try { rec = JSON.parse(readFileSync(allowanceFile(id), 'utf8')); } catch { return null; } // no record: no allowance, or the first call
    if (!rec || typeof rec.pct !== 'number' || !(rec.pct > 0) || typeof rec.transcript !== 'string') return null;
    const marks = noticePct >= 100 ? [100] : [noticePct, 100];
    let st = null;
    try { st = JSON.parse(readFileSync(meterFile(id), 'utf8')); } catch { /* first look */ }
    if (!st || st.v !== 1 || !st.own) st = { v: 1, own: freshMeter(), kids: {}, skip: [], dirMtime: 0, fired: [] };
    if (marks.every((m) => st.fired.includes(m))) return null; // all sent: this call costs one small read
    const deadline = Date.now() + METER_BUDGET_MS;
    let dirty = meterAdvance(st.own, rec.transcript, deadline);
    dirty = meterKids(st, rec.transcript, id, deadline) || dirty;
    const dir = dirname(rec.transcript);
    for (const [kid, m] of Object.entries(st.kids)) dirty = meterAdvance(m, join(dir, `agent-${kid}.jsonl`), deadline) || dirty;
    const meters = [st.own, ...Object.values(st.kids)];
    const units = meters.reduce((a, m) => a + m.units + (m.open ? requestUnits(m.open.usage, m.open.model) : 0), 0);
    const used = (units / unitsPerPercent() / rec.pct) * 100; // percent of the allowance
    const crossed = marks.filter((m) => used >= m && !st.fired.includes(m));
    const sent = crossed.filter((m) => claimOnce(`allowance-notice-${id}-${m}`));
    for (const m of crossed) st.fired.push(m); // a mark another call of this agent claimed first is done too
    if (dirty || crossed.length) {
      try {
        mkdirSync(allowDir(), { recursive: true });
        const tmp = `${meterFile(id)}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(st));
        renameSync(tmp, meterFile(id));
      } catch { /* best effort: the next call reads again */ }
    }
    return sent.length ? allowanceNoticeText(Math.max(...sent), rec.pct) : null;
  } catch {
    return null;
  }
}

// --- Spend (the self-check) -------------------------------------------------------------------------------------

// Plan units spent in one transcript: requests deduplicated by requestId (else message id), a request's usage the
// field-wise max over its lines (one API request is written as several lines). Returns { units, tokens, calls, byModel,
// unknownCalls }; tokens is input + output + cache write + cache read; byModel maps alias -> { calls, units }.
export function transcriptSpend(path) {
  const out = { units: 0, tokens: 0, calls: 0, byModel: {}, unknownCalls: 0 };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const reqs = new Map();
    let anon = 0;
    let off = 0;
    let carry = '';
    const feed = (line) => {
      if (!line.includes('"type":"assistant"')) return;
      let rec;
      try { rec = JSON.parse(line); } catch { return; }
      if (!rec || rec.type !== 'assistant') return;
      const msg = rec.message || {};
      if (msg.model === '<synthetic>') return;
      const key = rec.requestId || msg.id || `anon-${anon += 1}`;
      const u = usageOf(msg.usage);
      const prev = reqs.get(key);
      if (prev) {
        for (const k of Object.keys(prev.usage)) prev.usage[k] = Math.max(prev.usage[k], u[k]);
        if (msg.model) prev.model = msg.model;
      } else reqs.set(key, { usage: u, model: msg.model || '' });
    };
    const CHUNK = 8 * 1024 * 1024;
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, off);
      off += len;
      const parts = (carry + buf.toString('utf8')).split('\n');
      carry = parts.pop();
      for (const l of parts) feed(l);
    }
    if (carry) feed(carry);
    for (const r of reqs.values()) {
      const c = classifyModel(r.model);
      const alias = c.known ? c.alias : '';
      if (!modelWeight(alias).known) out.unknownCalls += 1;
      const units = requestUnits(r.usage, r.model);
      out.units += units;
      out.tokens += r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
      out.calls += 1;
      const b = (out.byModel[alias || 'unknown'] ||= { calls: 0, units: 0 });
      b.calls += 1;
      b.units += units;
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const idOk = (s) => /^[A-Za-z0-9_-]+$/.test(String(s || ''));

// Where an agent's transcript is: its state record, else agent-<id>.jsonl under <claude dir>/projects/*/*/subagents.
export function findAgentTranscript(agentId, claudeDirPath) {
  if (!idOk(agentId)) return null;
  try {
    const rec = JSON.parse(readFileSync(allowanceFile(agentId), 'utf8'));
    if (rec && rec.agent_id === agentId && typeof rec.transcript === 'string' && existsSync(rec.transcript)) return { transcript: rec.transcript, record: rec };
  } catch { /* no record: scan */ }
  const root = join(claudeDirPath, 'projects');
  try {
    for (const proj of readdirSync(root)) {
      let sessions = [];
      try { sessions = readdirSync(join(root, proj)); } catch { continue; }
      for (const s of sessions) {
        const f = join(root, proj, s, 'subagents', `agent-${agentId}.jsonl`);
        if (existsSync(f)) return { transcript: f, record: null };
      }
    }
  } catch { /* no projects folder */ }
  return null;
}

// The agents below `agentId` (children, grandchildren, ...) in the same subagents folder, from the parentAgentId in
// each agent-<id>.meta.json. Returns their transcript paths. Agents running in parallel that are not descendants
// are never read.
export function descendantTranscripts(transcript, agentId) {
  const dir = dirname(transcript);
  const parentOf = new Map();
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.meta.json') || !n.startsWith('agent-')) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, n), 'utf8'));
        if (m && typeof m.parentAgentId === 'string') parentOf.set(n.slice('agent-'.length, -'.meta.json'.length), m.parentAgentId);
      } catch { /* unreadable meta: not a child of anything we know */ }
    }
  } catch { return []; }
  const found = [];
  let frontier = [agentId];
  const seen = new Set([agentId]);
  while (frontier.length) {
    const next = [];
    for (const [child, parent] of parentOf) {
      if (frontier.includes(parent) && !seen.has(child) && idOk(child)) { seen.add(child); next.push(child); }
    }
    for (const c of next) {
      const f = join(dir, `agent-${c}.jsonl`);
      if (existsSync(f)) found.push(f);
    }
    frontier = next;
  }
  return found;
}

// The whole self-check for one agent: { ok: false, reason } or { ok: true, ... } (see scripts/allowance.mjs).
export function agentSpend(agentId, claudeDirPath) {
  const loc = findAgentTranscript(agentId, claudeDirPath);
  if (!loc) return { ok: false, reason: `no transcript found for agent ${agentId}` };
  const own = transcriptSpend(loc.transcript);
  if (!own) return { ok: false, reason: 'the transcript could not be read' };
  let pct;
  if (loc.record && 'pct' in loc.record) pct = typeof loc.record.pct === 'number' ? loc.record.pct : null;
  else pct = briefAllowancePct(readBrief(loc.transcript));
  const kids = descendantTranscripts(loc.transcript, agentId).map(transcriptSpend).filter(Boolean);
  const sub = kids.reduce((a, k) => ({ units: a.units + k.units, tokens: a.tokens + k.tokens, calls: a.calls + k.calls }), { units: 0, tokens: 0, calls: 0 });
  const models = {};
  for (const s of [own, ...kids]) for (const [a, v] of Object.entries(s.byModel)) models[a] = (models[a] || 0) + v.calls;
  const per = unitsPerPercent();
  const totalUnits = own.units + sub.units;
  const totalTokens = own.tokens + sub.tokens;
  // Tokens: the allowance at the model's usual mix (the rung from the state record, else the model with most calls, at high) and
  // what is left of it, the unspent share of the allowance in units times that figure (so it adds up with the allowance).
  const topModel = Object.entries(own.byModel).sort((a, b) => b[1].calls - a[1].calls)[0]?.[0];
  const alias = loc.record?.model || (topModel && topModel !== 'unknown' ? topModel : 'sonnet');
  const effort = loc.record?.effort || 'high';
  const allowTok = pct ? allowanceTokens(pct, alias, effort) : null;
  return {
    ok: true,
    allowancePct: pct,
    totalTokens, allowanceTokens: allowTok, tokensLeft: allowTok ? allowTok * Math.max(0, 1 - totalUnits / (pct * per)) : null,
    allowanceModel: `${alias}/${effort}`,
    totalPct: totalUnits / per, ownPct: own.units / per, subPct: sub.units / per,
    totalUnits, ownCalls: own.calls, subCalls: sub.calls, subAgents: kids.length,
    models: Object.keys(models), unknownCalls: own.unknownCalls + kids.reduce((n, k) => n + k.unknownCalls, 0),
    usedOfAllowance: pct ? totalUnits / per / pct : null,
  };
}
