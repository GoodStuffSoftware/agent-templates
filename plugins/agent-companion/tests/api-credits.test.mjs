// API credits (0.31.46): the governor and its ledger (scripts/lib/api-credits.mjs,
// scripts/api-credits.mjs), the API review runner (scripts/api-review.mjs,
// scripts/lib/api-run.mjs, scripts/lib/api-tools.mjs) driven in-process with a stubbed fetch
// (no live calls), and the self-review clause that calls the governor.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import {
  DEFAULT_SHARES, decide, record, recordFailure, status, summaryLine, cycleOf,
  keyConfigured, parseKeySource, parseShares,
} from '../scripts/lib/api-credits.mjs';
import { runApi, validKeyShape, isUnavailable, isWorkspaceMissing, isSpendLimit, hardUsdFrom, OFFICIAL_ENDPOINT, SLOW_REVIEW_MS, HUNG_MS, SOFT_USD, DEFAULT_HARD_USD } from '../scripts/lib/api-run.mjs';
import { makeTools } from '../scripts/lib/api-tools.mjs';
import { main as reviewMain, buildPrompt, readProjectRules, fetchSystem, RULES_CAP } from '../scripts/api-review.mjs';
import { main as creditsMain } from '../scripts/api-credits.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';
import { spawnSyncHidden } from '../scripts/lib/proc.mjs';
import { selfReviewBlock, REVIEW_INSTRUCTION } from '../hooks/lib/self-review.mjs';

const NL = '\n';
const T = (s) => Date.parse(s);
const CFG = { budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:AC_API_KEY', reviewRatio: 0.5, itemEstimate: 2 };
const KEYENV = { AC_API_KEY: 'present' };
const SENTINEL = 'sk-ant-api03-SENTINEL-do-not-leak-0123456789';

function ledgerIn(fx) { return join(fx.dir, 'ledger', 'api-credits.json'); }
const dec = (fx, cat, now, env = KEYENV, cfg = CFG) => decide(cat, { now: T(now), cfg, env, path: ledgerIn(fx) });
const rec = (fx, cat, usd, now) => record(cat, usd, 'test', { now: T(now), cfg: CFG, path: ledgerIn(fx) });


// --- governor ------------------------------------------------------------------------

test('cycleOf: start day, rollover, year boundary, reserve window', () => {
  const a = cycleOf(T('2026-11-16T00:00:00Z'), 1);
  assert.equal(a.key, '2026-11-01');
  assert.ok(Math.abs(a.frac - 0.5) < 0.01);
  assert.equal(a.reserveReleased, false);
  assert.equal(cycleOf(T('2026-11-28T12:00:00Z'), 1).reserveReleased, true);
  assert.equal(cycleOf(T('2026-12-01T00:00:00Z'), 1).key, '2026-12-01');
  assert.equal(cycleOf(T('2026-11-10T00:00:00Z'), 15).key, '2026-10-15');
  assert.equal(cycleOf(T('2027-01-05T00:00:00Z'), 15).key, '2026-12-15');
});

test('config helpers: key source forms, shares', () => {
  assert.deepEqual(parseKeySource('env:AC_API_KEY'), { kind: 'env', name: 'AC_API_KEY' });
  assert.deepEqual(parseKeySource('bws:my-secret'), { kind: 'bws', name: 'my-secret' });
  assert.equal(parseKeySource('literal-key'), null);
  assert.equal(keyConfigured('env:AC_API_KEY', {}), false);
  assert.equal(keyConfigured('env:AC_API_KEY', KEYENV), true);
  assert.equal(keyConfigured('bws:x', {}), false);
  assert.equal(keyConfigured('bws:x', { BWS_ACCESS_TOKEN: 't' }), true);
  assert.deepEqual(parseShares('review=0.6, reserve=0'), { review: 0.6, overflow: 0.3, rater: 0.1, reserve: 0 });
});

test('fails closed to plan: no key, unreadable ledger, unknown category', () => {
  const fx = makeFixture();
  try {
    const none = dec(fx, 'review', '2026-11-16T00:00:00Z', {});
    assert.equal(none.decision, 'plan');
    assert.match(none.reason, /no API key/);
    mkdirSync(dirname(ledgerIn(fx)), { recursive: true });
    writeFileSync(ledgerIn(fx), '{not json');
    const bad = dec(fx, 'review', '2026-11-16T00:00:00Z');
    assert.equal(bad.decision, 'plan');
    assert.match(bad.reason, /failed closed/);
    assert.equal(dec(fx, 'bogus', '2026-11-16T00:00:00Z').decision, 'plan');
  } finally { fx.cleanup(); }
});

test('review alternates api and plan by a persisted counter', () => {
  const fx = makeFixture();
  try {
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push(dec(fx, 'review', '2026-11-16T00:00:00Z').decision);
    assert.deepEqual(seq, ['api', 'plan', 'api', 'plan', 'api', 'plan']);
    const led = JSON.parse(readFileSync(ledgerIn(fx), 'utf8'));
    assert.equal(led.cycles['2026-11-01'].turn.review, 6);
  } finally { fx.cleanup(); }
});

test('early in the cycle spend is throttled to the pace plus one average item; a pace plan does not advance the counter', () => {
  const fx = makeFixture();
  try {
    const now = '2026-11-01T01:00:00Z'; // 1/720 of the cycle: pace allowance $0.14, slack one item
    assert.equal(dec(fx, 'review', now).decision, 'api');
    rec(fx, 'review', 2, now);
    rec(fx, 'review', 2, now); // $4 spent, average $2: cap is 0.14 + 2
    const turnBefore = JSON.parse(readFileSync(ledgerIn(fx), 'utf8')).cycles['2026-11-01'].turn.review;
    for (let i = 0; i < 3; i++) {
      const d = dec(fx, 'review', now);
      assert.equal(d.decision, 'plan');
      assert.match(d.reason, /^pace:/);
    }
    assert.equal(JSON.parse(readFileSync(ledgerIn(fx), 'utf8')).cycles['2026-11-01'].turn.review, turnBefore);
    // Later in the month the allowance has grown and the same ledger lets reviews through again.
    const later = dec(fx, 'review', '2026-11-20T00:00:00Z');
    assert.notEqual(later.reason.slice(0, 5), 'pace:');
  } finally { fx.cleanup(); }
});

test('the reserve is held until the last 3 days of the cycle', () => {
  const fx = makeFixture();
  try {
    rec(fx, 'rater', 180, '2026-11-20T00:00:00Z'); // 90% of the budget gone: only the reserve is left
    const held = dec(fx, 'review', '2026-11-20T00:00:00Z');
    assert.equal(held.decision, 'plan');
    assert.match(held.reason, /^balance:/);
    const released = dec(fx, 'review', '2026-11-29T00:00:00Z');
    assert.equal(released.decision, 'api', released.reason);
  } finally { fx.cleanup(); }
});

test('a new cycle starts with an empty ledger', () => {
  const fx = makeFixture();
  try {
    rec(fx, 'review', 150, '2026-11-25T00:00:00Z');
    assert.equal(dec(fx, 'review', '2026-11-26T00:00:00Z').decision, 'plan');
    const d = dec(fx, 'review', '2026-12-02T00:00:00Z');
    assert.equal(d.decision, 'api', d.reason);
    const st = status({ now: T('2026-12-02T00:00:00Z'), cfg: CFG, path: ledgerIn(fx), env: KEYENV });
    assert.equal(st.total, 0);
    assert.match(st.text, /cycle 2026-12-01/);
    const nov = status({ now: T('2026-11-26T00:00:00Z'), cfg: CFG, path: ledgerIn(fx), env: KEYENV });
    assert.equal(nov.total, 150);
    assert.match(nov.text, /review\s+spent \$150\.00/);
  } finally { fx.cleanup(); }
});

test('two billing or auth failures in a row make decide answer plan for the rest of the cycle; a success clears it', () => {
  const fx = makeFixture();
  try {
    const now = T('2026-11-16T00:00:00Z');
    const o = { now, cfg: CFG, path: ledgerIn(fx) };
    assert.equal(recordFailure('credit balance too low', o).tripped, false);
    assert.equal(dec(fx, 'review', '2026-11-16T00:00:00Z').decision, 'api');
    assert.equal(recordFailure('credit balance too low', o).tripped, true);
    const d = dec(fx, 'review', '2026-11-17T00:00:00Z');
    assert.equal(d.decision, 'plan');
    assert.match(d.reason, /failed 2 times in a row/);
    assert.match(status({ ...o, env: KEYENV }).text, /BREAKER TRIPPED/);
    record('review', 0.01, 'probe', { ...o });
    assert.doesNotMatch(dec(fx, 'review', '2026-11-18T00:00:00Z').reason, /failed 2 times/);
    // a failure separated by a success does not trip it
    recordFailure('x', o);
    record('review', 1, 'ok', o);
    recordFailure('x', o);
    assert.doesNotMatch(dec(fx, 'review', '2026-11-19T00:00:00Z').reason, /failed 2 times/);
  } finally { fx.cleanup(); }
});

test('CLI: decide prints the word then one reason line; with no key it is plan', () => {
  const fx = makeFixture();
  try {
    const none = runScript('scripts/api-credits.mjs', ['decide', 'review'], { env: { AC_API_KEY: '' } });
    assert.equal(none.status, 0);
    const lines = none.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'plan');
    const withKey = runScript('scripts/api-credits.mjs', ['decide', 'review', '--now', '2026-11-16T00:00:00Z'], { env: { AC_API_KEY: 'x' } });
    assert.equal(withKey.stdout.trim().split(/\r?\n/)[0], 'api');
    const r = runScript('scripts/api-credits.mjs', ['record', 'review', '1.5', 'a', 'note', '--now', '2026-11-16T00:00:00Z'], { env: { AC_API_KEY: 'x' } });
    assert.match(r.stdout, /recorded; review total \$1\.50/);
    const s = runScript('scripts/api-credits.mjs', ['status', '--now', '2026-11-16T00:00:00Z'], { env: { AC_API_KEY: 'x' } });
    assert.match(s.stdout, /review\s+spent \$1\.50/);
    assert.equal(runScript('scripts/api-credits.mjs', ['nope']).status, 2);
  } finally { fx.cleanup(); }
});

