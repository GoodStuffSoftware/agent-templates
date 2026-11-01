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

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { opt, stateFile } from '../../hooks/lib/context.mjs';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';
import { spawnSyncHidden } from './proc.mjs';

export const CATEGORIES = ['review', 'overflow', 'rater'];
export const DEFAULT_SHARES = { review: 0.5, overflow: 0.3, rater: 0.1, reserve: 0.1 };
export const RESERVE_DAYS = 3;
export const DEFAULT_KEY_SOURCE = 'env:AC_API_KEY';
export const TRIP_AFTER = 2; // billing/auth failures in a row
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

// --- decide ----------------------------------------------------------------------------

export function decide(category, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), env = process.env } = {}) {
  const plan = (reason) => ({ decision: 'plan', reason });
  try {
    if (!CATEGORIES.includes(category)) return plan(`unknown category "${category}"`);
    if (!keyConfigured(cfg.keySource, env)) return plan('no API key configured (set api_credits_key_source and the variable it names)');
    return mutate(now, cfg, path, (c, cy) => {
      if (c.tripped) return plan(`API runs failed ${c.fails} ${c.fails === 1 ? 'time' : 'times'} in a row this cycle (${c.tripped.reason}); plan until the cycle ends or a probe succeeds`);
      const sh = cfg.shares;
      const nonReserve = CATEGORIES.reduce((a, k) => a + (sh[k] || 0), 0) || 1;
      const pool = cfg.budget * (cy.reserveReleased ? 1 : 1 - (sh.reserve || 0));
      const total = sum(c.spent);
      const spent = c.spent[category] || 0;
      const cnt = c.n[category] || 0;
      const avg = cnt > 0 ? spent / cnt : cfg.itemEstimate;
      if (pool - total < avg) return plan(`balance: $${(cfg.budget - total).toFixed(2)} left of $${cfg.budget}${cy.reserveReleased ? '' : ', the rest is the held reserve'}`);
      const share = cy.reserveReleased ? (sh[category] || 0) + (sh.reserve || 0) * ((sh[category] || 0) / nonReserve) : (sh[category] || 0);
      const cap = share * cfg.budget * cy.frac + avg;
      if (spent >= cap) return plan(`pace: ${category} spent $${spent.toFixed(2)} >= $${cap.toFixed(2)} allowed at ${(cy.frac * 100).toFixed(0)}% of the cycle`);
      if (category === 'review') {
        const t = c.turn.review || 0;
        const r = cfg.reviewRatio;
        const api = Math.ceil((t + 1) * r - 1e-9) > Math.ceil(t * r - 1e-9);
        c.turn.review = t + 1;
        if (!api) return plan(`alternation: review turn ${t} stays on the plan (target ${(r * 100).toFixed(0)}% api)`);
        return { decision: 'api', reason: `review turn ${t} on credits: spent $${spent.toFixed(2)} of $${cap.toFixed(2)} pace cap, $${(cfg.budget - total).toFixed(2)} left` };
      }
      return { decision: 'api', reason: `${category} on credits: spent $${spent.toFixed(2)} of $${cap.toFixed(2)} pace cap, $${(cfg.budget - total).toFixed(2)} left` };
    });
  } catch (e) {
    return plan(`failed closed: ${String((e && e.message) || e).slice(0, 120)}`);
  }
}

// --- record ----------------------------------------------------------------------------

export function record(category, usd, meta = '', { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), success = true, detail = null, alreadyBooked = 0, count = true } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category "${category}"`);
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error('usd must be a non-negative number');
  return mutate(now, cfg, path, (c) => {
    c.spent[category] = (c.spent[category] || 0) + n - (Number(alreadyBooked) || 0);
    if (count) c.n[category] = (c.n[category] || 0) + 1;
    c.entries.push({
      t: new Date(now).toISOString(), cat: category, usd: n, meta: String(meta).slice(0, 200),
      ...(detail ? { project: String(detail.project || '').slice(0, 80), model: String(detail.model || '').slice(0, 80), tokens: detail.tokens || null, turns: detail.turns ?? null, ...(detail.error ? { error: String(detail.error).slice(0, 200) } : {}) } : {}),
    });
    if (c.entries.length > MAX_ENTRIES) c.entries.splice(0, c.entries.length - MAX_ENTRIES);
    if (success) { c.fails = 0; c.tripped = null; }
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
  lines.push(`total spent $${total.toFixed(2)} of $${cfg.budget}; left $${(cfg.budget - total).toFixed(2)} (reserve $${((sh.reserve || 0) * cfg.budget).toFixed(2)})`);
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
