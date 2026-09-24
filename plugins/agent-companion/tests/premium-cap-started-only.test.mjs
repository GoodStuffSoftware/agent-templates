// premium_cap counts spawns that actually STARTED (slice 1b fix d).
//
// Reproduced on origin/main before this fix: a spawn the guard DENIES
// (warrant, fit, cap) is written to spawns.jsonl but never counted toward the
// cap, and a cap-denied retry does not extend the window — both still hold,
// asserted first below. But a spawn the guard ALLOWS and the harness then
// rejects (an unknown subagent_type) held a slot for the full 10-minute
// window, so every failed retry extended the block. Now an allowed spawn
// records a PENDING entry, the SubagentStart hook confirms it, and a pending
// entry never confirmed stops counting after PREMIUM_PENDING_MS (3 min).
//
// Time is moved by ageing the stored entries, not by waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

const SID = 'sess-cap-started';
const FOUR_MIN = 4 * 60 * 1000;

function harness() {
  const fx = makeFixture();
  const env = { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '2' };
  const file = join(fx.stateDir, 'state', 'premium-window.json');
  let n = 0;
  const spawn = (prompt, model, extra = {}) => {
    n += 1;
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: SID, agent_type: 'main', cwd: fx.dir,
      tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: `w${n}`, prompt, ...extra },
    }, { env });
    assert.equal(res.status, 0, res.stderr);
    return res.json?.hookSpecificOutput?.permissionDecision;
  };
  const started = () => runHook('hooks/spawn-log.mjs', { session_id: SID, agent_id: `a${n}`, agent_type: 'general-purpose', hook_event_name: 'SubagentStart' }, { env });
  const entries = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } };
  // Move every stored entry `ms` into the past (numbers and objects alike).
  const age = (ms) => writeFileSync(file, JSON.stringify(entries().map((e) => (typeof e === 'number' ? e - ms : { ...e, t: e.t - ms }))));
  return { ...fx, spawn, started, entries, age };
}

const WARRANTED = 'WARRANT: needs frontier reasoning\ngo';

test('unchanged: guard-denied spawns are logged to spawns.jsonl but never counted; a cap-denied retry does not extend the window', () => {
  const h = harness();
  try {
    assert.equal(h.spawn('go', 'fable'), 'deny'); // no warrant
    assert.equal(h.spawn('WEIGHT: 1\nWARRANT: x', 'opus'), 'deny'); // fit
    assert.equal(h.entries().length, 0);
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny'); // cap
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny'); // retry
    assert.equal(h.entries().length, 2);
    assert.equal(readJsonl(join(h.stateDir, 'telemetry', 'spawns.jsonl')).length, 6);
  } finally { h.cleanup(); }
});

test('a spawn that never starts (harness-rejected) stops holding a slot after 3 minutes', () => {
  const h = harness();
  try {
    assert.equal(h.spawn(WARRANTED, 'fable', { subagent_type: 'no-such-agent' }), 'allow');
    // No SubagentStart: the harness rejected it. Four minutes later...
    h.age(FOUR_MIN);
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow', 'the rejected spawn must not still count toward the cap');
  } finally { h.cleanup(); }
});

test('a spawn that DID start keeps counting for the full window', () => {
  const h = harness();
  try {
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    h.started();
    assert.equal(h.entries()[0].confirmed, true);
    h.age(FOUR_MIN);
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny', 'a started premium agent still counts inside the window');
  } finally { h.cleanup(); }
});

test('a parallel burst (no starts yet) is still capped: pending entries count while young', () => {
  const h = harness();
  try {
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny');
  } finally { h.cleanup(); }
});

test('a teammate spawn (team_name) is recorded as started at once', () => {
  const h = harness();
  try {
    assert.equal(h.spawn(WARRANTED, 'fable', { team_name: 'crew' }), 'allow');
    assert.equal(h.entries()[0].confirmed, true);
    h.age(FOUR_MIN);
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny');
  } finally { h.cleanup(); }
});

test('a pre-1b window entry (a bare timestamp) still counts as a started spawn', () => {
  const h = harness();
  try {
    assert.equal(h.spawn(WARRANTED, 'fable'), 'allow');
    writeFileSync(join(h.stateDir, 'state', 'premium-window.json'), JSON.stringify([Date.now() - FOUR_MIN, Date.now() - FOUR_MIN]));
    assert.equal(h.spawn(WARRANTED, 'fable'), 'deny');
  } finally { h.cleanup(); }
});
