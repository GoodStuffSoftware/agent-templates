// Named API targets (0.31.72): per-category ordered lists with failover, per-target lanes and booking, --target, per-target cost lines,
// and the `API: target=` brief line. The network is mocked (no live calls).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { loadConfig, resolveTargets, TargetError, decide, record, recordFailure, targetLines, PRIMARY } from '../scripts/lib/api-credits.mjs';
import { getTargetOrgs, loadSpendConfig } from '../scripts/lib/api-spend.mjs';
import { main as reviewMain } from '../scripts/api-review.mjs';
import { runWorker } from '../scripts/api-worker.mjs';
import { briefDeclarations } from '../hooks/lib/brief-directives.mjs';
import { routeReview, apiTarget, apiMarker, runnerPrompt } from '../hooks/lib/sg-review-route.mjs';
import { spawnSyncHidden } from '../scripts/lib/proc.mjs';

const K0 = 'sk-ant-api03-PRIMARY-testkeytestkey';
const KA = 'sk-ant-api03-TARGETA-testkeytestkey';
const KB = 'sk-ant-api03-TARGETB-testkeytestkey';
const ENV = { AC_API_KEY: K0, AC_KEY_A: KA, AC_KEY_B: KB };
const TARGETS = JSON.stringify({ a: { key: 'env:AC_KEY_A' }, b: { key: 'env:AC_KEY_B', budget: 50 } });
const mk = (opts = {}) => loadConfig((k, d) => (k in opts ? opts[k] : d));
const CFG_LIST = mk({ api_targets: TARGETS, api_category_targets: 'review=primary,a,b workers=a,b' });
const msg = (t) => ({ status: 200, body: { type: 'message', role: 'assistant', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } } });
const err = (status, message, type = 'invalid_request_error', details) => ({ status, body: { type: 'error', error: { type, message, ...(details ? { details } : {}) } } });
const OK = msg('VERDICT: PASS');
const SPEND400 = err(400, 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC');
const ENF429 = err(429, 'cap', 'rate_limit_error', { error_code: 'enforced_spend_limit_reached' });
const CREDIT = err(400, 'Your credit balance is too low to access the Anthropic API.');

// fetch stub keyed by the x-api-key header: byKey[key] = response (repeats) ; records calls per key
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
  const run = async (fetchImpl, { cfg = CFG_LIST, extra = [] } = {}) => {
    const lines = []; const errs = [];
    const code = await reviewMain(['run', '--brief-file', brief, '--diff-ref', 'HEAD~1..HEAD', '--model', 'sonnet', '--cwd', repo, '--runner', 'fetch', ...extra],
      { out: (s) => lines.push(s), err: (s) => errs.push(s), env: ENV, fetchImpl, sleep: async () => {}, cfg });
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  const ledger = () => { const p = join(fx.stateDir, 'state', 'api-credits.json'); return existsSync(p) ? Object.values(JSON.parse(readFileSync(p, 'utf8')).cycles)[0] : null; };
  return { fx, run, ledger };
}

test('options unset: the only target is the primary, and a spend-limit 400 is today\'s unavailable result (no failover)', async () => {
  const cfg = mk();
  assert.deepEqual(resolveTargets('review', cfg).map((t) => t.name), [PRIMARY]);
  assert.deepEqual(resolveTargets('workers', cfg).map((t) => t.name), [PRIMARY]);
  const t = rig();
  try {
    const f = keyed({ [K0]: SPEND400 });
    const r = await t.run(f, { cfg });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /^API review unavailable/);
    assert.deepEqual(f.calls, { [K0]: 1 });
    assert.equal(decide('review', { cfg, env: ENV }).target, undefined);
  } finally { t.fx.cleanup(); }
});

for (const [name, resp, primaryCalls] of [['a spend-limit 400', SPEND400, 1], ['the enforced 429 (not retried)', ENF429, 1], ['credit exhausted', CREDIT, 1]]) {
  test(`failover: ${name} on the primary moves the review to target a, booked on a's lane`, async () => {
    const t = rig();
    try {
      const f = keyed({ [K0]: resp });
      const r = await t.run(f);
      assert.equal(r.code, 0, r.out);
      assert.match(r.err, /failing over to a/);
      assert.deepEqual(f.calls, { [K0]: primaryCalls, [KA]: 1 });
      const l = t.ledger();
      assert.equal(l.spent.review || 0, 0, 'nothing booked on the primary lane');
      assert.ok(l.lanes.a.spent.review > 0, 'booked on a');
      if (resp !== CREDIT) assert.ok(l.tripped, 'a wall trips the primary lane at once (credit exhausted counts toward the two-in-a-row breaker)');
      assert.equal(l.entries.filter((e) => e.target === 'a' && e.usd > 0).length, 1, 'the booked entry carries its target');
      if (resp !== CREDIT) assert.equal(decide('review', { cfg: CFG_LIST, env: ENV, target: 'primary' }).target, 'a');
    } finally { t.fx.cleanup(); }
  });
}

