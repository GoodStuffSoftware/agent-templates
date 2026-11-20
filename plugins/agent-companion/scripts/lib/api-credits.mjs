// api-credits.mjs — the API-credit governor and its ledger.
//
// The operator's plan includes monthly Claude Platform API credits. They are
// usable only through a Console API key on the Claude API (Claude Code is not
// covered) and unused credits expire at the end of each billing cycle. This
// library decides, call by call, whether a piece of work goes to the credits
// ("api") or stays on the subscription ("plan"), and keeps the ledger that
// decision rests on. It never touches the network and never holds a key; the
// key is resolved only by the runner (scripts/api-review.mjs, resolveKey here)
// and goes only into the request headers of one Messages API call.
//
// Policy:
//   - Spend is paced linearly across the billing cycle. A category may have
//     spent at most share x budget x elapsed-fraction PLUS one average item of
//     slack. Early in a cycle everything is throttled; credits last the month.
//   - The reserve share is held back until the last RESERVE_DAYS of the cycle,
//     then released (every category's share is scaled up to cover it).
//   - `review` also has a target ratio (default 0.5): api and plan alternate
//     by a persisted counter, and pacing or balance can only turn api into plan.
//   - Fail closed: no key configured, an unreadable ledger or any error all
//     answer "plan".
//   - Billing or auth failures from an API run (recordFailure) trip a breaker:
//     two in a row and `decide` answers "plan" for the rest of the cycle.
//
// Overflow (near the weekly plan cap) and a cheap bulk rater are categories of
// the same budget; nothing here runs them yet.
//
// Billing (0.31.55): the ledger holds only what runs booked for themselves, and booked spend
// can be wrong (on 2026-11-15 it read $88.66 where Anthropic had billed $41.56). So `decide`
// and `status` take a billing snapshot (scripts/lib/api-spend.mjs fetches and caches it from
// the Admin API; this file stays free of the network) and rest on BILLED spend, plus booked
// spend only for the window after the last complete billed UTC day. Without a snapshot they
// fall back to booked figures and say so (BOOKED_ONLY). Per-workspace monthly limits are a
// config map because the API cannot read them back.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { opt, stateFile } from '../../hooks/lib/context.mjs';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';
import { spawnSyncHidden } from './proc.mjs';
import { priceUsage } from './pricing.mjs';

export const CATEGORIES = ['review', 'overflow', 'rater', 'workers'];
// Sum 1.0. review keeps the largest share; workers is a real spender now; overflow and rater are reserved and barely used.
export const DEFAULT_SHARES = { review: 0.5, overflow: 0.1, rater: 0.05, workers: 0.3, reserve: 0.05 };
export const RESERVE_DAYS = 3;
export const DEFAULT_KEY_SOURCE = 'env:AC_API_KEY';
export const TRIP_AFTER = 2; // billing/auth failures in a row
export const BOOKED_ONLY = 'booked only, not verified against billing';
// Category -> workspace (name or wrkspc_ id) for the billed-spend attribution and the limits. 'review'
// is replaced by api_spend_reviewers_workspace in loadSpendConfig (lib/api-spend.mjs).
export const DEFAULT_CATEGORY_WORKSPACES = { review: 'reviewers', workers: 'workers' };
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// The ledger is the only machine record of API spend (the Admin API is unavailable for individual
// accounts), so every run is kept: one entry each, a few hundred bytes.
const MAX_ENTRIES = 2000;

export const ledgerPath = () => stateFile('api-credits.json');

// --- config --------------------------------------------------------------------------

