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
// can be wrong (for example it can read $90.00 where Anthropic billed $40.00). So `decide`
// and `status` take a billing snapshot (scripts/lib/api-spend.mjs fetches and caches it from
// the Admin API; this file stays free of the network) and rest on BILLED spend, plus booked
// spend only for the window after the last complete billed UTC day. Without a snapshot they
// fall back to booked figures and say so (BOOKED_ONLY). Per-workspace monthly limits are a
// config map because the API cannot read them back.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { opt, stateFile, telemetryDir, tailRecords } from '../../hooks/lib/context.mjs';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';
import { spawnSyncHidden } from './proc.mjs';
import { priceUsage } from './pricing.mjs';

export const CATEGORIES = ['review', 'overflow', 'rater', 'workers'];
// Sum 1.0. review keeps the largest share; workers is a real spender now; overflow and rater are reserved and barely used.
export const DEFAULT_SHARES = { review: 0.5, overflow: 0.1, rater: 0.05, workers: 0.3, reserve: 0.05 };
export const RESERVE_DAYS = 3;
// Budget mode (0.31.79). Default 'credit': gating follows the remaining prepaid credit (balance anchor minus billed since) minus a
// small reserve, wherever an anchor exists; a fixed number goes stale as credit moves (top-ups, other spend). 'fixed' keeps the old
// fixed-budget gating. Reserve default $5: about one failed-late worker run of headroom so the balance is not driven to exactly zero.
export const DEFAULT_BUDGET_MODE = 'credit';
export const DEFAULT_RESERVE_USD = 5;
export const DEFAULT_KEY_SOURCE = 'env:AC_API_KEY';
export const DEFAULT_BWS_TOKEN_SOURCE = 'env:BWS_ACCESS_TOKEN';
const BWS_TOKEN_ENV = 'BWS_ACCESS_TOKEN';
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
    const n = Number(part.slice(i + 1).replace(/^\$/, '').replace(/!$/, ''));
    if (Number.isFinite(n) && n > 0) out[part.slice(0, i)] = n;
  }
  return out;
}

// The names in api_credits_workspace_limits written with a trailing ! ("workers=50!"): a limit the operator mirrors from a real
// Console limit on purpose. In credit mode only these stop API work; the others are advisory while an anchor shows credit left.
export function parseWorkspaceLimitHard(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const i = part.lastIndexOf('=');
    if (i < 1 || !/!$/.test(part)) continue;
    const n = Number(part.slice(i + 1).replace(/^\$/, '').replace(/!$/, ''));
    if (Number.isFinite(n) && n > 0) out[part.slice(0, i)] = true;
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

// --- named API targets (0.31.72) ----------------------------------------------------------
// A target is a place API work can be billed: a key source, an optional workspace id (sent as the
// anthropic-workspace-id header only when set), an optional admin key source (cost data) and an optional monthly budget,
// with its own breaker and budget lane in the ledger. The built-in target "primary" is today's setup (api_credits_key_source
// plus the AC_API_WORKSPACE_ID / AC_API_WORKERS_WORKSPACE_ID workspaces); with api_targets and api_category_targets unset
// nothing else exists and behaviour is unchanged. api_targets is JSON: {"name":{"key":"bws:secret","workspace":"","admin":"bws:secret","budget":50}}.
export const PRIMARY = 'primary';
const TARGET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export class TargetError extends Error {}

export function parseTargets(raw) {
  const targets = {};
  const errors = [];
  const s = String(raw ?? '').trim();
  if (!s) return { targets, errors };
  let j = null;
  try { j = JSON.parse(s); } catch { errors.push('api_targets is not valid JSON'); }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    for (const [k, v] of Object.entries(j)) {
      const name = String(k).trim().toLowerCase();
      if (!TARGET_NAME_RE.test(name)) { errors.push(`target name "${String(k).slice(0, 40)}" is not allowed (a-z, 0-9, _ -)`); continue; }
      if (name === PRIMARY) { errors.push('target "primary" is built in (api_credits_key_source) and cannot be redefined'); continue; }
      const key = String((v && v.key) || '').trim();
      if (!parseKeySource(key)) { errors.push(`target ${name}: key must be env:<NAME> or bws:<secret-name>`); continue; }
      const workspace = String((v && v.workspace) || '').trim();
      if (workspace && !/^[A-Za-z0-9_.-]+$/.test(workspace)) { errors.push(`target ${name}: workspace id is malformed`); continue; }
      const b = Number(v && v.budget);
      targets[name] = { name, keySource: key, workspace, admin: String((v && v.admin) || '').trim(), budget: Number.isFinite(b) && b > 0 ? b : null };
    }
  } else if (j !== null) errors.push('api_targets must be a JSON object of targets');
  return { targets, errors };
}

// "category=target,target category=target" -> { category: [target, ...] } (ordered: the first is the default, later ones are failover).
export function parseCategoryTargets(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(/[;\s]+/).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1 || i === part.length - 1) continue;
    const list = [...new Set(part.slice(i + 1).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (list.length) out[part.slice(0, i).toLowerCase()] = list;
  }
  return out;
}

const builtinPrimary = (cfg) => ({ name: PRIMARY, keySource: cfg.keySource, workspace: '', admin: '', budget: cfg.budget, builtin: true });

// The ordered targets a job of `category` may use. `explicit` (--target, or an `API: target=` brief line) starts the list at that
// target: used as given, its failover only the targets listed after it for the category. An unknown name throws a TargetError.
export function resolveTargets(category, cfg, explicit = null) {
  const targets = cfg.targets || { [PRIMARY]: builtinPrimary(cfg) };
  const configured = (cfg.categoryTargets || {})[category];
  const list = configured && configured.length ? configured : [PRIMARY];
  const known = () => Object.keys(targets).join(', ');
  for (const n of list) if (!targets[n]) throw new TargetError(`api_category_targets names an unknown target "${n}" for ${category} (known: ${known()})`);
  let names = list;
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== '') {
    const n = String(explicit).trim().toLowerCase();
    if (!targets[n]) throw new TargetError(`unknown target "${String(explicit).slice(0, 40)}" (known: ${known()})`);
    const at = list.indexOf(n);
    names = at < 0 ? [n] : list.slice(at);
  }
  return names.map((n) => targets[n]);
}

