// Older, non-routable pinned model ids (config's referenceModels) let the
// agent-defs audit validate effort against what a SPECIFIC dated model
// actually supports (e.g. Opus 4.6 / Sonnet 4.6 have no xhigh) rather than
// against the current alias tier's (wider) effort list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';

function runAgentDefsAudit(dir, env) {
  const auditScript = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
  const out = execFileSync(process.execPath, [auditScript, '--dir', dir, '--only', 'agent-defs', '--json'], {
    encoding: 'utf8', cwd: PLUGIN_ROOT, env: { ...process.env, ...env }, timeout: 30000,
  });
  return JSON.parse(out).results.find((r) => r.id === 'agent-defs');
}

test('effort xhigh on claude-opus-4-6 is flagged (that generation has no xhigh)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'pinned.md'), '---\nname: pinned\nmodel: claude-opus-4-6\neffort: xhigh\n---\nbody\n');
    const result = runAgentDefsAudit(dir, { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') });
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /claude-opus-4-6/.test(f) && /xhigh/.test(f)),
      `expected an xhigh finding for claude-opus-4-6; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('effort max on claude-opus-4-6 is accepted (max IS in that generation\'s list)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'pinned.md'), '---\nname: pinned\nmodel: claude-opus-4-6\neffort: max\n---\nbody\n');
    const result = runAgentDefsAudit(dir, { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') });
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      !result.findings.some((f) => /claude-opus-4-6/.test(f) && /effort/.test(f)),
      `did not expect an effort finding for claude-opus-4-6/max; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('a definition pinned to opus with no effort names the session-inheritance reason', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'noeffort.md'), '---\nname: noeffort\nmodel: opus\n---\nbody\n');
    const result = runAgentDefsAudit(dir, { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') });
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /no effort set/.test(f) && /inherits the orchestrating session/.test(f)),
      `expected the session-inheritance no-effort finding; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('a definition pinned to SONNET with no effort ALSO names the session-inheritance reason — not opus-only', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'noeffort2.md'), '---\nname: noeffort2\nmodel: sonnet\n---\nbody\n');
    const result = runAgentDefsAudit(dir, { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') });
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /noeffort2/.test(f) && /inherits the orchestrating session/.test(f)),
      `expected the session-inheritance no-effort finding on the sonnet def too; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});
