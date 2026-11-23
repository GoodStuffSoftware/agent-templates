import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import {
  SCOPES, defaultRules, readRules, matchRules, renderRules, rulesPath, userOwnText, COPYABLE_PROMPT_WHEN,
  outputCap, cutToCap, DEFAULT_OUTPUT_CAP, OUTPUT_CAP_CEILING,
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
      'agent-brevity', 'child-coordinator-messages', 'copyable-prompt', 'delegate-first', 'delegate-reminder', 'event-turn-quiet', 'knowledge-check-howto', 'lead-brevity', 'lead-effort-check', 'poll-guard-doctrine', 'pr-wait-hint', 'resume-doctrine', 'worker-one-wait', 'worker-one-wait-operate',
    ].sort());
    assert.equal(rules.find((r) => r.id === 'agent-brevity').enabled, false);
    for (const id of ['copyable-prompt', 'delegate-first', 'delegate-reminder', 'lead-brevity', 'poll-guard-doctrine', 'resume-doctrine', 'worker-one-wait', 'worker-one-wait-operate']) {
      assert.equal(rules.find((r) => r.id === id).enabled, true, `${id} should default to enabled`);
    }
    assert.deepEqual(defaultRules().length, rules.length);
    for (const s of SCOPES) assert.ok(typeof s === 'string');
  } finally {
    cleanup();
  }
});

