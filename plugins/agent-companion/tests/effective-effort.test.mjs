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
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
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
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
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
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, 'inherited(unknown)');
  } finally { cleanup(); }
});

test('haiku spawn with no effort anywhere: effective_effort is inherited(unknown) (Haiku 5.5 takes an effort)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-haiku', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'a quick read' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, 'inherited(unknown)');
  } finally { cleanup(); }
});

// The effortless-model arm of the guard (hooks/spawn-guard.mjs noEffortModel) is reachable
// for any tier whose efforts list is empty. Haiku 5.5 takes an effort, so stage haiku as
// effortless through the state-dir override (as route-floors.test.mjs does).
test('a model whose tier takes no effort parameter: effective_effort is null', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({ tiers: { haiku: { efforts: [] } } }));
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-eff-none', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'a quick read' },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PROJECT_EFFORT_FILL: 'off' } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.effective_effort, null);
  } finally { cleanup(); }
});
