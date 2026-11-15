// api-spend.mjs — the API-credit spend watch (reads the Admin API cost report).
//
// The governor (lib/api-credits.mjs) keeps its own ledger of API-credit spend. This module
// asks the organization's cost report what was actually billed this cycle, per workspace,
// and answers three questions for the daily scout report:
//   1. How much did the reviewers workspace and the whole organization spend this cycle?
//   2. Is the reviewers workspace over an alert threshold (default $50) that has not been
//      acknowledged this cycle?
//   3. Is there spend the governor ledger cannot explain (reviewers workspace spend beyond the
//      ledger by more than max($1, 10%))? Something other than the governed runner used the key.
//
// It needs an Admin API key (sk-ant-admin...), which only an organization has. The key is read
// by the key reader and goes only into the x-api-key header of a GET request. It is never put
// in argv, a URL, a log, a file or an error message: every string leaving this module passes
// through scrub(). Nothing here writes anything except the alert state (ack).
//
// Cost report notes: completed UTC days only (spend lags up to a day); amounts are decimal strings in cents; cost is before credits; the default
// workspace has workspace_id null.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { opt, stateFile, stateRootPath } from '../../hooks/lib/context.mjs';
import { withFileLock } from '../../hooks/lib/file-lock.mjs';
import { spawnSyncHidden } from './proc.mjs';
import { loadConfig, cycleOf, resolveKey, status, parseCategoryWorkspaces } from './api-credits.mjs';

export const ENDPOINT = 'https://api.anthropic.com';
export const API_VERSION = '2023-06-01';
export const DEFAULT_ALERTS = [50];
export const DEFAULT_REVIEWERS_WORKSPACE = 'reviewers';
const DAY_MS = 86400000;
const MAX_PAGES = 6;
const HOUR_MS = 3600000;
export const BILLING_TTL_MS = 15 * 60000;

export const alertStatePath = () => stateFile('api-spend-alerts.json');
export const billingCachePath = () => stateFile('api-billing-cache.json');
export const defaultAdminKeySource = () => `dpapi:${join(stateRootPath(), 'secrets', 'anthropic-admin-key.dpapi')}`;

// --- config --------------------------------------------------------------------------------

export function parseAlerts(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const n = Number(part.replace(/^\$/, ''));
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export function loadSpendConfig(o = opt) {
  const gov = loadConfig(o);
  const raw = o('api_spend_alerts', '');
  const alerts = String(raw).trim() === '' ? [...DEFAULT_ALERTS] : parseAlerts(raw);
  const reviewersWorkspace = String(o('api_spend_reviewers_workspace', DEFAULT_REVIEWERS_WORKSPACE) || '').trim() || DEFAULT_REVIEWERS_WORKSPACE;
  return {
    ...gov,
    // The reviewers workspace is the review category's workspace unless api_credits_category_workspaces names one.
    categoryWorkspaces: { ...gov.categoryWorkspaces, ...(parseCategoryWorkspaces(o('api_credits_category_workspaces', '')).review ? {} : { review: reviewersWorkspace }) },
    adminKeySource: String(o('api_admin_key_source', '') || '').trim() || defaultAdminKeySource(),
    alerts,
    reviewersWorkspace,
  };
}

// --- secrets hygiene -----------------------------------------------------------------------

export function scrub(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('[key]');
  return s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[key]');
}

// --- admin key -----------------------------------------------------------------------------

export function parseAdminKeySource(src) {
  const s = String(src || '').trim();
  const m = /^(dpapi|env|bws):(.+)$/.exec(s);
  return m ? { kind: m[1], name: m[2].trim() } : null;
}

// The DPAPI blob was written by ConvertFrom-SecureString for the current Windows user. The script
// reads the path from an environment variable and prints the key on stdout only.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$enc = (Get-Content -LiteralPath $env:AC_SPEND_DPAPI_PATH -Raw).Trim()',
  '$sec = ConvertTo-SecureString -String $enc',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
].join('; ');

