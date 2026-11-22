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
import { join, dirname } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { selfReviewBriefText } from '../hooks/lib/self-review.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { readContextSignal, subagentNoticeText, noticeVariant, BOUNDARY_FRESH_TURNS } from '../hooks/lib/subagent-context.mjs';

const SID = 'sess-ctx';
const AGENT = 'worker-ctx-test-1';
const TH = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' }; // an operator who raised the option back to the pre-0.31.54 value
const HAND = 'commit and push any work in progress to your branch, write a handoff file <task>-handoff.md next to your detail file (done, remaining, files touched, branch and sha, the exact next step), then end with "DONE: partial, handoff at <path>".';
const NOTE = (k) => `[agent-companion] Context at ${k}K: finish the current step, ${HAND}`; // the hard limit is off in tests (helpers.mjs), so no "limit" is named

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
  hook_event_name: 'SubagentStop', session_id: SID, transcript_path: lead, agent_id: AGENT, agent_type: 'general-purpose', last_assistant_message: 'STATUS: done', ...extra,
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
    assert.equal(ctxText(r), NOTE(310));
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

test('0.31.54: with no option set the default 110,000 fires the hand-off notice once, one telemetry row per worker', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 90000) + turn('r2', 118000));
    const r = runHook('hooks/subagent-context.mjs', pre(lead));
    assert.equal(ctxText(r), NOTE(118));
    assert.match(ctxText(r), /commit and push any work in progress to your branch/);
    assert.match(ctxText(r), /<task>-handoff\.md next to your detail file \(done, remaining, files touched, branch and sha, the exact next step\)/);
    appendFileSync(agentFile, turn('r3', 160000));
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '', 'once per worker');
    assert.equal(rows().length, 1, 'exactly one telemetry line');
    assert.equal(rows()[0].kind, 'size');
    assert.equal(rows()[0].threshold, 110000);
    // A second worker gets its own notice and its own row.
    const other = join(agentFile, '..', 'agent-worker-ctx-test-2.jsonl');
    writeFileSync(other, user('go') + turn('q1', 125000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead, { agent_id: 'worker-ctx-test-2' }))), /Context at \d+K: finish the current step/);
    assert.equal(rows().length, 2);
  } finally { fx.cleanup(); }
});

test('0.31.54: the option still moves the threshold (a bigger number fires later)', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 200000));
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead), { env: TH }).stdout.trim(), '', 'raised to 300,000: 200,000 is under it');
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /Context at \d+K: finish the current step/);
  } finally { fx.cleanup(); }
});

test('under the threshold: silent, nothing logged', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 109000));
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
    assert.equal(ctxText(r), '[agent-companion] You compacted; re-read only what the next step needs and continue.');
    assert.doesNotMatch(ctxText(r), /split|handoff|Finish/, 'a compaction alone asks for no wrap-up');
    assert.equal(runHook('hooks/subagent-context.mjs', pre(lead)).stdout.trim(), '', 'same boundary: once');

    // A second compaction is a second event; the stop (opt-in) is the third (step budget, hooks/lib/step-budget.mjs).
    appendFileSync(agentFile, turn('r3', 190000) + boundary('b-2', 'manual') + user('summary') + turn('r4', 25000));
    const second = runHook('hooks/subagent-context.mjs', pre(lead));
    assert.equal(second.json.hookSpecificOutput.permissionDecision, undefined, 'two compactions no longer stop the helper');
    assert.match(ctxText(second), /You compacted; re-read only/);
    appendFileSync(agentFile, turn('r5', 190000) + boundary('b-3', 'auto') + user('summary') + turn('r6', 25000));
    // The compaction stop denies only on the step_budget_deny opt-in (soft by default, 2026-11-01).
    const third = runHook('hooks/subagent-context.mjs', pre(lead), { env: { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_DENY: 'true' } });
    assert.equal(third.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(third.json.hookSpecificOutput.permissionDecisionReason, /^Step budget reached/);
    const logged = rows();
    assert.deepEqual(logged.map((x) => x.kind), ['compaction', 'compaction', 'compaction']);
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
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /Context at \d+K: finish the current step/);
  } finally { fx.cleanup(); }
});

