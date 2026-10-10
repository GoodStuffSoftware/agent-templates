// Routine placement note (hooks/routine-placement.mjs): PreToolUse on the
// scheduled-task tools. Advisory only; every fixture lives in a temp home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { NOTE_MAX } from '../hooks/lib/routine-placement.mjs';

const CREATE = 'mcp__scheduled-tasks__create_scheduled_task';
const UPDATE = 'mcp__scheduled-tasks__update_scheduled_task';
const HOOK = 'hooks/routine-placement.mjs';

function pinFolder(fx, name, level) {
  const dir = join(fx.dir, name);
  if (level) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ modelSettings: { 'model-x': { effortLevel: level } } }));
  } else mkdirSync(dir, { recursive: true });
  return dir;
}
function writeConfig(fx, name, obj) {
  const d = join(fx.stateDir, 'config');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(obj));
}
const note = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

test('create in a pinned folder: pin, start effort, map, why line', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'low-folder', 'low');
    writeConfig(fx, 'routine-pins.json', { folders: { low: cwd, high: join(fx.dir, 'high-folder') } });
    writeConfig(fx, 'decision-register.json', { decisions: [{ id: 'routine-effort-pins' }] });
    const r = runHook(HOOK, { tool_name: CREATE, tool_input: { prompt: 'x' }, cwd });
    assert.equal(r.status, 0);
    const n = note(r);
    assert.ok(n.includes('folder effort pin: low'));
    assert.ok(n.includes('starts at low'));
    assert.ok(n.includes('map: low='));
    assert.ok(n.includes('/ac recommend'));
    assert.ok(n.includes('Why: decision `routine-effort-pins`'));
    assert.ok(n.length <= NOTE_MAX);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
  } finally { fx.cleanup(); }
});

test('create in an unpinned folder falls back to the user default, then the app default', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'plain', null);
    let r = runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd });
    assert.ok(note(r).includes('folder effort pin: none'));
    assert.ok(note(r).includes('starts at the app default'));
    assert.ok(!note(r).includes('Why:'));
    mkdirSync(join(fx.dir, '.claude'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'settings.json'),
      JSON.stringify({ modelSettings: { 'model-x': { effortLevel: 'xhigh' } } }));
    r = runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd });
    assert.ok(note(r).includes('folder effort pin: none'));
    assert.ok(note(r).includes('starts at xhigh'));
  } finally { fx.cleanup(); }
});

test('missing config: the rule is still given, without the map', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'p', 'high');
    const r = runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd });
    const n = note(r);
    assert.ok(n.includes('/ac recommend'));
    assert.ok(n.includes('folder effort pin: high'));
    assert.ok(!n.includes('map:'));
  } finally { fx.cleanup(); }
});

test('malformed config fails open to the no-map note', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'p', null);
    const d = join(fx.stateDir, 'config');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'routine-pins.json'), '{not json');
    const r = runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd });
    assert.equal(r.status, 0);
    assert.ok(!note(r).includes('map:'));
  } finally { fx.cleanup(); }
});

test('update without prompt: no note', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { tool_name: UPDATE, tool_input: { taskId: 't', enabled: false }, cwd: fx.dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('update with prompt: note', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { tool_name: UPDATE, tool_input: { taskId: 't', prompt: 'new' }, cwd: fx.dir });
    assert.ok(note(r).includes('Routine placement'));
  } finally { fx.cleanup(); }
});

test('option off: no note', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd: fx.dir },
      { env: { CLAUDE_PLUGIN_OPTION_ROUTINE_PLACEMENT_NOTE: 'false' } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('other tools and empty stdin: silent, exit 0', () => {
  const fx = makeFixture();
  try {
    assert.equal(runHook(HOOK, { tool_name: 'Bash', tool_input: {}, cwd: fx.dir }).stdout.trim(), '');
    assert.equal(runHook(HOOK, undefined).status, 0);
  } finally { fx.cleanup(); }
});

test('registered in hooks.json with a matcher for both tools, and declared in plugin.json', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((e) => JSON.stringify(e).includes('routine-placement.mjs'));
  assert.ok(entry);
  const re = new RegExp(entry.matcher);
  assert.ok(re.test(CREATE) && re.test(UPDATE));
  assert.ok(!re.test('mcp__scheduled-tasks__delete_scheduled_task'));
  const pj = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const o = pj.userConfig ? pj.userConfig.routine_placement_note : null;
  assert.equal(o && o.default, true);
});