function readDpapi(path, { platform = process.platform, env = process.env, spawn = spawnSyncHidden } = {}) {
  if (platform !== 'win32') throw new Error('dpapi key source unsupported on this platform');
  if (!existsSync(path)) throw new Error('admin key file not found');
  const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    env: { ...env, AC_SPEND_DPAPI_PATH: path }, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error('could not decrypt the admin key file (wrong Windows user?)');
  return String(r.stdout || '').trim();
}

// Resolves the admin key. Throws messages that never contain it.
export function readAdminKey(src, opts = {}) {
  const p = parseAdminKeySource(src);
  if (!p || !p.name) throw new Error('no admin key source configured (api_admin_key_source)');
  const env = opts.env || process.env;
  const key = String(p.kind === 'dpapi' ? readDpapi(p.name, opts) : resolveKey(`${p.kind}:${p.name}`, env)).trim();
  if (!key) throw new Error('admin key source returned nothing');
  if (!/^sk-ant-admin/.test(key)) throw new Error('the configured key is not an admin key (sk-ant-admin...)');
  return key;
}

// --- Admin API -----------------------------------------------------------------------------

async function adminGet(path, query, key, fetchImpl) {
  const qs = new URLSearchParams();
  for (const [k, v] of query) qs.append(k, v);
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}${path}?${qs}`, {
      method: 'GET',
      // redirect: 'error' so the key header can never follow a redirect off the official host.
      redirect: 'error',
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'user-agent': 'agent-companion-api-spend' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Admin API request failed (${scrub((e && (e.cause?.code || e.name)) || 'network error', key).slice(0, 40)})`);
  }
  if (!res.ok) {
    let kind = '';
    try { kind = ((await res.json())?.error?.type) || ''; } catch { /* no body */ }
    throw new Error(`Admin API HTTP ${res.status}${kind ? ` ${scrub(kind, key).slice(0, 40)}` : ''}`);
  }
  try { return await res.json(); } catch { throw new Error('Admin API returned unreadable output'); }
}

// Cost in dollars per workspace id ('' = the default workspace) between two instants.
export async function fetchCostByWorkspace(key, fetchImpl, startMs, endMs) {
  const byWs = {};
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = [['starting_at', new Date(startMs).toISOString()], ['ending_at', new Date(endMs).toISOString()],
      ['bucket_width', '1d'], ['group_by[]', 'workspace_id'], ['limit', '31']];
    if (page) q.push(['page', page]);
    const j = await adminGet('/v1/organizations/cost_report', q, key, fetchImpl);
    if (!j || !Array.isArray(j.data)) throw new Error('Admin API cost report has an unexpected shape');
    for (const b of j.data) for (const r of (b && b.results) || []) {
      const cents = Number(r.amount);
      if (!Number.isFinite(cents)) continue;
      const id = r.workspace_id || '';
      byWs[id] = (byWs[id] || 0) + cents / 100;
    }
    if (!j.has_more || !j.next_page) return byWs;
    page = j.next_page;
  }
  throw new Error('Admin API cost report has too many pages');
}

export async function fetchWorkspaces(key, fetchImpl) {
  const out = [];
  let after = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = [['limit', '100']];
    if (after) q.push(['after_id', after]);
    const j = await adminGet('/v1/organizations/workspaces', q, key, fetchImpl);
    if (!j || !Array.isArray(j.data)) throw new Error('Admin API workspace list has an unexpected shape');
    for (const w of j.data) if (w && w.id) out.push({ id: String(w.id), name: String(w.name || '') });
    if (!j.has_more || !j.last_id) return out;
    after = j.last_id;
  }
  return out;
}

// --- alert state (per cycle, next to the governor's state files) ---------------------------

function readAlertState(path) {
  if (!existsSync(path)) return { v: 1, cycles: {} };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && typeof j === 'object' && j.cycles && typeof j.cycles === 'object' ? j : { v: 1, cycles: {} };
  } catch { return { v: 1, cycles: {} }; }
}

export function ackedIds(cycleKey, path = alertStatePath()) {
  return Object.keys(readAlertState(path).cycles[cycleKey]?.acked || {});
}

