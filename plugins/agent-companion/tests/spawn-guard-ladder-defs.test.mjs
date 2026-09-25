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
import { mkdirSync, writeFileSync } from 'node:fs';
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

test('an ignored rewrite is detected at SubagentStart and turns rewriting off for the rest of the session', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-ignored', 'agent-companion:ac-sonnet-low');
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