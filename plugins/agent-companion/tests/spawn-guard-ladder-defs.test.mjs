// Ladder track (0292) round 2, item 4: spawn-guard.mjs reads plugin-
// namespaced agent definitions. `agent-companion:ac-*` (and any
// `<plugin>:<agent>`) resolves to that plugin's own agents/ folder, so a
// ladder spawn's model and effort come from its rung file: no false rule-1
// note, and no route model autofilled over the rung.
//
// And the peer finding: when autofill sets a model on a NON-ladder spawn,
// the guard rewrites the spawn to the matching ac-<model>-<effort> rung so
// effort is pinned too — only where the rewrite is safe (a general-purpose
// or unnamed spawn, and a ladder agent already STARTED in this session,
// which shows the harness registered the ladder). Otherwise: an advisory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function guard(dir, sessionId, toolInput) {
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sessionId, agent_type: 'main', cwd: dir,
    tool_input: { run_in_background: true, name: 'w', ...toolInput },
  });
  assert.equal(res.status, 0, res.stderr);
  return res;
}
function rowFor(stateDir, sessionId) {
  return readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sessionId).pop();
}
function seedStart(stateDir, sessionId, agentType) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'subagent-starts.jsonl'),
    `${JSON.stringify({ v: 2, at: new Date().toISOString(), session_id: sessionId, agent_type: agentType })}\n`, { flag: 'a' });
}
const updated = (res) => res.json?.hookSpecificOutput?.updatedInput || null;
const msgOf = (res) => res.json?.systemMessage || '';

test('agent-companion:ac-opus-high reads model AND effort from the plugin\'s own agents/ file: no rule-1 note, no autofill', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = guard(dir, 'sess-ns-high', {
      subagent_type: 'agent-companion:ac-opus-high', prompt: 'TYPE: novel-design\nWARRANT: weight 5 — design',
    });
    assert.doesNotMatch(msgOf(res), /SPAWNING RULE 1/);
    assert.equal(updated(res)?.model, undefined, 'no model may be filled in over the rung');
    const r = rowFor(stateDir, 'sess-ns-high');
    assert.equal(r.model_definition, 'opus');
    assert.equal(r.effort_definition, 'high');
    assert.equal(r.model_autofilled, false);
    assert.equal(r.inherited, false);
  } finally {
    cleanup();
  }
});

test('agent-companion:ac-haiku with TYPE: novel-design is NOT autofilled to opus (the rung is locked)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = guard(dir, 'sess-ns-haiku', { subagent_type: 'agent-companion:ac-haiku', prompt: 'TYPE: novel-design' });
    assert.equal(updated(res)?.model, undefined);
    const r = rowFor(stateDir, 'sess-ns-haiku');
    assert.equal(r.model, 'haiku');
    assert.equal(r.model_autofilled, false);
  } finally {
    cleanup();
  }
});

test('a bare ladder name resolves to the plugin\'s own rung file and is never autofilled', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = guard(dir, 'sess-ns-bare', { subagent_type: 'ac-opus-low', prompt: 'TYPE: novel-design' });
    assert.equal(updated(res)?.model, undefined);
    const r = rowFor(stateDir, 'sess-ns-bare');
    assert.equal(r.model_definition, 'opus');
    assert.equal(r.effort_definition, 'low');
  } finally {
    cleanup();
  }
});

test('another plugin\'s <plugin>:<agent> resolves through its installed_plugins.json installPath', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const install = join(dir, '.claude', 'plugins', 'cache', 'mp', 'other-plugin', '1.0.0');
    mkdirSync(join(install, 'agents'), { recursive: true });
    writeFileSync(join(install, 'agents', 'reviewer.md'), '---\nname: reviewer\nmodel: sonnet\neffort: "high"\n---\nbody\n');
    mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'other-plugin@mp': [{ scope: 'user', version: '1.0.0', installPath: install, lastUpdated: '2026-09-24T00:00:00.000Z' }] },
    }));
    const res = guard(dir, 'sess-other-plugin', { subagent_type: 'other-plugin:reviewer', prompt: 'review this' });
    assert.doesNotMatch(msgOf(res), /SPAWNING RULE 1/);
    const r = rowFor(stateDir, 'sess-other-plugin');
    assert.equal(r.model_definition, 'sonnet');
    assert.equal(r.effort_definition, 'high');
  } finally {
    cleanup();
  }
});

