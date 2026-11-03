// SDK reviewer user guards: scripts/lib/api-sdk-guards.mjs (the user's PreToolUse command hooks wrapped as SDK hook callbacks)
// and its wiring in runApiSdk. Real hook commands run (small node scripts); the SDK is a fake, so there is no live call and no install.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SHARES } from '../scripts/lib/api-credits.mjs';
import { makeFixture } from './helpers.mjs';
import {
  userConfigDir, hookName, parseIfRule, ifMatches, readUserPreToolUseHooks, mapHookResult, runHookCommand, buildUserGuards, DEFAULT_HOOK_TIMEOUT_S,
} from '../scripts/lib/api-sdk-guards.mjs';
import { runApiSdk, initMismatch, pluginIdentity, PLUGIN_ROOT, SDK_TOOLS } from '../scripts/lib/api-sdk-run.mjs';

const CFG = { budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:AC_API_KEY', reviewRatio: 0.5, itemEstimate: 2 };
const KEY = 'sk-ant-api03-SENTINEL-guards-do-not-leak-0123456789';
const NOW = Date.parse('2026-11-16T00:00:00Z');
const NL = '\n';
const fwd = (p) => String(p).replace(/\\/g, '/');
const tmp = () => mkdtempSync(join(tmpdir(), 'ac-guards-'));

// A user config dir holding settings.json with the given PreToolUse groups; returns the dir.
function userDir(groups, extra = {}) {
  const d = tmp();
  writeFileSync(join(d, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: groups, PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }] }, ...extra }));
  return d;
}
// A hook script (node) kept next to the settings; the hook command runs it by absolute path.
function script(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return `node "${fwd(p)}"`;
}
const readStdin = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);';
const forceGuard = `${readStdin}if(/git push.*--force/.test(i.tool_input.command||"")){process.stderr.write("force push needs a backup first");process.exit(2)}process.exit(0)});`;
const bashInput = (command, over = {}) => ({ session_id: 's', transcript_path: '', cwd: '/r', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't1', ...over });
const base = () => ({ ...process.env });

