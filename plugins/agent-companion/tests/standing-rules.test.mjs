import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import {
  SCOPES, defaultRules, readRules, matchRules, renderRules, rulesPath,
} from '../hooks/lib/rules.mjs';
import { stateFile, writeJson } from '../hooks/lib/context.mjs';

// Run a fn with one or more env vars set, restoring the previous values
// (including "was unset") afterwards regardless of how fn exits.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('readRules() with no file returns the built-ins, agent-brevity disabled', () => {
  const { cleanup } = makeFixture();
  try {
    const { rules } = readRules();
    const ids = rules.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      'agent-brevity', 'copyable-prompt', 'delegate-first', 'delegate-reminder', 'lead-brevity',
    ].sort());
    assert.equal(rules.find((r) => r.id === 'agent-brevity').enabled, false);
    for (const id of ['copyable-prompt', 'delegate-first', 'delegate-reminder', 'lead-brevity']) {
      assert.equal(rules.find((r) => r.id === id).enabled, true, `${id} should default to enabled`);
    }
    assert.deepEqual(defaultRules().length, rules.length);
    for (const s of SCOPES) assert.ok(typeof s === 'string');
  } finally {
    cleanup();
  }
});

test('a minimal user override disables a built-in without dropping it', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'copyable-prompt', enabled: false }]));
    const { rules } = readRules();
    const r = rules.find((x) => x.id === 'copyable-prompt');
    assert.ok(r, 'copyable-prompt must still be present');
    assert.equal(r.enabled, false);
    assert.equal(r.builtin, true);
    assert.equal(matchRules({ scope: 'user-prompt', text: 'write me a prompt for a reviewer' }).length, 0);
  } finally {
    cleanup();
  }
});

test('an unknown id in the user file is appended as a non-builtin rule', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 'my-own-rule', scope: 'user-prompt', when: '\\bfoo\\b', then: 'say foo things' },
    ]));
    const { rules } = readRules();
    const r = rules.find((x) => x.id === 'my-own-rule');
    assert.ok(r, 'my-own-rule must be present');
    assert.equal(r.builtin, false);
    assert.equal(r.enabled, true);
    assert.equal(r.then, 'say foo things');
  } finally {
    cleanup();
  }
});

test('garbage entries in the user file are dropped without throwing', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      'not an object',
      {},
      { id: 'bad-scope-rule', scope: 'not-a-real-scope', then: 'x' },
      { id: 'no-then-rule', scope: 'user-prompt', when: '.' },
      42,
      null,
    ]));
    let result;
    assert.doesNotThrow(() => { result = readRules(); });
    const ids = result.rules.map((r) => r.id);
    assert.ok(!ids.includes('bad-scope-rule'));
    assert.ok(!ids.includes('no-then-rule'));
    // Only the five built-ins survive; nothing usable came from the garbage.
    assert.equal(result.rules.length, defaultRules().length);
  } finally {
    cleanup();
  }
});

test('an uncompilable when regex disables the rule instead of throwing', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 'bad-regex-rule', scope: 'user-prompt', when: '(', then: 'unreachable' },
    ]));
    let result;
    assert.doesNotThrow(() => { result = readRules(); });
    const r = result.rules.find((x) => x.id === 'bad-regex-rule');
    assert.ok(r, 'the rule must still be present, just disabled');
    assert.equal(r.enabled, false);
  } finally {
    cleanup();
  }
});

test('an over-length when source (>400 chars) also disables the rule', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 'pathological-rule', scope: 'user-prompt', when: `a${'?'.repeat(410)}`, then: 'unreachable' },
    ]));
    const { rules } = readRules();
    const r = rules.find((x) => x.id === 'pathological-rule');
    assert.ok(r);
    assert.equal(r.enabled, false);
  } finally {
    cleanup();
  }
});

test('matchRules(user-prompt) matches copyable-prompt on a prompt-shaped ask, not on unrelated text', () => {
  const { cleanup } = makeFixture();
  try {
    const hit = matchRules({ scope: 'user-prompt', text: 'write me a prompt for a reviewer' });
    assert.deepEqual(hit.map((r) => r.id), ['copyable-prompt']);

    const miss = matchRules({ scope: 'user-prompt', text: 'fix the login bug' });
    assert.equal(miss.length, 0);
  } finally {
    cleanup();
  }
});

test('renderRules respects maxChars and reports the dropped count', () => {
  const rules = [
    { then: 'x'.repeat(10) },
    { then: 'y'.repeat(10) },
    { then: 'z'.repeat(10) },
  ];
  const firstTwoOnly = renderRules(rules.slice(0, 2), { maxChars: 100000 });
  const capped = renderRules(rules, { maxChars: firstTwoOnly.length });

  assert.ok(capped.includes('x'.repeat(10)));
  assert.ok(capped.includes('y'.repeat(10)));
  assert.ok(!capped.includes('z'.repeat(10)), 'the third rule should have been dropped by the cap');
  assert.match(capped, /1 more rule dropped/);

  assert.equal(renderRules([]), '');
});

