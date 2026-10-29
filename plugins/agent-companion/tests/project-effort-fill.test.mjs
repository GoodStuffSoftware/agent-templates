// Project-agent effort fill (project_effort_fill: autofix | off): a project or user agent whose definition sets a
// model but no effort, spawned with no effort of its own, gets updatedInput.effort set silently: the routing
// table's effort for the spawn's TYPE when that route is on the model that runs, else the model's own default.
// An effort in the spawn input or in the agent file always wins. One spawns.jsonl row records it; no message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runHook, readJsonl, decisionOf } from './helpers.mjs';
import { resolveRoute, modelTiers } from '../hooks/lib/context.mjs';

const agentFile = (fm) => `---\nname: x\n${fm}\n---\nbody\n`;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function setup() {
  const fx = makeFixture();
  const proj = join(fx.dir, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const pa = join(proj, '.claude', 'agents');
  put(join(pa, 'proj-haiku.md'), agentFile('model: haiku'));
  put(join(pa, 'proj-sonnet.md'), agentFile('model: sonnet'));
  put(join(pa, 'proj-opus.md'), agentFile('model: opus'));
  put(join(pa, 'proj-sonnet-effort.md'), agentFile('model: sonnet\neffort: low'));
  put(join(pa, 'proj-effortonly.md'), agentFile('effort: high'));
  put(join(pa, 'proj-inherit.md'), agentFile('model: inherit'));
  put(join(fx.dir, '.claude', 'agents', 'user-haiku.md'), agentFile('model: haiku'));
  return { ...fx, proj };
}

let counter = 0;
function spawn(fx, { type, prompt, extra, env } = {}) {
  counter += 1;
  const sid = `sess-effort-${process.pid}-${counter}`;
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: fx.proj,
    tool_input: { subagent_type: type, run_in_background: true, name: `w${counter}`, prompt, ...(extra || {}) },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...(env || {}) } });
  assert.equal(res.status, 0, res.stderr);
  const hso = res.json?.hookSpecificOutput || {};
  const spawns = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sid);
  return {
    res, sid, row: spawns[0] || null,
    decision: decisionOf(res.json),
    msg: res.json?.systemMessage || '',
    updated: hso.updatedInput || null,
    all: JSON.stringify(res.json || {}),
  };
}
const W = 'ROLE: writer\n';
const ownDefault = (alias) => modelTiers().tiers[alias].resolvesTo.defaultEffort;

test('premise: the live table gives lookup a haiku effort and bounded-feature a sonnet effort', () => {
  assert.equal(resolveRoute({ type: 'lookup' }).model, 'haiku');
  assert.ok(resolveRoute({ type: 'lookup' }).effort);
  assert.equal(resolveRoute({ type: 'bounded-feature' }).model, 'sonnet');
  assert.ok(resolveRoute({ type: 'bounded-feature' }).effort);
});

test('a model-only project agent on a TYPE whose route is on its model gets the table effort, silently, with one row', () => {
  const fx = setup();
  try {
    for (const [agent, type] of [['proj-haiku', 'lookup'], ['proj-sonnet', 'bounded-feature'], ['user-haiku', 'explore']]) {
      const r = spawn(fx, { type: agent, prompt: `TYPE: ${type}\n${W}do it` });
      assert.equal(r.decision, 'proceed', r.all);
      assert.equal(r.updated?.effort, resolveRoute({ type }).effort, `${agent}/${type}`);
      assert.equal(r.updated?.subagent_type, agent);
      assert.match(r.updated?.prompt || '', /do it/);
      assert.equal(r.msg, '', `${agent}: no visible message`);
      assert.doesNotMatch(r.all, /effort not|inherit/i, `${agent}: nothing about effort is said`);
      assert.equal(r.row?.spawn_effort_source, 'guard-fill');
      assert.equal(r.row?.spawn_effort, r.updated.effort);
      assert.equal(r.row?.effective_effort, r.updated.effort);
      assert.equal(r.row?.effort_definition, null);
      assert.ok((r.row?.silent_fixes || []).includes(`effort_filled:${r.updated.effort}`), JSON.stringify(r.row?.silent_fixes));
    }
  } finally { fx.cleanup(); }
});

test('no TYPE, or a TYPE routed to another model: the model\'s own default effort, not the other tier\'s', () => {
  const fx = setup();
  try {
    const none = spawn(fx, { type: 'proj-haiku', prompt: `${W}look around` });
    assert.equal(none.updated?.effort, ownDefault('haiku'), none.all);
    assert.equal(none.msg, '');
    const none2 = spawn(fx, { type: 'proj-sonnet', prompt: `${W}look around` });
    assert.equal(none2.updated?.effort, ownDefault('sonnet'), none2.all);
    // bounded-feature routes to sonnet; a haiku agent takes haiku's default, not sonnet's table effort.
    const other = spawn(fx, { type: 'proj-haiku', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(other.updated?.effort, ownDefault('haiku'), other.all);
  } finally { fx.cleanup(); }
});

test('an opus project agent rewritten to the table model by project_route_guard gets that model\'s effort', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-opus', prompt: `TYPE: bounded-feature\n${W}do it` });
    const route = resolveRoute({ type: 'bounded-feature' });
    assert.equal(r.updated?.model, route.model, r.all);
    assert.equal(r.updated?.effort, route.effort, r.all);
    assert.equal(r.msg, '');
  } finally { fx.cleanup(); }
});

