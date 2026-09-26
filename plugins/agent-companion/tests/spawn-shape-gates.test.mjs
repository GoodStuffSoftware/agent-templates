// Gates 1-3 on hooks/spawn-guard.mjs: spawn SHAPE (foreground/background,
// teammate/subagent, shared-tree/isolated), orthogonal to the existing
// model-TIER checks (fit/warrant/premium-cap) covered elsewhere.
//
// Real-corpus baseline these gates were sized against
// (~/.claude/agent-companion/telemetry/spawns.jsonl, 196 rows carrying
// run_in_background): 148 main-session-foreground (raw Gate 1 applicable),
// 19 of those haiku-tier (exempt), 8 name+isolation (Gate 2), 52
// unnamed-and-unisolated (Gate 3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

test('gate1 (foreground guard): warn is the default and fires for a plain main-session foreground spawn', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-warn',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', name: 'isolate-from-gate3',
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow');
    assert.match(res.json?.systemMessage || '', /FOREGROUND/);
    assert.match(res.json?.systemMessage || '', /not Anthropic guidance/i);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_mode, 'warn');
    assert.equal(row.gate1_applicable, true);
    assert.equal(row.gate1_exempt, false);
    assert.equal(row.gate1_action, 'warn');
  } finally {
    cleanup();
  }
});

test('gate1: resolved haiku-tier model is exempt (cheapest known tier)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-exempt',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'claude-haiku-4-5', name: 'isolate-from-gate3',
        prompt: 'quick lookup',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow');
    assert.equal(res.json?.systemMessage, undefined, 'an exempt haiku-tier spawn must add no gate1 message');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_applicable, true);
    assert.equal(row.gate1_exempt, true);
    assert.equal(row.gate1_action, 'none');
  } finally {
    cleanup();
  }
});

test('gate1: run_in_background true is not applicable', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-bg',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', name: 'x', run_in_background: true,
        prompt: 'backgrounded work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /FOREGROUND/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_applicable, false);
    assert.equal(row.gate1_action, 'none');
  } finally {
    cleanup();
  }
});

test('gate1: caller is itself a subagent is not applicable, regardless of run_in_background', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-subcaller',
      agent_type: 'subagent',
      agent_id: 'agent-caller-1',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', name: 'x', prompt: 'nested spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /FOREGROUND/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.caller_is_subagent, true);
    assert.equal(row.gate1_applicable, false);
    assert.equal(row.gate1_action, 'none');
  } finally {
    cleanup();
  }
});

test('gate1: mode "off" disables the gate even for an applicable, non-exempt spawn', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-off',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', name: 'x', prompt: 'do the thing' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'off' },
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /FOREGROUND/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_mode, 'off');
    assert.equal(row.gate1_applicable, true);
    assert.equal(row.gate1_action, 'none');
  } finally {
    cleanup();
  }
});

test('gate1: mode "block" denies an unjustified foreground spawn and records guard "foreground"', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-block-deny',
      agent_type: 'main',
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', name: 'x', prompt: 'do the thing, no justification' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(res.json?.hookSpecificOutput?.permissionDecisionReason || '', /FOREGROUND:/);

    // Telemetry row is still written before the deny, same as fit/warrant/cap.
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_action, 'block');

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 1);
    assert.equal(denials[0].guard, 'foreground');
    assert.equal(denials[0].outcome, 'deny');
  } finally {
    cleanup();
  }
});

test('gate1: mode "block" allows a spawn whose brief carries a FOREGROUND justification', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g1-block-justified',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', name: 'x',
        prompt: 'FOREGROUND: need this before the lead can continue\ndo the thing',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate1_action, 'none');

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 0);
  } finally {
    cleanup();
  }
});

test('gate2 (isolation demotion notice): fires only when BOTH name and isolation are set, cites agent-teams.md', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g2-fire',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', name: 'probe-agent', isolation: 'worktree',
        run_in_background: true, // isolate from gate1's message
        prompt: 'isolated work',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.match(res.json?.systemMessage || '', /ordinary subagent/i);
    assert.match(res.json?.systemMessage || '', /agent-teams\.md/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate2_fired, true);
  } finally {
    cleanup();
  }
});