test('0.31.54: the resume-doctrine rule carries the handoff clause in the same rule (no new rule), and the session-start text stays under the cap', () => {
  const { cleanup } = makeFixture();
  try {
    const { rules } = readRules();
    const rd = rules.find((r) => r.id === 'resume-doctrine');
    assert.match(rd.then, /A worker returning "DONE: partial, handoff at <path>" gets a fresh same-rung continuation from it./);
    assert.equal(rules.filter((r) => /DONE: partial, handoff at/.test(r.then || '')).length, 1, 'one rule, not a new one');
    // The cap test must be able to fail: render at the shipped default cap (3000) AND at 4200, and require that the
    // handoff clause survived (a rule dropped for length is replaced by a "(N more rules dropped" line, never silently).
    const hits = matchRules({ scope: 'session-start', text: '', sessionId: 's' });
    for (const maxChars of [3000, 4200]) {
      const text = renderRules(hits, { maxChars });
      assert.ok(text.includes('DONE: partial, handoff at'), `the handoff clause is in the session-start text at ${maxChars} chars`);
      assert.doesNotMatch(text, /more rules? dropped/, `no rule dropped for length at ${maxChars} chars (text is ${text.length})`);
    }
    // And the check itself bites: a cap too small for the whole set drops rules and says so.
    assert.match(renderRules(hits, { maxChars: 500 }), /more rules? dropped/);
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

    // Already reminded for both firings: not due until the guard fires again.
    writeJson(stateFile('delegation-streak.json'), { 'sess-drift-1': { streak: 0, fired: 2, reminded: 2 } });
    assert.equal(
      matchRules({ scope: 'always', sessionId: 'sess-drift-1' }).some((r) => r.id === 'delegate-reminder'),
      false,
    );
    writeJson(stateFile('delegation-streak.json'), { 'sess-drift-1': { streak: 0, fired: 3, reminded: 2 } });
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

test('hook --event user-prompt: delegate-reminder goes out once per guard firing, not on every later prompt', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
    const SID = 'sess-remind-once';
    const prompt = () => runHook('hooks/standing-rules.mjs', { session_id: SID, prompt: 'what next?' }, { env, args: ['--event', 'user-prompt'] });
    const reminded = (res) => /Delegation reminder/.test(res.json?.hookSpecificOutput?.additionalContext || '');
    const guardFires = () => runHook('hooks/delegation-guard.mjs', {
      session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, { env: { ...env, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2', CLAUDE_CODE_SESSION_ATTENDED: '1' } });

    assert.equal(reminded(prompt()), false, 'no firing yet: silent');
    guardFires(); guardFires(); // threshold 2: the second call fires (warn)
    assert.equal(reminded(prompt()), true, 'first prompt after a firing: reminded');
    assert.equal(reminded(prompt()), false, 'second prompt, no new firing: silent');
    assert.equal(reminded(prompt()), false);
    guardFires(); guardFires();
    assert.equal(reminded(prompt()), true, 'a new firing earns one more reminder');
    assert.equal(reminded(prompt()), false);
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

// 0.29.1 fix g: copyable-prompt fired on turns carrying only harness wrapper
// blocks (another agent's message or a task summary that says "prompt").
// A user-prompt rule matches only the user's own text, wrappers stripped.
const WRAPPED_ONLY = [
  '<cross-session-message from="peer">Here is the prompt for the reviewer: write a prompt</cross-session-message>',
  '<task-notification>\n<summary>Agent "prompt writer" completed</summary>\n</task-notification>',
  '<agent-message from="w">brief for the next worker; prompts attached</agent-message>',
  '<system-reminder>The user may ask for a prompt later.</system-reminder>',
  '<system-reminder>outer <task-notification>a prompt</task-notification> still outer prompt</system-reminder>',
  '<cross-session-message from="x">unterminated message that says prompt',
];

test('matchRules(user-prompt) ignores wrapper-only turns and still fires on the user\'s own ask', () => {
  const { cleanup } = makeFixture();
  try {
    for (const text of WRAPPED_ONLY) {
      assert.deepEqual(matchRules({ scope: 'user-prompt', text }).map((r) => r.id), [], text);
    }
    const ids = (text) => matchRules({ scope: 'user-prompt', text }).map((r) => r.id);
    assert.deepEqual(ids('write me a prompt for a reviewer'), ['copyable-prompt']);
    assert.deepEqual(ids(`${WRAPPED_ONLY[3]}\nwrite me a prompt for a reviewer`), ['copyable-prompt'], 'user text beside a wrapper still counts');
    assert.deepEqual(ids(`${WRAPPED_ONLY[0]}\nfix the login bug`), [], 'wrapper text never counts as the user\'s');
  } finally {
    cleanup();
  }
});

test('hook --event user-prompt: a wrapper-only turn never fires copyable-prompt; a real "write me a prompt" still fires', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const [i, prompt] of WRAPPED_ONLY.entries()) {
      const res = runHook('hooks/standing-rules.mjs',
        { session_id: `sess-wrap-${i}`, prompt, cwd: dir },
        { args: ['--event', 'user-prompt'] });
      assert.equal(res.status, 0);
      assert.ok(!(res.json?.hookSpecificOutput?.additionalContext || '').includes('fenced code block'), `wrapper-only turn must not fire copyable-prompt: ${prompt}`);
    }
    const hit = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-wrap-real', prompt: 'write me a prompt for a reviewer', cwd: dir },
      { args: ['--event', 'user-prompt'] });
    assert.ok(hit.json?.hookSpecificOutput?.additionalContext.includes('fenced code block'), hit.stdout);
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

// 0.29.2: copyable-prompt's `when` was \bprompts?\b, so ANY mention of a
// prompt fired it ("the prompt field is empty", "why do prompts time out?").
// It now fires on a request for a prompt only. Both directions, as a table.
const PROMPT_REQUESTS = [
  'write me a prompt for a reviewer',
  'Please write me a prompt for onboarding a new hire.',
  'give me a prompt that summarises the logs',
  'draft a prompt for the builder',
  'can you create a prompt to review this PR?',
  'I need a prompt for an agent that triages bugs',
  'a prompt that checks the handoff file, please',
  'write a short copyable prompt for the release agent',
  'draft a new system prompt for the support bot',
  'give me prompts for three reviewers',
  'write me a brief for the builder',
  'compose two prompts for the eval',
  'Prompt for the reviewer, please.',
  'write the prompt for the next worker',
  'generate a short prompt that tests the parser',
  'WRITE ME A PROMPT',
];
const PROMPT_MENTIONS = [
  'the prompt field is empty',
  'why do prompts time out?',
  'the prompt was too long, trim it',
  'I pasted the prompt above',
  'prompt caching makes this cheaper',
  'the system prompt says to be brief',
  'git will prompt for credentials on push',
  'fix the login bug',
  'please respond promptly',
  'does the prompt injection guard still work?',
  'the UserPromptSubmit hook fired twice',
  'give me a brief summary of the diff',
  'the brief for the builder was too long',
  'create a prompt field in the settings form',
  'write the prompt caching docs',
  'write a test for prompts',
  'the reviewer prompted me for a password',
  'update the prompt hook to skip wrappers',
];

test('copyable-prompt fires on a request for a prompt, and not on a mere mention of one', () => {
  assert.ok(PROMPT_REQUESTS.length >= 10 && PROMPT_MENTIONS.length >= 10);
  const { cleanup } = makeFixture();
  try {
    const ids = (text) => matchRules({ scope: 'user-prompt', text }).map((r) => r.id);
    for (const text of PROMPT_REQUESTS) assert.deepEqual(ids(text), ['copyable-prompt'], `should fire: ${text}`);
    for (const text of PROMPT_MENTIONS) assert.deepEqual(ids(text), [], `should stay silent: ${text}`);
  } finally {
    cleanup();
  }
});

test('the shipped copyable-prompt `when` fits the source-length cap, so it never goes inert', () => {
  const { cleanup } = makeFixture();
  try {
    assert.ok(COPYABLE_PROMPT_WHEN.length <= 400, `when is ${COPYABLE_PROMPT_WHEN.length} chars`);
    const r = readRules().rules.find((x) => x.id === 'copyable-prompt');
    assert.equal(r.when, COPYABLE_PROMPT_WHEN);
    assert.equal(r.enabled, true);
  } finally {
    cleanup();
  }
});

// 0.29.2: slash-command and teammate wrappers are harness text too.
const COMMAND_WRAPPED_ONLY = [
  '<teammate-message teammate_id="w1">write me a prompt for the reviewer</teammate-message>',
  '<command-message>prompt-writer is running</command-message>\n<command-name>/prompt-writer</command-name>\n<command-args>write me a prompt for a reviewer</command-args>',
  '<local-command-stdout>draft a prompt for the builder</local-command-stdout>',
  '<local-command-caveat>Caveat: generated while running local commands. Give me a prompt for them.</local-command-caveat>',
  '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>\n<local-command-stdout>a prompt that was cleared</local-command-stdout>',
];

test('userOwnText strips teammate and slash-command wrappers', () => {
  for (const text of COMMAND_WRAPPED_ONLY) assert.equal(userOwnText(text).trim(), '', text);
  assert.match(userOwnText(`${COMMAND_WRAPPED_ONLY[0]}\nfix the bug`), /fix the bug/);
});

test('a turn made only of teammate/slash-command wrappers stays silent, in matchRules and in the hook', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const [i, text] of COMMAND_WRAPPED_ONLY.entries()) {
      assert.deepEqual(matchRules({ scope: 'user-prompt', text }).map((r) => r.id), [], text);
      const res = runHook('hooks/standing-rules.mjs',
        { session_id: `sess-cmd-wrap-${i}`, prompt: text, cwd: dir },
        { args: ['--event', 'user-prompt'] });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '', `wrapper-only turn must be silent: ${text}`);
    }
    assert.deepEqual(
      matchRules({ scope: 'user-prompt', text: `${COMMAND_WRAPPED_ONLY[1]}\nwrite me a prompt for a reviewer` }).map((r) => r.id),
      ['copyable-prompt'], 'the user\'s own text beside the wrappers still counts');
  } finally {
    cleanup();
  }
});

// 0.29.2 review round 2: the reviewer's 44 phrasings, each with the reviewer's
// judgement of "is this a request for a prompt?". All 44 must agree.
const REVIEW_PHRASINGS = [
  ['prompt engineering is overrated', false],
  ['the system prompt is wrong', false],
  ['prompt me before deleting anything', false],
  ['can you prompt the user for their email?', false],
  ['write a prompt for X', true],
  ['write me a prompt for the reviewer', true],
  ['Can you draft a prompt that summarizes the diff?', true],
  ['give me a copyable prompt to hand to the builder', true],
  ['I need a prompt for onboarding a new agent', true],
  ['prompt for a code reviewer, please', true],
  ['Compose the system prompt for the scout', true],
  ['generate three prompts for the benchmark', true],
  ['could you write up a prompt for the release agent', true],
  ['I want a prompt that I can paste into the other session', true],
  ['Put together a prompt for the reviewer', true],
  ['Draft prompts for each of the three tracks', true],
  ['Write a handoff prompt.', true],
  ['write me a brief for the builder', true],
  ['make me a prompt for the lander', true],
  ["Write the reviewer's prompt", true],
  ['rewrite this prompt so it is shorter', true],
  ['turn this into a prompt I can paste', true],
  ['can I get a prompt to give the other agent?', true],
  ['what should the prompt for the scout say? write it out', true],
  ['the prompt field is empty', false],
  ['why do prompts time out?', false],
  ['write a test for prompts', false],
  ['create a prompt field on the settings page', false],
  ['give the prompt box a border', false],
  ['generate the prompt cache key', false],
  ['the user prompt hook fires twice', false],
  ['prompt injection in the fetched page is a risk', false],
  ['Generate a promptly-formatted report', false],
  ['the brief for the builder was too long', false],
  ['draft PR for the prompt fix', false],
  ['Prompt for confirmation before running migrations', false],
  ['The CLI shows a prompt for the password', false],
  ['git shows a prompt that asks for my passphrase', false],
  ['I got a prompt that said access denied', false],
  ['write the prompts to a log file', false],
  ['create a prompts table in the database', false],
  ['compose the prompt template loader from these parts', false],
  ['a prompt that I sent timed out', false],
  ['the prompt-submit hook is slow', false],
];

test('copyable-prompt agrees with every one of the reviewer\'s 44 phrasings', () => {
  assert.equal(REVIEW_PHRASINGS.length, 44);
  const { cleanup } = makeFixture();
  try {
    const wrong = REVIEW_PHRASINGS.filter(([text, want]) =>
      matchRules({ scope: 'user-prompt', text }).some((r) => r.id === 'copyable-prompt') !== want);
    assert.deepEqual(wrong, [], 'phrasings where the rule disagrees with the expected answer');
  } finally {
    cleanup();
  }
});

// 0.29.2 review round 3 (F5): round 2 had dropped craft/prepare/"send me"/
// "I'd like", which fired in 0.29.1 and round 1, and added a bare "get" that
// fired on a program's prompt. Plus the round-2 re-reviewer's other phrasings.
const ROUND3_PHRASINGS = [
  ['Could you craft a prompt for the scout?', true],
  ['Prepare a prompt for the release agent', true],
  ['Send me a prompt for the lander', true],
  ["I'd like a prompt for the reviewer", true],
  ['I would like a prompt that reviews the diff', true],
  ['could I get a prompt for the lander?', true],
  ['craft me a prompt', true],
  ['prepare the prompts for each track', true],
  ['send me the prompt for the fixer', true],
  ['Give the reviewer a prompt it can run cold', true],
  ["Draft the scout's prompt", true],
  ['Need a quick prompt for onboarding', true],
  ['Another prompt for the fixer, please', true],
  ['regenerate the prompt for the scout', true],
  ['I get a UAC prompt every time I run the installer', false],
  ['Why do I get a prompt for my SSH passphrase?', false],
  ['we get a prompt for 2FA on every push', false],
  ['we get prompted for 2FA every time', false],
  ['send the prompt to the API', false],
  ["I'd like the prompt box wider", false],
  ['I need to prompt the user for a password', false],
  ['Rewrite the prompt injection filter', false],
  ['The prompt that you wrote is too long', false],
  ['make the prompt box wider', false],
];

// 0.29.7 (V5 of the round-3 verification): "I'd like" matched only a
// straight apostrophe, so "I’d like a prompt" (U+2019, as phones and word
// processors type it) was silent, where 0.29.1 fired.
const APOSTROPHE_PHRASINGS = [
  ['I’d like a prompt for the reviewer', true],
  ['I’d like a copyable prompt for the lander', true],
  ['Iʼd like a prompt for the scout', true], // U+02BC
  ['I`d like a prompt for the fixer', true],
  ["I'd like a prompt for the reviewer", true],
  ['I’d like to prompt the user before deleting', false],
  ['I’d like the prompt box wider', false],
  ['I’d like the prompt field to be taller', false],
  ['They’d like the prompts table sorted', false],
];

test('copyable-prompt: "I\'d like" asks for a prompt with any apostrophe', () => {
  const { cleanup } = makeFixture();
  try {
    const wrong = APOSTROPHE_PHRASINGS.filter(([text, want]) =>
      matchRules({ scope: 'user-prompt', text }).some((r) => r.id === 'copyable-prompt') !== want);
    assert.deepEqual(wrong, [], 'phrasings where the rule disagrees with the expected answer');
  } finally {
    cleanup();
  }
});

test('copyable-prompt: craft, prepare, "send me" and "I\'d like" ask for a prompt; a program\'s prompt you "get" does not', () => {
  const { cleanup } = makeFixture();
  try {
    const wrong = ROUND3_PHRASINGS.filter(([text, want]) =>
      matchRules({ scope: 'user-prompt', text }).some((r) => r.id === 'copyable-prompt') !== want);
    assert.deepEqual(wrong, [], 'phrasings where the rule disagrees with the expected answer');
  } finally {
    cleanup();
  }
});

// 0.29.2 review round 3 (F6): a "<command-args " the user typed took the ">"
// of the harness's <system-reminder> that followed as its own, so it opened a
// wrapper that never closed and hid the user's ask. It is text, not a tag,
// when another wrapper tag starts before its ">".
test('a stray wrapper-tag name in the user\'s own text does not hide the ask', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // [text, the user's words that must survive, the real wrapper's text that must not]
    const cases = [
      ['the <command-args flag is ignored, write me a prompt for the reviewer\n<system-reminder>todo list is empty</system-reminder>',
        'write me a prompt for the reviewer', 'todo list'],
      ['why does <teammate-message from=x get dropped? draft a prompt for the fixer <teammate-message teammate_id="a">hi there</teammate-message>',
        'draft a prompt for the fixer', 'hi there'],
      // Inside a wrapper, the same stray name no longer swallows what follows the wrapper.
      ['<system-reminder>see the <command-args docs</system-reminder>\nwrite me a prompt for the reviewer',
        'write me a prompt for the reviewer', 'see the'],
    ];
    for (const [text, kept, removed] of cases) {
      const own = userOwnText(text);
      assert.ok(own.includes(kept), `the user's own words survive: ${text}`);
      assert.ok(!own.includes(removed), `the real wrapper's text is still removed: ${text}`);
      assert.deepEqual(matchRules({ scope: 'user-prompt', text }).map((r) => r.id), ['copyable-prompt'], text);
    }
    const res = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-stray-tag', prompt: cases[0][0], cwd: dir }, { args: ['--event', 'user-prompt'] });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /fenced code block/, 'the hook injects the copyable-prompt rule');
    // The shapes it must still strip: a real opening tag, attributes and all,
    // including an attribute value that names a wrapper tag.
    assert.equal(userOwnText('<teammate-message teammate_id="a" color="b">write me a prompt</teammate-message>').trim(), '');
    assert.equal(userOwnText('<command-args>write me a prompt</command-args>').trim(), '');
    for (const summary of ['fixed the <system-reminder> parsing', 'the <command-args bug']) {
      const block = `<teammate-message teammate_id="a" summary="${summary}">write me a prompt</teammate-message>`;
      assert.equal(userOwnText(block).trim(), '', block);
      assert.equal(userOwnText(`${block}\nfix the bug`).trim(), 'fix the bug', block);
    }
  } finally {
    cleanup();
  }
});

// userOwnText runs on every UserPromptSubmit. It used to strip one level of
// nesting per regex pass, about 30 s on 1 MB of nested wrapper tags. It is
// one linear pass now. Each input below is at least 1 MB; each must finish in
// under 200 ms, and the silent/fire behaviour must not change.
function oneMegabyte(unit) {
  return unit.repeat(Math.ceil((1 << 20) / unit.length));
}

test('wrapper stripping is linear: 1 MB of nested, unclosed and mixed wrappers finishes in under 200 ms', () => {
  const { cleanup } = makeFixture();
  try {
    const depth = Math.ceil((1 << 20) / '<system-reminder></system-reminder>'.length);
    const ask = 'write me a prompt for the reviewer';
    const MIXED = ['system-reminder', 'teammate-message', 'command-args', 'task-notification'];
    const opens = [];
    const closes = [];
    for (let i = 0; i < depth; i++) {
      const tag = MIXED[i % MIXED.length];
      opens.push(`<${tag} n="${i % 7}">`);
      closes.push(`</${tag}>`);
    }
    const mixed = `${opens.join('')}${ask}${closes.reverse().join('')}`;
    const cases = [
      ['nested, balanced', `${'<system-reminder>'.repeat(depth)}${ask}${'</system-reminder>'.repeat(depth)}`, false],
      ['nested, mixed names', mixed, false],
      ['nested, then the user\'s own ask', `${'<command-args>'.repeat(2 * depth)}x${'</command-args>'.repeat(2 * depth)}\n${ask}`, true],
      ['unclosed opening tags', `${oneMegabyte('<teammate-message x>')}${ask}`, false],
      ['opening tags with no ">" at all', `${oneMegabyte('<command-args ')}${ask}`, true],
      ['closing tags only', `${oneMegabyte('</command-args>')}${ask}`, true],
      ['mixed open, close and stray', `${oneMegabyte('<command-name>a</system-reminder><teammate-message>b</command-name>')}${ask}`, false],
    ];
    for (const [label, text, fires] of cases) {
      assert.ok(text.length >= 1 << 20, `${label}: the input must be at least 1 MB`);
      const t0 = process.hrtime.bigint();
      const hit = matchRules({ scope: 'user-prompt', text }).some((r) => r.id === 'copyable-prompt');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(hit, fires, `${label}: expected ${fires ? 'fire' : 'silent'}`);
      assert.ok(ms < 200, `${label}: took ${ms.toFixed(1)} ms`);
    }
  } finally {
    cleanup();
  }
});

test('renderRules names the rules it dropped over the cap (first six, then an ellipsis)', () => {
  const rules = [{ id: 'keep', then: 'k'.repeat(10) }];
  for (let i = 1; i <= 8; i += 1) rules.push({ id: `big-${i}`, then: 'b'.repeat(50) });
  const kept = renderRules(rules.slice(0, 1), { maxChars: 100000 });
  const out = renderRules(rules, { maxChars: kept.length + 10 });
  assert.match(out, /\(8 more rules dropped: over the \d+-char limit: big-1, big-2, big-3, big-4, big-5, big-6, \.\.\.\)/);
  const one = renderRules(rules.slice(0, 2), { maxChars: kept.length });
  assert.match(one, /\(1 more rule dropped: over the \d+-char limit: big-1\)/);
  assert.equal(renderRules(rules.slice(0, 1), { maxChars: kept.length }), kept, 'nothing dropped: no extra line');
});

test('the built-in lead session-start rules, effort check on, stay lean enough to leave room under the default cap', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'lead-effort-check', enabled: true }]));
    const lines = matchRules({ scope: 'session-start', sessionId: 'lean-1' })
      .filter((r) => r.id !== 'pr-wait-hint') // its length depends on the install path
      .map((r) => `\n- ${r.then.trim()}`.length);
    const total = lines.reduce((a, b) => a + b, 0);
    // 0.31.65: 1650 -> 1750 for the writer-brief sentence in delegate-first
    assert.ok(total <= 1750, `built-in lead rules (without pr-wait-hint) take ${total} chars; the operator's own rules share the 3000-char cap`);
  } finally {
    cleanup();
  }
});

