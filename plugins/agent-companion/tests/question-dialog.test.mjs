// question_dialog (0.31.51): hooks/question-dialog.mjs turns a question dialog (AskUserQuestion) away in the main
// session when the dialog would hold up messages from other agents and worker results, and tells the agent to ask in the
// closing message of the turn. Every test runs the real hook against scratch state (a makeFixture home); invented
// session and project names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, decisionOf, PLUGIN_ROOT } from './helpers.mjs';

const DENY_TEXT = 'Do not open a question dialog. It holds this session\'s turn open until the operator answers, '
  + 'and every message from other agents and every worker result waits behind it, sometimes for hours. Carry on with everything '
  + 'that does not depend on the answer. Then put the question, the options and your recommendation in the closing message of '
  + 'this turn (or in the app\'s end-of-turn question tool, if there is one) and end the turn.';

const SID = 'sess-qd-main';
const HOUR = 3600 * 1000;
const QUESTION = { questions: [{ question: 'Which colour for the border?', header: 'Colour', options: [{ label: 'Red', description: 'a' }, { label: 'Blue', description: 'b' }], multiSelect: false }] };

const payload = (fx, extra = {}) => ({
  session_id: SID, cwd: fx.dir, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: QUESTION, permission_mode: 'default', ...extra,
});
const ask = (fx, mode, extra = {}, env = {}) => runHook('hooks/question-dialog.mjs', payload(fx, extra), {
  env: { ...(mode ? { CLAUDE_PLUGIN_OPTION_QUESTION_DIALOG: mode } : {}), ...env },
});
const withFx = (fn) => () => { const fx = makeFixture(); try { fn(fx); } finally { fx.cleanup(); } };

function denialRows(fx) {
  const f = join(fx.stateDir, 'telemetry', 'question-dialog.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// The refusal is not a guard denial: denials.jsonl stays empty, or the scout's zero-denials canary would be blind.
const noGuardDenials = (fx) => assert.equal(existsSync(join(fx.stateDir, 'telemetry', 'denials.jsonl')), false);
const silent = (r) => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), '', 'no output: the dialog goes through'); };
const denied = (r, rule, fx) => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decisionOf(r.json), 'deny', r.stdout);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, DENY_TEXT);
  const rows = denialRows(fx);
  assert.equal(rows.length, 1, 'one telemetry row per refusal');
  assert.equal(rows[0].v, 2);
  assert.equal(rows[0].rule, rule);
  assert.equal(rows[0].session_id, SID);
  assert.ok(Number.isFinite(Date.parse(rows[0].at)));
  assert.equal(rows[0].n, rule === 'end-turn' ? 0 : 1);
  assert.equal(rows[0].mode, rule === 'end-turn' ? 'end-turn' : 'auto');
  assert.equal(rows[0].permission_mode, 'default');
  noGuardDenials(fx);
};

