import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { makeFixture, runHook } from './helpers.mjs';
import {
  LEAD_EFFORT_CHECK_TEXT, leadEffortCheckText, defaultRules, readRules, matchRules, renderRules, rulesPath,
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

test('the wording informs once, never asks or waits, and keeps the unattended carve-out', () => {
  const t = LEAD_EFFORT_CHECK_TEXT;
  assert.match(t, /Before the first spawn and after any resume or compaction/);
  assert.match(t, /get_session with session_id "self" and read its effort/);
  assert.match(t, /A lead runs at xhigh/);
  assert.ok(t.length < 1000, `the rule is paid for at every session start: ${t.length} chars`);
  // interactive: state once in the first report, no ask, no wait
  assert.match(t, /Interactive and below xhigh: state once, in your first report, the effort you run at and that orchestration is tuned for xhigh/);
  assert.match(t, /no spawn or tool call is held/);
  assert.match(t, /Then continue normally and say nothing more about effort this session/);
  assert.match(t, /You cannot change your own effort/);
  assert.doesNotMatch(t, /set_session_effort/);
  assert.doesNotMatch(t, /ToolSearch/);
  // limits
  assert.match(t, /Never raise to max, never lower/);
  // unattended: state once only if below; silence at or above
  assert.match(t, /Unattended \(scheduledTaskId in get_session, headless or -p run\): state the effort once, only if below xhigh/);
  assert.match(t, /at xhigh or above, say nothing about effort/);
  assert.match(t, /never suggest lowering/);
});

test('the rule text no longer instructs an ask or a wait (both targets)', () => {
  for (const t of [LEAD_EFFORT_CHECK_TEXT, leadEffortCheckText('high')]) {
    assert.doesNotMatch(t, /AskUserQuestion|options selector|Header "Lead effort"|Option [12] "|until answered|wait until|do not ask again/);
    assert.doesNotMatch(t, /ask (with|the operator|them)/i);
  }
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
    assert.ok(ctx.includes('state once, in your first report'));
    assert.ok(ctx.includes('outcome level'), 'the other session-start rules still fire');
  } finally {
    cleanup();
  }
});
