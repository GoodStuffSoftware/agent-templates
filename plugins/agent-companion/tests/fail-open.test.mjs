import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';

test('spawn-guard fails open when the state dir path is unwritable (a file, not a dir)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // Point AGENT_COMPANION_STATE_DIR at a path that is a FILE, so every
    // mkdirSync(..., {recursive:true}) inside the resolvers throws.
    const blocker = join(dir, 'blocked-state-dir');
    writeFileSync(blocker, 'this is a file, not a directory');
    process.env.AGENT_COMPANION_STATE_DIR = blocker;

    const payload = {
      session_id: 'sess-failopen-1',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'do the thing' },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });

    assert.equal(res.status, 0, `spawn-guard must exit 0 even when its state dir is unwritable: stderr=${res.stderr}`);
    assert.ok(res.json, `spawn-guard must still emit a decision: stdout=${res.stdout} stderr=${res.stderr}`);
    assert.equal(res.json?.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.ok(
      ['allow', 'deny'].includes(res.json?.hookSpecificOutput?.permissionDecision),
      `expected an allow/deny decision, got ${JSON.stringify(res.json)}`,
    );
  } finally {
    cleanup();
  }
});

test('delegation-guard fails open the same way', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const blocker = join(dir, 'blocked-state-dir-2');
    writeFileSync(blocker, 'file, not a directory');
    process.env.AGENT_COMPANION_STATE_DIR = blocker;

    const payload = { session_id: 'sess-failopen-2', agent_type: 'main', tool_name: 'Bash', cwd: dir };
    const res = runHook('hooks/delegation-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });

    assert.equal(res.status, 0, `delegation-guard must exit 0 even when its state dir is unwritable: stderr=${res.stderr}`);
  } finally {
    cleanup();
  }
});
