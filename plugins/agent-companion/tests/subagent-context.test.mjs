// Subagent context notice: hooks/subagent-context.mjs (PreToolUse, inside the
// subagent) tells a subagent MID-RUN that its own context passed
// subagent_context_notice_tokens or that it just compacted; hooks/runaway-check.mjs
// (SubagentStop) records what the hook missed and tells the lead, next to the
// runaway flag; scripts/detect.mjs counts both over 24 hours. Advice only.
//
// Payload shape is the real one (checked against a headless run on 2026-10-02):
// a PreToolUse inside a subagent carries agent_id and agent_type, and its
// transcript_path is the LEAD's, so the subagent's own file is derived as
// <dir>/<session_id>/subagents/agent-<agent_id>.jsonl.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { readContextSignal, subagentNoticeText, BOUNDARY_FRESH_TURNS } from '../hooks/lib/subagent-context.mjs';

const SID = 'sess-ctx';
const AGENT = 'worker-ctx-test-1';
const TH = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' };

// An assistant request whose context (input + cache_read + cache_write) is `ctx`.
const turn = (id, ctx) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
})}\n`;
const boundary = (uuid, trigger = 'auto', preTokens = 210000) => `${JSON.stringify({
  type: 'system', subtype: 'compact_boundary', uuid, timestamp: '2026-10-02T12:00:00.000Z',
  compactMetadata: { trigger, preTokens },
})}\n`;
const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;

function layout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-c');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  return { lead, agentFile: join(sub, `agent-${AGENT}.jsonl`) };
}

const pre = (lead, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', ...extra,
});
const stopPayload = (lead, extra = {}) => ({
  hook_event_name: 'SubagentStop', session_id: SID, transcript_path: lead, agent_id: AGENT, agent_type: 'general-purpose', ...extra,
});
const ctxText = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const leadDrain = (lead) => runHook('hooks/runaway-notice.mjs', {
  hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: lead, prompt: 'go',
}, { env: { CLAUDE_PLUGIN_OPTION_SESSION_BUDGET_UNITS: '0' } });
const rows = () => readJsonl(join(telemetryDir(), 'subagent-context.jsonl'));

test('mid-run: past the threshold, the subagent is told once, with the agent-side wording', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 120000) + turn('r2', 310000));
    const r = runHook('hooks/subagent-context.mjs', pre(lead));
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(ctxText(r), '[agent-companion] Your context is past 300,000 tokens. Finish the current step, return your results, and if more work remains, say what is left so the lead can split it.');
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput'], 'advice only: no decision of any kind');
    // Once: later tool calls of the same agent, however large the context.
    appendFileSync(agentFile, turn('r3', 380000));
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '');
    const logged = rows();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].kind, 'size');
    assert.equal(logged[0].phase, 'mid-run');
    assert.equal(logged[0].tokens, 310000);
    assert.equal(logged[0].agent_id, AGENT);
  } finally { fx.cleanup(); }
});

test('under the threshold: silent, nothing logged', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 299000));
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'subagent-context.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('compaction trigger: a compact_boundary just behind the agent says "you just compacted", once per compaction', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    // Context is far below the threshold: with a 200K window this is the usual case.
    writeFileSync(agentFile, user('go') + turn('r1', 195000) + boundary('b-1') + user('summary') + turn('r2', 30000));
    const r = runHook('hooks/subagent-context.mjs', pre(lead));
    assert.equal(ctxText(r), '[agent-companion] You just compacted. Finish the current step, return your results, and if more work remains, say what is left so the lead can split it.');
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '', 'same boundary: once');

    // A second compaction is a second event.
    appendFileSync(agentFile, turn('r3', 190000) + boundary('b-2', 'manual') + user('summary') + turn('r4', 25000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /You just compacted/);
    const logged = rows();
    assert.deepEqual(logged.map((x) => x.kind), ['compaction', 'compaction']);
    assert.equal(logged[0].trigger, 'auto');
    assert.equal(logged[0].pre_tokens, 210000);
    assert.equal(logged[1].trigger, 'manual');
    assert.ok(logged.every((x) => x.phase === 'mid-run'));
  } finally { fx.cleanup(); }
});

test('an old boundary is not "just compacted": too many requests after it', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    let t = user('go') + boundary('b-old');
    for (let i = 0; i <= BOUNDARY_FRESH_TURNS + 1; i += 1) t += turn(`n${i}`, 40000 + i);
    writeFileSync(agentFile, t);
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '');
    const sig = readContextSignal(agentFile);
    assert.equal(sig.boundary.id, 'b-old');
    assert.equal(sig.turnsAfterBoundary, BOUNDARY_FRESH_TURNS + 2);
  } finally { fx.cleanup(); }
});

test('both at once: one message, both claimed', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + boundary('b-1') + turn('r1', 320000));
    const r = runHook('hooks/subagent-context.mjs', pre(lead));
    assert.equal((ctxText(r).match(/\[agent-companion\]/g) || []).length, 1);
    assert.deepEqual(rows().map((x) => x.kind).sort(), ['compaction', 'size']);
  } finally { fx.cleanup(); }
});

test('subagent_context_notice_tokens 0 is off, even with a compaction and a huge context', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + boundary('b-1') + turn('r1', 900000));
    const r = runHook('hooks/subagent-context.mjs', pre(lead), { env: { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0' } });
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'subagent-context.jsonl')), false);
    const s = runHook('hooks/runaway-check.mjs', stopPayload(lead), { env: { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0' } });
    assert.equal(s.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'subagent-context.jsonl')), false);
    assert.equal(leadDrain(lead).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('the lead is never touched: no agent_id, no output, even with a huge transcript', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 900000));
    writeFileSync(lead, user('go') + turn('l1', 900000));
    const { agent_id, agent_type, ...mainThread } = pre(lead);
    assert.equal(runHook('hooks/subagent-context.mjs', mainThread).stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'subagent-context.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('fails open: no derivable transcript, missing file, garbage stdin', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const a = runHook('hooks/subagent-context.mjs', pre(lead)); // no agent file yet
    assert.equal(a.status, 0);
    assert.equal(a.stdout.trim(), '');
    assert.equal(runHook('hooks/subagent-context.mjs', pre(join(fx.dir, 'nowhere.jsonl'))).status, 0);
    assert.equal(runHook('hooks/subagent-context.mjs', undefined).status, 0);
    assert.equal(readContextSignal(join(fx.dir, 'nope.jsonl')), null);
  } finally { fx.cleanup(); }
});

test('a huge tool result after the last request does not hide it: the tail widens once', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const big = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1500000) } })}\n`;
    writeFileSync(agentFile, user('go') + turn('r1', 330000) + big);
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /past 300,000 tokens/);
  } finally { fx.cleanup(); }
});

