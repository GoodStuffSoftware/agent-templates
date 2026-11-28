// worker_wait_guard (0.31.23): a repeat sleep/poll/watch loop by the same worker, inside a window after
// its previous match, is refused (deny-repeat, the default); `hint` keeps the earlier hint-only
// behaviour and `off` does nothing. The detector itself (what counts as a poll) is unchanged: see
// tests/worker-wait.test.mjs and tests/worker-wait-review.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
    env: { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_REWRITE: '0', CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...env },
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
    assert.ok(r.then.length <= 240, `${r.then.length} chars`);
  } finally { cleanup(); }
});

test('the options exist in plugin.json with the documented defaults', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.worker_wait_guard.default, 'deny-repeat');
  assert.equal(cfg.worker_wait_repeat_window_minutes.default, WORKER_WAIT_WINDOW_MINUTES);
  assert.equal(cfg.worker_wait_repeat_window_minutes.type, 'number');
});

// 0.31.79: a repeat Bash wait is rewritten to the sanctioned background form instead of refused. bash-tail.mjs does the
// rewrite (the one hook that rewrites shell calls); poll-guard.mjs only stays out of the way.
const REWRITE = { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_REWRITE: '1' };
function both(dir, p, env) {
  const e = { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...env };
  return { tail: runHook('hooks/bash-tail.mjs', p, { env: e }), poll: runHook('hooks/poll-guard.mjs', p, { env: e }) };
}
test('rewrite: a repeat Bash wait runs in the background (updatedInput from bash-tail), poll-guard does not deny, and it is logged as a rewrite', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const first = both(dir, payload({ agent_id: 'g-rw' }), { ...at(0), ...REWRITE });
    assert.equal(first.tail.json?.hookSpecificOutput?.updatedInput, undefined, 'the first match is still only a hint');
    const b = both(dir, payload({ agent_id: 'g-rw' }), { ...at(5), ...REWRITE });
    assert.equal(decisionOf(b.poll), undefined);
    assert.equal(b.poll.json?.hookSpecificOutput?.updatedInput, undefined, 'only bash-tail returns updatedInput');
    const u = b.tail.json.hookSpecificOutput.updatedInput;
    assert.equal(u.run_in_background, true);
    assert.match(u.command, /gh pr checks 31/);
    assert.match(u.command, /wait-cap|SECONDS/, 'the loop cap applies to the background loop');
    assert.match(ctxOf(b.tail), /background command/);
    assert.deepEqual(denialsOf(dir).map((d) => d.outcome), ['rewrite']);
  } finally { cleanup(); }
});

test('rewrite: still denied for PowerShell, for a heavy command and for a command bash-tail rewrites', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const cases = [
      ['PowerShell', 'while ($true) { Start-Sleep 20 }'],
      ['Bash', 'npm test; until gh pr checks 31; do sleep 20; done'],
      ['Bash', 'git worktree remove x; sleep 30'],
    ];
    cases.forEach(([tool, command], i) => {
      const id = 'g-keep' + i;
      both(dir, payload({ agent_id: id, tool_name: tool, tool_input: { command } }), { ...at(0), ...REWRITE });
      const b = both(dir, payload({ agent_id: id, tool_name: tool, tool_input: { command } }), { ...at(3), ...REWRITE });
      assert.equal(decisionOf(b.poll), 'deny', command);
      assert.notEqual(b.tail.json?.hookSpecificOutput?.updatedInput?.run_in_background, true, command);
    });
  } finally { cleanup(); }
});

// Review fix: poll-guard stands down only when bash-tail will rewrite. A deny or ask rule that matches the command makes
// bash-tail leave the call alone, so poll-guard must keep its refusal (before the fix neither hook acted).
test('rewrite: a deny rule matching the wait keeps poll-guard\'s refusal; without the rule poll-guard stands down and bash-tail rewrites', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sleepPayload = (id) => payload({ agent_id: id, tool_input: { command: 'sleep 30' } });
    for (const withRule of [false, true]) {
      const id = 'g-perm' + (withRule ? '1' : '0');
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(withRule ? { permissions: { deny: ['Bash(sleep:*)'] } } : {}));
      both(dir, sleepPayload(id), { ...at(0), ...REWRITE });
      const b = both(dir, sleepPayload(id), { ...at(3), ...REWRITE });
      if (withRule) {
        assert.equal(decisionOf(b.poll), 'deny', 'poll-guard keeps the refusal');
        assert.notEqual(b.tail.json?.hookSpecificOutput?.updatedInput?.run_in_background, true);
      } else {
        assert.equal(decisionOf(b.poll), undefined, 'poll-guard stands down');
        assert.equal(b.tail.json.hookSpecificOutput.updatedInput.run_in_background, true);
      }
    }
  } finally { cleanup(); }
});

test('rewrite: worker_wait_rewrite is declared in plugin.json (default true)', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.worker_wait_rewrite.type, 'boolean');
  assert.equal(cfg.worker_wait_rewrite.default, true);
});