test('SubagentStop: a mid-run event reaches the lead next to the runaway flag, once, however often the worker stops', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r0', 190000) + boundary('b-1') + turn('r1', 30000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /You compacted; re-read only/);
    const env = { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '1' }; // the same stop also trips the runaway flag
    const s1 = runHook('hooks/runaway-check.mjs', stopPayload(lead), { env });
    assert.equal(s1.stdout.trim(), '', 'SubagentStop output stays empty: queued, not emitted');
    runHook('hooks/runaway-check.mjs', stopPayload(lead), { env }); // continued with SendMessage and stopped again
    const text = ctxText(leadDrain(lead));
    assert.match(text, /runaway spawn: general-purpose/);
    assert.match(text, /subagent context: general-purpose \(worker-ctx-t\) compacted; row in subagent-context\.jsonl\./);
    assert.doesNotMatch(text, /brief ONE fresh|told mid-run/, 'a compaction alone: no advice to the lead');
    assert.equal((text.match(/subagent context:/g) || []).length, 1, 'reported once');
    assert.equal(leadDrain(lead).stdout.trim(), '');
    assert.equal(rows().length, 1, 'the stop did not log a second row for the same compaction');
  } finally { fx.cleanup(); }
});

test('SubagentStop: a size event seen mid-run says "told mid-run to hand off" and points the lead at a fresh same-rung worker', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 80000) + turn('r2', 340000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /Context at \d+K: finish the current step/);
    runHook('hooks/runaway-check.mjs', stopPayload(lead));
    const text = ctxText(leadDrain(lead));
    assert.match(text, /passed 110,000 tokens of context \(340,000 at its last call\); it was told mid-run to hand off\./);
    assert.match(text, /returned "DONE: partial, handoff at <path>", start a fresh worker on the same rung from that file \(not a resume\)/);
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
    assert.match(text, /subagent context: general-purpose \(worker-ctx-t\) passed 110,000 tokens of context \(340,000 at its last call\); it was not reached mid-run\./);
    assert.match(text, /otherwise brief ONE fresh same-rung worker with the whole remaining build scope \(code, tests, fixes, landing\)/);
    assert.match(text, /never split the remaining build across several writers/);
    assert.doesNotMatch(text, /smaller briefs|its own review/);
  } finally { fx.cleanup(); }
});

test('a workflow agent (subagents/workflows/<id>/agent-<id>.jsonl) is found and gets the notice', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const wf = join(agentFile, '..', 'workflows', 'wf_1');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, `agent-${AGENT}.jsonl`), user('go') + turn('r1', 350000));
    assert.match(ctxText(runHook('hooks/subagent-context.mjs', pre(lead))), /Context at \d+K: finish the current step/);
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
  assert.equal(cfg.userConfig.subagent_context_notice_tokens.default, 110000);
  assert.equal(subagentNoticeText(['size'], 110000).startsWith('[agent-companion] Context at 110K: finish the current step, '), true);
  assert.equal(subagentNoticeText(['size'], 110000, 'writer', { ctx: 126000, hard: 150000 }), `[agent-companion] Context at 126K, limit 150K: finish the current step, ${HAND}`);
  assert.equal(subagentNoticeText(['compaction', 'size'], 110000), `[agent-companion] You just compacted. Context at 110K: finish the current step, ${HAND}`);
  assert.equal(subagentNoticeText(['compaction'], 110000), '[agent-companion] You compacted; re-read only what the next step needs and continue.');
  assert.equal(cfg.userConfig.step_budget_compaction_stop.default, 3);
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

// --- Review round (0.31.54 fix): the size notice is role-aware ----------------------------------------------------------

