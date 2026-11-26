// Review fixes for named API targets (0.31.72): the primary pick when the list starts elsewhere, the worker with the options unset,
// the org call, per-attempt review ids, the SDK credit trigger, and the --target nits. The network is mocked (no live calls).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { loadConfig, decide, record, recordFallback, PRIMARY } from '../scripts/lib/api-credits.mjs';
import { fetchBilling, loadSpendConfig } from '../scripts/lib/api-spend.mjs';
import { main as reviewMain } from '../scripts/api-review.mjs';
import { runWorker } from '../scripts/api-worker.mjs';
import { briefDeclarations } from '../hooks/lib/brief-directives.mjs';
import { routeReview } from '../hooks/lib/sg-review-route.mjs';
import { runApiSdk } from '../scripts/lib/api-sdk-run.mjs';
import { spawnSyncHidden } from '../scripts/lib/proc.mjs';

const K0 = 'sk-ant-api03-PRIMARY-testkeytestkey';
const KA = 'sk-ant-api03-TARGETA-testkeytestkey';
const KB = 'sk-ant-api03-TARGETB-testkeytestkey';
const ENV = { AC_API_KEY: K0, AC_KEY_A: KA, AC_KEY_B: KB };
const TARGETS = JSON.stringify({ a: { key: 'env:AC_KEY_A' }, b: { key: 'env:AC_KEY_B', budget: 50 } });
const mk = (opts = {}) => loadConfig((k, d) => (k in opts ? opts[k] : d));
const OK = { status: 200, body: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'VERDICT: PASS' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } } };
const ENF429 = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'cap', details: { error_code: 'enforced_spend_limit_reached' } } } };
const SPEND400 = 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC';

function keyed(byKey) {
  const calls = {};
  const f = async (url, init) => {
    const k = init.headers['x-api-key'];
    calls[k] = (calls[k] || 0) + 1;
    const r = byKey[k] || OK;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  f.calls = calls;
  return f;
}

function rig() {
  const fx = makeFixture();
  const repo = join(fx.dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => { const r = spawnSyncHidden('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'second');
  const brief = join(fx.dir, 'brief.txt');
  writeFileSync(brief, 'TYPE: bounded-feature\nthe lead brief, verbatim\n');
  const run = async (fetchImpl, { cfg, extra = [] } = {}) => {
    const lines = [];
    const code = await reviewMain(['run', '--brief-file', brief, '--diff-ref', 'HEAD~1..HEAD', '--model', 'sonnet', '--cwd', repo, '--runner', 'fetch', ...extra],
      { out: (s) => lines.push(s), err: () => {}, env: ENV, fetchImpl, sleep: async () => {}, cfg });
    return { code, out: lines.join('\n') };
  };
  const ledger = () => { const p = join(fx.stateDir, 'state', 'api-credits.json'); return existsSync(p) ? Object.values(JSON.parse(readFileSync(p, 'utf8')).cycles)[0] : null; };
  return { fx, run, ledger };
}

test('fix 1: a list that starts elsewhere (review=b,primary) answers the primary by name, and the runner stays on it', async () => {
  const cfg = mk({ api_targets: TARGETS, api_category_targets: 'review=b,primary' });
  const t = makeFixture();
  try {
    const path = join(t.dir, 'ledger', 'api-credits.json');
    record('review', 100, 'over the budget of b', { cfg, path, apiKeySource: 'ANTHROPIC_API_KEY', target: 'b' }); // b has a 50 budget
    const d = decide('review', { cfg, env: ENV, path });
    assert.equal(d.decision, 'api');
    assert.equal(d.target, 'primary');
    // the options unset: no target key, as 0.31.71 answered
    const u = decide('review', { cfg: mk(), env: ENV, path: join(t.dir, 'ledger2', 'api-credits.json') });
    assert.equal(u.decision, 'api');
    assert.ok(!('target' in u));
  } finally { t.cleanup(); }
  const r = rig();
  try {
    const f = keyed({});
    const out = await r.run(f, { cfg, extra: ['--target', 'primary'] });
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(f.calls, { [K0]: 1 }, 'ran on the primary only, never on b');
  } finally { r.fx.cleanup(); }
  const w = makeFixture();
  try {
    const b = `TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: mid\nBranch fix/zz, diff range main..fix/zz in WORKTREE: ${w.dir}\n`;
    const rr = await routeReview({ typeIsParity: true, declaredType: 'code-review', brief: b, decls: briefDeclarations(b), p: { tool_use_id: 'toolu_t2', cwd: w.dir }, input: { subagent_type: 'agent-companion:ac-sonnet-high', description: 'r', prompt: b }, subagentCaller: true, model: 'sonnet',
      deps: { opt: (k, d) => (k === 'api_review_route' ? 'all' : d), decide: () => ({ decision: 'api', reason: 'ok', target: 'primary' }), stateDir: () => join(w.dir, 'st'), telemetryDir: () => join(w.dir, 'tel') } });
    assert.equal(rr.route, 'api');
    assert.match(rr.updatedInput.prompt, / --target primary /);
  } finally { w.cleanup(); }
});

const sdkFor = (cappedKeys) => ({ query: ({ options }) => (async function* () {
  yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' };
  if (cappedKeys.includes(options.env.ANTHROPIC_API_KEY)) yield { type: 'result', subtype: 'success', is_error: true, result: `API Error: 400 ${SPEND400}`, errors: [] };
  else { yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 100 } } }; yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01, num_turns: 1 }; }
})() });
const cappedSdk = sdkFor([K0, KA, KB]);
const WENV = { ...ENV, AC_API_WORKERS_WORKSPACE_ID: 'wrkspc_test' };
const cycleAt = (w) => { const p = join(w.stateDir, 'state', 'api-credits.json'); return existsSync(p) ? Object.values(JSON.parse(readFileSync(p, 'utf8')).cycles)[0] : {}; };

