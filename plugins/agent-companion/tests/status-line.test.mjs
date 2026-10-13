// parseStatus: pure edge cases. Synthetic strings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { parseStatus } from '../hooks/lib/status-line.mjs';

test('plain, case-insensitive, and the three words', () => {
  assert.equal(parseStatus('STATUS: done'), 'done');
  assert.equal(parseStatus('status: Blocked\nBLOCKERS: x'), 'blocked');
  assert.equal(parseStatus('STATUS: partial'), 'partial');
  assert.equal(parseStatus('STATUS - done'), 'done');
});

test('markdown around the line', () => {
  for (const s of ['**STATUS:** done', '**STATUS: done**', '> STATUS: done', '## STATUS: done', '- STATUS: done', '`STATUS: done`', '| STATUS | done |', '__STATUS__: done']) {
    assert.equal(parseStatus(s), 'done', s);
  }
});

test('not on the first line, blank lines skipped, 12-line window', () => {
  assert.equal(parseStatus('\n\nOk, here is the result.\n\nSTATUS: partial'), 'partial');
  assert.equal(parseStatus(`${'l\n'.repeat(11)}STATUS: done`), 'done');
  assert.equal(parseStatus(`${'l\n'.repeat(12)}STATUS: done`), null);
});

test('first match wins; mid-sentence and unknown words do not match', () => {
  assert.equal(parseStatus('STATUS: blocked\nSTATUS: done'), 'blocked');
  assert.equal(parseStatus('The STATUS: done flag is set'), null);
  assert.equal(parseStatus('STATUS: finished'), null);
  assert.equal(parseStatus('STATUS: donezo'), null);
});

test('missing, empty, non-string, and huge input', () => {
  for (const v of [undefined, null, '', 42, {}, 'no line here']) assert.equal(parseStatus(v), null);
  assert.equal(parseStatus(`STATUS: done\n${'z'.repeat(20_000_000)}`), 'done');
  assert.equal(parseStatus(`${'z'.repeat(20_000)}\nSTATUS: done`), null);
});
