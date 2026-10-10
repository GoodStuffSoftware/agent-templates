import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeFixture, runHook } from './helpers.mjs';
import {
  LEAD_EFFORT_CHECK_TEXT, defaultRules, readRules, matchRules, renderRules, rulesPath,
} from '../hooks/lib/rules.mjs';

// Every test runs inside makeFixture(), which points the state root at a temp
// directory, so none of this reads the operator's real ~/.claude.

const ENABLE = [{ id: 'lead-effort-check', enabled: true }];

test('lead-effort-check ships as a disabled session-start built-in', () => {
  const { cleanup } = makeFixture();
  try {
    const r = readRules().rules.find((x) => x.id === 'lead-effort-check');
    assert.ok(r, 'built-in must exist');
    assert.equal(r.enabled, false);
    assert.equal(r.builtin, true);
    assert.equal(r.scope, 'session-start');
    assert.equal(r.then, LEAD_EFFORT_CHECK_TEXT);
    assert.equal(matchRules({ scope: 'session-start', sessionId: 's1' }).some((x) => x.id === 'lead-effort-check'), false);
    assert.equal(defaultRules().find((x) => x.id === 'lead-effort-check').enabled, false);
  } finally {
    cleanup();
  }
});

test('the minimal enable override turns it on and keeps the shipped wording', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify(ENABLE));
    const hit = matchRules({ scope: 'session-start', sessionId: 's2' }).find((x) => x.id === 'lead-effort-check');
    assert.ok(hit, 'enabled override must fire at session start');
    assert.equal(hit.then, LEAD_EFFORT_CHECK_TEXT);
  } finally {
    cleanup();
  }
});

test('the wording asks with AskUserQuestion, not in prose, and keeps the unattended carve-out', () => {
  const t = LEAD_EFFORT_CHECK_TEXT;
  // when to check
  assert.match(t, /Before the first spawn and again after any resume or compaction/);
  assert.match(t, /get_session with session_id "self" and read its effort field/);
  assert.match(t, /orchestration lead runs at xhigh/);
  assert.ok(t.length < 1200, `the rule is paid for at every session start: ${t.length} chars`);
  // interactive: the options selector, stop until answered
  assert.match(t, /AskUserQuestion tool \(the options selector\), not in prose/);
  assert.match(t, /no spawn and no other tool call until it is answered/);
  assert.match(t, /Header "Lead effort"/);
  assert.match(t, /name the current effort and why this looks like orchestration/);
  // option 1
  assert.ok(t.includes('Option 1 "Raise to xhigh (Recommended)"'));
  assert.match(t, /the operator raises it with the app's effort control \(you cannot\)/);
  assert.match(t, /wait until get_session "self" shows xhigh or they say continue/);
  assert.match(t, /you cannot/);
  // the self-set path is gone: no ToolSearch load, no set_session_effort call
  assert.doesNotMatch(t, /set_session_effort/);
  assert.doesNotMatch(t, /ToolSearch/);
  // option 2
  assert.ok(t.includes('Option 2 "Stay at <current>": continue, and do not ask again this session.'));
  // limits
  assert.match(t, /Never raise to max, never lower/);
  // unattended: never asked
  assert.match(t, /Unattended \(scheduledTaskId in get_session, a headless or -p run, or no AskUserQuestion tool\): do not ask/);
  assert.match(t, /state the effort once only if it is below xhigh/);
  assert.match(t, /At xhigh or above: say nothing and do not ask./);
  assert.match(t, /never suggest lowering/);
  // the old prose-ask wording is gone
  assert.doesNotMatch(t, /ask them to raise it/);
  assert.doesNotMatch(t, /say so to the user in one line/);
});

test('an operator file that carries its own wording still wins', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'lead-effort-check', enabled: true, then: 'custom wording' }]));
    const hit = matchRules({ scope: 'session-start', sessionId: 's3' }).find((x) => x.id === 'lead-effort-check');
    assert.equal(hit.then, 'custom wording');
  } finally {
    cleanup();
  }
});

test('with every default rule on, the session-start block carries the rule whole under the default cap', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify(ENABLE));
    const out = renderRules(matchRules({ scope: 'session-start', sessionId: 's4' }));
    assert.ok(out.includes(LEAD_EFFORT_CHECK_TEXT), 'rule text must not be dropped for the char budget');
    assert.doesNotMatch(out, /dropped: over the/);
  } finally {
    cleanup();
  }
});

test('hook --event session-start injects the rule when enabled, and not otherwise', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const off = runHook('hooks/standing-rules.mjs', { session_id: 'sess-eff-1', cwd: dir }, { args: ['--event', 'session-start'] });
    assert.equal(off.status, 0);
    assert.ok(!off.json.hookSpecificOutput.additionalContext.includes('Lead effort'));

    writeFileSync(rulesPath(), JSON.stringify(ENABLE));
    const on = runHook('hooks/standing-rules.mjs', { session_id: 'sess-eff-2', cwd: dir }, { args: ['--event', 'session-start'] });
    assert.equal(on.status, 0);
    const ctx = on.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(LEAD_EFFORT_CHECK_TEXT));
    assert.ok(ctx.includes('Raise to xhigh (Recommended)'));
    assert.ok(ctx.includes('outcome level'), 'the other session-start rules still fire');
  } finally {
    cleanup();
  }
});
