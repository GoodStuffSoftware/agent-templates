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

test('rewrite path uses the exact form that started: a bare ladder start rewrites to the bare rung; unnamed spawns too', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    seedStart(stateDir, 'sess-rewrite-bare', 'ac-opus-high');
    const res = guard(dir, 'sess-rewrite-bare', { prompt: 'TYPE: explore' });
    assert.equal(updated(res)?.subagent_type, 'ac-opus-low');
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
    assert.match(msg, /no ladder agent has started in this session yet/);
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