// 0.31.80: tailOwnsCommand matched /worktree/ anywhere in the text, so a path or prose that merely says "worktree" kept poll-guard's refusal.
test('rewrite: a repeat wait whose text only mentions worktree (a path, a heredoc note) is rewritten, not refused', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const cmds = [
      'cd /x/.claude/worktrees/w1 && sleep 30',
      "cat > note.md <<'EOF'\nthe worktree is clean\nEOF\nsleep 30",
    ];
    cmds.forEach((command, i) => {
      const id = 'g-wt' + i;
      both(dir, payload({ agent_id: id, tool_input: { command } }), { ...at(0), ...REWRITE });
      const b = both(dir, payload({ agent_id: id, tool_input: { command } }), { ...at(3), ...REWRITE });
      assert.equal(decisionOf(b.poll), undefined, command);
      assert.equal(b.tail.json.hookSpecificOutput.updatedInput.run_in_background, true, command);
    });
  } finally { cleanup(); }
});

// 0.31.80: the hooks run in parallel; bash-tail may have written this call's stamp (a later clock reading) before poll-guard reads it.
test('rewrite: poll-guard judges bash-tail\'s stamp as of before this call, so the two hooks cannot disagree', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const id = 'g-race';
    const withCall = (n) => payload({ agent_id: id, tool_use_id: 'call-' + n, tool_input: { command: 'sleep 30' } });
    both(dir, withCall(1), { ...at(0), ...REWRITE });
    const later = { AGENT_COMPANION_FAKE_NOW: new Date(T0 + 3 * 60000 + 5).toISOString(), ...REWRITE };
    const earlier = { AGENT_COMPANION_FAKE_NOW: new Date(T0 + 3 * 60000).toISOString(), ...REWRITE };
    const e = (x) => ({ CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...x });
    const tail = runHook('hooks/bash-tail.mjs', withCall(2), { env: e(later) });
    const poll = runHook('hooks/poll-guard.mjs', withCall(2), { env: e(earlier) });
    assert.equal(tail.json.hookSpecificOutput.updatedInput.run_in_background, true);
    assert.equal(decisionOf(poll), undefined, 'poll-guard stands down although bash-tail stamped a later time');
  } finally { cleanup(); }
});

// 0.31.80: the worker-wait.jsonl row records the real outcome; release-watch counts action 'deny' rows as refusals.
test('rewrite: the worker-wait row says stand-down when bash-tail rewrites, deny when poll-guard refuses', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const [id, command] of [['g-row-a', 'sleep 30'], ['g-row-b', 'git worktree remove x; sleep 30']]) {
      both(dir, payload({ agent_id: id, tool_input: { command } }), { ...at(0), ...REWRITE });
      both(dir, payload({ agent_id: id, tool_input: { command } }), { ...at(3), ...REWRITE });
    }
    const rows = rowsOf(dir);
    assert.deepEqual(rows.filter((r) => r.agent_id === 'g-row-a').map((r) => r.action), ['hint', 'stand-down']);
    assert.deepEqual(rows.filter((r) => r.agent_id === 'g-row-b').map((r) => r.action), ['hint', 'deny']);
  } finally { cleanup(); }
});

// 0.31.80 review follow-ups.
test('stamp: an old-format stamp { s, t } with no id reads as the previous call, with or without a call id on the payload', async () => {
  const { stampBeforeThisCall } = await import('../hooks/lib/worker-wait-rewrite.mjs');
  const now = T0 + 5 * 60000;
  const old = { s: 'ww-guard-1', t: T0 };
  assert.deepEqual(stampBeforeThisCall(old, { tool_use_id: 'call-9' }, now), old, 'with an id on the payload an id-less stamp is not this call\'s');
  assert.deepEqual(stampBeforeThisCall(old, {}, now), old, 'without an id an old stamp (older than a second) is the previous call');
  assert.equal(stampBeforeThisCall(null, {}, now), null);
});

test('stamp: the write is atomic (it goes through a temp file renamed over the stamp, and the stamp parses)', async () => {
  const { writeStamp, readStamp } = await import('../hooks/lib/subagent-context.mjs');
  const { dir, cleanup } = makeFixture();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    assert.equal(writeStamp('atomic-key', { s: 'a', t: 1 }), true);
    assert.deepEqual(readStamp('atomic-key'), { s: 'a', t: 1 });
    assert.match(readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'subagent-context.mjs'), 'utf8'), /renameSync\(tmp, dest\)/);
  } finally { if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev; cleanup(); }
});

// Both hooks, one call with no tool_use_id, 0.5 s after the previous wait, poll-guard first.
test('rewrite: an id-less repeat 0.5 s after the previous wait gets the same answer from both hooks (poll-guard first)', { todo: 'known limit: without a tool_use_id a stamp written 0.5 s earlier cannot be told from the stamp of this call (hook start skew), so poll-guard refuses while bash-tail rewrites' }, () => {
  const { dir, cleanup } = makeFixture();
  try {
    const id = 'g-noid';
    const p = () => payload({ agent_id: id, tool_input: { command: 'sleep 30' } });
    const e = (x) => ({ CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...REWRITE, ...x });
    both(dir, p(), { ...at(0), ...REWRITE });
    const half = { AGENT_COMPANION_FAKE_NOW: new Date(T0 + 500).toISOString() };
    const poll = runHook('hooks/poll-guard.mjs', p(), { env: e(half) });
    const tail = runHook('hooks/bash-tail.mjs', p(), { env: e(half) });
    const rewritten = tail.json?.hookSpecificOutput?.updatedInput?.run_in_background === true;
    const denied = decisionOf(poll) === 'deny';
    assert.equal(denied, !rewritten, 'one hook refuses exactly when the other does not rewrite');
  } finally { cleanup(); }
});
