// spawn-audit's rung-drift finding: right model tier, effort below the
// ladder rung the routing table recommended for the declared weight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

test('a sonnet/medium spawn declaring weight 4 (table says sonnet/high) is flagged as effort-only drift', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const pluginData = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'underfforted.md'), '---\nname: underfforted\nmodel: sonnet\neffort: medium\n---\nbody\n');

    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-rung-drift', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'underfforted', prompt: 'WEIGHT: 4 — integration work' },
    }, { env: { CLAUDE_PLUGIN_DATA: pluginData } });
    assert.equal(res.status, 0, res.stderr);

    const auditScript = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
    const out = execFileSync(process.execPath, [auditScript, '--only', 'spawn-audit', '--json'], {
      windowsHide: true,
      encoding: 'utf8', cwd: PLUGIN_ROOT, env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData }, timeout: 30000,
    });
    const spawnAudit = JSON.parse(out).results.find((r) => r.id === 'spawn-audit');
    assert.ok(spawnAudit, 'spawn-audit check did not run');
    assert.ok(
      spawnAudit.findings.some((f) => /ran at the right model but a lower effort/.test(f)),
      `expected a rung-drift finding; got: ${JSON.stringify(spawnAudit.findings)}`,
    );
  } finally { cleanup(); }
});