export function ack(id, { now = Date.now(), cfg = loadConfig(), path = alertStatePath() } = {}) {
  const clean = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(clean)) throw new Error('bad alert id');
  const cy = cycleOf(now, cfg.cycleDay);
  return withFileLock(`${path}.lock`, () => {
    const st = readAlertState(path);
    const c = (st.cycles[cy.key] ||= { acked: {} });
    c.acked ||= {};
    c.acked[clean] = new Date(now).toISOString();
    for (const k of Object.keys(st.cycles).sort().slice(0, -4)) delete st.cycles[k];
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
    renameSync(tmp, path);
    return { id: clean, cycle: cy.key };
  }, { failOpen: false, waitMs: 3000 });
}

// --- check ---------------------------------------------------------------------------------

const usd = (n) => `$${n.toFixed(2)}`;
const money = (n) => `$${Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(2)}`;

export function unexplained(reviewers, ledger) {
  const over = reviewers - ledger;
  return over > Math.max(1, 0.1 * ledger) ? over : 0;
}

// Never throws. Returns { ok, line, notify, ... }.
export async function check({
  now = Date.now(), cfg = loadSpendConfig(), env = process.env, fetchImpl = globalThis.fetch,
  readKey = (src) => readAdminKey(src, { env }), ledgerPath, alertPath = alertStatePath(),
} = {}) {
  let key = '';
  try {
    key = await readKey(cfg.adminKeySource);
    const cy = cycleOf(now, cfg.cycleDay);
    // The cost report holds completed UTC days only (a window reaching into today is a 400 when it
    // would be empty). So spend lags by up to a day, and the ledger is cut at the same instant.
    const endMs = Math.floor(now / DAY_MS) * DAY_MS;
    const byWs = endMs > cy.start ? await fetchCostByWorkspace(key, fetchImpl, cy.start, endMs) : {};
    const total = Object.values(byWs).reduce((a, b) => a + b, 0);

    // The reviewers workspace: a wrkspc_ id, or a name looked up in the workspace list.
    let rid = cfg.reviewersWorkspace;
    if (!/^wrkspc_/.test(rid)) {
      const hit = (await fetchWorkspaces(key, fetchImpl)).find((w) => w.name.toLowerCase() === rid.toLowerCase());
      if (!hit) throw new Error(`no workspace named "${scrub(rid, key).slice(0, 40)}" (set api_spend_reviewers_workspace)`);
      rid = hit.id;
    }
    const reviewers = byWs[rid] || 0;

    // Ledger for the same window (the governor's own record). Skipped when it cannot be read.
    const st = status({ now, cfg, ...(ledgerPath ? { path: ledgerPath } : {}), env });
    const ledgerOk = !/ledger unreadable/.test(st.text);
    const entries = st.ledger && Array.isArray(st.ledger.entries) ? st.ledger.entries : null;
    // Turns of a run that died before its entry was written are booked in `spent` without an entry
    // (recordSpend): they are in the ledger, so they must not read as unexplained spend.
    const entered = entries ? entries.reduce((a, e) => a + (Number(e.usd) || 0), 0) : 0;
    const ledger = entries
      ? entries.reduce((a, e) => (Date.parse(e.t) < endMs ? a + (Number(e.usd) || 0) : a), 0) + Math.max(0, st.total - entered)
      : st.total;
    const unex = ledgerOk ? unexplained(reviewers, ledger) : 0;

    const day = Math.floor((now - cy.start) / DAY_MS) + 1;
    const reviewersBudget = (cfg.shares.review || 0) * cfg.budget;
    let line = `API credits: reviewers ${money(reviewers)} of ${money(reviewersBudget)} · total ${money(total)} of ${money(cfg.budget)} · cycle day ${day}`;
    if (unex > 0) line += ` · unexplained ${money(unex)}`;

    const done = new Set(ackedIds(cy.key, alertPath));
    const notify = [];
    for (const t of cfg.alerts) {
      const id = `reviewers-${t}`;
      if (reviewers >= t && !done.has(id)) notify.push({ id, message: `API credits: reviewer spend reached ${usd(reviewers)} (alert at ${money(t)}), cycle day ${day}, ${money(total)} of ${money(cfg.budget)} total` });
    }
    if (unex > 0 && !done.has('unexplained')) {
      notify.push({ id: 'unexplained', message: `API credits: ${usd(unex)} of reviewer spend is not in the governor ledger (billed ${usd(reviewers)}, ledger ${usd(ledger)}), cycle day ${day}` });
    }
    return { ok: true, line, notify, cycle: cy.key, through: new Date(endMs).toISOString().slice(0, 10), day, reviewers, total, ledger: ledgerOk ? ledger : null, unexplained: unex };
  } catch (e) {
    const reason = scrub((e && e.message) || e, key).slice(0, 120);
    return { ok: false, line: `API credits: unavailable (${reason})`, notify: [], reason };
  }
}