test('outputCap: the hook cap is the standing_rules_max_chars option, 4000 when unset, never above the harness ceiling', () => {
  const KEY = 'CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS';
  const was = process.env[KEY];
  try {
    delete process.env[KEY];
    assert.equal(DEFAULT_OUTPUT_CAP, 4000);
    assert.equal(outputCap(), 4000, 'unset keeps the old 4000');
    process.env[KEY] = '4200';
    assert.equal(outputCap(), 4200, 'the option can raise the limit past 4000');
    process.env[KEY] = '3000';
    assert.equal(outputCap(), 3000, 'and lower it');
    process.env[KEY] = '50000';
    assert.equal(outputCap(), OUTPUT_CAP_CEILING, 'never past the point where the harness swaps the text for a preview');
    assert.ok(OUTPUT_CAP_CEILING < 10000);
    for (const bad of ['0', '-5', 'abc']) { process.env[KEY] = bad; assert.equal(outputCap(), 4000, bad); }
  } finally { if (was === undefined) delete process.env[KEY]; else process.env[KEY] = was; }
});

test('cutToCap: the "(N more rules dropped)" note rides on top of the cap and is never the part that gets cut', () => {
  const rules = [{ id: 'keep', then: 'k'.repeat(10) }];
  for (let i = 1; i <= 8; i += 1) rules.push({ id: `big-${i}`, then: 'b'.repeat(50) });
  const kept = renderRules(rules.slice(0, 1), { maxChars: 100000 });
  const cap = kept.length + 10;
  const out = renderRules(rules, { maxChars: cap });
  assert.match(out, /8 more rules dropped/);
  assert.ok(out.length > cap, 'the note is appended past the rules budget');
  assert.equal(out.slice(0, cap).includes('more rules dropped'), false, 'a plain slice at the cap loses it');
  assert.equal(cutToCap(out, cap), out, 'cutToCap keeps the whole block, note included');
  assert.equal(cutToCap('x'.repeat(50), 20), 'x'.repeat(20), 'no note: a plain cut at the cap');
  assert.equal(cutToCap('', 20), '');
  // a block longer than the cap even before the note: the rules are cut, the note stays
  const long = `${'y'.repeat(100)}\n- (3 more rules dropped: over the 40-char limit: a, b, c)`;
  const cut = cutToCap(long, 40);
  assert.ok(cut.startsWith('y'.repeat(40) + '\n- (3 more rules'), cut);
  assert.ok(cut.endsWith('a, b, c)'));
  assert.ok(cut.length < long.length);
});

test('hook --event session-start: with a small standing_rules_max_chars and several rules, the dropped-rules note survives the output cap', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-cap-note', cwd: dir },
      { args: ['--event', 'session-start'], env: { CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '400' } });
    assert.equal(res.status, 0);
    const text = res.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(text, /\(\d+ more rules? dropped: over the 400-char limit: [^)]+\)$/, text);
    assert.ok(text.includes('outcome level'), 'the first rule still fits');
  } finally {
    cleanup();
  }
});