test('unit: noticeVariant reads read-only from a reviewer, lookup, plan leg or built-in read-only agent, and writer otherwise', () => {
  const ro = [
    'ROLE: reviewer\nTYPE: code-review\nreview it', 'TYPE: code-review\nreview it', 'ROLE: lookup\nfind it', 'TYPE: research\nfind it',
    'TYPE: survey\nx', 'TYPE: explore\nx', 'TYPE: verify\nx', 'ROLE: other\nTYPE: large-refactor\nplan it', 'ROLE: plan\nTYPE: novel-design\nx',
    'TYPE: debug-root-cause\nRead-only: write x-plan.md', 'ROLE: operate\ndeploy',
  ];
  for (const b of ro) assert.equal(noticeVariant(b, 'agent-companion:ac-sonnet-high'), 'readonly', b);
  for (const t of ['Explore', 'Plan', 'claude-code-guide']) assert.equal(noticeVariant('TYPE: integration\nROLE: writer', t), 'readonly', t);
  const wr = ['ROLE: writer\nTYPE: integration\nbuild', 'ROLE: fixer\nfix', 'ROLE: lander\nland', 'ROLE: docs\nwrite docs', 'TYPE: bounded-feature\nbuild', 'TYPE: large-refactor\nROLE: writer\nbuild', 'go', ''];
  for (const b of wr) assert.equal(noticeVariant(b, 'general-purpose'), 'writer', JSON.stringify(b));
  assert.equal(noticeVariant('ROLE: fixer\nTYPE: lookup\nfix', 'general-purpose'), 'writer', 'the ROLE wins over the TYPE');
});

test('past 110k: a reviewer, a lookup and a plan leg are told to write their findings and return, never to commit or push; a writer is told to commit and hand off', () => {
  const notice = (brief, id) => {
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx);
      writeFileSync(join(dirname(agentFile), `agent-${id}.jsonl`), user(brief) + turn('r1', 120000));
      return ctxText(runHook('hooks/subagent-context.mjs', pre(lead, { agent_id: id })));
    } finally { fx.cleanup(); }
  };
  for (const [name, brief] of [
    ['reviewer', 'TYPE: code-review\nROLE: reviewer\nWRITER: sonnet/high\nNo commits, no pushes. Review the diff.'],
    ['lookup', 'TYPE: lookup\nROLE: lookup\nfind the caller'],
    ['plan leg', 'TYPE: large-refactor\nROLE: other\nplan it, write task-plan.md'],
  ]) {
    const t = notice(brief, `ro-${name.replace(' ', '')}`);
    assert.match(t, /^\[agent-companion\] Context at 120K: finish the current step, /, name);
    assert.match(t, /write your findings so far to your detail file/, name);
    assert.doesNotMatch(t, /commit|push|handoff\.md|DONE: partial/, `${name}: never told to commit, push or hand off`);
  }
  for (const [name, brief] of [['writer', 'TYPE: integration\nROLE: writer\nbuild it'], ['fixer', 'ROLE: fixer\nfix it'], ['lander', 'ROLE: lander\nland it']]) {
    assert.equal(notice(brief, `wr-${name}`), NOTE(120), name);
  }
});

test('subagentNoticeText: the read-only variant is the size notice only; a compaction alone is unchanged', () => {
  assert.equal(subagentNoticeText(['compaction'], 110000, 'readonly'), '[agent-companion] You compacted; re-read only what the next step needs and continue.');
  const t = subagentNoticeText(['compaction', 'size'], 110000, 'readonly');
  assert.match(t, /^\[agent-companion\] You just compacted\. Context at \d+K: finish the current step, write your findings so far/);
  assert.doesNotMatch(t, /commit|push/);
});

test('noticeVariant: a ROLE: writer brief that names a plan file and says read-only still gets the writer notice', () => {
  assert.equal(noticeVariant('ROLE: writer\nTYPE: novel-design\nwork from x-plan.md; fixtures are read-only', 'general-purpose'), 'writer');
  assert.equal(noticeVariant('ROLE: fixer\nfix per x-plan.md\n[agent-companion] read only', 'general-purpose'), 'writer');
  assert.equal(noticeVariant('Write x-plan.md. This is read-only.', 'general-purpose'), 'readonly', 'no ROLE: the text clause applies');
});

test('noticeVariant: a plan marker on a type with no plan leg does not make a writer read-only; the real appended protocol text is ignored', () => {
  assert.equal(noticeVariant('TYPE: bounded-feature\nimplement per docs/foo-plan.md; keep fixtures read-only', 'general-purpose'), 'writer');
  assert.equal(noticeVariant('TYPE: novel-design\nwrite x-plan.md. Read-only.', 'general-purpose'), 'readonly');
  assert.equal(noticeVariant(`TYPE: novel-design\nbuild from x-plan.md${selfReviewBriefText('ac-sonnet-high')}`, 'general-purpose'), 'writer');
});