test('gate: brevity — excludes a gated rule when brevity resolves OFF, includes it when ON', () => {
  const { cleanup } = makeFixture();
  try {
    withEnv({ CLAUDE_PLUGIN_OPTION_BREVITY: 'false' }, () => {
      const off = matchRules({ scope: 'session-start', sessionId: 'sess-gate-1' });
      assert.ok(!off.some((r) => r.id === 'lead-brevity'), 'lead-brevity must be excluded when brevity is off');
      assert.ok(off.some((r) => r.id === 'delegate-first'), 'an ungated rule must still fire');
    });

    withEnv({ CLAUDE_PLUGIN_OPTION_BREVITY: 'true' }, () => {
      const on = matchRules({ scope: 'session-start', sessionId: 'sess-gate-2' });
      assert.ok(on.some((r) => r.id === 'lead-brevity'), 'lead-brevity must fire when brevity is on');
    });
  } finally {
    cleanup();
  }
});

test('gate: delegation-drift — only satisfied once this session has actually fired', () => {
  const { cleanup } = makeFixture();
  try {
    // No delegation-streak.json at all yet.
    assert.equal(
      matchRules({ scope: 'always', sessionId: 'sess-drift-1' }).some((r) => r.id === 'delegate-reminder'),
      false,
    );

    // Present, but this session's fired counter is 0 (or absent, which reads as 0).
    writeJson(stateFile('delegation-streak.json'), { 'sess-drift-1': { streak: 1, fired: 0 } });
    assert.equal(
      matchRules({ scope: 'always', sessionId: 'sess-drift-1' }).some((r) => r.id === 'delegate-reminder'),
      false,
    );

    // This session has actually fired.
    writeJson(stateFile('delegation-streak.json'), { 'sess-drift-1': { streak: 0, fired: 2 } });
    assert.equal(
      matchRules({ scope: 'always', sessionId: 'sess-drift-1' }).some((r) => r.id === 'delegate-reminder'),
      true,
    );

    // No sessionId at all (e.g. CLI usage) must never claim drift is active.
    assert.equal(
      matchRules({ scope: 'always' }).some((r) => r.id === 'delegate-reminder'),
      false,
    );
  } finally {
    cleanup();
  }
});

test('hook --event user-prompt: matching prompt injects the directive, non-matching prompt is silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const hit = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-hook-1', prompt: 'write me a prompt for a reviewer', cwd: dir },
      { args: ['--event', 'user-prompt'] });
    assert.equal(hit.status, 0);
    assert.ok(hit.json, `expected JSON stdout, got: ${hit.stdout}`);
    assert.equal(hit.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(hit.json.hookSpecificOutput.additionalContext.includes('fenced code block'));
    assert.equal(hit.json.systemMessage, undefined, 'a rule firing must never set systemMessage');

    const miss = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-hook-2', prompt: 'fix the login bug', cwd: dir },
      { args: ['--event', 'user-prompt'] });
    assert.equal(miss.status, 0);
    assert.equal(miss.stdout.trim(), '', 'a non-matching prompt must produce completely empty stdout');
  } finally {
    cleanup();
  }
});

test('hook --event session-start: emits the lead-brevity directive by default', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-hook-3', cwd: dir },
      { args: ['--event', 'session-start'] });
    assert.equal(res.status, 0);
    assert.ok(res.json, `expected JSON stdout, got: ${res.stdout}`);
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(res.json.hookSpecificOutput.additionalContext.includes('outcome level'));
  } finally {
    cleanup();
  }
});

test('standing_rules=false silences both events entirely', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const start = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-hook-4', cwd: dir },
      { env: { CLAUDE_PLUGIN_OPTION_STANDING_RULES: 'false' }, args: ['--event', 'session-start'] });
    assert.equal(start.status, 0);
    assert.equal(start.stdout.trim(), '');

    const prompt = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-hook-5', prompt: 'write me a prompt for a reviewer', cwd: dir },
      { env: { CLAUDE_PLUGIN_OPTION_STANDING_RULES: 'false' }, args: ['--event', 'user-prompt'] });
    assert.equal(prompt.status, 0);
    assert.equal(prompt.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('fails open when the state dir path is unwritable (a file, not a dir)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const blocker = join(dir, 'blocked-state-dir');
    writeFileSync(blocker, 'this is a file, not a directory');
    process.env.AGENT_COMPANION_STATE_DIR = blocker;

    const start = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-failopen-1', cwd: dir },
      { args: ['--event', 'session-start'] });
    assert.equal(start.status, 0, `must exit 0 even when its state dir is unwritable: stderr=${start.stderr}`);

    const prompt = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-failopen-2', prompt: 'write me a prompt', cwd: dir },
      { args: ['--event', 'user-prompt'] });
    assert.equal(prompt.status, 0, `must exit 0 even when its state dir is unwritable: stderr=${prompt.stderr}`);
  } finally {
    cleanup();
  }
});
