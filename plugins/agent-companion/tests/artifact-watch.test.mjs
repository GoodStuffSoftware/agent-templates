// Artifact watch alerts: hooks/artifact-watch.mjs (PostToolUse), hooks/artifact-watch-start.mjs (SessionStart),
// scripts/artifact-watch.mjs (CLI). Ids and urls are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, PLUGIN_ROOT, childEnv } from './helpers.mjs';

const URL1 = 'https://claude.ai/artifact/TestArtifactAAAA1';
const URL2 = 'https://claude.ai/artifact/TestArtifactBBBB2';
const AT = 1795582347544;
const HOOK = 'hooks/artifact-watch.mjs';
const START = 'hooks/artifact-watch-start.mjs';

const post = (sid, response, tool = 'ArtifactComments', input = { action: 'watch' }) =>
  ({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: response });
const failed = (url = URL1, at = AT) => ({ watches: [], arms: [{ url, state: 'failed', reason: 'no_subscription_token', at }] });
const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

test('fixture failure gives one directive, a repeat gives none', () => {
  const fx = makeFixture();
  try {
    const a = runHook(HOOK, post('s1', failed()));
    assert.equal(a.status, 0);
    const t = ctx(a);
    assert.match(t, /PushNotification/);
    assert.match(t, /session-sync:share-artifacts/);
    assert.match(t, /next reply/);
    assert.ok(t.includes(URL1) && t.includes('no_subscription_token'));
    const b = runHook(HOOK, post('s1', failed()));
    assert.equal(b.status, 0);
    assert.equal(b.stdout.trim(), '');
    const log = readFileSync(join(fx.stateDir, 'state', 'artifact-watch-alerts.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
  } finally { fx.cleanup(); }
});

test('a new at for the same url alerts again; another session alerts too', () => {
  const fx = makeFixture();
  try {
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    assert.ok(ctx(runHook(HOOK, post('s1', failed(URL1, AT + 5000)))));
    assert.ok(ctx(runHook(HOOK, post('s2', failed()))));
  } finally { fx.cleanup(); }
});

test('an armed-only listing is silent; connected false is a failure', () => {
  const fx = makeFixture();
  try {
    const armed = { watches: [{ url: URL1, task_id: 't', since: AT, connected: true, token_expires_at: AT + 1, auto_reply: 'armed', armed_via: 'session_resume' }], arms: [{ url: URL1, state: 'armed', at: AT }] };
    const r = runHook(HOOK, post('s1', armed));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const dropped = { watches: [{ ...armed.watches[0], connected: false }] };
    assert.match(ctx(runHook(HOOK, post('s1', dropped))), /watch not connected/);
  } finally { fx.cleanup(); }
});

test('text-form results are detected (string, content blocks, Artifact publish line)', () => {
  const fx = makeFixture();
  try {
    const line = `- ${URL1} — NOT watching: the live subscription failed to arm at 2026-11-25T04:52:27.544Z — the control plane minted no live-channel credential. Share it.`;
    const t1 = ctx(runHook(HOOK, post('s1', `No artifact watch is connected; 1 artifact:\n${line}`)));
    assert.ok(t1 && t1.includes(URL1) && t1.includes('control plane minted no live-channel credential'));
    const t2 = ctx(runHook(HOOK, post('s2', [{ type: 'text', text: line }])));
    assert.ok(t2);
    const pub = `Published ${URL2}\nNOT watching: the live subscription failed to arm at 2026-11-25T05:00:00.000Z — no_subscription_token`;
    const t3 = ctx(runHook(HOOK, post('s3', { content: [{ type: 'text', text: pub }] }, 'Artifact', { title: 'My Page' })));
    assert.ok(t3 && t3.includes(URL2) && t3.includes('My Page'));
  } finally { fx.cleanup(); }
});

test('malformed payloads exit 0 silently', () => {
  const fx = makeFixture();
  try {
    for (const payload of [undefined, {}, { session_id: 's', tool_name: 'ArtifactComments' }, post('s', 42), post('s', { arms: 'x', watches: [null, 3] }), post('s', null)]) {
      const r = runHook(HOOK, payload);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    }
    const raw = spawnSync(process.execPath, [join(PLUGIN_ROOT, HOOK)], { input: '{not json', encoding: 'utf8', env: childEnv({}), windowsHide: true });
    assert.equal(raw.status, 0);
    assert.equal(raw.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('option off: silent', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, post('s1', failed()), { env: { CLAUDE_PLUGIN_OPTION_ARTIFACT_WATCH_ALERTS: 'false' } });
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('SessionStart: silent without watches, one line with recorded watches, only on resume or compact', () => {
  const fx = makeFixture();
  try {
    const start = (sid, source) => runHook(START, { session_id: sid, hook_event_name: 'SessionStart', source });
    assert.equal(start('s1', 'resume').stdout.trim(), '');
    runHook(HOOK, post('s1', { watches: [{ url: URL1, connected: true, since: AT }] })); // records s1 holds a watch
    const r = start('s1', 'resume');
    assert.match(ctx(r), /ArtifactComments/);
    assert.ok(ctx(r).includes('{"action":"watch"}'));
    assert.ok(ctx(start('s1', 'compact')));
    assert.equal(start('s1', 'startup').stdout.trim(), '');
    assert.equal(start('s2', 'resume').stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('SessionStart: session metadata with publishedArtifacts counts as holding watches', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, 'code-sessions', 'acct', 'org');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local_x.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: 'cli-9', title: 'My Session', publishedArtifacts: [{ url: URL1, title: 'Page One' }] }));
    const env = { AGENT_COMPANION_CODE_SESSIONS_DIR: join(fx.dir, 'code-sessions') };
    const r = runHook(START, { session_id: 'cli-9', source: 'resume' }, { env });
    assert.ok(ctx(r));
    const d = ctx(runHook(HOOK, post('cli-9', failed()), { env }));
    assert.ok(d.includes('My Session') && d.includes('Page One'));
  } finally { fx.cleanup(); }
});

test('CLI simulate prints the directive once, nothing the second time; status and scan', () => {
  const fx = makeFixture();
  try {
    const cli = (...a) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'artifact-watch.mjs'), ...a], { encoding: 'utf8', env: childEnv({}), cwd: fx.dir, windowsHide: true });
    const a = cli('simulate', '--session', 'test-sim');
    assert.match(a.stdout, /ARTIFACT WATCH FAILED/);
    assert.equal(cli('simulate', '--session', 'test-sim').stdout.trim(), '');
    const st = JSON.parse(cli('status', '--json').stdout);
    assert.equal(st.alertsSent, 1);
    assert.equal(st.dedupeKeys, 1);
    // scan: a transcript tail with an unalerted failure
    const proj = join(fx.dir, '.claude', 'projects', 'p');
    mkdirSync(proj, { recursive: true });
    const row = { type: 'user', sessionId: 'sess-a', toolUseResult: failed(URL2, AT + 1) };
    writeFileSync(join(proj, 'sess-a.jsonl'), `${JSON.stringify({ type: 'x' })}\n${JSON.stringify(row)}\n`);
    const sc = JSON.parse(cli('scan', '--json').stdout);
    assert.equal(sc.length, 1);
    assert.equal(sc[0].failures[0].url, URL2);
    runHook(HOOK, post('sess-a', failed(URL2, AT + 1)));
    assert.equal(JSON.parse(cli('scan', '--json').stdout).length, 0);
  } finally { fx.cleanup(); }
});

test('hooks are registered and the option defaults on', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const has = (ev, re, file) => hooks[ev].some((g) => re.test(g.matcher || '') && g.hooks.some((h) => h.args.join(' ').includes(file)));
  assert.ok(has('PostToolUse', /ArtifactComments/, 'artifact-watch.mjs'));
  assert.ok(has('SessionStart', /resume/, 'artifact-watch-start.mjs'));
  const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.userConfig.artifact_watch_alerts.default, true);
  assert.ok(existsSync(join(PLUGIN_ROOT, 'hooks', 'artifact-watch.mjs')));
});
