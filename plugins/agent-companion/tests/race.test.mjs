import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, readJsonl, PLUGIN_ROOT } from './helpers.mjs';

// 8 concurrent processes all report the SAME brand-new agent_type via
// spawn-log.mjs (SubagentStart -> noteAgentType()). The old read-check-append
// had no lock: several could pass the "already seen?" check before any of
// them had appended, producing more than one row for one type. The wx-marker
// mechanism must let exactly one process win.
test('noteAgentType: 8 concurrent processes, same new type -> exactly 1 row and 1 marker', async () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const script = join(PLUGIN_ROOT, 'hooks', 'spawn-log.mjs');
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
    const N = 8;
    const agentType = 'race-probe-agent-type';

    const runs = Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
      child.stdin.write(JSON.stringify({
        session_id: `sess-race-${i}`,
        agent_id: `agent-race-${i}`,
        agent_type: agentType,
        cwd: dir,
      }));
      child.stdin.end();
    }));

    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.code, 0, `spawn-log exited ${r.code}: ${r.stderr}`);

    const rows = readJsonl(join(stateDir, 'telemetry', 'unknown-agent-types.jsonl'))
      .filter((r) => r.agent_type === agentType);
    assert.equal(rows.length, 1, `expected exactly 1 row for ${agentType}, got ${rows.length}`);

    const markersDir = join(stateDir, 'state', 'agent-types');
    const markers = readdirSync(markersDir).filter((f) => f.includes(agentType.replace(/[^A-Za-z0-9._-]/g, '_')));
    assert.equal(markers.length, 1, `expected exactly 1 marker file for ${agentType}, got ${markers.length}: ${markers.join(', ')}`);
  } finally {
    cleanup();
  }
});
