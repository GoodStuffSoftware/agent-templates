// Ladder track (0292), item 2 support: spawn-guard.mjs cheaply records its
// OWN resolved version (read from ITS OWN import.meta.url, same technique
// self-update.mjs's runningPlugin() uses for itself) on every invocation, so
// hooks/ladder-check.mjs (SessionStart) has a fact to compare against
// installed_plugins.json — catching the exact failure mode observed on the
// desktop app: /reload-plugins reports a fresh load, but spawn-guard.mjs
// itself kept running old code from a stale cache path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

test('every spawn-guard invocation writes state/spawn-guard-running.json with the running plugin.json version', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const pj = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const payload = {
      session_id: 'sess-self-report',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);

    const reportFile = join(stateDir, 'state', 'spawn-guard-running.json');
    assert.ok(existsSync(reportFile), `expected ${reportFile} to exist`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.name, pj.name);
    assert.equal(report.version, pj.version);
    assert.ok(report.at, 'report carries a timestamp');
  } finally {
    cleanup();
  }
});
