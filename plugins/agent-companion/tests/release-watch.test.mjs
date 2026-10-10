// The scout's Claude Code release watch (scripts/lib/release-watch.mjs), its
// SessionStart line (hooks/scout-surface.mjs) and the scout_suppress option.
// Fixture versions are 9.x so they sit above whatever `claude --version` says on
// the machine running the suite. The network is never touched: the suite sets
// AGENT_COMPANION_RELEASE_WATCH_NO_NET, and these tests that need a response
// start a server on the loopback interface and clear it.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, runHook, runScript, childEnv, PLUGIN_ROOT } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import {
  topicsOf, parseChangelog, newerMatching, checkDue, fetchChangelogHead, CHECK_INTERVAL_MS,
} from '../scripts/lib/release-watch.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## 9.0.3',
  '',
  '- Added `effort` to the Agent tool for a per-spawn setting',
  '- Fixed a terminal rendering glitch in the status bar',
  '',
  '## 9.0.2',
  '',
  '- Fixed subagent auto-compact window being ignored',
  '- Improved Monitor output for long-running commands',
  '- Fixed monitoring dashboards flickering',
  '',
  '## 9.0.1',
  '',
  '- Fixed an old hooks problem',
  '',
].join('\n');

function serve(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const srv = createServer((req, res) => { hits.push({ url: req.url, range: req.headers.range }); handler(req, res, hits); });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/CHANGELOG.md`,
      hits,
      close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
    }));
  });
}

function okServer(body = CHANGELOG) {
  return serve((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); });
}

// spawnSync would block the loopback server living in this process.
function runDetect({ cwd, env = {}, timeout = 20000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'detect.mjs')], {
      cwd, env: childEnv(env), windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out); } catch { /* leave null */ }
      resolve({ status, json, stderr: err });
    });
  });
}

const WATCH_ENV = (url, extra = {}) => ({
  AGENT_COMPANION_RELEASE_WATCH_NO_NET: '',
  AGENT_COMPANION_RELEASE_WATCH_URL: url,
  AGENT_COMPANION_RELEASE_WATCH_INSTALLED: '9.0.1',
  ...extra,
});

const releaseSig = (res) => (res.json?.signals || []).find((s) => s.kind === 'cli_release_available');

// ---------------------------------------------------------------------------
// keyword extraction
// ---------------------------------------------------------------------------

test('topicsOf: every topic the brief names matches, and unrelated text does not', () => {
  const cases = [
    ['Added a subagent frontmatter field', 'agents'],
    ['Fixed the Agent tool hanging', 'agents'],
    ['Fixed a SessionStart hook not firing', 'hooks'],
    ['Fixed prompt cache misses after resume', 'cache'],
    ['Fixed auto-compaction running twice', 'compaction'],
    ['Added effort levels', 'effort'],
    ['Fixed SendMessage to a stopped agent', 'SendMessage'],
    ['Fixed worktree cleanup', 'worktree'],
    ['Fixed dynamic workflows', 'workflow'],
    ['Added the Monitor tool', 'Monitor'],
    ['Fixed the desktop app crashing', 'desktop'],
    ['Fixed plugin validate output', 'plugins'],
  ];
  for (const [text, topic] of cases) assert.ok(topicsOf(text).includes(topic), `${text} -> ${topic}; got ${topicsOf(text)}`);
  assert.deepEqual(topicsOf('Fixed a terminal rendering glitch in the status bar'), []);
  assert.deepEqual(topicsOf('Fixed monitoring dashboards flickering'), [], 'lower-case monitoring is not the Monitor tool');
});

test('parseChangelog + newerMatching: only releases newer than installed, only matching items, newest first', () => {
  const releases = parseChangelog(CHANGELOG);
  assert.deepEqual(releases.map((r) => r.version), ['9.0.3', '9.0.2', '9.0.1']);
  const newer = newerMatching(releases, '9.0.1');
  assert.deepEqual(newer.map((r) => r.version), ['9.0.3', '9.0.2']);
  assert.equal(newer[0].items.length, 1, 'the rendering item is dropped');
  assert.equal(newer[1].items.length, 2, 'subagent + Monitor kept, monitoring dropped');
  assert.deepEqual(newer[0].items[0].topics.sort(), ['agents', 'effort']);
});

test('parseChangelog joins an indented continuation line to its bullet', () => {
  const r = parseChangelog('## 9.1.0\n- Fixed a hook that\n  also touched the cache\n- Other\n');
  assert.equal(r[0].items.length, 2);
  assert.match(r[0].items[0], /hook that also touched the cache/);
});

// ---------------------------------------------------------------------------
// throttle
// ---------------------------------------------------------------------------

test('checkDue: due with no state, not due inside 24 h, due after, due when the clock moved back', () => {
  const t0 = Date.parse('2026-10-09T00:00:00Z');
  assert.equal(checkDue({}, t0), true);
  assert.equal(checkDue({ lastAttemptAt: new Date(t0).toISOString() }, t0 + CHECK_INTERVAL_MS - 1), false);
  assert.equal(checkDue({ lastAttemptAt: new Date(t0).toISOString() }, t0 + CHECK_INTERVAL_MS), true);
  assert.equal(checkDue({ lastAttemptAt: new Date(t0 + 5000).toISOString() }, t0), true);
});

test('the scout asks the host once per 24 hours: a second run inside the window makes no request, the signal persists', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    const env = WATCH_ENV(srv.url, { AGENT_COMPANION_FAKE_NOW: '2026-10-09T00:00:00.000Z' });
    const a = await runDetect({ cwd: dir, env });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(srv.hits.length, 1);
    assert.match(srv.hits[0].range, /^bytes=0-/, 'asks for the head of the file only');
    const sig = releaseSig(a);
    assert.ok(sig, JSON.stringify(a.json?.signals));
    assert.match(sig.detail, /9\.0\.3 is out; installed 9\.0\.1/);
    assert.match(sig.detail, /2 unseen release\(s\)/);
    assert.match(sig.detail, /3 changelog item\(s\)/);

    const b = await runDetect({ cwd: dir, env: { ...env, AGENT_COMPANION_FAKE_NOW: '2026-10-09T23:00:00.000Z' } });
    assert.equal(srv.hits.length, 1, 'inside the window: no second request');
    assert.ok(releaseSig(b), 'the unseen release still shows from the stored result');

    const c = await runDetect({ cwd: dir, env: { ...env, AGENT_COMPANION_FAKE_NOW: '2026-10-10T00:00:01.000Z' } });
    assert.equal(srv.hits.length, 2, 'past 24 h: asks again');
    assert.ok(releaseSig(c));
  } finally { await srv.close(); cleanup(); }
});

// ---------------------------------------------------------------------------
// offline, failure, details file
// ---------------------------------------------------------------------------

test('offline (nothing listening): silent, exit 0, no signal, the attempt is recorded so it is not retried for 24 h', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  const deadUrl = srv.url;
  await srv.close(); // the port now refuses connections
  try {
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(deadUrl) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(releaseSig(res), undefined);
    assert.doesNotMatch(res.stderr, /release|fetch/i);
    const st = JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8'));
    assert.equal(st.lastOk, false);
    assert.ok(st.lastAttemptAt);
    assert.equal(existsSync(stateFile('cli-release-details.md')), false);
  } finally { cleanup(); }
});

test('an HTTP error is a silent failure too', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await serve((req, res) => { res.writeHead(503); res.end('no'); });
  try {
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(releaseSig(res), undefined);
    assert.equal(JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8')).lastReason, 'http 503');
  } finally { await srv.close(); cleanup(); }
});

test('a host that never answers is cut off at the 3 s budget (fetchChangelogHead)', async () => {
  const srv = await serve(() => { /* never respond */ });
  try {
    const t0 = Date.now();
    const r = await fetchChangelogHead({ url: srv.url, timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  } finally { await srv.close(); }
});

test('a server that ignores Range and streams a huge body is cut at maxBytes', async () => {
  const big = `## 9.9.9\n- Fixed hooks\n${'x'.repeat(5000)}\n## 9.9.8\n- Fixed agents\n${'y'.repeat(200000)}`;
  const srv = await okServer(big);
  try {
    const r = await fetchChangelogHead({ url: srv.url, maxBytes: 20000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < 21000);
    assert.doesNotMatch(r.text, /9\.9\.8/, 'the cut-off last block is dropped');
  } finally { await srv.close(); }
});