export const targetOf = (cfg, name) => ((cfg && cfg.targets) || {})[name || PRIMARY] || builtinPrimary(cfg);

export function loadConfig(o = opt) {
  const day = Math.floor(Number(o('api_credits_cycle_day', 1)));
  const budget = Number(o('api_credits_budget_usd', 200));
  const ratio = Number(o('api_credits_review_ratio', 0.5));
  const est = Number(o('api_credits_item_estimate_usd', 2));
  const tp = parseTargets(o('api_targets', ''));
  return {
    budget: Number.isFinite(budget) && budget > 0 ? budget : 200,
    cycleDay: day >= 1 && day <= 28 ? day : 1,
    shares: parseShares(o('api_credits_shares', '')),
    keySource: String(o('api_credits_key_source', DEFAULT_KEY_SOURCE) || '').trim(),
    reviewRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5,
    itemEstimate: Number.isFinite(est) && est > 0 ? est : 2,
    workspaceLimits: parseWorkspaceLimits(o('api_credits_workspace_limits', '')),
    workspaceLimitHard: parseWorkspaceLimitHard(o('api_credits_workspace_limits', '')),
    // 0.31.79: what gates. 'credit' (default): an account with a balance anchor is gated by its remaining credit minus the reserve;
    // an account with no anchor keeps its fixed budget. 'fixed': the fixed budgets gate every account, anchors only inform.
    budgetMode: String(o('api_credits_budget_mode', DEFAULT_BUDGET_MODE) || '').trim().toLowerCase() === 'fixed' ? 'fixed' : 'credit',
    reserveUsd: Number.isFinite(Number(o('api_credits_reserve_usd', DEFAULT_RESERVE_USD))) && Number(o('api_credits_reserve_usd', DEFAULT_RESERVE_USD)) >= 0 ? Number(o('api_credits_reserve_usd', DEFAULT_RESERVE_USD)) : DEFAULT_RESERVE_USD,
    budgetSource: Number(o('api_credits_budget_usd', 200)) === 200 ? 'api_credits_budget_usd, shipped default 200 = the Ultra plan monthly credit' : 'api_credits_budget_usd, set by the operator',
    categoryWorkspaces: { ...DEFAULT_CATEGORY_WORKSPACES, ...parseCategoryWorkspaces(o('api_credits_category_workspaces', '')) },
    targets: { [PRIMARY]: { name: PRIMARY, keySource: String(o('api_credits_key_source', DEFAULT_KEY_SOURCE) || '').trim(), workspace: '', admin: '', budget: Number.isFinite(budget) && budget > 0 ? budget : 200, builtin: true }, ...tp.targets },
    bwsTokenSource: String(o('api_bws_token_source', DEFAULT_BWS_TOKEN_SOURCE) || '').trim() || DEFAULT_BWS_TOKEN_SOURCE,
    categoryTargets: parseCategoryTargets(o('api_category_targets', '')),
    targetErrors: tp.errors,
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

// The Bitwarden access token (0.31.73, option api_bws_token_source): "env:NAME" (default env:BWS_ACCESS_TOKEN) or "file:<path>"
// (a leading ~ is the home directory; the file is read here, in this process, and trimmed). With a file source the
// BWS_ACCESS_TOKEN variable, when set, wins over the file. Errors name the source, never the value. The token goes only to the
// bws child's environment (resolveKey).
export function parseTokenSource(src) {
  const m = /^(env|file):(.+)$/.exec(String(src || '').trim() || DEFAULT_BWS_TOKEN_SOURCE);
  return m && m[2].trim() ? { kind: m[1], name: m[2].trim() } : null;
}
const homePath = (p) => (p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);
const keyFailure = (msg) => Object.assign(new Error(msg), { keyFailure: true });
// Decodes a token file's bytes: a UTF-16 BOM (what Windows PowerShell 5.1 `>` and Out-File write) or an unmarked UTF-16 pattern
// (ASCII text with a NUL in every other byte) decodes as UTF-16; anything else is UTF-8 (a UTF-8 BOM is stripped by trim).
function decodeTokenBytes(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  if (b.length >= 2 && b.length % 2 === 0 && b[0] !== 0 && b[1] === 0) return b.toString('utf16le');
  if (b.length >= 2 && b.length % 2 === 0 && b[0] === 0 && b[1] !== 0) return Buffer.from(b).swap16().toString('utf16le');
  return b.toString('utf8');
}
// A token holds no NUL or other control character (Node would quote part of it in a spawn error); messages name the source only.
const PLAIN_TOKEN = /^[^\u0000-\u001f\u007f]+$/;
export function bwsToken(env = process.env, tokenSource = undefined) {
  const src = tokenSource === undefined ? opt('api_bws_token_source', DEFAULT_BWS_TOKEN_SOURCE) : tokenSource;
  const p = parseTokenSource(src);
  if (!p) throw keyFailure('api_bws_token_source must be env:<NAME> or file:<path>');
  if (p.kind === 'env') {
    if (!env[p.name]) throw keyFailure(`${p.name} is not set`);
    const ev = String(env[p.name]).trim(); // a trailing newline in a variable passed before; keep passing
    if (!ev || !PLAIN_TOKEN.test(ev)) throw keyFailure(`${p.name} is not a plain-text token`);
    return ev;
  }
  if (env[BWS_TOKEN_ENV]) {
    const ev = String(env[BWS_TOKEN_ENV]).trim();
    if (!ev || !PLAIN_TOKEN.test(ev)) throw keyFailure(`${BWS_TOKEN_ENV} is not a plain-text token`);
    return ev;
  }
  if (!/^~([\\/]|$)/.test(p.name) && !isAbsolute(p.name)) throw keyFailure(`Bitwarden token file path must be absolute or start with ~ (file:${p.name})`);
  let v;
  try { v = decodeTokenBytes(readFileSync(homePath(p.name))).trim(); } catch { throw keyFailure(`Bitwarden token file is missing or unreadable (file:${p.name})`); }
  if (!v) throw keyFailure(`Bitwarden token file is empty (file:${p.name})`);
  if (!PLAIN_TOKEN.test(v)) throw keyFailure(`Bitwarden token file is not plain text (file:${p.name})`);
  return v;
}

// Cheap presence check for `decide`: the source is well formed and the thing it
// reads from is set. Never returns the key's or the token's value.
export function keyConfigured(src, env = process.env, tokenSource = undefined) {
  const p = parseKeySource(src);
  if (!p || !p.name) return false;
  if (p.kind === 'env') return !!env[p.name];
  try { return !!bwsToken(env, tokenSource); } catch { return false; }
}

// A key-lookup failure that is the configuration's fault (bws failed, no such secret): the runner
// counts it toward the two-strikes breaker, like a billing or auth failure. keyFailure: the run never started, so a
// caller with another target may move on to it.
const keyError = (msg) => Object.assign(new Error(msg), { configFailure: true, keyFailure: true });

// The key itself. Runner only. Throws a message that never contains the key.
export function resolveKey(src, env = process.env, tokenSource = undefined) {
  const p = parseKeySource(src);
  if (!p || !p.name) throw keyFailure('no key source configured');
  if (p.kind === 'env') {
    const v = env[p.name];
    if (!v) throw keyFailure(`environment variable ${p.name} is not set`);
    return v;
  }
  const token = bwsToken(env, tokenSource);
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.name);
  const args = isId ? ['secret', 'get', p.name, '-o', 'json'] : ['secret', 'list', '-o', 'json'];
  let r;
  // Any throw from the spawn (Node's TypeError can quote the env value) becomes a fixed text with no value.
  try { r = spawnSyncHidden(process.env.AGENT_COMPANION_BWS_BIN || 'bws', args, { env: { ...env, [BWS_TOKEN_ENV]: token }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); } catch { throw keyError('bws could not be started'); }
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
const limitMatch = (cfg, name, id, extraNames = []) => {
  const names = [name, ...extraNames].filter((n) => n !== null && n !== undefined).map((n) => String(n).toLowerCase());
  for (const [k, v] of Object.entries(cfg.workspaceLimits || {})) {
    if (k === id || names.includes(k.toLowerCase())) return [k, v];
  }
  return null;
};
const limitFor = (cfg, name, id, extraNames = []) => { const m = limitMatch(cfg, name, id, extraNames); return m ? m[1] : null; };
// 0.31.79: true when the limit was written "name=usd!" (mirrors a real Console limit on purpose).
export const limitHardFor = (cfg, name, id, extraNames = []) => { const m = limitMatch(cfg, name, id, extraNames); return !!(m && (cfg.workspaceLimitHard || {})[m[0]]); };

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
    return { verified: false, wsName: wsRef || null, limit: wsRef ? limitFor(cfg, wsRef, wsRef, [category]) : null, limitHard: wsRef ? limitHardFor(cfg, wsRef, wsRef, [category]) : false, wsMonth: bookedBetween(entries, monthStart, Infinity, cats) };
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
    limitHard: wsRef ? limitHardFor(cfg, name, wsId, [category]) : false,
    wsMonth: (wsId === null ? 0 : billedSince(snap, monthStart, wsId)) + bookedBetween(entries, Math.max(snap.through, monthStart), Infinity, cats),
    through: snap.through,
  };
}

// --- decide ----------------------------------------------------------------------------
//
// With a billing snapshot the figures are billed spend through the last complete UTC day plus the booked spend after it.
// Without one (no admin key, no network) they are the booked figures and every reason says so.

// `peek` (0.31.63): answer without advancing the review alternation counter (turn.review), so status and diagnostics
// never flip the next real routing decision. Only the spawn guard's call (and a writer's manual path) advances it.
export function decide(category, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), env = process.env, billing = null, peek = false, target = null } = {}) {
  const plan = (reason) => ({ decision: 'plan', reason });
  try {
    if (!CATEGORIES.includes(category)) return plan(`unknown category "${category}"`);
    // 0.31.72: the category's ordered targets (primary only, unless api_category_targets or an explicit target says otherwise).
    // Each has its own lane; a cap or credit "plan" answer (or a missing key) moves on to the next, alternation is applied once
    // to whichever target takes the run (and not at all for an explicit target). With the options unset the chain is
    // [primary] and every answer below is the one this function always gave.
    const chain = resolveTargets(category, cfg, target);
    const explicit = target !== null && target !== undefined && String(target).trim() !== '';
    const reasons = [];
    const usable = [];
    for (const t of chain) {
      if (keyConfigured(t.keySource, env, cfg.bwsTokenSource)) usable.push(t);
      else reasons.push(t.name === PRIMARY ? 'no API key configured (set api_credits_key_source and the variable it names)' : `target ${t.name}: no API key available (check its key source)`);
    }
    const joined = () => reasons.join('; then ');
    if (!usable.length) return plan(joined());
    return mutate(now, cfg, path, (c, cy) => {
      let hit = null;
      for (const t of usable) {
        const r = t.name === PRIMARY ? evalPrimary(category, { cfg, c, cy, billing, now }) : evalNamed(category, t, { c });
        if (r.api) { hit = { t, tail: r.tail }; break; }
        reasons.push(t.name === PRIMARY ? r.reason : `target ${t.name}: ${r.reason}`);
      }
      if (!hit) return plan(joined());
      const via = hit.t.name === PRIMARY ? '' : ` via ${hit.t.name}`;
      // The answer names the target unless it is the primary AND the list starts at the primary (the old, unset-options shape): a list
      // that starts elsewhere (review=spare,primary) would otherwise run the primary answer on its first entry.
      const tgt = hit.t.name === PRIMARY && chain[0].name === PRIMARY ? {} : { target: hit.t.name };
      if (category === 'review' && !explicit) {
        const t = c.turn.review || 0;
        const r = cfg.reviewRatio;
        const api = Math.ceil((t + 1) * r - 1e-9) > Math.ceil(t * r - 1e-9);
        if (!peek) c.turn.review = t + 1;
        if (!api) return plan(`alternation: review turn ${t} stays on the plan (target ${(r * 100).toFixed(0)}% api)`);
        return { decision: 'api', reason: `review turn ${t} on credits${via}: ${hit.tail}`, ...tgt };
      }
      return { decision: 'api', reason: `${category} on credits${via}${explicit ? ' (explicit target)' : ''}: ${hit.tail}`, ...tgt };
    });
  } catch (e) {
    return plan(`failed closed: ${String((e && e.message) || e).slice(0, 120)}`);
  }
}