// --- billed spend snapshot (0.31.55): fetch, cache, never throw ----------------------------------------------------
//
// One snapshot holds what `api-credits.mjs status` and `decide` need: the cost report by day, workspace and model
// (billed dollars), the usage report by day, key and model (tokens), the usage report by hour and workspace (for the
// booked-entry check) and the workspace and key names. GET only; the key goes only into the x-api-key header. Cached
// in state for BILLING_TTL_MS. The cost report holds completed UTC days only, so `through` (the end of the last
// complete day) is where booked spend takes over.

async function pagedBuckets(path, base, key, fetchImpl) {
  const out = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = base.map((x) => [...x]);
    if (page) q.push(['page', page]);
    const j = await adminGet(path, q, key, fetchImpl);
    if (!j || !Array.isArray(j.data)) throw new Error('Admin API report has an unexpected shape');
    out.push(...j.data);
    if (!j.has_more || !j.next_page) return out;
    page = j.next_page;
  }
  throw new Error('Admin API report has too many pages');
}

export async function fetchApiKeyNames(key, fetchImpl) {
  const out = {};
  let after = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = [['limit', '100']];
    if (after) q.push(['after_id', after]);
    const j = await adminGet('/v1/organizations/api_keys', q, key, fetchImpl);
    if (!j || !Array.isArray(j.data)) throw new Error('Admin API key list has an unexpected shape');
    for (const k of j.data) if (k && k.id) out[String(k.id)] = String(k.name || '');
    if (!j.has_more || !j.last_id) return out;
    after = j.last_id;
  }
  return out;
}

const dayOf = (iso) => String(iso).slice(0, 10);
const modelOf = (r) => String(r.model || String(r.description || '').replace(/ - .*$/, '') || 'unknown');
const windowFrom = (now, cycleDay) => {
  const d = new Date(now);
  return Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), cycleOf(now, cycleDay).start);
};

