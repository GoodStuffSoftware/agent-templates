// 0.31.16: the decision register's `date` trigger kind. Synthetic registers in a fixture
// state root; nothing reads the operator's real register.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import {
  registerPath, statePath, detailPath, readState, emptyState, validateRegister, evaluateTriggers, openFlags,
  scanDatesToState, pendingLine, runRegister,
} from '../scripts/lib/decision-register.mjs';

const T = (s) => Date.parse(s);

function register(trigger = { id: 'due', premise: 'p1', kind: 'date', due: '2026-10-19' }, status = 'active') {
  return {
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'trial-x', title: 'Trial X', status, decided: '2026-10-12', decision: 'What is standing.', reverse: 'Undo it.',
      premises: [{ id: 'p1', text: 'The claim.', label: 'E' }], triggers: [trigger],
    }],
  };
}
const put = (reg) => { mkdirSync(dirname(registerPath()), { recursive: true }); writeFileSync(registerPath(), JSON.stringify(reg)); };

test('validator accepts a real due date and rejects missing, malformed and impossible ones', () => {
  assert.equal(validateRegister(register(), { rollout: {} }).ok, true);
  for (const due of [undefined, '', 'soon', '2026-10-9', '2026-02-30', '2026-13-01', 20261019]) {
    const t = { id: 'due', premise: 'p1', kind: 'date' };
    if (due !== undefined) t.due = due;
    const v = validateRegister(register(t), { rollout: {} });
    assert.equal(v.ok, false, String(due));
    assert.match(v.errors.join('\n'), /due must be a real date/);
  }
});

test('the date trigger flags once the due day has begun, and only once', () => {
  const reg = register();
  const state = emptyState();
  assert.deepEqual(evaluateTriggers({ register: reg, nowT: T('2026-10-18T23:59:59Z'), state }).newFlags, []);
  const first = evaluateTriggers({ register: reg, nowT: T('2026-10-19T00:00:00Z'), state });
  assert.deepEqual(first.newFlags, ['trial-x/due@2026-10-19']);
  const f = state.flags['trial-x/due@2026-10-19'];
  assert.equal(f.kind, 'date');
  assert.equal(f.severity, 'due');
  assert.match(f.summary, /2026-10-19/);
  assert.deepEqual(evaluateTriggers({ register: reg, nowT: T('2026-10-25T00:00:00Z'), state }).newFlags, []);
  assert.equal(openFlags(state, reg, T('2026-10-25T00:00:00Z')).length, 1);
});

test('a decision that is no longer active neither flags nor keeps an open flag', () => {
  const retired = register(undefined, 'retired');
  const s1 = emptyState();
  assert.deepEqual(evaluateTriggers({ register: retired, nowT: T('2026-11-01T00:00:00Z'), state: s1 }).newFlags, []);
  const reg = register();
  const s2 = emptyState();
  evaluateTriggers({ register: reg, nowT: T('2026-10-20T00:00:00Z'), state: s2 });
  assert.equal(openFlags(s2, reg, T('2026-10-21T00:00:00Z')).length, 1);
  assert.equal(openFlags(s2, retired, T('2026-10-21T00:00:00Z')).length, 0);
});

test('the daily-checkup path (runRegister) flags the date and writes the detail file', () => {
  const fx = makeFixture();
  try {
    put(register());
    const r = runRegister({ nowT: T('2026-10-20T10:00:00Z'), force: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.newFlags, ['trial-x/due@2026-10-19']);
    assert.ok(existsSync(detailPath()));
    assert.match(readState().flags['trial-x/due@2026-10-19'].summary, /review date 2026-10-19 has passed/);
  } finally { fx.cleanup(); }
});

test('the scout path (scanDatesToState) flags it, the scout signals it, and the session line shows it', () => {
  const fx = makeFixture();
  try {
    put(register());
    const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: '2026-10-20T10:00:00Z' } });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'decision_review_due');
    assert.ok(sig, 'decision_review_due raised');
    assert.match(sig.detail, /trial-x/);
    const line = pendingLine({ nowT: T('2026-10-20T11:00:00Z') });
    assert.ok(line);
    assert.match(line.line, /Decision review due: Trial X/);
    // Not flagged before the date.
    const early = scanDatesToState({ nowT: T('2026-10-01T00:00:00Z'), stateFile: statePath() });
    assert.deepEqual(early.newFlags, []);
  } finally { fx.cleanup(); }
});

