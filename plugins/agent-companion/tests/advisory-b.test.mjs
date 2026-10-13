// Advisory hooks F9 (live sessions), F10 (peer message), F14 (overdue worker).
// Synthetic fixtures only: a throwaway home under the test sandbox.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

const HOOK = 'hooks/advisory-b.mjs';
const SID = 'lead-sess-1';

function run(event, payload, env) {
  return runHook(HOOK, payload, { args: ['--event', event], env });
}
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

function layout(fx) {
  const proj = join(fx.dir, '.claude', 'projects', 'slug');
  const transcript = join(proj, `${SID}.jsonl`);
  const subDir = join(proj, SID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(transcript, '{}\n');
  return { transcript, subDir };
}
function name(subDir, id, nm) {
  writeFileSync(join(subDir, `agent-${id}.meta.json`), JSON.stringify({ name: nm, agentType: 'general-purpose' }));
}
function start(id, extra = {}) { return run('worker-start', { session_id: SID, agent_id: id, agent_type: 'general-purpose', ...extra }); }
function stop(id) { return run('worker-stop', { session_id: SID, agent_id: id, agent_type: 'general-purpose' }); }
function startRow(fx, id, ageMin) {
  const tel = join(fx.stateDir, 'telemetry');
  mkdirSync(tel, { recursive: true });
  const at = new Date(Date.now() - ageMin * 60000).toISOString();
  writeFileSync(join(tel, 'subagent-starts.jsonl'), `${JSON.stringify({ v: 2, at, session_id: SID, agent_id: id, agent_type: 'general-purpose' })}\n`, { flag: 'a' });
}

// ---- F10 ----
test('F10: warns once for a non-subagent target while own subagents run, names them, never denies', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    start('a1');
    const payload = { session_id: SID, transcript_path: transcript, tool_name: 'SendMessage', tool_input: { to: 'peer-session' } };
    const r = run('send', payload);
    assert.equal(r.status, 0);
    const c = ctx(r);
    assert.match(c, /another session \("peer-session"\)/);
    assert.match(c, /worker-one/);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(ctx(run('send', payload)), '', 'second send to the same target is silent');
  } finally { fx.cleanup(); }
});

test('F10: silent for own subagent, main, no running subagents, or option off', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    const send = (to, env) => run('send', { session_id: SID, transcript_path: transcript, tool_input: { to } }, env);
    assert.equal(ctx(send('peer-x')), '', 'nothing running yet');
    start('a1');
    assert.equal(ctx(send('worker-one')), '');
    assert.equal(ctx(send('a1')), '');
    assert.equal(ctx(send('main')), '');
    assert.equal(ctx(send('peer-y', { CLAUDE_PLUGIN_OPTION_PEER_MESSAGE_WARNING: 'false' })), '');
    stop('a1');
    assert.equal(ctx(send('peer-z')), '', 'stopped workers do not count as running');
  } finally { fx.cleanup(); }
});

test('F10: a subagent caller is ignored', () => {
  const fx = makeFixture();
  try {
    const { transcript } = layout(fx);
    start('a1');
    const r = run('send', { session_id: SID, agent_id: 'a1', transcript_path: transcript, tool_input: { to: 'peer' } });
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

// ---- F14 ----
test('F14: overdue worker noticed once, with its name, from telemetry start time', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'slow-writer');
    name(subDir, 'a2', 'quick-reader');
    start('a1'); start('a2');
    startRow(fx, 'a1', 30);
    startRow(fx, 'a2', 5);
    const p = { session_id: SID, transcript_path: transcript };
    const r = run('user-prompt', { ...p, hook_event_name: 'UserPromptSubmit' }, { CLAUDE_PLUGIN_OPTION_LIVE_SESSIONS: 'false' });
    const c = ctx(r);
    assert.match(c, /^slow-writer has run 3\d min, past 1\.5x the 15-minute worker size\. Probe its output file/);
    assert.doesNotMatch(c, /quick-reader/);
    assert.equal(ctx(run('tick', { ...p, hook_event_name: 'PostToolUse' })), '', 'once per worker');
  } finally { fx.cleanup(); }
});

test('F14: stopped worker, threshold 0, option off, subagent caller all silent', () => {
  const fx = makeFixture();
  try {
    const { transcript } = layout(fx);
    start('a1');
    startRow(fx, 'a1', 40);
    const p = { session_id: SID, transcript_path: transcript };
    assert.equal(ctx(run('tick', p, { CLAUDE_PLUGIN_OPTION_OVERDUE_WORKER_MINUTES: '0' })), '');
    assert.equal(ctx(run('tick', p, { CLAUDE_PLUGIN_OPTION_OVERDUE_WORKER_WARNING: 'false' })), '');
    assert.equal(ctx(run('tick', { ...p, agent_id: 'x' })), '');
    stop('a1');
    assert.equal(ctx(run('tick', p)), '');
  } finally { fx.cleanup(); }
});