// --- event turns ---------------------------------------------------------------------------------------------

import { isEventTurn, pickEventTurnText } from '../hooks/lib/rules.mjs';
import { runScript } from './helpers.mjs';

const EVENT_PROMPTS = {
  'task notification': '<task-notification>\n<task-id>w1</task-id>\n<summary>Worker "sample" completed</summary>\n</task-notification>',
  'cross-session message': '<cross-session-message from="peer-a">status: the build is green</cross-session-message>',
  'side-sessions event': '<side-sessions-event>\nside session "notes" finished\n</side-sessions-event>',
  'CI monitor event': '<ci-monitor-event>\nrun 42 failed on the lint job\n</ci-monitor-event>',
  'system notification reminder': '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n</system-reminder>',
};
const ET_ARGS = ['--event', 'user-prompt'];
const FULL_START = 'Event turn: nothing here was typed by the operator';
const SHORT_START = 'Event turn: update the task list';
const ctxOf = (res) => res.json?.hookSpecificOutput?.additionalContext || '';

test('isEventTurn: each wrapper kind alone is an event turn', () => {
  for (const [kind, prompt] of Object.entries(EVENT_PROMPTS)) assert.equal(isEventTurn(prompt), true, kind);
});

test('isEventTurn: operator text, keep-warm ping, plain text, empty and non-strings are not event turns', () => {
  assert.equal(isEventTurn(`${EVENT_PROMPTS['system notification reminder']}\nplease also check the logs`), false, 'operator text beside a reminder');
  assert.equal(isEventTurn(`${EVENT_PROMPTS['task notification']}\nfix the login bug`), false);
  assert.equal(isEventTurn('[ac-keep-warm] ping'), false);
  assert.equal(isEventTurn('fix the login bug'), false);
  assert.equal(isEventTurn('<system-reminder>The user hasn\'t heard from you in a while.</system-reminder>'), false, 'a reminder that is not a system notification');
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) assert.equal(isEventTurn(bad), false);
});

test('hook: each event kind injects the full text on the first firing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    let i = 0;
    for (const [kind, prompt] of Object.entries(EVENT_PROMPTS)) {
      const res = runHook('hooks/standing-rules.mjs', { session_id: `sess-ev-kind-${i++}`, prompt, cwd: dir }, { args: ET_ARGS });
      assert.equal(res.status, 0, kind);
      assert.ok(ctxOf(res).includes(FULL_START), `${kind}: ${res.stdout}`);
    }
  } finally {
    cleanup();
  }
});

test('hook: full text first, short text after, in one session; a new session gets the full text again', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const run = (sid) => runHook('hooks/standing-rules.mjs', { session_id: sid, prompt: EVENT_PROMPTS['task notification'], cwd: dir }, { args: ET_ARGS });
    const first = ctxOf(run('sess-ev-a'));
    assert.ok(first.includes(FULL_START));
    for (let n = 0; n < 2; n++) {
      const later = ctxOf(run('sess-ev-a'));
      assert.ok(later.includes(SHORT_START), later);
      assert.ok(!later.includes(FULL_START));
    }
    assert.ok(ctxOf(run('sess-ev-b')).includes(FULL_START), 'another session starts again with the full text');
  } finally {
    cleanup();
  }
});

test('hook: operator text beside a reminder, the keep-warm ping, plain text, empty and malformed input do not fire', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const silent = (payload, label) => {
      const res = runHook('hooks/standing-rules.mjs', payload, { args: ET_ARGS });
      assert.equal(res.status, 0, label);
      assert.ok(!ctxOf(res).includes('Event turn'), label);
    };
    silent({ session_id: 's1', prompt: `${EVENT_PROMPTS['system notification reminder']}\nand fix the typo`, cwd: dir }, 'operator text + reminder');
    silent({ session_id: 's2', prompt: '[ac-keep-warm] ping', cwd: dir }, 'keep-warm ping');
    silent({ session_id: 's3', prompt: 'hello', cwd: dir }, 'plain text');
    silent({ session_id: 's4', prompt: '', cwd: dir }, 'empty prompt');
    silent({ session_id: 's5', cwd: dir }, 'no prompt');
    silent({ session_id: 's6', prompt: 12345, cwd: dir }, 'non-string prompt');
    const noSid = runHook('hooks/standing-rules.mjs', { prompt: EVENT_PROMPTS['task notification'], cwd: dir }, { args: ET_ARGS });
    assert.equal(noSid.status, 0);
    assert.ok(ctxOf(noSid).includes(FULL_START), 'no session id: fires, with the full text every time');
    const garbage = runHook('hooks/standing-rules.mjs', undefined, { args: ET_ARGS });
    assert.equal(garbage.status, 0);
    assert.equal(garbage.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('hook: a subagent never gets the event-turn rule', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-ev-sub', agent_id: 'agent-1', agent_type: 'worker', prompt: EVENT_PROMPTS['task notification'], cwd: dir },
      { args: ET_ARGS });
    assert.equal(res.status, 0);
    assert.ok(!ctxOf(res).includes('Event turn'), res.stdout);
    assert.deepEqual(matchRules({ scope: 'event-turn', text: EVENT_PROMPTS['task notification'], subagent: true }), []);
  } finally {
    cleanup();
  }
});

test('hook: event-turn-quiet can be disabled by id', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'event-turn-quiet', enabled: false }]));
    const res = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-ev-off', prompt: EVENT_PROMPTS['task notification'], cwd: dir }, { args: ET_ARGS });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  } finally {
    cleanup();
  }
});

test('a user-written event-turn rule fires on an event turn (no when needed), and not on a typed prompt', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 'event-turn-quiet', enabled: false },
      { id: 'my-event-note', scope: 'event-turn', then: 'Sample event note.' },
      { id: 'my-event-twice', scope: 'event-turn', then: 'First note.', thenLater: 'Later note.' },
    ]));
    const run = (prompt) => ctxOf(runHook('hooks/standing-rules.mjs', { session_id: 'sess-ev-user', prompt, cwd: dir }, { args: ET_ARGS }));
    const a = run(EVENT_PROMPTS['cross-session message']);
    assert.ok(a.includes('Sample event note.') && a.includes('First note.') && !a.includes('Later note.'), a);
    const b = run(EVENT_PROMPTS['cross-session message']);
    assert.ok(b.includes('Sample event note.') && b.includes('Later note.') && !b.includes('First note.'), b);
    assert.equal(run('fix the login bug'), '');
  } finally {
    cleanup();
  }
});

test('pickEventTurnText: no session id keeps the full text', () => {
  const { cleanup } = makeFixture();
  try {
    const rules = [{ id: 'r', then: 'full', thenLater: 'short' }];
    assert.equal(pickEventTurnText(rules, undefined)[0].then, 'full');
    assert.equal(pickEventTurnText(rules, undefined)[0].then, 'full');
  } finally {
    cleanup();
  }
});

test('rules.mjs test --scope event-turn simulates an event turn and says why a text is not one', () => {
  const { cleanup } = makeFixture();
  try {
    const hit = runScript('scripts/rules.mjs', ['test', EVENT_PROMPTS['CI monitor event'], '--scope', 'event-turn']);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /MATCH\s+event-turn-quiet/);
    assert.ok(hit.stdout.includes(FULL_START));
    const miss = runScript('scripts/rules.mjs', ['test', 'fix the login bug', '--scope', 'event-turn']);
    assert.equal(miss.status, 0, miss.stderr);
    assert.match(miss.stdout, /NOT an event turn/);
    assert.match(miss.stdout, /not an event turn\s+event-turn-quiet/);
  } finally {
    cleanup();
  }
});

test('rules.mjs add --scope event-turn needs no --when and the rule shows in list', () => {
  const { cleanup } = makeFixture();
  try {
    const add = runScript('scripts/rules.mjs', ['add', '--id', 'sample-event-rule', '--scope', 'event-turn', '--then', 'Sample.']);
    assert.equal(add.status, 0, add.stderr);
    const list = runScript('scripts/rules.mjs', ['list']);
    assert.match(list.stdout, /sample-event-rule\s+scope=event-turn/);
    assert.match(list.stdout, /event-turn-quiet\s+scope=event-turn/);
  } finally {
    cleanup();
  }
});

// --- review round 0.31.51: an operator's own turn is never an event turn ------------------------------------------

import { existsSync, readdirSync } from 'node:fs';
import { markEventTurnTold } from '../hooks/lib/rules.mjs';

const TN_BLOCK = '<task-notification>\n<summary>Worker "sample" completed</summary>\n</task-notification>';
const markerCount = (stateDir) => {
  const d = join(stateDir, 'state', 'event-turn-told');
  return existsSync(d) ? readdirSync(d).length : 0;
};

