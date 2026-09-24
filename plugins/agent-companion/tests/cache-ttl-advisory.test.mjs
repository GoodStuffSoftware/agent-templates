// Cache-TTL advisory (agent-defs check). ADVISORY ONLY — must never flip the
// check's status to 'fail'; see checks.mjs's `bad` regex, which these
// findings deliberately do not match. Evidence for the thresholds:
// ~/.claude/reports/2026-09-23-subagent-cache-ttl.md (30-day measurement),
// recorded in full in config/model-tiers.json's `cacheTtl` block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';

function runAgentDefsAudit(dir, env) {
  const auditScript = join(PLUGIN_ROOT, 'scripts', 'audit.mjs');
  const out = execFileSync(process.execPath, [auditScript, '--dir', dir, '--only', 'agent-defs', '--json'], {
    windowsHide: true,
    encoding: 'utf8', cwd: PLUGIN_ROOT, env: { ...process.env, ...env }, timeout: 30000,
  });
  return JSON.parse(out).results.find((r) => r.id === 'agent-defs');
}

function fixtureEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

test('opus-tier architect with no cacheTtl gets a 1h suggestion, and stays a warning, not a failure', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'my-architect.md'),
      '---\nname: my-architect\ndescription: designs the plan for a large change\nmodel: opus\neffort: xhigh\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /my-architect/.test(f) && /consider experimental/.test(f) && /1h/.test(f)),
      `expected a 1h cache-TTL suggestion for the opus architect; got: ${JSON.stringify(result.findings)}`,
    );
    assert.notEqual(result.status, 'fail', 'a cache-TTL advisory must never fail the check');
  } finally { cleanup(); }
});

test('opus-tier architect that ALREADY sets cacheTtl: 1h gets no suggestion', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'my-architect.md'),
      '---\nname: my-architect\ndescription: designs the plan for a large change\nmodel: opus\neffort: xhigh\nexperimental:\n  cacheTtl: 1h\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      !result.findings.some((f) => /my-architect/.test(f) && /consider experimental/.test(f)),
      `did not expect a cache-TTL suggestion once already set; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('opus-tier BUILDER (not architect/reviewer/lead) gets no cacheTtl suggestion — role name must mark it long-lived', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'my-builder.md'),
      '---\nname: my-builder\ndescription: implements a bounded change\nmodel: opus\neffort: high\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      !result.findings.some((f) => /my-builder/.test(f) && /consider experimental/.test(f)),
      `did not expect a cache-TTL suggestion for a plain builder; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('generic ac-opus-* ladder worker is excluded from the opus-tier suggestion even though it names no long-lived role', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    // Deliberately named/described like a long-lived reviewer role, to prove
    // the ac-* exclusion wins even when the role-name heuristic would
    // otherwise fire.
    writeFileSync(
      join(agentsDir, 'ac-opus-xhigh.md'),
      '---\nname: ac-opus-xhigh\ndescription: generic ladder rung, reviewer-capable, one-shot\nmodel: opus\neffort: xhigh\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      !result.findings.some((f) => /ac-opus-xhigh/.test(f) && /consider experimental/.test(f)),
      `did not expect a cache-TTL suggestion for a ladder worker; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('haiku definition set to cacheTtl: 1h is flagged as likely costing more', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'quick-lookup.md'),
      '---\nname: quick-lookup\ndescription: a single read-only lookup\nmodel: haiku\nexperimental:\n  cacheTtl: 1h\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /quick-lookup/.test(f) && /likely costs MORE/.test(f)),
      `expected a "costs more" note for haiku at 1h; got: ${JSON.stringify(result.findings)}`,
    );
    assert.notEqual(result.status, 'fail', 'a cache-TTL advisory must never fail the check');
  } finally { cleanup(); }
});

test('ac-* ladder worker set to cacheTtl: 1h is flagged as likely costing more, even on opus', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'ac-opus-max.md'),
      '---\nname: ac-opus-max\ndescription: generic ladder rung\nmodel: opus\neffort: max\nexperimental:\n  cacheTtl: 1h\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      result.findings.some((f) => /ac-opus-max/.test(f) && /likely costs MORE/.test(f)),
      `expected a "costs more" note for a one-shot ladder worker at 1h; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});

test('sonnet definition set to cacheTtl: 1h gets no cost-warning (not haiku, not a ladder worker)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'example-sonnet-reviewer.md'),
      '---\nname: example-sonnet-reviewer\ndescription: reviews a change\nmodel: sonnet\neffort: high\nexperimental:\n  cacheTtl: 1h\n---\nbody\n',
    );
    const result = runAgentDefsAudit(dir, fixtureEnv(dir));
    assert.ok(result, 'agent-defs check did not run');
    assert.ok(
      !result.findings.some((f) => /example-sonnet-reviewer/.test(f) && /likely costs MORE/.test(f)),
      `did not expect a cost-warning for a sonnet reviewer at 1h; got: ${JSON.stringify(result.findings)}`,
    );
  } finally { cleanup(); }
});
