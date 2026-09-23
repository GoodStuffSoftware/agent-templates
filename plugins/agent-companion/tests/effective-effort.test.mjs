// effective_effort on spawns.jsonl: what will ACTUALLY run, for a later join
// against transcript output_tokens to get tokens-per-effort per model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

test('agent definition with an explicit effort: effective_effort equals it verbatim', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'definer.md'), '---\nname: definer\nmodel: opus\neffort: xhigh\n---\nbody\n');
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-def', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'definer', prompt: 'WARRANT: weight 5 — needs opus' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, 'xhigh');
  } finally { cleanup(); }
});

test('opus spawn with no effort anywhere: effective_effort is inherited(<caller effort>), not a model default', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }] },
      effort: 'high',
      timestamp: '2026-09-23T10:00:00.000Z',
    })}\n`);
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-opus-unset', agent_type: 'main', cwd: dir, transcript_path: transcriptPath,
      tool_input: { subagent_type: 'general-purpose', model: 'opus', prompt: 'WARRANT: weight 5 — needs opus' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, 'inherited(high)');
  } finally { cleanup(); }
});

test('opus spawn with no effort anywhere and no readable caller transcript: effective_effort is inherited(unknown)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-opus-unknown', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'opus', prompt: 'WARRANT: weight 5 — needs opus' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, 'inherited(unknown)');
  } finally { cleanup(); }
});

test('haiku spawn: effective_effort is null (model takes no effort parameter)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-haiku', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'a quick read' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, null);
  } finally { cleanup(); }
});
