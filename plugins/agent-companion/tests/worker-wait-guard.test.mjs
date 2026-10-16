// worker_wait_guard (0.31.23): a repeat sleep/poll/watch loop by the same worker, inside a window after
// its previous match, is refused (deny-repeat, the default); `hint` keeps the earlier hint-only
// behaviour and `off` does nothing. The detector itself (what counts as a poll) is unchanged: see
// tests/worker-wait.test.mjs and tests/worker-wait-review.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import {
  workerWaitDecision, workerWaitDenyText, workerWaitMode, WORKER_WAIT_WINDOW_MINUTES,
} from '../hooks/lib/poll-guard.mjs';
import { readRules } from '../hooks/lib/rules.mjs';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const at = (min) => ({ AGENT_COMPANION_FAKE_NOW: new Date(T0 + min * 60000).toISOString() });

function payload(extra = {}) {
  return {
    session_id: 'ww-guard-1',
    tool_name: 'Bash',
    tool_input: { command: 'until gh pr checks 31; do sleep 20; done' },
    agent_id: 'agent-g1',
    ...extra,
  };
}
function run(dir, p, env = {}) {
  return runHook('hooks/poll-guard.mjs', p, {
    env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...env },
  });
}
const tel = (dir, name) => readJsonl(join(dir, '.claude', 'agent-companion', 'telemetry', name));
const rowsOf = (dir) => tel(dir, 'worker-wait.jsonl');
const denialsOf = (dir) => tel(dir, 'denials.jsonl');
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision;
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('first poll gets the hint only, and the hint warns that a repeat is refused', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const a = run(dir, payload({ agent_id: 'g-first' }), at(0));
    assert.equal(decisionOf(a), undefined);
    assert.match(ctxOf(a), /One-wait rule for workers/);
    assert.match(ctxOf(a), /is refused/);
    assert.match(ctxOf(a), /run_in_background/);
    assert.match(ctxOf(a), /gh run watch/);
    assert.doesNotMatch(ctxOf(a), /STATUS: partial|the lead waits/);
    assert.equal(denialsOf(dir).length, 0);
    assert.deepEqual(rowsOf(dir).map((r) => [r.first, r.action]), [[true, 'hint']]);
  } finally { cleanup(); }
});

test('a repeat by the same agent inside the window is denied, names the sanctioned wait, and is logged', () => {
  const { dir, cleanup } = makeFixture();
  try {
    run(dir, payload({ agent_id: 'g-repeat' }), at(0));
    const b = run(dir, payload({ agent_id: 'g-repeat' }), at(5));
    assert.equal(b.status, 0);
    assert.equal(decisionOf(b), 'deny');
    const why = b.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(why, /run_in_background/);
    assert.match(why, /scripts\/pr-wait\.mjs/);
    assert.match(why, /gh run watch/);
    assert.doesNotMatch(why, /STATUS: partial|the lead waits/);
    const d = denialsOf(dir);
    assert.equal(d.length, 1);
    assert.equal(d[0].guard, 'worker-wait');
    assert.equal(d[0].outcome, 'deny');
    assert.equal(d[0].tool_name, 'Bash');
    assert.doesNotMatch(d[0].detail, /gh pr checks|sleep 20/, 'the command text is not stored');
    assert.deepEqual(rowsOf(dir).map((r) => [r.first, r.action]), [[true, 'hint'], [false, 'deny']]);
    // the refused call restarts the window: another at +12 (7 minutes after the refusal) is refused too
    assert.equal(decisionOf(run(dir, payload({ agent_id: 'g-repeat' }), at(12))), 'deny');
  } finally { cleanup(); }
});

test('a repeat after the window gets the hint again, not a deny', () => {
  const { dir, cleanup } = makeFixture();
  try {
    run(dir, payload({ agent_id: 'g-late' }), at(0));
    const b = run(dir, payload({ agent_id: 'g-late' }), at(WORKER_WAIT_WINDOW_MINUTES + 1));
    assert.equal(decisionOf(b), undefined);
    assert.match(ctxOf(b), /One-wait rule for workers/);
    assert.equal(denialsOf(dir).length, 0);
    assert.deepEqual(rowsOf(dir).map((r) => r.action), ['hint', 'hint']);
    // and that hint restarted the window
    assert.equal(decisionOf(run(dir, payload({ agent_id: 'g-late' }), at(WORKER_WAIT_WINDOW_MINUTES + 3))), 'deny');
  } finally { cleanup(); }
});

test('a different agent, or the same id in another session, gets its own hint', () => {
  const { dir, cleanup } = makeFixture();
  try {
    run(dir, payload({ agent_id: 'g-one' }), at(0));
    const other = run(dir, payload({ agent_id: 'g-two' }), at(1));
    assert.equal(decisionOf(other), undefined);
    assert.match(ctxOf(other), /One-wait rule/);
    const sess = run(dir, payload({ agent_id: 'g-one', session_id: 'ww-guard-other-session' }), at(2));
    assert.equal(decisionOf(sess), undefined);
    assert.match(ctxOf(sess), /One-wait rule/);
    assert.equal(denialsOf(dir).length, 0);
  } finally { cleanup(); }
});

