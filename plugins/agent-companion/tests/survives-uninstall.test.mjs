import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

test('spawns.jsonl survives a plugin uninstall (rm -rf on the plugin data dir)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const pluginDataDir = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');

    const payload = {
      session_id: 'sess-uninstall-1',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'do the thing' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: pluginDataDir },
    });
    assert.equal(res.status, 0, `spawn-guard exited ${res.status}: ${res.stderr}`);
    assert.ok(res.json, `spawn-guard produced no JSON output: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow');

    // Confirm the row landed under the DURABLE state root, not the plugin
    // data dir, before we destroy the latter.
    const telemetryFile = join(stateDir, 'telemetry', 'spawns.jsonl');
    const before = readJsonl(telemetryFile);
    assert.equal(before.length, 1, 'expected exactly one spawn row before uninstall');
    assert.equal(before[0].session_id, 'sess-uninstall-1');

    // This is exactly what a plugin uninstall does: delete the whole plugin
    // data directory.
    assert.ok(existsSync(pluginDataDir) || true); // dir may or may not exist yet, both are fine
    rmSync(pluginDataDir, { recursive: true, force: true });
    assert.ok(!existsSync(pluginDataDir), 'plugin data dir should be gone (simulated uninstall)');

    const after = readJsonl(telemetryFile);
    assert.equal(after.length, 1, 'spawn row must survive the plugin data dir being deleted');
    assert.equal(after[0].session_id, 'sess-uninstall-1');
    assert.equal(after[0].v, 2);
  } finally {
    cleanup();
  }
});
