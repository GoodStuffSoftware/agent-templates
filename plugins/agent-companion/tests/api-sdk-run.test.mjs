// API SDK engine (0.31.46): scripts/lib/api-sdk-run.mjs driven with an injected fake SDK module
// (no live calls, no install), and its wiring in scripts/api-review.mjs (engine choice, fallback).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { DEFAULT_SHARES } from '../scripts/lib/api-credits.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';
import { spawnSyncHidden } from '../scripts/lib/proc.mjs';
import {
  runApiSdk, loadSdk, sdkEnv, SDK_TOOLS, SDK_DISALLOWED, SDK_BASH_DENY, SDK_POWERSHELL_DENY, SDK_READ_DENY, DEFAULT_SDK_VERSION,
  sdkToolsFor, sdkSystem, DEFAULT_SDK_DEADLINE_MS, DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS,
} from '../scripts/lib/api-sdk-run.mjs';
import { main as reviewMain, DEFAULT_RUNNER, chooseRunner, briefAsksForCommands, buildPrompt } from '../scripts/api-review.mjs';

const CFG = { budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:AC_API_KEY', reviewRatio: 0.5, itemEstimate: 2 };
const KEY = 'sk-ant-api03-SENTINEL-sdk-do-not-leak-0123456789';
const ENV = { AC_API_KEY: KEY, AC_API_WORKSPACE_ID: 'wrkspc_test1', PATH: '/bin', SystemRoot: 'C:\\Windows' };
const NOW = Date.parse('2026-11-16T00:00:00Z');
const NL = '\n';

const sonnetUsd = (u) => priceUsage(u, 'claude-sonnet-5-5').usd;
const init = (apiKeySource = 'ANTHROPIC_API_KEY') => ({ type: 'system', subtype: 'init', apiKeySource, tools: SDK_TOOLS });
const assistant = (id, content, usage, extra = {}) => ({ type: 'assistant', message: { id, role: 'assistant', content, usage, stop_reason: extra.stop || null }, ...(extra.error ? { error: extra.error } : {}) });
const txt = (t) => [{ type: 'text', text: t }];
const result = (o = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: `VERDICT: PASS${NL}fine`, stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1, errors: [], ...o });

// A fake SDK module. `script` is an array of messages, or fn({prompt, options}) returning an async generator.
function fakeSdk(script) {
  const calls = [];
  return {
    calls,
    query(args) {
      calls.push(args);
      const gen = typeof script === 'function' ? script(args) : (async function* () { for (const m of script) yield m; })();
      const it = gen[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; }, next: () => it.next(), return: async () => { if (it.return) await it.return(); return { done: true, value: undefined }; } };
    },
  };
}

function ledgerOf(fx) {
  const p = join(fx.stateDir, 'state', 'api-credits.json');
  return existsSync(p) ? Object.values(JSON.parse(readFileSync(p, 'utf8')).cycles)[0] : null;
}

const run = (sdk, over = {}) => runApiSdk({ prompt: 'review this', model: 'sonnet', cwd: process.cwd(), cfg: CFG, env: ENV, now: NOW, requireVerdict: true, sdk, ...over });

test('sdkEnv: a minimal copy of the system variables; every other Anthropic, Claude or cloud credential is stripped', () => {
  const base = {
    Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', TEMP: 'C:\\tmp', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bash.exe',
    ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_CUSTOM_HEADERS: 'x: y',
    CLAUDE_CODE_OAUTH_TOKEN: 'oat', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', AC_API_KEY: KEY, BWS_ACCESS_TOKEN: 'b',
  };
  const e = sdkEnv({ key: KEY, workspace: 'wrkspc_a', base, bashTimeoutMs: 90000 });
  assert.equal(e.ANTHROPIC_API_KEY, KEY);
  assert.equal(e.ANTHROPIC_CUSTOM_HEADERS, 'anthropic-workspace-id: wrkspc_a');
  assert.equal(e.Path, 'C:\\bin');
  assert.equal(e.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Git\\bash.exe');
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'AC_API_KEY', 'BWS_ACCESS_TOKEN']) assert.ok(!(k in e), `${k} leaked`);
  assert.equal(e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.equal(e.BASH_DEFAULT_TIMEOUT_MS, '90000');
  assert.equal(e.BASH_MAX_TIMEOUT_MS, '600000', 'the ceiling lets a test run use 10 minutes');
  assert.ok(!('CLAUDE_CODE_USE_POWERSHELL_TOOL' in e), 'PowerShell is only switched on when asked');
  assert.equal(sdkEnv({ key: KEY, base, powershell: true }).CLAUDE_CODE_USE_POWERSHELL_TOOL, '1');
  const d = sdkEnv({ key: KEY, base });
  assert.equal(d.BASH_DEFAULT_TIMEOUT_MS, String(DEFAULT_BASH_TIMEOUT_MS));
  assert.equal(d.BASH_MAX_TIMEOUT_MS, String(MAX_BASH_TIMEOUT_MS));
  assert.equal('ANTHROPIC_CUSTOM_HEADERS' in sdkEnv({ key: KEY, base }), false, 'no workspace, no header');
});