test('an ordinary 429 is retried and does not fail over', async () => {
  const t = rig();
  try {
    const f = keyed({ [K0]: err(429, 'slow down', 'rate_limit_error') });
    const r = await t.run(f);
    assert.equal(r.code, 4, r.out);
    assert.equal(f.calls[K0], 3, 'one try and two retries');
    assert.equal(f.calls[KA], undefined);
  } finally { t.fx.cleanup(); }
});

test('explicit --target b: runs on b, and fails over only to the targets after it', async () => {
  const t = rig();
  try {
    const f = keyed({ [KB]: OK });
    const r = await t.run(f, { extra: ['--target', 'b'] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(f.calls, { [KB]: 1 });
    assert.deepEqual(resolveTargets('review', CFG_LIST, 'a').map((x) => x.name), ['a', 'b']);
    assert.deepEqual(resolveTargets('review', CFG_LIST, 'b').map((x) => x.name), ['b']);
  } finally { t.fx.cleanup(); }
});

test('an unknown target is an error (CLI usage error, TargetError, governor fails closed)', async () => {
  const t = rig();
  try {
    const f = keyed({});
    const r = await t.run(f, { extra: ['--target', 'nope'] });
    assert.equal(r.code, 2);
    assert.match(r.out, /unknown target "nope"/);
    assert.deepEqual(f.calls, {});
    assert.throws(() => resolveTargets('review', CFG_LIST, 'nope'), TargetError);
    const d = decide('review', { cfg: CFG_LIST, env: ENV, target: 'nope' });
    assert.equal(d.decision, 'plan');
    assert.match(d.reason, /^failed closed/);
  } finally { t.fx.cleanup(); }
});

test('the list exhausted: every target capped ends as the unavailable result and the governor then says plan', async () => {
  const t = rig();
  try {
    const f = keyed({ [K0]: SPEND400, [KA]: ENF429, [KB]: SPEND400 });
    const r = await t.run(f);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /^API review unavailable/);
    assert.deepEqual(f.calls, { [K0]: 1, [KA]: 1, [KB]: 1 });
    const d = decide('review', { cfg: CFG_LIST, env: ENV });
    assert.equal(d.decision, 'plan');
    assert.match(d.reason, /target a/);
  } finally { t.fx.cleanup(); }
});

test('governor: a primary over its cap answers api via the next target; per-target lanes keep separate breakers and booked spend', () => {
  const t = makeFixture();
  try {
    const path = join(t.dir, 'ledger', 'api-credits.json');
    const cfg = CFG_LIST;
    record('review', 1000, 'big', { cfg, path, apiKeySource: 'ANTHROPIC_API_KEY' }); // primary far over its budget
    const d = decide('review', { cfg, env: ENV, path });
    assert.equal(d.decision, 'api');
    assert.equal(d.target, 'a');
    record('review', 2, 'on a', { cfg, path, apiKeySource: 'ANTHROPIC_API_KEY', target: 'a' });
    recordFailure('wall', { cfg, path, hard: true, target: 'a' });
    const e = decide('review', { cfg, env: ENV, path, target: 'a' }); // an explicit target skips the review alternation
    assert.equal(e.target, 'b', 'a is tripped, so b takes the run');
    const c = Object.values(JSON.parse(readFileSync(path, 'utf8')).cycles)[0];
    assert.equal(c.lanes.a.spent.review, 2);
    assert.ok(c.lanes.a.tripped);
    assert.ok(!(c.lanes.b && c.lanes.b.tripped));
    assert.equal(c.spent.review, 1000);
  } finally { t.cleanup(); }
});

test('per-target cost lines are grouped by org id, with a failing admin key shown as no cost data', async () => {
  const cfg = loadSpendConfig((k, d) => ({
    api_targets: JSON.stringify({ a: { key: 'env:AC_KEY_A', admin: 'env:ADMIN_A' }, b: { key: 'env:AC_KEY_B', admin: 'env:ADMIN_B' }, c: { key: 'env:AC_KEY_B', admin: 'env:ADMIN_BAD' } }),
    api_category_targets: 'review=a,b', api_admin_key_source: 'env:ADMIN_A',
  }[k] ?? d), {});
  const ADMINS = { ADMIN_A: 'sk-ant-admin01-AAAA', ADMIN_B: 'sk-ant-admin01-BBBB' };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const k = init.headers['x-api-key'];
    const org = k === ADMINS.ADMIN_A ? { id: 'org_AAA', name: 'Same Name' } : { id: 'org_BBB', name: 'Same Name' };
    const body = u.pathname === '/v1/organizations/me' ? org : (u.pathname.endsWith('workspaces') || u.pathname.endsWith('api_keys')) ? { data: [], has_more: false, last_id: null } : { data: [], has_more: false, next_page: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const dir = makeFixture();
  try {
    const orgs = await getTargetOrgs({ now: Date.parse('2026-11-10T12:00:00Z'), cfg, env: {}, fetchImpl, readKey: (src) => { const n = src.replace('env:', ''); if (!ADMINS[n]) throw new Error(`cannot read ${src} (${ADMINS.ADMIN_A})`); return ADMINS[n]; }, cachePath: join(dir.dir, 'billing.json') });
    const ids = orgs.map((g) => g.id);
    assert.ok(ids.includes('org_AAA') && ids.includes('org_BBB'), 'two orgs with one display name stay two groups');
    const lines = targetLines({ cfg, orgs, now: Date.parse('2026-11-10T12:00:00Z') }).join('\n');
    assert.match(lines, /org org_AAA \(Same Name\): billed \$0\.00/);
    assert.match(lines, /org org_BBB \(Same Name\): billed/);
    assert.match(lines, /no cost data/);
    assert.ok(!lines.includes('sk-ant-admin'), 'no key value in the report');
  } finally { dir.cleanup(); }
});

test('worker: --target flag is a usage error for an unknown name; the worker fails over like the review runner', async () => {
  const { main } = await import('../scripts/api-worker.mjs');
  const w = makeFixture();
  try {
    const bf = join(w.dir, 'b.txt'); writeFileSync(bf, 'do it');
    const lines = [];
    const code = await main(['run', '--brief-file', bf, '--cwd', w.dir, '--target', 'nope'], { write: (s) => lines.push(s), env: ENV, cfg: CFG_LIST });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /unknown target "nope"/);
    // a capped first target (error result, no spend) goes to the next; the booking carries the target that did the work
    const keysSeen = [];
    const sdk = { query: ({ options }) => { const k = options.env.ANTHROPIC_API_KEY; keysSeen.push(k); return (async function* () {
      yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' };
      if (k === KA) yield { type: 'result', subtype: 'success', is_error: true, result: `API Error: 400 ${SPEND400.body.error.message}`, errors: [] };
      else { yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 100 } } }; yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01, num_turns: 1 }; }
    })(); } };
    const booked = [];
    const credits = { decide: (c, t) => ({ decision: 'api', reason: 'ok', ...(t && t !== PRIMARY ? { target: t } : {}) }), record: (c, usd, m, t) => booked.push(t) };
    const cfg = mk({ api_targets: TARGETS, api_category_targets: 'workers=a,b' });
    const r = await runWorker({ prompt: 'x', cwd: w.dir, env: ENV, cfg, credits, sdk, configDir: '' });
    assert.equal(r.status, 'done', r.reason);
    assert.deepEqual(keysSeen, [KA, KB]);
    assert.equal(r.target, 'b');
    assert.deepEqual(booked, ['b']);
  } finally { w.cleanup(); }
});

