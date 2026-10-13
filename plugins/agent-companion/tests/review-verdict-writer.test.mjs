// 0.31.17: review verdict rows record the writer under review (WRITER: line) and the reviewer's own
// model and effort, on the foreground and the background paths. Old rows without them still fold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { writerOf } from '../hooks/lib/review-verdict.mjs';
import { readSpawnRows } from '../scripts/lib/decision-register.mjs';

const SID = 'sess-wr';
const brief = (w) => `TYPE: code-review\nROLE: reviewer\n${w ? `WRITER: ${w}\n` : ''}Review the diff.`;
const rows = () => readJsonl(join(telemetryDir(), 'review-verdicts.jsonl'));
const fg = (tu, prompt) => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { description: 'review', prompt, name: 'rev-w' },
  tool_response: { status: 'completed', content: [{ type: 'text', text: 'VERDICT: FIX' }] },
});
const spawnRow = (tu) => JSON.stringify({ at: '2026-10-13T09:00:00Z', session_id: SID, tool_use_id: tu, model: 'opus', spawn_effort: 'high', caller_effort: 'xhigh' }) + '\n';

test('writerOf parses the WRITER line like spawn-guard', () => {
  assert.deepEqual(writerOf(brief('sonnet/medium')), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(writerOf(brief('haiku medium')), { model: 'haiku', effort: 'medium' });
  assert.deepEqual(writerOf(brief(null)), { model: null, effort: null });
  assert.deepEqual(writerOf(brief('gibberish words here')), { model: null, effort: null });
  assert.deepEqual(writerOf(undefined), { model: null, effort: null });
});

test('foreground row carries reviewed and reviewer model/effort', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), spawnRow('toolu_w1'));
    runHook('hooks/review-verdict.mjs', fg('toolu_w1', brief('sonnet/medium')));
    const r = rows()[0];
    assert.equal(r.reviewed_model, 'sonnet');
    assert.equal(r.reviewed_effort, 'medium');
    assert.equal(r.reviewer_model, 'opus');
    assert.equal(r.reviewer_effort, 'high');
  } finally { fx.cleanup(); }
});

test('no WRITER line and no spawn row: fields are null, row still written', () => {
  const fx = makeFixture();
  try {
    runHook('hooks/review-verdict.mjs', fg('toolu_w2', brief(null)));
    const r = rows()[0];
    assert.equal(r.review_verdict, 'FIX');
    for (const k of ['reviewed_model', 'reviewed_effort', 'reviewer_model', 'reviewer_effort']) assert.equal(r[k], null);
  } finally { fx.cleanup(); }
});

test('background path remembers the writer at launch and records it at stop', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), spawnRow('toolu_w3'));
    const prompt = brief('haiku/medium');
    runHook('hooks/review-verdict.mjs', {
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_w3',
      tool_input: { description: 'review', prompt, name: 'rev-w', run_in_background: true },
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'agentw3' },
    });
    runHook('hooks/review-verdict.mjs', {
      session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'agentw3', last_assistant_message: 'VERDICT: PASS',
    }, { args: ['--event', 'stop'] });
    const r = rows()[0];
    assert.equal(r.source, 'subagent-stop');
    assert.equal(r.reviewed_model, 'haiku');
    assert.equal(r.reviewed_effort, 'medium');
    assert.equal(r.reviewer_model, 'opus');
  } finally { fx.cleanup(); }
});

test('an old verdict row without the new fields still folds into the spawn rows', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), spawnRow('toolu_w4'));
    writeFileSync(join(telemetryDir(), 'review-verdicts.jsonl'),
      JSON.stringify({ session_id: SID, review_of_tool_use_id: 'toolu_w4', review_verdict: 'PASS' }) + '\n');
    const got = readSpawnRows(join(telemetryDir(), 'spawns.jsonl'));
    assert.equal(got.find((r) => r.tool_use_id === 'toolu_w4')?.review_verdict, 'PASS');
  } finally { fx.cleanup(); }
});
