// Hidden scoring test: opt() resolution. Every fixture here writes its own
// settings.json under a temp home (AGENT_COMPANION_HOME_OVERRIDE) -- nothing
// here may read or write a real ~/.claude/settings.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { opt, claudeDir } from '../src/hooks/lib/context.mjs';

const PLUGIN = 'agent-companion';

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opt-fixture-'));
  const saved = { home: process.env.AGENT_COMPANION_HOME_OVERRIDE, cfgDir: process.env.CLAUDE_CONFIG_DIR };
  process.env.AGENT_COMPANION_HOME_OVERRIDE = dir;
  delete process.env.CLAUDE_CONFIG_DIR;
  return {
    dir,
    cleanup() {
      if (saved.home === undefined) delete process.env.AGENT_COMPANION_HOME_OVERRIDE; else process.env.AGENT_COMPANION_HOME_OVERRIDE = saved.home;
      if (saved.cfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfgDir;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    },
  };
}

function writeSettings(obj, { file = 'settings.json' } = {}) {
  const dir = claudeDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, file);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}

function withOptions(options, key = `${PLUGIN}@agent-templates`) {
  return { pluginConfigs: { [key]: { options } } };
}

function clearOptionEnv() {
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_')) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  return () => { for (const [k, v] of Object.entries(saved)) process.env[k] = v; };
}

// --- pre-existing suite: env var behavior must still work ---

test('opt(): env var still resolves an explicit boolean/string when no settings.json exists', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = 'true';
    assert.equal(opt('memory_vault', false), true);
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): unset key with no env var and no settings.json falls back to the default', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    assert.equal(opt('memory_vault', false), false);
  } finally {
    restoreEnv();
    cleanup();
  }
});

// --- new tests from the fix: settings.json fallback ---

test('opt() resolves from settings.json when no env var is set', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: true, memory_brief_mode: 'nudge' }));
    assert.equal(opt('memory_vault', false), true);
    assert.equal(opt('memory_brief_mode', 'off'), 'nudge');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): the CLAUDE_PLUGIN_OPTION_ env var still wins over settings.json', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: true, memory_brief_mode: 'nudge' }));
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = 'false';
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF_MODE = 'block';
    assert.equal(opt('memory_vault', false), false, 'env var must override settings.json');
    assert.equal(opt('memory_brief_mode', 'off'), 'block');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): settings.local.json wins over settings.json for the same key', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: false }), { file: 'settings.json' });
    writeSettings(withOptions({ memory_vault: true }), { file: 'settings.local.json' });
    assert.equal(opt('memory_vault', false), true);
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): a malformed settings.json does not throw and falls back to the default', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings('{ this is not valid json');
    assert.doesNotThrow(() => opt('memory_vault', false));
    assert.equal(opt('memory_vault', false), false);
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): an unqualified pluginConfigs key ("agent-companion", no marketplace suffix) is honoured', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: true }, PLUGIN));
    assert.equal(opt('memory_vault', false), true);
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): a JSON boolean true in settings.json gets the same coercion as the env-var string "true"', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: true }));
    const fromSettings = opt('memory_vault', false);
    restoreEnv();
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_VAULT = 'true';
    const fromEnv = opt('memory_vault', false);
    assert.equal(fromSettings, fromEnv);
    assert.equal(fromSettings, true);
  } finally {
    cleanup();
  }
});
