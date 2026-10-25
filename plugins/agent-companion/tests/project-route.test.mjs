// Project-agent routing (0.31.35, project_route_guard: autofix | warn | off): a project or user agent whose
// definition pins opus follows the routing table. The spawn is rewritten silently (updatedInput.model), one
// routing-autofix row is written, a PREMIUM: line skips it, and nothing is ever denied. Also: agent_id on
// denials.jsonl rows written for a subagent's call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runHook, readJsonl, decisionOf } from './helpers.mjs';
import { resolveRoute } from '../hooks/lib/context.mjs';

const agentFile = (fm) => `---\nname: x\n${fm}\n---\nbody\n`;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function setup() {
  const fx = makeFixture();
  const proj = join(fx.dir, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const pa = join(proj, '.claude', 'agents');
  put(join(pa, 'proj-architect.md'), agentFile('model: opus\neffort: xhigh'));
  put(join(pa, 'proj-sonnet.md'), agentFile('model: sonnet\neffort: high'));
  put(join(pa, 'proj-effortonly.md'), agentFile('effort: high'));
  put(join(fx.dir, '.claude', 'agents', 'user-agent.md'), agentFile('model: opus\neffort: high'));
  return { ...fx, proj };
}

let counter = 0;
function spawn(fx, { type = 'proj-architect', prompt, model, env, extra, payload } = {}) {
  counter += 1;
  const sid = `sess-route-${process.pid}-${counter}`;
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: fx.proj, ...(payload || {}),
    tool_input: { subagent_type: type, run_in_background: true, name: `w${counter}`, prompt, ...(model ? { model } : {}), ...(extra || {}) },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...(env || {}) } });
  assert.equal(res.status, 0, res.stderr);
  const hso = res.json?.hookSpecificOutput || {};
  const rows = readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl')).filter((r) => r.session_id === sid);
  return {
    res, sid, rows,
    route: rows.filter((r) => r.guard === 'routing-autofix'),
    decision: decisionOf(res.json),
    msg: res.json?.systemMessage || '',
    updated: hso.updatedInput || null,
    all: JSON.stringify(res.json || {}),
  };
}
const W = 'ROLE: writer\n';
const tableModel = (type) => resolveRoute({ type }).model;

test('the live table sends bounded-feature and integration off Opus and keeps the heavy types on it (premise of this file)', () => {
  assert.notEqual(tableModel('bounded-feature'), 'opus');
  assert.notEqual(tableModel('integration'), 'opus');
  for (const t of ['debug-root-cause', 'novel-design', 'large-refactor', 'critical-change']) assert.equal(tableModel(t), 'opus', t);
});

test('autofix (default): an opus project agent on a TYPE the table routes to sonnet runs on the table model, silently, with one row', () => {
  const fx = setup();
  try {
    for (const type of ['bounded-feature', 'integration']) {
      const r = spawn(fx, { prompt: `TYPE: ${type}\n${W}do it` });
      assert.equal(r.decision, 'proceed', r.all);
      assert.equal(r.updated?.model, tableModel(type));
      assert.equal(r.updated?.subagent_type, 'proj-architect', 'the agent keeps its own definition');
      assert.match(r.updated?.prompt || '', /do it/);
      assert.equal(r.msg, '', 'no message');
      assert.doesNotMatch(r.all, /Project routing|routing table|PREMIUM/);
      assert.equal(r.route.length, 1);
      assert.equal(r.route[0].outcome, 'autofix');
      assert.equal(r.route[0].subagent_type, 'proj-architect');
      assert.equal(r.route[0].declared_type, type);
      assert.equal(r.route[0].from_model, 'opus');
      assert.equal(r.route[0].to_model, tableModel(type));
    }
    // A user agent (~/.claude/agents) is rewritten the same way.
    const u = spawn(fx, { type: 'user-agent', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(u.updated?.model, tableModel('bounded-feature'));
    assert.equal(u.route.length, 1);
  } finally { fx.cleanup(); }
});

test('autofix: the rewritten spawn is not premium (no warrant, no cap), even past the cap window', () => {
  const fx = setup();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '1' };
    for (let i = 0; i < 4; i += 1) {
      const r = spawn(fx, { prompt: `TYPE: bounded-feature\n${W}do it`, env });
      assert.equal(r.decision, 'proceed', r.all);
      assert.equal(r.updated?.model, tableModel('bounded-feature'));
    }
  } finally { fx.cleanup(); }
});

test('types the table keeps on Opus pass untouched, with no row', () => {
  const fx = setup();
  try {
    for (const type of ['debug-root-cause', 'novel-design', 'large-refactor', 'critical-change']) {
      const r = spawn(fx, { prompt: `TYPE: ${type}\n${W}do it` });
      assert.equal(r.decision, 'proceed', `${type}: ${r.all}`);
      assert.equal(r.updated?.model, undefined, type);
      assert.equal(r.route.length, 0, type);
      assert.equal(r.msg, '', type);
    }
  } finally { fx.cleanup(); }
});

test('a PREMIUM: <reason> line keeps Opus; an empty PREMIUM: line does not', () => {
  const fx = setup();
  try {
    const keep = spawn(fx, { prompt: `TYPE: bounded-feature\nPREMIUM: touches the billing state machine, needs the deeper model\n${W}do it` });
    assert.equal(keep.decision, 'proceed');
    assert.equal(keep.updated?.model, undefined);
    assert.equal(keep.route.length, 0);
    const empty = spawn(fx, { prompt: `TYPE: bounded-feature\nPREMIUM:\n${W}do it` });
    assert.equal(empty.updated?.model, tableModel('bounded-feature'));
    assert.equal(empty.route.length, 1);
  } finally { fx.cleanup(); }
});

