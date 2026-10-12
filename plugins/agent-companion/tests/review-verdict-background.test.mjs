// Background reviewer verdicts (0.31.14): the PostToolUse launch acknowledgement is remembered by
// agent id, the SubagentStop event carries the final message, and the same parser and row format
// as the foreground path (tests/review-verdict.test.mjs) apply.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { evalMetric, emptyState, readSpawnRows } from '../scripts/lib/decision-register.mjs';

const REVIEW_BRIEF = 'TYPE: code-review\nROLE: reviewer\nReview the diff.';
const WRITER_BRIEF = 'TYPE: bounded-feature\nROLE: writer\nBuild it.';
const SID = 'sess-bg';

// The launch acknowledgement, in the shape the transcript's toolUseResult records for a background Agent call.
const launch = (id, tu, prompt = REVIEW_BRIEF, name = 'rev-bg') => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { description: 'review', prompt, subagent_type: 'general-purpose', name, run_in_background: true },
  tool_response: {
    isAsync: true, status: 'async_launched', agentId: id, description: 'review', prompt,
    outputFile: `/tmp/${id}.output`, canReadOutputFile: true, canContinueAgent: true,
  },
});
const stop = (id, msg, extra = {}) => ({
  session_id: SID, hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'general-purpose',
  last_assistant_message: msg, ...extra,
});
const fgPost = (tu, text, prompt = REVIEW_BRIEF) => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { description: 'review', prompt, name: 'rev-bg' },
  tool_response: { status: 'completed', content: [{ type: 'text', text }] },
});
const rows = () => readJsonl(join(telemetryDir(), 'review-verdicts.jsonl'));
const post = (payload, env) => runHook('hooks/review-verdict.mjs', payload, { env });
const onStop = (payload, env) => runHook('hooks/review-verdict.mjs', payload, { args: ['--event', 'stop'], env });

for (const [text, want] of [
  ['Findings below.\nVERDICT: PASS - no issues', 'PASS'],
  ['- a nit\nVERDICT: FIX', 'FIX'],
  ['VERDICT: BLOCK - cannot ship', 'BLOCK'],
]) {
  test(`background reviewer: ${want} is recorded from the SubagentStop message`, () => {
    const fx = makeFixture();
    try {
      const l = post(launch('agentbg1', 'toolu_bg1'));
      assert.equal(l.stdout.trim(), '');
      assert.equal(rows().length, 0, 'the launch acknowledgement records nothing');
      const r = onStop(stop('agentbg1', text));
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', 'no output to the model');
      const got = rows();
      assert.equal(got.length, 1);
      assert.equal(got[0].review_verdict, want);
      assert.equal(got[0].review_of_tool_use_id, 'toolu_bg1');
      assert.equal(got[0].session_id, SID);
      assert.equal(got[0].name, 'rev-bg');
      assert.equal(got[0].declared_type, 'code-review');
      assert.equal(got[0].declared_role, 'reviewer');
      assert.equal(got[0].source, 'subagent-stop');
      assert.equal(got[0].agent_id, 'agentbg1');
    } finally { fx.cleanup(); }
  });
}