test('an explicit effort in the spawn input, or in the agent file, always wins', () => {
  const fx = setup();
  try {
    const given = spawn(fx, { type: 'proj-haiku', prompt: `TYPE: lookup\n${W}do it`, extra: { effort: 'high' } });
    assert.ok(!given.updated || given.updated.effort === 'high', given.all);
    assert.notEqual(given.row?.spawn_effort_source, 'guard-fill');
    assert.ok(!(given.row?.silent_fixes || []).some((f) => /^effort_filled/.test(f)));
    const file = spawn(fx, { type: 'proj-sonnet-effort', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.ok(!file.updated || file.updated.effort === undefined, file.all);
    assert.equal(file.row?.spawn_effort_source, 'definition');
    assert.equal(file.row?.effort_definition, 'low');
  } finally { fx.cleanup(); }
});

test('not a model-only pin: an effort-only pin, a model: inherit agent and a ladder rung are left alone', () => {
  const fx = setup();
  try {
    for (const type of ['proj-effortonly', 'proj-inherit', 'agent-companion:ac-haiku']) {
      const r = spawn(fx, { type, prompt: `TYPE: lookup\n${W}do it` });
      assert.ok(!r.updated || r.updated.effort === undefined, `${type}: ${r.all}`);
      assert.ok(!(r.row?.silent_fixes || []).some((f) => /^effort_filled/.test(f)), type);
    }
  } finally { fx.cleanup(); }
});

test('off: nothing is filled', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-haiku', prompt: `TYPE: lookup\n${W}do it`, env: { CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
    assert.ok(!r.updated || r.updated.effort === undefined, r.all);
    assert.notEqual(r.row?.spawn_effort_source, 'guard-fill');
    assert.match(r.msg, /INHERIT/, 'off: the existing rule-1 note is unchanged');
  } finally { fx.cleanup(); }
});

test('built-in types: a model and no effort gets the table or tier-default effort, silently', () => {
  const fx = setup();
  try {
    const gp = spawn(fx, { type: 'general-purpose', prompt: `TYPE: operate\n${W}do it`, extra: { model: 'sonnet' } });
    assert.equal(gp.decision, 'proceed', gp.all);
    const route = resolveRoute({ type: 'operate' });
    const want = route.model === 'sonnet' ? route.effort : ownDefault('sonnet');
    assert.equal(gp.updated?.effort, want, gp.all);
    assert.equal(gp.updated?.model, 'sonnet');
    assert.equal(gp.msg, '');
    assert.equal(gp.row?.spawn_effort_source, 'guard-fill');
    assert.ok((gp.row?.silent_fixes || []).includes(`effort_filled:${want}`));
    // no TYPE: the model's own default
    const bare = spawn(fx, { type: 'general-purpose', prompt: `${W}do it`, extra: { model: 'haiku' } });
    assert.equal(bare.updated?.effort, ownDefault('haiku'), bare.all);
    // Explore with no model: the TYPE routes the model, then the effort is filled
    const ex = spawn(fx, { type: 'Explore', prompt: `TYPE: lookup\n${W}find it` });
    assert.equal(ex.decision, 'proceed', ex.all);
    assert.ok(ex.updated?.model, ex.all);
    assert.equal(ex.updated.effort, resolveRoute({ type: 'lookup' }).effort, ex.all);
    assert.equal(ex.row?.spawn_effort_source, 'guard-fill');
  } finally { fx.cleanup(); }
});

test('built-in types: an explicit effort wins, and off fills nothing', () => {
  const fx = setup();
  try {
    const given = spawn(fx, { type: 'general-purpose', prompt: `TYPE: operate\n${W}do it`, extra: { model: 'sonnet', effort: 'low' } });
    assert.ok(!given.updated || given.updated.effort === 'low', given.all);
    assert.notEqual(given.row?.spawn_effort_source, 'guard-fill');
    const off = spawn(fx, { type: 'general-purpose', prompt: `TYPE: operate\n${W}do it`, extra: { model: 'sonnet' },
      env: { CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
    assert.ok(!off.updated || off.updated.effort === undefined, off.all);
    assert.notEqual(off.row?.spawn_effort_source, 'guard-fill');
  } finally { fx.cleanup(); }
});
