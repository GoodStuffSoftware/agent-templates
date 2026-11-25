// Artifact watch alerts: hooks/artifact-watch.mjs (PostToolUse), hooks/artifact-watch-start.mjs (SessionStart),
// scripts/artifact-watch.mjs (CLI). Ids and urls are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, PLUGIN_ROOT, childEnv, realTmpdir } from './helpers.mjs';

const URL1 = 'https://claude.ai/artifact/TestArtifactAAAA1';
const URL2 = 'https://claude.ai/artifact/TestArtifactBBBB2';
const AT = 1795582347544;
const HOOK = 'hooks/artifact-watch.mjs';
const START = 'hooks/artifact-watch-start.mjs';

const post = (sid, response, tool = 'ArtifactComments', input = { action: 'watch' }) =>
  ({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: response });
const failed = (url = URL1, at = AT) => ({ watches: [], arms: [{ url, state: 'failed', reason: 'no_subscription_token', at }] });
const armed = (url = URL1, since = AT) => ({ watches: [{ url, task_id: 't', since, connected: true, token_expires_at: since + 1, auto_reply: 'armed', armed_via: 'session_resume' }], arms: [{ url, state: 'armed', at: since }] });
const notConnected = (url = URL1, since) => ({ watches: [{ url, task_id: 't', connected: false, ...(since ? { since } : {}) }] });
const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
const stateFile = (fx, sid) => join(fx.stateDir, 'state', 'artifact-watch', `${sid}.json`);

