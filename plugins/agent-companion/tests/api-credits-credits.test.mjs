// `api-credits.mjs credits` and `credits anchor`: used this cycle (billed + booked), remaining against a Console balance anchor,
// the caps, the fallbacks and the warnings. Driven with a stubbed Admin API fetch, a stubbed key reader and a temp state dir:
// no live calls, no real key. Invented names and ids throughout; the key is a sentinel that must never reach any output.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SHARES, record, readAnchor, anchorPath, creditsView, decide, loadConfig, recordFailure, DEFAULT_BUDGET_MODE, DEFAULT_RESERVE_USD } from '../scripts/lib/api-credits.mjs';
import { makeFixture } from './helpers.mjs';
import { main } from '../scripts/api-credits.mjs';

const T = (s) => Date.parse(s);
const KEY = 'sk-ant-admin01-SENTINEL-do-not-leak-0123456789';
const NOW_ISO = '2026-11-10T12:00:00Z'; // cycle day 10; the cost report reaches 11-10T00:00Z
const WS_A = 'wrkspc_AAAA';
const WS_B = 'wrkspc_BBBB';
const CFG = {
  budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:AC_API_KEY', reviewRatio: 0.5, itemEstimate: 2,
  adminKeySource: 'env:AC_ADMIN_KEY', alerts: [50], reviewersWorkspace: 'reviewers',
  workspaceLimits: { reviewers: 60 }, categoryWorkspaces: { review: 'reviewers', workers: 'workers' },
};