// --- runner, with a stubbed fetch (no live calls) ----------------------------------------

const sonnetUsd = (u) => priceUsage({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }, 'claude-sonnet-5-5').usd;
const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const USAGE = { input_tokens: 1000, output_tokens: 200 };
const msg = (content, usage = USAGE, stop = 'end_turn') => ({ status: 200, body: { type: 'message', role: 'assistant', content, stop_reason: stop, usage } });
const apiError = (status, message, type = 'invalid_request_error') => ({ status, body: { type: 'error', error: { type, message } } });

// A fetch stub. `script` is an array (the last entry repeats) or fn(callNumber, body).
function stubFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: { ...init.headers }, body, raw: init.body, redirect: init.redirect });
    const r = typeof script === 'function' ? script(calls.length, body) : script[Math.min(calls.length - 1, script.length - 1)];
    return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  f.calls = calls;
  return f;
}

function rig() {
  const fx = makeFixture();
  const repo = join(fx.dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...a) => {
    const r = spawnSyncHidden('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'src', 'b.mjs'), 'export const b = 1;\n');
  git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'second');
  writeFileSync(join(fx.dir, 'outside.txt'), 'outside secret');
  const brief = join(fx.dir, 'brief.txt');
  writeFileSync(brief, 'TYPE: bounded-feature\nthe lead brief, verbatim\n');
  const run = async (fetchImpl, { extra = [], env = {}, key = SENTINEL } = {}) => {
    const lines = [];
    const errs = [];
    const code = await reviewMain(
      ['run', '--brief-file', brief, '--diff-ref', 'HEAD~1..HEAD', '--model', 'sonnet', '--effort', 'xhigh', '--cwd', repo, '--writer', 'sonnet/high', ...(extra.includes('--runner') ? [] : ['--runner', 'fetch']), ...extra],
      { out: (s) => lines.push(s), err: (s) => errs.push(s), env: { AC_API_KEY: key, ...env }, fetchImpl, sleep: async () => {}, cfg: CFG },
    );
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  const ledger = () => {
    const p = join(fx.stateDir, 'state', 'api-credits.json');
    return existsSync(p) ? Object.values(JSON.parse(readFileSync(p, 'utf8')).cycles)[0] : null;
  };
  return { fx, repo, brief, run, ledger };
}

function filesUnder(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (e !== '.git') filesUnder(p, acc); } else acc.push(p);
  }
  return acc;
}