export function parseShares(raw) {
  const out = { ...DEFAULT_SHARES };
  for (const part of String(raw || '').split(/[,;\s]+/).filter(Boolean)) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (k in DEFAULT_SHARES && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// A warning line when the shares do not sum to 1.0 (+-0.001), else ''.
export function sharesWarning(shares) {
  const t = Object.values(shares || {}).reduce((a, v) => a + (Number(v) || 0), 0);
  return Math.abs(t - 1) > 0.001 ? `WARNING: api_credits_shares sum to ${t.toFixed(3)}, not 1.0; the pace caps and the reserve assume 1.0` : '';
}

// "name=usd, name=usd" -> { name: usd } (a workspace name or wrkspc_ id; amounts above 0 only).
export function parseWorkspaceLimits(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const i = part.lastIndexOf('=');
    if (i < 1) continue;
    const n = Number(part.slice(i + 1).replace(/^\$/, ''));
    if (Number.isFinite(n) && n > 0) out[part.slice(0, i)] = n;
  }
  return out;
}

// "category=workspace, ..." -> replacements for DEFAULT_CATEGORY_WORKSPACES (category names are lower-cased).
export function parseCategoryWorkspaces(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1 || i === part.length - 1) continue;
    out[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return out;
}

export function loadConfig(o = opt) {
  const day = Math.floor(Number(o('api_credits_cycle_day', 1)));
  const budget = Number(o('api_credits_budget_usd', 200));
  const ratio = Number(o('api_credits_review_ratio', 0.5));
  const est = Number(o('api_credits_item_estimate_usd', 2));
  return {
    budget: Number.isFinite(budget) && budget > 0 ? budget : 200,
    cycleDay: day >= 1 && day <= 28 ? day : 1,
    shares: parseShares(o('api_credits_shares', '')),
    keySource: String(o('api_credits_key_source', DEFAULT_KEY_SOURCE) || '').trim(),
    reviewRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5,
    itemEstimate: Number.isFinite(est) && est > 0 ? est : 2,
    workspaceLimits: parseWorkspaceLimits(o('api_credits_workspace_limits', '')),
    categoryWorkspaces: { ...DEFAULT_CATEGORY_WORKSPACES, ...parseCategoryWorkspaces(o('api_credits_category_workspaces', '')) },
  };
}

// --- billing cycle (UTC) ---------------------------------------------------------------

export function cycleOf(nowMs, cycleDay) {
  const d = new Date(nowMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() < cycleDay) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = Date.UTC(y, m, cycleDay);
  const end = Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, cycleDay);
  return {
    key: new Date(start).toISOString().slice(0, 10),
    start,
    end,
    frac: Math.min(1, Math.max(0, (nowMs - start) / (end - start))),
    reserveReleased: nowMs >= end - RESERVE_DAYS * DAY_MS,
  };
}

// --- key source ------------------------------------------------------------------------

export function parseKeySource(src) {
  const m = /^(env|bws):(.+)$/.exec(String(src || '').trim());
  return m ? { kind: m[1], name: m[2].trim() } : null;
}

// Cheap presence check for `decide`: the source is well formed and the thing it
// reads from is set. Never reads the key's value into anything it returns.
export function keyConfigured(src, env = process.env) {
  const p = parseKeySource(src);
  if (!p || !p.name) return false;
  if (p.kind === 'env') return !!env[p.name];
  return !!env.BWS_ACCESS_TOKEN;
}

// A key-lookup failure that is the configuration's fault (bws failed, no such secret): the runner
// counts it toward the two-strikes breaker, like a billing or auth failure.
const keyError = (msg) => Object.assign(new Error(msg), { configFailure: true });

// The key itself. Runner only. Throws a message that never contains the key.
export function resolveKey(src, env = process.env) {
  const p = parseKeySource(src);
  if (!p || !p.name) throw new Error('no key source configured');
  if (p.kind === 'env') {
    const v = env[p.name];
    if (!v) throw new Error(`environment variable ${p.name} is not set`);
    return v;
  }
  if (!env.BWS_ACCESS_TOKEN) throw new Error('BWS_ACCESS_TOKEN is not set');
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.name);
  const args = isId ? ['secret', 'get', p.name, '-o', 'json'] : ['secret', 'list', '-o', 'json'];
  const r = spawnSyncHidden(process.env.AGENT_COMPANION_BWS_BIN || 'bws', args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw keyError('bws failed to return the secret');
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw keyError('bws returned unreadable output'); }
  const hit = isId ? j : (Array.isArray(j) ? j.find((s) => s && s.key === p.name) : null);
  if (!hit || typeof hit.value !== 'string' || !hit.value) throw keyError(`bws has no secret named ${p.name}`);
  return hit.value;
}

// --- ledger ----------------------------------------------------------------------------

const emptyCycle = () => ({ spent: {}, n: {}, turn: {}, fails: 0, tripped: null, entries: [] });

function readLedger(path) {
  if (!existsSync(path)) return { v: 1, cycles: {} };
  const j = JSON.parse(readFileSync(path, 'utf8')); // a throw here is the caller's fail-closed
  if (!j || typeof j !== 'object' || typeof j.cycles !== 'object') throw new Error('ledger is not a ledger');
  return j;
}

