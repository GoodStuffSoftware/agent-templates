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
import { thresholdFor, longRunText } from '../hooks/lib/long-run.mjs';

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

test('the note text is short and says what to do', () => {
  const t = longRunText(150);
  assert.match(t, /Step 150: if you are making progress, keep going and update your running notes file now; if you are stuck or looping, stop and report what is blocking\./);
  assert.ok(t.length < 240, 'about 60 tokens at most');
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
      assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined, 'never a deny');
      assert.equal(ctx(r), longRunText(n), `call ${n}`);
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
    assert.equal(ctx(r), longRunText(400));
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

test('no agent definition carries maxTurns any more', () => {
  const dir = join(PLUGIN_ROOT, 'agents');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 12);
  for (const f of files) {
    const fm = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').split('\n---\n')[0];
    assert.doesNotMatch(fm, /^maxTurns:/m, f);
  }
});