// cost: [day, workspace id|null, cents, description, model]
function billingStub({ cost, failPath = null }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (failPath && u.pathname.includes(failPath)) return { ok: false, status: 500, json: async () => ({ error: { type: 'api_error' } }) };
    const day = (d) => ({ starting_at: `${d}T00:00:00Z`, ending_at: new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString() });
    if (u.pathname === '/v1/organizations/workspaces') return ok({ data: [{ id: WS_A, name: 'reviewers' }, { id: WS_B, name: 'workers' }], has_more: false, last_id: null });
    if (u.pathname === '/v1/organizations/api_keys') return ok({ data: [], has_more: false, last_id: null });
    if (u.pathname === '/v1/organizations/cost_report') {
      const days = [...new Set(cost.map((c) => c[0]))].sort();
      return ok({ data: days.map((d) => ({ ...day(d), results: cost.filter((c) => c[0] === d).map(([, ws, cents, description, model]) => ({ currency: 'USD', amount: String(cents), workspace_id: ws, description, model })) })), has_more: false, next_page: null });
    }
    if (u.pathname === '/v1/organizations/usage_report/messages') return ok({ data: [], has_more: false, next_page: null });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

// Billed through 11-10T00:00Z: 11-02 reviewers $20.00, 11-03 reviewers $5.00, 11-04 workers $3.00 and the default workspace $1.00 (total $29.00).
const COST = [
  ['2026-11-02', WS_A, 2000, 'Claude Sonnet 5.5 - Output Tokens', 'claude-sonnet-5-5'],
  ['2026-11-03', WS_A, 500, 'Claude Haiku 5.5 - Output Tokens', 'claude-haiku-5-5'],
  ['2026-11-04', WS_B, 300, 'Claude Sonnet 5.5 - Input Tokens', 'claude-sonnet-5-5'],
  ['2026-11-04', null, 100, 'Claude Haiku 5.5 - Input Tokens', 'claude-haiku-5-5'],
];

// One CLI call. `withKey: false` makes the key reader throw (no admin key configured).
async function run(fx, argv, { withKey = true, failPath = null, stub = null } = {}) {
  const s = stub || billingStub({ cost: COST, failPath });
  const out = [];
  const inj = {
    cfg: CFG, env: { AC_API_KEY: 'present' }, billingFetch: s.fetchImpl, billingCachePath: join(fx.dir, 'bc.json'),
    readKey: withKey ? () => KEY : () => { throw new Error('no admin key source configured (api_admin_key_source)'); },
  };
  const code = await main([...argv, '--now', NOW_ISO], { out: (x) => out.push(x), ...inj });
  return { code, text: out.join('\n'), stub: s };
}

const book = (cat, usd, at) => record(cat, usd, 'item', { apiKeySource: 'ANTHROPIC_API_KEY', now: T(at), cfg: CFG });
const withFixture = (fn) => async () => { const fx = makeFixture(); try { await fn(fx); } finally { fx.cleanup(); } };

test('credits: billed + booked-not-yet-billed + anchor arithmetic', withFixture(async (fx) => {
  book('review', 10, '2026-11-05T09:00:00Z'); // already inside the billed days: not counted again
  book('review', 2, '2026-11-10T06:00:00Z'); // after the last complete billed day: the lag window
  assert.equal((await run(fx, ['credits', 'anchor', '100', '--date', '2026-11-03T08:00:00Z'])).code, 0);
  const r = await run(fx, ['credits', '--json']);
  assert.equal(r.code, 0);
  const v = JSON.parse(r.text);
  assert.equal(v.source, 'billing');
  assert.equal(v.billed.cycleTotal, 29);
  assert.equal(v.billed.throughUtc, '2026-11-10T00:00:00.000Z');
  assert.equal(v.booked.cycleTotal, 12);
  assert.equal(v.booked.notYetBilled, 2);
  assert.equal(v.used.combined, 31);
  const byWs = Object.fromEntries(v.billed.byWorkspace.map((w) => [w.name, w.usd]));
  assert.equal(byWs.reviewers, 25);
  assert.equal(byWs.workers, 3);
  assert.equal(v.billed.byWorkspace.reduce((a, w) => a + w.usd, 0), 29); // the default workspace's $1.00 is the rest
  // the anchor's own UTC day counts in full: billed since 11-03 = 5 + 3 + 1 = 9
  assert.equal(v.anchor.usd, 100);
  assert.equal(v.remaining.billedSinceAnchor, 9);
  assert.equal(v.remaining.usd, 91);
  assert.equal(v.remaining.bookedNotYetBilledSinceAnchor, 2);
  assert.equal(v.remaining.afterBooked, 89);
  assert.deepEqual(v.warnings, []);
  // text view
  const t = (await run(fx, ['credits'])).text;
  assert.match(t, /data runs to: 2026-11-10 00:00Z \(end of the last complete UTC day/);
  assert.match(t, /used this cycle, billed: \$29\.00/);
  assert.match(t, /booked, not yet billed: \$2\.00/);
  assert.match(t, /used this cycle, combined: \$31\.00/);
  assert.match(t, /remaining: \$91\.00 = anchor - billed since 2026-11-03 \$9\.00; \$89\.00 after the booked-not-yet-billed \$2\.00/);
  assert.match(t, /by workspace: reviewers \$25\.00, workers \$3\.00/);
  assert.match(t, /workspace limits: reviewers \$27\.00 of \$60\.00 \(45%, billed \+ booked, calendar month\)/); // $25.00 billed + $2.00 booked after the last billed day
}));

test('credits: no anchor says how to set one; the used figures still show', withFixture(async (fx) => {
  const t = (await run(fx, ['credits'])).text;
  assert.match(t, /remaining: no anchor: run `credits anchor <usd>`/);
  assert.match(t, /Console only; the Admin API cannot read it/);
  assert.match(t, /used this cycle, billed: \$29\.00/);
  const v = JSON.parse((await run(fx, ['credits', '--json'])).text);
  assert.equal(v.anchor, null);
  assert.equal(v.remaining, null);
}));

test('credits: no admin key shows the ledger-only view, exit 0, with the reason', withFixture(async (fx) => {
  book('review', 4, '2026-11-06T09:00:00Z');
  book('workers', 1.5, '2026-11-08T09:00:00Z');
  await run(fx, ['credits', 'anchor', '50', '--date', '2026-11-05']);
  const r = await run(fx, ['credits'], { withKey: false });
  assert.equal(r.code, 0);
  assert.equal(r.stub.calls.length, 0, 'no request without a key');
  assert.match(r.text, /billing: not available \(no admin key source configured/);
  assert.match(r.text, /booked, not yet billed: \$5\.50/);
  assert.match(r.text, /used this cycle, combined: \$5\.50/);
  assert.match(r.text, /remaining: \$44\.50 = anchor - booked since 2026-11-05 \$5\.50 \(billing not available; booked only\)/);
  const v = JSON.parse((await run(fx, ['credits', '--json'], { withKey: false })).text);
  assert.equal(v.source, 'ledger-only');
  assert.equal(v.billed, null);
  assert.match(v.fallbackReason, /no admin key/);
}));

test('credits: an Admin API error falls back to the ledger view, exit 0', withFixture(async (fx) => {
  book('review', 3, '2026-11-06T09:00:00Z');
  const r = await run(fx, ['credits'], { failPath: 'cost_report' });
  assert.equal(r.code, 0);
  assert.ok(r.stub.calls.length > 0, 'the API was tried');
  assert.match(r.text, /billing: not available \(.+\); showing the local ledger only/);
  assert.match(r.text, /booked, not yet billed: \$3\.00/);
  assert.ok(!r.text.includes(KEY));
}));

test('credits: warns when the anchor is older than one cycle', withFixture(async (fx) => {
  await run(fx, ['credits', 'anchor', '300', '--date', '2026-09-20']);
  const v = JSON.parse((await run(fx, ['credits', '--json'])).text);
  assert.ok(v.warnings.some((w) => /older than one cycle/.test(w)), v.warnings.join(' | '));
  assert.match((await run(fx, ['credits'])).text, /WARNING: the anchor is \d+ days old \(older than one cycle\)/);
}));

test('credits: warns of a probable top-up when spend since the anchor exceeds the anchored balance', withFixture(async (fx) => {
  await run(fx, ['credits', 'anchor', '5', '--date', '2026-11-03']); // billed since 11-03 is $9.00
  const v = JSON.parse((await run(fx, ['credits', '--json'])).text);
  assert.ok(v.warnings.some((w) => /top-up/.test(w) && /\$9\.00/.test(w) && /\$5\.00/.test(w)), v.warnings.join(' | '));
  assert.ok(v.remaining.usd < 0);
}));

test('credits: warns when the anchor is before the billing window fetched', withFixture(async (fx) => {
  await run(fx, ['credits', 'anchor', '500', '--date', '2026-10-25']);
  const v = JSON.parse((await run(fx, ['credits', '--json'])).text);
  assert.ok(v.warnings.some((w) => /before the billing window/.test(w) && /2026-10-25/.test(w) && /2026-11-01/.test(w)), v.warnings.join(' | '));
}));

test('credits --json: the shape', withFixture(async (fx) => {
  await run(fx, ['credits', 'anchor', '100', '--date', '2026-11-03']);
  const r = await run(fx, ['credits', '--json']);
  const v = JSON.parse(r.text);
  for (const k of ['source', 'cycle', 'billed', 'booked', 'used', 'anchor', 'remaining', 'caps', 'warnings']) assert.ok(k in v, `missing ${k}`);
  assert.deepEqual(Object.keys(v.cycle).sort(), ['day', 'end', 'fractionElapsed', 'key', 'reserveReleased', 'start']);
  assert.deepEqual(Object.keys(v.caps).sort(), ['categories', 'monthlyBudget', 'reserveReleased', 'reserveShare', 'workspaceLimits']);
  assert.equal(v.caps.monthlyBudget, 200);
  assert.deepEqual(v.caps.categories.map((c) => c.category), ['review', 'overflow', 'rater', 'workers']);
  for (const c of v.caps.categories) for (const k of ['share', 'shareUsd', 'spent', 'basis', 'paceCapNow', 'usedOfPaceCap', 'workspace']) assert.ok(k in c, `category missing ${k}`);
  // review pace cap on cycle day 10 of 30: share x budget x fraction + the default item estimate
  const rev = v.caps.categories.find((c) => c.category === 'review');
  assert.ok(Math.abs(rev.paceCapNow - (rev.share * 200 * v.cycle.fractionElapsed + 2)) < 1e-9);
  assert.ok(Array.isArray(v.warnings));
  assert.equal(r.text.trim()[0], '{', 'json only: no prose around it');
}));

test('credits: the admin key never appears in any output', withFixture(async (fx) => {
  book('review', 2, '2026-11-10T06:00:00Z');
  const all = [];
  all.push((await run(fx, ['credits', 'anchor', '100', '--date', '2026-11-03'])).text);
  all.push((await run(fx, ['credits'])).text);
  all.push((await run(fx, ['credits', '--json'])).text);
  all.push((await run(fx, ['credits'], { failPath: 'cost_report' })).text);
  all.push((await run(fx, ['credits', '--json'], { withKey: false })).text);
  for (const t of all) { assert.ok(!t.includes(KEY)); assert.ok(!/sk-ant-/.test(t)); }
  const s = billingStub({ cost: COST });
  await run(fx, ['credits'], { stub: s });
  assert.ok(s.calls.every((c) => (c.init && c.init.method ? c.init.method === 'GET' : true)), 'GET only');
  assert.ok(!readFileSync(anchorPath(), 'utf8').includes(KEY));
}));

test('credits anchor: writes, then replaces; --date and the amount are checked', withFixture(async (fx) => {
  assert.equal(existsSync(anchorPath()), false);
  const first = await run(fx, ['credits', 'anchor', '183.40']);
  assert.equal(first.code, 0);
  assert.match(first.text, /anchored: Console balance \$183\.40 as of 2026-11-10T12:00:00\.000Z$/);
  let a = readAnchor();
  assert.equal(a.usd, 183.4);
  assert.equal(a.asOf, T(NOW_ISO));
  const second = await run(fx, ['credits', 'anchor', '$150', '--date', '2026-11-05']);
  assert.equal(second.code, 0);
  assert.match(second.text, /anchored: Console balance \$150\.00 as of 2026-11-05T00:00:00\.000Z; replaced \$183\.40 as of 2026-11-10$/);
  a = readAnchor();
  assert.equal(a.usd, 150);
  assert.equal(a.asOf, T('2026-11-05T00:00:00Z'));
  // refusals leave the stored anchor alone
  for (const argv of [['credits', 'anchor', 'abc'], ['credits', 'anchor', '-5'], ['credits', 'anchor'], ['credits', 'anchor', '10', '--date'], ['credits', 'anchor', '10', '--date', 'yesterday'], ['credits', 'anchor', '10', '--date', '2026-12-01']]) {
    const r = await run(fx, argv);
    assert.equal(r.code, 2, argv.join(' '));
  }
  assert.equal(readAnchor().usd, 150);
}));

test('creditsView: pure, ledger unreadable is a warning, not a throw', () => {
  const v = creditsView({ snap: null, reason: 'x', cfg: CFG, ledgerCycle: {}, ledgerOk: false, anchor: null, now: T(NOW_ISO) });
  assert.equal(v.source, 'ledger-only');
  assert.ok(v.warnings.some((w) => /ledger is unreadable/.test(w)));
});

// --- 0.31.79 credit-mode gate: decide() on the remaining Console credit minus the reserve ---------------------------------
const GENV = { AC_API_KEY: 'present', AC_KEY_A: 'present' };
const GNOW = T('2026-11-10T12:00:00Z');
const CCFG = { ...CFG, budgetMode: 'credit', reserveUsd: 5, workspaceLimits: {}, workspaceLimitHard: {} };
const anchorAt = (usd) => ({ usd, asOf: T('2026-11-01T00:00:00Z'), setAt: T('2026-11-01T00:00:00Z') });
const anchorOf = (usd, extra = {}) => ({ primary: anchorAt(usd), ...extra });
const gpath = (fx) => join(fx.dir, 'gate-ledger.json');
const gate = (fx, { cfg = CCFG, anchors = anchorOf(100), cat = 'review', target = null } = {}) =>
  decide(cat, { now: GNOW, cfg, anchors, billing: null, path: gpath(fx), env: GENV, target });
const gbook = (fx, usd, cfg = CCFG, target = null) => record('review', usd, 'item', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T09:00:00Z'), cfg, path: gpath(fx), target });

test('gate: credit left above the reserve answers api, even when the fixed budget would be spent', withFixture(async (fx) => {
  gbook(fx, 120); // past the fixed $200 budget's pace cap, but $380 of the $500 balance remains
  const d = gate(fx, { anchors: anchorOf(500) });
  assert.equal(d.decision, 'api', d.reason);
  assert.match(d.reason, /credit left of the \$500\.00 Console balance/);
}));

test('gate: spent down to the reserve answers plan with the top-up hint', withFixture(async (fx) => {
  gbook(fx, 96); // 100 - 96 = 4, below the $5 reserve
  const d = gate(fx);
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /credit: .*minus the \$5\.00 reserve/);
  assert.match(d.reason, /credits anchor/);
}));

test('gate: no anchor keeps the fixed budget', withFixture(async (fx) => {
  const d = gate(fx, { anchors: {} });
  assert.equal(d.decision, 'api');
  assert.doesNotMatch(d.reason, /Console balance/);
  gbook(fx, 1000); // fixed budget blown
  const e = gate(fx, { anchors: {} });
  assert.equal(e.decision, 'plan');
  assert.match(e.reason, /balance: |pace: /);
}));

test('gate: a "!" workspace limit is enforced in credit mode', withFixture(async (fx) => {
  const cfg = { ...CCFG, workspaceLimits: { reviewers: 10 }, workspaceLimitHard: { reviewers: true } };
  gbook(fx, 12, cfg);
  const d = gate(fx, { cfg, anchors: anchorOf(500) });
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /workspace limit: reviewers .*enforced, set with !/);
}));

test('gate: a plain workspace limit in credit mode does not stop work and is noted as advisory', withFixture(async (fx) => {
  const cfg = { ...CCFG, workspaceLimits: { reviewers: 10 }, workspaceLimitHard: {} };
  gbook(fx, 12, cfg);
  const d = gate(fx, { cfg, anchors: anchorOf(500) });
  assert.equal(d.decision, 'api', d.reason);
  assert.match(d.reason, /advisory in credit mode/);
}));

test('gate: fixed mode ignores the anchor and gates on the fixed budget', withFixture(async (fx) => {
  const cfg = { ...CCFG, budgetMode: 'fixed' };
  gbook(fx, 1000, cfg);
  const d = gate(fx, { cfg, anchors: anchorOf(5000) });
  assert.equal(d.decision, 'plan');
  assert.doesNotMatch(d.reason, /Console balance/);
}));

test('gate: a named target gates on its own anchor, and failover moves on when the primary credit is spent', withFixture(async (fx) => {
  const cfg = { ...CCFG, targets: { primary: { name: 'primary', keySource: 'env:AC_API_KEY', builtin: true }, spare: { name: 'spare', keySource: 'env:AC_KEY_A', workspace: '', admin: '' } }, categoryTargets: { review: ['primary', 'spare'] } };
  gbook(fx, 96, cfg); // primary down to $4 of $100: below the reserve
  const anchors = anchorOf(100, { spare: anchorAt(50) });
  const d = gate(fx, { cfg, anchors });
  assert.equal(d.decision, 'api', d.reason);
  assert.equal(d.target, 'spare');
  assert.match(d.reason, /\$50\.00 Console balance/);
  gbook(fx, 47, cfg, 'spare'); // spare down to $3
  const e = gate(fx, { cfg, anchors, target: 'spare' });
  assert.equal(e.decision, 'plan');
  assert.match(e.reason, /target spare: credit: /);
}));

test('gate: a real spend-limit rejection (breaker tripped) falls back to the plan even with credit left', withFixture(async (fx) => {
  assert.equal(gate(fx, { anchors: anchorOf(500) }).decision, 'api');
  recordFailure('HTTP 400: You have reached your specified workspace API usage limits', { now: GNOW, cfg: CCFG, path: gpath(fx), hard: true });
  const d = gate(fx, { anchors: anchorOf(500) });
  assert.equal(d.decision, 'plan');
  assert.match(d.reason, /API runs failed/);
}));

test('default: a real install with no mode set (normal option path) gets credit mode and the $5 reserve, and the gate uses it', withFixture(async (fx) => {
  assert.equal(DEFAULT_BUDGET_MODE, 'credit');
  assert.equal(DEFAULT_RESERVE_USD, 5);
  const cfg = loadConfig(); // the real option reader, nothing set
  assert.equal(cfg.budgetMode, 'credit');
  assert.equal(cfg.reserveUsd, 5);
  assert.equal(loadConfig((k, d) => (k === 'api_credits_budget_mode' ? 'fixed' : d)).budgetMode, 'fixed');
  assert.equal(loadConfig((k, d) => (k === 'api_credits_budget_mode' ? 'bogus' : d)).budgetMode, 'credit');
  // decide() with no cfg argument builds the same default: fixed budget blown, anchored credit left -> api on credit
  record('review', 1000, 'big', { apiKeySource: 'ANTHROPIC_API_KEY', now: T('2026-11-05T09:00:00Z'), path: gpath(fx) });
  const d = decide('review', { now: GNOW, anchors: anchorOf(5000), path: gpath(fx), env: GENV });
  assert.equal(d.decision, 'api', d.reason);
  assert.match(d.reason, /Console balance/);
}));

test('manifest: plugin.json declares mode default credit and reserve default 5', () => {
  const m = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).userConfig;
  assert.equal(m.api_credits_budget_mode.default, 'credit');
  assert.equal(m.api_credits_reserve_usd.default, 5);
});