test('legitimate commands are allowed after the hint (background wait, pr-wait.mjs, ordinary work)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    run(dir, payload({ agent_id: 'g-ok' }), at(0));
    for (const input of [
      { command: 'gh run watch 1', run_in_background: true },
      { command: 'node scripts/pr-wait.mjs 31' },
      { command: 'sleep 1' },
      { command: 'git status' },
      { command: 'npm test' },
    ]) {
      const r = run(dir, payload({ agent_id: 'g-ok', tool_input: input }), at(2));
      assert.equal((r.stdout || '').trim(), '', JSON.stringify(input));
    }
    assert.equal(denialsOf(dir).length, 0);
    assert.equal(rowsOf(dir).length, 1);
  } finally { cleanup(); }
});

test('PowerShell repeats are denied too; the main thread is never denied', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const ps = (extra = {}) => payload({ tool_name: 'PowerShell', tool_input: { command: 'Start-Sleep -Seconds 30' }, agent_id: 'g-ps', ...extra });
    run(dir, ps(), at(0));
    assert.equal(decisionOf(run(dir, ps(), at(1))), 'deny');
    const main = payload();
    delete main.agent_id;
    assert.equal((run(dir, main, at(2)).stdout || '').trim(), '');
  } finally { cleanup(); }
});

test('worker_wait_guard=hint never denies; =off does nothing and logs nothing; a bad value means deny-repeat', () => {
  for (const [mode, expectDeny, rows] of [['hint', false, 2], ['off', false, 0], ['bogus', true, 2]]) {
    const { dir, cleanup } = makeFixture();
    try {
      const env = { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_GUARD: mode };
      const a = run(dir, payload({ agent_id: 'g-mode' }), { ...at(0), ...env });
      const b = run(dir, payload({ agent_id: 'g-mode' }), { ...at(1), ...env });
      assert.equal(decisionOf(b) === 'deny', expectDeny, mode);
      assert.equal(rowsOf(dir).length, rows, mode);
      if (mode === 'off') assert.equal((a.stdout || '').trim(), '');
      if (mode === 'hint') assert.doesNotMatch(ctxOf(a), /is refused/, 'hint mode does not promise a refusal');
    } finally { cleanup(); }
  }
});

test('worker_wait_repeat_window_minutes moves the window; worker_wait_advisory=false still silences everything', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const win = { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_REPEAT_WINDOW_MINUTES: '3' };
    run(dir, payload({ agent_id: 'g-win' }), { ...at(0), ...win });
    assert.equal(decisionOf(run(dir, payload({ agent_id: 'g-win' }), { ...at(2), ...win })), 'deny');
    assert.equal(decisionOf(run(dir, payload({ agent_id: 'g-win' }), { ...at(6), ...win })), undefined);
    const off = { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_ADVISORY: 'false' };
    run(dir, payload({ agent_id: 'g-adv' }), { ...at(0), ...off });
    assert.equal((run(dir, payload({ agent_id: 'g-adv' }), { ...at(1), ...off }).stdout || '').trim(), '');
  } finally { cleanup(); }
});

test('workerWaitDecision: the pure rule', () => {
  const W = 15 * 60000;
  const base = { mode: 'deny-repeat', sessionId: 's', nowMs: 1_000_000_000, windowMs: W, firstClaim: true };
  assert.deepEqual(workerWaitDecision({ ...base, prev: null }), { action: 'hint', first: true });
  assert.equal(workerWaitDecision({ ...base, prev: { s: 's', t: base.nowMs - 60000 }, firstClaim: false }).action, 'deny');
  assert.equal(workerWaitDecision({ ...base, prev: { s: 's', t: base.nowMs - W }, firstClaim: false }).action, 'deny');
  assert.equal(workerWaitDecision({ ...base, prev: { s: 's', t: base.nowMs - W - 1 }, firstClaim: false }).action, 'hint');
  assert.equal(workerWaitDecision({ ...base, prev: { s: 'other', t: base.nowMs - 1000 }, firstClaim: false }).action, 'hint');
  assert.equal(workerWaitDecision({ ...base, prev: { s: 's', t: base.nowMs + 5000 }, firstClaim: false }).action, 'hint', 'clock skew never denies');
  assert.equal(workerWaitDecision({ ...base, mode: 'hint', prev: { s: 's', t: base.nowMs - 1000 }, firstClaim: false }).action, 'silent');
  assert.equal(workerWaitDecision({ ...base, mode: 'hint', prev: null, firstClaim: true }).action, 'hint');
  assert.equal(workerWaitMode('Deny-Repeat'), 'deny-repeat');
  assert.equal(workerWaitMode(undefined), 'deny-repeat');
  assert.equal(workerWaitMode('off'), 'off');
  assert.match(workerWaitDenyText('C:\\p\\ac'), /C:\/p\/ac\/scripts\/pr-wait\.mjs/);
});

test('the spawn rule has no partial-return escape and names the sanctioned waits', () => {
  const { cleanup } = makeFixture();
  try {
    const r = readRules().rules.find((x) => x.id === 'worker-one-wait');
    assert.doesNotMatch(r.then, /STATUS: partial|the lead waits|Cannot wait/i);
    assert.match(r.then, /no sleep, poll or watch loops/);
    assert.match(r.then, /run_in_background/);
    assert.match(r.then, /pr-wait\.mjs/);
    assert.match(r.then, /gh run watch/);
    assert.ok(r.then.length <= 200, `${r.then.length} chars`);
  } finally { cleanup(); }
});

test('the options exist in plugin.json with the documented defaults', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.worker_wait_guard.default, 'deny-repeat');
  assert.equal(cfg.worker_wait_repeat_window_minutes.default, WORKER_WAIT_WINDOW_MINUTES);
  assert.equal(cfg.worker_wait_repeat_window_minutes.type, 'number');
});