test('F14: without a telemetry row the ledger start time is used', () => {
  const fx = makeFixture();
  try {
    const { transcript } = layout(fx);
    start('a1');
    const f = join(fx.stateDir, 'state', 'worker-ledger', `${SID}.jsonl`);
    const old = new Date(Date.now() - 25 * 60000).toISOString();
    writeFileSync(f, `${JSON.stringify({ at: old, ev: 'start', agent_id: 'a1', agent_type: 'general-purpose' })}\n`);
    assert.match(ctx(run('tick', { session_id: SID, transcript_path: transcript })), /general-purpose has run 2\d min/);
  } finally { fx.cleanup(); }
});

// ---- F9 ----
function session(fx, dir, id, { title, ageMin = 10 }) {
  const d = join(fx.dir, '.claude', 'projects', dir);
  mkdirSync(d, { recursive: true });
  const f = join(d, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'first prompt text' } })];
  if (title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }));
  writeFileSync(f, `${lines.join('\n')}\n`);
  const t = new Date(Date.now() - ageMin * 60000);
  utimesSync(f, t, t);
}

test('F9: lists live sessions in this repo, worktrees and related repos; skips old and own; re-fires only on change', () => {
  const fx = makeFixture();
  try {
    const cwd = join(fx.dir, 'dev', 'app-a');
    const slug = (s) => s.replace(/[^A-Za-z0-9]/g, '-');
    const mine = slug(cwd);
    session(fx, mine, SID, { title: 'me' });
    session(fx, mine, 'other-1', { title: 'Design chat', ageMin: 12 });
    session(fx, `${mine}--claude-worktrees-w1`, 'other-2', { ageMin: 70 });
    session(fx, mine, 'old-1', { title: 'Too old', ageMin: 200 });
    session(fx, slug(join(fx.dir, 'dev', 'app-b')), 'rel-1', { title: 'Popup session', ageMin: 3 });
    session(fx, slug(join(fx.dir, 'dev', 'unrelated')), 'un-1', { title: 'Unrelated', ageMin: 3 });
    const env = { CLAUDE_PLUGIN_OPTION_RELATED_REPOS: JSON.stringify({ 'app-a': ['app-b'] }) };
    const p = { session_id: SID, cwd };
    const c = ctx(run('session-start', p, env));
    assert.match(c, /^Other live sessions \(last 2 h\): /);
    assert.match(c, /"Popup session" \(app-b, 3m\)/);
    assert.match(c, /"Design chat" \(app-a, 12m\)/);
    assert.match(c, /"first prompt text" \(app-a, 1h 10m\)/);
    assert.doesNotMatch(c, /Too old|Unrelated|"me"/);
    assert.match(c, /message it and say what changes\.$/);
    assert.equal(ctx(run('user-prompt', p, env)), '', 'unchanged set is silent');
    session(fx, mine, 'other-3', { title: 'New one', ageMin: 1 });
    assert.match(ctx(run('user-prompt', p, env)), /"New one"/);
  } finally { fx.cleanup(); }
});

test('F9: same repo only without related_repos; option off and subagent are silent', () => {
  const fx = makeFixture();
  try {
    const cwd = join(fx.dir, 'dev', 'app-a');
    const slug = (s) => s.replace(/[^A-Za-z0-9]/g, '-');
    session(fx, slug(join(fx.dir, 'dev', 'app-b')), 'rel-1', { title: 'Popup', ageMin: 3 });
    assert.equal(ctx(run('session-start', { session_id: SID, cwd })), '');
    session(fx, slug(cwd), 'o1', { title: 'Peer', ageMin: 3 });
    assert.match(ctx(run('session-start', { session_id: SID, cwd })), /"Peer"/);
    assert.equal(ctx(run('session-start', { session_id: SID, cwd }, { CLAUDE_PLUGIN_OPTION_LIVE_SESSIONS: 'false' })), '');
    assert.equal(ctx(run('session-start', { session_id: SID, cwd, agent_id: 'z' })), '');
  } finally { fx.cleanup(); }
});

test('malformed stdin and unknown events fail open with no output', () => {
  const fx = makeFixture();
  try {
    for (const ev of ['send', 'tick', 'user-prompt', 'session-start', 'worker-start', 'bogus']) {
      const r = run(ev, undefined);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    }
  } finally { fx.cleanup(); }
});