// Triggers -------------------------------------------------------------------------------------------------------
function helperRunning(fx, sid = SID) {
  const d = join(fx.stateDir, 'state', 'worker-ledger');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ev: 'start', agent_id: 'agent-qd-1', agent_type: 'ac-sonnet-high' })}\n`);
}
function otherSession(fx, { ageMs = 10 * 60000, sessionId = 'sess-qd-other', pid = 4242, key = 'updatedAt' } = {}) {
  const d = join(fx.dir, '.claude', 'sessions');
  mkdirSync(d, { recursive: true });
  const t = Date.now() - ageMs;
  writeFileSync(join(d, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: 'C:\\invented\\proj-a', startedAt: t - 1000, [key]: t, status: 'idle' }));
}
function transcriptWithPeer(fx) {
  const f = join(fx.dir, 'transcript-qd.jsonl');
  const text = 'Another Claude session sent a message:\n<cross-session-message from="peer-one" name="peer-one">\nplease look at the build\n</cross-session-message>';
  writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
  ].join('\n') + '\n');
  return f;
}
function transcriptWithoutPeer(fx) {
  const f = join(fx.dir, 'transcript-qd-plain.jsonl');
  writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    // A tool result that merely mentions the tag is not a message from another session.
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'grep: <cross-session-message from="x"> in docs' }] } }),
  ].join('\n') + '\n');
  return f;
}

test('the deny text: plain words, under 600 characters, the same wording pinned', () => {
  assert.ok(DENY_TEXT.length < 600, `${DENY_TEXT.length} characters`);
  for (const w of [/do not open a question dialog/i, /holds this session's turn open/, /message from other agents/, /worker result/, /carry on with everything/i,
    /closing message/, /options/, /recommendation/, /end the turn/]) assert.match(DENY_TEXT, w);
  assert.equal(DENY_TEXT.length, 425);
});

test('allow: never interferes, with every trigger present', withFx((fx) => {
  helperRunning(fx); otherSession(fx);
  silent(ask(fx, 'allow', { transcript_path: transcriptWithPeer(fx) }));
  assert.equal(denialRows(fx).length, 0);
}));

test('off is another word for allow (also in any letter case): never interferes, with every trigger present', withFx((fx) => {
  helperRunning(fx); otherSession(fx);
  silent(ask(fx, 'off', { transcript_path: transcriptWithPeer(fx) }));
  silent(ask(fx, ' Off ', { transcript_path: transcriptWithPeer(fx) }));
  assert.equal(denialRows(fx).length, 0);
}));

test('end-turn: always turns the dialog away, with no trigger present; one row names end-turn', withFx((fx) => {
  denied(ask(fx, 'end-turn'), 'end-turn', fx);
}));

test('auto (the default, also with the option unset): nothing to wait on means the dialog is allowed', withFx((fx) => {
  silent(ask(fx, 'auto', { transcript_path: transcriptWithoutPeer(fx) }));
  silent(ask(fx, null));
  assert.equal(denialRows(fx).length, 0);
}));

test('auto: helpers running is a trigger on its own', withFx((fx) => {
  helperRunning(fx);
  denied(ask(fx, 'auto'), 'helpers', fx);
}));

test('auto: a helper that has stopped is not a trigger', withFx((fx) => {
  helperRunning(fx);
  const f = join(fx.stateDir, 'state', 'worker-ledger', `${SID}.jsonl`);
  writeFileSync(f, readFileSync(f, 'utf8') + `${JSON.stringify({ at: new Date().toISOString(), ev: 'stop', agent_id: 'agent-qd-1', agent_type: 'ac-sonnet-high' })}\n`);
  silent(ask(fx, 'auto'));
}));

test('auto: another live session in the last two hours is a trigger on its own', withFx((fx) => {
  otherSession(fx);
  denied(ask(fx, 'auto'), 'live-sessions', fx);
}));

test('auto: a session record older than two hours, this session\'s own record, and a record with no time are not triggers', withFx((fx) => {
  otherSession(fx, { ageMs: 2 * HOUR + 5 * 60000, pid: 11 });
  otherSession(fx, { sessionId: SID, pid: 12 });
  const d = join(fx.dir, '.claude', 'sessions');
  writeFileSync(join(d, '13.json'), JSON.stringify({ pid: 13, sessionId: 'sess-qd-notime' }));
  writeFileSync(join(d, '14.json'), '{ not json');
  writeFileSync(join(d, '15.key'), 'not a record');
  silent(ask(fx, 'auto'));
}));

test('auto: the time can come from statusUpdatedAt or startedAt', withFx((fx) => {
  otherSession(fx, { key: 'statusUpdatedAt', pid: 21 });
  denied(ask(fx, 'auto'), 'live-sessions', fx);
}));

test('auto: a message received from another session is a trigger on its own', withFx((fx) => {
  denied(ask(fx, 'auto', { transcript_path: transcriptWithPeer(fx) }), 'peer-message', fx);
}));

test('auto: with no session records folder, a repo session touched in the last two hours still counts (the repo-scoped fallback)', withFx((fx) => {
  const repo = join(fx.dir, 'repo-qd');
  const slug = repo.replace(/[^A-Za-z0-9]/g, '-');
  const proj = join(fx.dir, '.claude', 'projects', slug);
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'sess-qd-sibling.jsonl'), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } })}\n`);
  denied(ask(fx, 'auto', { cwd: repo }), 'live-sessions', fx);
}));

