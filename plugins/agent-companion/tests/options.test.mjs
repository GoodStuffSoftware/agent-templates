// opt() resolution. The bug these cover: opt() used to read ONLY
// CLAUDE_PLUGIN_OPTION_* env vars, which the harness exports for HOOK
// invocations and nothing else, so every CLI entry point (audit, doctor,
// memory-search, memory-vault, the scheduled sync) silently ran on shipped
// defaults no matter what the operator had enabled in settings.json.
//
// Every fixture here writes its own settings.json under a temp home. Nothing
// in this file may read or write the operator's real ~/.claude/settings.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, assertNotRealHome } from './helpers.mjs';
import { opt, claudeDir } from '../hooks/lib/context.mjs';

const PLUGIN = 'agent-companion';

// Write settings.json (or settings.local.json) into the fixture's .claude dir.
function writeSettings(obj, { file = 'settings.json' } = {}) {
  const dir = claudeDir();
  assertNotRealHome(dir, 'claudeDir()');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return path;
}

function withOptions(options, key = `${PLUGIN}@agent-templates`) {
  return { pluginConfigs: { [key]: { options } } };
}

// The env vars the harness would set inside a hook. Tests that assert the
// settings.json path must run with NONE of them present, or they prove nothing.
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

test('opt() resolves from settings.json when no env var is set', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_vault: true, memory_brief_mode: 'nudge' }));
    // Both default OFF in code — a pass here means settings.json was read.
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

test('opt(): the verbatim-case env var is honoured too, and still beats settings.json', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_brief_mode: 'nudge' }));
    process.env.CLAUDE_PLUGIN_OPTION_memory_brief_mode = 'verbatim-win';
    assert.equal(opt('memory_brief_mode', 'off'), 'verbatim-win');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): JSON values get the SAME coercion as env strings', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({
      json_true: true,
      json_false: false,
      str_true: 'true',
      str_false: 'false',
      str_off: 'OFF',
      json_zero: 0,
      json_number: 4321,
      str_number: '99',
      bad_number: 'not-a-number',
      json_string: 'nudge',
      json_null: null,
      json_object: { a: 1 },
      json_array: [1, 2],
      empty_string: '',
    }));
    // boolean fallback -> everything but false/0/no/off is true
    assert.equal(opt('json_true', false), true);
    assert.equal(opt('json_false', true), false);
    assert.equal(opt('str_true', false), true, 'the string "true" must work like JSON true');
    assert.equal(opt('str_false', true), false, 'the string "false" must work like JSON false');
    assert.equal(opt('str_off', true), false);
    assert.equal(opt('json_zero', true), false);
    // number fallback
    assert.equal(opt('json_number', 7), 4321);
    assert.equal(opt('str_number', 7), 99, 'a JSON string holding a number still coerces');
    assert.equal(opt('bad_number', 7), 7, 'an uncoercible number falls back');
    // string fallback
    assert.equal(opt('json_string', 'off'), 'nudge');
    // not-a-scalar and empty are "not set"
    assert.equal(opt('json_null', 'fallback'), 'fallback');
    assert.equal(opt('json_object', 'fallback'), 'fallback');
    assert.equal(opt('json_array', 'fallback'), 'fallback');
    assert.equal(opt('empty_string', 'fallback'), 'fallback');
    // absent key
    assert.equal(opt('never_configured', 'fallback'), 'fallback');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): malformed, missing, and unreadable settings all fall back WITHOUT throwing', () => {
  const restoreEnv = clearOptionEnv();
  try {
    // 1. no settings.json at all
    {
      const { cleanup } = makeFixture();
      try {
        assert.equal(opt('memory_vault', false), false);
        assert.equal(opt('some_string', 'dflt'), 'dflt');
      } finally { cleanup(); }
    }
    // 2. malformed JSON
    {
      const { cleanup } = makeFixture();
      try {
        writeSettings('{ "pluginConfigs": { not json at all');
        assert.equal(opt('memory_vault', false), false);
      } finally { cleanup(); }
    }
    // 3. valid JSON of the wrong SHAPE at every level
    for (const bad of [
      [1, 2, 3],
      { pluginConfigs: 'nope' },
      { pluginConfigs: { [`${PLUGIN}@agent-templates`]: 'nope' } },
      { pluginConfigs: { [`${PLUGIN}@agent-templates`]: { options: 'nope' } } },
      { pluginConfigs: { [`${PLUGIN}@agent-templates`]: { options: null } } },
    ]) {
      const { cleanup } = makeFixture();
      try {
        writeSettings(bad);
        assert.equal(opt('memory_vault', false), false, `shape ${JSON.stringify(bad)} must fall back`);
      } finally { cleanup(); }
    }
    // 4. unreadable: a DIRECTORY where settings.json should be
    {
      const { cleanup } = makeFixture();
      try {
        mkdirSync(join(claudeDir(), 'settings.json'), { recursive: true });
        assert.equal(opt('memory_vault', false), false);
      } finally { cleanup(); }
    }
    // 5. a key that is not a string cannot throw out of opt()
    {
      const { cleanup } = makeFixture();
      try {
        assert.equal(opt(undefined, 'dflt'), 'dflt');
        assert.equal(opt(42, 'dflt'), 'dflt');
      } finally { cleanup(); }
    }
  } finally {
    restoreEnv();
  }
});