function writeLedger(path, led) {
  const keep = Object.keys(led.cycles).sort().slice(-4);
  for (const k of Object.keys(led.cycles)) if (!keep.includes(k)) delete led.cycles[k];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(led, null, 2)}\n`);
  renameSync(tmp, path);
}

// Read-modify-write under a lock. fn(cycle, led) may mutate the cycle; returns fn's value.
function mutate(now, cfg, path, fn) {
  return withFileLock(`${path}.lock`, () => {
    const led = readLedger(path);
    const cy = cycleOf(now, cfg.cycleDay);
    const c = (led.cycles[cy.key] ||= emptyCycle());
    for (const k of ['spent', 'n', 'turn']) c[k] ||= {};
    c.entries ||= [];
    const out = fn(c, cy, led);
    writeLedger(path, led);
    return out;
  }, { failOpen: false, waitMs: 3000 });
}

const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

// --- billed spend (a snapshot fetched by lib/api-spend.mjs; nothing here touches the network) ---------------
//
// snapshot = { through: ms (end of the last complete billed UTC day), cost: [{ day, ws, model, usd }],
//   usage: [{ day, ws, key, model, input, output, cacheRead, cacheWrite }] | null,
//   hourly: [{ hour: ms, ws }] | null, hourlyFrom: ms | null, workspaces: { id: name }, keys: { id: name }, missing: [...] }
// ws is a workspace id; '' is the default workspace.

const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const monthStartOf = (nowMs) => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const tOf = (e) => Date.parse(e && e.t);

// A category's workspace (name or id) as an id; null when it names none the snapshot knows, '' for the default workspace.
export function resolveWorkspace(snap, nameOrId) {
  const w = String(nameOrId || '').trim();
  if (!w) return null;
  if (/^wrkspc_/.test(w)) return w;
  if (w.toLowerCase() === 'default') return '';
  for (const [id, name] of Object.entries((snap && snap.workspaces) || {})) if (String(name).toLowerCase() === w.toLowerCase()) return id;
  return null;
}

export const workspaceName = (snap, id) => (id === '' ? 'default' : ((snap && snap.workspaces && snap.workspaces[id]) || id || 'default'));

// Billed dollars from `fromMs` through the snapshot's cut-off; ws (an id) narrows to one workspace.
export function billedSince(snap, fromMs, ws) {
  let t = 0;
  for (const r of (snap && snap.cost) || []) if (dayMs(r.day) >= fromMs && (ws === undefined || r.ws === ws)) t += Number(r.usd) || 0;
  return t;
}

// Booked dollars of ledger entries with fromMs <= t < toMs, optionally of the categories in `cats`.
export function bookedBetween(entries, fromMs, toMs = Infinity, cats = null) {
  let t = 0;
  for (const e of entries || []) {
    const at = tOf(e);
    if (at >= fromMs && at < toMs && (!cats || cats.includes(e.cat))) t += Number(e.usd) || 0;
  }
  return t;
}

// `names`: the workspace name and, when the category is mapped by id with no billing to resolve it, the category's default name
// (a limit set as workers=50 must still hold when AC_API_WORKERS_WORKSPACE_ID maps workers to an id).
const limitFor = (cfg, name, id, extraNames = []) => {
  const names = [name, ...extraNames].filter((n) => n !== null && n !== undefined).map((n) => String(n).toLowerCase());
  for (const [k, v] of Object.entries(cfg.workspaceLimits || {})) {
    if (k === id || names.includes(k.toLowerCase())) return v;
  }
  return null;
};

// What `decide` rests on, for one category: billed spend through the cut-off plus booked spend after it.
// billing = null: booked figures only (verified: false); a workspace limit is then checked against the
// booked spend of the categories that share the workspace this calendar month.
export function spendView(billing, category, { cfg, cy, entries, now }) {
  const wsRef = (cfg.categoryWorkspaces || {})[category];
  const monthStart = monthStartOf(now);
  const snap = billing && Number.isFinite(billing.through) ? billing : null;
  const sameWsCats = (resolve) => {
    const mine = resolve(wsRef);
    return Object.entries(cfg.categoryWorkspaces || {}).filter(([, w]) => (mine === null ? String(w).toLowerCase() === String(wsRef).toLowerCase() : resolve(w) === mine)).map(([c]) => c);
  };
  if (!snap) {
    const cats = wsRef ? sameWsCats((w) => String(w).toLowerCase()) : [category];
    return { verified: false, wsName: wsRef || null, limit: wsRef ? limitFor(cfg, wsRef, wsRef, [category]) : null, wsMonth: bookedBetween(entries, monthStart, Infinity, cats) };
  }
  const winFrom = Math.max(snap.through, cy.start);
  const wsId = resolveWorkspace(snap, wsRef);
  const cats = wsId === null ? [category] : sameWsCats((w) => resolveWorkspace(snap, w));
  const name = wsId === null ? (wsRef || null) : workspaceName(snap, wsId);
  return {
    verified: true,
    wsMapped: wsId !== null,
    total: billedSince(snap, cy.start) + bookedBetween(entries, winFrom),
    spent: wsId === null ? bookedBetween(entries, cy.start, Infinity, [category]) : billedSince(snap, cy.start, wsId) + bookedBetween(entries, winFrom, Infinity, [category]),
    wsName: name,
    limit: wsRef ? limitFor(cfg, name, wsId, [category]) : null,
    wsMonth: (wsId === null ? 0 : billedSince(snap, monthStart, wsId)) + bookedBetween(entries, Math.max(snap.through, monthStart), Infinity, cats),
    through: snap.through,
  };
}

// --- decide ----------------------------------------------------------------------------
//
// With a billing snapshot the figures are billed spend through the last complete UTC day plus the booked spend after it.
// Without one (no admin key, no network) they are the booked figures and every reason says so.

export function decide(category, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), env = process.env, billing = null } = {}) {
  const plan = (reason) => ({ decision: 'plan', reason });
  try {
    if (!CATEGORIES.includes(category)) return plan(`unknown category "${category}"`);
    if (!keyConfigured(cfg.keySource, env)) return plan('no API key configured (set api_credits_key_source and the variable it names)');
    return mutate(now, cfg, path, (c, cy) => {
      if (c.tripped) return plan(`API runs failed ${c.fails} ${c.fails === 1 ? 'time' : 'times'} in a row this cycle (${c.tripped.reason}); plan until the cycle ends or a probe succeeds`);
      const sh = cfg.shares;
      const view = spendView(billing, category, { cfg, cy, entries: c.entries, now });
      const tag = view.verified ? '' : ` (${BOOKED_ONLY})`;
      if (view.limit !== null && view.wsMonth >= view.limit) return plan(`workspace limit: ${view.wsName} at $${view.wsMonth.toFixed(2)} of its $${view.limit.toFixed(2)} monthly limit${tag}`);
      const nonReserve = CATEGORIES.reduce((a, k) => a + (sh[k] || 0), 0) || 1;
      const pool = cfg.budget * (cy.reserveReleased ? 1 : 1 - (sh.reserve || 0));
      const total = view.verified ? view.total : sum(c.spent);
      const spent = view.verified ? view.spent : (c.spent[category] || 0);
      const cnt = c.n[category] || 0;
      const avg = cnt > 0 ? (c.spent[category] || 0) / cnt : cfg.itemEstimate;
      const basis = view.verified ? (view.wsMapped ? 'billed' : 'booked only, no workspace mapped') : 'booked';
      if (pool - total < avg) return plan(`balance: $${(cfg.budget - total).toFixed(2)} left of $${cfg.budget} (${basis})${cy.reserveReleased ? '' : ', the rest is the held reserve'}${tag}`);
      const share = cy.reserveReleased ? (sh[category] || 0) + (sh.reserve || 0) * ((sh[category] || 0) / nonReserve) : (sh[category] || 0);
      const cap = share * cfg.budget * cy.frac + avg;
      if (spent >= cap) return plan(`pace: ${category} spent $${spent.toFixed(2)} (${basis}) >= $${cap.toFixed(2)} allowed at ${(cy.frac * 100).toFixed(0)}% of the cycle${tag}`);
      if (category === 'review') {
        const t = c.turn.review || 0;
        const r = cfg.reviewRatio;
        const api = Math.ceil((t + 1) * r - 1e-9) > Math.ceil(t * r - 1e-9);
        c.turn.review = t + 1;
        if (!api) return plan(`alternation: review turn ${t} stays on the plan (target ${(r * 100).toFixed(0)}% api)`);
        return { decision: 'api', reason: `review turn ${t} on credits: spent $${spent.toFixed(2)} (${basis}) of $${cap.toFixed(2)} pace cap, $${(cfg.budget - total).toFixed(2)} left${tag}` };
      }
      return { decision: 'api', reason: `${category} on credits: spent $${spent.toFixed(2)} (${basis}) of $${cap.toFixed(2)} pace cap, $${(cfg.budget - total).toFixed(2)} left${tag}` };
    });
  } catch (e) {
    return plan(`failed closed: ${String((e && e.message) || e).slice(0, 120)}`);
  }
}

// --- record ----------------------------------------------------------------------------

// Every category books money that the Console bills to an API key (review and workers run on the key; overflow and rater are
// categories of the same budget), so every category needs proof that the run billed the API: apiKeySource === 'ANTHROPIC_API_KEY'
// (what the SDK init message reports for a run on the key; a subscription run reports another source). A record without it is
// refused, nothing is written to the ledger, and the attempt goes to the rejects log beside the ledger.
export const REQUIRED_API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
export const rejectsPath = (path = ledgerPath()) => join(dirname(path), 'api-credits-rejects.jsonl');
export class RecordRefused extends Error {}

function logReject(path, now, category, usd, meta, reason) {
  try {
    const rp = rejectsPath(path);
    mkdirSync(dirname(rp), { recursive: true });
    appendFileSync(rp, `${JSON.stringify({ t: new Date(now).toISOString(), cat: String(category), usd: Number.isFinite(Number(usd)) ? Number(usd) : String(usd), meta: String(meta).slice(0, 200), reason })}\n`);
  } catch { /* the refusal still stands when the log cannot be written */ }
}

// The rejects of the cycle that holds `now`: the lines of the rejects log with a time inside it.
export function rejectsInCycle({ now = Date.now(), cfg = loadConfig(), path = ledgerPath() } = {}) {
  const cy = cycleOf(now, cfg.cycleDay);
  let n = 0;
  try {
    for (const line of readFileSync(rejectsPath(path), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const t = Date.parse(JSON.parse(line).t); if (t >= cy.start && t < cy.end) n++; } catch { /* a damaged line is not counted */ }
    }
  } catch { /* no log: none */ }
  return n;
}

export function record(category, usd, meta = '', { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), success = true, detail = null, alreadyBooked = 0, count = true, id = null, apiKeySource = null } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category "${category}"`);
  if (apiKeySource !== REQUIRED_API_KEY_SOURCE) {
    const reason = apiKeySource ? `api key source "${String(apiKeySource).slice(0, 40)}" is not ${REQUIRED_API_KEY_SOURCE}` : 'no api key source: the record carries no proof that the run billed the API key';
    logReject(path, now, category, usd, meta, reason);
    throw new RecordRefused(`refused, nothing booked: ${reason}; pass --api-key-source ${REQUIRED_API_KEY_SOURCE} (CLI) or apiKeySource: '${REQUIRED_API_KEY_SOURCE}' (library) only for a run billed to the API key`);
  }
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error('usd must be a non-negative number');
  return mutate(now, cfg, path, (c) => {
    c.spent[category] = (c.spent[category] || 0) + n - (Number(alreadyBooked) || 0);
    if (count) c.n[category] = (c.n[category] || 0) + 1;
    c.entries.push({
      ...(id ? { id: String(id).slice(0, 40) } : {}), t: new Date(now).toISOString(), cat: category, usd: n, meta: String(meta).slice(0, 200),
      ...(detail ? { project: String(detail.project || '').slice(0, 80), model: String(detail.model || '').slice(0, 80), tokens: detail.tokens || null, turns: detail.turns ?? null, ...(detail.path ? { path: String(detail.path).slice(0, 20) } : {}), ...(detail.error ? { error: String(detail.error).slice(0, 200) } : {}), ...(Array.isArray(detail.notes) && detail.notes.length ? { notes: detail.notes.slice(0, 5).map((x) => String(x).slice(0, 120)) } : {}) } : {}),
    });
    if (c.entries.length > MAX_ENTRIES) c.entries.splice(0, c.entries.length - MAX_ENTRIES);
    if (success && category !== 'workers') { c.fails = 0; c.tripped = null; }
    return { spent: c.spent[category], n: c.n[category] };
  });
}