test('isEventTurn: an unterminated or malformed wrapper tag swallows nothing; what follows it is operator text', () => {
  const asked = '<task-notification>\nwhy did this show up in my chat?';
  assert.equal(isEventTurn(asked), false, 'the reproduced input: an opening tag never closed, then a typed question');
  assert.equal(isEventTurn('<task-notification>\nsome truncated log line'), false);
  assert.equal(isEventTurn('please look at this <task-notification> thing, what is it?'), false, 'an unclosed tag in the middle of typed text');
  assert.equal(isEventTurn(`${TN_BLOCK}\nwhat was that?`), false, 'a closed block followed by typed text');
  assert.equal(isEventTurn(`what was that?\n${TN_BLOCK}`), false, 'typed text followed by a closed block');
  assert.equal(isEventTurn(`${TN_BLOCK}\n<task-notification>\nand why?`), false, 'a closed block, then an unclosed tag with typed text');
  assert.equal(isEventTurn('<task-notification>x</task-notification></task-notification> why?'), false, 'a stray closing tag does not hide text');
});

test('isEventTurn: complete blocks still count, with attributes, in a row and with surrounding whitespace', () => {
  assert.equal(isEventTurn(`${TN_BLOCK}\n${TN_BLOCK}`), true, 'two closed blocks');
  assert.equal(isEventTurn('<task-notification id="w1" kind="x">\ndone\n</task-notification>'), true, 'a block with attributes');
  assert.equal(isEventTurn(`  \n\t${TN_BLOCK}  \n\n`), true, 'leading and trailing whitespace');
  assert.equal(isEventTurn(`<cross-session-message from="peer-a">hi</cross-session-message>\n${TN_BLOCK}`), true, 'two different kinds');
  assert.equal(isEventTurn('[SYSTEM NOTIFICATION - NOT USER INPUT]'), true, 'the automated banner line alone');
  assert.equal(isEventTurn(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${TN_BLOCK}`), true, 'the banner line beside a complete block');
  assert.equal(isEventTurn('[SYSTEM NOTIFICATION - NOT USER INPUT] and please fix the typo'), false, 'the banner text with typed words on its line');
});

test('user-prompt rules keep the swallow-to-end for an unclosed wrapper (a truncated message that says "prompt" stays silent)', () => {
  assert.equal(userOwnText('<cross-session-message from="x">unterminated message that says prompt').trim(), '');
  assert.match(userOwnText('<task-notification>\nwhy did this show up in my chat?', { strict: true }), /why did this show up/);
});

test('hook: the reproduced input is silent; a real event turn still gets the full text', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const typed = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-et-typed', prompt: '<task-notification>\nwhy did this show up in my chat?', cwd: dir }, { args: ET_ARGS });
    assert.equal(typed.status, 0);
    assert.ok(!ctxOf(typed).includes('Event turn'), typed.stdout);
    const real = runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-et-real', prompt: EVENT_PROMPTS['task notification'], cwd: dir }, { args: ET_ARGS });
    assert.ok(ctxOf(real).includes(FULL_START), real.stdout);
  } finally {
    cleanup();
  }
});

test('the told-marker is written only when the full text was injected (not when the character cap dropped it)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const run = (env) => runHook('hooks/standing-rules.mjs',
      { session_id: 'sess-et-cap', prompt: EVENT_PROMPTS['task notification'], cwd: dir }, { args: ET_ARGS, env });
    const capped = run({ CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '300' });
    assert.equal(capped.status, 0);
    assert.match(ctxOf(capped), /dropped: over the 300-char limit: event-turn-quiet/);
    assert.ok(!ctxOf(capped).includes(FULL_START));
    assert.equal(markerCount(stateDir), 0, 'a dropped text leaves no marker');
    const again = run({});
    assert.ok(ctxOf(again).includes(FULL_START), 'the full text is offered again once the cap allows it');
    assert.equal(markerCount(stateDir), 1);
    assert.ok(ctxOf(run({})).includes(SHORT_START), 'and the short text after that');
  } finally {
    cleanup();
  }
});

test('marker names come from a hash of the ids: ids that sanitise to the same string keep separate markers', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    const rules = [{ id: 'r', then: 'full text', thenLater: 'short text' }];
    const deliver = (sid) => {
      const picked = pickEventTurnText(rules, sid);
      markEventTurnTold(picked, sid, '\n\n[agent-companion: standing rules]\n- full text');
      return picked[0].then;
    };
    assert.equal(deliver('a/b'), 'full text');
    assert.equal(deliver('a_b'), 'full text', 'a different id that sanitises to the same string is a new session');
    assert.equal(deliver('a/b'), 'short text');
    assert.equal(deliver('a_b'), 'short text');
    assert.equal(markerCount(stateDir), 2);
    for (const f of readdirSync(join(stateDir, 'state', 'event-turn-told'))) assert.match(f, /^[0-9a-f]{32}-[0-9a-f]{32}\.seen$/);
  } finally {
    cleanup();
  }
});

test('rules.mjs add --then-later (and --then-later-file) sets the later text of an event-turn rule, and show prints it', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const add = runScript('scripts/rules.mjs', ['add', '--id', 'sample-twice', '--scope', 'event-turn', '--then', 'First note.', '--then-later', 'Later note.']);
    assert.equal(add.status, 0, add.stderr);
    const show = runScript('scripts/rules.mjs', ['show', 'sample-twice']);
    assert.equal(JSON.parse(show.stdout).thenLater, 'Later note.');
    const file = join(dir, 'later.txt');
    writeFileSync(file, 'Later note from a file.\n');
    const add2 = runScript('scripts/rules.mjs', ['add', '--id', 'sample-file', '--scope', 'event-turn', '--then', 'First.', '--then-later-file', file]);
    assert.equal(add2.status, 0, add2.stderr);
    assert.equal(JSON.parse(runScript('scripts/rules.mjs', ['show', 'sample-file']).stdout).thenLater, 'Later note from a file.');
    const bad = runScript('scripts/rules.mjs', ['add', '--id', 'sample-bad', '--scope', 'always', '--then', 'x', '--then-later', 'y']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /event-turn/);
    const run = (sid) => ctxOf(runHook('hooks/standing-rules.mjs',
      { session_id: sid, prompt: EVENT_PROMPTS['cross-session message'], cwd: dir }, { args: ET_ARGS }));
    assert.ok(run('sess-add-later').includes('First note.'));
    assert.ok(run('sess-add-later').includes('Later note.'));
  } finally {
    cleanup();
  }
});

// ---- 0.31.57: the shipped knowledge check (by task type), the session-start budget and its overflow warning ------------
import {
  KC_MARKER, KC_DEFAULT_TYPES, KC_LEAD_NOTICE, holdKnowledgeNotice, mergeKnowledgeNotice, knowledgeDecision, buildKnowledgeClause, knowledgeClause, hasFreshKnowledgeLine, localDate,
} from '../hooks/lib/knowledge-check.mjs';
import {
  KNOWLEDGE_HOWTO_WHEN, SUPERSEDED_USER_RULE_IDS, sessionStartBudget, sessionStartOverflow, BUDGET_AUDIENCES,
} from '../hooks/lib/rules.mjs';

import { readFileSync as kcReadFile } from 'node:fs';
import { fileURLToPath as kcFileURL } from 'node:url';
const KC_PLUGIN_ROOT = kcFileURL(new URL('..', import.meta.url));
const KC_NOW = new Date(2026, 10, 16, 12, 0, 0); // local noon, 2026-11-16
const KC_TYPES_OFF = ['research', 'lookup', 'explore', 'survey', 'operate', 'mechanical-edit', 'verify', 'docs', 'code-review'];

test('A1: every default builder type gets the clause; no other type, no reviewer and no TYPE does', () => {
  const { cleanup } = makeFixture();
  try {
    assert.equal(KC_DEFAULT_TYPES.length, 8);
    for (const t of KC_DEFAULT_TYPES) assert.equal(knowledgeDecision({ type: t, role: 'writer', brief: 'b', now: KC_NOW }), 'clause', t);
    for (const t of KC_TYPES_OFF) assert.equal(knowledgeDecision({ type: t, role: 'writer', brief: 'b', now: KC_NOW }), null, t);
    assert.equal(knowledgeDecision({ type: null, role: 'writer', brief: 'b', now: KC_NOW }), null, 'no TYPE');
    assert.equal(knowledgeDecision({ type: 'critical-change', role: 'reviewer', brief: 'b', now: KC_NOW }), null, 'a reviewer');
    assert.equal(knowledgeDecision({ type: 'Bounded-Feature', role: null, brief: 'b', now: KC_NOW }), 'clause', 'case is ignored');
  } finally { cleanup(); }
});

test('A1: the clause is short, dated, and carries each instruction', () => {
  const c = knowledgeClause(KC_NOW);
  assert.ok(c.length <= 350, `clause is ${c.length} chars`);
  assert.ok(c.startsWith(KC_MARKER));
  assert.match(c, /Before your first edit/);
  assert.match(c, /ONE WebSearch \(or WebFetch of the official docs or changelog\)/);
  assert.match(c, /"Knowledge check 2026-11-16: confirmed" or "changed: <what>"/);
  assert.match(c, /contradicts the brief, stop and report\./);
  assert.match(c, /"Knowledge check: none needed \(<why>\)"/);
  assert.equal(buildKnowledgeClause({ type: 'integration', brief: 'b', now: KC_NOW }), `\n\n${c}`);
});

test('A2: a "Knowledge check YYYY-MM-DD:" line dated today or yesterday is reused; older, future-less, quoted or fenced ones are not', () => {
  const { cleanup } = makeFixture();
  try {
    const d = (brief) => knowledgeDecision({ type: 'bounded-feature', role: 'writer', brief, now: KC_NOW });
    assert.equal(d('TYPE: bounded-feature\nKnowledge check 2026-11-16: confirmed (docs say X).\nBuild it.'), 'reused', 'today');
    assert.equal(d('TYPE: bounded-feature\nKnowledge check 2026-11-15: changed: the flag moved.\nBuild it.'), 'reused', 'yesterday');
    assert.equal(d('- **Knowledge check 2026-11-16:** confirmed\nBuild it.'), 'reused', 'bullet and bold');
    assert.equal(d('knowledge check 2026-11-16: confirmed'), 'reused', 'case');
    assert.equal(d('Knowledge check 2026-11-14: confirmed'), 'clause', 'two days old');
    assert.equal(d('Knowledge check 2026-11-17: confirmed'), 'clause', 'tomorrow is not today or yesterday');
    assert.equal(d('Knowledge check: confirmed'), 'clause', 'no date');
    assert.equal(d('> Knowledge check 2026-11-16: confirmed'), 'clause', 'a quoted line');
    assert.equal(d('```\nKnowledge check 2026-11-16: confirmed\n```'), 'clause', 'a fenced line');
    assert.equal(d('Note: Knowledge check 2026-11-16: confirmed'), 'clause', 'not at the start of a line');
    assert.equal(hasFreshKnowledgeLine('Knowledge check 2026-11-16: x', KC_NOW), true);
    // month and year edges of "yesterday"
    assert.equal(hasFreshKnowledgeLine('Knowledge check 2026-02-28: x', new Date(2026, 2, 1, 9)), true);
    assert.equal(hasFreshKnowledgeLine('Knowledge check 2025-12-31: x', new Date(2026, 0, 1, 9)), true);
  } finally { cleanup(); }
});

test('A6: knowledge_check off removes the clause; knowledge_check_types narrows or widens the list', () => {
  const { cleanup } = makeFixture();
  try {
    withEnv({ CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK: '0' }, () => {
      assert.equal(knowledgeDecision({ type: 'bounded-feature', role: 'writer', brief: 'b', now: KC_NOW }), null);
    });
    withEnv({ CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK_TYPES: 'research, integration' }, () => {
      assert.equal(knowledgeDecision({ type: 'research', role: 'other', brief: 'b', now: KC_NOW }), 'clause');
      assert.equal(knowledgeDecision({ type: 'integration', role: 'writer', brief: 'b', now: KC_NOW }), 'clause');
      assert.equal(knowledgeDecision({ type: 'bounded-feature', role: 'writer', brief: 'b', now: KC_NOW }), null);
    });
    withEnv({ CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK_TYPES: '' }, () => {
      assert.equal(knowledgeDecision({ type: 'bounded-feature', role: 'writer', brief: 'b', now: KC_NOW }), 'clause', 'empty reads as the default list');
    });
  } finally { cleanup(); }
});

const kcSpawn = (dir, prompt, { sid = 'sess-kc-1', env = {}, extra = {} } = {}) => runHook('hooks/spawn-guard.mjs', {
  session_id: sid, agent_type: 'main', cwd: dir, ...extra,
  tool_input: { subagent_type: 'agent-companion:ac-sonnet-low', model: 'sonnet', description: 'x', prompt },
}, { env });
const kcPrompt = (res) => String(res.json?.hookSpecificOutput?.updatedInput?.prompt || '');
const kcCtx = (res) => String(res.json?.hookSpecificOutput?.additionalContext || '');

test('A1+A4: a bounded-feature spawn gets the clause and the lead notice, the notice once per session', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const a = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the flag');
    assert.equal(a.status, 0, a.stderr);
    assert.ok(kcPrompt(a).includes(KC_MARKER), kcPrompt(a));
    assert.ok(kcPrompt(a).includes(`Knowledge check ${localDate()}: confirmed`));
    assert.ok(kcCtx(a).includes(KC_LEAD_NOTICE), `notice missing: ${a.stdout}`);
    const b = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd another flag');
    assert.ok(kcPrompt(b).includes(KC_MARKER), 'the second spawn still gets the clause');
    assert.ok(!kcCtx(b).includes(KC_LEAD_NOTICE), 'the notice goes once per session');
    const c = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nthird', { sid: 'sess-kc-2' });
    assert.ok(kcCtx(c).includes(KC_LEAD_NOTICE), 'a new session is told again');
  } finally { cleanup(); }
});

test('A2: a brief with "Knowledge check <today>:" gets neither the clause nor the notice', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = kcSpawn(dir, `TYPE: bounded-feature\nROLE: writer\nKnowledge check ${localDate()}: confirmed, the docs agree.\nadd the flag`);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!kcPrompt(res).includes(KC_MARKER));
    assert.ok(!kcCtx(res).includes(KC_LEAD_NOTICE));
    // and it did not use up the session's notice: the next spawn without the line still gets it
    const next = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the other flag');
    assert.ok(kcCtx(next).includes(KC_LEAD_NOTICE));
  } finally { cleanup(); }
});

test('A3: TYPE research, operate, code-review and a brief with no TYPE get nothing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const prompt of ['TYPE: research\nROLE: lookup\nfind the flag', 'TYPE: operate\nROLE: operate\nrun it', 'TYPE: code-review\nROLE: reviewer\nreview it', 'just fix it']) {
      const res = kcSpawn(dir, prompt);
      assert.equal(res.status, 0, `${prompt}: ${res.stderr}`);
      assert.ok(!kcPrompt(res).includes(KC_MARKER), prompt);
      assert.ok(!kcCtx(res).includes(KC_LEAD_NOTICE), prompt);
    }
  } finally { cleanup(); }
});

test('A4: a worker that spawns a builder gets the clause for it but the lead notice is not sent to a worker', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the flag', { sid: 'sess-kc-3', extra: { agent_id: 'worker-1', agent_type: 'agent-companion:ac-sonnet-high' } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(kcPrompt(res).includes(KC_MARKER));
    assert.ok(!kcCtx(res).includes(KC_LEAD_NOTICE));
  } finally { cleanup(); }
});

test('A6: knowledge_check off at the spawn guard: no clause, no notice', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the flag', { env: { CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK: '0' } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!kcPrompt(res).includes(KC_MARKER));
    assert.ok(!kcCtx(res).includes(KC_LEAD_NOTICE));
  } finally { cleanup(); }
});

// 0.31.58: the live miss. A brief that only MENTIONS the marker (a verification brief that asks the worker to look for the
// block) was read as "already appended" and got no clause. Payload shape and entry point as hooks.json runs them: stdin
// JSON, no CLAUDE_PLUGIN_OPTION_* env, a lead (no agent_id).
test('A7: a brief that quotes the marker still gets the clause and the lead notice; a brief that carries the block does not get a second one', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const verify = `TYPE: bounded-feature-small\nROLE: other\n\nRead your brief and reply CLAUSE: yes|no (yes if it contains a block starting "${KC_MARKER}").`;
    const a = kcSpawn(dir, verify, { sid: 'sess-kc-quote' });
    assert.equal(a.status, 0, a.stderr);
    assert.ok(kcPrompt(a).includes(`\n\n${knowledgeClause()}`), `clause missing: ${kcPrompt(a)}`);
    assert.ok(kcCtx(a).includes(KC_LEAD_NOTICE), `notice missing: ${a.stdout}`);
    const b = kcSpawn(dir, verify, { sid: 'sess-kc-quote' });
    assert.ok(kcPrompt(b).includes(`\n\n${knowledgeClause()}`), 'the second spawn still gets the clause');
    assert.ok(!kcCtx(b).includes(KC_LEAD_NOTICE), 'the notice goes once per session');
    // a re-spawned brief that already ends in the appended block
    const again = kcSpawn(dir, `TYPE: bounded-feature-small\nROLE: other\nbuild it\n\n${knowledgeClause()}`, { sid: 'sess-kc-quote-2' });
    assert.equal(kcPrompt(again).split(KC_MARKER).length - 1, 1, 'one block, not two');
    // the dated line and a research type, same entry point
    const dated = kcSpawn(dir, `TYPE: bounded-feature-small\nROLE: other\nKnowledge check ${localDate()}: confirmed.\nbuild it`, { sid: 'sess-kc-quote-3' });
    assert.ok(!kcPrompt(dated).includes(KC_MARKER) && !kcCtx(dated).includes(KC_LEAD_NOTICE));
    const research = kcSpawn(dir, 'TYPE: research\nROLE: lookup\nfind it', { sid: 'sess-kc-quote-3' });
    assert.ok(!kcPrompt(research).includes(KC_MARKER) && !kcCtx(research).includes(KC_LEAD_NOTICE));
  } finally { cleanup(); }
});

test('A8: the carried block is read like a declaration (CRLF counts, a fence or comment does not)', () => {
  const { cleanup } = makeFixture();
  try {
    const d = (brief) => knowledgeDecision({ type: 'bounded-feature', role: 'writer', brief, now: KC_NOW });
    const block = knowledgeClause(KC_NOW);
    assert.equal(d(`build it\r\n\r\n${block}`), null, 'a CRLF brief that carries the block');
    assert.equal(d(`build it\n\n\`\`\`\n${block}\n\`\`\``), 'clause', 'a fenced copy is a quote');
    assert.equal(d(`build it\n<!--\n${block}\n-->`), 'clause', 'a commented copy is a quote');
  } finally { cleanup(); }
});

