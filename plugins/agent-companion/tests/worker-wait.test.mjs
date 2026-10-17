// Worker one-wait rule: the pure detector (hooks/lib/poll-guard.mjs
// workerWaitPattern), the PreToolUse hook (hooks/poll-guard.mjs on
// Bash/PowerShell, subagents only) and the spawn-scope standing rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { workerWaitPattern, workerWaitHint } from '../hooks/lib/poll-guard.mjs';
import { matchRules, readRules } from '../hooks/lib/rules.mjs';

const MATCH = [
  ['gh pr checks 31', 'gh-check'],
  ['gh pr checks --watch', 'gh-check'],
  ['gh run watch 123', 'gh-check'],
  ['until gh pr checks 31 | grep -q pass; do sleep 20; done', 'loop'],
  ['while true; do gh run view 1 --exit-status && break; sleep 15; done', 'loop'],
  ['sleep 60 && gh pr view 31', 'sleep'],
  ['gh pr view 31 --json statusCheckRollup', 'gh-check'],
  ['gh api repos/o/r/commits/abc/check-runs', 'gh-check'],
  ['cd x && sleep 30', 'sleep'],
  ['Start-Sleep -Seconds 30', 'sleep'],
  ['watch -n 5 ls', 'sleep'],
];
const NO_MATCH = [
  'echo "sleep 5"',
  'sleep 1',
  'git log --grep=sleep',
  'node scripts/pr-wait.mjs 31',
  'node "/p/scripts/pr-wait.mjs" 31 && sleep 60',
  'gh pr view 31 --json title',
  'ls -la',
  '',
];

for (const [cmd, kind] of MATCH) {
  test(`workerWaitPattern matches ${JSON.stringify(cmd)} as ${kind}`, () => {
    assert.deepEqual(workerWaitPattern(cmd), { kind });
  });
}
for (const cmd of NO_MATCH) {
  test(`workerWaitPattern leaves ${JSON.stringify(cmd)} alone`, () => {
    assert.equal(workerWaitPattern(cmd), null);
  });
}
test('workerWaitPattern: a run_in_background call is the sanctioned one-wait', () => {
  assert.equal(workerWaitPattern('gh run watch 123', { background: true }), null);
  assert.equal(workerWaitPattern('until gh pr checks 31; do sleep 20; done', { background: true }), null);
});
test('workerWaitPattern never throws on odd input', () => {
  for (const v of [undefined, null, 42, {}, '"unterminated']) assert.doesNotThrow(() => workerWaitPattern(v));
});
test('the hint names pr-wait.mjs and run_in_background', () => {
  const h = workerWaitHint('C:\\p\\agent-companion');
  assert.match(h, /pr-wait\.mjs/);
  assert.match(h, /run_in_background/);
  assert.match(h, /C:\/p\/agent-companion\/scripts\/pr-wait\.mjs/);
});

function payload(extra = {}) {
  return {
    session_id: 'ww-hook-1',
    tool_name: 'Bash',
    tool_input: { command: 'until gh pr checks 31; do sleep 20; done' },
    agent_id: 'agent-w1',
    ...extra,
  };
}
function run(dir, p, env = {}) {
  return runHook('hooks/poll-guard.mjs', p, {
    env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...env },
  });
}
function rowsOf(dir) {
  return readJsonl(join(dir, '.claude', 'agent-companion', 'telemetry', 'worker-wait.jsonl'));
}

test('hook (worker_wait_guard=hint): a subagent gets the hint once; the second match is silent but logged', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const HINT = { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_GUARD: 'hint' };
    const a = run(dir, payload(), HINT);
    assert.equal(a.status, 0);
    const ctx = a.json?.hookSpecificOutput?.additionalContext;
    assert.match(ctx, /One-wait rule for workers/);
    assert.match(ctx, /pr-wait\.mjs/);
    assert.equal(a.json.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(a.json.permissionDecision, undefined);
    const b = run(dir, payload(), HINT);
    assert.equal((b.stdout || '').trim(), '');
    const rows = rowsOf(dir);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.first), [true, false]);
    assert.equal(rows[0].kind, 'loop');
    assert.equal(rows[0].agent_id, 'agent-w1');
  } finally { cleanup(); }
});

test('hook: PowerShell is covered; a different worker gets its own hint', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const a = run(dir, payload({ tool_name: 'PowerShell', tool_input: { command: 'Start-Sleep -Seconds 30' }, agent_id: 'agent-w2' }));
    assert.match(a.json?.hookSpecificOutput?.additionalContext || '', /One-wait rule/);
  } finally { cleanup(); }
});

test('hook: the main thread (no agent_id) gets nothing and logs nothing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = payload();
    delete p.agent_id;
    const res = run(dir, p);
    assert.equal((res.stdout || '').trim(), '');
    assert.equal(rowsOf(dir).length, 0);
  } finally { cleanup(); }
});

test('hook: run_in_background, pr-wait.mjs and ordinary commands are silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const input of [
      { command: 'gh run watch 1', run_in_background: true },
      { command: 'node scripts/pr-wait.mjs 31' },
      { command: 'git status' },
    ]) {
      assert.equal((run(dir, payload({ tool_input: input })).stdout || '').trim(), '');
    }
    assert.equal(rowsOf(dir).length, 0);
  } finally { cleanup(); }
});

test('hook: worker_wait_advisory=false silences it', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = run(dir, payload(), { CLAUDE_PLUGIN_OPTION_WORKER_WAIT_ADVISORY: 'false' });
    assert.equal((res.stdout || '').trim(), '');
    assert.equal(rowsOf(dir).length, 0);
  } finally { cleanup(); }
});

test('hook: poll_guard=false does not switch the worker rule off (separate kill switch)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = run(dir, payload(), { CLAUDE_PLUGIN_OPTION_POLL_GUARD: 'false' });
    assert.match(res.json?.hookSpecificOutput?.additionalContext || '', /One-wait rule/);
  } finally { cleanup(); }
});

test('rule: worker-one-wait is a builtin spawn rule, short, and follows worker_wait_advisory', () => {
  const { cleanup } = makeFixture();
  try {
    const r = readRules().rules.find((x) => x.id === 'worker-one-wait');
    assert.ok(r && r.builtin && r.scope === 'spawn' && r.enabled);
    assert.ok(r.then.length <= 240, `${r.then.length} chars`);
    assert.match(r.then, /No interim notice for a planned wait/);
    const op = readRules().rules.find((x) => x.id === 'worker-one-wait-operate');
    assert.match(op.then, /No interim notice for a planned wait/);
    assert.ok(matchRules({ scope: 'spawn', text: 'TYPE: x\nDo a thing', sessionId: 's' }).some((x) => x.id === 'worker-one-wait'));
    process.env.CLAUDE_PLUGIN_OPTION_WORKER_WAIT_ADVISORY = 'false';
    try {
      assert.ok(!matchRules({ scope: 'spawn', text: 'Do a thing', sessionId: 's' }).some((x) => x.id === 'worker-one-wait'));
    } finally { delete process.env.CLAUDE_PLUGIN_OPTION_WORKER_WAIT_ADVISORY; }
  } finally { cleanup(); }
});

test('hooks.json matcher covers Bash and PowerShell for poll-guard', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((e) => e.hooks.some((h) => (h.args || []).some((a) => a.endsWith('hooks/poll-guard.mjs'))));
  assert.ok(entry);
  assert.equal(entry.matcher, '^(ScheduleWakeup|Monitor|Bash|PowerShell)$');
});