test('fix 2: a capped worker run with the options unset trips nothing and asks the governor the plain way', async () => {
  const w = makeFixture();
  try {
    const asked = [];
    const credits = { decide: (c, t) => { asked.push(t); return { decision: 'api', reason: 'ok' }; }, record: () => {} };
    const r = await runWorker({ prompt: 'x', cwd: w.dir, env: WENV, cfg: mk(), credits, sdk: cappedSdk, configDir: '' });
    assert.equal(r.status, 'failed');
    assert.deepEqual(asked, [undefined]);
    assert.ok(!cycleAt(w).tripped, 'the shared breaker is not tripped');
  } finally { w.cleanup(); }
});

test('fix 2+4: with targets set, only the capped target\'s lane trips; an explicit --target primary reaches the governor by name', async () => {
  const w = makeFixture();
  try {
    const asked = [];
    const credits = { decide: (c, t) => { asked.push(t); return { decision: 'api', reason: 'ok', ...(t && t !== PRIMARY ? { target: t } : {}) }; }, record: () => {} };
    const cfg = mk({ api_targets: TARGETS, api_category_targets: 'workers=a,primary' });
    await runWorker({ prompt: 'x', cwd: w.dir, env: WENV, cfg, credits, sdk: sdkFor([KA]), configDir: '', target: 'a' });
    assert.equal(asked[0], 'a');
    const c = cycleAt(w);
    assert.ok(c.lanes && c.lanes.a && c.lanes.a.tripped, 'a is tripped');
    assert.ok(!c.tripped, 'the primary lane is not');
    const asked2 = [];
    const credits2 = { decide: (c2, t) => { asked2.push(t); return { decision: 'api', reason: 'ok' }; }, record: () => {} };
    await runWorker({ prompt: 'x', cwd: w.dir, env: WENV, cfg: mk({ api_targets: TARGETS, api_category_targets: 'workers=a,primary' }), credits: credits2, sdk: cappedSdk, configDir: '', target: 'primary' });
    assert.equal(asked2[0], 'primary');
  } finally { w.cleanup(); }
});

