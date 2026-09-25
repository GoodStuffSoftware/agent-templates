// Ladder track round 2: the daily scout's cross-session version checks.
//
// stale_guard_running: spawn-guard.mjs stamps guard_version / guard_source /
// guard_scope into every spawns.jsonl row, and scripts/detect.mjs flags spawns
// in the last 24h guarded by a version BELOW the one installed for that same
// scope. This is the only channel that sees a session whose own hooks are
// all stale (the 2026-09-24 incident: a session that loaded only 0.22.0).
//
// plugin_version_behind: compares the installed version against the latest
// AVAILABLE one (the marketplace clone locally, the routine's own checkout in
// the cloud), directionally; never against whichever checkout runs the scout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { scopeKey } from '../hooks/lib/context.mjs';

const HOUR = 3600 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function writeInstalled(dir, list, key = 'agent-companion@agent-templates') {
  mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [key]: list } }));
}

// A row shaped like the current guard's, with the stamp fields.
function row(sessionId, msAgo, stamp) {
  return {
    v: 2, at: iso(msAgo), session_id: sessionId, model: 'opus', subagent_type: 'general-purpose',
    route_layer: null, declared_type: null, effective_effort: 'inherited(high)', fit_trial: false, route_profile_rev: null,
    ...stamp,
  };
}
// A row shaped like a pre-0.29.0 guard's: no route_layer and no stamp keys at all.
function legacyRow(sessionId, msAgo) {
  return { v: 2, at: iso(msAgo), session_id: sessionId, model: 'opus', subagent_type: 'general-purpose', inherited: false };
}

function writeSpawns(stateDir, rows) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'spawns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function runDetect(dir, { script = 'scripts/detect.mjs', env = {} } = {}) {
  const res = runScript(script, [], { cwd: dir, env, timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, `detect.mjs printed no JSON: ${res.stdout}`);
  return res.json.signals;
}
const find = (signals, kind) => signals.filter((s) => s.kind === kind);

test('after a normal update, no warning: pre-update rows, a session open across the update, and fresh sessions on the new version', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: join(dir, 'x', '0.29.2'), lastUpdated: iso(2 * HOUR) }]);
    writeSpawns(stateDir, [
      row('aaaaaaaa-pre-update', 3 * HOUR, { guard_version: '0.29.1', guard_source: 'cache', guard_scope: 'user' }),
      row('bbbbbbbb-straddler', 3 * HOUR, { guard_version: '0.29.1', guard_source: 'cache', guard_scope: 'user' }),
      row('bbbbbbbb-straddler', 1 * HOUR, { guard_version: '0.29.1', guard_source: 'cache', guard_scope: 'user' }),
      row('cccccccc-fresh', 0.5 * HOUR, { guard_version: '0.29.2', guard_source: 'cache', guard_scope: 'user' }),
    ]);
    assert.deepEqual(find(runDetect(dir), 'stale_guard_running'), []);
  } finally {
    cleanup();
  }
});

test('a dev checkout newer than installed is never called stale (nor a newer cache copy)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeSpawns(stateDir, [
      row('dddddddd-dev', 1 * HOUR, { guard_version: '0.29.3', guard_source: 'checkout', guard_scope: 'user' }),
      row('eeeeeeee-newer-cache', 1 * HOUR, { guard_version: '0.29.3', guard_source: 'cache', guard_scope: 'user' }),
      // An OLDER checkout is the operator's own tree, not a stale install.
      row('ffffffff-old-dev', 1 * HOUR, { guard_version: '0.28.0', guard_source: 'checkout', guard_scope: 'user' }),
    ]);
    assert.deepEqual(find(runDetect(dir), 'stale_guard_running'), []);
  } finally {
    cleanup();
  }
});