test('SubagentStop: a mid-run event reaches the lead next to the runaway flag, once, however often the worker stops', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r0', 190000) + boundary('b-1') + turn('r1', 30000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /just compacted/);
    const env = { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '1' }; // the same stop also trips the runaway flag
    const s1 = runHook('hooks/runaway-check.mjs', stopPayload(lead), { env });
    assert.equal(s1.stdout.trim(), '', 'SubagentStop output stays empty: queued, not emitted');
    runHook('hooks/runaway-check.mjs', stopPayload(lead), { env }); // continued with SendMessage and stopped again
    const text = ctxText(leadDrain(lead));
    assert.match(text, /runaway spawn: general-purpose/);
    assert.match(text, /subagent context: general-purpose \(worker-ctx-t\) compacted; it was told mid-run to wrap up\./);
    assert.equal((text.match(/subagent context:/g) || []).length, 1, 'reported once');
    assert.equal(leadDrain(lead).stdout.trim(), '');
    assert.equal(rows().length, 1, 'the stop did not log a second row for the same compaction');
  } finally { fx.cleanup(); }
});

test('SubagentStop fallback: a worker the mid-run hook never reached is recorded with phase "stop" and the lead is told', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    // Crossed on its last turn: no tool call followed, so no PreToolUse saw it.
    writeFileSync(agentFile, user('go') + turn('r1', 80000) + turn('r2', 340000));
    const s = runHook('hooks/runaway-check.mjs', stopPayload(lead));
    assert.equal(s.stdout.trim(), '');
    const logged = rows();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].phase, 'stop');
    assert.equal(logged[0].kind, 'size');
    const text = ctxText(leadDrain(lead));
    assert.match(text, /subagent context: general-purpose \(worker-ctx-t\) passed 300,000 tokens of context \(340,000 at its last call\); it was not reached mid-run\./);
    assert.match(text, /split the remainder into smaller briefs/);
  } finally { fx.cleanup(); }
});