test('runApiSdk: the trimmed options reach query(); the ledger gets each call once; the result is reconciled with total_cost_usd', async () => {
  const fx = makeFixture();
  try {
    const u1 = { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 };
    const u2 = { input_tokens: 100, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000 };
    const sdk = fakeSdk([
      init(),
      // one API call arrives as two messages with the same id and the same usage: counted once
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --test' } }], u1),
      assistant('m1', txt('running'), u1),
      assistant('m2', txt(`VERDICT: PASS${NL}fine`), u2, { stop: 'end_turn' }),
      result({ total_cost_usd: 0.0123 }),
    ]);
    const r = await run(sdk, { platform: 'linux' });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.path, 'sdk');
    assert.equal(r.turns, 2);
    assert.deepEqual(r.tokens, { input: 2100, output: 700, cacheRead: 7000, cacheWrite: 5000 });
    const priced = sonnetUsd({ input: 2100, output: 700, cacheRead: 7000, cacheWrite: 5000 });
    assert.ok(Math.abs(r.usd - Math.max(priced, 0.0123)) < 1e-9);
    assert.match(r.text, /^VERDICT: PASS/);
    // options
    const o = sdk.calls[0].options;
    assert.deepEqual(o.settingSources, []);
    assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch']);
    assert.deepEqual(o.allowedTools, o.tools);
    for (const t of ['Edit', 'Write', 'Task', 'Agent', 'NotebookEdit']) assert.ok(o.disallowedTools.includes(t), t);
    for (const t of ['WebFetch', 'WebSearch', 'PowerShell']) assert.ok(!o.disallowedTools.includes(t), `${t} is allowed`);
    for (const t of SDK_BASH_DENY) assert.ok(o.disallowedTools.includes(t));
    for (const t of SDK_READ_DENY) assert.ok(o.disallowedTools.includes(t), `credential deny ${t}`);
    assert.ok(!o.disallowedTools.some((t) => t.startsWith('PowerShell')), 'no PowerShell tool off Windows, so no PowerShell rules');
    assert.ok(!('CLAUDE_CODE_USE_POWERSHELL_TOOL' in o.env));
    assert.equal(o.env.BASH_MAX_TIMEOUT_MS, '600000');
    assert.deepEqual(SDK_DISALLOWED.filter((t) => SDK_TOOLS.includes(t)), []);
    assert.equal(o.permissionMode, 'dontAsk'); // requested; the binary reports default under the env scrub, so the lists below are what hold
    assert.ok(o.allowedTools.length > 0 && o.disallowedTools.length > 0, 'explicit allow and deny lists carry the safety');
    assert.equal(typeof o.systemPrompt, 'string');
    assert.match(o.systemPrompt, /VERDICT: PASS/);
    assert.equal(o.cwd, process.cwd());
    assert.equal(o.model, 'claude-sonnet-5-5');
    assert.equal(o.maxBudgetUsd, 1);
    assert.equal('plugins' in o || 'mcpServers' in o || 'skills' in o, false, 'no plugins, MCP servers or skills are passed at all');
    assert.equal(o.env.ANTHROPIC_API_KEY, KEY);
    assert.equal(o.env.ANTHROPIC_CUSTOM_HEADERS, 'anthropic-workspace-id: wrkspc_test1');
    assert.ok(!('AC_API_KEY' in o.env) && !('AC_API_WORKSPACE_ID' in o.env));
    assert.ok(o.abortController instanceof AbortController);
    // ledger: per-turn booking + the run entry; spent == the reconciled figure, once
    const cy = ledgerOf(fx);
    assert.ok(Math.abs(cy.spent.review - r.usd) < 1e-9);
    assert.equal(cy.n.review, 1);
    const e = cy.entries[cy.entries.length - 1];
    assert.equal(e.path, 'sdk');
    assert.equal(e.turns, 2);
    assert.ok(!JSON.stringify(cy).includes(KEY));
  } finally { fx.cleanup(); }
});

