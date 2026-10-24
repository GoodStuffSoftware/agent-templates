// Live step budget: hooks/subagent-context.mjs (PreToolUse, inside the helper) counts the
// helper's tool calls per agent_id, warns once at the soft line and denies everything but
// a report or detail write past the hard one; a second compaction stops it the same way.
// Caps come from the helper's brief (first user message of its own transcript): lookup,
// research, survey, explore and verify 40/60, everything else 80/120, `BUDGET: <n>` sets
// the stop with the warning at 80%. Library: hooks/lib/step-budget.mjs.
//
// The counter file is one byte per call, so a test seeds N-1 bytes and runs the hook once
// rather than spawning N hook processes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import { briefStepInfo, capsFor, isReportWrite, STOP_REASON, warnText } from '../hooks/lib/step-budget.mjs';

const SID = 'sess-step';
const AGENT = 'worker-step-test-1';
const OFF_CTX = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0', CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0' };

const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;
const turn = (id) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 } },
})}\n`;
const boundary = (uuid) => `${JSON.stringify({
  type: 'system', subtype: 'compact_boundary', uuid, timestamp: '2026-10-23T12:00:00.000Z',
  compactMetadata: { trigger: 'auto', preTokens: 210000 },
})}\n`;

function layout(fx, brief = 'TYPE: bounded-feature\nbuild it') {
  const proj = join(fx.dir, 'projects', 'proj-step');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  const agentFile = join(sub, `agent-${AGENT}.jsonl`);
  writeFileSync(agentFile, brief === null ? '' : user(brief) + turn('r1'));
  return { lead, agentFile };
}

const counterFile = (agent = AGENT) => join(stateDir(), 'step-budget', `${agent}.cnt`);
// Make the next call the Nth.
function seed(n, agent = AGENT) {
  mkdirSync(join(stateDir(), 'step-budget'), { recursive: true });
  writeFileSync(counterFile(agent), '.'.repeat(n - 1));
}

const pre = (lead, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'ac-sonnet-high', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', ...extra,
});
const run = (lead, env = {}, extra = {}) => runHook('hooks/subagent-context.mjs', pre(lead, extra), { env: { ...OFF_CTX, ...env } });
const ctxText = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const rows = () => readJsonl(join(telemetryDir(), 'step-budget.jsonl'));

test('counting: one count per call, per agent_id', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    for (let i = 0; i < 3; i += 1) assert.equal(run(lead).stdout.trim(), '');
    assert.equal(statSync(counterFile()).size, 3);
    run(lead, {}, { agent_id: 'worker-other' }); // another agent: its own file (no transcript of its own: not counted)
    assert.equal(statSync(counterFile()).size, 3);
  } finally { fx.cleanup(); }
});

test('the lead (no agent_id) is never counted', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const payload = pre(lead);
    delete payload.agent_id;
    delete payload.agent_type;
    const r = runHook('hooks/subagent-context.mjs', payload, { env: OFF_CTX });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(stateDir(), 'step-budget')), false);
  } finally { fx.cleanup(); }
});

test('cap selection by TYPE: writers and unknown 80/120, lookup types 40/60', () => {
  const fx = makeFixture();
  try {
    for (const t of ['bounded-feature', 'code-review', 'operate', 'made-up-type', null]) {
      assert.deepEqual(capsFor({ type: t, budget: null }), { warn: 80, stop: 120, kind: 'writer' }, String(t));
    }
    for (const t of ['lookup', 'research', 'survey', 'explore', 'verify']) {
      assert.deepEqual(capsFor({ type: t, budget: null }), { warn: 40, stop: 60, kind: 'lookup' }, t);
    }
    assert.deepEqual(briefStepInfo('TYPE: research\nfind it'), { type: 'research', budget: null });
    assert.deepEqual(briefStepInfo('no directives here'), { type: null, budget: null });
    // a TYPE line inside a fenced block is not a declaration
    assert.deepEqual(briefStepInfo('TYPE: bounded-feature\n```\nTYPE: lookup\nBUDGET: 5\n```'), { type: 'bounded-feature', budget: null });
  } finally { fx.cleanup(); }
});

test('end to end: a lookup brief warns at 40, a writer brief does not', () => {
  const fx = makeFixture();
  try {
    const a = layout(fx, 'TYPE: lookup\nfind it');
    seed(39);
    assert.equal(run(a.lead).stdout.trim(), '');
    seed(40);
    const r = run(a.lead);
    assert.match(ctxText(r), /^\[agent-companion\] 40 of 60 steps used: finish, write your detail file, report what is left\.$/);
    writeFileSync(a.agentFile, user('TYPE: bounded-feature\nbuild it') + turn('r1'));
    rmSync(join(fx.stateDir, 'state', 'subagent-context-claims', `step-warn-${AGENT}.seen`), { force: true }); // a fresh warn claim
    seed(40);
    assert.equal(run(a.lead).stdout.trim(), '');
    seed(80);
    assert.match(ctxText(run(a.lead)), /80 of 120 steps used/);
  } finally { fx.cleanup(); }
});

test('BUDGET: <n> sets the stop, the warning at 80% of it', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(briefStepInfo('TYPE: research\nBUDGET: 150\nx'), { type: 'research', budget: 150 });
    assert.deepEqual(capsFor({ type: 'research', budget: 150 }), { warn: 120, stop: 150, kind: 'brief' });
    const { lead } = layout(fx, 'TYPE: bounded-feature\nBUDGET: 50\nbuild it');
    seed(39);
    assert.equal(run(lead).stdout.trim(), '');
    seed(40);
    assert.match(ctxText(run(lead)), /40 of 50 steps used/);
    seed(50);
    assert.equal(denied(run(lead)), false); // 50 of 50 used: the 50th call still runs
    seed(51);
    const r = run(lead);
    assert.equal(denied(r), true);
    assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, STOP_REASON);
  } finally { fx.cleanup(); }
});

test('only a plain step count is a BUDGET: units, thousands separators, decimals and tiny numbers declare nothing', () => {
  const b = (line) => briefStepInfo(`TYPE: bounded-feature\n${line}\nbuild it`).budget;
  assert.equal(b('Budget: about 100 tool calls.'), null);
  for (const [line, want] of [
    ['BUDGET: 100', 100], ['BUDGET: 100 tool calls', 100], ['**BUDGET:** 90 steps.', 90], ['budget: 60 turns', 60], ['BUDGET: 10', 10],
  ]) assert.equal(b(line), want, line);
  for (const line of ['BUDGET: 1,000 tool calls', 'BUDGET: 2.5 hours', 'BUDGET: 30 minutes', 'BUDGET: 50% of context', 'BUDGET: 5 USD', 'BUDGET: 1', 'BUDGET: 9', 'BUDGET: 0', 'BUDGET: 12345']) {
    assert.equal(b(line), null, line);
  }
});

test('warn once: the second call past the line is silent', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    seed(80);
    const first = run(lead);
    assert.equal(ctxText(first), warnText(80, 120));
    assert.equal(denied(first), false);
    const second = run(lead); // call 81
    assert.equal(second.stdout.trim(), '');
    assert.equal(rows().filter((r) => r.kind === 'warn').length, 1);
    assert.equal(rows()[0].agent_id, AGENT);
    assert.equal(rows()[0].steps, 80);
  } finally { fx.cleanup(); }
});

test('stop: call 120 runs, call 121 is denied, only a report or detail write passes', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    seed(120);
    assert.equal(denied(run(lead)), false);
    const r = run(lead); // 121
    assert.equal(denied(r), true);
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, 'Step budget reached: write your report now and stop.');
    assert.equal(r.json.continue, undefined);
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: 'a.md' }], ['Write', { file_path: 'src/app.js', content: 'x' }], ['Agent', { prompt: 'x' }]]) {
      assert.equal(denied(run(lead, {}, { tool_name: tool, tool_input: input })), true, tool);
    }
    for (const f of ['C:\\work\\p2-step-budget-detail.md', '/tmp/x-handoff.md', 'REVIEW-foo.md', 'out/report.json']) {
      const w = run(lead, {}, { tool_name: 'Write', tool_input: { file_path: f, content: 'x' } });
      assert.equal(denied(w), false, f);
    }
    assert.equal(denied(run(lead, {}, { tool_name: 'Edit', tool_input: { file_path: 'x-detail.md', old_string: 'a', new_string: 'b' } })), false);
    assert.equal(rows().filter((x) => x.kind === 'stop' && x.why === 'steps').length >= 5, true);
  } finally { fx.cleanup(); }
});

test('isReportWrite: Write and Edit of a named doc file only', () => {
  assert.equal(isReportWrite('Write', { file_path: 'a/b-detail.md' }), true);
  assert.equal(isReportWrite('Write', { file_path: 'a/b-handoff.md' }), true);
  assert.equal(isReportWrite('Write', { file_path: 'a/detail.js' }), false);
  assert.equal(isReportWrite('Write', { file_path: 'a/main.md' }), false);
  assert.equal(isReportWrite('Bash', { command: 'echo > x-detail.md' }), false);
  assert.equal(isReportWrite('Write', {}), false);
});

test('options: step_budget_stop, step_budget_warn and the lookup pair move the lines; step_budget off disables', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const env = { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_WARN: '10', CLAUDE_PLUGIN_OPTION_STEP_BUDGET_STOP: '20' };
    seed(10);
    assert.match(ctxText(run(lead, env)), /10 of 20 steps used/);
    seed(21);
    assert.equal(denied(run(lead, env)), true);
    assert.equal(denied(run(lead, { ...env, CLAUDE_PLUGIN_OPTION_STEP_BUDGET: 'false' })), false);
    const lk = layout(fx, 'TYPE: verify\ncheck it');
    rmSync(join(fx.stateDir, 'state', 'subagent-context-claims', `step-warn-${AGENT}.seen`), { force: true });
    seed(5);
    assert.match(ctxText(run(lk.lead, { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_LOOKUP_WARN: '5', CLAUDE_PLUGIN_OPTION_STEP_BUDGET_LOOKUP_STOP: '8' })), /5 of 8 steps used/);
    seed(9);
    assert.equal(denied(run(lk.lead, { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_LOOKUP_WARN: '5', CLAUDE_PLUGIN_OPTION_STEP_BUDGET_LOOKUP_STOP: '8' })), true);
    // a stop of 0 turns the hard stop (and the warning) off for the class
    seed(500);
    assert.equal(run(lead, { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_LOOKUP_STOP: '0' }).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('second compaction: the first only warns the context way, the second stops the helper', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const ctxOn = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0' };
    appendFileSync(agentFile, boundary('b1') + turn('r2'));
    const first = run(lead, ctxOn);
    assert.match(ctxText(first), /You just compacted/);
    assert.equal(denied(first), false);
    appendFileSync(agentFile, boundary('b2') + turn('r3'));
    const second = run(lead, ctxOn);
    assert.equal(denied(second), true);
    assert.equal(second.json.hookSpecificOutput.permissionDecisionReason, STOP_REASON);
    assert.equal(rows().at(-1).why, 'compactions');
    // sticky: later calls stay stopped, a report write still passes
    assert.equal(denied(run(lead, ctxOn)), true);
    assert.equal(denied(run(lead, ctxOn, { tool_name: 'Write', tool_input: { file_path: 'x-detail.md', content: 'x' } })), false);
    assert.equal(readFileSync(counterFile(), 'utf8').length, 4);
  } finally { fx.cleanup(); }
});

test('second compaction stops the helper even with the context notice off, and writes no context telemetry', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    appendFileSync(agentFile, boundary('b1') + turn('r2'));
    assert.equal(denied(run(lead)), false);
    appendFileSync(agentFile, boundary('b2') + turn('r3'));
    const r = run(lead); // OFF_CTX: subagent_context_notice_tokens 0
    assert.equal(denied(r), true);
    assert.equal(existsSync(join(telemetryDir(), 'subagent-context.jsonl')), false);
    assert.equal(readJsonl(join(telemetryDir(), 'denials.jsonl')).at(-1).guard, 'step-budget');
  } finally { fx.cleanup(); }
});

test('fail open: no transcript, no brief, or a lead-only payload counts and caps nothing', () => {
  const fx = makeFixture();
  try {
    const none = layout(fx, null);
    seed(500);
    assert.equal(run(none.lead).stdout.trim(), ''); // empty transcript: no brief
    assert.equal(statSync(counterFile()).size, 499);
    const noFile = pre(join(fx.dir, 'projects', 'nowhere', 'lead.jsonl'));
    const r = runHook('hooks/subagent-context.mjs', noFile, { env: OFF_CTX });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});
