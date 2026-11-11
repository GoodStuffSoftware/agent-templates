// The settings home (<state root>/config/settings.json) and the one config folder
// (<state root>/config/, with the six old top-level files as a fallback).
//
// Every fixture writes under its own temp home (makeFixture). Nothing here may read or write the
// operator's real ~/.claude or ~/.claude/agent-companion. Project names are invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeFixture, assertNotRealHome, PLUGIN_ROOT } from './helpers.mjs';
import {
  opt, claudeDir, scoutSuppressed, settingsHomePath, settingsHomeValue, settingsHomeProblems, settingsHomeStatus,
  resetSettingsHomeCache, setManifestPathForTests, declaredOptions, explainOption,
  configFilePath, configFileStatus, KNOWN_CONFIG_FILES, LEGACY_TOPLEVEL_CONFIG_FILES, stateRootPath,
} from '../hooks/lib/context.mjs';
import { planWeights, _resetPlanWeightsForTests } from '../hooks/lib/plan-allowance.mjs';
import { pricingTable, _resetPricingCacheForTests } from '../scripts/lib/pricing.mjs';
import { compactionConfig, _resetCompactionConfigForTests } from '../scripts/lib/cache-advisor.mjs';
import { rolloutActive, rolloutFile } from '../hooks/lib/context-ceiling.mjs';
import { loadEventSources } from '../scripts/lib/usage/events.mjs';
import { loadConfig } from '../scripts/lib/api-credits.mjs';
import { writeUserFile } from '../scripts/calibrate-weights.mjs';

const PLUGIN = 'agent-companion';

function clearOptionEnv() {
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (k.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_')) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  return () => {
    for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_')) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  };
}

// A fixture plus a clean option environment and an empty home cache; the returned done() undoes both.
function sandbox() {
  const fx = makeFixture();
  const restoreEnv = clearOptionEnv();
  resetSettingsHomeCache();
  assertNotRealHome(stateRootPath(), 'stateRootPath()');
  return {
    fx,
    done() {
      setManifestPathForTests(null);
      restoreEnv();
      resetSettingsHomeCache();
      fx.cleanup();
    },
  };
}

function writeHome(content) {
  const p = settingsHomePath();
  assertNotRealHome(p, 'settingsHomePath()');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  resetSettingsHomeCache();
  return p;
}

function writePluginSettings(options, file = 'settings.json') {
  const dir = claudeDir();
  assertNotRealHome(dir, 'claudeDir()');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ pluginConfigs: { [`${PLUGIN}@agent-templates`]: { options } } }));
}

// ---------------------------------------------------------------------------------------------------- precedence

test('settings home: beats env, settings.local.json and settings.json; an absent key falls through each in turn', () => {
  const s = sandbox();
  try {
    writePluginSettings({ delegation_guard: 'from-settings', delegation_threshold: 11, memory_vault: true }, 'settings.json');
    writePluginSettings({ delegation_guard: 'from-local', delegation_threshold: 12 }, 'settings.local.json');
    process.env.CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD = 'from-env';
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF_MODE = 'env-mode';
    writeHome({ delegation_guard: 'from-home' });
    assert.equal(opt('delegation_guard', 'warn'), 'from-home', 'home beats env, local and settings');
    // not in the home: the old chain, unchanged
    assert.equal(opt('memory_brief_mode', 'nudge'), 'env-mode', 'env');
    assert.equal(opt('delegation_threshold', 4), 12, 'settings.local.json');
    assert.equal(opt('memory_vault', false), true, 'settings.json');
    assert.equal(opt('scope_tripwire_writer_deny', 4), 4, 'caller fallback');
    delete process.env.CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD;
    assert.equal(opt('delegation_guard', 'warn'), 'from-home');
  } finally { s.done(); }
});