// Spend of one paid turn, booked as it happens so a killed run still leaves its cost in the
// ledger. The run's final record() passes the total with alreadyBooked set to this sum.
export function recordSpend(category, usd, { now = Date.now(), cfg = loadConfig(), path = ledgerPath() } = {}) {
  const n = Number(usd);
  if (!CATEGORIES.includes(category) || !Number.isFinite(n) || n <= 0) return;
  mutate(now, cfg, path, (c) => { c.spent[category] = (c.spent[category] || 0) + n; });
}

// A review that ended partial, failed or stopped and was redone as a plan review: marks its ledger entry (looked up by the id
// api-review.mjs printed) so the spend on it counts as double-spent. Idempotent; the reason of the first call stands unless a
// later one brings a new one. Returns { found, already, usd }.
export function recordFallback(id, reason = '', { now = Date.now(), cfg = loadConfig(), path = ledgerPath() } = {}) {
  const want = String(id || '').trim();
  if (!want) throw new Error('a review id is required');
  return mutate(now, cfg, path, (c, cy, led) => {
    for (const cyc of Object.values(led.cycles)) {
      const e = (cyc.entries || []).find((x) => x && x.id === want);
      if (!e) continue;
      const already = !!e.fallback;
      const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!already || why) e.fallback = { t: new Date(now).toISOString(), reason: why || 'unspecified' };
      return { found: true, already, usd: Number(e.usd) || 0 };
    }
    return { found: false, already: false, usd: 0 };
  });
}

