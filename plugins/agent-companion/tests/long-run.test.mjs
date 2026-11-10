// Soft long-run note (replaces the hard maxTurns: 150): hooks/subagent-context.mjs counts a
// subagent tool calls (state/long-runs/<agent_id>.cnt, one byte per call), tells it ONCE at
// 150 and at every further 100 to keep going or report, and logs each crossing as one row in
// state/long-runs.jsonl. It never denies; the lead (no agent_id) is never counted.
// Library: hooks/lib/long-run.mjs. A test seeds N-1 counter bytes and runs the hook once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { thresholdFor, longRunText, longRunRow, longRunSummaryRow } from '../hooks/lib/long-run.mjs';
import { leadLongRunText } from '../hooks/lib/advisory-b.mjs';

const SID = 'sess-long';
const AGENT = 'worker-long-test-1';
const OFF = {
  CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0', CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0',
};
const STARTED = '2026-11-01T10:00:00.000Z';

const user = (t) => `${JSON.stringify({ type: 'user', timestamp: STARTED, message: { role: 'user', content: t } })}\n`;

function layout(fx, brief = '\n  Build the widget\nTYPE: bounded-feature\nmore') {
  const proj = join(fx.dir, 'projects', 'proj-long');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  const agentFile = join(sub, `agent-${AGENT}.jsonl`);
  writeFileSync(agentFile, user(brief));
  return { lead, agentFile };
}

const cnt = (agent = AGENT) => join(stateDir(), 'long-runs', `${agent}.cnt`);
function seed(n, agent = AGENT) { // make the next call the Nth
  mkdirSync(join(stateDir(), 'long-runs'), { recursive: true });
  writeFileSync(cnt(agent), '.'.repeat(n - 1));
}
const pre = (lead, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'ac-sonnet-high', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', ...extra,
});
const run = (lead, extra = {}) => runHook('hooks/subagent-context.mjs', pre(lead, extra), { env: { ...OFF, CLAUDE_PLUGIN_OPTION_STEP_BUDGET: 'false' } });
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const rows = () => readJsonl(join(stateDir(), 'long-runs.jsonl'));

test('thresholds: 150, then every further 100', () => {
  assert.equal(thresholdFor(1), null);
  assert.equal(thresholdFor(149), null);
  assert.equal(thresholdFor(150), 150);
  assert.equal(thresholdFor(249), 150);
  assert.equal(thresholdFor(250), 250);
  assert.equal(thresholdFor(350), 350);
  assert.equal(thresholdFor(449), 350);
});

test('the worker line is a neutral progress marker: it says it is not a cap and asks only for a current detail file', () => {
  const t = longRunText(150);
  assert.equal(t, '[agent-companion] Step 150: this is a progress marker, not a cap, and nothing will interrupt your run. Carry on as you were; the only ask is that you keep your detail file current.');
  assert.ok(t.length < 240, 'about 60 tokens at most');
  // Operator ruling 2026-11-10: a step count must not read as a cap. None of these words may reach a worker at the long-run mark.
  for (const w of ['budget', 'limit', 'finish', 'wrap up', 'stop', 'hand off', 'handoff', 'report what']) assert.equal(t.toLowerCase().includes(w), false, w);
  assert.doesNotMatch(t, /\bof \d+ steps\b/i);
});

test('counting: one byte per call, per agent_id; silent below 150', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    for (let i = 0; i < 3; i += 1) assert.equal(run(lead).stdout.trim(), '');
    assert.equal(statSync(cnt()).size, 3);
    run(lead, { agent_id: 'worker-other' });
    assert.equal(statSync(cnt()).size, 3);
    assert.equal(statSync(cnt('worker-other')).size, 1);
    assert.equal(existsSync(join(stateDir(), 'long-runs.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('the call before a threshold is silent, the threshold call injects once', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    for (const n of [150, 250, 350]) {
      seed(n - 1);
      assert.equal(run(lead).stdout.trim(), '', `call ${n - 1}`);
      const r = run(lead);
      assert.equal(r.status, 0);
      if (n === 150) assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined, 'never a deny');
      assert.equal(ctx(r), n === 150 ? longRunText(n) : '', `call ${n}: the worker hears the marker at the first mark only`);
      // once per threshold: the next calls past it say nothing
      assert.equal(run(lead).stdout.trim(), '', `call ${n + 1}`);
      assert.equal(run(lead).stdout.trim(), '', `call ${n + 2}`);
    }
    assert.deepEqual(rows().map((r) => r.steps), [150, 250, 350]);
  } finally { fx.cleanup(); }
});

test('a call that races past the exact number still fires the threshold once', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    seed(152); // another parallel call took 150 and 151 without winning the claim
    assert.equal(ctx(run(lead)), longRunText(152));
    seed(153);
    assert.equal(run(lead).stdout.trim(), '');
    assert.deepEqual(rows().map((r) => r.steps), [152]);
  } finally { fx.cleanup(); }
});