test('details file: lists every newer release, marks the unseen ones, names the topics', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    assert.equal(res.status, 0, res.stderr);
    const md = readFileSync(stateFile('cli-release-details.md'), 'utf8');
    assert.match(md, /# Claude Code releases newer than 9\.0\.1/);
    assert.match(md, /## 9\.0\.3 \(NEW\)/);
    assert.match(md, /## 9\.0\.2 \(NEW\)/);
    assert.match(md, /\[agents, effort\] Added `effort` to the Agent tool/);
    assert.match(md, /Monitor output/);
    assert.doesNotMatch(md, /rendering glitch/);
    assert.doesNotMatch(md, /monitoring dashboards/);
    assert.doesNotMatch(md, /## 9\.0\.1/);
  } finally { await srv.close(); cleanup(); }
});

test('the local changelog cache backs up a failed fetch', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  const dead = srv.url;
  await srv.close();
  try {
    const cache = join(dir, '.claude', 'cache', 'changelog.md');
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, CHANGELOG);
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(dead) });
    assert.equal(res.status, 0, res.stderr);
    const sig = releaseSig(res);
    assert.ok(sig, 'the cached changelog already names newer releases');
    assert.equal(JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8')).source, 'local-cache');
  } finally { cleanup(); }
});

test('release_watch off: no request, no signal', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(srv.url, { CLAUDE_PLUGIN_OPTION_RELEASE_WATCH: 'false' }) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(srv.hits.length, 0);
    assert.equal(releaseSig(res), undefined);
  } finally { await srv.close(); cleanup(); }
});

