// Reviewer sessions: the SDK review engine marks its child with AC_REVIEWER_SESSION=1. With the marker, the lead and
// orchestration hooks are silent and the safety guards still deny; without it nothing changes.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, decisionOf, PLUGIN_ROOT } from './helpers.mjs';
import { REVIEWER_OFF_HOOKS, REVIEWER_SESSION_ENV, isReviewerSession } from '../hooks/lib/context.mjs';

const MARK = { [REVIEWER_SESSION_ENV]: '1' };

test('isReviewerSession: only the value 1 counts', () => {
  assert.equal(isReviewerSession({ AC_REVIEWER_SESSION: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(isReviewerSession({ AC_REVIEWER_SESSION: v }), false, String(v));
  assert.equal(isReviewerSession({}), false);
});

test('REVIEWER_OFF_HOOKS: every name is a real hook script; the safety and record hooks are not on the list', () => {
  const scripts = new Set(readdirSync(join(PLUGIN_ROOT, 'hooks')).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')));
  for (const n of REVIEWER_OFF_HOOKS) assert.ok(scripts.has(n), `${n} is a hook script`);
  assert.equal(new Set(REVIEWER_OFF_HOOKS).size, REVIEWER_OFF_HOOKS.length, 'no duplicates');
  for (const n of ['poll-guard', 'bash-tail', 'bash-exit', 'read-dedupe', 'window-check', 'scope-tripwire', 'subagent-context', 'compact-floor']) {
    assert.ok(!REVIEWER_OFF_HOOKS.includes(n), `${n} stays on`);
  }
});

test('safety guard stays on: printenv is denied with and without the marker', () => {
  const ask = (env) => runHook('hooks/poll-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'printenv' }, session_id: 's-rev-1' }, { env });
  assert.equal(decisionOf(ask({}).json), 'deny');
  const r = ask(MARK);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decisionOf(r.json), 'deny', 'a reviewer session is still refused an environment dump');
});

test('safety guard stays on: kill by image name is denied in a reviewer session', () => {
  const r = runHook('hooks/poll-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'taskkill /F /IM zzz_none.exe' }, session_id: 's-rev-2' }, { env: MARK });
  assert.equal(decisionOf(r.json), 'deny');
});

test('safety guards stay on: plugin uninstall and a remote branch delete are denied in a reviewer session', () => {
  for (const [i, command] of ['claude plugin uninstall agent-companion', 'git push origin --delete topic', 'git push origin :topic'].entries()) {
    const r = runHook('hooks/poll-guard.mjs', { tool_name: 'Bash', tool_input: { command }, session_id: `s-rev-g${i}` }, { env: MARK });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decisionOf(r.json), 'deny', command);
  }
});

test('lead-only: the delegation guard blocks the long execution streak without the marker and is silent with it', () => {
  const fx = makeFixture();
  try {
    const env = {
      CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
      CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'block', CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2',
    };
    const call = (sid, extra) => runHook('hooks/delegation-guard.mjs', {
      session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: fx.dir,
    }, { env: { ...env, ...extra } });
    const plain = [1, 2, 3, 4].map(() => decisionOf(call('s-rev-plain', {}).json));
    assert.ok(plain.includes('deny'), `without the marker the guard fires: ${plain.join(',')}`);
    for (let i = 0; i < 4; i += 1) {
      const r = call('s-rev-marked', MARK);
      assert.equal(r.status, 0, r.stderr);
      assert.equal((r.stdout || '').trim(), '', 'silent with the marker');
    }
  } finally { fx.cleanup(); }
});

test('lead-only: standing rules print nothing with the marker, and still print without it', () => {
  const fx = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
    const ask = (extra) => runHook('hooks/standing-rules.mjs', { session_id: 's-rev-3', prompt: 'write me a prompt for a reviewer', cwd: fx.dir }, { env: { ...env, ...extra }, args: ['--event', 'user-prompt'] });
    const open = ask({});
    assert.ok(open.json && /fenced code block/.test(open.json.hookSpecificOutput.additionalContext), 'without the marker a rule fires');
    const marked = ask(MARK);
    assert.equal(marked.status, 0);
    assert.equal((marked.stdout || '').trim(), '', 'with the marker: silent');
  } finally { fx.cleanup(); }
});

test('lead-only: the poll guard doctrine hint is silent with the marker', () => {
  const fx = makeFixture();
  try {
    const poll = (ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' } }] } });
    const launch = { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }] } };
    const tp = join(fx.dir, 'session.jsonl');
    writeFileSync(tp, [launch, poll('2026-01-01T00:00:05Z'), poll('2026-01-01T00:01:05Z')].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const payload = { session_id: 's-rev-5', tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, transcript_path: tp };
    const env = { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
    const open = runHook('hooks/poll-guard.mjs', payload, { env });
    assert.ok(open.json && open.json.systemMessage, `without the marker the hint fires: ${open.stdout}`);
    const marked = runHook('hooks/poll-guard.mjs', payload, { env: { ...env, ...MARK } });
    assert.equal((marked.stdout || '').trim(), '', 'with the marker: silent');
  } finally { fx.cleanup(); }
});
