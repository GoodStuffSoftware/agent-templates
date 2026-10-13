// Struggle detector (hooks/struggle-detector.mjs, hooks/lib/struggle.mjs).
// Every prompt below is synthetic. No operator text lives in this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import {
  scorePrompt, step, emptyState, loadUserPatterns, operatorMessage, leadMessage, liveEffort,
  WINDOW, COOLDOWN, MAX_FIRES,
} from '../hooks/lib/struggle.mjs';

const HOOK = 'hooks/struggle-detector.mjs';
const score = (t, o) => scorePrompt(t, o).n;

// --- pattern classes -------------------------------------------------------
test('strong correction scores 2', () => {
  for (const t of [
    'That is not true, the file exists.',
    "That's not what the plan said.",
    'I meant the second folder.',
    'You already approved this earlier.',
    'Why did you rename the helper?',
    'You just said the opposite.',
    'Do it yourself please.',
    "It doesn't have to be a new file.",
    'No, use the existing helper.',
    'We should not add a dependency.',
  ]) assert.equal(score(t), 2, t);
});

test('weak correction: one alone scores 1, two together score 1, strong plus weak stays 2', () => {
  assert.equal(score('Please make sure the output is sorted.'), 1);
  assert.equal(score('Make sure it is sorted, and use the other column instead.'), 1);
  assert.equal(score('That is not true, and make sure you read it.'), 2);
});

test('plain request scores 0', () => {
  assert.equal(score('Add a unit test for the parser module.'), 0);
});

test('repetition scores 2 against an earlier sentence of the session', () => {
  const first = scorePrompt('Rename the exported helper functions across the parser module.');
  assert.equal(first.n, 0);
  const again = scorePrompt('Please rename the exported helper functions across the parser module now.', { earlier: first.sentences });
  assert.equal(again.repeat, true);
  assert.equal(again.n, 2);
  const different = scorePrompt('Summarize the open pull requests for the release branch.', { earlier: first.sentences });
  assert.equal(different.repeat, false);
});

test('correction straight after the lead asked adds 1', () => {
  const asked = 'Should I merge it now?';
  assert.equal(score('Make sure the tests pass first.', { prevLead: asked }), 2);
  assert.equal(score('Make sure the tests pass first.', { prevLead: 'Done.' }), 1);
  assert.equal(score('Sounds good.', { prevLead: asked }), 0); // no correction signal, no bonus
});

test('tagged prompts are skipped, code blocks are ignored', () => {
  const s = scorePrompt('<task-notification>that is not true</task-notification>');
  assert.equal(s.skipped, true);
  assert.equal(score('Here is the log:\n```\nthat is not true\n```\nPlease summarize.'), 0);
});

test('user patterns add to the default set; bad entries are ignored', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.stateDir, 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'struggle-patterns.json'), JSON.stringify({ strong: ['\\bzorp phrase\\b', '(unclosed'], weak: ['\\bblarg\\b', 7] }));
    const user = loadUserPatterns(dir);
    assert.equal(user.strong.length, 1);
    assert.equal(user.weak.length, 1);
    assert.equal(score('That is a zorp phrase.', { user }), 2);
    assert.equal(score('That is a blarg.', { user }), 1);
    assert.equal(score('That is a zorp phrase.'), 0);
    assert.deepEqual(loadUserPatterns(join(fx.dir, 'nowhere')), { strong: [], weak: [] });
  } finally { fx.cleanup(); }
});

test('user patterns with nested quantifiers are skipped (ReDoS guard)', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.stateDir, 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'struggle-patterns.json'), JSON.stringify({
      strong: ['(a+)+$', '(.*)*x', '(a|b*){2,}c', '\bzorp phrase\b'], weak: ['^(\w+\s?)*$', '\bblarg\b'],
    }));
    const user = loadUserPatterns(dir);
    assert.equal(user.strong.length, 1);
    assert.equal(user.weak.length, 1);
    const t0 = Date.now();
    scorePrompt('a'.repeat(1400) + '!', { user });
    assert.ok(Date.now() - t0 < 1000);
  } finally { fx.cleanup(); }
});

test('the shipped example file holds placeholders only and parses', () => {
  const j = JSON.parse(readFileSync(new URL('../config/struggle-patterns.example.json', import.meta.url), 'utf8'));
  for (const s of [...j.strong, ...j.weak]) assert.match(s, /\{\{[A-Z_]+\}\}/);
});