test('the order is cheapest first: helpers, then live sessions, then a peer message', withFx((fx) => {
  helperRunning(fx); otherSession(fx);
  const r = ask(fx, 'auto', { transcript_path: transcriptWithPeer(fx) });
  assert.equal(decisionOf(r.json), 'deny');
  assert.equal(denialRows(fx)[0].rule, 'helpers');
  assert.equal(denialRows(fx)[0].n, 1);
}));

test('plan mode is always allowed, even with end-turn and every trigger', withFx((fx) => {
  helperRunning(fx); otherSession(fx);
  silent(ask(fx, 'end-turn', { permission_mode: 'plan', transcript_path: transcriptWithPeer(fx) }));
  silent(ask(fx, 'auto', { permission_mode: 'plan' }));
  assert.equal(denialRows(fx).length, 0);
}));

test('other permission modes are treated alike', withFx((fx) => {
  for (const m of ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', undefined]) {
    const r = ask(fx, 'end-turn', { permission_mode: m });
    assert.equal(decisionOf(r.json), 'deny', String(m));
  }
}));

test('a subagent\'s own call is ignored, in every mode', withFx((fx) => {
  helperRunning(fx); otherSession(fx);
  for (const mode of ['allow', 'auto', 'end-turn']) silent(ask(fx, mode, { agent_id: 'agent-qd-1', agent_type: 'ac-sonnet-high' }));
  assert.equal(denialRows(fx).length, 0);
}));

test('another tool name passes through untouched, in end-turn mode', withFx((fx) => {
  for (const tool of ['Bash', 'ExitPlanMode', 'Artifact', 'SendMessage', 'AskUserQuestions']) {
    silent(ask(fx, 'end-turn', { tool_name: tool }));
  }
  assert.equal(denialRows(fx).length, 0);
}));

test('an unknown option value reads as auto', withFx((fx) => {
  silent(ask(fx, 'sometimes'));
  helperRunning(fx);
  denied(ask(fx, 'sometimes'), 'helpers', fx);
}));

test('the value is read case-insensitively', withFx((fx) => {
  denied(ask(fx, 'END-TURN'), 'end-turn', fx);
}));

test('fail open: malformed, empty or incomplete input is allowed, exit 0, no output', withFx((fx) => {
  silent(runHook('hooks/question-dialog.mjs', undefined, { env: { CLAUDE_PLUGIN_OPTION_QUESTION_DIALOG: 'end-turn' } })); // empty stdin
  // payloads that are not an object, sent raw
  const raw = (text) => spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'question-dialog.mjs')], {
    input: text, encoding: 'utf8', windowsHide: true, cwd: fx.dir,
    env: { ...process.env, CLAUDE_PLUGIN_OPTION_QUESTION_DIALOG: 'end-turn', AGENT_COMPANION_HOME_OVERRIDE: fx.dir, AGENT_COMPANION_STATE_DIR: fx.stateDir },
  });
  for (const text of ['{ this is not json', '[]', 'null', '42', '"AskUserQuestion"']) {
    const r = raw(text);
    assert.equal(r.status, 0, text);
    assert.equal((r.stdout || '').trim(), '', text);
  }
  // no session id: a garbled call is not the main thread
  silent(ask(fx, 'end-turn', { session_id: undefined }));
  silent(ask(fx, 'end-turn', { session_id: '' }));
  // tool_input missing is fine for a main-thread call in end-turn mode (the hook does not read it): still a valid deny
  const noInput = ask(fx, 'end-turn', { tool_input: undefined });
  assert.equal(decisionOf(noInput.json), 'deny');
}));

test('fail open: missing state in auto mode (no ledger, no records folder, no transcript, no projects) is allowed', withFx((fx) => {
  silent(ask(fx, 'auto', { transcript_path: join(fx.dir, 'no-such-transcript.jsonl') }));
  silent(ask(fx, 'auto', { transcript_path: 42, cwd: undefined }));
}));

