// Regression: a run_in_background call is recorded as background, never as a finished exit 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { exitOf } from '../hooks/lib/bash-exit.mjs';

const rowsOf = (fx) => {
  const f = join(fx.stateDir, 'telemetry', 'bash-exit.jsonl');
  return existsSync(f) ? readJsonl(f) : [];
};
const post = (tool_name) => ({ session_id: 'sess-bg', hook_event_name: 'PostToolUse', tool_name,
  tool_input: { command: 'npm test SECRET-CMD', run_in_background: true },
  tool_response: { stdout: 'Command running in background with ID: bx1 SECRET-OUT', stderr: '', interrupted: false } });

for (const tool of ['Bash', 'PowerShell']) {
  test(`run_in_background ${tool} call -> background:true, exit:null, no command or output text`, () => {
    const fx = makeFixture();
    try {
      runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post(tool) });
      const [row] = rowsOf(fx);
      assert.equal(row.background, true);
      assert.equal(row.exit, null);
      assert.equal(row.failed, false);
      assert.ok(!JSON.stringify(row).includes('SECRET'));
    } finally { fx.cleanup(); }
  });
}

test('a foreground call has no background field', () => {
  const fx = makeFixture();
  try {
    const p = post('Bash');
    p.tool_input.run_in_background = false;
    runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...p });
    const [row] = rowsOf(fx);
    assert.equal(row.exit, 0);
    assert.equal('background' in row, false);
  } finally { fx.cleanup(); }
});

test('exitOf: background wins over a success payload', () => {
  assert.deepEqual(exitOf(post('Bash')), { exit: null, failed: false, interrupted: false, background: true });
});