test('toolset: Read, Grep, Glob, Bash, WebSearch, WebFetch everywhere, PowerShell on Windows; no edit, write, agent, notebook or MCP tool', () => {
  assert.deepEqual(sdkToolsFor('linux'), ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch']);
  assert.deepEqual(sdkToolsFor('darwin'), sdkToolsFor('linux'));
  assert.deepEqual(sdkToolsFor('win32'), [...sdkToolsFor('linux'), 'PowerShell']);
  for (const t of sdkToolsFor('win32')) assert.ok(!SDK_DISALLOWED.includes(t), t);
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task']) { assert.ok(!sdkToolsFor('win32').includes(t), t); assert.ok(SDK_DISALLOWED.includes(t), t); }
  assert.ok(!sdkToolsFor('win32').some((t) => t.startsWith('mcp__')));
  assert.equal(DEFAULT_SDK_DEADLINE_MS, 15 * 60 * 1000, 'a test run of up to 10 minutes needs more than the fetch engine 8');
  assert.ok(MAX_BASH_TIMEOUT_MS < DEFAULT_SDK_DEADLINE_MS);
  assert.match(sdkSystem(30), /600000/, 'the reviewer is told how to ask for a long timeout');
  for (const rule of SDK_POWERSHELL_DENY) assert.match(rule, /^PowerShell\(.+ \*\)$/);
});

test('runApiSdk on Windows: PowerShell is allowed, switched on in the child env, and has its own deny rules', async () => {
  const fx = makeFixture();
  try {
    const sdk = fakeSdk([init(), assistant('m1', txt(`VERDICT: PASS${NL}ok`), { input_tokens: 10, output_tokens: 10 }, { stop: 'end_turn' }), result()]);
    const r = await run(sdk, { platform: 'win32' });
    assert.equal(r.ok, true, r.reason);
    const o = sdk.calls[0].options;
    assert.ok(o.tools.includes('PowerShell') && o.allowedTools.includes('PowerShell'));
    assert.equal(o.env.CLAUDE_CODE_USE_POWERSHELL_TOOL, '1', 'else the scoped Bash deny rules turn the tool off');
    for (const t of SDK_POWERSHELL_DENY) assert.ok(o.disallowedTools.includes(t), t);
    for (const t of SDK_BASH_DENY) assert.ok(o.disallowedTools.includes(t), t);
    assert.ok(!o.disallowedTools.includes('PowerShell'), 'the bare tool name is not denied');
  } finally { fx.cleanup(); }
});

test('runApiSdk: a total_cost_usd above the priced sum is what gets booked (the ledger never undercounts)', async () => {
  const fx = makeFixture();
  try {
    const u = { input_tokens: 1000, output_tokens: 100 };
    const r = await run(fakeSdk([init(), assistant('m1', txt(`VERDICT: FIX${NL}x`), u, { stop: 'end_turn' }), result({ result: `VERDICT: FIX${NL}x`, total_cost_usd: 0.5 })]));
    assert.equal(r.ok, true);
    assert.equal(r.usd, 0.5);
    assert.ok(Math.abs(ledgerOf(fx).spent.review - 0.5) < 1e-9);
  } finally { fx.cleanup(); }
});

test('runApiSdk: an init that is not on ANTHROPIC_API_KEY aborts the run before any work, as a configuration failure', async () => {
  const fx = makeFixture();
  try {
    let aborted = false;
    const sdk = fakeSdk(async function* (args) {
      args.options.abortController.signal.addEventListener('abort', () => { aborted = true; });
      yield init('claude.ai');
      yield assistant('m1', txt('should never be read'), { input_tokens: 5, output_tokens: 5 });
    });
    const r = await run(sdk);
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, true);
    assert.match(r.reason, /claude\.ai.*ANTHROPIC_API_KEY/);
    assert.equal(aborted, true);
    assert.equal(r.usd, 0);
    assert.equal(ledgerOf(fx).fails, 1, 'counts toward the two-strikes breaker');
  } finally { fx.cleanup(); }
});

