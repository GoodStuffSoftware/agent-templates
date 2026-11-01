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
import { DEFAULT_SHARES, record, recordSpend } from '../scripts/lib/api-credits.mjs';
import {
  check, ack, ackedIds, readAdminKey, parseAdminKeySource, parseAlerts, loadSpendConfig, scrub, unexplained,
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
  record('review', 12.34, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
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
  record('review', 12.5, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
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
  record('review', 52, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
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
  record('review', 60, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const lo = await run(stub({ cents: { [REV]: 4900 } }), { ...p, o: { cfg: { ...CFG, alerts: [50] } } });
  assert.deepEqual(lo.notify, []);
  const hi = await run(stub({ cents: { [REV]: 6000 } }), { ...p, o: { cfg: { ...CFG, alerts: [25, 50, 90] } } });
  assert.deepEqual(hi.notify.map((n) => n.id), ['reviewers-25', 'reviewers-50']);
});

test('cycle rollover: an alert acked last cycle fires again in the new cycle', async () => {
  const p = tmp();
  ack('reviewers-50', { now: NOW, cfg: CFG, path: p.alerts });
  const later = T('2026-12-03T12:00:00Z');
  record('review', 55, 't', { now: T('2026-12-02T01:00:00Z'), cfg: CFG, path: p.ledger });
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
  record('review', 20, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
  const r = await run(stub({ cents: { [REV]: 5200 } }), p);
  assert.equal(r.line, 'API credits: reviewers $52 of $100 · total $52 of $200 · cycle day 10 · unexplained $32');
  assert.deepEqual(r.notify.map((n) => n.id).sort(), ['reviewers-50', 'unexplained']);
  const u = r.notify.find((n) => n.id === 'unexplained');
  assert.match(u.message, /\$32\.00/);
  // within tolerance: not flagged
  const ok = await run(stub({ cents: { [REV]: 5200 } }), (() => { const q = tmp(); record('review', 50, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: q.ledger }); return q; })());
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
  record('review', 40, 't', { now: T('2026-11-10T09:00:00Z'), cfg: CFG, path: p.ledger }); // today: not in the report yet
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
  record('review', 52, 't', { now: T('2026-11-05T00:00:00Z'), cfg: CFG, path: p.ledger });
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
  const c = loadSpendConfig((k, d) => d);
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
