import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

test('audit.mjs --only spawn-audit reads telemetry from the durable state root', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const pluginData = join(dir, '.claude', 'plugins', 'data', 'agent-companion-x');
    // Write one real spawn row through the actual hook first.
    const payload = {
      session_id: 'sess-audit-1',
      agent_type: 'main',
      cwd: dir,
      tool_input: { subagent_type: 'general-purpose', prompt: 'do the thing' },
    };
    const spawnRes = runHook('hooks/spawn-guard.mjs', payload, { env: { CLAUDE_PLUGIN_DATA: pluginData } });
    assert.equal(spawnRes.status, 0, `spawn-guard exited ${spawnRes.status}: ${spawnRes.stderr}`);

    const auditScript = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
    const out = execFileSync(process.execPath, [auditScript, '--only', 'spawn-audit', '--json'], {
      windowsHide: true,
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
      timeout: 30000,
    });
    const report = JSON.parse(out);
    const spawnAudit = report.results.find((r) => r.id === 'spawn-audit');
    assert.ok(spawnAudit, 'spawn-audit check did not run');
    assert.notEqual(spawnAudit.status, 'skip', `spawn-audit should not skip: ${JSON.stringify(spawnAudit.findings)}`);
    assert.ok(
      !spawnAudit.findings.some((f) => /no spawn telemetry recorded yet/.test(f)),
      `spawn-audit must not report "no spawn telemetry recorded yet": ${JSON.stringify(spawnAudit.findings)}`,
    );
    assert.equal(spawnAudit.data.total, 1);
  } finally {
    cleanup();
  }
});