test('runApiSdk: the per-review spend cap aborts the run and falls back (no verdict)', async () => {
  const fx = makeFixture();
  try {
    let aborted = false;
    const sdk = fakeSdk(async function* (args) {
      args.options.abortController.signal.addEventListener('abort', () => { aborted = true; });
      yield init();
      yield assistant('m1', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], { input_tokens: 400000, output_tokens: 10 }); // ~$0.80
      yield assistant('m2', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], { input_tokens: 400000, output_tokens: 10 }); // over $1
      yield assistant('m3', txt(`VERDICT: PASS${NL}too late`), { input_tokens: 1, output_tokens: 1 });
    });
    const r = await run(sdk);
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, false);
    assert.match(r.reason, /spend cap of \$1 after 2 turn/);
    assert.equal(aborted, true);
    assert.ok(r.usd > 1);
    const cy = ledgerOf(fx);
    assert.ok(Math.abs(cy.spent.review - r.usd) < 1e-9, 'the spent turns are in the ledger');
  } finally { fx.cleanup(); }
});

test('runApiSdk: the wall-clock deadline aborts a hung run', async () => {
  const fx = makeFixture();
  try {
    const sdk = fakeSdk(async function* (args) {
      yield init();
      await new Promise((resolve, reject) => {
        const s = args.options.abortController.signal;
        if (s.aborted) return reject(new Error('aborted'));
        s.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')));
      });
    });
    const r = await run(sdk, { deadlineMs: 40 });
    assert.equal(r.ok, false);
    assert.equal(r.unavailable, false);
    assert.match(r.reason, /wall-clock deadline/);
  } finally { fx.cleanup(); }
});

test('runApiSdk: requireVerdict turns a review without a VERDICT line into a failure', async () => {
  const fx = makeFixture();
  try {
    const u = { input_tokens: 10, output_tokens: 10 };
    const none = await run(fakeSdk([init(), assistant('m1', txt('looks fine'), u), result({ result: 'looks fine' })]));
    assert.equal(none.ok, false);
    assert.match(none.reason, /no VERDICT line/);
    const cut = await run(fakeSdk([init(), assistant('m1', txt('VERDICT: PASS'), u), result({ result: 'VERDICT: PASS', stop_reason: 'max_tokens' })]));
    assert.equal(cut.ok, false);
    assert.match(cut.reason, /cut off/);
    const lax = await run(fakeSdk([init(), assistant('m1', txt('looks fine'), u), result({ result: 'looks fine' })]), { requireVerdict: false });
    assert.equal(lax.ok, true);
  } finally { fx.cleanup(); }
});

test('runApiSdk: an auth or billing error from the SDK is "unavailable"; other errors are plain failures; the key is scrubbed', async () => {
  const fx = makeFixture();
  try {
    const bill = await run(fakeSdk([init(), result({ subtype: 'success', is_error: true, result: `Your credit balance is too low (${KEY})`, errors: [] })]));
    assert.equal(bill.unavailable, true);
    assert.ok(!bill.reason.includes(KEY));
    const turns = await run(fakeSdk([init(), result({ subtype: 'error_max_turns', is_error: true, errors: [] })]));
    assert.equal(turns.ok, false);
    assert.equal(turns.unavailable, false);
    const ws = await run(fakeSdk([init(), result({ is_error: true, result: 'HTTP 400: the request must include the anthropic-workspace-id header' })]));
    assert.equal(ws.unavailable, true);
    const cy = ledgerOf(fx);
    assert.ok(!JSON.stringify(cy).includes(KEY));
  } finally { fx.cleanup(); }
});

test('runApiSdk: an SDK that cannot be loaded spends nothing and reports sdkUnavailable (the caller falls back); a bad key stops first', async () => {
  const fx = makeFixture();
  try {
    const r = await runApiSdk({ prompt: 'x', model: 'sonnet', cfg: CFG, env: ENV, now: NOW, load: async () => { throw new Error('npm install failed (exit 1)'); } });
    assert.equal(r.ok, false);
    assert.equal(r.sdkUnavailable, true);
    assert.match(r.reason, /Agent SDK is not available: npm install failed/);
    assert.equal(r.usd, 0);
    assert.equal(ledgerOf(fx), null, 'nothing booked, no failure counted');
    const bad = await runApiSdk({ prompt: 'x', model: 'sonnet', cfg: CFG, env: { AC_API_KEY: 'sk-ant-admin01-nope' }, now: NOW, sdk: fakeSdk([]) });
    assert.equal(bad.unavailable, true);
    assert.match(bad.reason, /not a Console API key/);
  } finally { fx.cleanup(); }
});