test('path-shaped namespaced names resolve to nothing and never break the spawn', () => {
  const { dir, cleanup } = makeFixture();
  try {
    for (const t of ['agent-companion:../../settings', 'agent-companion:a/b', '..:ac-opus-low']) {
      const res = guard(dir, `sess-unsafe-${t.length}`, { subagent_type: t, model: 'sonnet', prompt: 'x' });
      assert.ok(res.json, t);
    }
  } finally {
    cleanup();
  }
});

// --- autofill -> ladder rung ---------------------------------------------------

test('rewrite path: general-purpose, no model, a ladder agent already started this session -> rewritten to the rung', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-rewrite', 'agent-companion:ac-sonnet-low');
    const res = guard(dir, 'sess-rewrite', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    const u = updated(res);
    assert.equal(u?.subagent_type, 'agent-companion:ac-opus-low');
    assert.equal(u?.model, 'opus');
    assert.match(msgOf(res), /Rewrote subagent_type "general-purpose" -> "agent-companion:ac-opus-low" so effort low is pinned too/);
    assert.doesNotMatch(msgOf(res), /effort not pinned|SPAWNING RULE 1/);
    const r = rowFor(stateDir, 'sess-rewrite');
    assert.equal(r.subagent_type, 'general-purpose');
    assert.equal(r.subagent_type_rewritten_to, 'agent-companion:ac-opus-low');
    assert.equal(r.effective_effort, 'low');
  } finally {
    cleanup();
  }
});

// Round 3 (R2-6): a bare rewrite target must itself be registered. Outside
// this plugin's repo a bare name registers only from a user- or
// project-level file, so a bare start of ANOTHER rung plus a partial user
// install proves nothing about the target rung.
function userAgent(dir, name) {
  const d = join(dir, '.claude', 'agents');
  mkdirSync(d, { recursive: true });
  const [, model, effort] = name.match(/^ac-(\w+)-(\w+)$/);
  writeFileSync(join(d, `${name}.md`), `---\nname: ${name}\nmodel: ${model}\neffort: ${effort}\n---\nbody\n`);
}

test('bare rewrite refused: a bare start of another rung and a partial user-level install (only ac-sonnet-low) -> advisory', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    userAgent(dir, 'ac-sonnet-low');
    seedStart(stateDir, 'sess-bare-partial', 'ac-sonnet-low');
    const res = guard(dir, 'sess-bare-partial', { prompt: 'TYPE: explore' }); // routes to opus/low
    assert.equal(updated(res)?.subagent_type, undefined, 'must not rewrite to an unregistered bare ac-opus-low');
    assert.match(msgOf(res), /only bare ladder names have started in this session, and "ac-opus-low" itself has not started here/);
    assert.equal(rowFor(stateDir, 'sess-bare-partial').subagent_type_rewritten_to, null);
  } finally {
    cleanup();
  }
});

test('bare rewrite allowed only when that exact bare rung has started here and its file is at user or project scope', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-bare-exact', 'ac-opus-low');
    // Started, but no user/project file (the plugin's own copy does not register a bare name): refused.
    const before = guard(dir, 'sess-bare-exact', { prompt: 'TYPE: explore' });
    assert.equal(updated(before)?.subagent_type, undefined);
    userAgent(dir, 'ac-opus-low');
    const res = guard(dir, 'sess-bare-exact', { prompt: 'TYPE: explore' });
    assert.equal(updated(res)?.subagent_type, 'ac-opus-low');
  } finally {
    cleanup();
  }
});