// --- review statistics -------------------------------------------------------------------------

// A real review: a review-category entry that is not a probe or a measure run.
export const isRealReview = (e) => !!e && e.cat === 'review' && !/^(?:probe|measure)\b/i.test(String(e.meta || '').trim());
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const wasStopped = (e) => !!e.error || /\bpartial$/.test(String(e.meta || ''));

// Count real reviews in a list of ledger entries: n, spend, median cost, and how many were stopped (ended partial or failed) or
// fell back to a plan review (marked by record-fallback), with the spend on those.
export function summarizeReviews(entries) {
  const real = (entries || []).filter(isRealReview);
  const lost = real.filter((e) => wasStopped(e) || e.fallback);
  return {
    n: real.length, usd: real.reduce((a, e) => a + (Number(e.usd) || 0), 0), median: median(real.map((e) => Number(e.usd) || 0)),
    stopped: real.filter(wasStopped).length, fellBack: real.filter((e) => e.fallback).length,
    lost: lost.length, lostUsd: lost.reduce((a, e) => a + (Number(e.usd) || 0), 0),
  };
}

export function reviewSummaryLine(s) {
  return `${s.n} real review${s.n === 1 ? '' : 's'} ($${s.usd.toFixed(2)}), median $${s.median.toFixed(2)}; ${s.lost} stopped or fell back to a plan review ($${s.lostUsd.toFixed(2)} spent on them)`;
}