test('background reviewer: a final message with no VERDICT line writes no row', () => {
  const fx = makeFixture();
  try {
    post(launch('agentbg2', 'toolu_bg2'));
    onStop(stop('agentbg2', 'Looks fine to me.'));
    assert.equal(rows().length, 0);
    assert.equal(existsSync(join(telemetryDir(), 'review-verdicts.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('background reviewer: the transcript is read when last_assistant_message is absent', () => {
  const fx = makeFixture();
  try {
    post(launch('agentbg3', 'toolu_bg3'));
    const tp = join(fx.dir, 'agent-agentbg3.jsonl');
    writeFileSync(tp, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
      { type: 'user', message: { role: 'user', content: 'x' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done\nVERDICT: FIX' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    onStop({ ...stop('agentbg3', undefined), last_assistant_message: undefined, agent_transcript_path: tp });
    const got = rows();
    assert.equal(got.length, 1);
    assert.equal(got[0].review_verdict, 'FIX');
  } finally { fx.cleanup(); }
});

test('a non-reviewer background spawn writes nothing, and its stop is ignored even with a VERDICT line', () => {
  const fx = makeFixture();
  try {
    post(launch('agentbgw', 'toolu_w', WRITER_BRIEF, 'w'));
    assert.equal(existsSync(join(fx.stateDir, 'state', 'review-agents', 'agentbgw.json')), false, 'no mapping for a writer');
    onStop(stop('agentbgw', 'VERDICT: PASS'));
    onStop(stop('agent-never-launched', 'VERDICT: PASS'));
    assert.equal(rows().length, 0);
    assert.equal(existsSync(join(telemetryDir(), 'review-verdicts.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('dedupe: the foreground path recorded the spawn, so the stop writes nothing; and a repeat stop writes nothing', () => {
  const fx = makeFixture();
  try {
    // foreground result recorded first, then a stop for an agent carrying the same spawn id
    post(launch('agentbg4', 'toolu_bg4'));
    post(fgPost('toolu_bg4', 'VERDICT: PASS'));
    assert.equal(rows().length, 1);
    onStop(stop('agentbg4', 'VERDICT: FIX'));
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].review_verdict, 'PASS');
    assert.equal(rows()[0].source, 'post-tool-use');
    // background first, then the same stop again (SendMessage continuation), then a foreground echo
    post(launch('agentbg5', 'toolu_bg5'));
    onStop(stop('agentbg5', 'VERDICT: FIX'));
    onStop(stop('agentbg5', 'VERDICT: PASS'));
    post(fgPost('toolu_bg5', 'VERDICT: PASS'));
    const bg = rows().filter((r) => r.review_of_tool_use_id === 'toolu_bg5');
    assert.equal(bg.length, 1);
    assert.equal(bg[0].review_verdict, 'FIX');
  } finally { fx.cleanup(); }
});

test('a stop with no verdict leaves the launch remembered, so a later stop with one is recorded', () => {
  const fx = makeFixture();
  try {
    post(launch('agentbg6', 'toolu_bg6'));
    onStop(stop('agentbg6', 'Question: which branch?'));
    assert.equal(rows().length, 0);
    onStop(stop('agentbg6', 'VERDICT: PASS'));
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('the agent id is also read from the launch text when the payload has no agentId field', () => {
  const fx = makeFixture();
  try {
    const l = launch('agentbg7', 'toolu_bg7');
    l.tool_response = { content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: agentbg7 (internal ID)' }], status: 'async_launched' };
    post(l);
    onStop(stop('agentbg7', 'VERDICT: FIX'));
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('spawn_telemetry off: neither the launch nor the stop writes anything; garbage input fails open', () => {
  const fx = makeFixture();
  try {
    const off = { CLAUDE_PLUGIN_OPTION_SPAWN_TELEMETRY: 'false' };
    post(launch('agentbg8', 'toolu_bg8'), off);
    onStop(stop('agentbg8', 'VERDICT: FIX'), off);
    assert.equal(rows().length, 0);
    assert.equal(existsSync(join(fx.stateDir, 'state', 'review-agents')), false);
    assert.equal(onStop({}).status, 0);
    assert.equal(onStop(stop('../../etc', 'VERDICT: FIX')).status, 0);
    assert.equal(post(launch(null, 'toolu_x')).status, 0);
    assert.equal(rows().length, 0);
  } finally { fx.cleanup(); }
});

test('copies the reviewer spawn row\'s effort and writer link on the background path', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), JSON.stringify({
      at: '2026-10-10T09:00:00Z', session_id: SID, tool_use_id: 'toolu_bg9', caller_is_subagent: false,
      caller_effort: 'high', caller_tool_use_id: null, declared_type: 'code-review',
    }) + '\n');
    post(launch('agentbg9', 'toolu_bg9'));
    onStop(stop('agentbg9', 'VERDICT: FIX'));
    const r = rows()[0];
    assert.equal(r.caller_effort, 'high');
    assert.equal(r.spawn_row_found, true);
  } finally { fx.cleanup(); }
});

test('hooks.json registers the stop path on SubagentStop and keeps the PostToolUse ^Agent$ one', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const has = (g) => g.hooks.some((x) => x.args.some((a) => a.endsWith('review-verdict.mjs')));
  const stopGroups = (h.SubagentStop || []).filter(has);
  assert.equal(stopGroups.length, 1);
  const hook = stopGroups[0].hooks.find((x) => x.args.some((a) => a.endsWith('review-verdict.mjs')));
  assert.deepEqual(hook.args.slice(1), ['--event', 'stop']);
  assert.equal(hook.type, 'command');
  assert.equal((h.PostToolUse || []).filter(has).length, 1);
  assert.equal((h.PostToolUse || []).filter(has)[0].matcher, '^Agent$');
});

test('end to end: background verdicts feed reviewFixShareByLeadEffort', () => {
  const fx = makeFixture();
  try {
    const day = '2026-10-10';
    const at = (i) => new Date(Date.parse(`${day}T09:00:00Z`) + i * 60000).toISOString();
    const spawn = [
      { at: at(0), session_id: SID, caller_is_subagent: false, caller_effort: 'high', tool_use_id: 'w1', declared_type: 'bounded-feature' },
      { at: at(1), session_id: SID, caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r1', caller_tool_use_id: 'w1', declared_type: 'code-review' },
      { at: at(2), session_id: SID, caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r2', caller_tool_use_id: 'w1', declared_type: 'code-review' },
      { at: at(3), session_id: SID, caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r3', caller_tool_use_id: 'w1', declared_type: 'code-review' },
    ];
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), spawn.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const [id, tu] of [['ag1', 'r1'], ['ag2', 'r2'], ['ag3', 'r3']]) post(launch(id, tu));
    onStop(stop('ag1', 'VERDICT: FIX'));
    onStop(stop('ag2', 'VERDICT: PASS'));
    onStop(stop('ag3', 'no verdict here'));
    const merged = readSpawnRows();
    assert.equal(merged.length, 4);
    assert.deepEqual(merged.map((r) => r.review_verdict), [undefined, 'FIX', 'PASS', undefined]);
    const t = {
      id: 'rf', premise: 'p1', kind: 'metric', source: 'spawns', metric: 'reviewFixShareByLeadEffort',
      params: { levels: ['high'] }, op: '>', threshold: 0, minSample: 1, minDays: 1,
    };
    const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: merged, nowT: Date.parse('2026-10-12T10:00:00Z'), state: emptyState(), activeFromMs: null });
    const d = v.days.find((x) => x.qualifies);
    assert.equal(d.value, 50);
  } finally { fx.cleanup(); }
});