test('installed newer than the guard that ran the spawns: warns, naming both versions, the session and the remedy', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.5', installPath: join(dir, 'x', '0.29.5'), lastUpdated: iso(3 * HOUR) }]);
    writeSpawns(stateDir, [
      row('12345678-stale-session', 1 * HOUR, { guard_version: '0.29.2', guard_source: 'cache', guard_scope: 'user' }),
      row('12345678-stale-session', 0.5 * HOUR, { guard_version: '0.29.2', guard_source: 'cache', guard_scope: 'user' }),
    ]);
    const hits = find(runDetect(dir), 'stale_guard_running');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /2 spawn\(s\) in 24h from 1 session/);
    assert.match(hits[0].detail, /guard 0\.29\.2 < installed 0\.29\.5 \(user scope\)/);
    assert.match(hits[0].detail, /session 12345678/);
    assert.match(hits[0].detail, /remove the stale agent-companion entry in the desktop plugin manager, then \/reload-plugins, then verify with a trivial ladder spawn; fresh session if that still fails/);
    assert.equal(hits[0].dispatch, 'plugin-update');
  } finally {
    cleanup();
  }
});

test('multiple installs: every visible install is listed, and each row is judged against ITS OWN scope', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const project = join(dir, 'proj');
    writeInstalled(dir, [
      { scope: 'user', version: '0.29.5', installPath: join(dir, 'x', '0.29.5'), lastUpdated: iso(3 * HOUR) },
      { scope: 'project', projectPath: project, version: '0.29.4', installPath: join(dir, 'x', '0.29.4'), lastUpdated: iso(3 * HOUR) },
    ]);
    // The project-scope hash the guard would stamp for `project`.
    const projectScope = scopeKey({ scope: 'project', projectPath: project });
    writeSpawns(stateDir, [
      // Behind the user install: stale.
      row('99999999-user-stale', 1 * HOUR, { guard_version: '0.29.4', guard_source: 'cache', guard_scope: 'user' }),
      // 0.29.4 in the project scope, whose install IS 0.29.4: not stale.
      row('88888888-project-ok', 1 * HOUR, { guard_version: '0.29.4', guard_source: 'cache', guard_scope: projectScope }),
    ]);
    const hits = find(runDetect(dir), 'stale_guard_running');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /from 1 session/);
    assert.match(hits[0].detail, /session 99999999/);
    assert.doesNotMatch(hits[0].detail, /88888888/);
    assert.match(hits[0].detail, /Installs visible: user@0\.29\.5, project@0\.29\.4/);
  } finally {
    cleanup();
  }
});

test('the stale-only incident, as the scout sees it: pre-0.29.0 guard rows after the install landed warn', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeSpawns(stateDir, [
      legacyRow('sessleg1-desktop', 2 * HOUR),
      legacyRow('sessleg1-desktop', 1 * HOUR),
      legacyRow('sessleg2-fresh', 0.5 * HOUR),
      // A 0.29.x row with no stamp (route_layer present): version unknown, never guessed.
      row('sess029x-029x', 0.5 * HOUR, {}),
    ]);
    const hits = find(runDetect(dir), 'stale_guard_running');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /3 spawn\(s\) in 24h from 2 session/);
    assert.match(hits[0].detail, /guard a pre-0\.29\.0 version < installed 0\.29\.1/);
    assert.doesNotMatch(hits[0].detail, /sess029x/);
  } finally {
    cleanup();
  }
});

test('legacy rows do not warn when the install itself predates the route_layer fingerprint', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.28.0', installPath: join(dir, 'x', '0.28.0'), lastUpdated: iso(5 * HOUR) }]);
    writeSpawns(stateDir, [legacyRow('sessleg4-legacy', 1 * HOUR)]);
    assert.deepEqual(find(runDetect(dir), 'stale_guard_running'), []);
  } finally {
    cleanup();
  }
});

// --- plugin_version_behind ---------------------------------------------------