export async function fetchBilling(key, fetchImpl, { now = Date.now(), cfg = loadSpendConfig() } = {}) {
  const from = windowFrom(now, cfg.cycleDay);
  const endMs = Math.floor(now / DAY_MS) * DAY_MS;
  const missing = [];

  // Required: the cost report and the workspace names.
  const cost = [];
  let through = from;
  if (endMs > from) {
    const buckets = await pagedBuckets('/v1/organizations/cost_report', [['starting_at', new Date(from).toISOString()], ['ending_at', new Date(endMs).toISOString()],
      ['bucket_width', '1d'], ['group_by[]', 'workspace_id'], ['group_by[]', 'description'], ['limit', '31']], key, fetchImpl);
    through = endMs;
    const agg = new Map();
    for (const b of buckets) for (const r of (b && b.results) || []) {
      const cents = Number(r.amount);
      if (!Number.isFinite(cents)) continue;
      const k = JSON.stringify([dayOf(b.starting_at), r.workspace_id || '', modelOf(r)]);
      agg.set(k, (agg.get(k) || 0) + cents / 100);
    }
    for (const [k, usd] of agg) { const [day, ws, model] = JSON.parse(k); cost.push({ day, ws, model, usd }); }
  }
  const workspaces = Object.fromEntries((await fetchWorkspaces(key, fetchImpl)).map((w) => [w.id, w.name]));

  // Optional: each can fail alone and the snapshot says what is missing.
  let usage = null; let hourly = null; let hourlyFrom = null; let keys = {};
  try {
    usage = [];
    if (endMs > from) {
      const buckets = await pagedBuckets('/v1/organizations/usage_report/messages', [['starting_at', new Date(from).toISOString()], ['ending_at', new Date(endMs).toISOString()],
        ['bucket_width', '1d'], ['group_by[]', 'api_key_id'], ['group_by[]', 'workspace_id'], ['group_by[]', 'model'], ['limit', '31']], key, fetchImpl);
      for (const b of buckets) for (const r of (b && b.results) || []) {
        usage.push({ day: dayOf(b.starting_at), ws: r.workspace_id || '', key: r.api_key_id || '', model: String(r.model || ''), input: Number(r.uncached_input_tokens) || 0, output: Number(r.output_tokens) || 0,
          cacheRead: Number(r.cache_read_input_tokens) || 0, cacheWrite: Object.values(r.cache_creation || {}).reduce((a, v) => a + (Number(v) || 0), 0) });
      }
    }
  } catch { usage = null; missing.push('usage by key and model'); }
  try {
    const hEnd = Math.floor(now / HOUR_MS) * HOUR_MS;
    hourlyFrom = hEnd - 167 * HOUR_MS; // 168 hourly buckets is the page maximum
    const buckets = await pagedBuckets('/v1/organizations/usage_report/messages', [['starting_at', new Date(hourlyFrom).toISOString()], ['ending_at', new Date(hEnd + HOUR_MS).toISOString()],
      ['bucket_width', '1h'], ['group_by[]', 'workspace_id'], ['limit', '168']], key, fetchImpl);
    hourly = [];
    for (const b of buckets) {
      const rows = ((b && b.results) || []).filter((r) => (Number(r.output_tokens) || 0) + (Number(r.uncached_input_tokens) || 0) + (Number(r.cache_read_input_tokens) || 0) > 0);
      for (const ws of new Set(rows.map((r) => r.workspace_id || ''))) hourly.push({ hour: Date.parse(b.starting_at), ws });
    }
  } catch { hourly = null; hourlyFrom = null; missing.push('hourly usage'); }
  try { keys = await fetchApiKeyNames(key, fetchImpl); } catch { missing.push('key names'); }
  return { v: 1, through, from, cost, usage, hourly, hourlyFrom, workspaces, keys, missing };
}

function readBillingCache(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && j.v === 1 && j.snapshot && Number.isFinite(j.fetchedAt) ? j : null;
  } catch { return null; }
}

// { ok, snapshot, cached, ageMs } or { ok: false, reason }. Never throws; the reason never holds the key. A fresh cache
// (BILLING_TTL_MS, same window) answers without a request.
export async function getBilling({
  now = Date.now(), cfg = loadSpendConfig(), env = process.env, fetchImpl = globalThis.fetch,
  readKey = (src) => readAdminKey(src, { env }), cachePath = billingCachePath(), force = false,
} = {}) {
  const from = windowFrom(now, cfg.cycleDay);
  const hit = force ? null : readBillingCache(cachePath);
  if (hit && hit.snapshot.from === from && now - hit.fetchedAt >= 0 && now - hit.fetchedAt < BILLING_TTL_MS) return { ok: true, snapshot: hit.snapshot, cached: true, ageMs: now - hit.fetchedAt };
  let key = '';
  try {
    key = await readKey(cfg.adminKeySource);
    const snapshot = await fetchBilling(key, fetchImpl, { now, cfg });
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, fetchedAt: now, snapshot })}\n`);
      renameSync(tmp, cachePath);
    } catch { /* an unwritable cache only costs a refetch */ }
    return { ok: true, snapshot, cached: false, ageMs: 0 };
  } catch (e) {
    return { ok: false, reason: scrub((e && e.message) || e, key).slice(0, 120) };
  }
}
