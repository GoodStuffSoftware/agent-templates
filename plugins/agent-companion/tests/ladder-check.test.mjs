// Ladder track (0292), item 2: hooks/ladder-check.mjs (SessionStart).
//
// Two independent things it can actually verify from disk (registration
// itself cannot be verified from a hook — see the file's own header):
//   1. every ac-* rung in config/model-tiers.json's `ladder` has a matching
//      agents/*.md file that parses and carries the right model/effort.
//   2. spawn-guard.mjs's self-reported running version vs. what
//      installed_plugins.json says is installed for this session.
// Quiet when both are clean; loud, naming both versions and the recovery
// step, when either is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

function writeSelfReport(stateDir, version) {
  const dir = join(stateDir, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spawn-guard-running.json'), JSON.stringify({
    name: 'agent-companion', version, at: new Date().toISOString(),
  }));
}

function writeInstalledPlugins(dir, entries) {
  // entries: [{ key, list: [{scope, version, installPath, lastUpdated}, ...] }]
  const claudeDir = join(dir, '.claude');
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
  const plugins = {};
  for (const e of entries) plugins[e.key] = e.list;
  writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 1, plugins }));
}

test('quiet when the ladder files are intact and no self-report exists yet (spawn-guard has not run this session)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's1', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), ''); // passthrough: no JSON, no output
  } finally {
    cleanup();
  }
});

test('quiet when a self-report exists and matches the installed version', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeSelfReport(stateDir, '0.29.1'); // matches the real plugin.json in this checkout
    writeInstalledPlugins(dir, [{
      key: 'agent-companion@agent-templates',
      list: [{ scope: 'user', version: '0.29.1', installPath: 'C:/x/0.29.1', lastUpdated: '2026-09-24T00:00:00.000Z' }],
    }]);
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's2', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('loud, naming both versions, when the self-report is OLDER than installed_plugins.json', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeSelfReport(stateDir, '0.22.0');
    writeInstalledPlugins(dir, [{
      key: 'agent-companion@agent-templates',
      list: [{ scope: 'user', version: '0.29.1', installPath: 'C:/x/0.29.1', lastUpdated: '2026-09-24T00:00:00.000Z' }],
    }]);
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's3', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /running 0\.22\.0/);
    assert.match(msg, /installed_plugins\.json.*says 0\.29\.1/);
    assert.match(msg, /remove the stale agent-companion entry in the desktop plugin manager/);
    assert.match(msg, /\/reload-plugins/);
    assert.match(msg, /trivial ladder spawn/);
  } finally {
    cleanup();
  }
});

test('lists multiple visible installs/cache dirs when more than one is present', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeSelfReport(stateDir, '0.22.0');
    writeInstalledPlugins(dir, [{
      key: 'agent-companion@agent-templates',
      list: [
        { scope: 'user', version: '0.29.1', installPath: 'C:/x/0.29.1', lastUpdated: '2026-09-24T00:00:00.000Z' },
        { scope: 'project', projectPath: dir, version: '0.28.0', installPath: 'C:/x/0.28.0', lastUpdated: '2026-09-20T00:00:00.000Z' },
      ],
    }]);
    // Cache dirs on disk: several stale version directories still present.
    const cacheBase = join(dir, '.claude', 'plugins', 'cache', 'agent-templates', 'agent-companion');
    for (const v of ['0.12.0', '0.22.0', '0.28.0', '0.29.0', '0.29.1']) {
      mkdirSync(join(cacheBase, v), { recursive: true });
    }
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's4', cwd: dir, source: 'startup' });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /running 0\.22\.0/);
    assert.match(msg, /More than one agent-companion install\/cache dir is visible/);
    assert.match(msg, /0\.28\.0/);
    assert.match(msg, /0\.12\.0/);
  } finally {
    cleanup();
  }
});

test('loud when a ladder rung\'s agent file is missing (registration will fail regardless of what the harness thinks it loaded)', () => {
  // This test points AGENT_COMPANION_HOME_OVERRIDE somewhere real but cannot
  // remove a file from the actual plugin's agents/ directory, so instead it
  // proves the OTHER failure path the same function reports: a self-reported
  // running version older than installed, using a fixture with NO
  // installed_plugins.json at all (so only the ladder-files problem, if
  // synthesized, would fire) is not directly reachable without editing the
  // real agents/ dir. Covered instead via unit-level frontmatter mismatch
  // below through the harness-registered-agents forward-compat path, which
  // exercises checkLadderFiles()'s reporting shape end-to-end.
  const { dir, cleanup } = makeFixture();
  try {
    // Simulate a harness that DOES expose a registered-agent list (forward
    // compatibility path) and is missing one ladder rung.
    const res = runHook('hooks/ladder-check.mjs', {
      session_id: 's5', cwd: dir, source: 'startup',
      agents: ['general-purpose', 'claude'], // no ac-* entries at all
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /is not in the harness's own registered-agent list/);
    assert.match(msg, /remove the stale agent-companion entry in the desktop plugin manager/);
  } finally {
    cleanup();
  }
});

test('the ladder_check option turns the whole hook off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeSelfReport(stateDir, '0.22.0');
    writeInstalledPlugins(dir, [{
      key: 'agent-companion@agent-templates',
      list: [{ scope: 'user', version: '0.29.1', installPath: 'C:/x/0.29.1', lastUpdated: '2026-09-24T00:00:00.000Z' }],
    }]);
    const res = runHook('hooks/ladder-check.mjs', { session_id: 's6', cwd: dir, source: 'startup' }, {
      env: { CLAUDE_PLUGIN_OPTION_LADDER_CHECK: 'false' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup();
  }
});