test('registration: hooks.json wires the events and plugin.json declares the options defaulting on', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const has = (ev, matcher, event) => (h[ev] || []).some((g) => (g.matcher || '') === matcher
    && g.hooks.some((x) => (x.args || []).some((a) => String(a).endsWith('advisory-b.mjs')) && x.args.includes(event)));
  assert.ok(has('PreToolUse', '^SendMessage$', 'send'));
  assert.ok(has('SessionStart', '', 'session-start'));
  assert.ok(has('UserPromptSubmit', '', 'user-prompt'));
  assert.ok(has('PostToolUse', '', 'tick'));
  assert.ok(has('SubagentStart', '', 'worker-start'));
  assert.ok(has('SubagentStop', '', 'worker-stop'));
  assert.ok(has('PostToolUse', '^TaskStop$', 'task-stop'));
  const o = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig
    || JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).options;
  for (const k of ['live_sessions', 'peer_message_warning', 'overdue_worker_warning']) assert.equal(o[k].default, true, k);
  assert.equal(o.overdue_worker_minutes.default, 22);
  assert.equal(o.related_repos.default, '');
});

// ---- F10 known peers (0.31.15 amendment) ----
test('F10: new wording does not discourage peer traffic', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    start('a1');
    const c = ctx(run('send', { session_id: SID, transcript_path: transcript, tool_input: { to: 'stranger' } }));
    assert.equal(c, 'This message goes to another session ("stranger"), not your own workers (worker-one). Fine if it is meant for a peer or coordinator; to reach a worker, use its name.');
  } finally { fx.cleanup(); }
});

test('F10: no note for a target that already sent this session a cross-session message (a reply)', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    const rec = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
    writeFileSync(transcript, [
      rec('Another Claude session sent a message:\n<cross-session-message from="local_fb2426d3" name="Build routing profiles">\nhello\n</cross-session-message>\n\nNot typed by your user.'),
      rec('Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1">\nping\n</cross-session-message>'),
      // text that only quotes a name does not make it a peer
      rec('please tell stranger-quoted about the plan <cross-session-message from="stranger-quoted">x</cross-session-message>'),
    ].join('\n') + '\n');
    start('a1');
    const send = (to) => ctx(run('send', { session_id: SID, transcript_path: transcript, tool_input: { to } }));
    assert.equal(send('local_fb2426d3'), '', 'reply by from id');
    assert.equal(send('Build routing profiles'), '', 'reply by name');
    assert.equal(send('uds:\\\\.\\pipe\\LOCAL\\cc-msg-1'), '', 'reply by uds id');
    assert.match(send('stranger-quoted'), /another session/, 'a quoted tag in an operator turn is not a received message');
  } finally { fx.cleanup(); }
});

test('F10: no note for a name listed in known_peers; other targets still warn', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    start('a1');
    const env = { CLAUDE_PLUGIN_OPTION_KNOWN_PEERS: '["Coordinator", "scribe"]' };
    const send = (to, e = env) => ctx(run('send', { session_id: SID, transcript_path: transcript, tool_input: { to } }, e));
    assert.equal(send('coordinator'), '');
    assert.equal(send('scribe [3fa9c1]'), '');
    assert.match(send('someone-else'), /another session \("someone-else"\)/);
    // garbage option value: fail open to "warn"
    assert.match(send('coordinator', { CLAUDE_PLUGIN_OPTION_KNOWN_PEERS: 'not json' }), /another session/);
  } finally { fx.cleanup(); }
});

test('F10: replies to the three real sender forms raise no note', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'worker-one');
    const rec = (content) => JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content } });
    writeFileSync(transcript, [
      rec('Another Claude session sent a message:\n<agent-message from="cg-gaps">\nstatus?\n</agent-message>'),
      rec('Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-9" from-session="local_7a1" from-name="Sudoku agent coordinator">\nping\n</cross-session-message>'),
      rec('Another Claude session sent a message:\n<teammate-message teammate_id="deployer-2" color="red">\ndone\n</teammate-message>'),
    ].join('\n') + '\n');
    start('a1');
    const send = (to) => ctx(run('send', { session_id: SID, transcript_path: transcript, tool_input: { to } }));
    assert.equal(send('cg-gaps'), '');
    assert.equal(send('Sudoku agent coordinator'), '');
    assert.equal(send('local_7a1'), '');
    assert.equal(send('deployer-2'), '');
    assert.match(send('not-a-sender'), /another session/);
  } finally { fx.cleanup(); }
});

