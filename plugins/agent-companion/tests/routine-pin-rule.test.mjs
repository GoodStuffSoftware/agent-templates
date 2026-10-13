// Routine pin rule: cloud deny without a model (hooks/cloud-routine-pin.mjs), the local create
// check (hooks/routine-pin-check.mjs) and the pin-applicability part of the placement note.
// Fixtures only; no RemoteTrigger or scheduled-task tool is ever called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

const CLOUD = 'hooks/cloud-routine-pin.mjs';
const CHECK = 'hooks/routine-pin-check.mjs';
const PLACE = 'hooks/routine-placement.mjs';
const RT = 'RemoteTrigger';
const CREATE = 'mcp__scheduled-tasks__create_scheduled_task';
const UPDATE = 'mcp__scheduled-tasks__update_scheduled_task';
const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
const jc = (model) => ({ ccr: { session_context: model === undefined ? {} : { model } } });

test('cloud create with job_config and no model: denied, with the three instructions', () => {
  const fx = makeFixture();
  try {
    for (const model of [undefined, '', '  ']) {
      const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'create', body: { name: 'x', job_config: jc(model) } }, cwd: fx.dir });
      const o = r.json.hookSpecificOutput;
      assert.equal(o.permissionDecision, 'deny');
      assert.ok(o.permissionDecisionReason.includes('/ac recommend'));
      assert.ok(o.permissionDecisionReason.includes('alias'));
      assert.ok(o.permissionDecisionReason.includes('no effort field'));
    }
    const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'update', body: { job_config: { ccr: {} } } }, cwd: fx.dir });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('cloud create with an alias model: passes silently', () => {
  const fx = makeFixture();
  try {
    const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'create', body: { job_config: jc('sonnet') } }, cwd: fx.dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('cloud update with no job_config, other actions and unparseable input: pass', () => {
  const fx = makeFixture();
  try {
    for (const input of [
      { action: 'update', trigger_id: 't', body: { enabled: false } },
      { action: 'list' },
      { action: 'get', trigger_id: 't' },
      { action: 'update', body: '{not json' },
      { action: 'create', body: 42 },
      'garbage',
    ]) {
      const r = runHook(CLOUD, { tool_name: RT, tool_input: input, cwd: fx.dir });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', JSON.stringify(input));
    }
    assert.equal(runHook(CLOUD, undefined).status, 0);
  } finally { fx.cleanup(); }
});

test('cloud body given as a JSON string is read the same way', () => {
  const fx = makeFixture();
  try {
    const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'create', body: JSON.stringify({ job_config: jc('') }) }, cwd: fx.dir });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fx.cleanup(); }
});

test('cloud full pinned id: non-blocking note naming the id, no decision', () => {
  const fx = makeFixture();
  try {
    const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'create', body: { job_config: jc('claude-sonnet-5') } }, cwd: fx.dir });
    const o = r.json.hookSpecificOutput;
    assert.equal(o.permissionDecision, undefined);
    assert.ok(o.additionalContext.includes('claude-sonnet-5'));
    assert.ok(o.additionalContext.includes('alias'));
  } finally { fx.cleanup(); }
});