// ---------------------------------------------------------------------------
// the SessionStart line and the seen-set
// ---------------------------------------------------------------------------

const hookCtx = (res) => res.json?.hookSpecificOutput?.additionalContext || '';

test('main session: one line with versions, item count and details path; the next start is silent (seen-set)', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    const first = runHook('hooks/scout-surface.mjs', { session_id: 's-main-1', cwd: dir }, { cwd: dir });
    assert.equal(first.status, 0, first.stderr);
    const ctx = hookCtx(first);
    assert.match(ctx, /Claude Code 9\.0\.3 is out \(installed 9\.0\.1\)/);
    assert.match(ctx, /2 new release\(s\) \(9\.0\.2 to 9\.0\.3\)/);
    assert.match(ctx, /3 changelog item\(s\)/);
    assert.ok(ctx.includes(stateFile('cli-release-details.md')), ctx);
    assert.equal(ctx.split('\n').filter((l) => l.includes('Claude Code 9.0.3')).length, 1, 'exactly one line');
    // The generic scout block does not repeat the release signal.
    assert.doesNotMatch(ctx, /cli_release_available/);

    const second = runHook('hooks/scout-surface.mjs', { session_id: 's-main-2', cwd: dir }, { cwd: dir });
    assert.doesNotMatch(hookCtx(second), /Claude Code 9\.0\.3/, 'surfaced once');
    assert.doesNotMatch(hookCtx(second), /cli_release_available/);
    assert.deepEqual(JSON.parse(readFileSync(stateFile('release-watch.json'), 'utf8')).seen.sort(), ['9.0.2', '9.0.3']);
  } finally { await srv.close(); cleanup(); }
});