test('settings home: no file at all resolves exactly as before', () => {
  const s = sandbox();
  try {
    writePluginSettings({ delegation_guard: 'block' });
    assert.equal(existsSync(settingsHomePath()), false);
    assert.equal(opt('delegation_guard', 'warn'), 'block');
    assert.equal(opt('step_budget', true), true);
    assert.deepEqual(settingsHomeProblems(), []);
    assert.deepEqual(settingsHomeStatus(), { path: settingsHomePath(), exists: false, keys: [] });
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- parity

const PARITY = [
  // [option key, value, fallback the reader passes]
  ['memory_vault', true, false],
  ['memory_vault', false, true],
  ['step_budget', false, true],
  ['step_budget', true, false],
  ['scope_tripwire_writer_deny', 7, 4],
  ['scope_tripwire_writer_deny', 0, 4],
  ['subagent_ceiling_tokens', 250000, 0],
  ['api_credits_review_ratio', 0.25, 0.5],
  ['delegation_guard', 'block', 'warn'],
  ['delegation_guard', '', 'warn'],
  ['memory_archive_prefixes', 'a_,b-,  c d', 'findings_'],
  ['scout_suppress', 'model_benchmark_suggested, release_watch', ''],
  ['telemetry_endpoint', 'https://example.invalid/ingest', ''],
];

for (const [key, value, fallback] of PARITY) {
  test(`settings home parity: ${key}=${JSON.stringify(value)} reads like the same plugin option (${typeof value})`, () => {
    const viaHome = sandbox();
    let a;
    try { writeHome({ [key]: value }); a = opt(key, fallback); } finally { viaHome.done(); }
    const viaPlugin = sandbox();
    let b;
    try { writePluginSettings({ [key]: value }); b = opt(key, fallback); } finally { viaPlugin.done(); }
    assert.deepEqual(a, b);
    assert.equal(typeof a, typeof fallback);
  });
}

test('settings home parity: readers that wrap opt() (scoutSuppressed, loadConfig) see a home value like a plugin option', () => {
  const run = (setup) => {
    const s = sandbox();
    try {
      setup();
      return {
        suppressed: [...scoutSuppressed()].sort(),
        cfg: loadConfig(),
      };
    } finally { s.done(); }
  };
  const opts = {
    scout_suppress: 'model_benchmark_suggested; release_watch', api_credits_budget_usd: 321, api_credits_cycle_day: 9,
    api_credits_key_source: 'env:ZZ_TEST_KEY', api_credits_shares: 'review=0.6,overflow=0.4', api_credits_review_ratio: 0.2,
  };
  const home = run(() => writeHome(opts));
  const plugin = run(() => writePluginSettings(opts));
  assert.deepEqual(home, plugin);
  assert.equal(home.cfg.budget, 321);
  assert.equal(home.cfg.cycleDay, 9);
  assert.deepEqual(home.suppressed, ['model_benchmark_suggested', 'release_watch']);
});

// ---------------------------------------------------------------------------------------------------- bad files

test('settings home: a malformed file, a non-object, an array and a BOM-less empty file never break opt()', () => {
  for (const [text, kind] of [['{ not json', 'malformed'], ['[1,2]', 'not-object'], ['"text"', 'not-object'], ['null', 'not-object'], ['', 'malformed']]) {
    const s = sandbox();
    try {
      writePluginSettings({ delegation_guard: 'block' });
      writeHome(text);
      assert.equal(opt('delegation_guard', 'warn'), 'block', `falls through for ${JSON.stringify(text)}`);
      const probs = settingsHomeProblems();
      assert.equal(probs.length, 1);
      assert.equal(probs[0].kind, kind);
      assert.equal(probs[0].key, null);
    } finally { s.done(); }
  }
});

test('settings home: a UTF-8 BOM (PowerShell 5.1) is accepted', () => {
  const s = sandbox();
  try {
    writeHome(`﻿${JSON.stringify({ delegation_guard: 'block' })}`);
    assert.equal(opt('delegation_guard', 'warn'), 'block');
    assert.deepEqual(settingsHomeProblems(), []);
  } finally { s.done(); }
});

test('settings home: an unknown key and a wrong-type value are ignored one by one, the rest of the file still applies', () => {
  const s = sandbox();
  try {
    writePluginSettings({ memory_vault: true, delegation_threshold: 9, delegation_guard: 'block' });
    writeHome({
      no_such_option: 1, // unknown
      memory_vault: 'yes', // boolean option given a string
      delegation_threshold: '5', // number option given a string
      delegation_guard: 7, // string option given a number
      scout_suppress: ['a', 'b'], // array
      step_budget: false, // fine
      scope_tripwire_writer_deny: Number.MAX_SAFE_INTEGER, // fine
    });
    assert.equal(opt('memory_vault', false), true, 'fell through to settings.json');
    assert.equal(opt('delegation_threshold', 4), 9);
    assert.equal(opt('delegation_guard', 'warn'), 'block');
    assert.equal(opt('step_budget', true), false, 'the valid entry applied');
    assert.equal(opt('scope_tripwire_writer_deny', 4), Number.MAX_SAFE_INTEGER);
    const probs = settingsHomeProblems();
    assert.deepEqual(probs.map((p) => `${p.key}:${p.kind}`).sort(), [
      'delegation_guard:wrong-type', 'delegation_threshold:wrong-type', 'memory_vault:wrong-type',
      'no_such_option:unknown-key', 'scout_suppress:wrong-type',
    ]);
    for (const p of probs) assert.equal(JSON.stringify(p).includes('yes'), false, 'a problem never carries the value');
    assert.equal(settingsHomeValue('no_such_option'), undefined);
    assert.equal(opt('no_such_option', 'fb'), 'fb');
  } finally { s.done(); }
});

test('settings home: an unreadable path (a directory) is a problem, never a throw', () => {
  const s = sandbox();
  try {
    mkdirSync(settingsHomePath(), { recursive: true });
    resetSettingsHomeCache();
    assert.equal(opt('delegation_guard', 'warn'), 'warn');
    const probs = settingsHomeProblems();
    assert.equal(probs.length, 1);
    assert.equal(probs[0].kind, 'unreadable');
  } finally { s.done(); }
});

test('settings home: a key like __proto__ is an unknown key, not a prototype write', () => {
  const s = sandbox();
  try {
    writeHome('{"__proto__": {"delegation_guard": "block"}, "constructor": 1}');
    assert.equal(opt('delegation_guard', 'warn'), 'warn');
    assert.deepEqual(settingsHomeProblems().map((p) => p.kind), ['unknown-key', 'unknown-key']);
    assert.equal({}.delegation_guard, undefined);
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- read once

test('settings home: the file is parsed once per process, a missing file is checked once', () => {
  const s = sandbox();
  try {
    // missing file: remembered as missing even after it appears (until a reset)
    assert.equal(opt('delegation_guard', 'warn'), 'warn');
    const p = settingsHomePath();
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify({ delegation_guard: 'block' }));
    assert.equal(opt('delegation_guard', 'warn'), 'warn', 'not re-checked');
    resetSettingsHomeCache();
    assert.equal(opt('delegation_guard', 'warn'), 'block');
    // present file: an edit on disk is not re-read
    writeFileSync(p, JSON.stringify({ delegation_guard: 'off' }));
    assert.equal(opt('delegation_guard', 'warn'), 'block', 'not re-parsed');
    assert.equal(opt('delegation_guard', 'warn'), 'block');
    resetSettingsHomeCache();
    assert.equal(opt('delegation_guard', 'warn'), 'off');
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- sensitive

test('settings home: an option declared sensitive in plugin.json is never read from the file', () => {
  const s = sandbox();
  try {
    const manifest = join(s.fx.dir, 'fixture-plugin.json');
    writeFileSync(manifest, JSON.stringify({
      name: PLUGIN,
      userConfig: {
        zz_public: { type: 'string', title: 'p', description: 'd', default: 'x' },
        zz_secret: { type: 'string', title: 's', description: 'd', sensitive: true },
        zz_flag: { type: 'boolean', title: 'f', description: 'd', default: false },
      },
    }));
    setManifestPathForTests(manifest);
    writeHome({ zz_public: 'visible', zz_secret: 'hunter2', zz_flag: true });
    assert.equal(opt('zz_public', 'x'), 'visible');
    assert.equal(opt('zz_flag', false), true);
    assert.equal(opt('zz_secret', 'fallback'), 'fallback', 'never from the home file');
    process.env.CLAUDE_PLUGIN_OPTION_ZZ_SECRET = 'from-the-credential-store';
    assert.equal(opt('zz_secret', 'fallback'), 'from-the-credential-store', 'the old chain still serves it');
    const probs = settingsHomeProblems();
    assert.deepEqual(probs.map((p) => `${p.key}:${p.kind}`), ['zz_secret:sensitive-key']);
    assert.equal(JSON.stringify(probs).includes('hunter2'), false);
    // the report never shows a sensitive value
    const e = explainOption('zz_secret');
    assert.equal(e.sensitive, true);
    assert.notEqual(e.value, 'from-the-credential-store');
    assert.equal(e.source, 'env');
  } finally { s.done(); }
});

test('settings home: an unreadable manifest declares nothing, so the home file is ignored', () => {
  const s = sandbox();
  try {
    setManifestPathForTests(join(s.fx.dir, 'does-not-exist.json'));
    writeHome({ delegation_guard: 'block' });
    assert.equal(opt('delegation_guard', 'warn'), 'warn');
    assert.equal(settingsHomeProblems()[0].kind, 'unknown-key');
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- reporting

test('declaredOptions: every plugin.json option with type and default', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  const list = declaredOptions();
  assert.deepEqual(list.map((o) => o.key), Object.keys(manifest));
  for (const o of list) {
    assert.equal(o.type, manifest[o.key].type);
    assert.deepEqual(o.default, manifest[o.key].default);
    assert.equal(typeof o.sensitive, 'boolean');
  }
  assert.ok(list.some((o) => o.type === 'boolean') && list.some((o) => o.type === 'number') && list.some((o) => o.type === 'string'));
});

test('explainOption: names the source of the effective value, and the declared default', () => {
  const s = sandbox();
  try {
    writePluginSettings({ delegation_threshold: 8, memory_vault: true });
    writePluginSettings({ delegation_threshold: 6 }, 'settings.local.json');
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF_MODE = 'block';
    writeHome({ scope_tripwire_writer_deny: 9, delegation_guard: '' });
    const home = explainOption('scope_tripwire_writer_deny');
    assert.equal(home.source, 'home');
    assert.equal(home.value, 9);
    assert.equal(home.default, 4);
    assert.equal(home.type, 'number');
    assert.equal(home.detail, settingsHomePath());
    const env = explainOption('memory_brief_mode');
    assert.equal(env.source, 'env');
    assert.equal(env.value, 'block');
    assert.equal(env.detail, 'CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF_MODE');
    const local = explainOption('delegation_threshold');
    assert.equal(local.source, 'settings.local.json');
    assert.equal(local.value, 6);
    const user = explainOption('memory_vault');
    assert.equal(user.source, 'settings.json');
    assert.equal(user.value, true);
    assert.equal(user.default, false);
    const def = explainOption('step_budget');
    assert.equal(def.source, 'default');
    assert.equal(def.value, true);
    assert.equal(def.detail, null);
    const empty = explainOption('delegation_guard');
    assert.equal(empty.source, 'home');
    assert.equal(empty.empty, true);
    assert.equal(empty.value, 'warn', 'an empty string reads as unset: the declared default');
    const unknown = explainOption('no_such_option');
    assert.equal(unknown.declared, false);
    assert.equal(unknown.source, 'default');
    // opt() and explainOption() agree on every declared option
    for (const o of declaredOptions()) {
      const e = explainOption(o.key);
      if (o.default !== undefined) assert.deepEqual(e.value, opt(o.key, o.default), o.key);
    }
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- config folder

test('configFilePath: config/ first; the six old top-level names fall back to the old place; config/ wins when both exist', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    assert.deepEqual([...LEGACY_TOPLEVEL_CONFIG_FILES].sort(), ['compaction.json', 'leak-tokens.txt', 'model-pricing.json', 'model-tiers.json', 'plan-weights.json', 'rollout.json']);
    mkdirSync(join(root, 'config'), { recursive: true });
    for (const name of LEGACY_TOPLEVEL_CONFIG_FILES) {
      // neither exists: where a new file goes
      assert.equal(configFilePath(name), join(root, 'config', name), `${name} new`);
      // only the old one
      writeFileSync(join(root, name), 'old');
      assert.equal(configFilePath(name), join(root, name), `${name} old`);
      // both
      writeFileSync(join(root, 'config', name), 'new');
      assert.equal(configFilePath(name), join(root, 'config', name), `${name} both`);
    }
    // a name that was never top-level does not look there
    writeFileSync(join(root, 'brevity.json'), 'stray');
    assert.equal(configFilePath('brevity.json'), join(root, 'config', 'brevity.json'));
    // pure: asking creates nothing
    assert.equal(existsSync(join(root, 'config', 'brevity.json')), false);
  } finally { s.done(); }
});

test('configFileStatus: path in effect, existence, old location, shadowed old copy', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'model-tiers.json'), '{}'); // old only
    writeFileSync(join(root, 'plan-weights.json'), '{}'); // both
    writeFileSync(join(root, 'config', 'plan-weights.json'), '{}');
    writeFileSync(join(root, 'config', 'brevity.json'), '{}'); // new only
    const st = Object.fromEntries(configFileStatus().map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(st), KNOWN_CONFIG_FILES.map((f) => f.name));
    assert.deepEqual([st['model-tiers.json'].exists, st['model-tiers.json'].oldLocation, st['model-tiers.json'].shadowedOld], [true, true, false]);
    assert.equal(st['model-tiers.json'].path, join(root, 'model-tiers.json'));
    assert.deepEqual([st['plan-weights.json'].exists, st['plan-weights.json'].oldLocation, st['plan-weights.json'].shadowedOld], [true, false, true]);
    assert.equal(st['plan-weights.json'].path, join(root, 'config', 'plan-weights.json'));
    assert.deepEqual([st['brevity.json'].exists, st['brevity.json'].oldLocation, st['brevity.json'].shadowedOld], [true, false, false]);
    assert.deepEqual([st['rollout.json'].exists, st['rollout.json'].oldLocation], [false, false]);
    assert.equal(st['rollout.json'].path, join(root, 'config', 'rollout.json'));
    assert.equal(st['settings.json'].path, settingsHomePath());
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- loaders

// Old place only, new place only, both: each loader reads the right file.
function placeFile(root, name, where, body) {
  const dir = where === 'config' ? join(root, 'config') : root;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

test('plan-weights.json: old location still read; config/ wins when both exist', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    const read = () => { _resetPlanWeightsForTests(); return planWeights().unitsPerPercent.value; };
    placeFile(root, 'plan-weights.json', 'old', JSON.stringify({ unitsPerPercent: { value: 31 } }));
    assert.equal(read(), 31);
    placeFile(root, 'plan-weights.json', 'config', JSON.stringify({ unitsPerPercent: { value: 32 } }));
    assert.equal(read(), 32);
  } finally { _resetPlanWeightsForTests(); s.done(); }
});

test('model-pricing.json: old location still read; config/ wins when both exist', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    const read = () => { _resetPricingCacheForTests(); return pricingTable().zzMarker; };
    assert.equal(read(), undefined);
    placeFile(root, 'model-pricing.json', 'old', JSON.stringify({ zzMarker: 'old' }));
    assert.equal(read(), 'old');
    placeFile(root, 'model-pricing.json', 'config', JSON.stringify({ zzMarker: 'config' }));
    assert.equal(read(), 'config');
  } finally { _resetPricingCacheForTests(); s.done(); }
});

test('compaction.json: old location still read; config/ wins when both exist', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    const read = () => { _resetCompactionConfigForTests(); return compactionConfig().zzMarker; };
    assert.equal(read(), undefined);
    placeFile(root, 'compaction.json', 'old', JSON.stringify({ zzMarker: 'old' }));
    assert.equal(read(), 'old');
    placeFile(root, 'compaction.json', 'config', JSON.stringify({ zzMarker: 'config' }));
    assert.equal(read(), 'config');
  } finally { _resetCompactionConfigForTests(); s.done(); }
});

test('rollout.json: every reader (context-ceiling, usage events) takes the old location, then config/ when both exist', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    const now = Date.parse('2026-06-01T00:00:00Z');
    assert.equal(rolloutActive('zz-change', now), false);
    assert.equal(rolloutFile(), join(root, 'rollout.json'), 'neither exists: the reader path stays what it always was');
    placeFile(root, 'rollout.json', 'old', JSON.stringify({ 'zz-change': '2026-01-01T00:00:00Z' }));
    assert.equal(rolloutFile(), join(root, 'rollout.json'));
    assert.equal(rolloutActive('zz-change', now), true);
    assert.equal(loadEventSources(root).rolloutMs('zz-change'), Date.parse('2026-01-01T00:00:00Z'));
    placeFile(root, 'rollout.json', 'config', JSON.stringify({ 'zz-change': '2026-12-01T00:00:00Z' }));
    assert.equal(rolloutFile(), join(root, 'config', 'rollout.json'));
    assert.equal(rolloutActive('zz-change', now), false, 'config/ wins: not yet active');
    assert.equal(loadEventSources(root).rolloutMs('zz-change'), Date.parse('2026-12-01T00:00:00Z'));
  } finally { s.done(); }
});

test('model-tiers.json: old location still read; config/ wins when both exist (fresh process: modelTiers() caches)', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    const code = `import(${JSON.stringify(pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs')).href)}).then((m) => { process.stdout.write(String(m.modelTiers().zzMarker)); });`;
    const read = () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(read(), 'undefined');
    placeFile(root, 'model-tiers.json', 'old', JSON.stringify({ zzMarker: 'old' }));
    assert.equal(read(), 'old');
    placeFile(root, 'model-tiers.json', 'config', JSON.stringify({ zzMarker: 'config' }));
    assert.equal(read(), 'config');
  } finally { s.done(); }
});

test('leak-tokens.txt: the default token file is looked for in config/ first, then the old place', () => {
  const s = sandbox();
  try {
    const root = stateRootPath();
    placeFile(root, 'leak-tokens.txt', 'old', 'zz-token\n');
    assert.equal(configFilePath('leak-tokens.txt', root), join(root, 'leak-tokens.txt'));
    placeFile(root, 'leak-tokens.txt', 'config', 'zz-token\n');
    assert.equal(configFilePath('leak-tokens.txt', root), join(root, 'config', 'leak-tokens.txt'));
  } finally { s.done(); }
});

// ---------------------------------------------------------------------------------------------------- writer

test('plan-weights.json writer: updates the copy that exists, never makes a second one; a new file goes to config/', () => {
  const patch = { unitsPerPercent: { value: 29.5, status: 'measured' } };
  // nothing yet: config/
  let s = sandbox();
  try {
    const root = stateRootPath();
    const written = writeUserFile(patch);
    assert.equal(written, join(root, 'config', 'plan-weights.json'));
    assert.equal(existsSync(join(root, 'plan-weights.json')), false, 'no top-level copy');
    assert.equal(JSON.parse(readFileSync(written, 'utf8')).unitsPerPercent.value, 29.5);
  } finally { s.done(); }
  // old place only: stays there
  s = sandbox();
  try {
    const root = stateRootPath();
    placeFile(root, 'plan-weights.json', 'old', JSON.stringify({ custom: { keep: true } }));
    const written = writeUserFile(patch);
    assert.equal(written, join(root, 'plan-weights.json'));
    assert.equal(existsSync(join(root, 'config', 'plan-weights.json')), false, 'no second copy in config/');
    const j = JSON.parse(readFileSync(written, 'utf8'));
    assert.equal(j.custom.keep, true);
    assert.equal(j.unitsPerPercent.value, 29.5);
  } finally { s.done(); }
  // both: config/ is updated, the old one is left as it was
  s = sandbox();
  try {
    const root = stateRootPath();
    placeFile(root, 'plan-weights.json', 'old', JSON.stringify({ custom: { old: true } }));
    placeFile(root, 'plan-weights.json', 'config', JSON.stringify({ custom: { cfg: true } }));
    const written = writeUserFile(patch);
    assert.equal(written, join(root, 'config', 'plan-weights.json'));
    assert.equal(JSON.parse(readFileSync(written, 'utf8')).unitsPerPercent.value, 29.5);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'plan-weights.json'), 'utf8')), { custom: { old: true } });
  } finally { s.done(); }
});
