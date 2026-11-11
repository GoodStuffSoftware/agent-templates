// scripts/settings.mjs (`/ac settings`): list, get, set, unset, where, migrate, driven as child processes with scratch
// state; plus the stage-2 readers around the settings home: the journal digest, the resource-rules path, a hook.
//
// Every fixture is its own temp home (makeFixture). Nothing here reads or writes the operator's real ~/.claude or
// ~/.claude/agent-companion. Project and option values are invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { resetSettingsHomeCache } from '../hooks/lib/context.mjs';
import { observeSettings } from '../hooks/lib/settings-journal.mjs';
import { userRulesPath, loadRules } from '../scripts/lib/resource-rules.mjs';

const CLI = join(PLUGIN_ROOT, 'scripts', 'settings.mjs');
const CONTEXT_URL = pathToFileURL(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs')).href;

function childEnv(fx, extra = {}) {
  const env = { ...process.env, AGENT_COMPANION_HOME_OVERRIDE: fx.dir, AGENT_COMPANION_STATE_DIR: fx.stateDir, CLAUDE_CONFIG_DIR: join(fx.dir, '.claude') };
  for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
  return { ...env, ...extra };
}

function cli(fx, args, { env = {}, node = [] } = {}) {
  const r = spawnSync(process.execPath, [...node, CLI, ...args], { encoding: 'utf8', windowsHide: true, cwd: fx.dir, env: childEnv(fx, env), timeout: 30000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const homeFile = (fx) => join(fx.stateDir, 'config', 'settings.json');
const claudeSettings = (fx) => join(fx.dir, '.claude', 'settings.json');
const readHome = (fx) => readFileSync(homeFile(fx), 'utf8');
function writeHome(fx, text) { mkdirSync(join(fx.stateDir, 'config'), { recursive: true }); writeFileSync(homeFile(fx), text); }
function writeClaudeSettings(fx, obj) { mkdirSync(join(fx.dir, '.claude'), { recursive: true }); writeFileSync(claudeSettings(fx), JSON.stringify(obj, null, 2)); }

// A manifest with a sensitive option, loaded into the CLI process through --import (the seam context.mjs offers tests).
function sensitiveManifest(fx) {
  const manifest = join(fx.dir, 'fixture-plugin.json');
  writeFileSync(manifest, JSON.stringify({
    name: 'agent-companion',
    userConfig: {
      secret_token: { type: 'string', title: 'Secret', sensitive: true, default: '' },
      normal_flag: { type: 'boolean', title: 'Flag', default: false },
    },
  }));
  const pre = join(fx.dir, 'preload.mjs');
  writeFileSync(pre, `import { setManifestPathForTests } from ${JSON.stringify(CONTEXT_URL)};\nsetManifestPathForTests(${JSON.stringify(manifest)});\n`);
  return { node: ['--import', pathToFileURL(pre).href] };
}

test('a fresh install: every subcommand works, exits 0 and creates nothing', () => {
  const fx = makeFixture();
  try {
    for (const args of [['list'], ['list', '--all'], ['get', 'main_compact_floor_tokens'], ['where'], ['migrate', '--dry-run'], ['migrate'], ['unset', 'scout_suppress']]) {
      const r = cli(fx, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.err}`);
      assert.equal(r.err, '');
    }
    assert.ok(!existsSync(join(fx.stateDir, 'config')), 'no home folder was created');
    const list = cli(fx, ['list']);
    assert.match(list.out, /none: every option is at its declared default/);
    assert.match(list.out, /settings\.json: .*\(not present\)/);
    const all = cli(fx, ['list', '--all']);
    assert.match(all.out, /main_compact_floor_tokens = 0/);
    assert.match(all.out, /All 1\d\d options:/);
  } finally { fx.cleanup(); }
});

test('bad arguments print one usage line and exit 2', () => {
  const fx = makeFixture();
  try {
    for (const args of [['frobnicate'], ['get'], ['set', 'one'], ['set', 'a', 'b', 'c'], ['unset'], ['where', 'x'], ['list', '--bogus'], ['migrate', '--wet']]) {
      const r = cli(fx, args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.err, /^Usage: settings\.mjs /);
      assert.equal(r.err.trim().split('\n').length, 1);
    }
    assert.equal(cli(fx, []).status, 0);
  } finally { fx.cleanup(); }
});

test('where prints paths only', () => {
  const fx = makeFixture();
  try {
    writeClaudeSettings(fx, { pluginConfigs: { 'agent-companion@scratch-market': { options: { scout_suppress: 'secret-looking-value' } } } });
    const r = cli(fx, ['where']);
    assert.match(r.out, new RegExp(`home folder: .*config`));
    assert.ok(r.out.includes(homeFile(fx)));
    assert.ok(r.out.includes(claudeSettings(fx)));
    assert.ok(!r.out.includes('secret-looking-value'));
  } finally { fx.cleanup(); }
});

test('set writes the home file, keeps other entries, and get/list/unset follow', () => {
  const fx = makeFixture();
  try {
    let r = cli(fx, ['set', 'main_compact_floor_tokens', '400000']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Set main_compact_floor_tokens = 400000/);
    assert.deepEqual(JSON.parse(readHome(fx)), { main_compact_floor_tokens: 400000 });
    r = cli(fx, ['set', 'bash_exit_telemetry', 'false']);
    assert.equal(r.status, 0, r.err);
    r = cli(fx, ['set', 'scout_suppress', 'a b']);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(JSON.parse(readHome(fx)), { main_compact_floor_tokens: 400000, bash_exit_telemetry: false, scout_suppress: 'a b' });
    const get = cli(fx, ['get', 'bash_exit_telemetry']);
    assert.match(get.out, /bash_exit_telemetry = false/);
    assert.match(get.out, /from:\s+the home file/);
    assert.match(get.out, /default: true/);
    const list = cli(fx, ['list']);
    assert.match(list.out, /3 of \d+/);
    const un = cli(fx, ['unset', 'bash_exit_telemetry']);
    assert.equal(un.status, 0, un.err);
    assert.match(un.out, /falls back to true \(from the declared default\)/);
    assert.deepEqual(JSON.parse(readHome(fx)), { main_compact_floor_tokens: 400000, scout_suppress: 'a b' });
    const again = cli(fx, ['unset', 'bash_exit_telemetry']);
    assert.equal(again.status, 0);
    assert.match(again.out, /not set in the home file/);
  } finally { fx.cleanup(); }
});

test('get names a source that is overridden', () => {
  const fx = makeFixture();
  try {
    writeClaudeSettings(fx, { pluginConfigs: { 'agent-companion@scratch-market': { options: { main_compact_floor_tokens: 250000 } } } });
    let r = cli(fx, ['get', 'main_compact_floor_tokens']);
    assert.match(r.out, /= 250000/);
    assert.match(r.out, /Claude Code plugin options \(settings\.json\)/);
    assert.match(r.out, /no other source sets it/);
    cli(fx, ['set', 'main_compact_floor_tokens', '400000']);
    r = cli(fx, ['get', 'main_compact_floor_tokens']);
    assert.match(r.out, /= 400000/);
    assert.match(r.out, /from:\s+the home file/);
    assert.match(r.out, /also set \(not used/);
    assert.match(r.out, /settings\.json\): .* = 250000/);
    r = cli(fx, ['get', 'main_compact_floor_tokens'], { env: { CLAUDE_PLUGIN_OPTION_MAIN_COMPACT_FLOOR_TOKENS: '300000' } });
    assert.match(r.out, /CLAUDE_PLUGIN_OPTION_MAIN_COMPACT_FLOOR_TOKENS = "?300000/);
  } finally { fx.cleanup(); }
});

test('set keeps the file formatting: indent, line endings, key order, unknown entries', () => {
  const fx = makeFixture();
  try {
    writeHome(fx, '{\r\n    "scout_suppress": "x",\r\n    "not_an_option": 7,\r\n    "bash_exit_telemetry": true\r\n}\r\n');
    const r = cli(fx, ['set', 'bash_exit_telemetry', 'false']);
    assert.equal(r.status, 0, r.err);
    assert.equal(readHome(fx), '{\r\n    "scout_suppress": "x",\r\n    "not_an_option": 7,\r\n    "bash_exit_telemetry": false\r\n}\r\n');
    cli(fx, ['set', 'main_compact_floor_tokens', '150000']);
    assert.equal(readHome(fx), '{\r\n    "scout_suppress": "x",\r\n    "not_an_option": 7,\r\n    "bash_exit_telemetry": false,\r\n    "main_compact_floor_tokens": 150000\r\n}\r\n');
    writeHome(fx, '{"scout_suppress":"x"}');
    cli(fx, ['set', 'main_compact_floor_tokens', '150000']);
    assert.equal(readHome(fx), '{"scout_suppress":"x","main_compact_floor_tokens":150000}\n');
  } finally { fx.cleanup(); }
});

test('set refuses an unknown key (with nearest names), a wrong type and an invalid home file', () => {
  const fx = makeFixture();
  try {
    let r = cli(fx, ['set', 'compact_floor_tokens', '400000']);
    assert.equal(r.status, 1);
    assert.match(r.err, /not an option this plugin declares/);
    assert.match(r.err, /Nearest names: main_compact_floor_tokens/);
    r = cli(fx, ['set', 'main_compact_floor_tokens', 'lots']);
    assert.equal(r.status, 1);
    assert.match(r.err, /is a number/);
    r = cli(fx, ['set', 'bash_exit_telemetry', 'maybe']);
    assert.equal(r.status, 1);
    assert.match(r.err, /true or false/);
    assert.ok(!existsSync(homeFile(fx)), 'a refused set writes nothing');
    for (const bad of ['{ not json', '[1,2]', '"text"']) {
      writeHome(fx, bad);
      r = cli(fx, ['set', 'main_compact_floor_tokens', '400000']);
      assert.equal(r.status, 1, bad);
      assert.match(r.err, /Nothing was written/);
      assert.equal(readHome(fx), bad, 'the invalid file is untouched');
      r = cli(fx, ['unset', 'main_compact_floor_tokens']);
      assert.equal(r.status, 1, bad);
      assert.equal(readHome(fx), bad);
    }
  } finally { fx.cleanup(); }
});

test('set refuses a sensitive option (fixture manifest) and accepts the others', () => {
  const fx = makeFixture();
  try {
    const seam = sensitiveManifest(fx);
    let r = cli(fx, ['set', 'secret_token', 'abc123'], seam);
    assert.equal(r.status, 1);
    assert.match(r.err, /sensitive option/);
    assert.ok(!r.err.includes('abc123') && !r.out.includes('abc123'));
    assert.ok(!existsSync(homeFile(fx)));
    r = cli(fx, ['set', 'normal_flag', 'true'], seam);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(JSON.parse(readHome(fx)), { normal_flag: true });
    r = cli(fx, ['list', '--all'], seam);
    assert.match(r.out, /All 2 options/);
  } finally { fx.cleanup(); }
});

test('list reports problems in the home file and old-place config files', () => {
  const fx = makeFixture();
  try {
    writeHome(fx, JSON.stringify({ main_compact_floor_tokens: 'not a number', mystery_key: 1 }));
    writeFileSync(join(fx.stateDir, 'rollout.json'), '{}');
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'plan-weights.json'), '{}');
    writeFileSync(join(fx.stateDir, 'config', 'plan-weights.json'), '{}');
    const r = cli(fx, ['list']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /rollout\.json: .*\[OLD PLACE/);
    assert.match(r.out, /plan-weights\.json: .*config.*\(present\)  \[an old copy at .* is shadowed/);
    assert.match(r.out, /"main_compact_floor_tokens" must be a number/);
    assert.match(r.out, /"mystery_key" is not an option/);
  } finally { fx.cleanup(); }
});

function migrateFixture(fx) {
  writeClaudeSettings(fx, {
    model: 'some-model',
    pluginConfigs: {
      'agent-companion@scratch-market': {
        options: {
          main_compact_floor_tokens: 987654,
          scout_suppress: 'zz-private-value',
          bash_exit_telemetry: false,
          read_dedupe: 'not a boolean',
          no_such_option: 'zz-other-value',
        },
      },
      'someone-else@scratch-market': { options: { main_compact_floor_tokens: 1 } },
    },
  });
  writeHome(fx, JSON.stringify({ scout_suppress: 'kept-in-home' }, null, 2) + '\n');
  writeFileSync(join(fx.stateDir, 'rollout.json'), '{"change-a":"2026-01-01T00:00:00Z"}');
  writeFileSync(join(fx.stateDir, 'leak-tokens.txt'), 'old-token\n');
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  writeFileSync(join(fx.stateDir, 'plan-weights.json'), '{"old":true}');
  writeFileSync(join(fx.stateDir, 'config', 'plan-weights.json'), '{"new":true}');
}

test('migrate --dry-run changes nothing and prints key names only', () => {
  const fx = makeFixture();
  try {
    migrateFixture(fx);
    const settingsBefore = readFileSync(claudeSettings(fx));
    const homeBefore = readHome(fx);
    const r = cli(fx, ['migrate', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /dry run/);
    assert.match(r.out, /would copy \(2\): main_compact_floor_tokens, bash_exit_telemetry/);
    assert.match(r.out, /already in the home file, kept as they are \(1\): scout_suppress/);
    assert.match(r.out, /skipped, not an option this plugin declares \(1\): no_such_option/);
    assert.match(r.out, /skipped, value does not match the declared type \(1\): read_dedupe/);
    assert.match(r.out, /would move \(2\): rollout\.json, leak-tokens\.txt/);
    assert.match(r.out, /not moved.*: plan-weights\.json/);
    assert.match(r.out, /may now remove these option keys there/);
    for (const v of ['987654', 'zz-private-value', 'zz-other-value', 'kept-in-home', 'old-token']) assert.ok(!r.out.includes(v), `value ${v} not printed`);
    assert.deepEqual(readFileSync(claudeSettings(fx)), settingsBefore);
    assert.equal(readHome(fx), homeBefore);
    assert.ok(existsSync(join(fx.stateDir, 'rollout.json')));
    assert.ok(!existsSync(join(fx.stateDir, 'config', 'rollout.json')));
  } finally { fx.cleanup(); }
});

test('migrate copies options, keeps existing home keys, moves files, overwrites nothing, never edits Claude settings', () => {
  const fx = makeFixture();
  try {
    migrateFixture(fx);
    const settingsBefore = readFileSync(claudeSettings(fx));
    const r = cli(fx, ['migrate']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /copied \(2\): main_compact_floor_tokens, bash_exit_telemetry/);
    assert.match(r.out, /moved \(2\): rollout\.json, leak-tokens\.txt/);
    for (const v of ['987654', 'zz-private-value', 'zz-other-value', 'kept-in-home']) assert.ok(!r.out.includes(v), `value ${v} not printed`);
    assert.deepEqual(JSON.parse(readHome(fx)), { scout_suppress: 'kept-in-home', main_compact_floor_tokens: 987654, bash_exit_telemetry: false });
    assert.deepEqual(readFileSync(claudeSettings(fx)), settingsBefore, 'Claude Code settings byte-identical');
    assert.ok(!existsSync(join(fx.stateDir, 'rollout.json')));
    assert.equal(readFileSync(join(fx.stateDir, 'config', 'rollout.json'), 'utf8'), '{"change-a":"2026-01-01T00:00:00Z"}');
    assert.equal(readFileSync(join(fx.stateDir, 'config', 'leak-tokens.txt'), 'utf8'), 'old-token\n');
    assert.equal(readFileSync(join(fx.stateDir, 'config', 'plan-weights.json'), 'utf8'), '{"new":true}', 'existing config/ copy not overwritten');
    assert.equal(readFileSync(join(fx.stateDir, 'plan-weights.json'), 'utf8'), '{"old":true}', 'old copy left alone');
    const again = cli(fx, ['migrate']);
    assert.equal(again.status, 0);
    assert.match(again.out, /already in the home file, kept as they are \(3\)/);
    assert.match(again.out, /no plugin options|may now remove/);
    assert.deepEqual(JSON.parse(readHome(fx)), { scout_suppress: 'kept-in-home', main_compact_floor_tokens: 987654, bash_exit_telemetry: false });
  } finally { fx.cleanup(); }
});

test('migrate never copies a sensitive option (fixture manifest) and reports a bad home file as an error', () => {
  const fx = makeFixture();
  try {
    const seam = sensitiveManifest(fx);
    writeClaudeSettings(fx, { pluginConfigs: { 'agent-companion@scratch-market': { options: { secret_token: 'topsecret-1', normal_flag: true } } } });
    let r = cli(fx, ['migrate'], seam);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /skipped, sensitive \(1\): secret_token/);
    assert.ok(!r.out.includes('topsecret-1'));
    assert.deepEqual(JSON.parse(readHome(fx)), { normal_flag: true });
    writeHome(fx, '{ broken');
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), '{}');
    r = cli(fx, ['migrate']);
    assert.equal(r.status, 1);
    assert.match(r.out, /not valid JSON/);
    assert.equal(readHome(fx), '{ broken');
    assert.ok(existsSync(join(fx.stateDir, 'config', 'rollout.json')), 'files still move when the home file is bad');
  } finally { fx.cleanup(); }
});

test('a hook reads a value set with `set`', () => {
  const fx = makeFixture();
  try {
    const HOOK = 'hooks/bash-exit.mjs';
    const payload = { session_id: 'sess-sc', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: fx.dir,
      tool_input: { command: 'node scripts/ci-local.mjs' }, tool_response: { stdout: 'ok', stderr: '' } };
    const rows = () => { const f = join(fx.stateDir, 'telemetry', 'bash-exit.jsonl'); return existsSync(f) ? readJsonl(f) : []; };
    const noOpt = { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: 'off' };
    assert.equal(runHook(HOOK, payload, { env: noOpt }).status, 0);
    assert.equal(rows().length, 1, 'default: the hook records');
    assert.equal(cli(fx, ['set', 'bash_exit_telemetry', 'false']).status, 0);
    runHook(HOOK, payload, { env: noOpt });
    assert.equal(rows().length, 1, 'the home file value switched the hook off');
    assert.equal(cli(fx, ['unset', 'bash_exit_telemetry']).status, 0);
    runHook(HOOK, payload, { env: noOpt });
    assert.equal(rows().length, 2, 'unset: back to the default');
  } finally { fx.cleanup(); }
});

test('the journal option digest changes when the home file changes, and not for a reformat', () => {
  const fx = makeFixture();
  try {
    const digest = () => { resetSettingsHomeCache(); return observeSettings({}, { env: {}, dir: join(fx.dir, '.claude') }).options; };
    assert.equal(digest(), 'none', 'no home file: the digest is what it was before');
    writeHome(fx, '{"main_compact_floor_tokens": 400000}');
    const a = digest();
    assert.match(a, /^[0-9a-f]{12}$/);
    writeHome(fx, '{\n  "main_compact_floor_tokens": 400000\n}\n');
    assert.equal(digest(), a, 'same entries, different formatting: not a change');
    writeHome(fx, '{"main_compact_floor_tokens": 500000}');
    assert.notEqual(digest(), a);
    writeHome(fx, '{ not json');
    assert.equal(digest(), 'none', 'a malformed home file adds nothing');
  } finally { fx.cleanup(); }
});

test('a home file edit is journaled as an options change at the next session start', () => {
  const fx = makeFixture();
  try {
    const HOOK = 'hooks/settings-journal.mjs';
    const rows = () => { const f = join(fx.stateDir, 'telemetry', 'settings-changes.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
    const start = (sid) => ({ session_id: sid, cwd: '/work/alpha', source: 'startup', model: 'claude-opus-5-5' });
    runHook(HOOK, start('s1'));
    runHook(HOOK, start('s2'));
    assert.equal(rows().length, 1);
    assert.equal(cli(fx, ['set', 'main_compact_floor_tokens', '400000']).status, 0);
    runHook(HOOK, start('s3'));
    const got = rows();
    assert.equal(got.length, 2);
    assert.deepEqual(got[1].changed, ['options']);
  } finally { fx.cleanup(); }
});

test('resource-rules follows the state-dir override, like the rest of the plugin', () => {
  const fx = makeFixture();
  try {
    const state = join(fx.dir, 'custom-state');
    const cfg = join(fx.dir, 'cfg');
    const rules = join(state, 'config', 'resource-rules.json');
    assert.equal(userRulesPath({ AGENT_COMPANION_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg }), rules);
    assert.equal(userRulesPath({ CLAUDE_CONFIG_DIR: cfg }), join(cfg, 'agent-companion', 'config', 'resource-rules.json'));
    assert.equal(userRulesPath({ AC_RESOURCE_RULES: join(fx.dir, 'x.json'), AGENT_COMPANION_STATE_DIR: state }), join(fx.dir, 'x.json'));
    mkdirSync(join(state, 'config'), { recursive: true });
    writeFileSync(rules, JSON.stringify({ rules: [{ id: 'scratch-rule-from-state-dir', limit: 1 }] }));
    const loaded = loadRules({ AGENT_COMPANION_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg });
    assert.ok(loaded.rules.some((r) => r.id === 'scratch-rule-from-state-dir'), 'the user rules file under the state-dir override is read');
  } finally { fx.cleanup(); }
});