test('subagent session: gets nothing and does not use up the line', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    const sub = runHook('hooks/scout-surface.mjs', { session_id: 's-sub', agent_id: 'agent-abc', cwd: dir }, { cwd: dir });
    assert.equal(sub.status, 0, sub.stderr);
    assert.equal(sub.stdout.trim(), '', 'no output at all');
    const viaPath = runHook('hooks/scout-surface.mjs', {
      session_id: 's-sub2', cwd: dir, transcript_path: join(dir, 'p', 's', 'subagents', 'agent-x.jsonl'),
    }, { cwd: dir });
    assert.equal(viaPath.stdout.trim(), '');
    const main = runHook('hooks/scout-surface.mjs', { session_id: 's-main', cwd: dir }, { cwd: dir });
    assert.match(hookCtx(main), /Claude Code 9\.0\.3 is out/, 'the main session still gets it afterwards');
  } finally { await srv.close(); cleanup(); }
});

test('seen releases leave the scout signal; a later release surfaces alone', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    const env = WATCH_ENV(srv.url, { AGENT_COMPANION_FAKE_NOW: '2026-10-09T00:00:00.000Z' });
    await runDetect({ cwd: dir, env });
    runHook('hooks/scout-surface.mjs', { session_id: 's1', cwd: dir }, { cwd: dir });

    const quiet = await runDetect({ cwd: dir, env: { ...env, AGENT_COMPANION_FAKE_NOW: '2026-10-09T01:00:00.000Z' } });
    assert.equal(releaseSig(quiet), undefined, 'seen: the scout stops reporting it');

    // A new release lands upstream; the next daily check finds it.
    const srv2 = await okServer(`## 9.0.4\n\n- Fixed hooks firing twice\n\n${CHANGELOG.replace('# Changelog\n', '')}`);
    try {
      const later = await runDetect({ cwd: dir, env: WATCH_ENV(srv2.url, { AGENT_COMPANION_FAKE_NOW: '2026-10-11T00:00:00.000Z' }) });
      const sig = releaseSig(later);
      assert.ok(sig, JSON.stringify(later.json?.signals));
      assert.match(sig.detail, /9\.0\.4 is out/);
      assert.match(sig.detail, /1 unseen release\(s\)/);
      assert.match(sig.detail, /1 changelog item\(s\)/);
      const hook = runHook('hooks/scout-surface.mjs', { session_id: 's2', cwd: dir }, { cwd: dir });
      assert.match(hookCtx(hook), /1 new release\(s\) \(9\.0\.4\)/);
    } finally { await srv2.close(); }
  } finally { await srv.close(); cleanup(); }
});

test('a machine that has caught up gets no line', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    // The scout last saw 9.0.3 installed.
    writeFileSync(stateFile('baseline.json'), JSON.stringify({ version: '9.0.3 (Claude Code)' }));
    const hook = runHook('hooks/scout-surface.mjs', { session_id: 's-up', cwd: dir }, { cwd: dir });
    assert.doesNotMatch(hookCtx(hook), /Claude Code 9\.0\.3 is out/);
  } finally { await srv.close(); cleanup(); }
});

test('release_watch off silences the line', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    const hook = runHook('hooks/scout-surface.mjs', { session_id: 's-off', cwd: dir }, {
      cwd: dir, env: { CLAUDE_PLUGIN_OPTION_RELEASE_WATCH: 'false' },
    });
    assert.doesNotMatch(hookCtx(hook), /Claude Code 9\.0\.3/);
  } finally { await srv.close(); cleanup(); }
});

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

// routing_trial_review_due fires model_benchmark_suggested alongside it
// (tests/model-benchmark-suggestion.test.mjs).
const TRIAL_NOW = { AGENT_COMPANION_FAKE_NOW: '2026-10-01T00:00:00.000Z' };

