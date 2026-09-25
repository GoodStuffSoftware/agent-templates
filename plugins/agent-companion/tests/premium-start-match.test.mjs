// A SubagentStart confirms a premium spawn's pending window entry only when
// its agent type matches the spawn's (0.29.0 RC review R7, reviewer F8).
// Matched by session alone, a NON-premium start in the same session (a
// haiku Explore, say) confirmed the premium entry, so the premium spawn that
// the harness then rejected kept its slot for the full window. SubagentStart
// carries agent_type (not the model); the guard records the spawn's type on
// its entry. Either side lacking a type falls back to the session match
// (over-counts, the safe direction). Namespacing is ignored:
// "agent-companion:ac-opus" and "ac-opus" are one type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

const SID = 'sess-start-match';
// Each start is a new agent: a repeated agent_id is a CONTINUED agent, which
// confirms nothing (lib/ladder-rewrite.mjs, hooks/spawn-log.mjs).
let startSeq = 0;

function harness() {
  const fx = makeFixture();
  const env = { CLAUDE_PLUGIN_DATA: join(fx.dir, 'pdata') };
  const file = join(fx.stateDir, 'state', 'premium-window.json');
  mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
  return {
    ...fx,
    file,
    seed: (entries) => writeFileSync(file, JSON.stringify(entries)),
    window: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []),
    spawn: (subagentType) => runHook('hooks/spawn-guard.mjs', {
      session_id: SID, agent_type: 'main', cwd: fx.dir,
      tool_input: { ...(subagentType ? { subagent_type: subagentType } : {}), model: 'fable', run_in_background: true, name: 'w', prompt: 'WARRANT: x\ngo' },
    }, { env }),
    start: (agentType) => runHook('hooks/spawn-log.mjs', {
      session_id: SID, agent_id: `a${++startSeq}`, hook_event_name: 'SubagentStart', ...(agentType ? { agent_type: agentType } : {}),
    }, { env }),
  };
}

test('the guard records the spawn\'s agent type on its pending entry', () => {
  const h = harness();
  try {
    h.spawn('agent-companion:ac-opus-xhigh');
    h.spawn(null);
    assert.deepEqual(h.window().map((e) => e.atype), ['ac-opus-xhigh', 'general-purpose']);
  } finally { h.cleanup(); }
});

test('a start of a DIFFERENT agent type in the same session does not confirm a premium entry', () => {
  const h = harness();
  try {
    h.spawn('ac-opus-xhigh');
    h.start('Explore');
    assert.equal(h.window()[0].confirmed, false, 'a non-premium start confirmed the premium entry');
    h.start('agent-companion:ac-opus-xhigh');
    assert.equal(h.window()[0].confirmed, true, 'the matching start (namespaced) must confirm it');
  } finally { h.cleanup(); }
});

test('the oldest pending entry OF THE START\'S TYPE is the one confirmed', () => {
  const h = harness();
  try {
    const t = Date.now();
    h.seed([
      { t: t - 2000, sid: SID, confirmed: false, atype: 'ac-fable' },
      { t: t - 1000, sid: SID, confirmed: false, atype: 'general-purpose' },
    ]);
    h.start('general-purpose');
    assert.deepEqual(h.window().map((e) => e.confirmed), [false, true]);
  } finally { h.cleanup(); }
});

test('with no type on either side, a start still confirms by session (over-counts, the safe direction)', () => {
  const h = harness();
  try {
    const t = Date.now();
    h.seed([{ t, sid: SID, confirmed: false }]); // an older guard's entry: no atype
    h.start('Explore');
    assert.equal(h.window()[0].confirmed, true);
    h.seed([{ t, sid: SID, confirmed: false, atype: 'ac-opus' }]);
    h.start(null); // a payload with no agent_type
    assert.equal(h.window()[0].confirmed, true);
  } finally { h.cleanup(); }
});

test('a repeat start of the same agent_id (a continued agent) confirms no further premium entry', () => {
  const h = harness();
  try {
    const startId = (agentType, id) => runHook('hooks/spawn-log.mjs', {
      session_id: SID, agent_id: id, hook_event_name: 'SubagentStart', agent_type: agentType,
    }, { env: { CLAUDE_PLUGIN_DATA: join(h.dir, 'pdata') } });
    h.spawn('agent-companion:ac-opus-xhigh');
    startId('agent-companion:ac-opus-xhigh', 'agent-X');
    h.spawn('agent-companion:ac-opus-xhigh');
    startId('agent-companion:ac-opus-xhigh', 'agent-X'); // agent-X continued with SendMessage
    assert.deepEqual(h.window().map((e) => e.confirmed), [true, false]);
    startId('agent-companion:ac-opus-xhigh', 'agent-Y'); // the second spawn really starts
    assert.deepEqual(h.window().map((e) => e.confirmed), [true, true]);
  } finally { h.cleanup(); }
});