test('log row has exactly the agreed schema', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    seed(150);
    run(lead);
    const [row] = rows();
    assert.deepEqual(Object.keys(row), ['ts', 'sessionId', 'agentId', 'agentType', 'steps', 'startedAt', 'durationMin', 'description', 'transcriptPath']);
    assert.match(row.ts, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(row.sessionId, SID);
    assert.equal(row.agentId, AGENT);
    assert.equal(row.agentType, 'ac-sonnet-high');
    assert.equal(row.steps, 150);
    assert.equal(row.startedAt, STARTED);
    assert.equal(typeof row.durationMin, 'number');
    assert.ok(row.durationMin > 0);
    assert.equal(row.description, 'Build the widget'); // first non-empty line of the brief
    assert.equal(row.transcriptPath.replace(/\\/g, '/'), agentFile.replace(/\\/g, '/'));
  } finally { fx.cleanup(); }
});

test('an unreadable transcript gives null fields, not a missing row', () => {
  const fx = makeFixture();
  try {
    const lead = join(fx.dir, 'nowhere.jsonl');
    seed(150);
    const r = run(lead);
    assert.equal(ctx(r), longRunText(150));
    const [row] = rows();
    assert.equal(row.startedAt, null);
    assert.equal(row.durationMin, null);
    assert.equal(row.description, null);
    assert.equal(row.transcriptPath, null);
    assert.equal(row.agentId, AGENT);
    assert.equal(row.steps, 150);
  } finally { fx.cleanup(); }
});

test('the main thread (no agent_id) is not counted, warned or logged', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const payload = pre(lead);
    delete payload.agent_id;
    delete payload.agent_type;
    seed(150);
    const r = runHook('hooks/subagent-context.mjs', payload, { env: OFF });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(statSync(cnt()).size, 149);
    assert.equal(existsSync(join(stateDir(), 'long-runs.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('never blocks: far past the thresholds the call is allowed', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    seed(400);
    const r = run(lead);
    assert.equal(r.status, 0);
    assert.notEqual(r.json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(r.json?.continue, undefined);
    assert.equal(ctx(r), '', 'far past the first mark the worker hears nothing more');
    assert.equal(rows().at(-1).steps, 400, 'but the crossing is still logged for the lead and the scout');
  } finally { fx.cleanup(); }
});

test('with the step budget on, a 150 crossing is counted, logged and noted', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, 'TYPE: bounded-feature\nBUDGET: 9999\nbuild');
    seed(150);
    const r = runHook('hooks/subagent-context.mjs', pre(lead), { env: OFF });
    assert.ok(ctx(r).includes(longRunText(150)));
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('a writer with no BUDGET line hears nothing before the first mark and exactly the neutral line at it (step budget on, opt-in stop off)', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, 'TYPE: bounded-feature\nbuild the widget');
    const on = (l = lead) => runHook('hooks/subagent-context.mjs', pre(l), { env: OFF });
    for (const n of [1, 40, 60, 80, 81, 100, 120, 121, 149]) {
      seed(n);
      const r = on();
      assert.equal(r.stdout.trim(), '', `call ${n}`);
      assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined);
    }
    seed(150);
    const r = on();
    assert.equal(ctx(r), longRunText(150));
    assert.equal(ctx(r), '[agent-companion] Step 150: this is a progress marker, not a cap, and nothing will interrupt your run. Carry on as you were; the only ask is that you keep your detail file current.');
    seed(151);
    assert.equal(on().stdout.trim(), '', 'once');
    // a lookup-type brief gets the same: no 40 / 60 notes either
    const lk = layout(fx, 'TYPE: research\nfind it');
    for (const n of [40, 60]) { seed(n); assert.equal(on(lk.lead).stdout.trim(), '', `lookup call ${n}`); }
  } finally { fx.cleanup(); }
});