test('scout_suppress (env): the suppressed kind is neither emitted nor counted; the others are untouched', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const plain = runScript('scripts/detect.mjs', [], { cwd: dir, env: TRIAL_NOW });
    assert.equal(plain.status, 0, plain.stderr);
    const nBench = plain.json.signals.filter((s) => s.kind === 'model_benchmark_suggested').length;
    assert.ok(nBench > 0, 'precondition: the signal fires without the option');

    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir, env: { ...TRIAL_NOW, CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'model_benchmark_suggested' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.filter((s) => s.kind === 'model_benchmark_suggested').length, 0);
    assert.equal(res.json.signals.length, plain.json.signals.length - nBench, 'not counted either');
    assert.ok(res.json.signals.some((s) => s.kind === 'routing_trial_review_due'), 'the cause signal stays');
    const latest = JSON.parse(readFileSync(stateFile('scout-latest.json'), 'utf8'));
    assert.equal(latest.signals.length, res.json.signals.length);
  } finally { cleanup(); }
});

test('scout_suppress through settings.json (the plugin config layer), with a reason, and a list', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, '.claude', 'settings.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      pluginConfigs: {
        'agent-companion@agent-templates': {
          options: {
            scout_suppress: 'model_benchmark_suggested, spawn_activity',
            scout_suppress_reason: 'no benchmark runs on this machine (operator rule)',
          },
        },
      },
    }));
    const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: TRIAL_NOW });
    assert.equal(res.status, 0, res.stderr);
    const kinds = res.json.signals.map((s) => s.kind);
    assert.ok(!kinds.includes('model_benchmark_suggested'));
    assert.ok(kinds.includes('routing_trial_review_due'));
  } finally { cleanup(); }
});

test('suppressing cli_release_available stops the request, the signal and the line', async () => {
  const { dir, cleanup } = makeFixture();
  const srv = await okServer();
  try {
    const res = await runDetect({ cwd: dir, env: WATCH_ENV(srv.url, { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'cli_release_available' }) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(srv.hits.length, 0);
    assert.equal(releaseSig(res), undefined);
    const ok = await runDetect({ cwd: dir, env: WATCH_ENV(srv.url) });
    assert.ok(releaseSig(ok));
    const hook = runHook('hooks/scout-surface.mjs', { session_id: 's-sup', cwd: dir }, {
      cwd: dir, env: { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'cli_release_available' },
    });
    assert.doesNotMatch(hookCtx(hook), /Claude Code 9\.0\.3/);
  } finally { await srv.close(); cleanup(); }
});

test('the SessionStart block drops a suppressed kind already sitting in scout-latest.json, and its count', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = stateFile('scout-latest.json');
    mkdirSync(dirname(f), { recursive: true });
    const kinds = ['model_benchmark_suggested', 'model_benchmark_suggested', 'spawn_activity'];
    writeFileSync(f, JSON.stringify({ checkedAt: new Date().toISOString(), signals: kinds.map((kind) => ({ kind, detail: 'd' })) }));
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-filter', cwd: dir }, {
      cwd: dir, env: { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'model_benchmark_suggested' },
    });
    const ctx = hookCtx(res);
    assert.match(ctx, /1 drift signal\(s\)/);
    assert.doesNotMatch(ctx, /model_benchmark_suggested/);

    const onlySuppressed = ['model_benchmark_suggested'];
    writeFileSync(f, JSON.stringify({ checkedAt: new Date().toISOString(), signals: onlySuppressed.map((kind) => ({ kind, detail: 'd' })) }));
    const quiet = runHook('hooks/scout-surface.mjs', { session_id: 's-filter2', cwd: dir }, {
      cwd: dir, env: { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'model_benchmark_suggested' },
    });
    assert.equal(quiet.stdout.trim(), '', 'nothing left to say');
  } finally { cleanup(); }
});
