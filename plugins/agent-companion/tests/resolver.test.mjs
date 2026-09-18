import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, assertNotRealHome, readJsonl } from './helpers.mjs';
import {
  stateRoot, telemetryDir, stateDir, dataDir, appendLog, stateFile,
} from '../hooks/lib/context.mjs';

test('stateRoot() precedence: AGENT_COMPANION_STATE_DIR > CLAUDE_CONFIG_DIR > AGENT_COMPANION_HOME_OVERRIDE', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'ac-test-home-'));
  const configDir = mkdtempSync(join(tmpdir(), 'ac-test-config-'));
  const stateDirOverride = mkdtempSync(join(tmpdir(), 'ac-test-state-'));
  assertNotRealHome(homeDir, 'homeDir');
  assertNotRealHome(configDir, 'configDir');
  assertNotRealHome(stateDirOverride, 'stateDirOverride');

  const saved = {
    AGENT_COMPANION_HOME_OVERRIDE: process.env.AGENT_COMPANION_HOME_OVERRIDE,
    AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  try {
    // 1. HOME_OVERRIDE only -> stateRoot under <home>/.claude/agent-companion
    process.env.AGENT_COMPANION_HOME_OVERRIDE = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.AGENT_COMPANION_STATE_DIR;
    assert.equal(stateRoot(), join(homeDir, '.claude', 'agent-companion'));

    // 2. + CLAUDE_CONFIG_DIR -> wins over HOME_OVERRIDE
    process.env.CLAUDE_CONFIG_DIR = configDir;
    assert.equal(stateRoot(), join(configDir, 'agent-companion'));

    // 3. + AGENT_COMPANION_STATE_DIR -> wins over both
    process.env.AGENT_COMPANION_STATE_DIR = stateDirOverride;
    assert.equal(stateRoot(), stateDirOverride);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(stateDirOverride, { recursive: true, force: true });
  }
});

test('appendLog() writes under telemetry/', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const td = telemetryDir();
    assert.ok(td.startsWith(dir), `telemetryDir ${td} should be under fixture ${dir}`);
    appendLog('spawns.jsonl', { session_id: 'sess-a', at: new Date().toISOString(), probe: true });
    const rows = readJsonl(join(td, 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'sess-a');
    assert.equal(rows[0].v, 2);
  } finally {
    cleanup();
  }
});

test('stateFile() resolves under state/', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = stateFile('delegation-streak.json');
    assert.ok(f.startsWith(join(stateDir())), `stateFile() should resolve under stateDir()`);
    assert.ok(f.startsWith(dir), `stateFile() should be under the fixture (${dir})`);
    assert.ok(f.includes(`${join('state', '')}`.slice(0, -1)) || f.split(/[\\/]/).includes('state'));
  } finally {
    cleanup();
  }
});

test('dataDir() is unaffected by AGENT_COMPANION_STATE_DIR', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const d = dataDir();
    // Default (no CLAUDE_PLUGIN_DATA): plugin data dir, NOT under state root.
    assert.ok(d.includes(join('plugins', 'data')), `dataDir() should be the plugin data dir, got ${d}`);
    assert.ok(!d.startsWith(process.env.AGENT_COMPANION_STATE_DIR), 'dataDir() must not be under the state root');

    // Explicit CLAUDE_PLUGIN_DATA still wins, exactly as before this change.
    const explicit = join(dir, 'explicit-plugin-data');
    process.env.CLAUDE_PLUGIN_DATA = explicit;
    assert.equal(dataDir(), explicit);
    delete process.env.CLAUDE_PLUGIN_DATA;
  } finally {
    cleanup();
  }
});