const HOWTO_HITS = [
  'how do I set up the Gmail connector', 'How to configure the proxy for npm', 'give me the steps to install node',
  'walk me through enabling 2FA', 'what are the instructions for setting up SSO', 'how can we deploy this to Firebase',
  'how should I connect the desktop app to the bus', 'step by step to upgrade the plugin', 'how do you set up the proxy',
];
const HOWTO_MISSES = [
  'how does the hook work', 'how long did the install take', 'install the plugin and run the tests', 'set up a worktree and fix the bug',
  'how do I know the installer worked', 'the steps below failed', 'how did you configure it', 'how do I read the log',
  'a guide to the codebase', 'how to read this config file', 'walk me through the diff', 'explain it step by step', 'why did the deploy fail', 'how do I know the install worked', 'how should we handle the deploy failing', 'how do I tell if the upgrade worked',
];

test('A5: knowledge-check-howto fires on a request for setup steps and not on near-misses', () => {
  const { cleanup } = makeFixture();
  try {
    assert.ok(KNOWLEDGE_HOWTO_WHEN.length <= 400, `when is ${KNOWLEDGE_HOWTO_WHEN.length} chars; the cap is 400`);
    const rule = readRules().rules.find((r) => r.id === 'knowledge-check-howto');
    assert.ok(rule && rule.builtin && rule.audience === 'lead' && rule.scope === 'user-prompt' && rule.enabled, 'built-in, lead, user-prompt, on');
    const fires = (t) => matchRules({ scope: 'user-prompt', text: t, sessionId: 's' }).some((r) => r.id === 'knowledge-check-howto');
    for (const t of HOWTO_HITS) assert.ok(fires(t), `should fire: ${t}`);
    for (const t of HOWTO_MISSES) assert.ok(!fires(t), `should not fire: ${t}`);
    // the injected text asks for the docs and the date
    const text = renderRules(matchRules({ scope: 'user-prompt', text: HOWTO_HITS[0], sessionId: 's' }));
    assert.match(text, /current official docs/);
    assert.match(text, /say the date you checked/);
  } finally { cleanup(); }
});

