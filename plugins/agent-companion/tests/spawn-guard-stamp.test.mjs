// Ladder track (0292) round 2: spawn-guard.mjs stamps its own identity into
// every spawns.jsonl row — guard_version (its own plugin.json), guard_source
// (cache/checkout) and guard_scope (the install scope that applies to the
// spawn's cwd, as a label, never a path) — so the daily scout can compare,
// across sessions, the version a spawn really ran under with what is
// installed for that scope (scripts/detect.mjs, stale_copy_loaded).
// Round 1's machine-wide state/spawn-guard-running.json marker is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { scopeKey } from '../hooks/lib/context.mjs';

const PJ = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

function writeInstalled(dir, list) {
  mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'agent-companion@agent-templates': list } }));
}
function spawn(dir, sessionId, cwd) {
  return runHook('hooks/spawn-guard.mjs', {
    session_id: sessionId, agent_type: 'main', cwd,
    tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain spawn', run_in_background: true, name: 'w' },
  });
}
function lastRow(stateDir) {
  const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
  return rows[rows.length - 1];
}

test('every row carries guard_version, guard_source and the user scope; no machine-wide marker is written', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x'), lastUpdated: '2026-09-24T00:00:00.000Z' }]);
    const res = spawn(dir, 'sess-stamp-user', dir);
    assert.equal(res.status, 0, res.stderr);
    const r = lastRow(stateDir);
    assert.equal(r.guard_version, PJ.version);
    assert.equal(r.guard_source, 'checkout'); // this test runs the repo's own copy
    assert.equal(r.guard_scope, 'user');
    assert.equal(r.subagent_type_rewritten_to, null);
    assert.ok('loaded_at' in r, 'round 3: every row carries loaded_at (null when no trusted load time is known)');
    assert.equal(existsSync(join(stateDir, 'state', 'spawn-guard-running.json')), false);
  } finally {
    cleanup();
  }
});

test('a project-scope install covering cwd stamps its hashed scope key, never the path', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const proj = join(dir, 'zqx-private-proj');
    mkdirSync(proj, { recursive: true });
    const entry = { scope: 'project', projectPath: proj, version: '0.29.1', installPath: join(dir, 'y'), lastUpdated: '2026-09-24T00:00:00.000Z' };
    writeInstalled(dir, [{ scope: 'user', version: '0.29.0', installPath: join(dir, 'x'), lastUpdated: '2026-09-24T00:00:00.000Z' }, entry]);
    const res = spawn(dir, 'sess-stamp-project', join(proj, 'sub'));
    assert.equal(res.status, 0, res.stderr);
    const r = lastRow(stateDir);
    assert.equal(r.guard_scope, scopeKey(entry));
    assert.match(r.guard_scope, /^project:[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(r).includes('zqx-private-proj'), 'the project path must not appear in the row');
  } finally {
    cleanup();
  }
});

test('with nothing installed the scope is null, and the version is still stamped', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = spawn(dir, 'sess-stamp-none', dir);
    assert.equal(res.status, 0, res.stderr);
    const r = lastRow(stateDir);
    assert.equal(r.guard_version, PJ.version);
    assert.equal(r.guard_scope, null);
  } finally {
    cleanup();
  }
});
