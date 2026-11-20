// API spend watch (scripts/api-spend.mjs, scripts/lib/api-spend.mjs): the Admin API cost report
// against the governor ledger, driven with a stubbed fetch and a stubbed key reader (no live
// calls, no real key). Covers the alert threshold once per cycle, ack, cycle rollover,
// unexplained spend, the unavailable path, key sources, and that the key never reaches output.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SHARES, record, recordSpend, decide, billedSince, billingStatusLines, parseWorkspaceLimits, parseCategoryWorkspaces } from '../scripts/lib/api-credits.mjs';
import { makeFixture } from './helpers.mjs';
import { main as creditsMain } from '../scripts/api-credits.mjs';
import {
  check, ack, ackedIds, readAdminKey, parseAdminKeySource, parseAlerts, loadSpendConfig, scrub, unexplained, getBilling, BILLING_TTL_MS,
} from '../scripts/lib/api-spend.mjs';
import { main } from '../scripts/api-spend.mjs';

const T = (s) => Date.parse(s);
const KEY = 'sk-ant-admin01-SENTINEL-do-not-leak-0123456789';
const REV = 'wrkspc_REVIEWERS';
const CFG = {
  budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:AC_API_KEY', reviewRatio: 0.5, itemEstimate: 2,
  adminKeySource: 'env:AC_ADMIN_KEY', alerts: [50], reviewersWorkspace: 'reviewers',
};
const NOW = T('2026-11-10T12:00:00Z'); // cycle day 10; the cost report reaches 11-10T00:00Z

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'api-spend-'));
  return { dir: d, ledger: join(d, 'api-credits.json'), alerts: join(d, 'api-spend-alerts.json') };
}