// ---- worker ledger: TaskStop, interrupted spawns, zombies, pruning (0.31.17) ----
const ledgerRows = (fx) => readFileSync(join(fx.stateDir, 'state', 'worker-ledger', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function agentTranscript(subDir, id, ageMin) {
  const f = join(subDir, `agent-${id}.jsonl`);
  writeFileSync(f, '{}\n');
  const t = new Date(Date.now() - ageMin * 60000);
  utimesSync(f, t, t);
}

test('TaskStop writes a stop row for a ledger worker; F14 and F10 stop counting it', () => {
  const fx = makeFixture();
  try {
    const { transcript } = layout(fx);
    start('a1');
    startRow(fx, 'a1', 40);
    const p = { session_id: SID, transcript_path: transcript };
    const ts = (id, resp) => run('task-stop', { ...p, tool_name: 'TaskStop', tool_input: { task_id: id }, tool_response: resp });
    // real shape: tool_input.task_id equals the agent id; the response carries task_id and task_type
    ts('shell-task-1', { task_id: 'shell-task-1', task_type: 'local_bash' });
    assert.equal(ledgerRows(fx).length, 1, 'ids not in the ledger are ignored');
    ts('a1', { message: 'Successfully stopped task: a1 (x)', task_id: 'a1', task_type: 'local_agent' });
    const rows = ledgerRows(fx);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].ev, 'stop');
    assert.equal(rows[1].agent_id, 'a1');
    assert.equal(rows[1].agent_type, 'general-purpose');
    assert.equal(ctx(run('tick', p)), '', 'no overdue note for a stopped worker');
    assert.equal(ctx(run('send', { ...p, tool_input: { to: 'peer-q' } })), '', 'not counted as running');
  } finally { fx.cleanup(); }
});

test('TaskStop: a failed stop and a malformed payload write nothing', () => {
  const fx = makeFixture();
  try {
    layout(fx);
    start('a1');
    run('task-stop', { session_id: SID, tool_input: { task_id: 'a1' }, tool_response: { error: 'No task found' } });
    run('task-stop', { session_id: SID, tool_input: {} });
    assert.equal(run('task-stop', undefined).status, 0);
    assert.equal(ledgerRows(fx).length, 1);
  } finally { fx.cleanup(); }
});

test('an interrupted spawn (start row, no stop, idle subagent transcript) is not running', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'find-pilot-env-id');
    start('a1');
    startRow(fx, 'a1', 24);
    const p = { session_id: SID, transcript_path: transcript };
    agentTranscript(subDir, 'a1', 21); // last written 21 min ago: the operator rejected its tool prompt
    assert.equal(ctx(run('tick', p)), '', 'no "has run 24 min" note');
    assert.equal(ctx(run('send', { ...p, tool_input: { to: 'peer-q' } })), '', 'F10 does not count it');
  } finally { fx.cleanup(); }
});

test('a start whose subagent transcript is still being written stays running and overdue', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    name(subDir, 'a1', 'slow-writer');
    start('a1');
    startRow(fx, 'a1', 30);
    agentTranscript(subDir, 'a1', 2);
    assert.match(ctx(run('tick', { session_id: SID, transcript_path: transcript })), /^slow-writer has run 3\d min/);
  } finally { fx.cleanup(); }
});

test('zombie bound: with no transcript, a start older than 6 h is not running', () => {
  const fx = makeFixture();
  try {
    const { transcript } = layout(fx);
    start('a1');
    const f = join(fx.stateDir, 'state', 'worker-ledger', `${SID}.jsonl`);
    const old = new Date(Date.now() - 7 * 3600000).toISOString();
    writeFileSync(f, `${JSON.stringify({ at: old, ev: 'start', agent_id: 'a1', agent_type: 'general-purpose' })}\n`);
    const p = { session_id: SID, transcript_path: transcript };
    assert.equal(ctx(run('tick', p)), '');
    assert.equal(ctx(run('send', { ...p, tool_input: { to: 'peer-q' } })), '');
  } finally { fx.cleanup(); }
});

test('pruning runs from a stop event and session start, not only from SubagentStart', () => {
  const fx = makeFixture();
  try {
    const st = join(fx.stateDir, 'state');
    const old = new Date(Date.now() - 9 * 86400000);
    const seed = (dir, file) => {
      mkdirSync(join(st, dir), { recursive: true });
      const f = join(st, dir, file);
      writeFileSync(f, 'x');
      utimesSync(f, old, old);
      return f;
    };
    const a = seed('live-sessions', 'dead.sig');
    const b = seed('worker-ledger', 'dead.jsonl');
    const c = seed('peer-warned', 'dead.seen');
    stop('a1');
    assert.equal(existsSync(a) || existsSync(b) || existsSync(c), false, 'stop event pruned');
    // throttled: a fresh stale file survives a second run within the hour, then session-start after the stamp ages out
    const d = seed('live-sessions', 'dead2.sig');
    stop('a1');
    assert.equal(existsSync(d), true, 'throttled to once an hour');
    const stamp = join(st, 'advisory-prune.stamp');
    utimesSync(stamp, old, old);
    run('session-start', { session_id: SID, cwd: fx.dir });
    assert.equal(existsSync(d), false, 'session-start pruned');
  } finally { fx.cleanup(); }
});