test('opt(): the pluginConfigs key is matched by plugin name, whatever the marketplace qualifier', () => {
  const restoreEnv = clearOptionEnv();
  try {
    // An unfamiliar qualifier still matches: the plugin part is what counts.
    {
      const { cleanup } = makeFixture();
      try {
        writeSettings(withOptions({ memory_vault: true }, `${PLUGIN}@some-other-marketplace`));
        assert.equal(opt('memory_vault', false), true);
      } finally { cleanup(); }
    }
    // An UNQUALIFIED key matches too.
    {
      const { cleanup } = makeFixture();
      try {
        writeSettings(withOptions({ memory_vault: true }, PLUGIN));
        assert.equal(opt('memory_vault', false), true);
      } finally { cleanup(); }
    }
    // A different plugin's config must NOT be read.
    {
      const { cleanup } = makeFixture();
      try {
        writeSettings(withOptions({ memory_vault: true }, 'some-other-plugin@agent-templates'));
        assert.equal(opt('memory_vault', false), false);
      } finally { cleanup(); }
    }
    // A plugin whose name merely STARTS WITH ours is not ours.
    {
      const { cleanup } = makeFixture();
      try {
        writeSettings(withOptions({ memory_vault: true }, `${PLUGIN}-extra@agent-templates`));
        assert.equal(opt('memory_vault', false), false);
      } finally { cleanup(); }
    }
  } finally {
    restoreEnv();
  }
});

test('opt(): with two qualifiers, an emptier config cannot shadow the one that sets the key', () => {
  const restoreEnv = clearOptionEnv();
  try {
    const { cleanup } = makeFixture();
    try {
      // "@aaa" sorts first, and the marketplace this checkout came from
      // (agent-templates) is preferred — but neither defines the key, so the
      // lookup must keep walking rather than reporting "not set".
      writeSettings({
        pluginConfigs: {
          [`${PLUGIN}@aaa-first-alphabetically`]: { options: {} },
          [`${PLUGIN}@agent-templates`]: { options: { unrelated: 1 } },
          [`${PLUGIN}@zzz-last-alphabetically`]: { options: { memory_vault: true } },
        },
      });
      assert.equal(opt('memory_vault', false), true);
      // ...and when the preferred config DOES define it, it wins.
      writeSettings({
        pluginConfigs: {
          [`${PLUGIN}@aaa-first-alphabetically`]: { options: { memory_brief_mode: 'aaa' } },
          [`${PLUGIN}@agent-templates`]: { options: { memory_brief_mode: 'preferred' } },
        },
      });
      assert.equal(opt('memory_brief_mode', 'off'), 'preferred');
    } finally { cleanup(); }
  } finally {
    restoreEnv();
  }
});

test('opt(): settings.local.json takes precedence over settings.json', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_brief_mode: 'from-settings' }));
    writeSettings(withOptions({ memory_brief_mode: 'from-local' }), { file: 'settings.local.json' });
    assert.equal(opt('memory_brief_mode', 'off'), 'from-local');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): the settings cache is invalidated by an edit, and never serves a stale value', () => {
  const { cleanup } = makeFixture();
  const restoreEnv = clearOptionEnv();
  try {
    writeSettings(withOptions({ memory_brief_mode: 'first' }));
    assert.equal(opt('memory_brief_mode', 'off'), 'first');
    // Same path, different content. The cache keys on (mtimeMs, size), so a
    // rewrite must be picked up on the very next call.
    writeSettings(withOptions({ memory_brief_mode: 'second-and-longer' }));
    assert.equal(opt('memory_brief_mode', 'off'), 'second-and-longer');
    // ...including a rewrite that REMOVES the key.
    writeSettings(withOptions({ unrelated: 'x' }));
    assert.equal(opt('memory_brief_mode', 'off'), 'off');
  } finally {
    restoreEnv();
    cleanup();
  }
});

test('opt(): two different config dirs do not share a cache entry', () => {
  const restoreEnv = clearOptionEnv();
  const a = mkdtempSync(join(tmpdir(), 'ac-opt-a-'));
  const b = mkdtempSync(join(tmpdir(), 'ac-opt-b-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    assertNotRealHome(a, 'config dir a');
    assertNotRealHome(b, 'config dir b');
    writeFileSync(join(a, 'settings.json'), JSON.stringify(withOptions({ memory_brief_mode: 'in-a' })));
    writeFileSync(join(b, 'settings.json'), JSON.stringify(withOptions({ memory_brief_mode: 'in-b' })));
    process.env.CLAUDE_CONFIG_DIR = a;
    assert.equal(opt('memory_brief_mode', 'off'), 'in-a');
    process.env.CLAUDE_CONFIG_DIR = b;
    assert.equal(opt('memory_brief_mode', 'off'), 'in-b');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    restoreEnv();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