// A fetch stub: cents per workspace for the cost report, a workspace list, or a failure.
function stub({ cents = {}, fail = null, pages = null, workspaces = [{ id: REV, name: 'reviewers' }] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) return fail(url, init);
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname === '/v1/organizations/workspaces') return ok({ data: workspaces, has_more: false, last_id: null });
    if (u.pathname === '/v1/organizations/cost_report') {
      const mk = (ent) => ({ starting_at: '2026-11-01T00:00:00Z', ending_at: '2026-11-02T00:00:00Z', results: ent.map(([id, c]) => ({ workspace_id: id, amount: String(c), currency: 'USD' })) });
      if (pages) {
        const page = u.searchParams.get('page');
        return ok(page ? { data: [mk(pages[1])], has_more: false, next_page: null } : { data: [mk(pages[0])], has_more: true, next_page: 'page_2' });
      }
      return ok({ data: [mk(Object.entries(cents).map(([id, c]) => [id === 'default' ? null : id, c]))], has_more: false, next_page: null });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const run = (s, extra = {}) => check({ now: NOW, cfg: CFG, fetchImpl: s.fetchImpl, readKey: () => KEY, ledgerPath: extra.ledger, alertPath: extra.alerts, ...extra.o });

test('line: reviewers and total spend this cycle, cents to dollars, default workspace counted in total', async () => {
  const p = tmp();
  const s = stub({ cents: { [REV]: 1234, default: 500 } });
  record('review', 12.34, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(s, p);
  assert.equal(r.ok, true);
  assert.equal(r.line, 'API credits: reviewers $12.34 of $100 · total $17.34 of $200 · cycle day 10');
  assert.deepEqual(r.notify, []);
  const c = s.calls.find((x) => x.url.includes('cost_report'));
  assert.match(c.url, /starting_at=2026-11-01T00%3A00%3A00.000Z/);
  assert.match(c.url, /ending_at=2026-11-10T00%3A00%3A00.000Z/);
  assert.match(c.url, /group_by%5B%5D=workspace_id/);
  assert.equal(c.init.headers['x-api-key'], KEY);
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
});

test('cost report pages are summed', async () => {
  const p = tmp();
  const s = stub({ pages: [[[REV, 1000]], [[REV, 250], [null, 100]]] });
  record('review', 12.5, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(s, p);
  assert.equal(r.reviewers, 12.5);
  assert.equal(r.total, 13.5);
});

test('a reviewers workspace given as an id skips the workspace lookup', async () => {
  const p = tmp();
  const s = stub({ cents: { [REV]: 100 } });
  const r = await run(s, { ...p, o: { cfg: { ...CFG, reviewersWorkspace: REV } } });
  assert.equal(r.ok, true);
  assert.equal(s.calls.some((x) => x.url.includes('/workspaces')), false);
});

test('first day of the cycle: no completed day yet, no cost call, zero spend', async () => {
  const p = tmp();
  const s = stub();
  const r = await run(s, { ...p, o: { now: T('2026-11-01T09:00:00Z') } });
  assert.equal(r.line, 'API credits: reviewers $0 of $100 · total $0 of $200 · cycle day 1');
  assert.equal(s.calls.some((x) => x.url.includes('cost_report')), false);
});

test('threshold crossing notifies until acknowledged, then not again this cycle', async () => {
  const p = tmp();
  record('review', 52, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const s = stub({ cents: { [REV]: 5200 } });
  const a = await run(s, p);
  assert.equal(a.notify.length, 1);
  assert.equal(a.notify[0].id, 'reviewers-50');
  assert.match(a.notify[0].message, /\$52\.00/);
  assert.equal(a.notify[0].message.includes('\n'), false);
  // a failed push means no ack: the next day still carries it
  const b = await run(s, p);
  assert.equal(b.notify.length, 1);
  // ack: done for the cycle
  const k = ack('reviewers-50', { now: NOW, cfg: CFG, path: p.alerts });
  assert.deepEqual(k, { id: 'reviewers-50', cycle: '2026-11-01' });
  assert.deepEqual(ackedIds('2026-11-01', p.alerts), ['reviewers-50']);
  const c = await run(s, p);
  assert.deepEqual(c.notify, []);
  assert.match(c.line, /^API credits: reviewers \$52 of \$100/);
});

test('below the threshold nothing is notified; several thresholds notify one id each', async () => {
  const p = tmp();
  record('review', 60, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const lo = await run(stub({ cents: { [REV]: 4900 } }), { ...p, o: { cfg: { ...CFG, alerts: [50] } } });
  assert.deepEqual(lo.notify, []);
  const hi = await run(stub({ cents: { [REV]: 6000 } }), { ...p, o: { cfg: { ...CFG, alerts: [25, 50, 90] } } });
  assert.deepEqual(hi.notify.map((n) => n.id), ['reviewers-25', 'reviewers-50']);
});

test('cycle rollover: an alert acked last cycle fires again in the new cycle', async () => {
  const p = tmp();
  ack('reviewers-50', { now: NOW, cfg: CFG, path: p.alerts });
  const later = T('2026-12-03T12:00:00Z');
  record('review', 55, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-12-02T01:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(stub({ cents: { [REV]: 5500 } }), { ...p, o: { now: later } });
  assert.equal(r.cycle, '2026-12-01');
  assert.deepEqual(r.notify.map((n) => n.id), ['reviewers-50']);
  assert.deepEqual(ackedIds('2026-12-01', p.alerts), []);
  assert.deepEqual(ackedIds('2026-11-01', p.alerts), ['reviewers-50']);
});

test('unexplained spend: reviewers beyond the ledger by more than max($1, 10%)', async () => {
  assert.equal(unexplained(10.9, 10), 0);
  assert.ok(unexplained(11.1, 10) > 1);
  assert.equal(unexplained(104, 100), 0);
  assert.ok(unexplained(111, 100) > 10);
  assert.equal(unexplained(3, 5), 0);
  const p = tmp();
  record('review', 20, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(stub({ cents: { [REV]: 5200 } }), p);
  assert.equal(r.line, 'API credits: reviewers $52 of $100 · total $52 of $200 · cycle day 10 · unexplained $32');
  assert.deepEqual(r.notify.map((n) => n.id).sort(), ['reviewers-50', 'unexplained']);
  const u = r.notify.find((n) => n.id === 'unexplained');
  assert.match(u.message, /\$32\.00/);
  // within tolerance: not flagged
  const ok = await run(stub({ cents: { [REV]: 5200 } }), (() => { const q = tmp(); record('review', 50, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: q.ledger }); return q; })());
  assert.doesNotMatch(ok.line, /unexplained/);
  // ack silences it for the cycle
  ack('unexplained', { now: NOW, cfg: CFG, path: p.alerts });
  const after = await run(stub({ cents: { [REV]: 5200 } }), p);
  assert.deepEqual(after.notify.map((n) => n.id), ['reviewers-50']);
});

test('spend booked per turn without an entry (a killed run) is in the ledger, not unexplained', async () => {
  const p = tmp();
  recordSpend('review', 3, { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(stub({ cents: { [REV]: 300 } }), p);
  assert.doesNotMatch(r.line, /unexplained/);
  assert.deepEqual(r.notify, []);
  assert.equal(r.ledger, 3);
});

test('ledger spend after the cost report cut-off does not hide unexplained spend', async () => {
  const p = tmp();
  record('review', 40, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-10T09:00:00Z'), cfg: CFG, path: p.ledger }); // today: not in the report yet
  const r = await run(stub({ cents: { [REV]: 3000 } }), p);
  assert.equal(r.ledger, 0);
  assert.match(r.line, /unexplained \$30/);
});

test('unavailable: key reader failure, HTTP failure, unknown workspace, bad shape; none throws', async () => {
  const p = tmp();
  const r1 = await check({ now: NOW, cfg: CFG, readKey: () => { throw new Error('dpapi key source unsupported on this platform'); }, ledgerPath: p.ledger, alertPath: p.alerts });
  assert.equal(r1.ok, false);
  assert.equal(r1.line, 'API credits: unavailable (dpapi key source unsupported on this platform)');
  assert.deepEqual(r1.notify, []);
  const r2 = await run(stub({ fail: async () => ({ ok: false, status: 401, json: async () => ({ error: { type: 'authentication_error', message: `bad ${KEY}` } }) }) }), p);
  assert.equal(r2.line, 'API credits: unavailable (Admin API HTTP 401 authentication_error)');
  const r3 = await run(stub({ cents: { [REV]: 100 }, workspaces: [] }), p);
  assert.match(r3.line, /^API credits: unavailable \(no workspace named "reviewers"/);
  const r4 = await run(stub({ fail: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) }), p);
  assert.match(r4.line, /^API credits: unavailable \(Admin API cost report has an unexpected shape\)/);
  const r5 = await run(stub({ fail: async () => { throw Object.assign(new Error(`connect ${KEY}`), { cause: { code: 'ECONNRESET' } }); } }), p);
  assert.equal(r5.line, 'API credits: unavailable (Admin API request failed (ECONNRESET))');
  const r6 = await check({ now: NOW, cfg: CFG, fetchImpl: stub().fetchImpl, readKey: () => { throw new Error(`oops ${KEY}`); }, ledgerPath: p.ledger, alertPath: p.alerts });
  assert.doesNotMatch(JSON.stringify(r6), /SENTINEL/);
});

test('the key never appears in output, argv-like fields or any file', async () => {
  const p = tmp();
  record('review', 52, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const s = stub({ cents: { [REV]: 5200 } });
  const out = [];
  const env = { AC_ADMIN_KEY: KEY };
  const code = await main(['check', '--now', '2026-11-10T12:00:00Z'], { out: (x) => out.push(x), env, cfg: CFG, fetchImpl: s.fetchImpl, ledgerPath: p.ledger, alertPath: p.alerts });
  assert.equal(code, 0);
  const j = JSON.parse(out.join('\n'));
  assert.equal(j.ok, true);
  assert.deepEqual(j.notify.map((n) => n.id), ['reviewers-50']);
  assert.equal(out.join('').includes('SENTINEL'), false);
  for (const c of s.calls) assert.equal(c.url.includes('SENTINEL'), false);
  // The key header must never follow a redirect off the official host.
  assert.ok(s.calls.length > 0);
  for (const c of s.calls) { assert.equal(c.init.redirect, 'error'); assert.equal(c.init.method, 'GET'); assert.equal(new URL(c.url).origin, 'https://api.anthropic.com'); }
  const ackOut = [];
  assert.equal(await main(['ack', 'reviewers-50'], { out: (x) => ackOut.push(x), cfg: CFG, alertPath: p.alerts }), 0);
  assert.equal(JSON.parse(ackOut[0]).ok, true);
  assert.equal(readFileSync(p.alerts, 'utf8').includes('SENTINEL'), false);
  assert.equal(scrub(`x ${KEY} y sk-ant-api03-abcdefghijk`, KEY), 'x [key] y [key]');
});

test('CLI: ack rejects a bad id, unknown commands exit 2', async () => {
  const out = [];
  assert.equal(await main(['ack', '../x'], { out: (x) => out.push(x), cfg: CFG, alertPath: tmp().alerts }), 2);
  assert.equal(JSON.parse(out[0]).ok, false);
  assert.equal(await main(['frob'], { out: () => {}, cfg: CFG }), 2);
  assert.equal(await main(['check', '--now', 'nope'], { out: () => {}, cfg: CFG }), 2);
});

test('key sources: env, dpapi on a non-Windows host, dpapi through a hidden powershell, shape check', () => {
  assert.deepEqual(parseAdminKeySource('dpapi:C:/x/key.dpapi'), { kind: 'dpapi', name: 'C:/x/key.dpapi' });
  assert.deepEqual(parseAdminKeySource('env:AC_ADMIN_KEY'), { kind: 'env', name: 'AC_ADMIN_KEY' });
  assert.deepEqual(parseAdminKeySource('bws:my-admin'), { kind: 'bws', name: 'my-admin' });
  assert.equal(parseAdminKeySource('literal'), null);
  assert.equal(readAdminKey('env:AC_ADMIN_KEY', { env: { AC_ADMIN_KEY: ` ${KEY}\n` } }), KEY);
  assert.throws(() => readAdminKey('env:AC_ADMIN_KEY', { env: { AC_ADMIN_KEY: 'sk-ant-api03-notadmin1234' } }), (e) => !e.message.includes('notadmin') && /not an admin key/.test(e.message));
  assert.throws(() => readAdminKey('env:AC_ADMIN_KEY', { env: {} }), /not set/);
  assert.throws(() => readAdminKey('dpapi:/x/key.dpapi', { platform: 'linux' }), /unsupported on this platform/);

  const d = tmp().dir;
  const f = join(d, 'k.dpapi');
  writeFileSync(f, 'encrypted-blob-placeholder');
  let seen;
  const spawn = (cmd, args, o) => { seen = { cmd, args, o }; return { status: 0, stdout: `${KEY}\r\n`, stderr: '' }; };
  assert.equal(readAdminKey(`dpapi:${f}`, { platform: 'win32', spawn, env: {} }), KEY);
  assert.equal(seen.cmd, 'powershell');
  assert.deepEqual(seen.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(seen.o.windowsHide, true);
  assert.equal(seen.args.join(' ').includes(KEY), false);
  assert.equal(seen.o.env.AC_SPEND_DPAPI_PATH, f);
  assert.throws(() => readAdminKey(`dpapi:${f}`, { platform: 'win32', spawn: () => ({ status: 1, stdout: '', stderr: KEY }), env: {} }), (e) => !e.message.includes('SENTINEL'));
  assert.throws(() => readAdminKey(`dpapi:${join(d, 'missing')}`, { platform: 'win32', spawn, env: {} }), /not found/);
});

test('config: alerts list, defaults, governor values reused', () => {
  assert.deepEqual(parseAlerts('50, 80;$20 x -3'), [20, 50, 80]);
  const c = loadSpendConfig((k, d) => d, {});
  assert.deepEqual(c.alerts, [50]);
  assert.equal(c.budget, 200);
  assert.equal(c.cycleDay, 1);
  assert.equal(c.shares.review * c.budget, 100);
  assert.match(c.adminKeySource, /^dpapi:.*anthropic-admin-key\.dpapi$/);
  const o = loadSpendConfig((k, d) => ({ api_admin_key_source: 'env:X', api_spend_alerts: '30,60' })[k] ?? d);
  assert.equal(o.adminKeySource, 'env:X');
  assert.deepEqual(o.alerts, [30, 60]);
});

test('alert state is a file next to the governor state files and survives a bad file', () => {
  const p = tmp();
  writeFileSync(p.alerts, '{not json');
  assert.deepEqual(ackedIds('2026-11-01', p.alerts), []);
  ack('reviewers-50', { now: NOW, cfg: CFG, path: p.alerts });
  assert.ok(existsSync(p.alerts));
  assert.deepEqual(ackedIds('2026-11-01', p.alerts), ['reviewers-50']);
});


// --- billed spend (0.31.55): the Admin API snapshot, decide and status on billed figures ---------------------------------
//
// Invented names and ids throughout. The shapes follow the live responses of 2026-11-15: cost_report amounts are decimal
// strings in cents, usage_report rows carry token counts per api_key_id, workspace_id and model.

const WS_A = 'wrkspc_AAAA';
const WS_B = 'wrkspc_BBBB';
const KEY_A = 'apikey_AAAA';
const BCFG = {
  ...CFG, workspaceLimits: {}, categoryWorkspaces: { review: 'reviewers', workers: 'workers' },
};
const HOUR = 3600000;

// cost: [day, workspace id|null, cents, description, model]; usage: [day, key, ws, model, in, out, cacheRead, cacheWrite]; hourly: [ISO hour, ws]
function billingStub({ cost = [], usage = [], hourly = [], failPath = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (failPath && u.pathname.includes(failPath)) return { ok: false, status: 500, json: async () => ({ error: { type: 'api_error' } }) };
    const day = (d) => ({ starting_at: `${d}T00:00:00Z`, ending_at: new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString() });
    if (u.pathname === '/v1/organizations/workspaces') return ok({ data: [{ id: WS_A, name: 'reviewers' }, { id: WS_B, name: 'workers' }], has_more: false, last_id: null });
    if (u.pathname === '/v1/organizations/api_keys') return ok({ data: [{ id: KEY_A, name: 'review-key' }], has_more: false, last_id: null });
    if (u.pathname === '/v1/organizations/cost_report') {
      const days = [...new Set(cost.map((c) => c[0]))].sort();
      return ok({ data: days.map((d) => ({ ...day(d), results: cost.filter((c) => c[0] === d).map(([, ws, cents, description, model]) => ({ currency: 'USD', amount: String(cents), workspace_id: ws, description, model })) })), has_more: false, next_page: null });
    }
    if (u.pathname === '/v1/organizations/usage_report/messages') {
      if (u.searchParams.get('bucket_width') === '1h') {
        const hours = [...new Set(hourly.map((h) => h[0]))].sort();
        return ok({ data: hours.map((h) => ({ starting_at: h, ending_at: new Date(Date.parse(h) + HOUR).toISOString(), results: hourly.filter((x) => x[0] === h).map(([, ws]) => ({ uncached_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5, workspace_id: ws })) })), has_more: false, next_page: null });
      }
      const days = [...new Set(usage.map((x) => x[0]))].sort();
      return ok({ data: days.map((d) => ({ ...day(d), results: usage.filter((x) => x[0] === d).map(([, k, ws, model, i, o, cr, cw]) => ({ api_key_id: k, workspace_id: ws, model, uncached_input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cw } })) })), has_more: false, next_page: null });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

// Billed through 11-10T00:00Z: reviewers $5.00 + $20.00, workers $3.00, the default workspace $1.00.
const COST = [
  ['2026-11-02', WS_A, 2000, 'Claude Sonnet 5.5 - Output Tokens', 'claude-sonnet-5-5'],
  ['2026-11-03', WS_A, 500, 'Claude Haiku 5.5 - Output Tokens', 'claude-haiku-5-5'],
  ['2026-11-04', WS_B, 300, 'Claude Sonnet 5.5 - Input Tokens', 'claude-sonnet-5-5'],
  ['2026-11-04', null, 100, 'Claude Haiku 5.5 - Input Tokens', 'claude-haiku-5-5'],
];
const USAGE = [['2026-11-02', KEY_A, WS_A, 'claude-sonnet-5-5', 1000, 2000, 5000, 3000]];
const HOURLY = [['2026-11-05T10:00:00Z', WS_A], ['2026-11-09T20:00:00Z', WS_B]];
const mkBilling = (o = {}) => billingStub({ cost: COST, usage: USAGE, hourly: HOURLY, ...o });
const snap = async (o) => (await getBilling({ now: NOW, cfg: BCFG, fetchImpl: mkBilling(o).fetchImpl, readKey: () => KEY, cachePath: join(tmp().dir, 'cache.json') })).snapshot;

test('billing snapshot: cents to dollars by day, workspace and model; names; usage by key; hourly; cut-off at the last complete day', async () => {
  const s = mkBilling();
  const r = await getBilling({ now: NOW, cfg: BCFG, fetchImpl: s.fetchImpl, readKey: () => KEY, cachePath: join(tmp().dir, 'cache.json') });
  assert.equal(r.ok, true);
  const sn = r.snapshot;
  assert.equal(sn.through, T('2026-11-10T00:00:00Z'));
  assert.equal(billedSince(sn, T('2026-11-01T00:00:00Z')), 29);
  assert.equal(billedSince(sn, T('2026-11-01T00:00:00Z'), WS_A), 25);
  assert.equal(billedSince(sn, T('2026-11-03T00:00:00Z'), WS_A), 5);
  assert.equal(billedSince(sn, T('2026-11-01T00:00:00Z'), ''), 1);
  assert.deepEqual(sn.workspaces, { [WS_A]: 'reviewers', [WS_B]: 'workers' });
  assert.deepEqual(sn.keys, { [KEY_A]: 'review-key' });
  assert.deepEqual(sn.usage[0], { day: '2026-11-02', ws: WS_A, key: KEY_A, model: 'claude-sonnet-5-5', input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 3000 });
  assert.equal(sn.hourly.length, 2);
  assert.equal(sn.hourlyFrom, T('2026-11-03T13:00:00Z'));
  // GET only, the key only in the x-api-key header, never in a URL
  for (const c of s.calls) { assert.equal(c.init.method, 'GET'); assert.equal(c.init.headers['x-api-key'], KEY); assert.ok(!c.url.includes('sk-ant')); }
  assert.ok(s.calls.some((c) => c.url.includes('/usage_report/messages') && c.url.includes('bucket_width=1h')));
});

test('billing cache: a second call within 15 minutes makes no request; after the TTL or in a new window it refetches', async () => {
  const p = tmp();
  const cachePath = join(p.dir, 'cache.json');
  const s = mkBilling();
  const get = (now) => getBilling({ now, cfg: BCFG, fetchImpl: s.fetchImpl, readKey: () => KEY, cachePath });
  const a = await get(NOW);
  const n = s.calls.length;
  assert.ok(n > 0 && !a.cached);
  const b = await get(NOW + 14 * 60000);
  assert.equal(b.cached, true);
  assert.equal(s.calls.length, n);
  assert.ok(!readFileSync(cachePath, 'utf8').includes(KEY), 'the cache never holds the key');
  const c = await get(NOW + 16 * 60000);
  assert.equal(c.cached, false);
  assert.ok(s.calls.length > n);
  const m = s.calls.length;
  await get(T('2026-12-02T12:00:00Z')); // the window moved (new month): the old cache is not used
  assert.ok(s.calls.length > m);
  assert.equal(BILLING_TTL_MS, 15 * 60000);
});

test('billing unavailable: no key, HTTP failure or a key that is not an admin key leave ok false with a reason that never holds the key', async () => {
  const noKey = await getBilling({ now: NOW, cfg: BCFG, fetchImpl: mkBilling().fetchImpl, readKey: () => { throw new Error('no admin key source configured (api_admin_key_source)'); }, cachePath: join(tmp().dir, 'c.json') });
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason, /no admin key/);
  const http = await getBilling({ now: NOW, cfg: BCFG, fetchImpl: mkBilling({ failPath: 'cost_report' }).fetchImpl, readKey: () => KEY, cachePath: join(tmp().dir, 'c.json') });
  assert.equal(http.ok, false);
  assert.match(http.reason, /HTTP 500/);
  const net = await getBilling({ now: NOW, cfg: BCFG, fetchImpl: async () => { throw Object.assign(new Error(`boom ${KEY}`), { cause: { code: 'ENOTFOUND' } }); }, readKey: () => KEY, cachePath: join(tmp().dir, 'c.json') });
  assert.equal(net.ok, false);
  assert.ok(!JSON.stringify(net).includes(KEY));
});

test('billing snapshot: usage, hourly and key-name failures are optional and listed as missing', async () => {
  const sn = await snap({ failPath: 'usage_report' });
  assert.equal(sn.usage, null);
  assert.equal(sn.hourly, null);
  assert.deepEqual(sn.missing, ['usage by key and model', 'hourly usage']);
  const lines = billingStatusLines(sn, { cfg: BCFG, entries: [], now: NOW }).join('\n');
  assert.match(lines, /by key: not available/);
  assert.match(lines, /hourly check: not available/);
  assert.match(lines, /billed \$29\.00/);
});

const bk = (fx, cat, usd, at) => record(cat, usd, 't', { apiKeySource: 'ANTHROPIC_API_KEY', now: T(at), cfg: BCFG, path: join(fx.dir, 'led.json') });
const dB = (fx, cat, billing, cfg = BCFG, now = NOW) => decide(cat, { now, cfg, env: { AC_API_KEY: 'present' }, path: join(fx.dir, 'led.json'), billing });

test('decide rests on billed spend: booked spend that never reached the API does not throttle it', async () => {
  const p = tmp(); const fx = { dir: p.dir };
  const sn = await snap();
  bk(fx, 'review', 75, '2026-11-05T00:00:00Z'); bk(fx, 'review', 75, '2026-11-06T00:00:00Z'); // booked $150 of reviews, billed $25
  const booked = dB(fx, 'review', null);
  assert.equal(booked.decision, 'plan');
  assert.match(booked.reason, /booked only, not verified against billing/);
  const billed = dB(fx, 'review', sn);
  assert.equal(billed.decision, 'api', billed.reason);
  assert.match(billed.reason, /\(billed\)/);
  assert.ok(!/booked only/.test(billed.reason));
});

test('decide lag window: booked spend counts only after the last complete billed day', async () => {
  const sn = await snap(); // billed reviewers $25 through 11-10T00:00Z; the review pace cap at day 10 is about $34
  const before = tmp(); bk({ dir: before.dir }, 'review', 40, '2026-11-09T05:00:00Z'); bk({ dir: before.dir }, 'review', 40, '2026-11-09T06:00:00Z'); // inside the billed days: billed already says it all
  assert.equal(dB({ dir: before.dir }, 'review', sn).decision, 'api');
  const after = tmp(); bk({ dir: after.dir }, 'review', 40, '2026-11-10T05:00:00Z'); bk({ dir: after.dir }, 'review', 40, '2026-11-10T06:00:00Z'); // not reported yet: added on top of billed
  const d = dB({ dir: after.dir }, 'review', sn);
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /pace: review spent \$105.00 \(billed\)/);
});

test('decide balance: the total is billed across all workspaces plus the unreported window', async () => {
  const s = tmp();
  const big = await snap({ cost: [['2026-11-03', WS_B, 15500, 'Claude Sonnet 5.5 - Output Tokens', 'claude-sonnet-5-5']] }); // workers billed $155
  const d = dB({ dir: s.dir }, 'review', big, { ...BCFG, itemEstimate: 40 });
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /^balance: \$45\.00 left of \$200 \(billed\)/);
});

test('workspace limits: a category whose workspace is at or over its monthly limit is refused; below it is allowed', async () => {
  const sn = await snap(); // reviewers billed $25 this month
  const cfg = (lim) => ({ ...BCFG, workspaceLimits: { reviewers: lim } });
  const p = tmp();
  const over = dB({ dir: p.dir }, 'review', sn, cfg(20));
  assert.equal(over.decision, 'plan');
  assert.match(over.reason, /workspace limit: reviewers at \$25\.00 of its \$20\.00 monthly limit/);
  assert.equal(dB({ dir: p.dir }, 'review', sn, cfg(25)).decision, 'plan', 'at the limit is refused');
  assert.equal(dB({ dir: tmp().dir }, 'review', sn, cfg(26)).decision, 'api');
  // booked spend after the last complete day counts toward the limit
  const q = tmp(); bk({ dir: q.dir }, 'review', 2, '2026-11-10T08:00:00Z');
  assert.equal(dB({ dir: q.dir }, 'review', sn, cfg(26)).decision, 'plan');
  // a limit on another workspace does not touch this category; a limit given by wrkspc_ id works
  assert.equal(dB({ dir: tmp().dir }, 'review', sn, { ...BCFG, workspaceLimits: { workers: 1 } }).decision, 'api');
  assert.equal(dB({ dir: tmp().dir }, 'review', sn, { ...BCFG, workspaceLimits: { [WS_A]: 10 } }).decision, 'plan');
});

test('workspace limits without billing data: checked against the booked spend of the workspace this month', async () => {
  const p = tmp(); const fx = { dir: p.dir };
  bk(fx, 'review', 12, '2026-11-04T00:00:00Z');
  const d = dB(fx, 'review', null, { ...BCFG, workspaceLimits: { reviewers: 10 } });
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /workspace limit: reviewers at \$12\.00 of its \$10\.00 monthly limit \(booked only, not verified against billing\)/);
});

test('config: workspace limits default to none, the review workspace follows api_spend_reviewers_workspace, limits and the map parse', () => {
  assert.deepEqual(parseWorkspaceLimits('reviewers=100, workers=$60;bad=0 junk=x'), { reviewers: 100, workers: 60 });
  assert.deepEqual(parseCategoryWorkspaces('Workers=agents, review=wrkspc_X'), { workers: 'agents', review: 'wrkspc_X' });
  const none = loadSpendConfig(() => '', {});
  assert.deepEqual(none.workspaceLimits, {});
  assert.deepEqual(none.categoryWorkspaces, { review: 'reviewers', workers: 'workers' });
  const set = loadSpendConfig((k, f) => ({ api_spend_reviewers_workspace: 'rev2', api_credits_workspace_limits: 'rev2=50' })[k] ?? f, {});
  assert.equal(set.categoryWorkspaces.review, 'rev2');
  assert.deepEqual(set.workspaceLimits, { rev2: 50 });
  const own = loadSpendConfig((k, f) => ({ api_spend_reviewers_workspace: 'rev2', api_credits_category_workspaces: 'review=rev3' })[k] ?? f, {});
  assert.equal(own.categoryWorkspaces.review, 'rev3');
});

test('status lines: billed month and cycle by workspace, key and model, booked beside it, credits left, limits, no gaps', async () => {
  const sn = await snap();
  const p = tmp();
  bk({ dir: p.dir }, 'review', 24, '2026-11-05T10:30:00Z'); // matches usage on reviewers at 10:00Z; billed $25
  const entries = readLedgerEntries(p.dir);
  const text = billingStatusLines(sn, { cfg: { ...BCFG, workspaceLimits: { reviewers: 50 } }, entries, now: NOW, cacheAgeMs: 0 }).join('\n');
  assert.match(text, /calendar month 2026-11: billed \$29\.00 through 2026-11-09 \(complete UTC days\) \| booked \$24\.00/);
  assert.match(text, /by workspace: reviewers \$25\.00 of \$50\.00 limit \(50%\), workers \$3\.00, default \$1\.00/);
  assert.match(text, /by model: sonnet-5-5 \$23\.00, haiku-5-5 \$6\.00/);
  assert.match(text, /by key \(tokens; est = list price\): review-key 0\.01M tokens, est \$/);
  assert.match(text, /credits left \(estimate\) = monthly plan credit \$200 - billed this cycle \$29\.00 = \$171\.00/);
  assert.match(text, /workspace limits \(calendar month, billed\): reviewers \$25\.00 of \$50\.00 \(50%\)/);
  assert.match(text, /gaps: none/);
  assert.ok(!/GAP/.test(text));
});

test('status gaps: booked over billed beyond the tolerance, and booked entries with no usage on their workspace in that hour', async () => {
  const sn = await snap();
  const p = tmp(); const fx = { dir: p.dir };
  bk(fx, 'review', 24, '2026-11-05T10:30:00Z'); // matched hour
  bk(fx, 'review', 30, '2026-11-06T03:10:00Z'); // no usage on reviewers that hour
  bk(fx, 'review', 1, '2026-11-05T11:05:00Z'); // the hour before (10:00) has usage: matched
  bk(fx, 'overflow', 50, '2026-11-07T00:00:00Z'); // no workspace mapped: held to the default workspace, which has no usage that hour either
  const text = billingStatusLines(sn, { cfg: BCFG, entries: readLedgerEntries(p.dir), now: NOW }).join('\n');
  assert.match(text, /GAP: all categories: booked \$105\.00 but billed \$29\.00/);
  assert.match(text, /GAP: workspace reviewers: booked \$55\.00 but billed \$25\.00/);
  assert.match(text, /GAP: 2 booked entries \(\$80\.00\) with no usage on their workspace in that hour: 2026-11-06T03:10Z review \$30\.00, 2026-11-07T00:00Z overflow \$50\.00/);
  assert.ok(!/gaps: none/.test(text));
  // within the tolerance (max $1 or 10% of billed) there is no flag
  const q = tmp(); bk({ dir: q.dir }, 'review', 26.5, '2026-11-05T10:30:00Z');
  const ok = billingStatusLines(sn, { cfg: BCFG, entries: readLedgerEntries(q.dir), now: NOW }).join('\n');
  assert.ok(!/GAP: workspace reviewers/.test(ok));
  // a hole in the hourly report is a gap only inside the fetched window
  const old = tmp(); bk({ dir: old.dir }, 'review', 3, '2026-11-01T03:00:00Z');
  assert.ok(!/GAP: \d+ booked/.test(billingStatusLines(sn, { cfg: BCFG, entries: readLedgerEntries(old.dir), now: NOW }).join('\n')));
});

test('status without billing data: the figures are labelled booked only, not verified against billing', () => {
  const t = billingStatusLines(null, { cfg: BCFG, entries: [], now: NOW, reason: 'no admin key source configured' }).join('\n');
  assert.match(t, /billing: booked only, not verified against billing \(no admin key source configured\)/);
});

test('CLI: decide and status use the Admin API; without a key they fall back and say so', async () => {
  const fx = makeFixture();
  try {
    record('review', 75, 'big', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T00:00:00Z'), cfg: BCFG }); record('review', 75, 'big', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-06T00:00:00Z'), cfg: BCFG });
    const s = mkBilling();
    const inj = { cfg: BCFG, env: { AC_API_KEY: 'present' }, billingFetch: s.fetchImpl, readKey: () => KEY, billingCachePath: join(fx.dir, 'bc.json') };
    const out = [];
    assert.equal(await creditsMain(['decide', 'review', '--now', '2026-11-10T12:00:00Z'], { out: (x) => out.push(x), ...inj }), 0);
    assert.equal(out[0], 'api', out.join('\n'));
    assert.match(out[1], /\(billed\)/);
    const calls = s.calls.length;
    const st = [];
    assert.equal(await creditsMain(['status', '--now', '2026-11-10T12:00:00Z'], { out: (x) => st.push(x), ...inj }), 0);
    assert.equal(s.calls.length, calls, 'status reuses the cache of decide');
    const text = st.join('\n');
    assert.match(text, /billing \(Admin API, cached \d+ min ago\)|billing \(Admin API, fetched now\)/);
    assert.match(text, /credits left \(estimate\)/);
    assert.match(text, /GAP: all categories: booked \$150\.00 but billed \$29\.00/);
    assert.ok(!text.includes(KEY));
    // no admin key: booked only
    const out2 = []; const st2 = [];
    const noKey = { cfg: BCFG, env: { AC_API_KEY: 'present' }, readKey: () => { throw new Error('no admin key source configured (api_admin_key_source)'); }, billingCachePath: join(fx.dir, 'bc2.json') };
    await creditsMain(['decide', 'review', '--now', '2026-11-10T12:00:00Z'], { out: (x) => out2.push(x), ...noKey });
    assert.equal(out2[0], 'plan');
    assert.match(out2[1], /booked only, not verified against billing/);
    await creditsMain(['status', '--now', '2026-11-10T12:00:00Z'], { out: (x) => st2.push(x), ...noKey });
    assert.match(st2.join('\n'), /billing: booked only, not verified against billing \(no admin key source configured/);
  } finally { fx.cleanup(); }
});

function readLedgerEntries(dir) {
  const led = JSON.parse(readFileSync(join(dir, 'led.json'), 'utf8'));
  return Object.values(led.cycles).flatMap((c) => c.entries);
}

test('billing: a failed fetch is not retried for 5 minutes (negative cache); a later call and force retry', async () => {
  const cachePath = join(tmp().dir, 'c.json');
  let reads = 0;
  const readKey = () => { reads++; throw new Error('no admin key source configured'); };
  const get = (now, extra = {}) => getBilling({ now, cfg: BCFG, fetchImpl: mkBilling().fetchImpl, readKey, cachePath, ...extra });
  assert.equal((await get(NOW)).ok, false);
  assert.equal(reads, 1);
  const again = await get(NOW + 60000);
  assert.equal(again.ok, false);
  assert.match(again.reason, /no admin key/);
  assert.equal(reads, 1, 'no second attempt inside 5 minutes');
  await get(NOW + 6 * 60000);
  assert.equal(reads, 2);
  await get(NOW + 6 * 60000 + 1000, { force: true });
  assert.equal(reads, 3);
});

test('decide CLI: a billing fetch that never answers falls back to booked only after the deadline', async () => {
  const lines = [];
  const never = () => new Promise(() => {});
  const env = { AC_API_KEY: 'sk-ant-api03-x' };
  const code = await creditsMain(['decide', 'review'], { out: (s) => lines.push(s), cfg: { ...CFG }, env, readKey: never, billingDeadlineMs: 50, billingCachePath: join(tmp().dir, 'c.json') });
  assert.equal(code, 0);
  assert.ok(['api', 'plan'].includes(lines[0]));
  if (lines[0] === 'api') assert.match(lines[1], /booked only/);
});

test('config: workers maps to the workspace id from the runner variable or option unless set explicitly', () => {
  const none = loadSpendConfig((k, d) => d, {});
  assert.equal(none.categoryWorkspaces.workers, 'workers');
  const viaVar = loadSpendConfig((k, d) => d, { AC_API_WORKERS_WORKSPACE_ID: 'wrkspc_W1' });
  assert.equal(viaVar.categoryWorkspaces.workers, 'wrkspc_W1');
  const viaOpt = loadSpendConfig((k, d) => ({ api_workers_workspace_id: 'wrkspc_W2' })[k] ?? d, {});
  assert.equal(viaOpt.categoryWorkspaces.workers, 'wrkspc_W2');
  const notId = loadSpendConfig((k, d) => d, { AC_API_WORKERS_WORKSPACE_ID: 'some-name' });
  assert.equal(notId.categoryWorkspaces.workers, 'workers');
  const explicit = loadSpendConfig((k, d) => ({ api_credits_category_workspaces: 'workers=mine' })[k] ?? d, { AC_API_WORKERS_WORKSPACE_ID: 'wrkspc_W1' });
  assert.equal(explicit.categoryWorkspaces.workers, 'mine');
});

test('status: a category whose workspace does not resolve is named', () => {
  const snapshot = { through: T('2026-11-10T00:00:00Z'), from: T('2026-11-01T00:00:00Z'), cost: [], workspaces: { [REV]: 'reviewers' } };
  const lines = billingStatusLines(snapshot, { cfg: { ...CFG, categoryWorkspaces: { review: 'reviewers', workers: 'workers' } }, entries: [], now: NOW });
  assert.ok(lines.includes('category workers: workspace workers not found, booked spend only'));
  assert.ok(!lines.some((l) => l.startsWith('category review:')));
});

test('workspace limit set by name still holds when workers is mapped by id and billing is down', () => {
  const p = tmp(); const fx = { dir: p.dir };
  bk(fx, 'workers', 60, '2026-11-04T00:00:00Z');
  const cfg = { ...BCFG, categoryWorkspaces: { ...BCFG.categoryWorkspaces, workers: 'wrkspc_x' }, workspaceLimits: { workers: 50 } };
  const d = dB(fx, 'workers', null, cfg);
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /workspace limit: .* at \$60\.00 of its \$50\.00 monthly limit/);
  const ok = dB({ dir: tmp().dir }, 'workers', null, cfg);
  assert.equal(ok.decision, 'api', ok.reason);
});

test('pace of an unmapped category counts bookings from before the last billed day and can trip the gate', async () => {
  const sn = await snap(); // billed through 11-10T00:00Z; workers has no workspace in the snapshot
  const cfg = { ...BCFG, categoryWorkspaces: { ...BCFG.categoryWorkspaces, workers: 'nowhere' } };
  const p = tmp(); const fx = { dir: p.dir };
  for (const day of ['03', '04', '05']) bk(fx, 'workers', 25, `2026-11-${day}T00:00:00Z`); // before the cut-off; workers share $60 x ~0.3 elapsed = $20 + one $25 item
  const d = dB(fx, 'workers', sn, cfg);
  assert.equal(d.decision, 'plan', d.reason);
  assert.match(d.reason, /pace: workers spent \$75.00 \(booked only, no workspace mapped\)/);
  assert.equal(dB({ dir: tmp().dir }, 'workers', sn, cfg).decision, 'api');
});

test('config: a workspace id from the --workspace-id flag reaches the credits child as the workers variable', async () => {
  const { creditsEnv } = await import('../scripts/api-worker.mjs');
  const env = creditsEnv({ PATH: '/bin' }, 'wrkspc_flag');
  assert.equal(env.AC_API_WORKERS_WORKSPACE_ID, 'wrkspc_flag');
  assert.equal(loadSpendConfig((k, d) => d, env).categoryWorkspaces.workers, 'wrkspc_flag');
  assert.equal(creditsEnv({ PATH: '/bin' }, '').AC_API_WORKERS_WORKSPACE_ID, undefined);
});
