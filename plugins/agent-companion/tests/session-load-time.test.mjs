// Ladder track round 3: when did THIS session load its plugins?
//
// The scout judges a session by the version it loaded (stale_guard_running),
// and the spawn guard bounds its same-session ladder evidence to the current
// load, so the load time must be right. SessionStart `source: "resume"` fires
// both for a fresh `claude --resume` process (a new load) and for /resume
// inside a running process (no load). noteProcessLoad (hooks/lib/context.mjs)
// tells them apart by CLAUDE_PID; self-update.mjs records which source its
// `loadedAt` came from; the guard stamps `loaded_at` from trusted sources only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';

const PJ = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

test('noteProcessLoad: startup records the process; an in-process resume gets that load time; a new pid is a fresh load', async () => {
  const { cleanup } = makeFixture();
  try {
    // Every state path is computed at call time from the fixture's env overrides.
    const { noteProcessLoad } = await import('../hooks/lib/context.mjs');
    const t0 = 1_000_000_000_000;
    assert.deepEqual(noteProcessLoad('startup', 'sid-a', { pid: '111', now: t0 }), { fresh: true, loadedAt: t0 });
    // The second SessionStart hook of the SAME event sees its peer's record as fresh.
    assert.deepEqual(noteProcessLoad('startup', 'sid-a', { pid: '111', now: t0 + 500 }), { fresh: true, loadedAt: t0 });
    // /resume inside process 111, into another session, much later.
    assert.deepEqual(noteProcessLoad('resume', 'sid-b', { pid: '111', now: t0 + 3_600_000 }), { fresh: false, loadedAt: t0 });
    // /clear and compaction are never a load.
    assert.deepEqual(noteProcessLoad('compact', 'sid-b', { pid: '111', now: t0 + 3_700_000 }), { fresh: false, loadedAt: t0 });
    // `claude --resume` in a new process 222: fresh, and both hooks of that event agree.
    assert.deepEqual(noteProcessLoad('resume', 'sid-c', { pid: '222', now: t0 + 4_000_000 }), { fresh: true, loadedAt: t0 + 4_000_000 });
    assert.deepEqual(noteProcessLoad('resume', 'sid-c', { pid: '222', now: t0 + 4_000_300 }), { fresh: true, loadedAt: t0 + 4_000_000 });
    // No CLAUDE_PID: a startup is still a load; a resume is unknowable.
    assert.deepEqual(noteProcessLoad('startup', 'sid-d', { pid: '', now: t0 }), { fresh: true, loadedAt: t0 });
    assert.deepEqual(noteProcessLoad('resume', 'sid-d', { pid: null, now: t0 }), { fresh: null, loadedAt: null });
    // A path-shaped pid is ignored, never used as a file name.
    assert.deepEqual(noteProcessLoad('resume', 'sid-e', { pid: '../x', now: t0 }), { fresh: null, loadedAt: null });
  } finally {
    cleanup();
  }
});

function writeInstalled(dir, lastUpdated) {
  mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'agent-companion@agent-templates': [{ scope: 'user', version: PJ.version, installPath: join(dir, 'x'), lastUpdated }] },
  }));
}
function sessionStart(dir, sessionId, source, pid) {
  const res = runHook('hooks/self-update.mjs', { hook_event_name: 'SessionStart', session_id: sessionId, cwd: dir, source },
    { env: { CLAUDE_PID: pid } });
  assert.equal(res.status, 0, res.stderr);
  return res;
}
const loadRecord = (stateDir, sid) => JSON.parse(readFileSync(join(stateDir, 'state', 'version-notice-state.json'), 'utf8'))[sid];

test('self-update: an in-process /resume keeps the process\'s load time, so an update since then is reported', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, new Date(Date.now() - 3_600_000).toISOString());
    sessionStart(dir, 'sess-start', 'startup', '31337');
    const started = loadRecord(stateDir, 'sess-start');
    assert.equal(started.loadedAtFrom, 'startup');
    // The plugin is updated while process 31337 keeps running...
    writeInstalled(dir, new Date(Date.now() + 1000).toISOString());
    // ...then /resume inside it: its loaded copy predates the update.
    const res = sessionStart(dir, 'sess-resumed', 'resume', '31337');
    const rec = loadRecord(stateDir, 'sess-resumed');
    assert.equal(rec.loadedAtFrom, 'resume-in-process');
    assert.equal(rec.loadedAt, started.loadedAt);
    assert.match(res.json?.systemMessage || '', /was updated after this session loaded its plugins/);
  } finally {
    cleanup();
  }
});

test('self-update: a resume in a fresh process is a load; without CLAUDE_PID it is recorded as unverified', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, new Date(Date.now() - 3_600_000).toISOString());
    const res = sessionStart(dir, 'sess-fresh-resume', 'resume', '4040');
    assert.equal(loadRecord(stateDir, 'sess-fresh-resume').loadedAtFrom, 'resume');
    assert.equal(res.stdout.trim(), '');
    sessionStart(dir, 'sess-nopid-resume', 'resume', '');
    assert.equal(loadRecord(stateDir, 'sess-nopid-resume').loadedAtFrom, 'resume-unverified');
  } finally {
    cleanup();
  }
});

function spawn(dir, sessionId, pid) {
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sessionId, agent_type: 'main', cwd: dir,
    tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain spawn', run_in_background: true, name: 'w' },
  }, { env: { CLAUDE_PID: pid } });
  assert.equal(res.status, 0, res.stderr);
  return readJsonl(join(stateDir(dir), 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sessionId).pop();
}
const stateDir = (dir) => join(dir, '.claude', 'agent-companion');

test('the spawn guard stamps loaded_at from a trusted load only; an untrusted one falls back to the process record', () => {
  const { dir, stateDir: sd, cleanup } = makeFixture();
  try {
    writeInstalled(dir, new Date(Date.now() - 3_600_000).toISOString());
    sessionStart(dir, 'sess-trusted', 'startup', '777');
    const trusted = loadRecord(sd, 'sess-trusted');
    assert.equal(spawn(dir, 'sess-trusted', '777').loaded_at, new Date(trusted.loadedAt).toISOString());
    // A record whose source may be later than the real load is not used.
    const st = JSON.parse(readFileSync(join(sd, 'state', 'version-notice-state.json'), 'utf8'));
    st['sess-untrusted'] = { loadedAt: Date.now(), loadedAtFrom: 'first-seen', shown: [], at: Date.now() };
    writeFileSync(join(sd, 'state', 'version-notice-state.json'), JSON.stringify(st));
    // Same process 777: its own load record stands in.
    assert.equal(spawn(dir, 'sess-untrusted', '777').loaded_at, new Date(trusted.loadedAt).toISOString());
    // No process record either: null, never "now".
    assert.equal(spawn(dir, 'sess-untrusted', '').loaded_at, null);
  } finally {
    cleanup();
  }
});