test('runner: the key rides only in the x-api-key header; cost is metered from usage and booked; the verdict passes through', async () => {
  const t = rig();
  try {
    const f = stubFetch([msg([text(`VERDICT: PASS${NL}no findings`)])]);
    const r = await t.run(f, { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.net/v1' } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^VERDICT: PASS/);
    assert.match(r.out, /\(review path: API credits, fetch, claude-sonnet-5-5, 1 turn, \$0\.00\)$/);
    const c = f.calls[0];
    assert.equal(c.url, OFFICIAL_ENDPOINT, 'ANTHROPIC_BASE_URL is ignored: the key never goes to a gateway');
    assert.equal(c.headers['x-api-key'], SENTINEL);
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.equal('anthropic-workspace-id' in c.headers, false);
    assert.equal(c.body.model, 'claude-sonnet-5-5');
    assert.deepEqual(c.body.output_config, { effort: 'xhigh' });
    assert.deepEqual(c.body.tools.map((x) => x.name), ['read_file', 'grep', 'glob']);
    assert.match(c.body.messages[0].content[0].text, /^TYPE: code-review\nWRITER: sonnet\/high\nROLE: reviewer/);
    assert.match(c.body.messages[0].content[0].text, /the lead brief, verbatim/);
    assert.match(c.body.messages[0].content[0].text, /\+two/, 'the git diff is in the prompt');
    assert.equal((c.raw.match(/"cache_control"/g) || []).length, 1, 'one moving cache breakpoint');
    // The key is nowhere else: not in the body, the URL, the output, or any file the run left behind.
    assert.ok(!c.raw.includes(SENTINEL) && !c.url.includes(SENTINEL) && !r.out.includes(SENTINEL));
    for (const p of filesUnder(t.fx.dir)) assert.ok(!readFileSync(p, 'latin1').includes(SENTINEL), `key found in ${p}`);
    // Metered from usage x list price; one ledger entry with the per-run detail.
    const cy = t.ledger();
    assert.ok(Math.abs(cy.spent.review - sonnetUsd(USAGE)) < 1e-9);
    assert.equal(cy.n.review, 1);
    const e = cy.entries[0];
    assert.equal(e.project, 'repo');
    assert.equal(e.model, 'claude-sonnet-5-5');
    assert.deepEqual(e.tokens, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 });
    assert.equal(e.turns, 1);
    assert.ok(Math.abs(e.usd - sonnetUsd(USAGE)) < 1e-9 && e.t);
  } finally { t.fx.cleanup(); }
});

test('runner: --review-file gets the same text', async () => {
  const t = rig();
  try {
    const file = join(t.fx.dir, 'REVIEW-x.md');
    const r = await t.run(stubFetch([msg([text(`VERDICT: FIX${NL}blocker: x`)])]), { extra: ['--review-file', file] });
    assert.equal(r.code, 0);
    assert.equal(readFileSync(file, 'utf8').trim(), r.out.trim());
  } finally { t.fx.cleanup(); }
});

test('runner: anthropic-workspace-id is sent only when AC_API_WORKSPACE_ID is set; a malformed id is a config failure', async () => {
  const t = rig();
  try {
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    assert.equal((await t.run(f, { env: { AC_API_WORKSPACE_ID: 'wrkspc_01AbC-x.y' } })).code, 0);
    assert.equal(f.calls[0].headers['anthropic-workspace-id'], 'wrkspc_01AbC-x.y');
    const g = stubFetch([msg([text('VERDICT: PASS')])]);
    const bad = await t.run(g, { env: { AC_API_WORKSPACE_ID: 'x\r\nevil: 1' } });
    assert.equal(bad.code, 3);
    assert.match(bad.out, /^API review unavailable: AC_API_WORKSPACE_ID is malformed/);
    assert.equal(g.calls.length, 0);
  } finally { t.fx.cleanup(); }
});

test('runner: the tool loop reads files, greps and globs inside the repository; escapes are refused', async () => {
  const t = rig();
  try {
    const f = stubFetch((n) => {
      if (n === 1) return msg([text('looking'), toolUse('t1', 'read_file', { path: 'a.txt' }), toolUse('t2', 'read_file', { path: '../outside.txt' }), toolUse('t3', 'read_file', { path: '.git/config' })], USAGE, 'tool_use');
      if (n === 2) return msg([toolUse('t4', 'grep', { pattern: 'two' }), toolUse('t5', 'glob', { pattern: '**/*.mjs' })], USAGE, 'tool_use');
      return msg([text(`VERDICT: PASS${NL}checked`)]);
    });
    const r = await t.run(f);
    assert.equal(r.code, 0, r.out);
    assert.equal(f.calls.length, 3);
    const results1 = f.calls[1].body.messages[2].content;
    assert.equal(results1[0].tool_use_id, 't1');
    assert.match(results1[0].content, /1\tone\n2\ttwo/);
    assert.equal(results1[1].is_error, true);
    assert.match(results1[1].content, /outside the repository/);
    assert.ok(!JSON.stringify(f.calls[1].body).includes('outside secret'));
    assert.equal(results1[2].is_error, true);
    const results2 = f.calls[2].body.messages[4].content;
    assert.match(results2[0].content, /a\.txt:2:two/);
    assert.equal(results2[1].content, 'src/b.mjs');
    for (const c of f.calls) assert.equal((c.raw.match(/"cache_control"/g) || []).length, 1);
    assert.match(r.out, /3 turns/);
    assert.ok(Math.abs(t.ledger().spent.review - 3 * sonnetUsd(USAGE)) < 1e-9);
    assert.equal(t.ledger().entries[0].turns, 3);
  } finally { t.fx.cleanup(); }
});

test('runner: the turn cap and the dollar cap force a final no-tools verdict turn', async () => {
  const t = rig();
  try {
    const greedy = (n, body) => (body.tool_choice ? msg([text(`VERDICT: FIX${NL}out of budget`)]) : msg([toolUse(`t${n}`, 'glob', { pattern: '*' })], USAGE, 'tool_use'));
    const f = stubFetch(greedy);
    const r = await t.run(f, { extra: ['--max-turns', '2'] });
    assert.equal(r.code, 0, r.out);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].body.tool_choice, { type: 'none' });
    const tail = f.calls[1].body.messages.at(-1).content;
    assert.match(tail.at(-1).text, /Tool budget reached/);
    assert.match(r.out, /^VERDICT: FIX/);
    const g = stubFetch(greedy);
    const r2 = await t.run(g, { extra: ['--max-usd', '0.001'] });
    assert.equal(r2.code, 0, r2.out);
    assert.equal(g.calls.length, 2, 'one turn costs more than 80% of the cap, so the next turn is the last');
    assert.deepEqual(g.calls[1].body.tool_choice, { type: 'none' });
  } finally { t.fx.cleanup(); }
});

test('key shape: sk-ant-usr and sk-ant-api accepted; admin keys and OAuth tokens refused before any call', async () => {
  assert.equal(validKeyShape('sk-ant-usr01-abc'), true);
  assert.equal(validKeyShape('sk-ant-api03-abc'), true);
  assert.equal(validKeyShape('sk-ant-admin01-abc'), false);
  assert.equal(validKeyShape('sk-ant-oat01-abc'), false);
  assert.equal(validKeyShape('sk-other-abc'), false);
  assert.equal(validKeyShape(''), false);
  const t = rig();
  try {
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    const r = await t.run(f, { key: 'sk-ant-admin01-SECRETADMIN' });
    assert.equal(r.code, 3);
    assert.match(r.out, /^API review unavailable: the configured secret is not a Console API key/);
    assert.ok(!r.out.includes('SECRETADMIN'));
    assert.equal(f.calls.length, 0);
    assert.equal(t.ledger().fails, 1);
  } finally { t.fx.cleanup(); }
});

