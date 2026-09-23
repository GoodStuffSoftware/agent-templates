// A subagent definition with no `effort` frontmatter INHERITS the
// orchestrating session's effort (per Claude Code's sub-agents docs), not
// any model default — so a spawn with no effort stated anywhere should be
// warned, on every effort-taking model, not just opus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

test('spawn resolving to opus with no effort anywhere gets the no-effort-stated warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-opus-no-effort',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        prompt: 'WARRANT: weight 5 — needs opus reasoning',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /resolves to opus with no effort stated/);
    assert.match(msg, /INHERIT/);
  } finally {
    cleanup();
  }
});

test('an EFFORT: line in the brief silences the no-effort-stated warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-opus-effort-stated',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        prompt: 'WARRANT: weight 5 — needs opus reasoning\nEFFORT: xhigh',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /resolves to opus with no effort stated/);
  } finally {
    cleanup();
  }
});

test('an agent definition with effort: set in frontmatter silences the no-effort-stated warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'architect.md'),
      '---\nname: architect\nmodel: opus\neffort: xhigh\n---\nbody\n',
    );
    const payload = {
      session_id: 'sess-opus-def-effort',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'architect',
        prompt: 'WARRANT: weight 5 — needs opus reasoning',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /resolves to opus with no effort stated/);
  } finally {
    cleanup();
  }
});

test('a sonnet spawn with no effort anywhere ALSO gets the warning — the hazard is not opus-only', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-sonnet-no-effort',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain sonnet spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /resolves to sonnet with no effort stated/);
  } finally {
    cleanup();
  }
});

test('a haiku spawn never gets the no-effort-stated warning — it takes no effort parameter', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-haiku-no-effort',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'haiku', prompt: 'a quick read' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /no effort stated/);
  } finally {
    cleanup();
  }
});