test('fail open: an unreadable state folder and an unreadable session records folder are allowed in auto mode', withFx((fx) => {
  const blocker = join(fx.dir, 'blocked-state-dir');
  writeFileSync(blocker, 'a file, not a directory');
  mkdirSync(join(fx.dir, '.claude'), { recursive: true });
  writeFileSync(join(fx.dir, '.claude', 'sessions'), 'a file, not a directory');
  const r = ask(fx, 'auto', {}, { AGENT_COMPANION_STATE_DIR: blocker });
  silent(r);
}));

test('an unreadable state folder does not stop a refusal that needs no state (end-turn): exit 0, a valid deny', withFx((fx) => {
  const blocker = join(fx.dir, 'blocked-state-dir-2');
  writeFileSync(blocker, 'a file, not a directory');
  const r = ask(fx, 'end-turn', {}, { AGENT_COMPANION_STATE_DIR: blocker });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decisionOf(r.json), 'deny');
  assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, DENY_TEXT);
}));

test('the order continues: live sessions beat a peer message', withFx((fx) => {
  otherSession(fx);
  const r = ask(fx, 'auto', { transcript_path: transcriptWithPeer(fx) });
  assert.equal(decisionOf(r.json), 'deny');
  assert.equal(denialRows(fx)[0].rule, 'live-sessions');
}));

test('auto: a session that has been busy for hours counts while its process is alive; a dead process or an idle old record does not', withFx((fx) => {
  const d = join(fx.dir, '.claude', 'sessions');
  mkdirSync(d, { recursive: true });
  const old = Date.now() - 5 * HOUR;
  const rec = (pid, status) => writeFileSync(join(d, `${pid}.json`), JSON.stringify({ pid, sessionId: `sess-qd-busy-${pid}`, startedAt: old, updatedAt: old, statusUpdatedAt: old, status }));
  // a process that has exited: its pid is not alive now
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  rec(Number(gone.stdout), 'busy');
  rec(process.pid, 'idle'); // idle and old: not live, even though the process exists
  silent(ask(fx, 'auto'));
  rec(process.pid, 'busy'); // busy for 5 hours and the process exists: live
  denied(ask(fx, 'auto'), 'live-sessions', fx);
}));

test('the option can come from the settings home', withFx((fx) => {
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  writeFileSync(join(fx.stateDir, 'config', 'settings.json'), JSON.stringify({ question_dialog: 'end-turn' }));
  denied(ask(fx, null), 'end-turn', fx);
  writeFileSync(join(fx.stateDir, 'config', 'settings.json'), JSON.stringify({ question_dialog: 'allow' }));
  silent(ask(fx, null));
  // the settings home is read before the environment
  helperRunning(fx);
  silent(ask(fx, 'end-turn'));
}));

test('plugin.json: the option text names the stream the rows go to', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match((manifest.userConfig || manifest.options).question_dialog.description, /question-dialog\.jsonl/);
});

test('registered in hooks.json on exactly ^AskUserQuestion$ (the publish check keeps its own entry); question_dialog is declared with default auto', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const mine = hooks.filter((e) => e.hooks.some((h) => h.args.some((a) => a.endsWith('/hooks/question-dialog.mjs'))));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].matcher, '^AskUserQuestion$');
  assert.ok(mine[0].hooks[0].timeout <= 10);
  const publish = hooks.find((e) => e.hooks.some((h) => h.args.some((a) => a.endsWith('/hooks/publish-check.mjs'))));
  assert.equal(publish.matcher, '^(Artifact|AskUserQuestion)$');
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const o = (manifest.userConfig || manifest.options).question_dialog;
  assert.equal(o.type, 'string');
  assert.equal(o.default, 'auto');
});

test('the hook never emits permissionDecision allow, and its refusal is the only output it has', () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'hooks', 'question-dialog.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /permissionDecision['"]?\s*:\s*['"]allow['"]/);
});

