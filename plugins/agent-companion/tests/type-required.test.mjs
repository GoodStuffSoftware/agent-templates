// type_line_required (0.31.17): a ladder-rung spawn needs a TYPE: line or a
// line standing in for it (WEIGHT:, KIND:, a weighted WARRANT:).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runHook, decisionOf } from './helpers.mjs';

function spawn(prompt, { subagent_type = 'agent-companion:ac-sonnet-medium', mode = 'deny', agent_type = 'main', agent_id, extra = {} } = {}) {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-tr', agent_type, ...(agent_id ? { agent_id } : {}), cwd: dir,
      tool_input: { subagent_type, run_in_background: true, name: 'w', isolation: 'worktree', prompt, ...extra },
    }, { env: { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: mode } });
    assert.equal(res.status, 0, res.stderr);
    const h = res.json?.hookSpecificOutput || {};
    return { decision: decisionOf(res.json), reason: h.permissionDecisionReason || '', msg: `${res.json?.systemMessage || ''}${h.additionalContext || ''}` };
  } finally { cleanup(); }
}

test('rung with no TYPE/WEIGHT/KIND is denied; message gives the fix', () => {
  const r = spawn('ROLE: writer\ndo the thing');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /TYPE:/);
  assert.match(r.reason, /WEIGHT:/);
  assert.match(r.reason, /lookup/);
  assert.match(r.reason, /survey/);
  assert.match(r.reason, /type_line_required/);
});

test('TYPE line, WEIGHT only, KIND only, weighted WARRANT only are not denied', () => {
  for (const p of ['TYPE: bounded-feature\nx', 'WEIGHT: 3\nx', 'KIND: bounded\nx', 'WARRANT: weight 4 - reason\nx']) {
    const r = spawn(p);
    assert.notEqual(r.decision, 'deny', `${p}: ${r.reason}`);
  }
});

test('CONSEQUENCE alone does not stand in', () => {
  assert.equal(spawn('CONSEQUENCE: routine\nx').decision, 'deny');
});

test('unknown TYPE counts as present and keeps the type_line_nudge', () => {
  const r = spawn('TYPE: frobnicate\nx');
  assert.notEqual(r.decision, 'deny', r.reason);
  assert.match(r.msg, /not a task type/);
});

test('non-rung agents are unaffected', () => {
  for (const st of ['general-purpose', 'agent-companion:ac-browser']) {
    const r = spawn('x', { subagent_type: st, extra: { model: 'sonnet' } });
    assert.notEqual(r.decision, 'deny', `${st}: ${r.reason}`);
  }
});

test('warn adds a note, off is silent', () => {
  const w = spawn('x', { mode: 'warn' });
  assert.notEqual(w.decision, 'deny', w.reason);
  assert.match(w.msg, /no `TYPE:` line/);
  const o = spawn('x', { mode: 'off' });
  assert.notEqual(o.decision, 'deny', o.reason);
  assert.doesNotMatch(o.msg, /no `TYPE:` line/);
});

test('a worker spawning a sub-worker gets the same rule, with its own message', () => {
  const r = spawn('x', { agent_type: 'agent-companion:ac-sonnet-medium', agent_id: 'a123' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /worker/);
});
