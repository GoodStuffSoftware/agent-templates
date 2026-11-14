// Coordinator message gate: hooks/coordinator-gate.mjs, hooks/lib/coordinator-gate.mjs and the
// session-start rule 'child-coordinator-messages'. Synthetic fixtures only: an invented session folder in
// the shape of the desktop app's records, and invented messages (projects and text are made up).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, decisionOf, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import {
  tagOf, TAGS, DENY_REASON, modeFrom, sessionRecord, parentOf, resolveTargetSession, sessionForAddress, STANDING_RULE_TEXT,
} from '../hooks/lib/coordinator-gate.mjs';

const COORD = 'local_orchard-coord-0001'; // the coordinator
const CHILD = 'local_orchard-child-0002'; // started by COORD
const CHILD_CLI = 'cli-child-0001';
const PEER = 'local_orchard-peer-0003'; // another child of COORD
const COORD_CLI = 'cli-coord-0001';
const PIPE = 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-orchard-coord';
const PEER_PIPE = 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-orchard-peer';
const HOOK = 'hooks/coordinator-gate.mjs';

function world(extraEnv = {}) {
  const fx = makeFixture();
  const sessions = join(fx.dir, 'code-sessions', 'acct', 'org');
  mkdirSync(sessions, { recursive: true });
  const env = {
    CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    AGENT_COMPANION_CODE_SESSIONS_DIR: join(fx.dir, 'code-sessions'),
    ...extraEnv,
  };
  const record = (local, cli, spawnedFrom, more = {}) => writeFileSync(join(sessions, `${local}.json`), JSON.stringify({
    sessionId: local, cliSessionId: cli, title: 'invented', ...(spawnedFrom ? { spawnedFrom: { sessionId: spawnedFrom, taskId: 'task_1' } } : {}), ...more,
  }));
  record(COORD, COORD_CLI, null);
  record(CHILD, CHILD_CLI, COORD);
  record(PEER, 'cli-peer-0001', COORD);
  // The child's transcript: the coordinator's message carries the reply address and its session id.
  const transcript = join(fx.dir, 'child.jsonl');
  const incoming = (from, session) => JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="${from}" from-session="${session}" from-name="Orchard planner" from-mode="bypass">\nStart on the tile renderer.\n</cross-session-message>` },
  });
  writeFileSync(transcript, `${incoming(PIPE, COORD)}\n${incoming(PEER_PIPE, PEER)}\n`);
  const send = (payload, e = {}) => runHook(HOOK, {
    session_id: CHILD_CLI, transcript_path: transcript, tool_name: 'SendMessage', ...payload,
  }, { env: { ...env, ...e } });
  const rows = () => readJsonl(join(fx.stateDir, 'telemetry', 'coordinator-messages.jsonl'));
  return { fx, env, sessions, record, transcript, send, rows };
}

// ---- the tag check --------------------------------------------------------------------------------------

test('tagOf: each of the six tags passes, whatever the case, leading space or bold around it', () => {
  assert.deepEqual([...TAGS], ['QUESTION', 'BLOCKED', 'DONE', 'CHANGE', 'FINDING', 'ANSWER']);
  for (const t of TAGS) {
    assert.equal(tagOf(`${t}: the tile renderer needs a decision`), t);
    assert.equal(tagOf(`${t.toLowerCase()}: lower case`), t);
    assert.equal(tagOf(`   \n  ${t}: leading whitespace`), t);
    assert.equal(tagOf(`**${t}:** bold with the colon inside`), t);
    assert.equal(tagOf(`**${t}**: bold around the word`), t);
    assert.equal(tagOf(`__${t[0]}${t.slice(1).toLowerCase()}__: mixed case, underscores`), t);
  }
});

test('tagOf: status, a tag mid-message, a tag without a colon and non-strings carry no tag', () => {
  for (const m of [
    'Slice 2 of the tile renderer is built and tests are green, starting slice 3.',
    'Got it, thanks.',
    'Still working on the atlas packer; about half done.',
    'I am DONE: with the build step but moving on',
    'DONE with the atlas packer',
    'DONEISH: nearly',
    'QUESTIONS: a plural is not a tag',
    '',
  ]) assert.equal(tagOf(m), null, m);
  assert.equal(tagOf({ type: 'shutdown_response' }), null);
  assert.equal(tagOf(undefined), null);
});

test('modeFrom: block, warn and off; anything else is the shipped default', () => {
  assert.equal(modeFrom('block'), 'block');
  assert.equal(modeFrom(' WARN '), 'warn');
  assert.equal(modeFrom('off'), 'off');
  for (const v of ['', 'maybe', undefined, null, 1]) assert.equal(modeFrom(v), 'block');
});

// ---- the hook: the gate ---------------------------------------------------------------------------------

test('hook: a tagged message to the coordinator passes, for each tag, and leaves one telemetry row each', () => {
  const w = world();
  try {
    for (const t of TAGS) {
      const r = w.send({ tool_input: { to: COORD, message: `${t}: the atlas packer result for the orchard demo` } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', t);
    }
    const rows = w.rows();
    assert.equal(rows.length, TAGS.length);
    assert.deepEqual(rows.map((x) => x.tag), [...TAGS]);
    for (const x of rows) {
      assert.equal(x.decision, 'allow');
      assert.equal(x.mode, 'block');
      assert.equal(x.session_id, CHILD_CLI);
      assert.equal(x.target, 'session-id');
      assert.ok(!JSON.stringify(x).includes('atlas packer'), 'no message text in telemetry');
    }
  } finally { w.fx.cleanup(); }
});

test('hook: an untagged message to the coordinator is denied with the one-line reason', () => {
  const w = world();
  try {
    const r = w.send({ tool_input: { to: COORD, message: 'Slice 2 of the tile renderer is built, tests are green, starting slice 3.' } });
    assert.equal(decisionOf(r.json), 'deny');
    assert.equal(r.json.hookSpecificOutput.permissionDecisionReason, DENY_REASON);
    assert.equal(DENY_REASON.includes('\n'), false);
    const [x] = w.rows();
    assert.deepEqual([x.decision, x.tag, x.mode], ['deny', null, 'block']);
    assert.ok(!JSON.stringify(x).includes('tile renderer'));
  } finally { w.fx.cleanup(); }
});

test('hook: the mcp send_message form is gated the same way (session_id is the target)', () => {
  const w = world();
  try {
    const bad = w.send({ tool_name: 'mcp__ccd_session_mgmt__send_message', tool_input: { session_id: COORD, message: 'ack, continuing' } });
    assert.equal(decisionOf(bad.json), 'deny');
    const ok = w.send({ tool_name: 'mcp__ccd_session_mgmt__send_message', tool_input: { session_id: COORD, message: 'BLOCKED: the preview server will not start' } });
    assert.equal(ok.stdout.trim(), '');
    assert.deepEqual(w.rows().map((x) => [x.tool_name, x.decision]), [
      ['mcp__ccd_session_mgmt__send_message', 'deny'], ['mcp__ccd_session_mgmt__send_message', 'allow'],
    ]);
  } finally { w.fx.cleanup(); }
});

test('hook: hooks.json registers it on both send tools, and the option is declared with default block', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const entry = hooks.find((h) => h.hooks.some((x) => x.args.some((a) => a.endsWith('hooks/coordinator-gate.mjs'))));
  assert.ok(entry, 'registered');
  const re = new RegExp(entry.matcher);
  assert.ok(re.test('SendMessage') && re.test('mcp__ccd_session_mgmt__send_message'));
  assert.ok(!re.test('Agent') && !re.test('mcp__ccd_session_mgmt__start_session'));
  const decl = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.coordinator_message_gate;
  assert.equal(decl.default, 'block');
  assert.match(decl.description, /our environment's default/);
});

// ---- target addresses -----------------------------------------------------------------------------------

test('addresses: a local_ id and a uds: reply address both resolve to the coordinator; both forms are gated', () => {
  const w = world();
  try {
    assert.equal(resolveTargetSession(COORD, w.transcript), COORD);
    assert.equal(resolveTargetSession(PIPE, w.transcript), COORD);
    assert.equal(resolveTargetSession(PEER_PIPE, w.transcript), PEER);
    assert.equal(sessionForAddress(PIPE, w.transcript), COORD);
    const viaPipe = w.send({ tool_input: { to: PIPE, message: 'progress: halfway through the atlas packer' } });
    assert.equal(decisionOf(viaPipe.json), 'deny');
    const tagged = w.send({ tool_input: { to: PIPE, message: 'DONE: atlas packer merged' } });
    assert.equal(tagged.stdout.trim(), '');
    assert.deepEqual(w.rows().map((x) => [x.target, x.decision]), [['address', 'deny'], ['address', 'allow']]);
  } finally { w.fx.cleanup(); }
});

test('addresses: names, unknown pipes and other address forms do not resolve', () => {
  const w = world();
  try {
    assert.equal(resolveTargetSession('worker-one', w.transcript), null);
    assert.equal(resolveTargetSession('uds:\\\\.\\pipe\\LOCAL\\cc-msg-orchard-nobody', w.transcript), null);
    assert.equal(resolveTargetSession('bridge:abc', w.transcript), null);
    assert.equal(resolveTargetSession(PIPE, join(w.fx.dir, 'missing.jsonl')), null);
    assert.equal(resolveTargetSession(undefined, w.transcript), null);
  } finally { w.fx.cleanup(); }
});

// ---- what passes untouched ------------------------------------------------------------------------------

test('hook: sends that are not child-to-coordinator pass with no output and no telemetry', () => {
  const w = world();
  try {
    const status = 'still working, about half done';
    const cases = [
      ['to a peer child by id', { to: PEER, message: status }],
      ['to a peer child by reply address', { to: PEER_PIPE, message: status }],
      ['to an unknown pipe', { to: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-orchard-stranger', message: status }],
      ['to an unknown session id', { to: 'local_orchard-other-0004', message: status }],
      ['to one of its own subagents', { to: 'tile-worker', message: status }],
      ['a structured message', { to: COORD, message: { type: 'shutdown_response', approve: true } }],
    ];
    for (const [label, tool_input] of cases) {
      const r = w.send({ tool_input });
      assert.equal(r.status, 0, label);
      assert.equal(r.stdout.trim(), '', label);
    }
    // from a subagent of the child: out of scope
    const sub = w.send({ agent_id: 'agent-1', agent_type: 'general-purpose', tool_input: { to: COORD, message: status } });
    assert.equal(sub.stdout.trim(), '');
    assert.equal(w.rows().length, 0);
  } finally { w.fx.cleanup(); }
});

test('hook: a coordinator, and a session with no record, may send untagged messages to anyone', () => {
  const w = world();
  try {
    // the coordinator is top-level (no spawnedFrom): to its child, by id and by address
    const toChild = runHook(HOOK, { session_id: COORD_CLI, transcript_path: w.transcript, tool_name: 'SendMessage', tool_input: { to: CHILD, message: 'go ahead' } }, { env: w.env });
    assert.equal(toChild.stdout.trim(), '');
    const toPipe = runHook(HOOK, { session_id: COORD_CLI, transcript_path: w.transcript, tool_name: 'SendMessage', tool_input: { to: PIPE, message: 'go ahead' } }, { env: w.env });
    assert.equal(toPipe.stdout.trim(), '');
    // a session the app has no record of
    const none = runHook(HOOK, { session_id: 'cli-unknown', transcript_path: w.transcript, tool_name: 'SendMessage', tool_input: { to: COORD, message: 'hello' } }, { env: w.env });
    assert.equal(none.stdout.trim(), '');
    assert.equal(w.rows().length, 0);
  } finally { w.fx.cleanup(); }
});

// ---- fail open ------------------------------------------------------------------------------------------

test('fail open: garbage input, damaged records, a missing folder and an unreadable transcript all pass', () => {
  const w = world();
  try {
    const bad = runHook(HOOK, undefined, { env: w.env });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), '');
    for (const payload of [{}, { session_id: CHILD_CLI }, { session_id: CHILD_CLI, tool_name: 'SendMessage', tool_input: 'x' }, { session_id: 5, tool_input: { to: COORD, message: 'x' } }]) {
      const r = runHook(HOOK, payload, { env: w.env });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '');
    }
    // a transcript that cannot be read: the pipe cannot be resolved
    const noTranscript = w.send({ transcript_path: join(w.fx.dir, 'nope.jsonl'), tool_input: { to: PIPE, message: 'status' } });
    assert.equal(noTranscript.stdout.trim(), '');
    // the child's record is damaged JSON and the folder is full of junk: no parent known
    writeFileSync(join(w.sessions, `${CHILD}.json`), `{"cliSessionId":"${CHILD_CLI}", broken`);
    writeFileSync(join(w.sessions, 'local_junk.json'), '');
    rmCache(w);
    const damaged = w.send({ tool_input: { to: COORD, message: 'status' } });
    assert.equal(damaged.stdout.trim(), '');
    // the whole folder is gone
    const gone = w.send({ tool_input: { to: COORD, message: 'status' } }, { AGENT_COMPANION_CODE_SESSIONS_DIR: join(w.fx.dir, 'no-such-folder') });
    assert.equal(gone.stdout.trim(), '');
    assert.equal(w.rows().length, 0);
  } finally { w.fx.cleanup(); }
});

function rmCache(w) {
  const f = join(w.fx.stateDir, 'state', 'coordinator-parent.json');
  if (existsSync(f)) writeFileSync(f, '{}');
}

// ---- the option -----------------------------------------------------------------------------------------

test('option: warn sends the message and tells the model to tag; off gates nothing; block is the default', () => {
  const w = world();
  try {
    const msg = { to: COORD, message: 'ack, continuing with the atlas packer' };
    const warn = w.send({ tool_input: msg }, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'warn' });
    assert.equal(decisionOf(warn.json), 'proceed');
    assert.match(warn.json.hookSpecificOutput.additionalContext, /QUESTION:, BLOCKED:, DONE:, CHANGE:, FINDING: or ANSWER:/);
    const warnTagged = w.send({ tool_input: { to: COORD, message: 'ANSWER: use the 2x atlas' } }, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'warn' });
    assert.equal(warnTagged.stdout.trim(), '');
    const off = w.send({ tool_input: msg }, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'off' });
    assert.equal(off.stdout.trim(), '');
    const junk = w.send({ tool_input: msg }, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'sometimes' });
    assert.equal(decisionOf(junk.json), 'deny');
    const dflt = w.send({ tool_input: msg });
    assert.equal(decisionOf(dflt.json), 'deny');
    assert.deepEqual(w.rows().map((x) => [x.mode, x.decision, x.tag]), [
      ['warn', 'warn', null], ['warn', 'allow', 'ANSWER'], ['block', 'deny', null], ['block', 'deny', null],
    ]);
  } finally { w.fx.cleanup(); }
});

test('option: the settings home value is read like any other option', () => {
  const w = world();
  try {
    mkdirSync(join(w.fx.stateDir, 'config'), { recursive: true });
    writeFileSync(join(w.fx.stateDir, 'config', 'settings.json'), JSON.stringify({ coordinator_message_gate: 'warn' }));
    const r = w.send({ tool_input: { to: COORD, message: 'status' } });
    assert.equal(decisionOf(r.json), 'proceed');
    writeFileSync(join(w.fx.stateDir, 'config', 'settings.json'), JSON.stringify({ coordinator_message_gate: 'off' }));
    assert.equal(w.send({ tool_input: { to: COORD, message: 'status' } }).stdout.trim(), '');
  } finally { w.fx.cleanup(); }
});

// ---- the parent lookup ----------------------------------------------------------------------------------

test('lookup: the parent comes from spawnedFrom; prior and last-assistant CLI ids match; a top-level session has none', () => {
  const w = world();
  try {
    const root = join(w.fx.dir, 'code-sessions');
    assert.equal(sessionRecord(CHILD_CLI, root).parent, COORD);
    assert.equal(sessionRecord(COORD_CLI, root).parent, null);
    assert.equal(sessionRecord('cli-nobody', root), null);
    w.record(CHILD, 'cli-child-new', COORD, { priorCliSessionIds: [CHILD_CLI, 'cli-child-older'], lastAssistantCliSessionId: 'cli-child-last' });
    for (const id of [CHILD_CLI, 'cli-child-older', 'cli-child-new', 'cli-child-last']) assert.equal(sessionRecord(id, root).parent, COORD, id);
  } finally { w.fx.cleanup(); }
});

test('lookup: a found parent is cached; "no parent" is cached only briefly', () => {
  const w = world();
  try {
    const root = join(w.fx.dir, 'code-sessions');
    const prev = process.env.AGENT_COMPANION_CODE_SESSIONS_DIR;
    process.env.AGENT_COMPANION_CODE_SESSIONS_DIR = root;
    try {
      assert.equal(parentOf(CHILD_CLI, { now: 1000 }), COORD);
      writeFileSync(join(w.sessions, `${CHILD}.json`), '{}'); // record gone from the folder's view
      assert.equal(parentOf(CHILD_CLI, { now: 2000 }), COORD, 'served from the cache');
      assert.equal(parentOf(COORD_CLI, { now: 1000 }), null);
      w.record(COORD, COORD_CLI, PEER); // now it has a parent
      assert.equal(parentOf(COORD_CLI, { now: 1000 + 60_000 }), null, 'negative answer still cached');
      assert.equal(parentOf(COORD_CLI, { now: 1000 + 11 * 60_000 }), PEER, 'negative answer expired');
    } finally {
      if (prev === undefined) delete process.env.AGENT_COMPANION_CODE_SESSIONS_DIR; else process.env.AGENT_COMPANION_CODE_SESSIONS_DIR = prev;
    }
  } finally { w.fx.cleanup(); }
});

// ---- the session-start rule -----------------------------------------------------------------------------

test('rule: the standing rule appears in a child session only, and not with the option off', () => {
  const w = world();
  try {
    const start = (sid, e = {}, more = {}) => runHook('hooks/standing-rules.mjs', { session_id: sid, ...more }, { env: { ...w.env, ...e }, args: ['--event', 'session-start'] });
    const text = (r) => (r.json ? r.json.hookSpecificOutput.additionalContext : '');
    const child = text(start(CHILD_CLI));
    assert.ok(child.includes(STANDING_RULE_TEXT), 'child gets the rule');
    assert.match(child, /QUESTION: .*BLOCKED: .*DONE: .*CHANGE: .*FINDING: .*ANSWER: /s);
    assert.match(child, /task card if you use one, otherwise your task list; never message the coordinator just to report progress or acknowledge/);
    assert.ok(!text(start(COORD_CLI)).includes(STANDING_RULE_TEXT), 'a top-level session does not');
    assert.ok(!text(start('cli-unknown')).includes(STANDING_RULE_TEXT), 'an unknown session does not');
    assert.ok(!text(start(CHILD_CLI, {}, { agent_id: 'agent-1' })).includes(STANDING_RULE_TEXT), 'a subagent of a child does not');
    assert.ok(!text(start(CHILD_CLI, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'off' })).includes(STANDING_RULE_TEXT), 'off removes it');
    assert.ok(text(start(CHILD_CLI, { CLAUDE_PLUGIN_OPTION_COORDINATOR_MESSAGE_GATE: 'warn' })).includes(STANDING_RULE_TEXT), 'warn keeps it');
  } finally { w.fx.cleanup(); }
});

test('rule: it is two lines, short, and inside the standing-rules budget alongside every other session-start rule', async () => {
  assert.equal(STANDING_RULE_TEXT.split('\n').length, 2);
  assert.ok(STANDING_RULE_TEXT.length < 450, `${STANDING_RULE_TEXT.length} chars`);
  const { defaultRules, renderRules } = await import('../hooks/lib/rules.mjs');
  const all = defaultRules().filter((r) => r.scope === 'session-start' && r.enabled);
  assert.ok(all.some((r) => r.id === 'child-coordinator-messages'));
  const rendered = renderRules(all, { maxChars: 3000 });
  assert.ok(!/more rules? dropped/.test(rendered), 'nothing is dropped at the shipped budget');
  assert.match(defaultRules().find((r) => r.id === 'child-coordinator-messages').note, /^Origin: /);
});