test('A5: the how-to rule is gated by knowledge_check and works through the prompt hook', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const on = runHook('hooks/standing-rules.mjs', { session_id: 'sess-howto', prompt: 'how do I set up the proxy', cwd: dir }, { args: ['--event', 'user-prompt'] });
    assert.match(on.json?.hookSpecificOutput?.additionalContext || '', /current official docs/);
    const quiet = runHook('hooks/standing-rules.mjs', { session_id: 'sess-howto', prompt: 'how does the proxy work', cwd: dir }, { args: ['--event', 'user-prompt'] });
    assert.equal((quiet.stdout || '').trim(), '', 'a near-miss is silent');
    const off = runHook('hooks/standing-rules.mjs', { session_id: 'sess-howto', prompt: 'how do I set up the proxy', cwd: dir },
      { args: ['--event', 'user-prompt'], env: { CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK: '0' } });
    assert.equal((off.stdout || '').trim(), '', 'knowledge_check off: no how-to rule');
  } finally { cleanup(); }
});

test('A7: no knowledge check rule is a session-start rule (it was the overflow victim)', () => {
  const { cleanup } = makeFixture();
  try {
    const startRules = defaultRules().filter((r) => r.scope === 'session-start');
    assert.ok(startRules.length > 0);
    for (const r of startRules) {
      assert.doesNotMatch(r.id, /knowledge/);
      assert.doesNotMatch(r.then, /knowledge check/i);
    }
    assert.equal(defaultRules().some((r) => r.id === 'knowledge-check-spawn' || r.id === 'knowledge-check-session'), false);
  } finally { cleanup(); }
});

const KC_OLD_RULES = [
  { id: 'knowledge-check-spawn', enabled: true, scope: 'spawn', when: '.', then: 'KNOWLEDGE CHECK (old spawn rule): run ONE quick WebSearch.' },
  { id: 'knowledge-check-session', enabled: true, scope: 'session-start', then: 'KNOWLEDGE CHECK (old session rule): look it up.' },
];

test('A8: the two hand-written rule ids are ignored while the shipped check is on, so nothing is doubled', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.deepEqual(SUPERSEDED_USER_RULE_IDS, ['knowledge-check-spawn', 'knowledge-check-session']);
    writeFileSync(rulesPath(), JSON.stringify({ version: 1, rules: [...KC_OLD_RULES, { id: 'my-own-spawn-rule', scope: 'spawn', when: '.', then: 'OWN SPAWN RULE.' }] }));
    const spawnIds = matchRules({ scope: 'spawn', text: 'TYPE: bounded-feature', sessionId: 's' }).map((r) => r.id);
    assert.ok(!spawnIds.includes('knowledge-check-spawn'));
    assert.ok(spawnIds.includes('my-own-spawn-rule'), 'another user rule is untouched');
    assert.ok(!matchRules({ scope: 'session-start', sessionId: 's' }).some((r) => r.id === 'knowledge-check-session'));
    // the spawn brief carries one clause and not the old text
    const res = kcSpawn(dir, 'TYPE: bounded-feature\nROLE: writer\nadd the flag');
    assert.ok(kcPrompt(res).includes(KC_MARKER));
    assert.ok(!kcPrompt(res).includes('old spawn rule'));
    assert.ok(kcPrompt(res).includes('OWN SPAWN RULE.'));
    // the session-start block does not carry the old text either
    const start = runHook('hooks/standing-rules.mjs', { session_id: 'sess-kc-start', cwd: dir }, { args: ['--event', 'session-start'] });
    assert.ok(!(start.json?.hookSpecificOutput?.additionalContext || '').includes('old session rule'));
    // `rules list` shows them as superseded
    const list = runScript('scripts/rules.mjs', ['list']);
    assert.match(list.stdout, /off\s+knowledge-check-spawn[^\n]*superseded by the built-in knowledge check/);
    assert.match(list.stdout, /off\s+knowledge-check-session[^\n]*superseded/);
    assert.doesNotMatch(list.stdout, /my-own-spawn-rule[^\n]*superseded/);
    // knowledge_check off: they work as written again
    withEnv({ CLAUDE_PLUGIN_OPTION_KNOWLEDGE_CHECK: '0' }, () => {
      assert.ok(matchRules({ scope: 'spawn', text: 'x', sessionId: 's' }).some((r) => r.id === 'knowledge-check-spawn'));
      assert.ok(matchRules({ scope: 'session-start', sessionId: 's' }).some((r) => r.id === 'knowledge-check-session'));
    });
    // and a built-in id still merges as before (lead-effort-check is the pattern this follows)
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'lead-effort-check', enabled: true }]));
    assert.ok(matchRules({ scope: 'session-start', sessionId: 's' }).some((r) => r.id === 'lead-effort-check'));
  } finally { cleanup(); }
});

test('C: with every default built-in on (effort check too), the worst-case lead block leaves headroom under 4000', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([{ id: 'lead-effort-check', enabled: true }]));
    // 3000 is the shipped plugin.json default, 4000 the output cap the brief names.
    for (const cap of ['3000', '4000']) {
      withEnv({ CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: cap }, () => {
        for (const a of BUDGET_AUDIENCES) {
          const b = sessionStartBudget(a);
          assert.equal(b.dropped.length, 0, `${a} drops ${b.dropped} at ${cap}`);
          assert.equal(b.cap, Number(cap));
          assert.ok(b.headroom >= Number(cap) - 2400, `${a}: ${b.wanted} of ${cap} chars leaves ${b.headroom} for the operator's own rules`);
        }
      });
    }
    withEnv({ CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '4000' }, () => {
      assert.deepEqual(BUDGET_AUDIENCES, ['lead', 'lead-child', 'subagent']);
      assert.ok(sessionStartBudget('lead-child').wanted > sessionStartBudget('lead').wanted, 'the child-session rule only counts for a child');
      assert.ok(sessionStartBudget('subagent').wanted < sessionStartBudget('lead').wanted, 'lead-only rules stay out of a worker');
      assert.deepEqual(sessionStartOverflow(), []);
    });
  } finally { cleanup(); }
});