test('gate2: does not fire with only one of name/isolation set, and can be toggled off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const nameOnly = {
      session_id: 'sess-g2-name-only',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', name: 'x', run_in_background: true, prompt: 'p' },
    };
    const isoOnly = {
      session_id: 'sess-g2-iso-only',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', isolation: 'worktree', run_in_background: true, prompt: 'p' },
    };
    for (const payload of [nameOnly, isoOnly]) {
      const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
      assert.equal(res.status, 0);
      assert.doesNotMatch(res.json?.systemMessage || '', /ordinary subagent/i);
    }

    const toggledOff = {
      session_id: 'sess-g2-toggle-off',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', name: 'probe', isolation: 'worktree',
        run_in_background: true, prompt: 'p',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', toggledOff, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_ISOLATION_DEMOTION_NOTICE: 'false' },
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /ordinary subagent/i);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const row = rows.find((r) => r.session_id === 'sess-g2-toggle-off');
    assert.equal(row.gate2_fired, false, 'toggled off: gate2_fired must be false even though name+isolation are both set');
  } finally {
    cleanup();
  }
});

test('gate3 (shared-tree notice): fires only when BOTH name and isolation are absent', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-g3-fire',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, // isolate from gate1
        prompt: 'unnamed, unisolated work',
      },
    };
    // namegate off: this test isolates Gate 3 from Gate 4 (namegate), which
    // by default would autofill a name for this exact shape (main session,
    // explicitly background, no name) and legitimately suppress Gate 3 —
    // see spawn-namegate.test.mjs for that interaction.
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_NAMEGATE: 'false' },
    });
    assert.equal(res.status, 0);
    assert.match(res.json?.systemMessage || '', /own working tree/i);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate3_fired, true);
  } finally {
    cleanup();
  }
});

test('gate3: naming the spawn suppresses it even without isolation, and it can be toggled off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const named = {
      session_id: 'sess-g3-named',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', name: 'x', run_in_background: true, prompt: 'p' },
    };
    const res1 = runHook('hooks/spawn-guard.mjs', named, { env: baseEnv(dir) });
    assert.equal(res1.status, 0);
    assert.doesNotMatch(res1.json?.systemMessage || '', /own working tree/i);

    const toggledOff = {
      session_id: 'sess-g3-toggle-off',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, prompt: 'p' },
    };
    const res2 = runHook('hooks/spawn-guard.mjs', toggledOff, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_SHARED_TREE_NOTICE: 'false' },
    });
    assert.equal(res2.status, 0);
    assert.doesNotMatch(res2.json?.systemMessage || '', /own working tree/i);

    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    assert.equal(rows.find((r) => r.session_id === 'sess-g3-named').gate3_fired, false);
    assert.equal(rows.find((r) => r.session_id === 'sess-g3-toggle-off').gate3_fired, false);
  } finally {
    cleanup();
  }
});

test('regression: fit-autofill + premium warrant + memory nudge + gates all coexist behind exactly one updatedInput', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-regression-merge',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        // No model named: fit_autofill must set one from the routing table.
        // WARRANT: doubles as the WEIGHT declaration AND the premium warrant.
        prompt: 'WARRANT: weight 5 — architecture-level change, needs deep reasoning\ndo the big thing',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: {
        ...baseEnv(dir),
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_BRIEF: 'true',
        CLAUDE_PLUGIN_OPTION_MEMORY_SEARCH_REPO: 'false',
      },
    });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(res.json));

    // Exactly one updatedInput object, carrying every feature's contribution.
    const out = res.json.hookSpecificOutput;
    assert.equal(Object.keys(out).filter((k) => k === 'updatedInput').length, 1);
    assert.ok(out.updatedInput, 'updatedInput must be present (autofill sets the model)');
    assert.equal(out.updatedInput.model, 'opus', 'weight 5 must autofill to the routing table\'s opus');

    const rewrittenPrompt = String(out.updatedInput.prompt || '');
    assert.match(rewrittenPrompt, /STATUS:/i, 'the brevity reporting contract must still be injected');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.model_autofilled, true);
    assert.equal(row.declared_weight, 5);
    assert.equal(row.memory_addition_mode, 'nudge', 'memory nudge must still run alongside the gates');
    // This spawn is unnamed and unisolated, so gate3 fires alongside everything else.
    assert.equal(row.gate3_fired, true);
    assert.match(res.json.systemMessage || '', /own working tree/i);

    // Premium + weight-5 + WARRANT present -> no warrant denial.
    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 0, `expected no denials: ${JSON.stringify(denials)}`);
  } finally {
    cleanup();
  }
});