test('fix 4: the api-credits child gets --target primary when the worker names it', () => {
  const src = readFileSync(new URL('../scripts/api-worker.mjs', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("call(['decide', category"));
  assert.ok(line && /\.\.\.\(target \? \['--target', target\] : \[\]\)/.test(line), line);
});

test('fix 3: the Admin API org call and the cached org field exist only when a named target has an admin key', async () => {
  const seen = [];
  const f = async (url) => {
    const u = new URL(url); seen.push(u.pathname);
    const body = u.pathname === '/v1/organizations/me' ? { id: 'org_X', name: 'X' } : (u.pathname.endsWith('workspaces') || u.pathname.endsWith('api_keys')) ? { data: [], has_more: false, last_id: null } : { data: [], has_more: false, next_page: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const now = Date.parse('2026-11-10T12:00:00Z');
  const none = await fetchBilling('sk-ant-admin01-AAAA', f, { now, cfg: loadSpendConfig((k, d) => d, {}) });
  assert.ok(!seen.includes('/v1/organizations/me'), 'options unset: no extra call');
  assert.ok(!('org' in none), 'options unset: the snapshot shape is unchanged');
  seen.length = 0;
  const cfg = loadSpendConfig((k, d) => ({ api_targets: JSON.stringify({ a: { key: 'env:AC_KEY_A', admin: 'env:ADMIN_A' } }) }[k] ?? d), {});
  const some = await fetchBilling('sk-ant-admin01-AAAA', f, { now, cfg });
  assert.ok(seen.includes('/v1/organizations/me'));
  assert.equal(some.org.id, 'org_X');
});

test('fix 5: a failover attempt has its own ledger id, so record-fallback marks the attempt that produced the result', async () => {
  const t = rig();
  try {
    const cfg = mk({ api_targets: TARGETS, api_category_targets: 'review=primary,a,b' });
    const r = await t.run(keyed({ [K0]: ENF429 }), { cfg });
    assert.equal(r.code, 0, r.out);
    const ids = t.ledger().entries.filter((e) => e.cat === 'review' && e.id).map((e) => e.id);
    assert.equal(ids.length, 2, ids.join(','));
    assert.equal(new Set(ids).size, 2);
    assert.equal(ids[1], `${ids[0]}-2`);
    recordFallback(ids[1], 'x');
    const es = t.ledger().entries.filter((e) => e.cat === 'review');
    assert.ok(!es[0].fallback && es[1].fallback && es[1].target === 'a');
  } finally { t.fx.cleanup(); }
});

test('nit: --target as the last argument is a usage error (api-review and api-credits)', async () => {
  const t = rig();
  try {
    const r = await t.run(keyed({}), { cfg: mk({ api_targets: TARGETS }), extra: ['--target'] });
    assert.equal(r.code, 2);
    assert.match(r.out, /--target needs a target name/);
  } finally { t.fx.cleanup(); }
  const { main } = await import('../scripts/api-credits.mjs');
  const lines = [];
  assert.equal(await main(['decide', 'review', '--target'], { out: (s) => lines.push(s), env: ENV, cfg: mk({ api_targets: TARGETS }) }), 2);
  assert.match(lines.join('\n'), /--target needs a target name/);
});

test('fix 6: on the SDK engine a billing_error counts as credit exhausted (capped, so the failover trigger fires) even with a placeholder text', async () => {
  const fx = makeFixture();
  try {
    const sdk = { query: () => (async function* () {
      yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', tools: [] };
      yield { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null }, error: 'billing_error' };
      yield { type: 'result', subtype: 'success', is_error: true, result: '', stop_reason: null, total_cost_usd: 0, num_turns: 1, errors: [] };
    })() };
    const r = await runApiSdk({ prompt: 'x', model: 'sonnet', cwd: fx.dir, cfg: mk(), env: { AC_API_KEY: K0 }, now: Date.parse('2026-11-16T00:00:00Z'), requireVerdict: true, sdk });
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, true);
    assert.equal(r.capped, true, r.reason);
  } finally { fx.cleanup(); }
});
