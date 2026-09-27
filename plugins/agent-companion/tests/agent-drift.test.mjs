// Project-agent drift: `routingType:` frontmatter on a project's own agents,
// compared against the routing table by the agent-defs audit check and by the
// scout's project_agent_drift signal. Fixture projects only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { resolveRoute } from '../hooks/lib/context.mjs';
import { projectAgentDrift, driftFindings, parseFrontmatter } from '../scripts/lib/agent-drift.mjs';

function agent(dir, name, fm) {
  const d = join(dir, '.claude', 'agents');
  mkdirSync(d, { recursive: true });
  const lines = Object.entries({ name, description: `${name} agent`, ...fm }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(d, `${name}.md`), `---\n${lines.join('\n')}\n---\n\nBody.\n`);
}

const route = (t) => resolveRoute({ type: t, profile: false });

test('parseFrontmatter reads routingType as a plain key', () => {
  assert.equal(parseFrontmatter('---\nname: a\nroutingType: explore\n---\n').routingType, 'explore');
});

test('verdicts: below / above / match / inherits / unknown-type, and unmapped listed as info', () => {
  const fx = makeFixture();
  try {
    const dbg = route('debug-root-cause');
    const exp = route('explore');
    const nov = route('novel-design');
    agent(fx.dir, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    agent(fx.dir, 'explorer', { model: exp.model, effort: exp.effort, routingType: 'explore' });
    agent(fx.dir, 'architect', { model: nov.model, effort: 'max', routingType: 'novel-design' });
    agent(fx.dir, 'noeffort', { model: dbg.model, routingType: 'debug-root-cause' });
    agent(fx.dir, 'typo', { model: 'opus', effort: 'low', routingType: 'debug-rootcause' });
    agent(fx.dir, 'plain', { model: 'sonnet', effort: 'low' });
    const d = projectAgentDrift(fx.dir);
    const v = Object.fromEntries(d.agents.map((a) => [a.name, a.verdict]));
    assert.equal(v.debugger, 'below');
    assert.equal(v.explorer, 'match');
    assert.equal(v.architect, 'above');
    assert.equal(v.noeffort, 'inherits');
    assert.equal(v.typo, 'unknown-type');
    assert.deepEqual(d.unmapped, ['plain']);
    const f = driftFindings(d);
    assert.ok(f.some((x) => x.startsWith('info:') && /plain/.test(x)));
  } finally { fx.cleanup(); }
});

test('parity coverage: a writer needs a code-review agent on its model at >= its effort', () => {
  const fx = makeFixture();
  try {
    agent(fx.dir, 'builder', { model: 'opus', effort: 'xhigh', routingType: 'bounded-feature' });
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'high', routingType: 'code-review' });
    agent(fx.dir, 'looker', { model: 'sonnet', effort: 'low', routingType: 'explore' });
    let d = projectAgentDrift(fx.dir);
    assert.equal(d.parityGaps.length, 1, 'effort below the writer is a gap');
    assert.equal(d.parityGaps[0].writer, 'builder');
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'max', routingType: 'code-review' });
    d = projectAgentDrift(fx.dir);
    assert.equal(d.parityGaps.length, 0, 'same model, higher effort covers it; a read-only explorer needs no reviewer');
    agent(fx.dir, 'reviewer', { model: 'sonnet', effort: 'max', routingType: 'code-review' });
    assert.equal(projectAgentDrift(fx.dir).parityGaps.length, 1, 'a different model never covers');
  } finally { fx.cleanup(); }
});