test('the scout does not re-flag once the decision is retired', () => {
  const fx = makeFixture();
  try {
    put(register(undefined, 'retired'));
    const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: '2026-10-20T10:00:00Z' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.some((s) => s.kind === 'decision_review_due'), false);
  } finally { fx.cleanup(); }
});

test('reviewedOn: validated as a date, closes flags raised on or before that day, a later flag reopens', () => {
  const withReview = (reviewedOn) => { const r = register(); if (reviewedOn !== undefined) r.decisions[0].reviewedOn = reviewedOn; return r; };
  assert.equal(validateRegister(withReview('2026-10-20'), { rollout: {} }).ok, true);
  for (const bad of ['soon', '2026-10-9', '2026-02-30', 20261020, '']) {
    const v = validateRegister(withReview(bad), { rollout: {} });
    assert.equal(v.ok, false, String(bad));
    assert.match(v.errors.join('\n'), /reviewedOn must be a UTC date/);
  }
  const reg = withReview('2026-10-20');
  const state = emptyState();
  evaluateTriggers({ register: register(), nowT: T('2026-10-20T10:00:00Z'), state });
  assert.equal(openFlags(state, register(), T('2026-10-21T00:00:00Z')).length, 1, 'no reviewedOn: open');
  assert.equal(openFlags(state, reg, T('2026-10-21T00:00:00Z')).length, 0, 'flag on the reviewedOn day is settled');
  assert.equal(openFlags(state, withReview('2026-10-19'), T('2026-10-21T00:00:00Z')).length, 1, 'flag after reviewedOn stays open');
  state.flags['trial-x/due@2026-10-19'].at = '2026-10-20T23:59:59.000Z';
  assert.equal(openFlags(state, reg, T('2026-10-21T00:00:00Z')).length, 0, 'end of the reviewedOn day still settled');
  state.flags['trial-x/due@2026-10-19'].at = '2026-10-21T00:00:00.000Z';
  assert.equal(openFlags(state, reg, T('2026-10-21T01:00:00Z')).length, 1, 'next day reopens');
});

test('the scout raises no decision_review_due for a settled review (the same register without reviewedOn raises it)', () => {
  const fx = makeFixture();
  try {
    const env = { AGENT_COMPANION_FAKE_NOW: '2026-10-20T10:00:00Z' };
    const reg = register();
    reg.decisions[0].reviewedOn = '2026-10-20';
    put(reg);
    const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.some((s) => s.kind === 'decision_review_due'), false);
  } finally { fx.cleanup(); }
  // Control: the same register without reviewedOn does raise it.
  const fx2 = makeFixture();
  try {
    put(register());
    const res = runScript('scripts/detect.mjs', [], { cwd: fx2.dir, env: { AGENT_COMPANION_FAKE_NOW: '2026-10-20T10:00:00Z' } });
    assert.equal(res.json.signals.some((s) => s.kind === 'decision_review_due'), true);
  } finally { fx.cleanup(); }
});

test('decision-register.mjs --check validates a date trigger', () => {
  const fx = makeFixture();
  try {
    put(register());
    let r = runScript('scripts/decision-register.mjs', ['--check'], { cwd: fx.dir });
    assert.match(r.stdout, /^OK:/);
    put(register({ id: 'due', premise: 'p1', kind: 'date', due: '2026-02-30' }));
    r = runScript('scripts/decision-register.mjs', ['--check'], { cwd: fx.dir });
    assert.match(r.stdout, /INVALID/);
    assert.match(r.stdout, /due must be a real date/);
  } finally { fx.cleanup(); }
});