// --- threshold, cooldown, cap ----------------------------------------------
function run(scores) {
  const st = emptyState();
  const fires = [];
  scores.forEach((n, i) => { if (step(st, { n, skipped: false, sentences: [] }).fire) fires.push(i + 1); });
  return fires;
}

test('threshold: fires on the second flagged prompt in the window, not the first', () => {
  assert.deepEqual(run([2, 0, 0]), []);
  assert.deepEqual(run([2, 0, 2]), [3]);
  assert.deepEqual(run([1, 1, 1, 1]), []);   // score 1 is not flagged
  assert.deepEqual(run([3, 2]), [2]);        // 3 counts as flagged too
});

test('threshold: two flagged prompts further apart than the window do not fire', () => {
  assert.equal(WINDOW, 6);
  assert.deepEqual(run([2, 0, 0, 0, 0, 0, 2]), []);   // prompt 1 has left the window of 6
  assert.deepEqual(run([2, 0, 0, 0, 0, 2]), [6]);     // still inside it
});

test('cooldown: no second fire within 6 prompts of the first', () => {
  assert.equal(COOLDOWN, 6);
  assert.deepEqual(run([2, 2, 2, 2, 2, 2, 2]), [2]);        // prompts 3..7 are inside the cooldown
  assert.deepEqual(run([2, 2, 2, 2, 2, 2, 2, 2]), [2, 8]);  // prompt 8 is the first allowed
});

test('cap: at most 2 fires per session', () => {
  assert.equal(MAX_FIRES, 2);
  assert.deepEqual(run(Array(30).fill(2)), [2, 8]);
});

test('skipped prompts do not count as prompts', () => {
  const st = emptyState();
  assert.equal(step(st, { n: 0, skipped: true, sentences: [] }).window, 0);
  assert.equal(st.count, 0);
});

// --- messages --------------------------------------------------------------
test('operator message by effort', () => {
  const below = operatorMessage(2, 5, 'high');
  assert.match(below, /needed 2 corrections in the last 5 prompts/);
  assert.match(below, /raising effort to xhigh may help/);
  for (const e of ['xhigh', 'max', null, 'bogus']) {
    const m = operatorMessage(2, 5, e);
    assert.ok(!/raising effort/.test(m), String(e));
    assert.match(m, /missing fact or rule/);
    assert.match(m, /fresh session/);
  }
  assert.match(operatorMessage(2, 5, null), /lead effort: unknown/);
});

test('lead message is one line', () => {
  const m = leadMessage(2, 5);
  assert.ok(!m.includes('\n'));
  for (const w of ['Answer every question', 're-ask nothing', 'check your own work', 'do not change effort']) assert.ok(m.includes(w), w);
});