test('cloud option off: a modelless job_config passes', () => {
  const fx = makeFixture();
  try {
    const r = runHook(CLOUD, { tool_name: RT, tool_input: { action: 'create', body: { job_config: jc('') } }, cwd: fx.dir },
      { env: { CLAUDE_PLUGIN_OPTION_ROUTINE_PIN_RULE: 'false' } });
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

function task(fx, id, model) {
  const d = join(fx.dir, '.claude', 'scheduled-tasks', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n${model ? `model: ${model}\n` : ''}---\nBody\n`);
}

test('post-create: SKILL.md without model: gets an instruction with the exact path', () => {
  const fx = makeFixture();
  try {
    task(fx, 'new-t', null);
    const r = runHook(CHECK, { tool_name: CREATE, tool_input: { taskId: 'new-t', prompt: 'x' }, tool_response: 'ok', cwd: fx.dir });
    const c = ctx(r);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(c.includes('scheduled-tasks/new-t/SKILL.md'), c);
    assert.ok(c.includes('model: <alias>') && c.includes('description:'));
  } finally { fx.cleanup(); }
});

test('post-create: task id taken from the result path when the input has none', () => {
  const fx = makeFixture();
  try {
    task(fx, 'from-result', null);
    const r = runHook(CHECK, { tool_name: CREATE, tool_input: { prompt: 'x' }, tool_response: { content: [{ type: 'text', text: 'Created D:\\data\\.claude\\scheduled-tasks\\from-result\\SKILL.md' }] }, cwd: fx.dir });
    assert.ok(ctx(r).includes('scheduled-tasks/from-result/SKILL.md'));
  } finally { fx.cleanup(); }
});

test('post-create: with a model, an unreadable file, other tools or the option off: silent', () => {
  const fx = makeFixture();
  try {
    task(fx, 'pinned', 'sonnet');
    assert.equal(runHook(CHECK, { tool_name: CREATE, tool_input: { taskId: 'pinned' }, cwd: fx.dir }).stdout.trim(), '');
    assert.equal(runHook(CHECK, { tool_name: CREATE, tool_input: { taskId: 'absent' }, cwd: fx.dir }).stdout.trim(), '');
    assert.equal(runHook(CHECK, { tool_name: CREATE, tool_input: {}, cwd: fx.dir }).stdout.trim(), '');
    assert.equal(runHook(CHECK, { tool_name: UPDATE, tool_input: { taskId: 'pinned' }, cwd: fx.dir }).stdout.trim(), '');
    task(fx, 'bare', null);
    const off = runHook(CHECK, { tool_name: CREATE, tool_input: { taskId: 'bare' }, cwd: fx.dir },
      { env: { CLAUDE_PLUGIN_OPTION_ROUTINE_PIN_RULE: 'false' } });
    assert.equal(off.stdout.trim(), '');
    assert.equal(runHook(CHECK, undefined).status, 0);
  } finally { fx.cleanup(); }
});

function folder(fx, name, settings, mapFile) {
  const dir = join(fx.dir, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (settings) writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings));
  if (mapFile) {
    const d = join(fx.stateDir, 'config');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'routine-pins.json'), JSON.stringify({ folders: mapFile }));
  }
  return dir;
}

test('placement note, applicable pin: top-level effortLevel, and the rule text with the path', () => {
  const fx = makeFixture();
  try {
    const cwd = folder(fx, 'top', { effortLevel: 'low' });
    const n = ctx(runHook(PLACE, { tool_name: CREATE, tool_input: { taskId: 'abc', prompt: 'x' }, cwd }));
    assert.ok(n.includes('all routines are evaluated and pinned'), n);
    assert.ok(n.includes('/ac recommend'));
    assert.ok(n.includes('right after `description:`') && n.includes('scheduled-tasks/abc/SKILL.md'));
    assert.ok(n.includes('this folder\'s pin applies (top-level effortLevel low'));
    assert.ok(!n.includes('global default effort'));
  } finally { fx.cleanup(); }
});

test('placement note, update on a task whose model matches the pin key: applies; mismatch: does not', () => {
  const fx = makeFixture();
  try {
    const tiers = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8')).tiers;
    const id = tiers.sonnet.resolvesTo.modelId;
    const cwd = folder(fx, 'keyed', { modelSettings: { [id]: { effortLevel: 'low' } } }, { low: 'C:/pins/low' });
    task(fx, 'on-sonnet', 'sonnet');
    task(fx, 'on-opus', 'opus');
    const hit = ctx(runHook(PLACE, { tool_name: UPDATE, tool_input: { taskId: 'on-sonnet', prompt: 'x' }, cwd }));
    assert.ok(hit.includes('pin applies (low for the task\'s model)'), hit);
    const miss = ctx(runHook(PLACE, { tool_name: UPDATE, tool_input: { taskId: 'on-opus', prompt: 'x' }, cwd }));
    assert.ok(miss.includes('no pin applies in this folder'), miss);
    assert.ok(miss.includes('global default effort'));
    assert.ok(miss.includes('low=C:/pins/low'));
  } finally { fx.cleanup(); }
});

test('placement note, no pin at all: names the pin folders and warns about the global default', () => {
  const fx = makeFixture();
  try {
    const cwd = folder(fx, 'plain', null, { low: 'C:/pins/low', high: 'C:/pins/high' });
    const n = ctx(runHook(PLACE, { tool_name: CREATE, tool_input: { taskId: 'z', prompt: 'x' }, cwd }));
    assert.ok(n.includes('no pin applies in this folder'), n);
    assert.ok(n.includes('global default effort'));
    assert.ok(n.includes('high=C:/pins/high'));
  } finally { fx.cleanup(); }
});

test('placement note, create in a model-keyed folder (model not known yet): says it depends on the task model', () => {
  const fx = makeFixture();
  try {
    const cwd = folder(fx, 'maybe', { modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } });
    const n = ctx(runHook(PLACE, { tool_name: CREATE, tool_input: { taskId: 'q', prompt: 'x' }, cwd }));
    assert.ok(n.includes('applies only if the task\'s model resolves to'), n);
  } finally { fx.cleanup(); }
});

test('hook registrations: RemoteTrigger pre, scheduled-task create post, option declared', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = h.PreToolUse.find((e) => JSON.stringify(e).includes('cloud-routine-pin.mjs'));
  assert.ok(pre && new RegExp(pre.matcher).test('RemoteTrigger'));
  assert.ok(!new RegExp(pre.matcher).test('Agent'));
  const post = h.PostToolUse.find((e) => JSON.stringify(e).includes('routine-pin-check.mjs'));
  const re = new RegExp(post.matcher);
  assert.ok(re.test(CREATE) && !re.test(UPDATE));
  const pj = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(pj.userConfig.routine_pin_rule.default, true);
  const placement = h.PreToolUse.find((e) => JSON.stringify(e).includes('routine-placement.mjs'));
  assert.ok(new RegExp(placement.matcher).test(UPDATE));
});