test('a workflow agent (subagents/workflows/<id>/agent-<id>.jsonl) is found and gets the notice', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const wf = join(agentFile, '..', 'workflows', 'wf_1');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, `agent-${AGENT}.jsonl`), user('go') + turn('r1', 350000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /past 300,000 tokens/);
  } finally { fx.cleanup(); }
});

test('SubagentStop reads the transcript from the payload when it is given', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const own = join(fx.dir, 'elsewhere.jsonl');
    writeFileSync(own, user('go') + turn('r1', 500000));
    runHook('hooks/runaway-check.mjs', stopPayload(lead, { agent_transcript_path: own }));
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('hooks.json: a PreToolUse entry with NO matcher runs the hook, the plugin declares the option', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const g = (h.PreToolUse || []).find((x) => x.hooks.some((y) => y.args.some((a) => a.endsWith('subagent-context.mjs'))));
  assert.ok(g, 'registered on PreToolUse');
  assert.equal(g.matcher, undefined, 'every tool, so a subagent is checked on each call');
  assert.ok(existsSync(join(PLUGIN_ROOT, 'hooks', 'subagent-context.mjs')));
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(cfg.userConfig.subagent_context_notice_tokens.default, 300000);
  assert.equal(subagentNoticeText(['size'], 300000).startsWith('[agent-companion] Your context is past 300,000 tokens.'), true);
});

test('detect.mjs: budget_notices counts both notices over 24 hours (dispatch none), older rows excluded', () => {
  const fx = makeFixture();
  try {
    const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    const write = (name, list) => writeFileSync(join(telemetryDir(), name), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
    write('session-budget.jsonl', [
      { at: at(60000), units: 400.2 }, { at: at(7200000), units: 760 }, { at: at(3 * 86400000), units: 5000 },
    ]);
    write('subagent-context.jsonl', [
      { at: at(1000), kind: 'compaction', phase: 'mid-run' },
      { at: at(2000), kind: 'size', phase: 'mid-run' },
      { at: at(3000), kind: 'compaction', phase: 'stop' },
      { at: at(5 * 86400000), kind: 'compaction', phase: 'mid-run' },
    ]);
    const d = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000 });
    assert.equal(d.status, 0, d.stderr);
    const s = d.json.signals.find((x) => x.kind === 'budget_notices');
    assert.ok(s, 'signal present');
    assert.equal(s.dispatch, 'none');
    assert.equal(s.detail, '2 session budget notice(s) (highest ~760 plan units) and 3 subagent context notice(s) in 24h (2 compaction, 1 size; 2 mid-run, 1 only at stop)');
  } finally { fx.cleanup(); }
});

test('detect.mjs: no rows, no signal', () => {
  const fx = makeFixture();
  try {
    const d = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000 });
    assert.equal(d.status, 0, d.stderr);
    assert.equal(d.json.signals.some((x) => x.kind === 'budget_notices'), false);
  } finally { fx.cleanup(); }
});
