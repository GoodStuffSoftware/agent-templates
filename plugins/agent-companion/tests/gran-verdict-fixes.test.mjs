// 0.31.17 granularity-review fixes: F1 (branchOf key), N1 (STATUS template echo), N4 (operate one-wait variant).
// The cases are copied from the review's tests (the review file lives outside the repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { branchOf } from '../hooks/lib/review-verdict.mjs';
import { parseStatus } from '../hooks/lib/status-line.mjs';
import { matchRules } from '../hooks/lib/rules.mjs';

const SID = 'sess-gran-verdict';
const rbrief = (text) => `TYPE: code-review\nROLE: reviewer\n${text}\nReview the diff.`;
const fg = (tu, verdict, prompt) => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: tu,
  tool_input: { description: 'review', prompt, name: 'rev-' + tu },
  tool_response: { status: 'completed', content: [{ type: 'text', text: `VERDICT: ${verdict}` }] },
});
const send = (p) => runHook('hooks/review-verdict.mjs', p);
const outcomes = () => { try { return readJsonl(join(telemetryDir(), 'review-outcomes.jsonl')); } catch { return []; } };

test('F1: a file path is not a branch', () => {
  assert.equal(branchOf('Review the docs change in docs/TELEMETRY.md on branch feat/x'), 'feat/x');
  assert.equal(branchOf('see docs/ROUTING.md and fix/abc'), 'fix/abc');
  assert.equal(branchOf('Update release/notes.txt only'), null);
});

test('F1: a range keys on its head side; review target beats base; BRANCH: line beats both', () => {
  assert.equal(branchOf('Diff release/0.31.17..feat/x'), 'feat/x');
  assert.equal(branchOf('Diff release/0.31.17...feat/x'), 'feat/x');
  assert.equal(branchOf('Base branch: release/0.31.17. Review feat/a.'), 'feat/a');
  assert.equal(branchOf('Base branch: release/0.31.17. Reviewing `feat/b`.'), 'feat/b');
  assert.equal(branchOf('BRANCH: fix/z\nBase release/0.31.17. Review feat/a.'), 'fix/z');
  assert.equal(branchOf('Base release/0.31.17 and feat/q'), 'release/0.31.17');
  assert.equal(branchOf('branch release/0.31.17.'), 'release/0.31.17');
});

test('F1: two different feature branches sharing a base mention do not pair a PASS with a FIX', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', rbrief('Base branch: release/0.31.17. Review feat/a.')));
    send(fg('t2', 'FIX', rbrief('Base branch: release/0.31.17. Review feat/b.')));
    assert.equal(outcomes().length, 0);
    send(fg('t3', 'FIX', rbrief('Base branch: release/0.31.17. Review feat/a.')));
    assert.equal(outcomes().length, 1, 'same branch still pairs');
  } finally { fx.cleanup(); }
});

test('F1: two reviews that name the same docs file do not pair', () => {
  const fx = makeFixture();
  try {
    send(fg('t1', 'PASS', rbrief('Check docs/TELEMETRY.md for the new stream.')));
    send(fg('t2', 'FIX', rbrief('Check docs/TELEMETRY.md for the other stream.')));
    assert.equal(outcomes().length, 0);
  } finally { fx.cleanup(); }
});

test('N1: a template echo of the STATUS contract is not a status', () => {
  assert.equal(parseStatus('STATUS: done | blocked | partial'), null);
  assert.equal(parseStatus('**STATUS:** done / blocked / partial'), null);
  assert.equal(parseStatus('STATUS: done'), 'done');
  assert.equal(parseStatus('STATUS: partial\nBLOCKERS: x | y'), 'partial');
  assert.equal(parseStatus('STATUS: done (a/b)'), 'done');
});

test('N4: operate briefs get the operate variant (worker waits itself); other types keep the one-wait line, with no STATUS: partial hand-back', () => {
  const fx = makeFixture();
  try {
    const ids = (text) => matchRules({ scope: 'spawn', text, sessionId: 's' }).map((r) => r.id).filter((i) => i.startsWith('worker-one-wait'));
    assert.deepEqual(ids('TYPE: operate\nROLE: worker\nWatch the deploy'), ['worker-one-wait-operate']);
    assert.deepEqual(ids('Do a thing\nTYPE: Operate\nrun it'), ['worker-one-wait-operate']);
    assert.deepEqual(ids('TYPE: lookup\nDo a thing'), ['worker-one-wait']);
    assert.deepEqual(ids('Do a thing, the word TYPE: operate in prose'), ['worker-one-wait']);
    assert.deepEqual(ids('TYPE: operate-ish\nx'), ['worker-one-wait']);
    const op = matchRules({ scope: 'spawn', text: 'TYPE: operate\nx', sessionId: 's' }).find((r) => r.id === 'worker-one-wait-operate');
    assert.match(op.then, /you wait/);
    assert.doesNotMatch(op.then, /the lead waits/);
    const other = matchRules({ scope: 'spawn', text: 'TYPE: lookup\nx', sessionId: 's' }).find((r) => r.id === 'worker-one-wait');
    assert.doesNotMatch(other.then, /STATUS: partial|the lead waits|Cannot wait/);
    assert.match(other.then, /run_in_background/);
    assert.match(other.then, /pr-wait.mjs/);
    assert.match(other.then, /gh run watch/);
  } finally { fx.cleanup(); }
});
