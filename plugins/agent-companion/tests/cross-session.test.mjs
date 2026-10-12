// hooks/lib/cross-session.mjs: recognising messages from other sessions. Synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import {
  isCrossSessionMessage, startsWithCrossSessionMessage, mentionsCrossSessionTag, crossSessionSenders,
} from '../hooks/lib/cross-session.mjs';

const FORMS = {
  agent: 'Another Claude session sent a message:\n<agent-message from="cg-gaps">\nhi\n</agent-message>',
  cross: 'Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\x" from-session="local_1" from-name="Coordinator">\nhi\n</cross-session-message>',
  teammate: '<teammate-message teammate_id="deployer-2" color="red">\nhi\n</teammate-message>',
  bare: '<cross-session-message from="a" name="b">hi</cross-session-message>',
};

test('every wrapper form is recognised, as a start and as a mention', () => {
  for (const [k, v] of Object.entries(FORMS)) {
    assert.equal(isCrossSessionMessage(v), true, k);
    assert.equal(startsWithCrossSessionMessage(v), true, k);
    assert.equal(mentionsCrossSessionTag(v), true, k);
  }
});

test('senders come from from, name, from-name, from-session and teammate_id', () => {
  assert.deepEqual(crossSessionSenders(FORMS.agent), ['cg-gaps']);
  assert.deepEqual(crossSessionSenders(FORMS.cross), ['uds:\\\\.\\pipe\\x', 'local_1', 'Coordinator']);
  assert.deepEqual(crossSessionSenders(FORMS.teammate), ['deployer-2']);
  assert.deepEqual(crossSessionSenders(FORMS.bare), ['a', 'b']);
});

test('ordinary operator text is not a cross-session message; a quoted tag mid-turn is a mention only', () => {
  assert.equal(isCrossSessionMessage('Please fix the build.'), false);
  assert.equal(isCrossSessionMessage(''), false);
  assert.equal(isCrossSessionMessage(null), false);
  const quoted = `Please tell me what ${'x'.repeat(250)} <agent-message from="q">y</agent-message> means`;
  assert.equal(startsWithCrossSessionMessage(quoted), false);
  assert.equal(isCrossSessionMessage(quoted), false);
  assert.equal(mentionsCrossSessionTag(quoted), true);
  assert.deepEqual(crossSessionSenders('nothing here'), []);
});