test('the namespaced form is preferred: namespaced evidence rewrites to agent-companion:<rung> even with bare evidence present', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    userAgent(dir, 'ac-opus-low');
    seedStart(stateDir, 'sess-prefer-ns', 'ac-opus-low');
    seedStart(stateDir, 'sess-prefer-ns', 'agent-companion:ac-sonnet-high');
    const res = guard(dir, 'sess-prefer-ns', { prompt: 'TYPE: explore' });
    assert.equal(updated(res)?.subagent_type, 'agent-companion:ac-opus-low');
    // R2-9: after a rewrite the row names the rung's own model and effort.
    const r = rowFor(stateDir, 'sess-prefer-ns');
    assert.equal(r.model_definition, 'opus');
    assert.equal(r.effort_definition, 'low');
  } finally {
    cleanup();
  }
});

test('evidence from before the session last loaded its plugins does not count', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const t = join(stateDir, 'telemetry');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'subagent-starts.jsonl'), `${JSON.stringify({
      v: 2, at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), session_id: 'sess-reloaded', agent_type: 'agent-companion:ac-sonnet-low',
    })}\n`);
    // self-update recorded a /reload-plugins 1h ago: the start above predates it.
    mkdirSync(join(stateDir, 'state'), { recursive: true });
    writeFileSync(join(stateDir, 'state', 'version-notice-state.json'), JSON.stringify({
      'sess-reloaded': { loadedAt: Date.now() - 3600 * 1000, loadedAtFrom: 'reload', shown: [], at: Date.now() },
    }));
    const res = guard(dir, 'sess-reloaded', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(res)?.subagent_type, 'general-purpose');
    assert.match(msgOf(res), /no ladder agent has started in this session since it last loaded its plugins/);
    assert.ok(rowFor(stateDir, 'sess-reloaded').loaded_at, 'the row carries the trusted load time');
  } finally {
    cleanup();
  }
});

// Round 3: a rewrite the harness ignores. SubagentStart then reports the
// spawn's ORIGINAL type; the guard records that and stops rewriting for the
// rest of the session.
function start(dir, sessionId, agentType) {
  const res = runHook('hooks/spawn-log.mjs', { session_id: sessionId, agent_id: `ag-${Math.random().toString(16).slice(2, 8)}`, agent_type: agentType, cwd: dir });
  assert.equal(res.status, 0, res.stderr);
}
const startsFor = (stateDir, sessionId) => readJsonl(join(stateDir, 'telemetry', 'subagent-starts.jsonl')).filter((r) => r.session_id === sessionId);
// The session was armed (lib/ladder-rewrite.mjs) `msAgo`: the guard has
// recorded every spawn there since, as it does from the session's first
// ladder spawn (the one whose start is the rewrite's evidence).
function seedArmed(stateDir, sessionId, msAgo) {
  const s = join(stateDir, 'state');
  mkdirSync(s, { recursive: true });
  const f = join(s, 'ladder-rewrites.json');
  let all = {};
  try { all = JSON.parse(readFileSync(f, 'utf8')); } catch { all = {}; }
  all[sessionId] = { armedAt: Date.now() - msAgo, pending: [], ignored: null, touched: Date.now() };
  writeFileSync(f, JSON.stringify(all));
}
const TEN_MIN = 10 * 60 * 1000;

test('an ignored rewrite is detected at SubagentStart and turns rewriting off for the rest of the session', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-ignored', 'agent-companion:ac-sonnet-low');
    seedArmed(stateDir, 'sess-ignored', TEN_MIN);
    const first = guard(dir, 'sess-ignored', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(first)?.subagent_type, 'agent-companion:ac-opus-low');
    // The harness ran it as general-purpose anyway.
    start(dir, 'sess-ignored', 'general-purpose');
    const last = startsFor(stateDir, 'sess-ignored').pop();
    assert.equal(last.rewrite_ignored, 'agent-companion:ac-opus-low');
    // Next spawn: advisory, not another rewrite.
    const second = guard(dir, 'sess-ignored', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(second)?.subagent_type, 'general-purpose');
    assert.match(msgOf(second), /an earlier rewrite in this session ran as "general-purpose" instead of "agent-companion:ac-opus-low", so the harness did not honour it; rewriting is off for the rest of this session/);
    assert.equal(rowFor(stateDir, 'sess-ignored').subagent_type_rewritten_to, null);
    // Another session is unaffected.
    seedStart(stateDir, 'sess-other-ok', 'agent-companion:ac-sonnet-low');
    seedArmed(stateDir, 'sess-other-ok', TEN_MIN);
    const other = guard(dir, 'sess-other-ok', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(other)?.subagent_type, 'agent-companion:ac-opus-low');
  } finally {
    cleanup();
  }
});