test('no usable TYPE: left unchanged, never denied, one row logs it as untyped', () => {
  const fx = setup();
  try {
    for (const prompt of ['do it', `TYPE: frobnicate\n${W}do it`]) {
      const r = spawn(fx, { prompt });
      assert.equal(r.decision, 'proceed', r.all);
      assert.equal(r.updated?.model, undefined);
      assert.equal(r.msg, '');
      assert.equal(r.route.length, 1, prompt);
      assert.equal(r.route[0].outcome, 'untyped');
      assert.equal(r.route[0].to_model, null);
      assert.equal(r.route[0].declared_type, prompt.includes('frobnicate') ? 'frobnicate' : null);
    }
  } finally { fx.cleanup(); }
});

test('a WEIGHT: line that routes off Opus stands in for the TYPE', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { prompt: `WEIGHT: 2\n${W}do it` });
    assert.equal(r.decision, 'proceed', r.all);
    assert.ok(r.updated?.model && r.updated.model !== 'opus', 'rewritten');
    assert.equal(r.route[0].outcome, 'autofix');
  } finally { fx.cleanup(); }
});

test('warn: the spawn is untouched, one visible note, the same row (outcome warn)', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { prompt: `TYPE: bounded-feature\n${W}do it`, env: { CLAUDE_PLUGIN_OPTION_PROJECT_ROUTE_GUARD: 'warn' } });
    assert.equal(r.decision, 'proceed');
    assert.equal(r.updated?.model, undefined);
    assert.match(r.msg, /proj-architect .*routing table sends TYPE: bounded-feature to /);
    assert.match(r.msg, /PREMIUM: <reason>/);
    assert.equal(r.route.length, 1);
    assert.equal(r.route[0].outcome, 'warn');
  } finally { fx.cleanup(); }
});

test('off: nothing is rewritten, noted or logged', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { prompt: `TYPE: bounded-feature\n${W}do it`, env: { CLAUDE_PLUGIN_OPTION_PROJECT_ROUTE_GUARD: 'off' } });
    assert.equal(r.decision, 'proceed');
    assert.equal(r.updated?.model, undefined);
    assert.equal(r.route.length, 0);
    assert.doesNotMatch(r.msg, /routing table sends/);
  } finally { fx.cleanup(); }
});

test('not an opus spawn: a model parameter that replaces the pin, a sonnet-pinned agent, an effort-only pin, a ladder rung', () => {
  const fx = setup();
  try {
    const p = `TYPE: bounded-feature\n${W}do it`;
    const over = spawn(fx, { prompt: p, model: 'sonnet' });
    assert.equal(over.route.length, 0);
    assert.notEqual(over.updated?.model, 'opus');
    assert.equal(spawn(fx, { type: 'proj-sonnet', prompt: p }).route.length, 0);
    assert.equal(spawn(fx, { type: 'proj-effortonly', prompt: p }).route.length, 0);
    assert.equal(spawn(fx, { type: 'agent-companion:ac-sonnet-high', prompt: p }).route.length, 0);
  } finally { fx.cleanup(); }
});

test('a subagent caller: the routing row and every other denials row carry its agent_id; a lead row carries none', () => {
  const fx = setup();
  try {
    const sub = spawn(fx, { prompt: `TYPE: bounded-feature\n${W}do it`, payload: { agent_id: 'agent-abc123', agent_type: 'agent-companion:ac-sonnet-high' } });
    assert.equal(sub.route[0].agent_id, 'agent-abc123');
    const lead = spawn(fx, { prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal('agent_id' in lead.route[0], false);
    // A deny written for a subagent's call (a ladder rung with no TYPE line): recordDenial adds the id too.
    const d = spawn(fx, { type: 'agent-companion:ac-sonnet-high', prompt: 'ROLE: writer\ndo it', env: { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: 'deny' }, extra: { isolation: 'worktree' }, payload: { agent_id: 'agent-def456', agent_type: 'agent-companion:ac-sonnet-high' } });
    assert.equal(d.decision, 'deny', d.all);
    const row = d.rows.find((r) => r.guard === 'type-required');
    assert.ok(row, JSON.stringify(d.rows));
    assert.equal(row.agent_id, 'agent-def456');
    const ld = spawn(fx, { type: 'agent-companion:ac-sonnet-high', prompt: 'ROLE: writer\ndo it', env: { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: 'deny' }, extra: { isolation: 'worktree' } });
    assert.equal('agent_id' in ld.rows.find((r) => r.guard === 'type-required'), false);
  } finally { fx.cleanup(); }
});

test('autofix: the self-review text and the spawns row use the rewritten model, and an agent pinning only a model stays silent', () => {
  const fx = setup();
  try {
    put(join(fx.proj, '.claude', 'agents', 'proj-modelonly.md'), agentFile('model: opus'));
    for (const type of ['proj-architect', 'proj-modelonly']) {
      const r = spawn(fx, { type, prompt: `TYPE: bounded-feature\n${W}do it` });
      assert.equal(r.updated?.model, tableModel('bounded-feature'), r.all);
      assert.equal(r.msg, '', `${type}: no message`);
      assert.doesNotMatch(r.updated?.prompt || '', /WRITER: opus/, `${type}: reviewer brief must not name an opus writer`);
      assert.doesNotMatch(r.all, /ac-opus/, `${type}: no opus reviewer rung named`);
      const spawns = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).filter((x) => x.session_id === r.sid);
      assert.ok(spawns.every((x) => x.model !== 'opus'), `${type}: spawns row must not claim opus`);
    }
  } finally { fx.cleanup(); }
});
