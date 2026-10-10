// 0.31.5: three noisy PreToolUse:Agent messages are gone, and the fix changes
// MESSAGES only, never a deny/ask decision or the text appended to a brief.
//   1. "agent-companion (self-review): ... does not carry the protocol in its
//      definition, so it was appended to the brief" -- the append stays.
//   2. An empty "PreToolUse:Agent says:" -- the guard now prints nothing when
//      it has no text, no updatedInput and no additionalContext.
//   3. The "names X AND passes isolation" notice -- wrong on desktop; gone,
//      while the gate2_fired telemetry flag stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, decisionOf } from './helpers.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}
const spawn = (dir, input, env = {}, session = 'sess-quiet') => runHook('hooks/spawn-guard.mjs', {
  session_id: session, agent_type: 'main', tool_name: 'Agent', cwd: dir, tool_input: input,
}, { env: { ...baseEnv(dir), ...env } });

test('a spawn with nothing to say prints nothing at all (no empty "PreToolUse:Agent says:")', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = spawn(dir, {
      subagent_type: 'agent-companion:ac-sonnet-low', model: 'sonnet', name: 'quiet-one', run_in_background: true,
      isolation: 'worktree', prompt: 'TYPE: mechanical-edit\nROLE: writer\nrename the variable',
    }, { CLAUDE_PLUGIN_OPTION_BREVITY: 'false', CLAUDE_PLUGIN_OPTION_BREVITY_PEER: 'false' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '', 'no output object when there is no text and no change');
    assert.equal(decisionOf(res.json), null);
  } finally {
    cleanup();
  }
});

test('name + isolation: no isolation notice, gate2_fired still recorded, decision unchanged', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = spawn(dir, {
      subagent_type: 'agent-companion:ac-sonnet-low', model: 'sonnet', name: 'named-iso', isolation: 'worktree',
      run_in_background: true, prompt: 'TYPE: mechanical-edit\nROLE: writer\nrename it',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /AND passes isolation|ORDINARY SUBAGENT|agent-teams\.md/);
    assert.equal(readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0].gate2_fired, true);
    // A gate that DENIES still denies on the same shape, with no notice in the reason.
    const blocked = spawn(dir, {
      subagent_type: 'general-purpose', model: 'sonnet', name: 'named-iso-fg', isolation: 'worktree', prompt: 'no justification',
    }, { CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' }, 'sess-quiet-block');
    assert.equal(decisionOf(blocked.json), 'deny');
    assert.doesNotMatch(blocked.stdout, /AND passes isolation/);
  } finally {
    cleanup();
  }
});

test('self-review append: the brief still carries the protocol, the lead gets no note about it', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = spawn(dir, {
      subagent_type: 'agent-companion:ac-opus-max', name: 'sr-writer', run_in_background: true, isolation: 'worktree',
      prompt: 'TYPE: novel-design\nWARRANT: weight 5 - test\nROLE: writer\ndesign it',
    });
    assert.equal(res.status, 0, res.stderr);
    const prompt = res.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt, /## Self-review before you return/);
    assert.match(prompt, /Land your own work/);
    assert.doesNotMatch(res.json?.systemMessage || '', /self-review\)|does not carry the protocol/);
    assert.notEqual(decisionOf(res.json), 'deny');
    assert.equal(readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0].self_review_injected, true);
  } finally {
    cleanup();
  }
});