test('loadSdk: installs the pinned version once into the given dir, validates the version string, imports by file URL', async () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, 'sdk', '9.9.9');
    const installs = [];
    const install = (d, v) => {
      installs.push(v);
      const pkg = join(d, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: v }));
    };
    const seen = [];
    const importer = async (url) => { seen.push(url); return { query() {} }; };
    const a = await loadSdk({ version: '9.9.9', dir, install, importer });
    const b = await loadSdk({ version: '9.9.9', dir, install, importer });
    assert.equal(typeof a.query, 'function');
    assert.deepEqual(installs, ['9.9.9'], 'second call finds it installed');
    assert.match(seen[0], /^file:\/\/\/.*claude-agent-sdk\/sdk\.mjs$/);
    await assert.rejects(loadSdk({ version: '1.0.0 && calc', dir, install, importer }), /not a plain version number/);
    await assert.rejects(loadSdk({ version: '9.9.8', dir: join(fx.dir, 'sdk', '9.9.8'), install: () => {}, importer }), /is not 9\.9\.8/);
    assert.equal(DEFAULT_SDK_VERSION, '0.3.316');
  } finally { fx.cleanup(); }
});

// --- wiring in api-review.mjs -------------------------------------------------------------

test('chooseRunner / briefAsksForCommands: an explicit choice wins; the default goes to sdk when the brief asks for commands', () => {
  assert.equal(chooseRunner({ flag: 'sdk', option: 'fetch', brief: 'x' }), 'sdk');
  assert.equal(chooseRunner({ option: 'sdk', brief: 'x' }), 'sdk');
  assert.equal(chooseRunner({ option: 'fetch', brief: 'Run the tests and report' }), 'fetch');
  assert.equal(chooseRunner({ brief: 'Run the tests and report', fallback: 'fetch' }), 'sdk');
  assert.equal(chooseRunner({ brief: 'a plain review', fallback: 'fetch' }), 'fetch');
  assert.equal(chooseRunner({ brief: 'a plain review', fallback: 'sdk' }), 'sdk');
  assert.equal(DEFAULT_RUNNER, 'sdk', 'default chosen by measurement: the fixed overhead is under $0.02');
  assert.equal(chooseRunner({ brief: 'a plain review' }), 'sdk');
  assert.equal(briefAsksForCommands('the tests pass (api-* files)'), false);
  assert.equal(briefAsksForCommands('Please run the api tests with node --test'), true);
  assert.equal(briefAsksForCommands('execute the lint command'), true);
  assert.match(buildPrompt({ brief: 'b', diffRef: 'a..b', shell: true }), /Read, Grep, Glob, shell [(]Bash, and PowerShell on Windows[)], WebSearch and WebFetch tools can read it and run the tests/);
  assert.match(buildPrompt({ brief: 'b', diffRef: 'a..b' }), /you have no shell/);
});