test('fixture failure gives one directive, a repeat gives none', () => {
  const fx = makeFixture();
  try {
    const a = runHook(HOOK, post('s1', failed()));
    assert.equal(a.status, 0);
    const t = ctx(a);
    assert.match(t, /PushNotification/);
    assert.match(t, /switch back to the account that owns the artifact/);
    assert.match(t, /even with editor access/);
    assert.doesNotMatch(t, /share-artifacts/);
    assert.match(t, /next reply/);
    assert.ok(t.includes(URL1) && t.includes('no_subscription_token'));
    const b = runHook(HOOK, post('s1', failed()));
    assert.equal(b.status, 0);
    assert.equal(b.stdout.trim(), '');
    const log = readFileSync(join(fx.stateDir, 'state', 'artifact-watch-alerts.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.ok(existsSync(stateFile(fx, 's1')));
  } finally { fx.cleanup(); }
});

test('failed then failed again with a new at: silent; another session alerts', () => {
  const fx = makeFixture();
  try {
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    assert.equal(runHook(HOOK, post('s1', failed(URL1, AT + 5000))).stdout.trim(), '');
    assert.ok(ctx(runHook(HOOK, post('s2', failed()))));
    assert.notEqual(stateFile(fx, 's1'), stateFile(fx, 's2'));
  } finally { fx.cleanup(); }
});

test('failed, then ok, then failed: re-alert', () => {
  const fx = makeFixture();
  try {
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    assert.equal(runHook(HOOK, post('s1', armed())).stdout.trim(), '');
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    assert.equal(runHook(HOOK, post('s1', failed())).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('connected:false with no since, and with a repeated since: one alert, then silent', () => {
  const fx = makeFixture();
  try {
    assert.match(ctx(runHook(HOOK, post('s1', notConnected(URL1)))), /watch not connected/);
    assert.equal(runHook(HOOK, post('s1', notConnected(URL1))).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', notConnected(URL1, AT))).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', notConnected(URL1, AT))).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', notConnected(URL1, AT + 9))).stdout.trim(), '');
    // a connected:true entry resets it
    assert.equal(runHook(HOOK, post('s1', armed())).stdout.trim(), '');
    assert.ok(ctx(runHook(HOOK, post('s1', notConnected(URL1, AT)))));
  } finally { fx.cleanup(); }
});

test('24 h reminder: one more alert after 24 h, then silent', () => {
  const fx = makeFixture();
  try {
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    const f = stateFile(fx, 's1');
    const age = (ms) => { const j = JSON.parse(readFileSync(f, 'utf8')); j.urls[URL1].alertedAt -= ms; writeFileSync(f, JSON.stringify(j)); };
    age(23 * 3600 * 1000);
    assert.equal(runHook(HOOK, post('s1', failed())).stdout.trim(), '');
    age(2 * 3600 * 1000);
    const r = ctx(runHook(HOOK, post('s1', failed())));
    assert.match(r, /reminder/);
    assert.equal(runHook(HOOK, post('s1', failed())).stdout.trim(), '');
    age(48 * 3600 * 1000);
    assert.equal(runHook(HOOK, post('s1', failed())).stdout.trim(), '', 'a single reminder per episode');
  } finally { fx.cleanup(); }
});

test('an armed-only listing is silent; only failure-like states alert; pending states do nothing', () => {
  const fx = makeFixture();
  try {
    assert.equal(runHook(HOOK, post('s1', armed())).stdout.trim(), '');
    for (const state of ['pending', 'arming', 'connecting', 'retrying', 'unknown']) {
      const r = runHook(HOOK, post('s1', { arms: [{ url: URL1, state, at: AT }] }));
      assert.equal(r.stdout.trim(), '', state);
    }
    for (const state of ['error', 'dropped', 'revoked', 'expired', 'denied', 'unauthorized']) {
      const sid = `s-${state}`;
      assert.ok(ctx(runHook(HOOK, post(sid, { arms: [{ url: URL1, state, at: AT }] }))), state);
    }
  } finally { fx.cleanup(); }
});

test('a pending state after ok stays ok; after failed stays failed (no new alert)', () => {
  const fx = makeFixture();
  try {
    assert.ok(ctx(runHook(HOOK, post('s1', failed()))));
    assert.equal(runHook(HOOK, post('s1', { arms: [{ url: URL1, state: 'pending', at: AT + 1 }] })).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', failed(URL1, AT + 2))).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('comment text never alerts; the Artifact publish line does only without structured fields', () => {
  const fx = makeFixture();
  try {
    const line = `- ${URL1} — NOT watching: the live subscription failed to arm at 2026-11-25T04:52:27.544Z — no_subscription_token.`;
    // ArtifactComments text and comment bodies: never
    const body = { comments: [{ id: 'c1', body: `my notes: NOT watching: the live subscription failed to arm at 2026-11-25T04:52:27.544Z, see ${URL1}` }] };
    assert.equal(runHook(HOOK, post('s1', body)).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', `not watching ${URL1} failed to arm`)).stdout.trim(), '');
    assert.equal(runHook(HOOK, post('s1', line)).stdout.trim(), '', 'ArtifactComments text form is not used');
    assert.equal(runHook(HOOK, post('s1', [{ type: 'text', text: 'someone wrote: not watching, failed to arm' }], 'Artifact', { title: 'T', url: URL2 })).stdout.trim(), '');
    // Artifact publish result: anchored client line, url from the result
    const pub = `Published ${URL2}\nNOT watching: the live subscription failed to arm at 2026-11-25T05:00:00.000Z — no_subscription_token`;
    const t = ctx(runHook(HOOK, post('s2', { content: [{ type: 'text', text: pub }] }, 'Artifact', { title: 'My Page', url: URL1 })));
    assert.ok(t && t.includes(URL2) && t.includes('My Page') && !t.includes(URL1));
    const t2 = ctx(runHook(HOOK, post('s3', line, 'Artifact', { title: 'P' })));
    assert.ok(t2 && t2.includes(URL1));
    // structured fields present: text ignored
    assert.equal(runHook(HOOK, post('s4', { arms: [{ url: URL2, state: 'armed', at: AT }], note: pub }, 'Artifact', { title: 'P' })).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('an armed Artifact publish result: no alert', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, post('s1', { content: [{ type: 'text', text: `Published ${URL1}\nWatching for comments.` }], arms: [{ url: URL1, state: 'armed', at: AT }] }, 'Artifact', { title: 'P' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const r2 = runHook(HOOK, post('s1', `Published ${URL1}\nWatching for comments.`, 'Artifact', { title: 'P' }));
    assert.equal(r2.stdout.trim(), '');
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

test('a corrupt state file: the directive still prints and the file is left unchanged', () => {
  const fx = makeFixture();
  try {
    const f = stateFile(fx, 's1');
    mkdirSync(join(fx.stateDir, 'state', 'artifact-watch'), { recursive: true });
    writeFileSync(f, '{"urls": {broken');
    const r = runHook(HOOK, post('s1', failed()));
    assert.match(ctx(r), /ARTIFACT WATCH FAILED/);
    assert.equal(readFileSync(f, 'utf8'), '{"urls": {broken');
    assert.deepEqual(readdirSync(join(fx.stateDir, 'state', 'artifact-watch')), ['s1.json'], 'no temp file left behind');
  } finally { fx.cleanup(); }
});

test('option off: silent in PostToolUse and SessionStart', () => {
  const fx = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_ARTIFACT_WATCH_ALERTS: 'false' };
    assert.equal(runHook(HOOK, post('s1', failed()), { env }).stdout.trim(), '');
    assert.ok(!existsSync(stateFile(fx, 's1')));
    runHook(HOOK, post('s2', armed())); // s2 holds a watch (recorded with the option on)
    assert.ok(ctx(runHook(START, { session_id: 's2', hook_event_name: 'SessionStart', source: 'resume' })));
    assert.equal(runHook(START, { session_id: 's2', hook_event_name: 'SessionStart', source: 'resume' }, { env }).stdout.trim(), '');
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

test('SessionStart: session metadata (incl. priorCliSessionIds) counts as holding watches, via a capped cached index', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, 'code-sessions', 'acct', 'org');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local_x.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: 'cli-9', priorCliSessionIds: ['cli-old'], title: 'My Session', publishedArtifacts: [{ url: URL1, title: 'Page One' }] }));
    const env = { AGENT_COMPANION_CODE_SESSIONS_DIR: join(fx.dir, 'code-sessions') };
    assert.ok(ctx(runHook(START, { session_id: 'cli-9', source: 'resume' }, { env })));
    assert.ok(ctx(runHook(START, { session_id: 'cli-old', source: 'resume' }, { env })));
    assert.ok(existsSync(join(fx.stateDir, 'state', 'artifact-watch-index.json')));
    // a second session start is served from the cache: delete the record, the cached index still answers
    rmSync(join(dir, 'local_x.json'));
    assert.ok(ctx(runHook(START, { session_id: 'cli-9', source: 'resume' }, { env })));
    const d = ctx(runHook(HOOK, post('cli-9', failed()), { env }));
    assert.ok(d.includes('My Session') && d.includes('Page One'));
  } finally { fx.cleanup(); }
});

test('CLI simulate prints the directive once, nothing the second time, and never touches real state; status and scan', () => {
  const fx = makeFixture();
  const simDir = join(realTmpdir(), `ac-sim-test-${process.pid}`);
  try {
    // childEnv points the child at the fixture's state dir; simulate must ignore it and use its own temp dir.
    const env = { ...childEnv({}), AGENT_COMPANION_ARTIFACT_WATCH_SIM_DIR: simDir };
    const cli = (...a) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'artifact-watch.mjs'), ...a], { encoding: 'utf8', env, cwd: fx.dir, windowsHide: true });
    const before = existsSync(join(fx.stateDir, 'state')) ? readdirSync(join(fx.stateDir, 'state'), { recursive: true }) : [];
    const a = cli('simulate', '--session', 'test-sim', '--reset');
    assert.match(a.stdout, /ARTIFACT WATCH FAILED/);
    assert.equal(cli('simulate', '--session', 'test-sim').stdout.trim(), '');
    const after = existsSync(join(fx.stateDir, 'state')) ? readdirSync(join(fx.stateDir, 'state'), { recursive: true }) : [];
    assert.deepEqual(after.filter((n) => /artifact-watch/.test(n)), before.filter((n) => /artifact-watch/.test(n)), 'real state dir unchanged');
    assert.ok(existsSync(join(simDir, 'state', 'artifact-watch', 'test-sim.json')), 'state went to the isolated dir');
    assert.equal(JSON.parse(cli('status', '--json').stdout).alertsSent, 0);
    // a simulated record left in a log is excluded from status
    mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'state', 'artifact-watch-alerts.jsonl'), `${JSON.stringify({ session: 'x', url: URL1, simulated: true })}\n${JSON.stringify({ session: 'y', url: URL1 })}\n`);
    assert.equal(JSON.parse(cli('status', '--json').stdout).alertsSent, 1);
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
  } finally { fx.cleanup(); try { rmSync(simDir, { recursive: true, force: true }); } catch { /* none */ } }
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
