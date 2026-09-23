// SPAWNING RULE (operator-approved 2026-09-23), rules 1 and 2, enforced at
// spawn time in hooks/spawn-guard.mjs (rule 3 — resolved-model verification
// — lives in the audit; see tests/model-mismatch.test.mjs).
//
//   1. Every spawn names a definition that states BOTH model and effort. A
//      spawn with no model, or a definition with no effort, inherits the
//      lead's model and effort and counts as a violation. (The "no effort"
//      half is covered by tests/opus-effort-warning.test.mjs already; this
//      file covers the "no model at all" half, which previously had NO
//      warning when the brief declared no WEIGHT — fit_autofill only runs
//      off a declared weight, so a plain unweighted, unmodelled spawn
//      produced silence.)
//   2. Build check before opus-tier work: if the SESSION's Claude Code build
//      is below aliasResolution.minClaudeCodeVersion, restart before
//      spawning. Read from the CALLING session's own transcript (a
//      `version` field every harness-written record carries), never from
//      `claude --version` — a session keeps the build it started with,
//      which can differ from what's on PATH (the desktop app bundles its
//      own build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

function transcriptWithVersion(dir, version, name = 'transcript.jsonl') {
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify({
    type: 'user',
    version,
    timestamp: '2026-09-23T10:00:00.000Z',
    message: { role: 'user', content: 'hi' },
  })}\n`);
  return p;
}

// --- Rule 1, missing-model half --------------------------------------------

test('spawn with no model anywhere and no declared WEIGHT gets the missing-model warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-no-model',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'do a thing, no weight stated' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /SPAWNING RULE 1/);
    assert.match(msg, /names no model, and its definition/);
  } finally {
    cleanup();
  }
});

test('spawn with no model but a declared WEIGHT gets the (different) autofill note instead, not a duplicate', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-no-model-weighted',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'WARRANT: weight 1 — a quick read' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /named no model; set model=/); // the existing autofill note
    assert.doesNotMatch(msg, /names no model, and its definition/); // not layered on top
  } finally {
    cleanup();
  }
});

test('spawn with a model named at the spawn site never gets the missing-model warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-model-named',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'plain sonnet spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /names no model, and its definition/);
  } finally {
    cleanup();
  }
});

// --- Rule 2, build-version floor --------------------------------------------

test('opus spawn from a session on a build below the alias-resolution floor gets the build-floor warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithVersion(dir, '2.1.275');
    const payload = {
      session_id: 'sess-below-floor',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true,
        prompt: 'WARRANT: weight 5 — deep architecture work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.match(msg, /SPAWNING RULE 2/);
    assert.match(msg, /2\.1\.275/);
    assert.match(msg, /2\.1\.280/); // the floor itself, named
    assert.match(msg, /Restart the session/);
  } finally {
    cleanup();
  }
});

test('opus spawn from a session AT the floor gets no build-floor warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithVersion(dir, '2.1.280');
    const payload = {
      session_id: 'sess-at-floor',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true,
        prompt: 'WARRANT: weight 5 — deep architecture work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /SPAWNING RULE 2/);
  } finally {
    cleanup();
  }
});

test('opus spawn from a session ABOVE the floor gets no build-floor warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithVersion(dir, '2.1.290');
    const payload = {
      session_id: 'sess-above-floor',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true,
        prompt: 'WARRANT: weight 5 — deep architecture work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /SPAWNING RULE 2/);
  } finally {
    cleanup();
  }
});

test('sonnet spawn from a below-floor session gets NO build-floor warning — scoped to opus/fable only', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = transcriptWithVersion(dir, '2.1.275');
    const payload = {
      session_id: 'sess-sonnet-below-floor',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, prompt: 'plain sonnet spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /SPAWNING RULE 2/);
  } finally {
    cleanup();
  }
});

test('opus spawn with an UNREADABLE transcript (no transcript_path at all) stays silent — "unknown", never guessed', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-no-transcript',
      agent_type: 'main',
      cwd: dir,
      // deliberately no transcript_path
      tool_input: {
        subagent_type: 'general-purpose', model: 'opus', run_in_background: true,
        prompt: 'WARRANT: weight 5 — deep architecture work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /SPAWNING RULE 2/);
  } finally {
    cleanup();
  }
});

// --- No false warning on a well-formed spawn --------------------------------

test('a well-formed spawn (named definition stating model+effort, current build, weight declared) gets no SPAWNING RULE warning', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'ac-opus-high.md'),
      '---\nname: ac-opus-high\nmodel: opus\neffort: high\n---\nbody\n',
    );
    const transcriptPath = transcriptWithVersion(dir, '2.1.290');
    const payload = {
      session_id: 'sess-well-formed',
      agent_type: 'main',
      cwd: dir,
      transcript_path: transcriptPath,
      tool_input: {
        subagent_type: 'ac-opus-high', run_in_background: true, name: 'well-formed-worker',
        prompt: 'WARRANT: weight 5 — deep architecture work needing opus',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, res.stderr);
    const msg = res.json?.systemMessage || '';
    assert.doesNotMatch(msg, /SPAWNING RULE/);
  } finally {
    cleanup();
  }
});