test('the lead is told once per mark per worker, with the name and minutes, and the worker never sees that line', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    writeFileSync(join(lead, '..', SID, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ name: 'builder-one', agentType: 'ac-sonnet-high' }));
    seed(150);
    const w = run(lead);
    assert.equal(ctx(w).includes('Long run:'), false, 'not in the worker context');
    const leadPayload = { hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: lead, cwd: 'x', prompt: 'hi' };
    const lr = runHook('hooks/advisory-b.mjs', leadPayload, { args: ['--event', 'user-prompt'], env: OFF });
    assert.equal(lr.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const t = lr.json.hookSpecificOutput.additionalContext;
    assert.match(t, /^Long run: builder-one is at 150 steps, \d+ min\. Nothing stops it\.$/m);
    // once: the next prompt and the next tool call (tick) are silent about it
    assert.equal(runHook('hooks/advisory-b.mjs', leadPayload, { args: ['--event', 'user-prompt'], env: OFF }).stdout.includes('Long run:'), false);
    const tickPayload = { ...leadPayload, hook_event_name: 'PostToolUse', tool_name: 'Bash' };
    assert.equal(runHook('hooks/advisory-b.mjs', tickPayload, { args: ['--event', 'tick'], env: OFF }).stdout.includes('Long run:'), false);
    // the next mark is a new line; another session sees nothing; a worker's own hook (agent_id set) is passed through
    seed(250);
    run(lead);
    const next = runHook('hooks/advisory-b.mjs', tickPayload, { args: ['--event', 'tick'], env: OFF });
    assert.match(next.json.hookSpecificOutput.additionalContext, /Long run: builder-one is at 250 steps/);
    const other = runHook('hooks/advisory-b.mjs', { ...leadPayload, session_id: 'sess-other' }, { args: ['--event', 'user-prompt'], env: OFF });
    assert.equal(other.stdout.includes('Long run:'), false);
    const inWorker = runHook('hooks/advisory-b.mjs', { ...leadPayload, agent_id: AGENT, agent_type: 'ac-sonnet-high' }, { args: ['--event', 'user-prompt'], env: OFF });
    assert.equal(inWorker.stdout.includes('Long run:'), false);
  } finally { fx.cleanup(); }
});

test('a worker that passed the first mark leaves one summary row when it ends; a short one leaves none', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx, 'TYPE: bounded-feature\nbuild the widget');
    const tu = (id, name) => JSON.stringify({ type: 'assistant', timestamp: STARTED, message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input: {} }] } });
    const tr = (id, err) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: 'x' }] } });
    writeFileSync(agentFile, user('TYPE: bounded-feature\nbuild the widget') + [tu('t1', 'Bash'), tr('t1', true), tu('t2', 'Bash'), tr('t2', false), tu('t3', 'Read'), tr('t3', false), tu('t4', 'Edit'), tr('t4', true)].join('\n') + '\n');
    const stop = () => runHook('hooks/advisory-b.mjs', { hook_event_name: 'SubagentStop', session_id: SID, transcript_path: lead, agent_id: AGENT, agent_type: 'ac-sonnet-high', agent_transcript_path: agentFile }, { args: ['--event', 'worker-stop'], env: OFF });
    seed(120);
    stop();
    assert.equal(existsSync(join(stateDir(), 'long-runs.jsonl')), false, 'passed no mark: no row');
    seed(181);
    stop();
    const sum = rows().filter((r) => r.kind === 'summary');
    assert.equal(sum.length, 1);
    const [row] = sum;
    assert.equal(row.agentId, AGENT);
    assert.equal(row.type, 'bounded-feature');
    assert.equal(row.rung, 4);
    assert.equal(row.steps, 180);
    assert.deepEqual(row.toolCounts, { Bash: 2, Read: 1, Edit: 1 });
    assert.equal(row.failedCommands, 1, 'only a failed Bash counts');
    assert.equal(row.briefChars, 'TYPE: bounded-feature\nbuild the widget'.length);
    assert.ok(row.minutes > 0);
  } finally { fx.cleanup(); }
});

test('no agent definition carries maxTurns any more', () => {
  const dir = join(PLUGIN_ROOT, 'agents');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 12);
  for (const f of files) {
    const fm = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').split('\n---\n')[0];
    assert.doesNotMatch(fm, /^maxTurns:/m, f);
  }
});

test('one run steps from 148 to 260: the worker hears exactly one line, at 150, and the lead log has a row at 150 and at 250', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    seed(148); // the next call is the 148th
    const lines = [];
    for (let n = 148; n <= 260; n++) {
      const text = ctx(run(lead));
      if (text) lines.push([n, text]);
    }
    assert.deepEqual(lines, [[150, longRunText(150)]], 'one worker line per run, at 150');
    assert.deepEqual(rows().map((r) => r.steps), [150, 250]);
  } finally { fx.cleanup(); }
});

test('a clock behind the start of the run never shows negative minutes: the crossing row, the summary row and the lead line', () => {
  const fx = makeFixture();
  try {
    const { agentFile } = layout(fx);
    const before = new Date(Date.parse(STARTED) - 5 * 60000); // "now" five minutes before the transcript says the run began
    assert.equal(longRunRow({ agent_id: AGENT }, 150, agentFile, before).durationMin, 0);
    seed(151);
    const sum = longRunSummaryRow({ agent_id: AGENT, session_id: SID }, { transcript: agentFile, now: before });
    assert.equal(sum.minutes, 0);
    assert.match(leadLongRunText('builder-one', 150, -5), /at 150 steps, 0 min\./);
  } finally { fx.cleanup(); }
});