// Real-review statistics over the whole kept ledger, optionally from `since` (ms) up to `until` (ms, exclusive).
export function reviewStats({ since = null, until = null, path = ledgerPath() } = {}) {
  const all = [];
  for (const c of Object.values(readLedger(path).cycles)) all.push(...(c.entries || []));
  return summarizeReviews(all.filter((e) => { const t = Date.parse(e.t); return (since === null || t >= since) && (until === null || t < until); }));
}

// A billing or auth failure of an API run. Two in a row trip the breaker for the cycle; a hard
// failure (the workspace spend limit) trips it at once, so nothing retries against a wall.
export function recordFailure(reason, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), hard = false } = {}) {
  return mutate(now, cfg, path, (c) => {
    c.fails = (c.fails || 0) + 1;
    if (hard || c.fails >= TRIP_AFTER) c.tripped = { at: new Date(now).toISOString(), reason: String(reason).slice(0, 120) };
    return { fails: c.fails, tripped: !!c.tripped };
  });
}

// --- status ----------------------------------------------------------------------------

export function status({ now = Date.now(), cfg = loadConfig(), path = ledgerPath(), env = process.env } = {}) {
  let c = emptyCycle();
  let unreadable = null;
  const cy = cycleOf(now, cfg.cycleDay);
  try { c = { ...emptyCycle(), ...(readLedger(path).cycles[cy.key] || {}) }; } catch (e) { unreadable = String((e && e.message) || e); }
  const total = sum(c.spent);
  const sh = cfg.shares;
  const lines = [];
  lines.push(`cycle ${cy.key} (UTC, starts day ${cfg.cycleDay}): ${(cy.frac * 100).toFixed(0)}% elapsed, reserve ${cy.reserveReleased ? 'released' : `held until ${RESERVE_DAYS} days before ${new Date(cy.end).toISOString().slice(0, 10)}`}`);
  lines.push(`key: ${keyConfigured(cfg.keySource, env) ? `configured (${(parseKeySource(cfg.keySource) || {}).kind} source)` : 'not configured, so every decision is plan'}`);
  if (unreadable) lines.push(`ledger unreadable (${unreadable.slice(0, 80)}): every decision is plan`);
  for (const k of CATEGORIES) {
    const pace = (sh[k] || 0) * cfg.budget * cy.frac;
    lines.push(`${k.padEnd(9)} spent $${(c.spent[k] || 0).toFixed(2)} in ${c.n[k] || 0} item(s); share ${(sh[k] * 100).toFixed(0)}% = $${(sh[k] * cfg.budget).toFixed(2)}; paced allowance now $${pace.toFixed(2)}`);
  }
  { const rj = rejectsInCycle({ now, cfg, path }); if (rj > 0) lines.push(`REJECTED records this cycle: ${rj} (see ${rejectsPath(path)}): callers tried to book spend without proof of an API-billed run`); }
  if (!unreadable) lines.push(`real reviews this cycle: ${reviewSummaryLine(summarizeReviews(c.entries))}`);
  lines.push(`total spent $${total.toFixed(2)} of $${cfg.budget}; left $${(cfg.budget - total).toFixed(2)} (reserve $${((sh.reserve || 0) * cfg.budget).toFixed(2)})`);
  { const w = sharesWarning(sh); if (w) lines.push(w); }
  if (c.tripped) lines.push(`BREAKER TRIPPED ${c.tripped.at}: ${c.tripped.reason}; decide answers plan until the cycle ends or a probe succeeds`);
  else if (c.fails) lines.push(`${c.fails} billing/auth failure(s) in a row (trips at ${TRIP_AFTER})`);
  return { text: lines.join('\n'), total, cycle: cy, ledger: c };
}

// One line for the daily checkup or a brief: "API credits: reviews $X of $100, cycle day N".
export function summaryLine({ now = Date.now(), cfg = loadConfig(), path = ledgerPath() } = {}) {
  const cy = cycleOf(now, cfg.cycleDay);
  let spent = 0;
  try { spent = (readLedger(path).cycles[cy.key] || { spent: {} }).spent.review || 0; } catch { /* unreadable: shows $0 */ }
  const day = Math.floor((now - cy.start) / DAY_MS) + 1;
  return `API credits: reviews $${spent.toFixed(2)} of $${((cfg.shares.review || 0) * cfg.budget).toFixed(0)}, cycle day ${day}`;
}

// --- billed spend report (`status`) -------------------------------------------------------------------------

