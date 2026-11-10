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
      'agent-brevity', 'copyable-prompt', 'delegate-first', 'delegate-reminder', 'event-turn-quiet', 'lead-brevity', 'lead-effort-check', 'poll-guard-doctrine', 'pr-wait-hint', 'resume-doctrine', 'worker-one-wait', 'worker-one-wait-operate',
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
    assert.ok(total <= 1650, `built-in lead rules (without pr-wait-hint) take ${total} chars; the operator's own rules share the 3000-char cap`);
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