function rig() {
  const fx = makeFixture();
  const repo = join(fx.dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => {
    const r = spawnSyncHidden('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'second');
  const brief = join(fx.dir, 'brief.txt');
  writeFileSync(brief, 'TYPE: bounded-feature\nthe lead brief, verbatim. Run the tests.\n');
  const go = async (extra, hooks) => {
    const lines = []; const errs = [];
    const code = await reviewMain(
      ['run', '--brief-file', brief, '--diff-ref', 'HEAD~1..HEAD', '--model', 'sonnet', '--cwd', repo, '--writer', 'sonnet/high', ...extra],
      { out: (s) => lines.push(s), err: (s) => errs.push(s), env: { AC_API_KEY: KEY }, cfg: CFG, sleep: async () => {}, ...hooks },
    );
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  return { fx, go };
}

test('api-review: --runner sdk runs the SDK engine, inlines the brief and the diff, and labels the path sdk', async () => {
  const t = rig();
  try {
    const sdk = fakeSdk([init(), assistant('m1', txt(`VERDICT: PASS${NL}ok`), { input_tokens: 100, output_tokens: 20 }, { stop: 'end_turn' }), result({ total_cost_usd: 0.001 })]);
    const r = await t.go(['--runner', 'sdk'], { sdk, fetchImpl: async () => { throw new Error('fetch must not run'); } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^VERDICT: PASS/);
    assert.match(r.out, /\(review path: API credits, sdk, claude-sonnet-5-5, 1 turn, \$0\.00\)$/);
    const p = sdk.calls[0].prompt;
    assert.match(p, /^TYPE: code-review\nWRITER: sonnet\/high\nROLE: reviewer/);
    assert.match(p, /the lead brief, verbatim/);
    assert.match(p, /\+two/);
    assert.match(p, /shell [(]Bash, and PowerShell on Windows[)].*run the tests/);
    assert.equal(sdk.calls[0].options.maxBudgetUsd, 1);
    const capped = fakeSdk([init(), assistant('m1', txt(`VERDICT: PASS${NL}ok`), { input_tokens: 1, output_tokens: 1 }), result()]);
    await t.go(['--runner', 'sdk', '--max-usd', '0.25'], { sdk: capped });
    assert.equal(capped.calls[0].options.maxBudgetUsd, 0.25);
  } finally { t.fx.cleanup(); }
});

test('api-review: an SDK that cannot be loaded falls back to the fetch engine; a brief that asks for commands picks sdk by default; --runner fetch beats it', async () => {
  const t = rig();
  try {
    const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `VERDICT: PASS${NL}via fetch` }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) });
    let loads = 0;
    const loadSdkStub = async () => { loads += 1; throw new Error('import failed'); };
    const fb = await t.go([], { loadSdk: loadSdkStub, fetchImpl }); // brief says "Run the tests." -> sdk -> falls back
    assert.equal(fb.code, 0, fb.out);
    assert.equal(loads, 1);
    assert.match(fb.err, /Agent SDK is not available: import failed; using the fetch engine/);
    assert.match(fb.out, /via fetch/);
    assert.match(fb.out, /\(review path: API credits, fetch,/);
    const forced = await t.go(['--runner', 'fetch'], { loadSdk: loadSdkStub, fetchImpl });
    assert.equal(loads, 1, '--runner fetch never touches the SDK');
    assert.match(forced.out, /\(review path: API credits, fetch,/);
    const bad = await t.go(['--runner', 'both'], {});
    assert.equal(bad.code, 2);
  } finally { t.fx.cleanup(); }
});

test('runApiSdk: a hung SDK that ignores the abort signal still ends at the deadline; tokens and cost follow modelUsage', async () => {
  const fx = makeFixture();
  try {
    const hung = fakeSdk(async function* () {
      yield init();
      yield assistant('m1', txt('thinking'), { input_tokens: 1000, output_tokens: 1 });
      await new Promise(() => {}); // never settles, ignores abortController
    });
    const r = await run(hung, { deadlineMs: 60 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /wall-clock deadline/);
    assert.ok(r.usd > 0, 'the one paid turn is still in the result');
    assert.ok(Math.abs(ledgerOf(fx).spent.review - r.usd) < 1e-9);

    // Streamed usage carries a placeholder output count; the result's modelUsage is the truth.
    const mu = { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 5000, cacheReadInputTokens: 2000, cacheCreationInputTokens: 3000, cacheCreationEphemeral1hInputTokens: 0, costUSD: 0 } };
    const ok = await run(fakeSdk([init(), assistant('m1', txt(`VERDICT: PASS${NL}x`), { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 }, { stop: 'end_turn' }), result({ modelUsage: mu, total_cost_usd: 0 })]));
    assert.equal(ok.ok, true);
    assert.equal(ok.tokens.output, 5000);
    assert.ok(Math.abs(ok.usd - sonnetUsd({ input: 1000, output: 5000, cacheRead: 2000, cacheWrite: 3000 })) < 1e-9);
  } finally { fx.cleanup(); }
});

test('runApiSdk: the child gets a private CLAUDE_CONFIG_DIR and the credential directories are denied to Read', async () => {
  const fx = makeFixture();
  try {
    const sdk = fakeSdk([init(), assistant('m1', txt(`VERDICT: PASS${NL}x`), { input_tokens: 1, output_tokens: 1 }, { stop: 'end_turn' }), result()]);
    await run(sdk, { env: { ...ENV, CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude' } });
    const o = sdk.calls[0].options;
    assert.match(o.env.CLAUDE_CONFIG_DIR, /sdk[\\/]config-/);
    assert.ok(o.env.CLAUDE_CONFIG_DIR.startsWith(fx.stateDir), 'under the (sandboxed) state dir, not the operator config');
    assert.ok(o.disallowedTools.includes('Read(~/.claude/**)') && o.disallowedTools.includes('Read(~/.ssh/**)'));
  } finally { fx.cleanup(); }
});