// A copy of the plugin's runnable parts stamped with `version`, so detect.mjs
// can be run FROM a checkout at a different version than the repo's own.
function checkoutAt(root, version) {
  for (const d of ['scripts', 'hooks', 'config', 'agents', '.claude-plugin']) {
    cpSync(join(PLUGIN_ROOT, d), join(root, d), { recursive: true });
  }
  const pjFile = join(root, '.claude-plugin', 'plugin.json');
  const pj = JSON.parse(readFileSync(pjFile, 'utf8'));
  writeFileSync(pjFile, JSON.stringify({ ...pj, version }, null, 2));
  return root;
}
function writeMarketplaceClone(dir, version) {
  const loc = join(dir, '.claude', 'plugins', 'marketplaces', 'agent-templates');
  mkdirSync(join(loc, '.claude-plugin'), { recursive: true });
  writeFileSync(join(loc, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'agent-templates', plugins: [{ name: 'agent-companion', source: './plugins/agent-companion' }] }));
  mkdirSync(join(loc, 'plugins', 'agent-companion', '.claude-plugin'), { recursive: true });
  writeFileSync(join(loc, 'plugins', 'agent-companion', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'agent-companion', version }));
}
function runDetectFrom(root, dir, env = {}) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'detect.mjs')], {
    windowsHide: true, encoding: 'utf8', cwd: dir, env: { ...process.env, ...env }, timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).signals;
}

test('plugin_version_behind, the real inverted case: installed 0.29.1 and the checkout at 0.29.0 does not fire', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.1');
    assert.deepEqual(find(runDetectFrom(root, dir), 'plugin_version_behind'), []);
    // No marketplace clone at all: still silent (the checkout is never "latest" locally).
    const { dir: dir2, cleanup: c2 } = makeFixture();
    try {
      writeInstalled(dir2, [{ scope: 'user', version: '0.29.1', installPath: join(dir2, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
      assert.deepEqual(find(runDetectFrom(root, dir2), 'plugin_version_behind'), []);
    } finally {
      c2();
    }
  } finally {
    cleanup();
  }
});

test('plugin_version_behind: an unreleased dev checkout ahead of every release does not fire either', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.30.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.1');
    assert.deepEqual(find(runDetectFrom(root, dir), 'plugin_version_behind'), []);
  } finally {
    cleanup();
  }
});

test('plugin_version_behind fires when the marketplace clone is AHEAD of the install, naming both versions', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.3');
    const hits = find(runDetect(dir), 'plugin_version_behind');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /installed at 0\.29\.1; the latest available is 0\.29\.3/);
  } finally {
    cleanup();
  }
});

test('plugin_version_behind in the cloud: the routine checkout is latest, still directional', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    const env = { CLAUDE_CODE_REMOTE_SESSION_ID: 'test-cloud' };
    assert.deepEqual(find(runDetectFrom(root, dir, env), 'plugin_version_behind'), []);
    const ahead = checkoutAt(join(dir, 'checkout2'), '0.29.2');
    const hits = find(runDetectFrom(ahead, dir, env), 'plugin_version_behind');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /installed at 0\.29\.1; the latest available is 0\.29\.2/);
  } finally {
    cleanup();
  }
});

// --- new_agent_type ------------------------------------------------------------

test('new_agent_type ignores the ladder\'s own types, bare and namespaced, but still reports real unknowns', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const t = join(stateDir, 'telemetry');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'unknown-agent-types.jsonl'), [
      { v: 2, at: iso(HOUR), agent_type: 'agent-companion:ac-opus-high' },
      { v: 2, at: iso(HOUR), agent_type: 'ac-sonnet-low' },
      { v: 2, at: iso(HOUR), agent_type: 'brand-new-harness-type' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const hits = find(runDetect(dir), 'new_agent_type');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /brand-new-harness-type/);
    assert.doesNotMatch(hits[0].detail, /ac-opus-high|ac-sonnet-low/);
  } finally {
    cleanup();
  }
});
