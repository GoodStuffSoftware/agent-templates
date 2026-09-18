import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function fakeTranscript(path, { model, effort }) {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-09-18T10:00:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
      effort,
      timestamp: '2026-09-18T10:00:05.000Z',
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

test('spawns.jsonl v2 fields: run_in_background/isolation/name/team_name/desc_sha/desc_len/caller_*', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    fakeTranscript(transcriptPath, { model: 'claude-opus-4-6', effort: 'high' });

    const description = 'a test description for hashing';
    const payload = {
      session_id: 'sess-v2-1',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose',
        prompt: 'do the thing',
        run_in_background: true,
        isolation: 'worktree',
        name: 'probe-agent',
        team_name: 'probe-team',
        description,
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, `spawn-guard exited ${res.status}: ${res.stderr}`);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];

    assert.equal(row.v, 2);
    assert.equal(row.run_in_background, true);
    assert.equal(row.isolation, 'worktree');
    assert.equal(row.name, 'probe-agent');
    assert.equal(row.team_name, 'probe-team');
    assert.equal(row.desc_len, description.length);
    const expectedSha = createHash('sha256').update(description).digest('hex').slice(0, 16);
    assert.equal(row.desc_sha, expectedSha);
    assert.equal(row.caller_is_subagent, false);
    assert.equal(row.caller_agent_id, null);
    assert.equal(row.caller_model, 'claude-opus-4-6');
    assert.equal(row.caller_effort, 'high');
    assert.ok(!('effort' in row), 'v1 `effort` field must not appear on a v2 row');
  } finally {
    cleanup();
  }
});

test('null fields when the payload carries none of the optional inputs', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-v2-2',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'plain spawn, no extras' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.run_in_background, null);
    assert.equal(row.isolation, null);
    assert.equal(row.name, null);
    assert.equal(row.team_name, null);
    assert.equal(row.desc_sha, null);
    assert.equal(row.desc_len, null);
    assert.equal(row.caller_model, null);
    assert.equal(row.caller_effort, null);
  } finally {
    cleanup();
  }
});

test('spawn_effort_source: definition | inherited | none', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    fakeTranscript(transcriptPath, { model: 'claude-sonnet-4-6', effort: 'medium' });

    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'definer.md'),
      '---\nname: definer\nmodel: sonnet\neffort: high\n---\nbody\n',
    );
    writeFileSync(
      join(agentsDir, 'inheritor.md'),
      '---\nname: inheritor\nmodel: sonnet\n---\nbody\n',
    );
    writeFileSync(
      join(agentsDir, 'haiku-runner.md'),
      '---\nname: haiku-runner\nmodel: haiku\n---\nbody\n',
    );

    const cases = [
      { sid: 'sess-v2-def', subagent_type: 'definer', expectSource: 'definition', expectEffort: 'high' },
      { sid: 'sess-v2-inh', subagent_type: 'inheritor', expectSource: 'inherited', expectEffort: 'medium' },
      { sid: 'sess-v2-haiku', subagent_type: 'haiku-runner', expectSource: 'none', expectEffort: null },
    ];

    for (const c of cases) {
      const payload = {
        session_id: c.sid,
        agent_type: 'main',
        cwd: dir,
        transcript_path: transcriptPath,
        tool_input: { subagent_type: c.subagent_type, prompt: 'do the thing' },
      };
      const res = runHook('hooks/spawn-guard.mjs', payload, {
        env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
      });
      assert.equal(res.status, 0, `spawn-guard exited ${res.status} for ${c.sid}: ${res.stderr}`);
    }

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    for (const c of cases) {
      const row = rows.find((r) => r.session_id === c.sid);
      assert.ok(row, `no row for ${c.sid}`);
      assert.equal(row.spawn_effort_source, c.expectSource, `${c.sid}: spawn_effort_source`);
      assert.equal(row.spawn_effort, c.expectEffort, `${c.sid}: spawn_effort`);
    }
  } finally {
    cleanup();
  }
});

test('caller is a sub-agent: caller_model comes from the NESTED agent transcript, not the parent', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    // Parent (top-level) transcript: a different model, so we can tell which
    // file caller_model actually came from.
    const parentTranscript = join(dir, 'parent-session.jsonl');
    fakeTranscript(parentTranscript, { model: 'claude-parent-should-not-be-used', effort: 'low' });

    // Nested per-agent transcript, at the exact path callerTranscriptPath()
    // constructs: <dirname>/<basename-without-.jsonl>/subagents/agent-<id>.jsonl
    const agentId = 'agent-race-77';
    const nestedDir = join(dir, 'parent-session', 'subagents');
    mkdirSync(nestedDir, { recursive: true });
    const nestedTranscript = join(nestedDir, `agent-${agentId}.jsonl`);
    fakeTranscript(nestedTranscript, { model: 'claude-nested-sub-agent-model', effort: 'xhigh' });

    const payload = {
      session_id: 'sess-v2-subagent-caller',
      agent_type: 'subagent',
      agent_id: agentId,
      cwd: dir,
      transcript_path: parentTranscript, // no agent_transcript_path: forces the nested-path construction
      tool_input: { subagent_type: 'general-purpose', prompt: 'a sub-agent spawning another agent' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, `spawn-guard exited ${res.status}: ${res.stderr}`);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.caller_is_subagent, true);
    assert.equal(row.caller_agent_id, agentId);
    assert.equal(row.caller_model, 'claude-nested-sub-agent-model', 'caller_model must come from the NESTED transcript, not the parent');
    assert.equal(row.caller_effort, 'xhigh');
  } finally {
    cleanup();
  }
});

test('transcript with no assistant record in the tail window: caller_model/caller_effort are null, no throw', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const transcriptPath = join(dir, 'no-assistant-in-tail.jsonl');

    // A real assistant record exists, but it is followed by enough filler to
    // push it entirely out of the 128 KB tail-read window.
    const earlyAssistant = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-should-be-out-of-window', content: [{ type: 'text', text: 'old' }] },
      effort: 'high',
      timestamp: '2026-09-18T09:00:00.000Z',
    });
    const fillerLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) }, timestamp: '2026-09-18T09:30:00.000Z' });
    // ~200KB of filler lines, comfortably over the 128KB tail-read window.
    const fillerCount = Math.ceil((200 * 1024) / (fillerLine.length + 1));
    const filler = Array.from({ length: fillerCount }, () => fillerLine);

    writeFileSync(transcriptPath, `${[earlyAssistant, ...filler].join('\n')}\n`);

    const payload = {
      session_id: 'sess-v2-no-assistant-tail',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: { subagent_type: 'general-purpose', prompt: 'no assistant record in the tail window' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, `spawn-guard must not throw: ${res.stderr}`);
    assert.equal(res.stderr, '', 'spawn-guard must not write to stderr');

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.caller_model, null);
    assert.equal(row.caller_effort, null);
  } finally {
    cleanup();
  }
});