// A named target's lane in the cycle (the primary lane is the cycle's top level, so existing ledgers read unchanged).
export const laneOf = (c, name) => (!name || name === PRIMARY ? c : ((c.lanes ||= {})[name] ||= { spent: {}, n: {}, fails: 0, tripped: null }));
export const entriesOf = (entries, name) => (entries || []).filter((e) => (e.target || PRIMARY) === (name || PRIMARY));

// The primary lane: the governor as it was before targets (billing snapshot, pace, reserve, workspace limit, breaker).
function evalPrimary(category, { cfg, c, cy, billing, now }) {
  const plan = (reason) => ({ api: false, reason });
  if (c.tripped) return plan(`API runs failed ${c.fails} ${c.fails === 1 ? 'time' : 'times'} in a row this cycle (${c.tripped.reason}); plan until the cycle ends or a probe succeeds`);
  const sh = cfg.shares;
  const view = spendView(billing, category, { cfg, cy, entries: entriesOf(c.entries, PRIMARY), now });
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
  return { api: true, tail: `spent $${spent.toFixed(2)} (${basis}) of $${cap.toFixed(2)} pace cap, $${(cfg.budget - total).toFixed(2)} left${tag}` };
}

// A named target's lane: its own breaker and booked spend; its optional budget is a plain ceiling (no pacing: a failover target
// is for the runs the earlier targets could not take). No budget set: only its breaker and the provider's own limits bound it.
function evalNamed(category, t, { c }) {
  const L = laneOf(c, t.name);
  if (L.tripped) return { api: false, reason: `API runs failed ${L.fails} ${L.fails === 1 ? 'time' : 'times'} in a row this cycle (${L.tripped.reason}); plan until the cycle ends or a probe succeeds` };
  const total = sum(L.spent);
  const spent = L.spent[category] || 0;
  if (t.budget) {
    const cnt = L.n[category] || 0;
    const avg = cnt > 0 ? spent / cnt : 0;
    if (t.budget - total <= avg) return { api: false, reason: `balance: $${Math.max(0, t.budget - total).toFixed(2)} left of $${t.budget} (booked)` };
  }
  return { api: true, tail: `spent $${spent.toFixed(2)} (booked)${t.budget ? `, $${(t.budget - total).toFixed(2)} left of $${t.budget}` : ', no budget set'}` };
}

