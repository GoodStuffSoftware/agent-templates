// 0.31.17: post-PASS defect signal. A PASS verdict later followed by a FIX/BLOCK on the same branch
// appends an outcome row to telemetry/review-outcomes.jsonl; the register folds it back as
// post_pass_defect:true. Old rows without the new fields still parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { branchOf } from '../hooks/lib/review-verdict.mjs';
import { readSpawnRows, verdictReadStats } from '../scripts/lib/decision-register.mjs';

const SID = 'sess-ppd';
const brief = (b) => `TYPE: code-review\nROLE: reviewer\n${b ? `Review branch ${b} against main.\n` : ''}Review the diff.`;
const fg = (tu, verdict, prompt, sid = SID) => ({
  session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { description: 'review', prompt, name: 'rev' },
  tool_response: { status: 'completed', content: [{ type: 'text', text: `VERDICT: ${verdict}` }] },
});
const verdicts = () => readJsonl(join(telemetryDir(), 'review-verdicts.jsonl'));
const outcomes = () => { try { return readJsonl(join(telemetryDir(), 'review-outcomes.jsonl')); } catch { return []; } };
const send = (p) => runHook('hooks/review-verdict.mjs', p);

test('branchOf parses the first branch token, else null', () => {
  assert.equal(branchOf(brief('feat/0.31.17-post-pass-defect')), 'feat/0.31.17-post-pass-defect');
  assert.equal(branchOf('see fix/a-b, then feat/x'), 'fix/a-b');
  assert.equal(branchOf('branch release/0.31.17.'), 'release/0.31.17');
  assert.equal(branchOf(brief(null)), null);
  assert.equal(branchOf(undefined), null);
});

test('row carries reviewed_branch and post_pass_defect:null', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', brief('feat/a')));
    send(fg('t2', 'PASS', brief(null)));
    const [a, b] = verdicts();
    assert.equal(a.reviewed_branch, 'feat/a');
    assert.equal(a.post_pass_defect, null);
    assert.equal(b.reviewed_branch, null);
    assert.equal(outcomes().length, 0);
  } finally { fx.cleanup(); }
});

test('PASS then FIX on the same branch writes exactly one outcome row; a second FIX adds none', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', brief('feat/a')));
    send(fg('t2', 'FIX', brief('feat/a')));
    send(fg('t3', 'BLOCK', brief('feat/a')));
    const o = outcomes();
    assert.equal(o.length, 1);
    assert.equal(o[0].review_of_tool_use_id, 't1');
    assert.equal(o[0].session_id, SID);
    assert.equal(o[0].reviewed_branch, 'feat/a');
    assert.equal(o[0].post_pass_defect, true);
    assert.equal(o[0].evidence, 'later-fix-verdict');
    assert.equal(o[0].evidence_ref, 't2');
  } finally { fx.cleanup(); }
});

test('a FIX in a later session still matches the earlier PASS', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', brief('fix/b'), 'sess-one'));
    send(fg('t2', 'FIX', brief('fix/b'), 'sess-two'));
    const o = outcomes();
    assert.equal(o.length, 1);
    assert.equal(o[0].session_id, 'sess-one');
    assert.equal(o[0].review_of_tool_use_id, 't1');
  } finally { fx.cleanup(); }
});

test('FIX on another branch, FIX with no earlier PASS, and PASS after FIX write none', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', brief('feat/a')));
    send(fg('t2', 'FIX', brief('feat/other')));
    send(fg('t3', 'FIX', brief('feat/none')));
    send(fg('t4', 'FIX', brief(null)));
    send(fg('t5', 'PASS', brief('feat/c')));
    assert.equal(outcomes().length, 0);
  } finally { fx.cleanup(); }
});

test('a PASS older than 7 days does not count', () => {
  const fx = makeFixture();
  try {
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    writeFileSync(join(telemetryDir(), 'review-verdicts.jsonl'), JSON.stringify({ at: old, session_id: SID, review_of_tool_use_id: 'told', review_verdict: 'PASS', reviewed_branch: 'feat/a' }) + '\n');
    send(fg('t2', 'FIX', brief('feat/a')));
    assert.equal(outcomes().length, 0);
  } finally { fx.cleanup(); }
});

test('background reviewer: launch carries the branch, stop records it and the outcome', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', brief('feat/bg')));
    const prompt = brief('feat/bg');
    send({
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't2',
      tool_input: { description: 'review', prompt, name: 'rev-bg', run_in_background: true },
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'agent-bg1', description: 'review', prompt },
    });
    runHook('hooks/review-verdict.mjs', {
      session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'agent-bg1', agent_type: 'general-purpose',
      last_assistant_message: 'VERDICT: FIX',
    }, { args: ['--event', 'stop'] });
    const bg = verdicts().find((r) => r.review_of_tool_use_id === 't2');
    assert.equal(bg.reviewed_branch, 'feat/bg');
    assert.equal(outcomes().length, 1);
    assert.equal(outcomes()[0].evidence_ref, 't2');
  } finally { fx.cleanup(); }
});

test('register folds post_pass_defect onto the reviewer row; old rows without the fields still read', () => {
  const fx = makeFixture();
  try {
    const sp = join(telemetryDir(), 'spawns.jsonl');
    writeFileSync(sp, [
      { session_id: 's1', tool_use_id: 't1' }, { session_id: 's1', tool_use_id: 't2' }, { session_id: 's1', tool_use_id: 't3' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    // t1 is an old-format row (no reviewed_branch/post_pass_defect), t2 a new one, t3 has no verdict row.
    writeFileSync(join(telemetryDir(), 'review-verdicts.jsonl'), [
      { session_id: 's1', review_of_tool_use_id: 't1', review_verdict: 'PASS' },
      { session_id: 's1', review_of_tool_use_id: 't2', review_verdict: 'PASS', reviewed_branch: 'feat/a', post_pass_defect: null },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(telemetryDir(), 'review-outcomes.jsonl'), 'garbage\n' + JSON.stringify({ session_id: 's1', review_of_tool_use_id: 't2', post_pass_defect: true }) + '\n');
    verdictReadStats.reads = 0; verdictReadStats.outcomeReads = 0;
    const rows = readSpawnRows(sp);
    assert.equal(verdictReadStats.reads, 1);
    assert.equal(verdictReadStats.outcomeReads, 1, 'outcomes file read exactly once');
    assert.equal(rows[0].review_verdict, 'PASS');
    assert.equal(rows[0].post_pass_defect, undefined);
    assert.equal(rows[1].post_pass_defect, true);
    assert.equal(rows[2].post_pass_defect, undefined);
    verdictReadStats.outcomeReads = 0;
    readSpawnRows(sp, { foldVerdicts: false });
    assert.equal(verdictReadStats.outcomeReads, 0);
  } finally { fx.cleanup(); }
});