test('userConfigDir resolves CLAUDE_CONFIG_DIR, else ~/.claude', () => {
  assert.equal(fwd(userConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' }, '/h')).endsWith('/x/cfg'), true);
  assert.equal(fwd(userConfigDir({}, '/h')), '/h/.claude');
  assert.equal(fwd(userConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/h')), '/h/.claude');
});

test('readUserPreToolUseHooks: matcher and timeout kept; non-command, async, plugin-own and unsupported-if entries skipped; other events ignored', () => {
  const d = userDir([
    { matcher: 'Bash', hooks: [
      { type: 'command', command: 'node /u/guards/backup-guard.mjs', timeout: 7 },
      { type: 'command', command: 'node /u/guards/other.mjs' },
      { type: 'prompt', prompt: 'x' },
      { type: 'command', command: 'node /u/bg.mjs', async: true },
      { type: 'command', command: `node "${PLUGIN_ROOT}/hooks/own.mjs"` },
      { type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/own2.mjs' },
      { type: 'command', command: 'node /u/read-if.mjs', if: 'Read(secrets/**)' },
      { type: 'command', command: 'node /u/fail-closed.mjs', onFailure: 'block' },
      { type: 'command', command: 'node /u/gitonly.mjs', if: 'Bash(git push *)' },
    ] },
    { hooks: [{ type: 'command', command: 'bash /u/all-tools.sh' }] },
  ]);
  const r = readUserPreToolUseHooks({ configDir: d, pluginRoot: PLUGIN_ROOT });
  assert.deepEqual(r.hooks.map((h) => h.name), ['backup-guard.mjs', 'other.mjs', 'fail-closed.mjs', 'gitonly.mjs', 'all-tools.sh']);
  assert.equal(r.hooks[0].matcher, 'Bash');
  assert.equal(r.hooks[0].timeoutS, 7);
  assert.equal(r.hooks[1].timeoutS, DEFAULT_HOOK_TIMEOUT_S, 'Claude Code default when the hook has none');
  assert.equal(DEFAULT_HOOK_TIMEOUT_S, 600);
  assert.equal(r.hooks[2].blockOnFailure, true);
  assert.equal(r.hooks[4].matcher, undefined);
  assert.deepEqual(r.skipped, { plugin: 2, other: 3 });
  assert.equal(r.disabled, false);
});

test('readUserPreToolUseHooks: disableAllHooks, a missing or broken settings file and a missing hooks block yield nothing', () => {
  assert.equal(readUserPreToolUseHooks({ configDir: userDir([{ hooks: [{ type: 'command', command: 'x' }] }], { disableAllHooks: true }) }).disabled, true);
  assert.deepEqual(readUserPreToolUseHooks({ configDir: tmp() }).hooks, []);
  const d = tmp(); writeFileSync(join(d, 'settings.json'), '{ not json');
  assert.deepEqual(readUserPreToolUseHooks({ configDir: d }).hooks, []);
  const e = tmp(); writeFileSync(join(e, 'settings.json'), JSON.stringify({ model: 'x' }));
  assert.deepEqual(readUserPreToolUseHooks({ configDir: e }).hooks, []);
});

test('hookName: a secret-free basename; interpreters, flags and env assignments are skipped', () => {
  assert.equal(hookName('node "C:/Users/x/.claude/hooks/command-guard.mjs" --token=abc'), 'command-guard.mjs');
  assert.equal(hookName('FOO=bar bash -x /u/g.sh arg'), 'g.sh');
  assert.equal(hookName('   '), 'hook');
});

test('the if filter: Bash command rules (glob, legacy prefix, compound commands) and bare tool names', () => {
  const git = parseIfRule('Bash(git push *)');
  assert.equal(ifMatches(git, bashInput('git push --force origin x')), true);
  assert.equal(ifMatches(git, bashInput('git push')), true);
  assert.equal(ifMatches(git, bashInput('cd r && git push -f')), true);
  assert.equal(ifMatches(git, bashInput('git pushx')), false);
  assert.equal(ifMatches(git, bashInput('git status')), false);
  assert.equal(ifMatches(git, bashInput('x', { tool_name: 'Read' })), false);
  assert.equal(ifMatches(parseIfRule('Bash(npm:*)'), bashInput('npm test')), true);
  assert.equal(ifMatches(parseIfRule('Bash'), bashInput('anything')), true);
  assert.equal(parseIfRule('Read(a/**)'), null, 'file-path rules are not evaluated');
  assert.equal(parseIfRule('not a rule!!'), null);
  assert.equal(ifMatches(parseIfRule(undefined), bashInput('x')), true);
});

test('mapHookResult: exit 2 and a JSON deny block, with the reason; allow, other exit codes, plain text, timeout and error do not (onFailure block does)', () => {
  const h = { name: 'g.mjs', blockOnFailure: false };
  const r = (o) => ({ exit: 0, stdout: '', stderr: '', timedOut: false, error: null, ...o });
  assert.deepEqual(mapHookResult(h, r({ exit: 2, stderr: 'no force push\n' })), { deny: true, reason: 'no force push' });
  assert.equal(mapHookResult(h, r({ exit: 2 })).reason, 'blocked by user guard g.mjs');
  const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' } });
  assert.deepEqual(mapHookResult(h, r({ stdout: json })), { deny: true, reason: 'nope' });
  assert.deepEqual(mapHookResult(h, r({ stdout: JSON.stringify({ decision: 'block', reason: 'legacy' }) })), { deny: true, reason: 'legacy' });
  assert.equal(mapHookResult(h, r({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) })).deny, false);
  assert.equal(mapHookResult(h, r({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }) })).deny, false);
  assert.equal(mapHookResult(h, r({ exit: 1, stderr: 'boom' })).deny, false, 'a non-blocking error');
  assert.equal(mapHookResult(h, r({ stdout: 'deny everything' })).deny, false, 'plain text is no decision');
  assert.equal(mapHookResult(h, r({ stdout: '{ broken' })).deny, false);
  assert.equal(mapHookResult(h, r({ exit: null, timedOut: true })).deny, false, 'a timeout is fail-safe');
  assert.equal(mapHookResult(h, r({ exit: null, error: 'ENOENT' })).deny, false);
  const strict = { ...h, blockOnFailure: true };
  assert.equal(mapHookResult(strict, r({ exit: null, timedOut: true })).deny, true);
  assert.equal(mapHookResult(strict, r({ exit: 1 })).deny, true);
  assert.equal(mapHookResult(h, r({ exit: 2, stderr: `leaks ${KEY} here` }), KEY).reason.includes(KEY), false, 'the review key never reaches the model');
});

test('runHookCommand: stdin JSON, exit codes, the hook env (marker in, review key out) and the timeout', async () => {
  const d = tmp();
  const env = { ...base(), AC_REVIEWER_SESSION: '1' };
  const echoEnv = script(d, 'env.mjs', `${readStdin}process.stdout.write(JSON.stringify({m:process.env.AC_REVIEWER_SESSION,k:process.env.ANTHROPIC_API_KEY||null,t:i.tool_name,c:i.tool_input.command}));process.exit(0)});`);
  const ok = await runHookCommand({ command: echoEnv, args: null, timeoutS: 30 }, bashInput('git status'), { env, cwd: d });
  assert.equal(ok.exit, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { m: '1', k: null, t: 'Bash', c: 'git status' });
  const two = await runHookCommand({ command: script(d, 'two.mjs', forceGuard), args: null, timeoutS: 30 }, bashInput('git push --force origin x'), { env, cwd: d });
  assert.equal(two.exit, 2);
  assert.match(two.stderr, /backup first/);
  const slow = script(d, 'slow.mjs', 'setTimeout(()=>{},60000);process.stdin.resume();');
  const t0 = Date.now();
  const timed = await runHookCommand({ command: slow, args: null, timeoutS: 0.3 }, bashInput('x'), { env, cwd: d });
  assert.equal(timed.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, 'the timeout ends the wait');
  const bad = await runHookCommand({ command: 'node', args: ['--no-such-flag-xyz'], timeoutS: 30 }, bashInput('x'), { env, cwd: d });
  assert.notEqual(bad.exit, 0);
});

test('buildUserGuards: one SDK matcher per command hook, the matcher passed through; nothing to wrap gives null; logs only counts and basenames', () => {
  const d = userDir([{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node /u/secret-token-abc/guard.mjs --key=sk-ant-xyz', timeout: 9 }] }]);
  const g = buildUserGuards({ configDir: d, childEnv: {}, cwd: '/r', pluginRoot: PLUGIN_ROOT });
  assert.equal(g.hooks.PreToolUse.length, 1);
  assert.equal(g.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  assert.equal(typeof g.hooks.PreToolUse[0].hooks[0], 'function');
  assert.deepEqual(Object.keys(g.hooks), ['PreToolUse'], 'PreToolUse only');
  assert.deepEqual(g.summary, { wrapped: 1, names: ['guard.mjs'], skippedPlugin: 0, skippedOther: 0, disabled: false });
  assert.ok(!JSON.stringify(g.summary).includes('sk-ant-xyz') && !JSON.stringify(g.summary).includes('secret-token'));
  assert.equal(buildUserGuards({ configDir: tmp() }).hooks, null);
});

// A fake SDK that behaves like the real one where it matters here: it calls the PreToolUse callbacks of the matchers that match a tool call.
function sdkThatCallsBash(command, seen) {
  const calls = [];
  return {
    calls,
    query(args) {
      calls.push(args);
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', tools: SDK_TOOLS, plugins: [{ name: 'agent-companion', version: '1', source: 'agent-companion@inline' }], mcp_servers: [] };
        const out = [];
        for (const m of (args.options.hooks && args.options.hooks.PreToolUse) || []) {
          if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test('Bash')) continue;
          for (const cb of m.hooks) out.push(await cb(bashInput(command), 't1', { signal: new AbortController().signal }));
        }
        seen.push(out);
        yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: `VERDICT: PASS${NL}ok` }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn' } };
        yield { type: 'result', subtype: 'success', is_error: false, result: `VERDICT: PASS${NL}ok`, stop_reason: 'end_turn', total_cost_usd: 0, errors: [] };
      })();
      const it = gen[Symbol.asyncIterator]();
      return { [Symbol.asyncIterator]() { return this; }, next: () => it.next(), return: async () => { await it.return(); return { done: true, value: undefined }; } };
    },
  };
}

test('runApiSdk: the user guard denies git push --force in the SDK session; git status is allowed; init still shows only our plugin and no MCP', async () => {
  const fx = makeFixture();
  try {
    const d = tmp();
    const guard = script(d, 'backup-guard.mjs', forceGuard);
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: guard, timeout: 20 }] }] }, enabledPlugins: { 'x@y': true }, mcpServers: { s: {} } }));
    const env = { ...base(), AC_API_KEY: KEY };
    const go = async (command) => {
      const seen = [];
      const sdk = sdkThatCallsBash(command, seen);
      const r = await runApiSdk({ prompt: 'p', model: 'sonnet', cwd: process.cwd(), cfg: CFG, env, now: NOW, requireVerdict: true, sdk, userConfigDir: d });
      return { r, seen: seen[0], o: sdk.calls[0].options };
    };
    const deny = await go('git push --force origin main');
    assert.equal(deny.r.ok, true, deny.r.reason);
    assert.deepEqual(deny.seen, [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'force push needs a backup first' } }]);
    assert.deepEqual(deny.r.userGuards, { wrapped: 1, names: ['backup-guard.mjs'], skippedPlugin: 0, skippedOther: 0, disabled: false });
    assert.equal(deny.o.hooks.PreToolUse.length, 1);
    const allow = await go('git status');
    assert.deepEqual(allow.seen, [{}]);
    // Nothing else from the user settings is loaded.
    assert.deepEqual(deny.o.settingSources, ['project']);
    assert.deepEqual(deny.o.skills, []);
    assert.deepEqual(deny.o.mcpServers, {});
    assert.equal(deny.o.strictMcpConfig, true);
    assert.equal(deny.o.plugins.length, 1);
    assert.equal(deny.o.plugins[0].path, PLUGIN_ROOT);
    assert.equal(initMismatch(deny.r.init, pluginIdentity()), null);
    assert.ok(!JSON.stringify(deny.o).includes('"enabledPlugins"'));
    assert.ok(!JSON.stringify(deny.r).includes(KEY));
  } finally { fx.cleanup(); }
});

