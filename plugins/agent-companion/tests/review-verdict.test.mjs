// Review verdict telemetry: hooks/review-verdict.mjs (PostToolUse ^Agent$) records a reviewer's
// VERDICT line to telemetry/review-verdicts.jsonl; the register folds it into the spawns rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { parseVerdict } from '../hooks/lib/review-verdict.mjs';
import { evalMetric, emptyState, readSpawnRows } from '../scripts/lib/decision-register.mjs';

const REVIEW_BRIEF = 'TYPE: code-review\nROLE: reviewer\nReview the diff.';
const post = (o = {}) => ({
  session_id: 'sess-rv', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_rv1',
  tool_input: { description: 'review', prompt: REVIEW_BRIEF, subagent_type: 'general-purpose', name: 'rev-1' },
  tool_response: { status: 'completed', content: [{ type: 'text', text: 'VERDICT: PASS' + '\n' + 'no findings' }] },
  ...o,
});
const respond = (text) => ({ tool_response: { status: 'completed', content: [{ type: 'text', text }] } });
const rows = () => readJsonl(join(telemetryDir(), 'review-verdicts.jsonl'));
const run = (payload) => runHook('hooks/review-verdict.mjs', payload);

for (const [text, want] of [
  ['VERDICT: PASS' + '\n' + 'clean', 'PASS'],
  ['intro\nVERDICT: FIX' + '\n' + '- blocker a', 'FIX'],
  ['VERDICT: BLOCK - cannot ship', 'BLOCK'],
  ['**VERDICT: APPROVE WITH FIXES** - one nit', 'FIX'],
  ['VERDICT: REQUEST CHANGES', 'FIX'],
  ['VERDICT: PASS (no blockers)', 'PASS'],
  ['VERDICT: PASS - no blockers found', 'PASS'],
  ['VERDICT: PASS, nothing to fix', 'PASS'],
  ['VERDICT: PASS. Zero failures.', 'PASS'],
  ['VERDICT: PASS (0 requests)', 'PASS'],
  ['VERDICT: FIX (1 blocker)', 'FIX'],
  ['VERDICT: SHIP-WITH-FIXES', 'FIX'],
]) {
  test(`records ${want} from "${text.split('\n')[0]}"`, () => {
    const fx = makeFixture();
    try {
      const r = run(post(respond(text)));
      assert.equal(r.stdout.trim(), '', 'no output to the model');
      const got = rows();
      assert.equal(got.length, 1);
      assert.equal(got[0].review_verdict, want);
      assert.equal(got[0].session_id, 'sess-rv');
      assert.equal(got[0].review_of_tool_use_id, 'toolu_rv1');
      assert.equal(got[0].name, 'rev-1');
      assert.ok(Date.parse(got[0].at) > 0);
    } finally { fx.cleanup(); }
  });
}

test('a result with no VERDICT line writes no row', () => {
  const fx = makeFixture();
  try {
    const r = run(post(respond('Looks fine to me, nothing to add.')));
    assert.equal(r.stdout.trim(), '');
    assert.equal(rows().length, 0);
    assert.equal(parseVerdict('VERDICT: unclear musings'), null);
  } finally { fx.cleanup(); }
});

test('a non-reviewer spawn writes nothing, even with a VERDICT line', () => {
  const fx = makeFixture();
  try {
    run(post({ tool_input: { description: 'w', prompt: 'TYPE: bounded-feature\nROLE: writer\nbuild', name: 'w' } }));
    assert.equal(rows().length, 0);
    assert.equal(existsSync(join(telemetryDir(), 'review-verdicts.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('ROLE: reviewer alone qualifies; garbage input and a string response fail open', () => {
  const fx = makeFixture();
  try {
    run(post({ tool_input: { prompt: 'ROLE: reviewer\nlook' }, tool_response: 'VERDICT: FIX' }));
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].declared_type, null);
    assert.equal(run({}).status, 0);
    assert.equal(run(post({ tool_response: null })).status, 0);
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('copies the reviewer spawn row\'s effort and writer link when the row exists', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), JSON.stringify({
      at: '2026-10-10T09:00:00Z', session_id: 'sess-rv', tool_use_id: 'toolu_rv1', caller_is_subagent: false,
      caller_effort: 'high', caller_tool_use_id: null, declared_type: 'code-review',
    }) + '\n');
    run(post(respond('VERDICT: FIX')));
    const r = rows()[0];
    assert.equal(r.caller_effort, 'high');
    assert.equal(r.caller_is_subagent, false);
    assert.equal(r.spawn_row_found, true);
  } finally { fx.cleanup(); }
});

test('hooks.json registers the hook on PostToolUse ^Agent$ only', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const groups = (h.PostToolUse || []).filter((g) => g.hooks.some((x) => x.args.some((a) => a.endsWith('review-verdict.mjs'))));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, '^Agent$');
});

test('end to end: hook rows feed reviewFixShareByLeadEffort and it produces a value', () => {
  const fx = makeFixture();
  try {
    const day = '2026-10-10';
    const at = (i) => new Date(Date.parse(`${day}T09:00:00Z`) + i * 60000).toISOString();
    const spawn = [
      { at: at(0), session_id: 'sess-rv', caller_is_subagent: false, caller_effort: 'high', tool_use_id: 'w1', declared_type: 'bounded-feature' },
      { at: at(1), session_id: 'sess-rv', caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r1', caller_tool_use_id: 'w1', declared_type: 'code-review' },
      { at: at(2), session_id: 'sess-rv', caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r2', caller_tool_use_id: 'w1', declared_type: 'code-review' },
      { at: at(3), session_id: 'sess-rv', caller_is_subagent: true, caller_effort: 'high', tool_use_id: 'r3', caller_tool_use_id: 'w1', declared_type: 'code-review' },
    ];
    writeFileSync(join(telemetryDir(), 'spawns.jsonl'), spawn.map((r) => JSON.stringify(r)).join('\n') + '\n');
    run(post({ tool_use_id: 'r1', ...respond('VERDICT: FIX') }));
    run(post({ tool_use_id: 'r2', ...respond('VERDICT: PASS') }));
    run(post({ tool_use_id: 'r3', ...respond('no verdict here') }));
    const merged = readSpawnRows();
    assert.equal(merged.length, 4, 'folding adds no rows');
    assert.deepEqual(merged.map((r) => r.review_verdict), [undefined, 'FIX', 'PASS', undefined]);
    const t = {
      id: 'rf', premise: 'p1', kind: 'metric', source: 'spawns', metric: 'reviewFixShareByLeadEffort',
      params: { levels: ['high'] }, op: '>', threshold: 0, minSample: 1, minDays: 1,
    };
    const v = evalMetric({ decision: {}, trigger: t, key: 'k', history: [], spawnRows: merged, nowT: Date.parse('2026-10-12T10:00:00Z'), state: emptyState(), activeFromMs: null });
    const d = v.days.find((x) => x.qualifies);
    assert.equal(d.value, 50, 'one FIX of two verdicts, linked to the writer\'s lead effort');
  } finally { fx.cleanup(); }
});

test('an aliased TYPE (review) with no ROLE line is still a reviewer', async () => {
  const { reviewerOf } = await import('../hooks/lib/review-verdict.mjs');
  assert.ok(reviewerOf('TYPE: review\nWRITER: sonnet/high\nlook'));
  assert.ok(reviewerOf('TYPE: code-review\nlook'));
  assert.equal(reviewerOf('TYPE: bounded-feature\nlook'), null);
});
