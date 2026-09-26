// Gate 4 (namegate) on hooks/spawn-guard.mjs: track "namegate", operator
// decision 2026-09-25 — "every background worker gets a name". Scope: a
// MAIN-session spawn that runs in the background (explicit
// run_in_background: true — see spawn-guard.mjs's own comment on why an
// absent field is not treated as background) with no name. Never blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

test('namegate: background + no name -> hint AND autofill (default on)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-autofill',
      agent_type: 'main',
      cwd: join(dir, 'my-project'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'probe thing', prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, `exited ${res.status}: ${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', 'namegate never blocks');
    assert.match(res.json?.systemMessage || '', /namegate/i);

    const assignedName = res.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(assignedName, 'updatedInput.name must be set');
    assert.match(assignedName, /^[A-Za-z0-9._-]+$/, 'name must be sanitised to the safe character set');
    assert.match(assignedName, /^my-project-general-purpose-probe-thing/);

    // Brief boilerplate: names the worker itself, main as lead, peers.
    const prompt = res.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt, new RegExp(`worker \`${assignedName}\``));
    assert.match(prompt, /lead is `main`/);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, true);
    assert.equal(row.gate4_action, 'autofill');
    assert.equal(row.name_autofilled, true);
    assert.equal(row.name_effective, assignedName);
  } finally {
    cleanup();
  }
});

test('namegate: background + name already set -> untouched', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-named',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, name: 'already-named',
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    // The reporting-contract feature (unrelated to namegate) sets
    // updatedInput on every spawn regardless; what must be untouched here is
    // specifically the `name` — namegate must never override one already given.
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, 'already-named');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
    assert.equal(row.name_autofilled, false);
    assert.equal(row.name_effective, 'already-named');
  } finally {
    cleanup();
  }
});

test('namegate: foreground (no run_in_background field at all) + no name -> untouched', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-foreground',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'foreground work' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false, 'an absent run_in_background field is never treated as background');
    assert.equal(row.gate4_action, 'none');
    assert.equal(row.name_autofilled, false);
  } finally {
    cleanup();
  }
});

test('namegate: subagent-origin caller is out of scope, even background + no name', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-subcaller',
      agent_type: 'subagent',
      agent_id: 'agent-caller-1',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true, prompt: 'nested spawn' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.caller_is_subagent, true);
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
  } finally {
    cleanup();
  }
});

test('namegate: two collision-shaped spawns in the same session get distinct names, and the second lists the first as a peer', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const makePayload = () => ({
      session_id: 'sess-ng-collision',
      agent_type: 'main',
      cwd: join(dir, 'proj'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'same task', prompt: 'do a bounded task',
      },
    });
    const res1 = runHook('hooks/spawn-guard.mjs', makePayload(), { env: baseEnv(dir) });
    const name1 = res1.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name1);

    const res2 = runHook('hooks/spawn-guard.mjs', makePayload(), { env: baseEnv(dir) });
    const name2 = res2.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name2);
    assert.notEqual(name1, name2, 'uniqueness within the session: the second spawn must not collide with the first');
    assert.match(name2, /-2$/, 'first collision resolves to a -2 suffix');

    const prompt2 = res2.json?.hookSpecificOutput?.updatedInput?.prompt || '';
    assert.match(prompt2, new RegExp(name1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'peer list names the first worker');
  } finally {
    cleanup();
  }
});

test('namegate: slug sanitising — special characters and length are capped to [A-Za-z0-9._-]', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-sanitise',
      agent_type: 'main',
      cwd: join(dir, 'a weird/project name!!'),
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        description: 'a VERY long description with lots of words that keeps going and going and going well past any reasonable cap #$%^&*()',
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    const name = res.json?.hookSpecificOutput?.updatedInput?.name;
    assert.ok(name);
    assert.match(name, /^[A-Za-z0-9._-]+$/);
    assert.ok(name.length <= 60, `name must be capped in length, got ${name.length}: ${name}`);
  } finally {
    cleanup();
  }
});

test('namegate: namegate_autofill=false gives the hint only, never rewrites', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-hint-only',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_NAMEGATE_AUTOFILL: 'false' },
    });
    assert.equal(res.status, 0);
    assert.match(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined, 'hint-only must not set a name');

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, true);
    assert.equal(row.gate4_action, 'hint');
    assert.equal(row.name_autofilled, false);
  } finally {
    cleanup();
  }
});

test('namegate: namegate=false disables the whole gate (no hint, no autofill)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-ng-off',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose', model: 'sonnet', run_in_background: true,
        prompt: 'do a bounded task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { ...baseEnv(dir), CLAUDE_PLUGIN_OPTION_NAMEGATE: 'false' },
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.json?.systemMessage || '', /namegate/i);
    assert.equal(res.json?.hookSpecificOutput?.updatedInput?.name, undefined);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.gate4_applicable, false);
    assert.equal(row.gate4_action, 'none');
  } finally {
    cleanup();
  }
});
