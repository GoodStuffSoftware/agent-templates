// 0.31.28 scout-noise fixes: the 2026-10-16 routing-trial verdicts applied to the shipped table,
// session_churn not counting a subagent's self-review spawns, haiku_fit_leak skipping lead-declared
// grid rows, and project_agent_drift reporting once per repository. Temp fixtures only.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, runScript } from './helpers.mjs';
import { telemetryDir, resolveRoute } from '../hooks/lib/context.mjs';
import { scanChurn } from '../scripts/lib/session-churn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const shipped = JSON.parse(readFileSync(join(HERE, '..', 'config', 'model-tiers.json'), 'utf8'));
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

// --- shipped routing trials --------------------------------------------------------------------
test('no shipped routing trial is past its reviewBy as of 2026-10-17, explore (the 10-19 Haiku review) aside', () => {
  const today = Date.parse('2026-10-17');
  const due = Object.entries(shipped.taskTypes)
    .filter(([name, t]) => name !== 'explore' && t.override?.reviewBy && Date.parse(t.override.reviewBy) <= today)
    .map(([name]) => name);
  assert.deepEqual(due, []);
  assert.equal(shipped.taskTypes.explore.override.model, 'haiku', 'explore is left to the 10-19 review');
});

test('the 10-16 verdicts: settled rows carry no reviewBy, extended rows review on 2026-10-30', () => {
  for (const name of ['mechanical-edit', 'operate', 'debug-root-cause', 'novel-design', 'verify', 'bounded-feature', 'integration']) {
    assert.ok(shipped.taskTypes[name].override, `${name} keeps its override`);
    assert.equal(shipped.taskTypes[name].override.reviewBy, undefined, `${name} is settled`);
  }
  for (const name of ['large-refactor', 'long-autonomous-run', 'subagent-worker']) {
    assert.equal(shipped.taskTypes[name].override.reviewBy, '2026-10-30', name);
  }
  assert.equal(shipped.taskTypes.integration.override.waivesFloor, undefined, 'sonnet/high meets the elevated floor');
});

test('the shipped route for the 10-16 verdict types', () => {
  const want = {
    verify: ['sonnet', 'low'], 'bounded-feature': ['sonnet', 'high'], integration: ['sonnet', 'high'],
    'mechanical-edit': ['sonnet', 'low'], operate: ['sonnet', 'low'],
    'debug-root-cause': ['opus', 'medium'], 'novel-design': ['opus', 'xhigh'],
    'large-refactor': ['opus', 'high'], 'long-autonomous-run': ['opus', 'high'], 'subagent-worker': ['sonnet', 'low'],
  };
  for (const [type, [model, effort]] of Object.entries(want)) {
    const r = resolveRoute({ type, profile: false });
    assert.deepEqual([r.model, r.effort], [model, effort], type);
  }
});

// --- session_churn ------------------------------------------------------------------------------
test('review_rounds skips code-review spawns made by subagents (the self-review protocol)', async () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'projects');
    mkdirSync(root, { recursive: true });
    const at = new Date().toISOString();
    const spawnRows = [
      { at, session_id: 'lead-a', declared_type: 'code-review', caller_is_subagent: false },
      { at, session_id: 'lead-a', declared_type: 'code-review' },                      // field absent: still the lead
      { at, session_id: 'lead-a', declared_type: 'code-review', caller_is_subagent: true },
      { at, session_id: 'lead-a', declared_type: 'code-review', caller_is_subagent: true },
      { at, session_id: 'lead-b', declared_type: 'code-review', caller_is_subagent: true },
    ];
    const { rows } = await scanChurn({ root, spawnRows });
    assert.equal(rows.find((r) => r.session_id === 'lead-a').review_rounds, 2);
    assert.equal(rows.find((r) => r.session_id === 'lead-b'), undefined, 'only subagent reviews: no row');
  } finally { fx.cleanup(); }
});

// --- haiku_fit_leak -----------------------------------------------------------------------------
test('haiku_fit_leak skips grid rows (a lead-declared weight) and still counts profile and trial rows', () => {
  const fx = makeFixture();
  try {
    const NOW = '2026-10-13T12:00:00Z';
    const at = new Date(Date.parse(NOW) - 86400000).toISOString();
    const row = (o) => ({ session_id: 's1', model: 'sonnet', fit_expected: 'haiku/medium', subagent_type: 'general-purpose', at, ...o });
    const run = (rows) => {
      mkdirSync(telemetryDir(), { recursive: true });
      writeFileSync(join(telemetryDir(), 'spawns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: NOW }, timeout: 90000 });
      assert.equal(res.status, 0, res.stderr);
      return (res.json.signals || []).filter((s) => s.kind === 'haiku_fit_leak');
    };
    assert.equal(run([row({ route_layer: 'grid' }), row({ route_layer: 'grid' })]).length, 0, 'grid only: no signal');
    const hit = run([row({ route_layer: 'grid' }), row({ route_layer: 'profile' }), row({ route_layer: 'trial' }), row({})]);
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /^3 spawn\(s\) in 7 days/, hit[0].detail);
  } finally { fx.cleanup(); }
});

// --- project_agent_drift ------------------------------------------------------------------------
const driftAgent = (dir, name, fm) => {
  const lines = Object.entries({ name, description: `${name} agent`, ...fm }).map(([k, v]) => `${k}: ${v}`);
  put(join(dir, '.claude', 'agents', `${name}.md`), `---\n${lines.join('\n')}\n---\n\nBody.\n`);
};
function driftSignal(fx, cwd, projects) {
  const cj = join(fx.dir, 'claude.json');
  writeFileSync(cj, JSON.stringify({ projects: Object.fromEntries(projects.map((p) => [p, {}])) }));
  const res = runScript('scripts/detect.mjs', [], {
    cwd, env: { AGENT_COMPANION_DISCOVERY_CLAUDE_JSON: cj, AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  return res.json.signals.find((s) => s.kind === 'project_agent_drift');
}

test('project_agent_drift: a repo and its worktree copies are one project, with the copy count', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'proj-a');
    const trees = ['tree-one', 'tree-two', 'tree-three'].map((t) => join(root, '.claude', 'worktrees', t));
    for (const d of [root, ...trees]) driftAgent(d, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    const clean = join(fx.dir, 'clean');
    mkdirSync(join(clean, '.claude', 'agents'), { recursive: true });
    const s = driftSignal(fx, clean, [root, ...trees]);
    assert.ok(s);
    assert.match(s.detail, /^1 project\(s\)/, s.detail);
    assert.match(s.detail, /repo root: .*\(3 worktree copies\)/, s.detail);
    assert.doesNotMatch(s.detail, /tree-one|tree-two|tree-three/);
  } finally { fx.cleanup(); }
});

test('project_agent_drift: worktrees whose root is not listed fold into one entry; separate repos stay separate', () => {
  const fx = makeFixture();
  try {
    const a = join(fx.dir, 'proj-a');
    const b = join(fx.dir, 'proj-b');
    const aTrees = ['t1', 't2'].map((t) => join(a, '.claude', 'worktrees', t));
    for (const d of [...aTrees, b]) driftAgent(d, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    const clean = join(fx.dir, 'clean');
    mkdirSync(join(clean, '.claude', 'agents'), { recursive: true });
    const s = driftSignal(fx, clean, [...aTrees, b]);
    assert.ok(s);
    assert.match(s.detail, /^2 project\(s\)/, s.detail);
    assert.match(s.detail, /\(2 worktree copies\)/, s.detail);
    assert.equal((s.detail.match(/repo root \d/g) || []).length, 2);
  } finally { fx.cleanup(); }
});