test('failure classification: workspace header, billing, spend limit', () => {
  assert.equal(isWorkspaceMissing({ status: 400, text: 'This API key must include the anthropic-workspace-id header' }), true);
  assert.equal(isWorkspaceMissing({ status: 500, text: 'anthropic-workspace-id' }), false);
  assert.equal(isSpendLimit({ status: 400, text: 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01' }), true);
  assert.equal(isSpendLimit({ status: 400, text: 'monthly spend limit reached' }), true);
  assert.equal(isSpendLimit({ status: 429, text: 'You have reached your specified workspace API usage limits' }), false, 'a 429 stays a backoff and retry');
  assert.equal(isSpendLimit({ status: 400, text: 'max_tokens: 99999 > 8192, the maximum allowed' }), false);
  assert.equal(isUnavailable({ status: 402 }), true);
  assert.equal(isUnavailable({ text: 'Your credit balance is too low to access the API' }), true);
  assert.equal(isUnavailable({ text: 'Invalid API key' }), true);
  assert.equal(isUnavailable({ text: 'the build failed' }), false);
});

test('runner: a 400 about the workspace header exits 3 with "set AC_API_WORKSPACE_ID" and counts as a failure', async () => {
  const t = rig();
  try {
    const f = stubFetch([apiError(400, 'This API key is not scoped to a workspace: the request must include the anthropic-workspace-id header')]);
    const r = await t.run(f);
    assert.equal(r.code, 3);
    assert.match(r.out, /^API review unavailable: set AC_API_WORKSPACE_ID/);
    assert.equal(f.calls.length, 1, 'a config failure is not retried');
    assert.equal(t.ledger().fails, 1);
    assert.ok(!r.out.includes(SENTINEL));
  } finally { t.fx.cleanup(); }
});

test('runner: credit balance, 401 and 403 exit 3; two in a row make decide answer plan for the cycle', async () => {
  const t = rig();
  try {
    const a = await t.run(stubFetch([apiError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing')]));
    assert.equal(a.code, 3);
    assert.match(a.out, /^API review unavailable: HTTP 400: Your credit balance is too low/);
    assert.equal(t.ledger().fails, 1);
    assert.notEqual(decide('review', { cfg: CFG, env: KEYENV }).reason.slice(0, 11), 'API runs fa');
    const b = await t.run(stubFetch([apiError(401, 'invalid x-api-key', 'authentication_error')]));
    assert.equal(b.code, 3);
    assert.match(b.out, /^API review unavailable: HTTP 401/);
    const d = decide('review', { cfg: CFG, env: KEYENV });
    assert.equal(d.decision, 'plan');
    assert.match(d.reason, /failed 2 times in a row/);
    const c = await t.run(stubFetch([apiError(403, 'forbidden', 'permission_error')]));
    assert.equal(c.code, 3);
  } finally { t.fx.cleanup(); }
});

test('runner: the workspace spend limit (400) trips the breaker at once; a 429 is retried with backoff and does not', async () => {
  const t = rig();
  try {
    const f = stubFetch([apiError(429, 'You have reached your specified workspace API usage limits', 'rate_limit_error')]);
    const slow = await t.run(f);
    assert.equal(slow.code, 4);
    assert.match(slow.out, /^API review failed: HTTP 429/);
    assert.equal(f.calls.length, 3, 'one try and two retries');
    const l429 = t.ledger();
    assert.equal(l429.fails, 0, 'nothing tripped');
    assert.equal(l429.tripped, null);
    assert.equal(l429.spent.review, 0, 'nothing booked');
    assert.equal(l429.n.review, undefined, 'a $0 failed run is not counted as an item (it would lower the average)');
    assert.equal(l429.entries.length, 1, 'but it leaves a ledger entry');
    assert.equal(l429.entries[0].usd, 0);
    assert.match(l429.entries[0].error, /^HTTP 429/);
    assert.equal(decide('review', { cfg: CFG, env: KEYENV }).decision, 'api');

    const g = stubFetch([apiError(400, 'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC')]);
    const wall = await t.run(g);
    assert.equal(wall.code, 3);
    assert.match(wall.out, /^API review unavailable: HTTP 400: You have reached your specified workspace API usage limits/);
    assert.equal(g.calls.length, 1, 'no retry against a hard wall');
    assert.ok(t.ledger().tripped);
    const d = decide('review', { cfg: CFG, env: KEYENV });
    assert.equal(d.decision, 'plan');
    assert.match(d.reason, /failed 1 time in a row/);
    assert.match(status({ cfg: CFG, env: KEYENV }).text, /BREAKER TRIPPED/);
  } finally { t.fx.cleanup(); }
});

test('runner: a server error is retried; other failures exit 4, book what they cost and do not count toward the breaker', async () => {
  const t = rig();
  try {
    const ok = stubFetch([apiError(529, 'Overloaded', 'overloaded_error'), msg([text('VERDICT: PASS')])]);
    assert.equal((await t.run(ok)).code, 0);
    assert.equal(ok.calls.length, 2);
    const mid = stubFetch((n) => (n === 1 ? msg([toolUse('t1', 'glob', { pattern: '*' })], USAGE, 'tool_use') : apiError(400, `bad request, key was ${SENTINEL}`)));
    const r = await t.run(mid);
    assert.equal(r.code, 4);
    assert.match(r.out, /^API review failed: HTTP 400: bad request, key was \[key removed\]/);
    assert.ok(!r.out.includes(SENTINEL));
    const cy = t.ledger();
    assert.equal(cy.fails, 0);
    assert.ok(cy.spent.review > sonnetUsd(USAGE) * 0.99, 'the first turn was paid for and is booked');
    assert.equal(cy.tripped, null);
  } finally { t.fx.cleanup(); }
});

test('runner: a key echoed by the model is scrubbed from the output', async () => {
  const t = rig();
  try {
    const r = await t.run(stubFetch([msg([text(`VERDICT: PASS${NL}the key was ${SENTINEL}`)])]));
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes(SENTINEL));
    assert.match(r.out, /\[key removed\]/);
  } finally { t.fx.cleanup(); }
});

test('runner: no key means exit 4; a usage error means exit 2; nothing is called', async () => {
  const t = rig();
  try {
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    const noKey = await t.run(f, { key: '' });
    assert.equal(noKey.code, 4);
    assert.match(noKey.out, /^API review failed: environment variable AC_API_KEY is not set/);
    assert.equal(f.calls.length, 0);
    const lines = [];
    assert.equal(await reviewMain(['run'], { out: (s) => lines.push(s) }), 2);
  } finally { t.fx.cleanup(); }
});

test('probe: one tiny haiku call through the same path reports status, tokens and dollars, books it and clears the breaker', async () => {
  const t = rig();
  try {
    recordFailure('credit balance too low', { cfg: CFG });
    recordFailure('credit balance too low', { cfg: CFG });
    assert.ok(t.ledger().tripped);
    const f = stubFetch([msg([text('ok')], { input_tokens: 20, output_tokens: 4 })]);
    const lines = [];
    const code = await creditsMain(['probe'], { out: (s) => lines.push(s), env: { AC_API_KEY: SENTINEL }, fetchImpl: f, sleep: async () => {}, cfg: CFG });
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines[0], /^probe ok: HTTP 200 from the Messages API, claude-haiku-5-5, 20 tokens in, 4 out, cost \$0\.0000\d/);
    const b = f.calls[0].body;
    assert.equal(b.model, 'claude-haiku-5-5');
    assert.equal(b.tools, undefined);
    assert.equal(b.max_tokens, 512);
    assert.equal(f.calls[0].headers['x-api-key'], SENTINEL);
    assert.ok(!lines.join('\n').includes(SENTINEL));
    const cy = t.ledger();
    assert.equal(cy.tripped, null);
    assert.match(cy.entries.at(-1).meta, /probe/);
    const bad = [];
    assert.equal(await creditsMain(['probe'], { out: (s) => bad.push(s), env: { AC_API_KEY: SENTINEL }, fetchImpl: stubFetch([apiError(401, 'invalid x-api-key', 'authentication_error')]), sleep: async () => {}, cfg: CFG }), 1);
    assert.match(bad[0], /^API review unavailable: HTTP 401/);
  } finally { t.fx.cleanup(); }
});

test('the runner never starts Claude Code or reads ANTHROPIC_BASE_URL (the credits do not cover Claude Code)', () => {
  for (const f of ['scripts/lib/api-run.mjs', 'scripts/lib/api-tools.mjs', 'scripts/api-review.mjs']) {
    const code = readFileSync(join(PLUGIN_ROOT, f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /ANTHROPIC_BASE_URL|'-p'|"-p"|CLAUDE_CODE|claude\.exe|'claude'/, f);
    if (f !== 'scripts/api-review.mjs') assert.doesNotMatch(code, /child_process|spawn|exec/, f);
  }
});

test('read-only tools: confined to the repository, line-numbered, no shell', () => {
  const t = rig();
  try {
    const tools = makeTools(t.repo);
    assert.match(tools.run('read_file', { path: 'a.txt', offset: 2, limit: 1 }), /^2\ttwo/);
    assert.throws(() => tools.run('read_file', { path: '../outside.txt' }), /outside the repository/);
    assert.throws(() => tools.run('read_file', { path: '.git/config' }), /not readable/);
    assert.throws(() => tools.run('read_file', { path: 'missing.txt' }), /no such path/);
    assert.throws(() => tools.run('bash', { command: 'ls' }), /unknown tool/);
    assert.equal(tools.run('grep', { pattern: 'nothing-like-this' }), 'no matches');
    assert.match(tools.run('grep', { pattern: 'ONE', ignore_case: true, glob: '*.txt' }), /^a\.txt:1:one/);
    assert.equal(tools.run('glob', { pattern: 'src/*.mjs' }), 'src/b.mjs');
  } finally { t.fx.cleanup(); }
});

test('buildPrompt: protocol header, verbatim brief, the instruction, the diff', () => {
  const p = buildPrompt({ brief: 'BRIEF TEXT\n\n', diffRef: 'a..b', writer: 'sonnet/high', stat: ' x | 1 +', diff: 'diff --git a/x b/x' });
  assert.match(p, /^TYPE: code-review\nWRITER: sonnet\/high\nROLE: reviewer\n\nBRIEF TEXT\n/);
  assert.ok(p.includes(REVIEW_INSTRUCTION), 'the runner prompt and the self-review clause share one instruction');
  assert.match(REVIEW_INSTRUCTION, /Start with a verdict line, `VERDICT: PASS` or `VERDICT: FIX`, then list each finding as blocker, should-fix or nit, with file:line and a repro\.$/);
  assert.match(REVIEW_INSTRUCTION, /Run the tests affected by the diff, never the full suite or ci-local/);
  assert.match(REVIEW_INSTRUCTION, /affected-test selector if it has one .*otherwise mapped from the diff/);
  assert.ok(p.includes('Diff range under review: a..b'));
  assert.ok(p.includes('diff --git a/x b/x'));
});

// --- ledger detail and the cycle summary -----------------------------------------------------

test('summary line: reviews spent of the review share, cycle day; the CLI prints it', async () => {
  const fx = makeFixture();
  try {
    rec(fx, 'review', 12.5, '2026-11-16T00:00:00Z');
    rec(fx, 'rater', 3, '2026-11-16T00:00:00Z');
    assert.equal(summaryLine({ now: T('2026-11-16T10:00:00Z'), cfg: CFG, path: ledgerIn(fx) }), 'API credits: reviews $12.50 of $100, cycle day 16');
    assert.equal(summaryLine({ now: T('2026-12-02T10:00:00Z'), cfg: CFG, path: ledgerIn(fx) }), 'API credits: reviews $0.00 of $100, cycle day 2');
    const lines = [];
    await creditsMain(['summary', '--now', '2026-11-16T10:00:00Z'], { out: (s) => lines.push(s), cfg: CFG });
    assert.match(lines[0], /^API credits: reviews \$\d+\.\d\d of \$100, cycle day 16$/);
  } finally { fx.cleanup(); }
});

test('the ledger keeps every run, not a rolling hundred', () => {
  const fx = makeFixture();
  try {
    for (let i = 0; i < 150; i++) record('review', 0.01, `r${i}`, { now: T('2026-11-16T00:00:00Z'), cfg: CFG, path: ledgerIn(fx), detail: { project: 'p', model: 'm', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, turns: 1 } });
    const led = JSON.parse(readFileSync(ledgerIn(fx), 'utf8')).cycles['2026-11-01'];
    assert.equal(led.entries.length, 150);
    assert.equal(led.entries[0].project, 'p');
  } finally { fx.cleanup(); }
});

// --- self-review text ------------------------------------------------------------------

test('the self-review clause runs the governor before spawning a reviewer, and keeps the subagent route', () => {
  const rung = { model: 'sonnet', effort: 'high', agent: 'ac-sonnet-high' };
  const block = selfReviewBlock(rung);
  assert.ok(block.includes('api-credits.mjs" decide review'));
  assert.ok(block.includes('api-review.mjs" run --brief-file'));
  assert.ok(block.includes('--model sonnet --effort high'));
  assert.ok(block.includes('--review-file'));
  assert.ok(block.includes('no verdict line, no land'));
  assert.ok(block.includes('run_in_background') && block.includes('it logs itself at 8 minutes and goes on, and only a hung run is stopped'), 'a review can outlive a foreground Bash call (10 minutes), so it runs in the background');
  assert.ok(!block.includes('15 minutes') && !block.includes('stops itself after'), 'no wall-clock stop is promised');
  assert.ok(block.includes(`this instruction: "${REVIEW_INSTRUCTION}"`), 'the reviewer brief carries the affected-tests-only instruction');
  assert.ok(block.includes('can run the affected tests'));
  assert.ok(!block.includes('Bash timeout of 600000 ms'));
  assert.ok(block.includes("brief TEXT goes into that file, never only a path to it"));
  assert.ok(block.includes('spawn exactly ONE reviewer, in the foreground'));
  assert.ok(block.includes('API review unavailable'));
  const agent = readFileSync(join(PLUGIN_ROOT, 'agents', 'ac-sonnet-high.md'), 'utf8');
  assert.ok(agent.includes('api-credits.mjs" decide review'), 'the generated rung body carries the clause');
});


// --- review fixes (0.31.46 fix round) ---------------------------------------------------------

const direct = (t, fetchImpl, extra = {}) => runApi({
  prompt: 'review this', model: 'sonnet', cwd: t.repo, cfg: CFG, env: { AC_API_KEY: SENTINEL }, fetchImpl, sleep: async () => {}, ...extra,
});

test('runner: each paid turn is booked as it completes, so a run killed mid-way still leaves its spend; the final entry does not double-count', async () => {
  const t = rig();
  try {
    let seenAfterTurn1 = null;
    const f = stubFetch((n) => {
      if (n === 1) return msg([toolUse('t1', 'glob', { pattern: '*' })], USAGE, 'tool_use');
      if (n === 2) { seenAfterTurn1 = t.ledger(); return msg([text(`VERDICT: PASS${NL}ok`)]); }
      throw new Error('unexpected');
    });
    const r = await t.run(f);
    assert.equal(r.code, 0, r.out);
    assert.ok(seenAfterTurn1 && Math.abs(seenAfterTurn1.spent.review - sonnetUsd(USAGE)) < 1e-9, 'turn 1 was in the ledger before turn 2 was requested');
    assert.equal(seenAfterTurn1.n.review, undefined, 'no run entry yet');
    const cy = t.ledger();
    assert.ok(Math.abs(cy.spent.review - 2 * sonnetUsd(USAGE)) < 1e-9, 'two turns, booked once each');
    assert.equal(cy.n.review, 1);
    assert.ok(Math.abs(cy.entries[0].usd - 2 * sonnetUsd(USAGE)) < 1e-9);
  } finally { t.fx.cleanup(); }
});

test('runner: no wall-clock deadline: a review past 8 minutes is logged to long-runs and goes on to a verdict', async () => {
  const t = rig();
  try {
    let tNow = 1000;
    const rows = [];
    const f = stubFetch((n) => {
      tNow += 9 * 60 * 1000; // each response takes 9 minutes of the injected clock
      return n === 1 ? msg([toolUse('t1', 'glob', { pattern: '*' })], USAGE, 'tool_use') : msg([text(`VERDICT: PASS${NL}fine`)]);
    });
    const r = await direct(t, f, { clock: () => tNow, logRow: (row) => rows.push(row), requireVerdict: true });
    assert.equal(r.ok, true, r.reason);
    assert.equal(f.calls.length, 2, 'the review was not stopped at the old 8-minute deadline');
    assert.equal(rows.length, 1, 'one long-runs row');
    assert.equal(rows[0].agentType, 'api-review');
    assert.equal(rows[0].steps, 1);
    assert.ok(rows[0].durationMin >= 8, String(rows[0].durationMin));
    assert.deepEqual(Object.keys(rows[0]).sort(), ['agentId', 'agentType', 'description', 'durationMin', 'sessionId', 'startedAt', 'steps', 'transcriptPath', 'ts']);
    assert.ok(r.notes.some((n) => /ran past 8 minutes/.test(n) && /not stopped/.test(n)));
    assert.match(t.ledger().entries[0].notes[0], /ran past 8 minutes/, 'visible in the ledger');
    assert.equal(SLOW_REVIEW_MS, 8 * 60 * 1000);
  } finally { t.fx.cleanup(); }
});

test('runner: the slow row really lands in state/long-runs.jsonl (the schema the scout reads)', async () => {
  const t = rig();
  try {
    let tNow = 1000;
    const f = stubFetch(() => { tNow += 9 * 60 * 1000; return msg([text(`VERDICT: PASS${NL}fine`)]); });
    const r = await direct(t, f, { clock: () => tNow, meta: 'review a..b' });
    assert.equal(r.ok, true, r.reason);
    const p = join(t.fx.stateDir, 'state', 'long-runs.jsonl');
    assert.ok(existsSync(p), p);
    const row = JSON.parse(readFileSync(p, 'utf8').trim().split('\n')[0]);
    assert.equal(row.agentType, 'api-review');
    assert.equal(row.description, 'review a..b');
    assert.ok(Number.isFinite(row.steps) && Number.isFinite(Date.parse(row.ts)));
  } finally { t.fx.cleanup(); }
});

test('runner: only a hung run is stopped: no response for 10 minutes books what was paid and falls back', async () => {
  const t = rig();
  try {
    let tNow = 1000;
    let n = 0;
    const f = async (url, init) => { // turn 1 answers; turn 2 never answers (the clock jumps 11 minutes, then the call fails)
      n += 1;
      if (n === 1) return { status: 200, text: async () => JSON.stringify(msg([toolUse('t1', 'glob', { pattern: '*' })], USAGE, 'tool_use').body) };
      tNow += 11 * 60 * 1000;
      throw new Error('This operation was aborted');
    };
    const r = await direct(t, f, { clock: () => tNow, logRow: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, false, 'exit 4: the writer falls back to the subagent reviewer');
    assert.match(r.reason, /no response for 10 minutes after 1 turn/);
    assert.equal(HUNG_MS, 10 * 60 * 1000);
    const cy = t.ledger();
    assert.ok(Math.abs(cy.spent.review - sonnetUsd(USAGE)) < 1e-9);
    assert.match(cy.entries[0].error, /no response for 10 minutes/);
    // A slow but responding review (9 minutes per turn, no 10-minute silence) is not hung.
    let t2 = 0;
    const g = stubFetch((k) => { t2 += 9 * 60 * 1000; return k < 4 ? msg([toolUse(`t${k}`, 'glob', { pattern: '*' })], USAGE, 'tool_use') : msg([text(`VERDICT: PASS${NL}ok`)]); });
    const ok = await direct(t, g, { clock: () => t2, logRow: () => {}, requireVerdict: true });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(g.calls.length, 4);
  } finally { t.fx.cleanup(); }
});

test('runner: a soft note at $0.20 (ledger and result), a long-runs row for the scout, and the run goes on and the run goes on; the backstop is api_review_hard_usd, 0 disables it', async () => {
  const t = rig();
  try {
    const big = { input_tokens: 400000, output_tokens: 10 }; // about $0.80 a turn on Sonnet
    const script = (k) => (k < 4 ? msg([toolUse(`t${k}`, 'glob', { pattern: '*' })], big, 'tool_use') : msg([text(`VERDICT: PASS${NL}ok`)], big));
    const f = stubFetch(script);
    const r = await direct(t, f, { requireVerdict: true, maxUsd: 0 }); // backstop off: 4 turns, about $3.20
    assert.equal(r.ok, true, r.reason);
    assert.equal(f.calls.length, 4, 'nothing stopped it');
    assert.ok(r.usd > SOFT_USD);
    assert.equal(r.notes.filter((n) => /soft spend limit/.test(n)).length, 1, 'one note, not one per turn');
    assert.match(t.ledger().entries[0].notes.join(' '), /passed the \$0\.20 soft spend limit; not stopped/);
    assert.ok(!f.calls.some((c) => c.body.tool_choice), 'no forced final turn with the backstop off');
    const lr = join(t.fx.stateDir, 'state', 'long-runs.jsonl');
    const rows = readFileSync(lr, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, 'one row for the spend limit, not one per turn');
    assert.equal(rows[0].agentType, 'api-review');
    assert.match(rows[0].description, /soft spend limit; not stopped: \$0\.\d\d after 1 turn/);
    assert.ok(Number.isFinite(rows[0].steps));
    // With the default $0.50 backstop the run is also left alone until 80% of it ($0.40).
    const mid = { input_tokens: 40000, output_tokens: 10 }; // about $0.08 a turn
    const g = stubFetch((k) => (k < 3 ? msg([toolUse(`m${k}`, 'glob', { pattern: '*' })], mid, 'tool_use') : msg([text(`VERDICT: PASS${NL}ok`)], mid)));
    const r2 = await direct(t, g, { requireVerdict: true });
    assert.equal(r2.ok, true, r2.reason);
    assert.ok(!g.calls.some((c) => c.body.tool_choice), 'under 80% of the backstop: no forced final turn');
    assert.equal(DEFAULT_HARD_USD, 0.5);
    assert.equal(SOFT_USD, 0.2);
  } finally { t.fx.cleanup(); }
});

test('hardUsdFrom: the option value, 0 disables, junk and negatives take the default', () => {
  assert.equal(hardUsdFrom(''), 0.5);
  assert.equal(hardUsdFrom(undefined), 0.5);
  assert.equal(hardUsdFrom('3'), 3);
  assert.equal(hardUsdFrom(0), 0);
  assert.equal(hardUsdFrom('0'), 0);
  assert.equal(hardUsdFrom(-1), 0.5);
  assert.equal(hardUsdFrom('abc'), 0.5);
});

test('runner effort: the routed effort rides in output_config.effort on every request; none, none sent', async () => {
  const t = rig();
  try {
    const f = stubFetch((k) => (k === 1 ? msg([toolUse('t1', 'glob', { pattern: '*' })], USAGE, 'tool_use') : msg([text(`VERDICT: PASS${NL}ok`)])));
    const r = await direct(t, f, { effort: 'high' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(f.calls.length, 2);
    for (const c of f.calls) assert.deepEqual(c.body.output_config, { effort: 'high' });
    const g = stubFetch([msg([text(`VERDICT: PASS${NL}ok`)])]);
    await direct(t, g, {});
    assert.equal('output_config' in g.calls[0].body, false, 'no effort asked, none sent');
    const h = stubFetch([msg([text(`VERDICT: PASS${NL}ok`)])]);
    await t.run(h, { extra: [] }); // the CLI path: --effort xhigh reaches the request
    assert.deepEqual(h.calls[0].body.output_config, { effort: 'xhigh' });
  } finally { t.fx.cleanup(); }
});

test('runner: a brief file that holds only a path is exit 4 before any call; a long brief is cut and says so', async () => {
  const t = rig();
  try {
    writeFileSync(t.brief, "TYPE: bounded-feature\nThe lead's brief: C:/Users/me/.claude/tasks/x/brief.md\n");
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    const r = await t.run(f);
    assert.equal(r.code, 4);
    assert.match(r.out, /^API review failed: the brief file holds a file path or no text/);
    assert.equal(f.calls.length, 0);
    writeFileSync(t.brief, 'TYPE: bounded-feature\n');
    assert.equal((await t.run(f)).code, 4, 'no brief text at all');
    const long = buildPrompt({ brief: 'x'.repeat(70000), diffRef: 'a..b', writer: 'w' });
    assert.ok(long.includes('[brief cut at 60000 characters]'));
    assert.ok(!buildPrompt({ brief: 'short brief', diffRef: 'a..b' }).includes('[brief cut'));
  } finally { t.fx.cleanup(); }
});

test('runner: requireVerdict makes a verdict-less or cut-off answer a failure, booked once; the plain runner (probe) still passes any text', async () => {
  const t = rig();
  try {
    const f = stubFetch([msg([text('Let me check the files first.')])]);
    const r = await t.run(f);
    assert.equal(r.code, 4);
    assert.match(r.out, /^API review failed: the review has no VERDICT line/);
    const cy = t.ledger();
    assert.ok(Math.abs(cy.spent.review - sonnetUsd(USAGE)) < 1e-9, 'paid, and booked once');
    assert.equal(cy.fails, 0);
    const g = stubFetch([msg([text(`VERDICT: FIX${NL}blocker: half a`)], USAGE, 'max_tokens')]);
    const cut = await t.run(g);
    assert.equal(cut.code, 4);
    assert.match(cut.out, /cut off \(stop_reason max_tokens\)/);
    const ok = await t.run(stubFetch([msg([text(`**VERDICT: PASS**${NL}fine`)])]));
    assert.equal(ok.code, 0, 'a bold verdict line counts');
    const plain = await direct(t, stubFetch([msg([text('ok')])]), { tools: false });
    assert.equal(plain.ok, true);
  } finally { t.fx.cleanup(); }
});

test('runner: max_tokens defaults to 64000 and can be set; redirects are refused; bad numbers are exit 2', async () => {
  const t = rig();
  try {
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    await t.run(f);
    assert.equal(f.calls[0].body.max_tokens, 64000);
    assert.equal(f.calls[0].redirect, 'error', 'the key header never follows a redirect');
    const g = stubFetch([msg([text('VERDICT: PASS')])]);
    await t.run(g, { extra: ['--max-tokens', '4000'] });
    assert.equal(g.calls[0].body.max_tokens, 4000);
    for (const bad of ['--max-turns', '--max-usd', '--max-tokens']) {
      const h = stubFetch([msg([text('VERDICT: PASS')])]);
      const r = await t.run(h, { extra: [bad, 'abc'] });
      assert.equal(r.code, 2, bad);
      assert.equal(h.calls.length, 0);
    }
  } finally { t.fx.cleanup(); }
});

test('runner: a ledger write failure is reported on stderr and in the label, not swallowed', async () => {
  const t = rig();
  try {
    const p = join(t.fx.stateDir, 'state', 'api-credits.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{ not json');
    const r = await t.run(stubFetch([msg([text('VERDICT: PASS')])]));
    assert.equal(r.code, 0, r.out);
    assert.match(r.err, /^ledger write failed; \$[0-9.]+ not recorded/);
    assert.match(r.out, /ledger write failed; \$[0-9.]+ not recorded/);
    assert.ok(!r.err.includes(SENTINEL) && !r.out.includes(SENTINEL));
  } finally { t.fx.cleanup(); }
});

test('runner: a failed run that cost nothing still leaves a ledger entry with its error', async () => {
  const t = rig();
  try {
    const r = await t.run(stubFetch([apiError(401, 'invalid x-api-key', 'authentication_error')]));
    assert.equal(r.code, 3);
    const cy = t.ledger();
    assert.equal(cy.entries.length, 1);
    assert.equal(cy.entries[0].usd, 0);
    assert.match(cy.entries[0].error, /^HTTP 401/);
    assert.equal(cy.fails, 1);
  } finally { t.fx.cleanup(); }
});

test('runner: a bws lookup failure is a config failure: it counts toward the breaker, and decide then answers plan', async () => {
  const t = rig();
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  process.env.AGENT_COMPANION_BWS_BIN = join(t.fx.dir, 'no-such-bws-binary');
  try {
    const cfg = { ...CFG, keySource: 'bws:my-secret' };
    const env = { BWS_ACCESS_TOKEN: 'tok' };
    const f = stubFetch([msg([text('VERDICT: PASS')])]);
    for (let i = 0; i < 2; i++) {
      const r = await runApi({ prompt: 'x', model: 'sonnet', cwd: t.repo, cfg, env, fetchImpl: f, sleep: async () => {} });
      assert.equal(r.ok, false);
      assert.equal(r.unavailable, true, 'exit 3 class');
      assert.match(r.reason, /bws failed to return the secret/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(t.ledger().fails, 2);
    assert.match(decide('review', { cfg, env, path: join(t.fx.stateDir, 'state', 'api-credits.json') }).reason, /failed 2 times in a row/);
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    t.fx.cleanup();
  }
});

test('read-only tools: the deny list holds against case, trailing dots, streams and 8.3 names; UNC, device and drive paths are refused before the filesystem', () => {
  const t = rig();
  try {
    mkdirSync(join(t.repo, '.git'), { recursive: true });
    writeFileSync(join(t.repo, '.git', 'config'), 'url = https://u:tok@example.com/r.git');
    writeFileSync(join(t.repo, '.env'), 'SECRET=1');
    const tools = makeTools(t.repo);
    for (const p of ['.GIT/config', '.Git\\config', '.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config', 'GIT~1/config', '.ENV', '.Env', '.env.', '.env::$DATA', 'ENV~1', 'src/../.GIT/config']) {
      assert.throws(() => tools.run('read_file', { path: p }), /not readable|no such path/, p);
    }
    assert.throws(() => tools.run('grep', { pattern: 'tok', path: '.GIT' }), /not readable/);
    assert.ok(!tools.run('grep', { pattern: 'tok|SECRET' }).includes('tok@'), 'the walk skips them');
    const t0 = Date.now();
    for (const p of ['\\\\192.0.2.1\\share\\x.txt', '//192.0.2.1/share/x.txt', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\pipe\\x', 'C:a.txt', 'C:\\Windows\\win.ini', '/etc/passwd']) {
      assert.throws(() => tools.run('read_file', { path: p }), /outside the repository/, p);
    }
    assert.ok(Date.now() - t0 < 2000, 'no network lookup was started');
    assert.throws(() => tools.run('grep', { pattern: '^(a+)+$' }), /nested quantifiers/);
    assert.match(tools.run('grep', { pattern: '^(?:one)+$' }), /a\.txt:1:one/);
    if (process.platform === 'win32') assert.throws(() => tools.run('read_file', { path: 'NUL' }), /not readable/);
  } finally { t.fx.cleanup(); }
});

test('readProjectRules / fetchSystem: the project CLAUDE.md files are inlined under a stated cap; none means the base prompt unchanged', () => {
  const fx = makeFixture();
  try {
    assert.equal(RULES_CAP, 20000);
    const none = join(fx.dir, 'norules');
    mkdirSync(none, { recursive: true });
    assert.equal(readProjectRules(none), '', 'no CLAUDE.md: nothing inlined');
    assert.equal(fetchSystem('BASE', ''), 'BASE');
    const p = join(fx.dir, 'proj');
    mkdirSync(join(p, '.claude'), { recursive: true });
    writeFileSync(join(p, 'CLAUDE.md'), '# Root rules\nUse tabs.\n');
    writeFileSync(join(p, '.claude', 'CLAUDE.md'), 'Second file rule.\n');
    const r = readProjectRules(p);
    assert.match(r, /<project-rules file="claude\.md">\n# Root rules\nUse tabs\.\n<\/project-rules>/);
    assert.match(r, /<project-rules file=".claude\/claude\.md">\nSecond file rule\./);
    const sys = fetchSystem('BASE', r);
    assert.ok(sys.startsWith('BASE\n\n'));
    assert.match(sys, /do no knowledge check/);
    assert.match(sys, /Use tabs\./);
    // the cap: the first file is cut with a stated count, the second is named as left out
    const cut = readProjectRules(p, 10);
    assert.match(cut, /\[cut: \d+ more characters not shown, the 10-character cap on project rules\]/);
    assert.match(cut, /\.claude\/claude\.md left out: the 10-character cap/);
    assert.ok(cut.includes('# Root rul') && !cut.includes('Use tabs'));
  } finally { fx.cleanup(); }
});