// --- record ----------------------------------------------------------------------------

// Every category books money that the Console bills to an API key (review and workers run on the key; overflow and rater are
// categories of the same budget), so every category needs proof that the run billed the API: apiKeySource === 'ANTHROPIC_API_KEY'
// (what the SDK init message reports for a run on the key; a subscription run reports another source). A record without it is
// refused, nothing is written to the ledger, and the attempt goes to the rejects log beside the ledger.
export const REQUIRED_API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
export const rejectsPath = (path = ledgerPath()) => join(dirname(path), 'api-credits-rejects.jsonl');
export class RecordRefused extends Error {}

// The rejects log is capped: past REJECTS_MAX_BYTES (64 KiB) it is cut back to its newest lines that fit in REJECTS_KEEP_BYTES (32 KiB),
// so a runaway caller cannot grow it without bound. The current cycle's count (rejectsInCycle) reads what is left.
export const REJECTS_MAX_BYTES = 64 * 1024;
export const REJECTS_KEEP_BYTES = 32 * 1024;

function trimRejects(rp) {
  if (statSync(rp).size <= REJECTS_MAX_BYTES) return;
  const lines = readFileSync(rp, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const keep = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(lines[i]) + 1;
    if (bytes > REJECTS_KEEP_BYTES && keep.length) break;
    keep.unshift(lines[i]);
  }
  const tmp = `${rp}.tmp`;
  writeFileSync(tmp, `${keep.join('\n')}\n`);
  renameSync(tmp, rp);
}