const BIG_RULE = { id: 'big-user-rule', enabled: true, scope: 'session-start', then: `B${'x'.repeat(2399)}` };

test('B1: sessionStartBudget names the dropped rule for a lead and not for a worker that has room', () => {
  const { cleanup } = makeFixture();
  try {
    writeFileSync(rulesPath(), JSON.stringify([BIG_RULE]));
    withEnv({ CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '4200' }, () => {
      const lead = sessionStartBudget('lead');
      assert.deepEqual(lead.dropped, [], 'the lead block still fits at 4200 here');
      writeFileSync(rulesPath(), JSON.stringify([BIG_RULE, { id: 'big-two', scope: 'session-start', then: `C${'y'.repeat(900)}` }]));
      const over = sessionStartBudget('lead');
      assert.deepEqual(over.dropped, ['big-two']);
      assert.ok(over.wanted > over.cap);
      assert.ok(over.rules.find((r) => r.id === 'big-user-rule').chars > 2400);
      assert.deepEqual(sessionStartBudget('subagent').dropped, [], 'a worker has fewer rules, so it fits');
      assert.deepEqual(sessionStartOverflow().map((b) => b.audience), ['lead', 'lead-child']);
    });
  } finally { cleanup(); }
});

test('B1: rules.mjs add, enable and disable warn about a dropped rule after the edit and never refuse it', () => {
  const { cleanup } = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '4200' };
    const fill = runScript('scripts/rules.mjs', ['add', '--id', 'fill-one', '--scope', 'session-start', '--then', `F${'x'.repeat(2399)}`], { env });
    assert.equal(fill.status, 0, fill.stderr);
    assert.doesNotMatch(fill.stderr, /WARNING/, 'still fits: no warning');
    // Well over the line, not just past it: the pr-wait-hint rule embeds the plugin's own path, so the lead block is a few
    // dozen characters shorter on CI (a short checkout path) than in a long local one, and 800 fit there.
    const add = runScript('scripts/rules.mjs', ['add', '--id', 'fill-two', '--scope', 'session-start', '--then', `G${'y'.repeat(1100)}`], { env });
    assert.equal(add.status, 0, 'the edit is not refused');
    assert.match(add.stdout, /added "fill-two"/);
    assert.match(add.stderr, /WARNING: the session-start block is over its budget/);
    assert.match(add.stderr, /lead: 1 rule would drop \(fill-two\); the block needs \d+ chars, the cap is 4200/);
    assert.match(add.stderr, /lead-child: /);
    assert.doesNotMatch(add.stderr, /subagent: /, 'the worker block still fits');
    assert.match(add.stderr, /shorten a rule and keep its long form in a spec or doc file[^\n]*raise the standing_rules_max_chars option/);
    assert.ok(readRules().rules.some((r) => r.id === 'fill-two'), 'the rule was written');
    const off = runScript('scripts/rules.mjs', ['disable', 'fill-two'], { env });
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stderr, /WARNING/, 'disabling the rule clears the overflow');
    const on = runScript('scripts/rules.mjs', ['enable', 'fill-two'], { env });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /WARNING[\s\S]*fill-two/);
    const raised = runScript('scripts/rules.mjs', ['enable', 'fill-two'], { env: { ...env, CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '6000' } });
    assert.doesNotMatch(raised.stderr, /WARNING/, 'a raised cap fits it');
  } finally { cleanup(); }
});

test('B1: rules.mjs budget prints both audiences with each rule\'s length, and a dropped rule; --json parses', () => {
  const { cleanup } = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '4200' };
    let r = runScript('scripts/rules.mjs', ['budget'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^lead: used \d+ \/ cap 4200, headroom \d+$/m);
    assert.match(r.stdout, /^subagent \(a worker that compacts\): used \d+ \/ cap 4200, headroom \d+$/m);
    assert.match(r.stdout, /^\s+\d+\s+delegate-first$/m);
    const before = readRules().rules.length;
    writeFileSync(rulesPath(), JSON.stringify([BIG_RULE, { id: 'big-two', scope: 'session-start', then: `C${'y'.repeat(900)}` }]));
    r = runScript('scripts/rules.mjs', ['budget'], { env });
    assert.match(r.stdout, /big-two\s+\(DROPPED\)/);
    assert.match(r.stdout, /OVER by \d+/);
    const j = runScript('scripts/rules.mjs', ['budget', '--json'], { env });
    const parsed = JSON.parse(j.stdout);
    assert.deepEqual(parsed.audiences.map((a) => a.audience), ['lead', 'lead-child', 'subagent']);
    assert.deepEqual(parsed.audiences[0].dropped, ['big-two']);
    assert.equal(readRules().rules.length, before + 2, 'budget wrote nothing');
  } finally { cleanup(); }
});

test('B2: the scout raises standing_rules_overflow when the config drops a rule, and only then', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const run = (env) => {
      const res = runScript('scripts/detect.mjs', [], { cwd: dir, env, timeout: 90000 });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(res.json, 'detect prints JSON');
      return (res.json.signals || []).filter((s) => s.kind === 'standing_rules_overflow');
    };
    const env = { CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '4200' };
    assert.equal(run(env).length, 0, 'the shipped rules fit');
    writeFileSync(rulesPath(), JSON.stringify([BIG_RULE, { id: 'big-two', scope: 'session-start', then: `C${'y'.repeat(900)}` }]));
    const hit = run(env);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].dispatch, 'manual-check');
    assert.match(hit[0].detail, /lead: 1 rule would drop \(big-two\)/);
    assert.match(hit[0].detail, /the cap is 4200/);
    assert.match(hit[0].detail, /rules\.mjs budget/);
    assert.equal(run({ CLAUDE_PLUGIN_OPTION_STANDING_RULES_MAX_CHARS: '6000' }).length, 0, 'a raised cap clears it');
    // the kind is documented in the routine and the skill, and has a stale-signal guide

    for (const f of [['routines', 'calibration-scout-daily.md'], ['skills', 'calibration-scout', 'SKILL.md']]) {
      assert.match(kcReadFile(join(KC_PLUGIN_ROOT, ...f), 'utf8'), /standing_rules_overflow/);
    }
  } finally { cleanup(); }
});

test('A4: a denied or held spawn does not use up the lead notice; a worker caller and a canary never get it', () => {
  const { stateDir, cleanup } = makeFixture();
  try {
    // held, then the spawn is denied: a denied spawn never reaches allowWith, so no merge runs and no marker is written
    holdKnowledgeNotice({ sid: 'sess-denied', subagentCaller: false, isCanary: false });
    assert.equal(existsSync(join(stateDir, 'knowledge-check-notice')), false, 'a hold alone claims nothing');
    holdKnowledgeNotice({ sid: 'sess-denied', subagentCaller: false, isCanary: false });
    assert.ok(mergeKnowledgeNotice('ctx').includes(KC_LEAD_NOTICE), 'the next allowed spawn still gets it');
    holdKnowledgeNotice({ sid: 'sess-denied', subagentCaller: false, isCanary: false });
    assert.equal(mergeKnowledgeNotice('ctx'), 'ctx', 'and only once');
    assert.equal(mergeKnowledgeNotice('ctx'), 'ctx', 'a merge with nothing held is a no-op');
    holdKnowledgeNotice({ sid: 'sess-worker', subagentCaller: true, isCanary: false });
    assert.equal(mergeKnowledgeNotice('ctx'), 'ctx');
    holdKnowledgeNotice({ sid: 'sess-canary', subagentCaller: false, isCanary: true });
    assert.equal(mergeKnowledgeNotice('ctx'), 'ctx');
  } finally { cleanup(); }
});

test('A1: the read-only plan leg of a two-leg type gets no clause and does not use up the notice', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const plan = kcSpawn(dir, 'TYPE: novel-design\nROLE: plan\nplan the design, read-only');
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(!kcPrompt(plan).includes(KC_MARKER), 'plan leg: no clause');
    assert.ok(!kcCtx(plan).includes(KC_LEAD_NOTICE), 'plan leg: no notice');
    const write = kcSpawn(dir, 'TYPE: novel-design\nROLE: writer\nbuild the design');
    assert.ok(kcPrompt(write).includes(KC_MARKER), 'write leg: clause');
    assert.ok(kcCtx(write).includes(KC_LEAD_NOTICE), 'write leg: notice');
  } finally { cleanup(); }
});

test('A6: the plugin.json defaults for knowledge_check and knowledge_check_types match the code', () => {
  const manifest = JSON.parse(kcReadFile(join(KC_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const cfg = manifest.userConfig;
  assert.equal(cfg.knowledge_check.type, 'boolean');
  assert.equal(cfg.knowledge_check.default, true);
  assert.equal(cfg.knowledge_check_types.default, KC_DEFAULT_TYPES.join(','));
});