test('hook: API: target=<name> is read and passed to the governor and to api-review; API: no and API: opus keep working', async () => {
  assert.equal(apiTarget('x\nAPI: target=overflow-reviewers\n'), 'overflow-reviewers');
  assert.equal(apiTarget('API: no'), null);
  assert.equal(apiMarker('API: target=a'), null);
  assert.equal(apiMarker('API: no'), 'no');
  assert.equal(apiMarker('API: opus'), 'opus');
  assert.match(runnerPrompt({ briefFile: 'b', reviewFile: 'r', range: 'a..b', cwd: '/x', target: 'a' }), /--model sonnet --effort high --target a /);
  assert.doesNotMatch(runnerPrompt({ briefFile: 'b', reviewFile: 'r', range: 'a..b', cwd: '/x' }), /--target/);
  const w = makeFixture();
  try {
    const seen = [];
    const brief = (x) => `TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: mid\n${x}\nBranch fix/zz, diff range main..fix/zz in WORKTREE: ${w.dir}\n`;
    const call = (b, decide) => routeReview({ typeIsParity: true, declaredType: 'code-review', brief: b, decls: briefDeclarations(b), p: { tool_use_id: 'toolu_t1', cwd: w.dir }, input: { subagent_type: 'agent-companion:ac-sonnet-high', description: 'r', prompt: b }, subagentCaller: true, model: 'sonnet', sid: 's', updatedInput: null, deps: { opt: (k, d) => (k === 'api_review_route' ? 'all' : d), stateDir: () => w.dir, telemetryDir: () => w.dir, decide } });
    const r = await call(brief('API: target=a'), (c, o) => { seen.push(o.target); return { decision: 'api', reason: 'ok', target: 'a' }; });
    assert.equal(r.route, 'api');
    assert.deepEqual(seen, ['a']);
    assert.match(r.updatedInput.prompt, /api-review\.mjs.* --target a /);
    const n = await call(brief('API: no'), () => { throw new Error('not asked'); });
    assert.equal(n.route_reason, 'caller-no');
    const bad = await call(brief('API: target=nope'), () => ({ decision: 'plan', reason: 'failed closed: unknown target "nope"' }));
    assert.deepEqual([bad.route, bad.route_reason], ['subagent', 'governor-fallback']);
  } finally { w.cleanup(); }
});