test('parity follows the table\'s own reviewer sizing: stronger model counts, fable writer capped at opus, critical writer needs the F1 floor', () => {
  const fx = makeFixture();
  try {
    // A stronger reviewer model covers a weaker writer.
    agent(fx.dir, 'builder', { model: 'sonnet', effort: 'medium', routingType: 'bounded-feature' });
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'xhigh', routingType: 'code-review' });
    assert.equal(projectAgentDrift(fx.dir).parityGaps.length, 0, 'opus/xhigh reviews a sonnet/medium writer');
    // Fable writer: F2 caps its reviewer at opus.
    agent(fx.dir, 'builder', { model: 'fable', effort: 'high', routingType: 'bounded-feature' });
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'max', routingType: 'code-review' });
    assert.equal(projectAgentDrift(fx.dir).parityGaps.length, 0, 'opus/max covers a fable/high writer');
    // A critical-change writer's review is raised to the critical floor (F1).
    agent(fx.dir, 'builder', { model: 'opus', effort: 'medium', routingType: 'critical-change' });
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'medium', routingType: 'code-review' });
    const d = projectAgentDrift(fx.dir);
    assert.equal(d.parityGaps.length, 1);
    assert.match(d.parityGaps[0].need, /opus\/xhigh/);
  } finally { fx.cleanup(); }
});

test('a writer with no effort is unverifiable, never covered', () => {
  const fx = makeFixture();
  try {
    agent(fx.dir, 'builder', { model: 'opus', routingType: 'bounded-feature' });
    agent(fx.dir, 'reviewer', { model: 'opus', effort: 'max', routingType: 'code-review' });
    const d = projectAgentDrift(fx.dir);
    assert.equal(d.parityGaps.length, 0);
    assert.equal(d.parityUnverifiable.length, 1);
    assert.ok(driftFindings(d).some((x) => /builder sets no effort .* unverifiable/.test(x)));
  } finally { fx.cleanup(); }
});

test('no code-review agent: no parity check at all', () => {
  const fx = makeFixture();
  try {
    agent(fx.dir, 'builder', { model: 'opus', effort: 'xhigh', routingType: 'bounded-feature' });
    assert.equal(projectAgentDrift(fx.dir).parityGaps.length, 0);
  } finally { fx.cleanup(); }
});

test('agent-defs audit: drift is a warn finding; unmapped-only stays ok', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'proj');
    agent(proj, 'plain', { model: 'sonnet', effort: 'low' });
    let res = runScript('scripts/audit.mjs', ['--dir', proj, '--only', 'agent-defs', '--json']);
    let r = res.json.results.find((x) => x.id === 'agent-defs');
    assert.equal(r.status, 'ok', JSON.stringify(r.findings));
    assert.ok(r.findings.some((x) => /^info: 1 agent/.test(x)));
    assert.equal(r.data.routing.unmapped, 1);

    agent(proj, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    res = runScript('scripts/audit.mjs', ['--dir', proj, '--only', 'agent-defs', '--json']);
    r = res.json.results.find((x) => x.id === 'agent-defs');
    assert.equal(r.status, 'warn');
    assert.ok(r.findings.some((x) => /debugger\.md: routingType debug-root-cause routes to .* below the table/.test(x)), JSON.stringify(r.findings));
    assert.equal(r.data.routing.below, 1);
  } finally { fx.cleanup(); }
});

test('scout: project_agent_drift fires for a listed project with drift, silent without', () => {
  const fx = makeFixture();
  try {
    const drifted = join(fx.dir, 'drifted-proj');
    const clean = join(fx.dir, 'clean-proj');
    agent(drifted, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    const exp = route('explore');
    agent(clean, 'explorer', { model: exp.model, effort: exp.effort, routingType: 'explore' });
    const cj = join(fx.dir, 'claude.json');
    const run = (projects) => {
      writeFileSync(cj, JSON.stringify({ projects: Object.fromEntries(projects.map((p) => [p, {}])) }));
      return runScript('scripts/detect.mjs', [], {
        cwd: clean,
        env: { AGENT_COMPANION_DISCOVERY_CLAUDE_JSON: cj, AGENT_COMPANION_CI_STATUS_NO_GH: '1' },
        timeout: 60000,
      });
    };
    let res = run([clean]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'project_agent_drift'), undefined);
    res = run([clean, drifted]);
    const s = res.json.signals.find((x) => x.kind === 'project_agent_drift');
    assert.ok(s, JSON.stringify(res.json.signals.map((x) => x.kind)));
    assert.equal(s.dispatch, 'routing-review');
    assert.match(s.detail, /1 below/);
  } finally { fx.cleanup(); }
});
