// Ladder track (0292), item 1: when a ladder-registration failure pushes a
// caller into spawning a non-ladder built-in type (general-purpose etc.) with
// an EXPLICIT model that differs from the lead's own current model, the
// effort half of the pair is silently lost — a built-in type has no `effort`
// frontmatter, so it inherits the orchestrating session's effort with no
// warning that named THIS as the actual hazard. This is an advisory only
// (spawn-guard.mjs never denies on it); see hooks/spawn-guard.mjs's
// `isNonLadderExplicitEscalation`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

function transcriptWithModel(dir, model, effort) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
    effort,
    timestamp: '2026-09-24T10:00:00.000Z',
  })}\n`);
  return p;
}

test('non-ladder type + explicit model differing from the lead + no effort: the specific advisory fires, naming the inherited effort', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithModel(dir, 'claude-sonnet-4-6', 'high');
    const payload = {
      session_id: 'sess-ladder-escalation',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'ac-opus-low would not spawn (registration failure), falling back to general-purpose with model: opus',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /effort not set/);
    assert.match(msg, /is not a ladder agent/);
    assert.match(msg, /inherits the session's effort \(high\)/);
    assert.doesNotMatch(msg, /SPAWNING RULE 1/);
  } finally {
    cleanup();
  }
});

test('when the lead\'s own effort cannot be read, the advisory says so instead of guessing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // A transcript with a model but no top-level `effort` field on the record.
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }] },
      timestamp: '2026-09-24T10:00:00.000Z',
    })}\n`);
    const payload = {
      session_id: 'sess-ladder-escalation-unknown-effort',
      agent_type: 'main',
      cwd: dir,
      transcript_path: p,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'fallback spawn',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /effort not set/);
    assert.match(msg, /unknown — the lead's own effort could not be read/);
  } finally {
    cleanup();
  }
});

test('a LADDER agent type explicitly named (even if its local def cannot be found) does NOT get the non-ladder advisory', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithModel(dir, 'claude-sonnet-4-6', 'high');
    const payload = {
      session_id: 'sess-ladder-type-named',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'ac-opus-low', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'named the ladder rung directly',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /is not a ladder agent/);
    // Still falls to the generic rule-1 note (no local agents/ac-opus-low.md
    // in this fixture to supply `effort:`), just not the escalation-specific one.
    assert.match(msg, /SPAWNING RULE 1/);
  } finally {
    cleanup();
  }
});

test('the namespaced form (agent-companion:ac-opus-low) is also recognised as a ladder agent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithModel(dir, 'claude-sonnet-4-6', 'high');
    const payload = {
      session_id: 'sess-ladder-type-namespaced',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'agent-companion:ac-opus-low', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'named the namespaced ladder rung',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /is not a ladder agent/);
  } finally {
    cleanup();
  }
});

test('no escalation note when the caller\'s own model cannot be determined at all (no transcript)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-no-caller-model',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'no transcript at all',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /is not a ladder agent/);
    assert.match(msg, /SPAWNING RULE 1/); // generic note still fires
  } finally {
    cleanup();
  }
});

test('no escalation note when the explicit model matches the lead\'s own model (no escalation happened)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // Caller is itself running opus; a general-purpose spawn also names opus —
    // same tier, not an escalation, even though general-purpose is non-ladder.
    const transcriptPath = transcriptWithModel(dir, 'claude-opus-5-5', 'medium');
    const payload = {
      session_id: 'sess-same-model',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w1',
        prompt: 'same tier as the lead',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /is not a ladder agent/);
    assert.match(msg, /SPAWNING RULE 1/);
  } finally {
    cleanup();
  }
});