const usd2 = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
const iso = (ms) => new Date(ms).toISOString();
const group = (rows, keyFn, valFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + valFn(r)); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const tokensOf = (r) => (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
const model5 = (m) => String(m || 'unknown').replace(/^claude-/, '');

// Gaps between what the ledger booked and what Anthropic billed. Tolerance (the total and each workspace): the larger of $1 and 10% of billed.
export function billingGaps(snap, { cfg, cy, entries, now }) {
  const out = { over: [], unbilled: [], unmatched: { n: 0, usd: 0, examples: [] }, checked: false };
  const tol = (billed) => Math.max(1, 0.1 * billed);
  const booked = (cats) => bookedBetween(entries, cy.start, snap.through, cats);
  const total = { scope: 'all categories', booked: booked(null), billed: billedSince(snap, cy.start) };
  if (total.booked - total.billed > tol(total.billed)) out.over.push({ ...total, over: total.booked - total.billed });
  // Per workspace: every category routed to it, mapped or not. A category with no mapped workspace (overflow and rater by default)
  // is held to the default workspace, so its booked spend counts against that workspace's billed cost; comparing category by
  // category let review's billed cost on the default workspace hide overflow booked next to it. Both sides stop at the snapshot
  // cut-off (the end of the last complete UTC day), so the current day, which Console cost data has not reported yet, is left out.
  const byWs = new Map();
  for (const cat of CATEGORIES) {
    const ref = (cfg.categoryWorkspaces || {})[cat];
    const id = ref ? resolveWorkspace(snap, ref) : '';
    if (id === null) continue;
    byWs.set(id, [...(byWs.get(id) || []), cat]);
  }
  for (const [id, cats] of byWs) {
    const row ={ scope: `workspace ${workspaceName(snap, id)}`, booked: booked(cats), billed: billedSince(snap, cy.start, id) };
    if (row.booked - row.billed > tol(row.billed)) out.over.push({ ...row, over: row.booked - row.billed });
  }
  // A category that booked spend this cycle (through the cut-off) while its workspace has no billed cost at all. A category with
  // no mapped workspace (overflow and rater by default) was skipped by the loop above, which is why "gaps: none" hid a category
  // booked on a workspace with no billing; it is held to the default workspace. One mapped to a name the snapshot does not
  // know is skipped (status says so elsewhere).
  for (const cat of CATEGORIES) {
    const ref = (cfg.categoryWorkspaces || {})[cat];
    const ws = ref ? resolveWorkspace(snap, ref) : '';
    if (ws === null) continue;
    const bk = booked([cat]);
    if (bk > 0 && billedSince(snap, cy.start, ws) <= 0) out.unbilled.push({ cat, booked: bk, ws: workspaceName(snap, ws), mapped: !!ref });
  }
  if (Array.isArray(snap.hourly) && Number.isFinite(snap.hourlyFrom)) {
    out.checked = true;
    const have = new Set(snap.hourly.map((h) => `${h.ws}|${h.hour}`));
    const wsOfCat = {};
    for (const [cat, ref] of Object.entries(cfg.categoryWorkspaces || {})) wsOfCat[cat] = resolveWorkspace(snap, ref);
    for (const e of entries || []) {
      const at = tOf(e);
      const ws = wsOfCat[e.cat];
      if (!(at >= snap.hourlyFrom + HOUR_MS && at <= now) || ws === null || ws === undefined || !(Number(e.usd) > 0)) continue;
      const h = Math.floor(at / HOUR_MS) * HOUR_MS;
      // A run is booked when it ends, so its requests fall in that hour or the one before.
      if (have.has(`${ws}|${h}`) || have.has(`${ws}|${h - HOUR_MS}`)) continue;
      out.unmatched.n += 1;
      out.unmatched.usd += Number(e.usd) || 0;
      if (out.unmatched.examples.length < 5) out.unmatched.examples.push(`${iso(at).slice(0, 16)}Z ${e.cat} ${usd2(e.usd)}`);
    }
  }
  return out;
}

function periodLines(snap, label, fromMs, { cfg, entries, cy }) {
  const billed = billedSince(snap, fromMs);
  const bookedAll = bookedBetween(entries, fromMs, snap.through);
  const lines = [`${label}: billed ${usd2(billed)} through ${iso(snap.through - 1).slice(0, 10)} (complete UTC days) | booked ${usd2(bookedAll)} in the same days`];
  const rows = (snap.cost || []).filter((r) => dayMs(r.day) >= fromMs);
  const byWs = group(rows, (r) => r.ws, (r) => Number(r.usd) || 0);
  if (byWs.length) {
    lines.push('  by workspace: ' + byWs.map(([id, v]) => {
      const name = workspaceName(snap, id);
      const lim = limitFor(cfg, name, id);
      return `${name} ${usd2(v)}${lim !== null && label.startsWith('calendar month') ? ` of $${lim.toFixed(2)} limit (${pct(v, lim)})` : ''}`;
    }).join(', '));
  }
  const byModel = group(rows, (r) => model5(r.model), (r) => Number(r.usd) || 0);
  if (byModel.length) lines.push('  by model: ' + byModel.map(([m, v]) => `${m} ${usd2(v)}`).join(', '));
  if (Array.isArray(snap.usage)) {
    const u = snap.usage.filter((r) => dayMs(r.day) >= fromMs);
    const byKey = group(u, (r) => (snap.keys && snap.keys[r.key]) || r.key || 'unknown key', (r) => tokensOf(r));
    if (byKey.length) {
      lines.push('  by key (tokens; est = list price): ' + byKey.map(([k, t]) => {
        const est = u.filter((r) => ((snap.keys && snap.keys[r.key]) || r.key || 'unknown key') === k)
          .reduce((a, r) => { const p = priceUsage({ input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }, r.model); return a + (p ? p.usd : 0); }, 0);
        return `${k} ${(t / 1e6).toFixed(2)}M tokens, est ${usd2(est)}`;
      }).join('; '));
    }
  } else lines.push('  by key: not available (usage report could not be read)');
  return lines;
}

// The billed-spend section of `status`. snap = null: the fallback line only.
export function billingStatusLines(snap, { cfg, entries, now, reason = '', cacheAgeMs = null }) {
  if (!snap) return [`billing: ${BOOKED_ONLY}${reason ? ` (${reason})` : ''}; the figures above are what runs booked for themselves`];
  const cy = cycleOf(now, cfg.cycleDay);
  const monthStart = monthStartOf(now);
  const lines = [`billing (Admin API${cacheAgeMs === null ? '' : `, ${cacheAgeMs < 90000 ? 'fetched now' : `cached ${Math.round(cacheAgeMs / 60000)} min ago`}`}); cost data lags up to a day, so the last complete UTC day is ${iso(snap.through - 1).slice(0, 10)}`];
  lines.push(...periodLines(snap, `calendar month ${iso(monthStart).slice(0, 7)}`, monthStart, { cfg, entries, cy }));
  if (cy.start !== monthStart) lines.push(...periodLines(snap, `credit cycle from ${iso(cy.start).slice(0, 10)}`, cy.start, { cfg, entries, cy }));
  const billedCycle = billedSince(snap, cy.start);
  const win = bookedBetween(entries, Math.max(snap.through, cy.start));
  lines.push(`credits left (estimate) = monthly plan credit $${cfg.budget} - billed this cycle ${usd2(billedCycle)} = ${usd2(cfg.budget - billedCycle)}; minus ${usd2(win)} booked since the last complete day = ${usd2(cfg.budget - billedCycle - win)} (cost is before credits; the Console Billing page shows the real balance)`);
  for (const [cat, w] of Object.entries(cfg.categoryWorkspaces || {})) if (resolveWorkspace(snap, w) === null) lines.push(`category ${cat}: workspace ${w} not found, booked spend only`);
  const wsMonth = [];
  for (const [name, lim] of Object.entries(cfg.workspaceLimits || {})) {
    const id = /^wrkspc_/.test(name) ? name : resolveWorkspace(snap, name);
    const billed = id === null ? 0 : billedSince(snap, monthStart, id);
    const unk = id === null ? ' (no such workspace in the organization)' : '';
    wsMonth.push(`${name} ${usd2(billed)} of $${lim.toFixed(2)} (${pct(billed, lim)})${billed >= lim ? ' AT OR OVER LIMIT: decide answers plan for its categories' : ''}${unk}`);
  }
  lines.push(wsMonth.length ? `workspace limits (calendar month, billed): ${wsMonth.join('; ')}` : 'workspace limits: none configured (api_credits_workspace_limits; the API cannot read the Console limits)');
  const g = billingGaps(snap, { cfg, cy, entries, now });
  for (const o of g.over) lines.push(`GAP: ${o.scope}: booked ${usd2(o.booked)} but billed ${usd2(o.billed)} (booked over billed by ${usd2(o.over)}; booked spend that never reached the API?)`);
  for (const u of g.unbilled) lines.push(`GAP: category ${u.cat}: booked ${usd2(u.booked)} this cycle but the Console shows no billed cost on its workspace ${u.ws}${u.mapped ? '' : ' (no workspace mapped, so the default one)'}; booked spend that never reached the API?`);
  if (g.unmatched.n) lines.push(`GAP: ${g.unmatched.n} booked entr${g.unmatched.n === 1 ? 'y' : 'ies'} (${usd2(g.unmatched.usd)}) with no usage on their workspace in that hour: ${g.unmatched.examples.join(', ')}${g.unmatched.n > g.unmatched.examples.length ? ', ...' : ''}`);
  else if (g.checked) lines.push('hourly check: every booked entry in the last days has usage on its workspace in its hour');
  else lines.push('hourly check: not available (hourly usage could not be read)');
  if (!g.over.length && !g.unbilled.length && !g.unmatched.n) lines.push('gaps: none');
  if (Array.isArray(snap.missing) && snap.missing.length) lines.push(`not fetched: ${snap.missing.join(', ')}`);
  return lines;
}
