// Bash exit telemetry (hooks/bash-exit.mjs): record only. Payload shapes follow the Claude Code
// hooks documentation (PostToolUse on success, PostToolUseFailure with `error: "Exit code N..."`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { cmdKey, normalizeCommand } from '../hooks/lib/bash-exit.mjs';

const HOOK = 'hooks/bash-exit.mjs';
const post = (extra) => ({ session_id: 'sess-be', hook_event_name: 'PostToolUse', tool_name: 'Bash',
  tool_input: { command: 'node scripts/ci-local.mjs' }, tool_response: { stdout: 'ok', stderr: '' }, ...extra });
const fail = (extra) => ({ session_id: 'sess-be', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command: 'node scripts/ci-local.mjs' }, error: 'Exit code 2\nboom', is_interrupt: false, ...extra });
const rowsOf = (fx) => {
  const f = join(fx.stateDir, 'telemetry', 'bash-exit.jsonl');
  return existsSync(f) ? readJsonl(f) : [];
};
const run = (fx, payload, env) => runHook(HOOK, { cwd: fx.dir, ...payload }, { env });

test('success payload -> exit 0, failed false; prints nothing, exits 0', () => {
  const fx = makeFixture();
  try {
    const r = run(fx, post());
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const [row] = rowsOf(fx);
    assert.equal(row.exit, 0);
    assert.equal(row.failed, false);
    assert.equal(row.caller_is_subagent, false);
    assert.equal(row.agent_id, null);
  } finally { fx.cleanup(); }
});

test('failure payload "Exit code 2" -> exit 2, failed true', () => {
  const fx = makeFixture();
  try {
    const r = run(fx, fail());
    assert.equal(r.stdout.trim(), '');
    const [row] = rowsOf(fx);
    assert.equal(row.exit, 2);
    assert.equal(row.failed, true);
  } finally { fx.cleanup(); }
});

test('failure with an unparseable error -> exit null, failed true; interrupt -> exit null, interrupted', () => {
  const fx = makeFixture();
  try {
    run(fx, fail({ error: 'something odd' }));
    run(fx, fail({ error: 'The user doesn\'t want to proceed', is_interrupt: true }));
    const rows = rowsOf(fx);
    assert.deepEqual([rows[0].exit, rows[0].failed], [null, true]);
    assert.deepEqual([rows[1].exit, rows[1].failed, rows[1].interrupted], [null, false, true]);
  } finally { fx.cleanup(); }
});

test('defensive: a PostToolUse payload carrying a non-zero exit field or an error is a failure', () => {
  const fx = makeFixture();
  try {
    run(fx, post({ tool_response: { exit_code: 3 } }));
    run(fx, post({ tool_response: undefined, error: 'Exit code 7\nx' }));
    const rows = rowsOf(fx);
    assert.deepEqual([rows[0].exit, rows[0].failed], [3, true]);
    assert.deepEqual([rows[1].exit, rows[1].failed], [7, true]);
  } finally { fx.cleanup(); }
});

test('subagent flag comes from agent_id', () => {
  const fx = makeFixture();
  try {
    run(fx, post({ agent_id: 'a1', agent_type: 'ac-sonnet-medium' }));
    const [row] = rowsOf(fx);
    assert.equal(row.caller_is_subagent, true);
    assert.equal(row.agent_id, 'a1');
    assert.equal(row.agent_type, 'ac-sonnet-medium');
  } finally { fx.cleanup(); }
});

test('the same gate in different forms shares cmd_key; a different command does not', () => {
  const g = 'node scripts/ci-local.mjs';
  assert.equal(cmdKey(g), cmdKey(`cd /some/where && ${g}  2>&1`));
  assert.equal(cmdKey(g), cmdKey(`cd "C:/a b" && ${g} 2>&1 | tail -20`));
  assert.equal(cmdKey(g), cmdKey(`${g} | tail -n 5`));
  assert.notEqual(cmdKey(g), cmdKey('node scripts/other.mjs'));
  const wrapped = `__acf='/tmp/x.log'\nif true; then\n{ ${g}\n} > "$__acf" 2>&1\n__acrc=$?\nelse\n${g}\nfi`;
  assert.equal(normalizeCommand(wrapped), g);
});

test('row has no command text, only cmd_key and runner', () => {
  const fx = makeFixture();
  try {
    run(fx, post({ tool_input: { command: 'npm test --secret-flag-xyz' } }));
    const raw = JSON.stringify(rowsOf(fx));
    assert.ok(!raw.includes('secret-flag-xyz'));
    
    const [row] = rowsOf(fx);
    assert.match(row.cmd_key, /^[0-9a-f]{12}$/);
    assert.ok(row.runner && row.runner.startsWith('npm'));
  } finally { fx.cleanup(); }
});

test('non-Bash tools and options off write nothing', () => {
  const fx = makeFixture();
  try {
    run(fx, post({ tool_name: 'Read' }));
    run(fx, post(), { CLAUDE_PLUGIN_OPTION_BASH_EXIT_TELEMETRY: '0' });
    run(fx, post(), { CLAUDE_PLUGIN_OPTION_SPAWN_TELEMETRY: '0' });
    assert.deepEqual(rowsOf(fx), []);
  } finally { fx.cleanup(); }
});

test('garbage stdin fails open', () => {
  const fx = makeFixture();
  try {
    const r = runHook(HOOK, undefined, {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});