test('runApiSdk: userGuards false (api_review_user_guards off) registers no hooks and reads no user settings', async () => {
  const fx = makeFixture();
  try {
    const d = userDir([{ matcher: 'Bash', hooks: [{ type: 'command', command: script(tmp(), 'g.mjs', forceGuard) }] }]);
    const seen = [];
    const sdk = sdkThatCallsBash('git push --force x', seen);
    const r = await runApiSdk({ prompt: 'p', model: 'sonnet', cwd: process.cwd(), cfg: CFG, env: { ...base(), AC_API_KEY: KEY }, now: NOW, requireVerdict: true, sdk, userConfigDir: d, userGuards: false });
    assert.equal(r.ok, true, r.reason);
    assert.equal('hooks' in sdk.calls[0].options, false);
    assert.deepEqual(seen[0], []);
    assert.equal(r.userGuards, null);
  } finally { fx.cleanup(); }
});

test('runApiSdk: a hook that times out does not block the review (fail-safe) and one that exits 2 does', async () => {
  const fx = makeFixture();
  try {
    const d = tmp();
    const slow = script(d, 'slow.mjs', 'process.stdin.resume();setTimeout(()=>{},60000);');
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: slow, timeout: 0.3 },
      { type: 'command', command: script(d, 'g.mjs', forceGuard) },
    ] }] } }));
    const seen = [];
    const sdk = sdkThatCallsBash('git push --force x', seen);
    const r = await runApiSdk({ prompt: 'p', model: 'sonnet', cwd: process.cwd(), cfg: CFG, env: { ...base(), AC_API_KEY: KEY }, now: NOW, requireVerdict: true, sdk, userConfigDir: d });
    assert.equal(r.ok, true, r.reason);
    assert.equal(seen[0].length, 2);
    assert.deepEqual(seen[0][0], {}, 'the timed-out hook allows');
    assert.equal(seen[0][1].hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});