test('an honoured rewrite, and a plain general-purpose spawn starting first, never count as ignored', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-honoured', 'agent-companion:ac-sonnet-low');
    seedArmed(stateDir, 'sess-honoured', TEN_MIN);
    const a = guard(dir, 'sess-honoured', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(a)?.subagent_type, 'agent-companion:ac-opus-low');
    // A plain general-purpose spawn with an explicit model, made while the rewrite is pending.
    const b = guard(dir, 'sess-honoured', { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain work' });
    assert.equal(updated(b)?.subagent_type ?? 'general-purpose', 'general-purpose');
    // Its start arrives first, then the rewritten spawn's, as the rung.
    start(dir, 'sess-honoured', 'general-purpose');
    start(dir, 'sess-honoured', 'agent-companion:ac-opus-low');
    assert.ok(startsFor(stateDir, 'sess-honoured').every((r) => !r.rewrite_ignored));
    const c = guard(dir, 'sess-honoured', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    assert.equal(updated(c)?.subagent_type, 'agent-companion:ac-opus-low');
  } finally {
    cleanup();
  }
});

// Round 4 (R3-2): a rewrite is marked ignored only when the start is
// positively tied to THAT rewritten spawn.
const PLAIN_GP = { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain work' };
const AUTOFILL_GP = { subagent_type: 'general-purpose', prompt: 'TYPE: explore' };

test('a plain spawn made BEFORE the rewrite, in a session not yet armed: its start draws no conclusion', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-g1', 'agent-companion:ac-sonnet-low');
    // A: plain general-purpose, before any rewrite, so it was never recorded.
    guard(dir, 'sess-g1', PLAIN_GP);
    // B: rewritten (this arms the session, just now).
    assert.equal(updated(guard(dir, 'sess-g1', AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low');
    // A's start arrives: it could be B ignored, or A. No conclusion either way.
    start(dir, 'sess-g1', 'general-purpose');
    assert.ok(startsFor(stateDir, 'sess-g1').every((r) => !r.rewrite_ignored));
    const st = JSON.parse(readFileSync(join(stateDir, 'state', 'ladder-rewrites.json'), 'utf8'))['sess-g1'];
    assert.equal(st.ignored, null);
    // Even if B's start ALSO comes as general-purpose, the session was armed
    // too recently to know nothing else of that type was in flight: still none.
    start(dir, 'sess-g1', 'general-purpose');
    assert.ok(startsFor(stateDir, 'sess-g1').every((r) => !r.rewrite_ignored));
    // So rewriting carries on, and the note never claims the harness ignored it.
    const c = guard(dir, 'sess-g1', AUTOFILL_GP);
    assert.equal(updated(c)?.subagent_type, 'agent-companion:ac-opus-low');
    assert.doesNotMatch(msgOf(c), /did not honour/);
  } finally {
    cleanup();
  }
});

test('a one-message fan-out mixing plain and rewritten spawns: every start matches its own spawn, nothing is ignored', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-fan', 'agent-companion:ac-sonnet-low');
    seedArmed(stateDir, 'sess-fan', TEN_MIN);
    // One assistant message, four Agent calls: every PreToolUse runs first.
    guard(dir, 'sess-fan', PLAIN_GP);
    assert.equal(updated(guard(dir, 'sess-fan', AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low');
    guard(dir, 'sess-fan', { subagent_type: 'Explore', model: 'haiku', prompt: 'look around' });
    assert.equal(updated(guard(dir, 'sess-fan', AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low');
    // Then the starts, in an order unlike the spawn order.
    start(dir, 'sess-fan', 'agent-companion:ac-opus-low');
    start(dir, 'sess-fan', 'Explore');
    start(dir, 'sess-fan', 'general-purpose');
    start(dir, 'sess-fan', 'agent-companion:ac-opus-low');
    assert.equal(startsFor(stateDir, 'sess-fan').filter((r) => r.rewrite_ignored).length, 0);
    const st = JSON.parse(readFileSync(join(stateDir, 'state', 'ladder-rewrites.json'), 'utf8'))['sess-fan'];
    assert.equal(st.ignored, null);
    assert.deepEqual(st.pending, []); // each start consumed its own entry
    assert.equal(updated(guard(dir, 'sess-fan', AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low');
  } finally {
    cleanup();
  }
});

test('the same fan-out where one rewrite really ran as general-purpose: exactly that one is found ignored', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-fan2', 'agent-companion:ac-sonnet-low');
    seedArmed(stateDir, 'sess-fan2', TEN_MIN);
    guard(dir, 'sess-fan2', PLAIN_GP);
    guard(dir, 'sess-fan2', AUTOFILL_GP);
    guard(dir, 'sess-fan2', AUTOFILL_GP);
    // Two general-purpose starts (the plain spawn and one ignored rewrite), one rung start.
    start(dir, 'sess-fan2', 'general-purpose');
    start(dir, 'sess-fan2', 'agent-companion:ac-opus-low');
    start(dir, 'sess-fan2', 'general-purpose');
    const flagged = startsFor(stateDir, 'sess-fan2').filter((r) => r.rewrite_ignored);
    assert.equal(flagged.length, 1, JSON.stringify(flagged));
    assert.equal(flagged[0].rewrite_ignored, 'agent-companion:ac-opus-low');
    assert.match(msgOf(guard(dir, 'sess-fan2', AUTOFILL_GP)), /did not honour it; rewriting is off/);
  } finally {
    cleanup();
  }
});

test('a ladder spawn arms the session: plain spawns after it are recorded', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    guard(dir, 'sess-arm', { subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'ladder work' });
    guard(dir, 'sess-arm', PLAIN_GP);
    const st = JSON.parse(readFileSync(join(stateDir, 'state', 'ladder-rewrites.json'), 'utf8'))['sess-arm'];
    assert.equal(typeof st.armedAt, 'number');
    assert.deepEqual(st.pending.map((e) => [e.expect, e.rewrite]), [['ac-sonnet-low', false], ['general-purpose', false]]);
    // A session with no ladder spawn and no rewrite writes nothing.
    guard(dir, 'sess-unarmed', PLAIN_GP);
    const all = JSON.parse(readFileSync(join(stateDir, 'state', 'ladder-rewrites.json'), 'utf8'));
    assert.equal(all['sess-unarmed'], undefined);
  } finally {
    cleanup();
  }
});

test('advisory path: no ladder start in this session -> model filled in, subagent_type untouched, advisory names the rung', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    // A ladder start in ANOTHER session proves nothing about this one.
    seedStart(stateDir, 'sess-some-other', 'agent-companion:ac-opus-low');
    const res = guard(dir, 'sess-advisory', { subagent_type: 'general-purpose', prompt: 'TYPE: explore' });
    const u = updated(res);
    assert.equal(u?.subagent_type, 'general-purpose');
    assert.equal(u?.model, 'opus');
    const msg = msgOf(res);
    assert.match(msg, /effort not pinned/);
    assert.match(msg, /Spawn subagent_type "agent-companion:ac-opus-low" to pin opus\/low together/);
    assert.match(msg, /no ladder agent has started in this session, so the harness has not shown it registered the ladder here/);
    assert.doesNotMatch(msg, /SPAWNING RULE 1/); // the advisory replaces the generic note, not stacked on it
    assert.equal(rowFor(stateDir, 'sess-advisory').subagent_type_rewritten_to, null);
  } finally {
    cleanup();
  }
});

test('advisory path: a type with its own tools (Explore) is never swapped, even with ladder evidence', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-explore', 'agent-companion:ac-opus-low');
    const res = guard(dir, 'sess-explore', { subagent_type: 'Explore', prompt: 'TYPE: explore' });
    assert.equal(updated(res)?.subagent_type, 'Explore');
    assert.match(msgOf(res), /"Explore" has its own tools and prompt/);
  } finally {
    cleanup();
  }
});

test('advisory path: fit_autofill_ladder off disables the rewrite', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-opt-off', 'agent-companion:ac-opus-low');
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-opt-off', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'TYPE: explore', run_in_background: true, name: 'w' },
    }, { env: { CLAUDE_PLUGIN_OPTION_FIT_AUTOFILL_LADDER: 'false' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(updated(res)?.subagent_type, 'general-purpose');
    assert.match(msgOf(res), /fit_autofill_ladder option is off/);
  } finally {
    cleanup();
  }
});

test('new_agent_type source: ladder callers (bare and agent-companion:) are known types; another plugin\'s ac-* is not', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    for (const [i, t] of ['agent-companion:ac-opus-high', 'ac-sonnet-low', 'other-plugin:ac-opus-low'].entries()) {
      const res = runHook('hooks/spawn-guard.mjs', {
        session_id: `sess-caller-${i}`, agent_type: t, agent_id: `a${i}`, cwd: dir,
        tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'x', run_in_background: true, name: 'w' },
      });
      assert.equal(res.status, 0, res.stderr);
    }
    const seen = readJsonl(join(stateDir, 'telemetry', 'unknown-agent-types.jsonl')).map((r) => r.agent_type);
    assert.deepEqual(seen, ['other-plugin:ac-opus-low']);
  } finally {
    cleanup();
  }
});
// Round 5 (V4-1): continuing a worker with SendMessage fires SubagentStart
// again with the SAME agent_id and no Agent PreToolUse. A repeat start is no
// spawn: it concludes nothing, consumes nothing and writes nothing.
const REWRITES = (stateDir) => join(stateDir, 'state', 'ladder-rewrites.json');
function startAs(dir, sessionId, agentType, agentId, env = {}) {
  const res = runHook('hooks/spawn-log.mjs', { session_id: sessionId, agent_id: agentId, agent_type: agentType, cwd: dir, hook_event_name: 'SubagentStart' }, { env });
  assert.equal(res.status, 0, res.stderr);
}
function ageArming(stateDir, sessionId, ms) {
  const all = JSON.parse(readFileSync(REWRITES(stateDir), 'utf8'));
  all[sessionId].armedAt -= ms;
  writeFileSync(REWRITES(stateDir), JSON.stringify(all));
}
const FOUR_MIN = 4 * 60 * 1000;