test('liveEffort: payload first, then the recorded spawn row, else null', () => {
  const fx = makeFixture();
  try {
    assert.equal(liveEffort({ effort: { level: 'High' } }, join(fx.dir, 'none'), 's1'), 'high');
    const f = join(fx.dir, 'spawns.jsonl');
    writeFileSync(f, [
      { session_id: 's1', lead_effort_live: 'low' }, { session_id: 's2', lead_effort_live: 'max' },
      { session_id: 's1', lead_effort_live: 'high' }, { session_id: 's1', lead_effort_live: null },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(liveEffort({}, f, 's1'), 'high');
    assert.equal(liveEffort({}, f, 's3'), null);
    assert.equal(liveEffort({}, join(fx.dir, 'none'), 's1'), null);
  } finally { fx.cleanup(); }
});

// --- the hook --------------------------------------------------------------
const CORRECT = ['That is not true.', 'I meant the other one.', 'No, use the old one.'];
const send = (prompt, extra = {}, opts = {}) => runHook(HOOK, { session_id: 'sess-1', prompt, ...extra }, opts);

test('hook: silent until 2 of the last 6 prompts are flagged, then both messages', () => {
  const fx = makeFixture();
  try {
    let r = send(CORRECT[0]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    r = send('Add a test.');
    assert.equal(r.stdout.trim(), '');
    r = send(CORRECT[1], { effort: { level: 'high' } });
    assert.equal(r.status, 0);
    assert.match(r.json.systemMessage, /needed 2 corrections in the last 3 prompts/);
    assert.match(r.json.systemMessage, /raising effort to xhigh may help/);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(r.json.hookSpecificOutput.additionalContext, /^Struggle signal: 2 of the last 3/);
    assert.ok(!r.json.hookSpecificOutput.additionalContext.includes('\n'));
    // cooldown
    for (let i = 0; i < 4; i++) assert.equal(send(CORRECT[2]).stdout.trim(), '', `cooldown ${i}`);
  } finally { fx.cleanup(); }
});

test('hook: xhigh and unknown effort get the missing-fact wording', () => {
  const fx = makeFixture();
  try {
    send(CORRECT[0]);
    const r = send(CORRECT[1], { effort: { level: 'xhigh' } });
    assert.ok(!/raising effort/.test(r.json.systemMessage));
    assert.match(r.json.systemMessage, /missing fact or rule/);
  } finally { fx.cleanup(); }
  const fx2 = makeFixture();
  try {
    send(CORRECT[0]);
    const r = send(CORRECT[1]);
    assert.match(r.json.systemMessage, /lead effort: unknown/);
  } finally { fx2.cleanup(); }
});

test('hook: effort falls back to the recorded spawn row', () => {
  const fx = makeFixture();
  try {
    const tel = join(fx.stateDir, 'telemetry');
    mkdirSync(tel, { recursive: true });
    writeFileSync(join(tel, 'spawns.jsonl'), JSON.stringify({ session_id: 'sess-1', lead_effort_live: 'medium' }) + '\n');
    send(CORRECT[0]);
    const r = send(CORRECT[1]);
    assert.match(r.json.systemMessage, /lead effort: medium/);
    assert.match(r.json.systemMessage, /raising effort to xhigh may help/);
  } finally { fx.cleanup(); }
});

test('hook: the lead asking a question adds to the score (transcript tail)', () => {
  const fx = makeFixture();
  try {
    const tp = join(fx.dir, 't.jsonl');
    writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Do you want me to proceed?' }] } }) + '\n');
    // weak alone scores 1 (not flagged); with the lead's question it scores 2 and counts
    assert.equal(send('Make sure it is tested.', { transcript_path: tp }).stdout.trim(), '');
    const r = send('Make sure it is documented.', { transcript_path: tp });
    assert.ok(r.json && r.json.systemMessage);
  } finally { fx.cleanup(); }
});

test('hook: at most 2 fires per session, state keeps no prompt text', () => {
  const fx = makeFixture();
  try {
    let fired = 0;
    for (let i = 0; i < 20; i++) if (send('That is not true, rotate the secretword' + i + ' database password tonight please.').stdout.trim()) fired++;
    assert.equal(fired, 2);
    const dir = join(fx.stateDir, 'state', 'struggle');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const saved = readFileSync(join(dir, files[0]), 'utf8');
    assert.ok(JSON.parse(saved).sentences.length > 0, 'sentences were stored, so the check below is not vacuous');
    assert.ok(!saved.includes('secretword') && !saved.includes('secre') && !saved.includes('datab'));
    const tel = readFileSync(join(fx.stateDir, 'telemetry', 'struggle.jsonl'), 'utf8');
    assert.ok(!tel.includes('secretword'));
    assert.equal(tel.trim().split('\n').length, 20);
  } finally { fx.cleanup(); }
});

test('hook: sessions are independent', () => {
  const fx = makeFixture();
  try {
    send(CORRECT[0]);
    const other = runHook(HOOK, { session_id: 'sess-2', prompt: CORRECT[1] });
    assert.equal(other.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('hook: passes through for subagents, tagged prompts, headless runs and option off', () => {
  const fx = makeFixture();
  try {
    send(CORRECT[0]);
    assert.equal(send(CORRECT[1], { agent_id: 'a1' }).stdout.trim(), '');
    assert.equal(send('<task-notification>' + CORRECT[1]).stdout.trim(), '');
    assert.equal(send(CORRECT[1], {}, { env: { CLAUDE_PLUGIN_OPTION_STRUGGLE_DETECTOR: 'false' } }).stdout.trim(), '');
    // headless: scored and logged, but silent
    const r = send(CORRECT[1], {}, { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    assert.equal(r.stdout.trim(), '');
    assert.match(readFileSync(join(fx.stateDir, 'telemetry', 'struggle.jsonl'), 'utf8'), /"fired":false/);
  } finally { fx.cleanup(); }
});

test('hook: user pattern file is honoured', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.stateDir, 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'struggle-patterns.json'), JSON.stringify({ strong: ['\\bzorp phrase\\b'] }));
    send('One zorp phrase here.');
    assert.ok(send('Another zorp phrase here.').json.systemMessage);
  } finally { fx.cleanup(); }
});

test('hook: fails open on empty, garbage and unwritable state', () => {
  const fx = makeFixture();
  try {
    assert.equal(runHook(HOOK, undefined).status, 0);
    assert.equal(runHook(HOOK, { session_id: 's' }).stdout.trim(), '');
    assert.equal(runHook(HOOK, { prompt: 'x' }).stdout.trim(), '');
    assert.equal(send(CORRECT[0], { transcript_path: join(fx.dir, 'missing.jsonl') }).status, 0);
    assert.ok(existsSync(fx.dir));
  } finally { fx.cleanup(); }
});

test('hooks.json registers the detector on UserPromptSubmit', () => {
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const cmds = h.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((x) => x.args.join(' ')));
  assert.ok(cmds.some((c) => c.endsWith('hooks/struggle-detector.mjs')));
});

test('plugin.json declares the option, default true', () => {
  const j = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const o = (j.userConfig || j.options || {}).struggle_detector;
  assert.ok(o, 'option present');
  assert.equal(o.default, true);
});

// --- messages from other sessions (0.31.15 amendment) -----------------------
const XS = (body) => `Another Claude session sent a message:\n<cross-session-message from="local_abc" name="peer">\n${body}\n</cross-session-message>\n\nThis came from another Claude session.`;

test('a cross-session message is not an operator prompt: not scored, not counted', () => {
  for (const t of [XS('That is not true, I meant the other one.'), '<cross-session-message from="x">No, use the old one.</cross-session-message>', '  Another Claude session sent a message: no, I meant the other file']) {
    const s = scorePrompt(t);
    assert.equal(s.skipped, true, t);
    assert.equal(s.n, 0);
  }
  const st = emptyState();
  step(st, scorePrompt(XS('That is not true.')));
  assert.equal(st.count, 0);
  assert.equal(st.scores.length, 0);
  // an ordinary prompt that merely mentions the phrase later is still scored
  assert.equal(scorePrompt('That is not true, as the other session said.').skipped, false);
});

test('hook: cross-session messages never fire the detector or enter the window', () => {
  const fx = makeFixture();
  try {
    send(CORRECT[0]);
    assert.equal(send(XS(CORRECT[1])).stdout.trim(), '');
    assert.equal(send(XS(CORRECT[2])).stdout.trim(), '');
    // the two relayed corrections did not count: the next operator correction is only the 2nd flagged prompt
    assert.ok(send(CORRECT[1]).json.systemMessage, 'second operator correction fires');
    const rows = existsSync(join(fx.stateDir, 'telemetry', 'struggle.jsonl')) ? readFileSync(join(fx.stateDir, 'telemetry', 'struggle.jsonl'), 'utf8').trim().split('\n') : [];
    assert.equal(rows.length, 2, 'only operator prompts are logged');
  } finally { fx.cleanup(); }
});

test('hook: stored state holds no readable words of a real prompt (stems are hashed) and the repeat check still works', () => {
  const fx = makeFixture();
  try {
    const prompt = 'Please rotate the production database password immediately tonight, then email hunter the new credentials.';
    send(prompt);
    const dir = join(fx.stateDir, 'state', 'struggle');
    const body = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
    for (const w of ['pleas', 'rotat', 'produ', 'datab', 'passw', 'hunte', 'crede']) assert.ok(!body.includes(w), w);
    assert.ok(JSON.parse(body).sentences.length >= 1, 'something is stored for the repeat check');
    // the same sentence again is a repeat (score >= 2) -> counts as flagged
    send(prompt);
    const rows = readFileSync(join(fx.stateDir, 'telemetry', 'struggle.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows[1].score >= 2);
    assert.equal(rows[1].v, 2, 'written through appendLog');
    assert.ok(!JSON.stringify(rows).includes('hunter'));
  } finally { fx.cleanup(); }
});