function logReject(path, now, category, usd, meta, reason) {
  try {
    const rp = rejectsPath(path);
    mkdirSync(dirname(rp), { recursive: true });
    appendFileSync(rp, `${JSON.stringify({ t: new Date(now).toISOString(), cat: String(category), usd: Number.isFinite(Number(usd)) ? Number(usd) : String(usd), meta: String(meta).slice(0, 200), reason })}\n`);
    trimRejects(rp);
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

export function record(category, usd, meta = '', { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), success = true, detail = null, alreadyBooked = 0, count = true, id = null, apiKeySource = null, target = null } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category "${category}"`);
  if (apiKeySource !== REQUIRED_API_KEY_SOURCE) {
    const reason = apiKeySource ? `api key source "${String(apiKeySource).slice(0, 40)}" is not ${REQUIRED_API_KEY_SOURCE}` : 'no api key source: the record carries no proof that the run billed the API key';
    logReject(path, now, category, usd, meta, reason);
    throw new RecordRefused(`refused, nothing booked: ${reason}; pass --api-key-source ${REQUIRED_API_KEY_SOURCE} (CLI) or apiKeySource: '${REQUIRED_API_KEY_SOURCE}' (library) only for a run billed to the API key`);
  }
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error('usd must be a non-negative number');
  const tn = target && target !== PRIMARY ? String(target) : null;
  return mutate(now, cfg, path, (c) => {
    const L = laneOf(c, tn);
    L.spent[category] = (L.spent[category] || 0) + n - (Number(alreadyBooked) || 0);
    if (count) L.n[category] = (L.n[category] || 0) + 1;
    c.entries.push({
      ...(id ? { id: String(id).slice(0, 40) } : {}), t: new Date(now).toISOString(), cat: category, ...(tn ? { target: tn.slice(0, 40) } : {}), usd: n, meta: String(meta).slice(0, 200),
      ...(detail ? { project: String(detail.project || '').slice(0, 80), model: String(detail.model || '').slice(0, 80), tokens: detail.tokens || null, turns: detail.turns ?? null, ...(detail.path ? { path: String(detail.path).slice(0, 20) } : {}), ...(detail.error ? { error: String(detail.error).slice(0, 200) } : {}), ...(Array.isArray(detail.notes) && detail.notes.length ? { notes: detail.notes.slice(0, 5).map((x) => String(x).slice(0, 120)) } : {}) } : {}),
    });
    if (c.entries.length > MAX_ENTRIES) c.entries.splice(0, c.entries.length - MAX_ENTRIES);
    if (success && category !== 'workers') { L.fails = 0; L.tripped = null; }
    return { spent: L.spent[category], n: L.n[category] };
  });
}

// Spend of one paid turn, booked as it happens so a killed run still leaves its cost in the
// ledger. The run's final record() passes the total with alreadyBooked set to this sum.
export function recordSpend(category, usd, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), target = null } = {}) {
  const n = Number(usd);
  if (!CATEGORIES.includes(category) || !Number.isFinite(n) || n <= 0) return;
  mutate(now, cfg, path, (c) => { const L = laneOf(c, target); L.spent[category] = (L.spent[category] || 0) + n; });
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
export function recordFailure(reason, { now = Date.now(), cfg = loadConfig(), path = ledgerPath(), hard = false, target = null } = {}) {
  return mutate(now, cfg, path, (c) => {
    const L = laneOf(c, target);
    L.fails = (L.fails || 0) + 1;
    if (hard || L.fails >= TRIP_AFTER) L.tripped = { at: new Date(now).toISOString(), reason: String(reason).slice(0, 120) };
    return { fails: L.fails, tripped: !!L.tripped };
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
  lines.push(`key: ${keyConfigured(cfg.keySource, env, cfg.bwsTokenSource) ? `configured (${(parseKeySource(cfg.keySource) || {}).kind} source)` : 'not configured, so every decision is plan'}`);
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
  // The primary lane's entries only (named targets are reported by targetLines); allEntries has every lane.
  return { text: lines.join('\n'), total, cycle: cy, ledger: { ...c, entries: entriesOf(c.entries, PRIMARY), allEntries: c.entries } };
}

/// --- per-target report (0.31.72) --------------------------------------------------------------
// Empty unless api_targets names a target, so the output with the options unset is the output it always was.
export const namedTargets = (cfg) => Object.values((cfg && cfg.targets) || {}).filter((t) => !t.builtin);

// One lane's booked figures and breaker, as a line for target `t`.
function laneLine(t, c) {
  const L = laneOf(c, t.name);
  const spent = sum(L.spent);
  const n = sum(L.n);
  const budget = t.name === PRIMARY ? null : t.budget;
  const brk = L.tripped ? `BREAKER TRIPPED ${L.tripped.at}: ${L.tripped.reason}` : (L.fails ? `${L.fails} failure(s) in a row (trips at ${TRIP_AFTER})` : 'breaker ok');
  return `${t.name}: booked $${spent.toFixed(2)} in ${n} item(s)${budget ? ` of its $${budget} budget` : ''}; ${brk}`;
}

// cycle: the ledger cycle (top level = primary lane, lanes = named). orgs: getTargetOrgs() result ([] before it is fetched), grouped
// by org id with the org name only as secondary text. A group with no cost data says so and never fails the report.
export function targetLines({ cfg, cycle = emptyCycle(), orgs = [], now = Date.now() }) {
  const named = namedTargets(cfg);
  const lines = [];
  for (const e of cfg.targetErrors || []) lines.push(`api_targets: ${e}`);
  if (!named.length && !Object.keys(cfg.categoryTargets || {}).length) return lines;
  const cy = cycleOf(now, cfg.cycleDay);
  const all = Object.values(cfg.targets || {});
  lines.push('API targets (grouped by org; booked = this ledger, billed = Admin API):');
  for (const cat of ['review', 'workers']) {
    const l = (cfg.categoryTargets || {})[cat];
    if (l && l.length) lines.push(`  ${cat} order: ${l.join(' > ')}, then the plan`);
  }
  const seen = new Set();
  const groups = orgs.length ? orgs : [{ id: null, name: '', targets: all.map((t) => t.name), ok: false, snapshot: null, reason: 'billing not fetched' }];
  for (const g of groups) {
    const head = g.id ? `org ${g.id}${g.name ? ` (${g.name})` : ''}` : 'org unknown';
    const billed = g.ok && g.snapshot ? `billed $${billedSince(g.snapshot, cy.start).toFixed(2)} this cycle through ${new Date(g.snapshot.through).toISOString().slice(0, 10)}` : `no cost data${g.reason ? ` (${g.reason})` : ''}`;
    lines.push(`  ${head}: ${billed}`);
    for (const name of g.targets) {
      const t = (cfg.targets || {})[name];
      if (!t) continue;
      seen.add(name);
      const ws = g.ok && g.snapshot && t.workspace ? `; workspace ${workspaceName(g.snapshot, t.workspace)} billed $${billedSince(g.snapshot, cy.start, t.workspace).toFixed(2)}` : '';
      lines.push(`    ${laneLine(t, cycle)}${ws}`);
    }
  }
  for (const t of all) if (!seen.has(t.name)) lines.push(`    ${laneLine(t, cycle)}`);
  return lines;
}

// The API share of all reviews (0.31.63), from telemetry/review-verdicts.jsonl. An API review counts once, by the row api-review.mjs
// writes on exit (source "api-review"); every other row counts as a subagent review unless it says route "api" (the verdict row of a
// guard-routed review, which the api-review row already counts). An api-review row with ok:false (a failed run, retried as a subagent) is not counted: the retry is the one review that happened. The denominator is reviews with a verdict: API reviews that finished plus subagent reviews with a parsed verdict line. Rows without a route (older ones) are subagent reviews.
export function reviewShareLines({ now = Date.now(), file = join(telemetryDir(), 'review-verdicts.jsonl') } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * 86400000;
  const t = { today: { api: 0, all: 0 }, week: { api: 0, all: 0 } };
  try {
    for (const r of tailRecords(file, { bytes: 8 * 1024 * 1024 })) {
      const at = Date.parse(r && r.at);
      if (!Number.isFinite(at) || at < weekAgo || at > now + 60000) continue;
      const isApi = r.source === 'api-review';
      if (isApi && r.ok === false) continue; // a failed run: the review is redone on a subagent, whose verdict row counts it
      if (!isApi && r.route === 'api') continue;
      for (const [k, on] of [['today', String(r.at).slice(0, 10) === day], ['week', true]]) { if (!on) continue; t[k].all++; if (isApi) t[k].api++; }
    }
  } catch { /* an unreadable log shows zeros */ }
  const f = (x) => `${x.api} of ${x.all} (${x.all ? Math.round((x.api / x.all) * 100) : 0}%) on the API`;
  return [`review share today: ${f(t.today)}`, `review share last 7 days: ${f(t.week)}`];
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
    // The same grouping as the per-workspace check above: a category with no mapped workspace is held to the default workspace ('').
    const wsOfCat = {};
    for (const cat of CATEGORIES) { const ref = (cfg.categoryWorkspaces || {})[cat]; wsOfCat[cat] = ref ? resolveWorkspace(snap, ref) : ''; }
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

// --- credits: used, remaining against a Console anchor, and the caps (`credits`, `credits anchor`) --------------------------
//
// The Admin API reports cost but not the prepaid balance (Console only). So the operator reads the balance B in the Console on a
// date D and records it (`credits anchor`); remaining = B - billed cost since D. The anchor lives in the agent-companion state,
// never in the repo or in operator-edited config. Pure functions: the snapshot (or null) and the ledger come from the caller.

export const anchorPath = () => stateFile('api-credits-anchor.json');

const anchorOf = (j) => {
  const asOf = Date.parse(j && j.asOf);
  const setAt = Date.parse(j && j.setAt);
  return j && Number.isFinite(Number(j.usd)) && Number.isFinite(asOf) ? { usd: Number(j.usd), asOf, setAt: Number.isFinite(setAt) ? setAt : asOf } : null;
};

// 0.31.79: every account has its own anchor. The file keeps the primary's anchor at the top level (so an existing file reads
// unchanged) and the named targets' under `targets`. { primary: anchor|null, <target name>: anchor, ... }; primary null when unreadable.
export function readAnchors(path = anchorPath()) {
  const out = { [PRIMARY]: null };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    out[PRIMARY] = anchorOf(j);
    for (const [name, v] of Object.entries((j && j.targets) || {})) { const a = anchorOf(v); if (a) out[String(name).toLowerCase()] = a; }
  } catch { /* none stored or unreadable: no anchors */ }
  return out;
}

// { usd, asOf (ms), setAt (ms) } or null when none is stored or the file is unreadable. target: a named target (default primary).
export function readAnchor(path = anchorPath(), target = PRIMARY) {
  return readAnchors(path)[String(target || PRIMARY).toLowerCase()] || null;
}

// Re-anchoring replaces the stored anchor of that account only. Throws on a bad amount or a date in the future.
export function writeAnchor(usd, { asOf = Date.now(), now = Date.now(), path = anchorPath(), target = PRIMARY } = {}) {
  const text = String(usd ?? '').trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('the balance must be a plain dollar amount, for example 183.40');
  const n = Number(text);
  if (!Number.isFinite(asOf)) throw new Error('bad --date (an ISO date or time)');
  if (asOf > now + 60000) throw new Error('--date is in the future');
  const name = String(target || PRIMARY).toLowerCase();
  const rec = { usd: n, asOf: new Date(asOf).toISOString(), setAt: new Date(now).toISOString() };
  let doc = { v: 1 };
  try { const j = JSON.parse(readFileSync(path, 'utf8')); if (j && typeof j === 'object') doc = j; } catch { /* a fresh file */ }
  if (name === PRIMARY) doc = { ...doc, v: 1, ...rec }; else doc = { ...doc, v: 1, targets: { ...(doc.targets || {}), [name]: rec } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
  return { usd: n, asOf, setAt: now };
}

// Remaining prepaid credit of one account: the anchor (the Console balance on a date) minus what was billed since the anchor's UTC
// day (that whole day counts, so a mid-day reading errs low). snap: the account's billing snapshot or null; entries: its booked
// ledger entries (any cycle). `afterBooked` also subtracts the booked spend the cost report has not reached yet (the figure
// that gates); without a snapshot only the booked entries stand in for billing. Null without an anchor.
export function creditRemaining({ anchor, snap = null, entries = [] }) {
  if (!anchor) return null;
  const fromDay = Math.floor(anchor.asOf / DAY_MS) * DAY_MS;
  let billedSinceAnchor = null; let bookedSinceAnchor; let basis;
  if (snap && Number.isFinite(snap.through)) {
    billedSinceAnchor = billedSince(snap, fromDay);
    bookedSinceAnchor = bookedBetween(entries, Math.max(snap.through, fromDay));
    basis = `billed since ${iso(fromDay).slice(0, 10)}`;
  } else { bookedSinceAnchor = bookedBetween(entries, fromDay); basis = `booked since ${iso(fromDay).slice(0, 10)}`; }
  const spentSince = (billedSinceAnchor === null ? 0 : billedSinceAnchor) + bookedSinceAnchor;
  return {
    usd: anchor.usd - (billedSinceAnchor === null ? bookedSinceAnchor : billedSinceAnchor), afterBooked: anchor.usd - spentSince, spentSince, basis,
    billedSinceAnchor, bookedNotYetBilledSinceAnchor: billedSinceAnchor === null ? null : bookedSinceAnchor, bookedSinceAnchor: billedSinceAnchor === null ? bookedSinceAnchor : null,
    verified: billedSinceAnchor !== null, fromDay,
  };
}

// All booked entries of one lane across the kept cycles (the ledger keeps four): the booked side of a remaining-credit sum.
const laneEntriesAll = (led, name) => Object.values((led && led.cycles) || {}).flatMap((c) => entriesOf((c && c.entries) || [], name));

// Today's pace cap for a category, as `decide` computes it (share x budget x cycle fraction + one average item).
function paceCap(category, { cfg, cy, ledgerCycle }) {
  const sh = cfg.shares;
  const nonReserve = CATEGORIES.reduce((a, k) => a + (sh[k] || 0), 0) || 1;
  const own = sh[category] || 0;
  const share = cy.reserveReleased ? own + (sh.reserve || 0) * (own / nonReserve) : own;
  const cnt = (ledgerCycle.n || {})[category] || 0;
  const avg = cnt > 0 ? ((ledgerCycle.spent || {})[category] || 0) / cnt : cfg.itemEstimate;
  return share * cfg.budget * cy.frac + avg;
}

// snap: a billing snapshot or null (ledger only; reason says why). ledgerCycle: the current cycle of the ledger ({ spent, n, entries }).
export function creditsView({ snap = null, reason = '', cfg, ledgerCycle = {}, ledgerOk = true, anchor = null, now = Date.now(), fetchedAgeMs = null }) {
  const cy = cycleOf(now, cfg.cycleDay);
  const entries = Array.isArray(ledgerCycle.entries) ? ledgerCycle.entries : [];
  const monthStart = monthStartOf(now);
  const lc = { spent: ledgerCycle.spent || {}, n: ledgerCycle.n || {} };
  const bookedTotal = sum(lc.spent);
  const warnings = [];
  if (!ledgerOk) warnings.push('the local ledger is unreadable: booked figures are missing');
  const view = { now: iso(now), source: snap ? 'billing' : 'ledger-only', fallbackReason: snap ? null : (reason || 'billing not available'), cycle: { key: cy.key, start: iso(cy.start), end: iso(cy.end), day: Math.floor((now - cy.start) / DAY_MS) + 1, fractionElapsed: cy.frac, reserveReleased: cy.reserveReleased } };

  // Used this cycle.
  const wsRows = []; const modelRows = [];
  let billedCycle = null; let notYetBilled; let dataRunsTo = null;
  if (snap) {
    const rows = (snap.cost || []).filter((r) => dayMs(r.day) >= cy.start);
    billedCycle = billedSince(snap, cy.start);
    for (const [id, v] of group(rows, (r) => r.ws, (r) => Number(r.usd) || 0)) {
      const name = workspaceName(snap, id);
      wsRows.push({ id, name, usd: v, limit: limitFor(cfg, name, id) });
    }
    for (const [m, v] of group(rows, (r) => model5(r.model), (r) => Number(r.usd) || 0)) modelRows.push({ model: m, usd: v });
    notYetBilled = bookedBetween(entries, Math.max(snap.through, cy.start));
    dataRunsTo = iso(snap.through);
  } else notYetBilled = bookedTotal;
  view.billed = snap ? { cycleTotal: billedCycle, throughUtc: dataRunsTo, throughNote: 'end of the last complete UTC day billed; cost data lags up to a day', cachedAgeMin: fetchedAgeMs === null ? null : Math.round(fetchedAgeMs / 60000), byWorkspace: wsRows, byModel: modelRows } : null;
  view.booked = { cycleTotal: bookedTotal, notYetBilled, note: snap ? 'booked in the local ledger after the last complete billed day (the lag window)' : 'every booked entry counts as not yet billed (no billing data)' };
  view.used = { combined: (snap ? billedCycle : 0) + notYetBilled };

  // Remaining: anchor minus billed since the anchor's UTC day (that whole day counts, so a mid-day reading errs low).
  view.anchor = null; view.remaining = null;
  if (anchor) {
    const ageDays = (now - anchor.asOf) / DAY_MS;
    view.anchor = { usd: anchor.usd, asOf: iso(anchor.asOf), setAt: iso(anchor.setAt), ageDays: Math.round(ageDays * 10) / 10 };
    const rem = creditRemaining({ anchor, snap, entries });
    const { billedSinceAnchor, bookedSinceAnchor, basis, spentSince } = rem;
    if (snap && rem.fromDay < snap.from) warnings.push(`the anchor (${iso(anchor.asOf).slice(0, 10)}) is before the billing window fetched (from ${iso(snap.from).slice(0, 10)}): billed since the anchor is understated, remaining is too high; re-anchor`);
    view.remaining = { usd: rem.usd, afterBooked: rem.afterBooked, basis, billedSinceAnchor, bookedNotYetBilledSinceAnchor: rem.bookedNotYetBilledSinceAnchor, bookedSinceAnchor };
    if (now - anchor.asOf > cy.end - cy.start) warnings.push(`the anchor is ${Math.floor(ageDays)} days old (older than one cycle): read the Console balance again and run \`credits anchor <usd>\``);
    if (spentSince > anchor.usd) warnings.push(`spend since the anchor (${usd2(spentSince)}) exceeds the anchored balance (${usd2(anchor.usd)}): a top-up probably happened; read the Console balance again and re-anchor`);
  }

  // Caps.
  const cats = CATEGORIES.map((k) => {
    const sv = spendView(snap, k, { cfg, cy, entries, now });
    const spent = sv.verified ? sv.spent : (lc.spent[k] || 0);
    const cap = paceCap(k, { cfg, cy, ledgerCycle: lc });
    return { category: k, share: cfg.shares[k] || 0, shareUsd: (cfg.shares[k] || 0) * cfg.budget, spent, basis: sv.verified ? 'billed + booked' : 'booked', paceCapNow: cap, usedOfPaceCap: cap > 0 ? spent / cap : null, workspace: (cfg.categoryWorkspaces || {})[k] || null };
  });
  const wsLimits = Object.entries(cfg.workspaceLimits || {}).map(([name, limit]) => {
    let used; let basis;
    if (snap) {
      const id = /^wrkspc_/.test(name) ? name : resolveWorkspace(snap, name);
      used = id === null ? null : billedSince(snap, monthStart, id) + bookedBetween(entries, Math.max(snap.through, monthStart), Infinity, CATEGORIES.filter((c) => resolveWorkspace(snap, (cfg.categoryWorkspaces || {})[c]) === id));
      basis = 'billed + booked, calendar month';
    } else {
      used = bookedBetween(entries, monthStart, Infinity, CATEGORIES.filter((c) => String((cfg.categoryWorkspaces || {})[c] || '').toLowerCase() === name.toLowerCase()));
      basis = 'booked only, calendar month';
    }
    return { workspace: name, limit, used, usedPct: used === null || !(limit > 0) ? null : used / limit, basis };
  });
  view.caps = { monthlyBudget: cfg.budget, reserveShare: cfg.shares.reserve || 0, reserveReleased: cy.reserveReleased, categories: cats, workspaceLimits: wsLimits };
  view.warnings = warnings;
  return view;
}