test('a continued agent (repeat agent_id) while a rewrite is pending is never an ignored rewrite', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sid = 'sess-resumed';
    // A plain general-purpose worker, spawned and started before the session is armed.
    guard(dir, sid, { ...PLAIN_GP, name: 'w1' });
    startAs(dir, sid, 'general-purpose', 'agent-A');
    // A ladder worker arms the session and is the evidence; armed for 4 min.
    guard(dir, sid, { subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'ladder worker' });
    startAs(dir, sid, 'agent-companion:ac-sonnet-low', 'agent-L');
    ageArming(stateDir, sid, FOUR_MIN);
    // B is rewritten; the lead continues agent-A with SendMessage at the same moment.
    const b = updated(guard(dir, sid, AUTOFILL_GP))?.subagent_type;
    assert.equal(b, 'agent-companion:ac-opus-low');
    const before = readFileSync(REWRITES(stateDir), 'utf8');
    startAs(dir, sid, 'general-purpose', 'agent-A');
    assert.equal(readFileSync(REWRITES(stateDir), 'utf8'), before, 'a repeat start writes nothing');
    startAs(dir, sid, b, 'agent-B'); // B starts as the rung: the rewrite WAS honoured
    assert.ok(startsFor(stateDir, sid).every((r) => !r.rewrite_ignored));
    const st = JSON.parse(readFileSync(REWRITES(stateDir), 'utf8'))[sid];
    assert.equal(st.ignored, null);
    assert.deepEqual(st.pending, []);
    assert.equal(updated(guard(dir, sid, AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low', 'rewriting carries on');
  } finally {
    cleanup();
  }
});

test('many resumed general-purpose workers around a pending rewrite: none counts, and a real ignored rewrite is still found', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sid = 'sess-resumed-many';
    // Six plain workers: three before the session is armed, three after.
    for (let i = 0; i < 3; i++) { guard(dir, sid, { ...PLAIN_GP, name: `pre${i}` }); startAs(dir, sid, 'general-purpose', `pre-${i}`); }
    guard(dir, sid, { subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'ladder worker' });
    startAs(dir, sid, 'agent-companion:ac-sonnet-low', 'agent-L');
    for (let i = 0; i < 3; i++) { guard(dir, sid, { ...PLAIN_GP, name: `post${i}` }); startAs(dir, sid, 'general-purpose', `post-${i}`); }
    ageArming(stateDir, sid, FOUR_MIN);
    // Two rewrites pending; every worker is continued, some twice, in between.
    guard(dir, sid, AUTOFILL_GP);
    guard(dir, sid, AUTOFILL_GP);
    const ids = ['pre-0', 'post-0', 'pre-1', 'post-1', 'pre-2', 'post-2', 'pre-0', 'post-2', 'agent-L'];
    for (const id of ids) startAs(dir, sid, id === 'agent-L' ? 'agent-companion:ac-sonnet-low' : 'general-purpose', id);
    assert.ok(startsFor(stateDir, sid).every((r) => !r.rewrite_ignored), 'no continuation is an ignored rewrite');
    let st = JSON.parse(readFileSync(REWRITES(stateDir), 'utf8'))[sid];
    assert.equal(st.ignored, null);
    assert.equal(st.pending.filter((e) => e.rewrite).length, 2, 'both rewrites still pending: nothing consumed');
    // One rewrite honoured; the other really runs as general-purpose (a NEW agent_id).
    startAs(dir, sid, 'agent-companion:ac-opus-low', 'agent-R1');
    startAs(dir, sid, 'general-purpose', 'agent-R2');
    const flagged = startsFor(stateDir, sid).filter((r) => r.rewrite_ignored);
    assert.deepEqual(flagged.map((r) => r.agent_id), ['agent-R2']);
    // And a continuation of that one afterwards adds nothing.
    startAs(dir, sid, 'general-purpose', 'agent-R2');
    assert.equal(startsFor(stateDir, sid).filter((r) => r.rewrite_ignored).length, 1);
    st = JSON.parse(readFileSync(REWRITES(stateDir), 'utf8'))[sid];
    assert.equal(st.ignored.wanted, 'agent-companion:ac-opus-low');
  } finally {
    cleanup();
  }
});

test('with spawn_telemetry off, an agent started after arming and then continued is still known as a repeat', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sid = 'sess-resumed-notel';
    const env = { CLAUDE_PLUGIN_OPTION_SPAWN_TELEMETRY: 'false' };
    seedStart(stateDir, sid, 'agent-companion:ac-sonnet-low');
    guard(dir, sid, { subagent_type: 'agent-companion:ac-sonnet-low', prompt: 'ladder worker' });
    startAs(dir, sid, 'agent-companion:ac-sonnet-low', 'agent-L', env);
    guard(dir, sid, { ...PLAIN_GP, name: 'w1' });
    startAs(dir, sid, 'general-purpose', 'agent-A', env);
    ageArming(stateDir, sid, FOUR_MIN);
    assert.equal(updated(guard(dir, sid, AUTOFILL_GP))?.subagent_type, 'agent-companion:ac-opus-low');
    startAs(dir, sid, 'general-purpose', 'agent-A', env);
    const st = JSON.parse(readFileSync(REWRITES(stateDir), 'utf8'))[sid];
    assert.equal(st.ignored, null);
    assert.equal(st.pending.filter((e) => e.rewrite).length, 1);
  } finally {
    cleanup();
  }
});