const pctOf = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(0)}%`);

export function creditsLines(v) {
  const L = [];
  L.push(`API credits (cycle ${v.cycle.key} .. ${v.cycle.end.slice(0, 10)}, day ${v.cycle.day}, ${(v.cycle.fractionElapsed * 100).toFixed(0)}% elapsed)`);
  if (v.source === 'ledger-only') L.push(`billing: not available (${v.fallbackReason}); showing the local ledger only, which is booked spend, not verified against billing`);
  else L.push(`data runs to: ${v.billed.throughUtc.slice(0, 10)} 00:00Z (end of the last complete UTC day; cost data lags up to a day); fetched ${v.billed.cachedAgeMin === null || v.billed.cachedAgeMin < 2 ? 'now' : `${v.billed.cachedAgeMin} min ago`}`);
  if (v.billed) {
    L.push(`used this cycle, billed: ${usd2(v.billed.cycleTotal)} (Admin API cost report, list price, before credits)`);
    L.push(`  by workspace: ${v.billed.byWorkspace.length ? v.billed.byWorkspace.map((w) => `${w.name} ${usd2(w.usd)}`).join(', ') : 'none yet'}`);
    L.push(`  by model: ${v.billed.byModel.length ? v.billed.byModel.map((m) => `${m.model} ${usd2(m.usd)}`).join(', ') : 'none yet'}`);
  }
  L.push(`booked, not yet billed: ${usd2(v.booked.notYetBilled)} (${v.booked.note})`);
  L.push(`used this cycle, combined: ${usd2(v.used.combined)}`);
  if (v.anchor && v.remaining) {
    L.push(`anchor: Console balance ${usd2(v.anchor.usd)} on ${v.anchor.asOf.slice(0, 16).replace('T', ' ')}Z, set ${v.anchor.setAt.slice(0, 10)} (${v.anchor.ageDays} days old)`);
    L.push(`remaining: ${usd2(v.remaining.usd)} = anchor - ${v.remaining.basis} ${usd2(v.remaining.billedSinceAnchor === null ? v.remaining.bookedSinceAnchor : v.remaining.billedSinceAnchor)}${v.remaining.billedSinceAnchor === null ? ' (billing not available; booked only)' : `; ${usd2(v.remaining.afterBooked)} after the booked-not-yet-billed ${usd2(v.remaining.bookedNotYetBilledSinceAnchor)}`}`);
  } else L.push('remaining: no anchor: run `credits anchor <usd>` (the prepaid balance is shown in the Console only; the Admin API cannot read it)');
  const c = v.caps;
  L.push(`caps: monthly budget ${usd2(c.monthlyBudget)}; reserve ${usd2(c.reserveShare * c.monthlyBudget)} ${c.reserveReleased ? 'released' : 'held until the last days of the cycle'}`);
  for (const k of c.categories) L.push(`  ${k.category.padEnd(9)} spent ${usd2(k.spent)} of today's pace cap ${usd2(k.paceCapNow)} (${pctOf(k.usedOfPaceCap)}); share ${(k.share * 100).toFixed(0)}% = ${usd2(k.shareUsd)} (${k.basis})${k.workspace ? `; workspace ${k.workspace}` : ''}`);
  L.push(c.workspaceLimits.length ? `workspace limits: ${c.workspaceLimits.map((w) => `${w.workspace} ${w.used === null ? 'not found' : usd2(w.used)} of ${usd2(w.limit)} (${pctOf(w.usedPct)}, ${w.basis})`).join('; ')}` : 'workspace limits: none configured (api_credits_workspace_limits)');
  for (const w of v.warnings) L.push(`WARNING: ${w}`);
  L.push('caveat: cost is list price, Priority Tier is excluded, and values can be revised for about 7 days after month end');
  return L;
}
