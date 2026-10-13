// 0.31.16: the grid never resolves haiku below medium (tier field `minEffort`).
// `--weight 1|2 --kind mechanical` used to come out haiku/low (the mechanical delta is -1
// from medium); Anthropic advises against low on Haiku 5.5 for agent work.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const label = (r) => `${r.model}/${r.effort}`;

test('the shipped haiku tier carries minEffort medium', () => {
  assert.equal(ctx.modelTiers().tiers.haiku.minEffort, 'medium');
});

test('weight 1 and 2 with kind mechanical resolve to haiku/medium, not haiku/low', () => {
  for (const weight of [1, 2]) {
    const r = ctx.effortFor(weight, 'mechanical', 'routine');
    assert.equal(label(r), 'haiku/medium', `weight ${weight}`);
    assert.match(r.rationale, /haiku never runs below medium -> haiku\/medium$/);
  }
});

test('the floor is recorded as a grid raise, and resolveRoute returns it', () => {
  const floors = [];
  ctx.effortFor(1, 'mechanical', 'routine', { floors });
  assert.deepEqual(floors, [{ floor: 'haiku-min-effort', raised: 'effort low -> medium', within: 'grid' }]);
  const route = ctx.resolveRoute({ weight: 1, weightExplicit: true, kind: 'mechanical', kindExplicit: true });
  assert.equal(label(route), 'haiku/medium');
  assert.equal(route.layer, 'grid');
});

test('rows that were already at or above medium do not move', () => {
  assert.equal(label(ctx.effortFor(1, 'bounded', 'routine')), 'haiku/medium');
  assert.equal(label(ctx.effortFor(1, 'diagnostic', 'routine')), 'haiku/high');
  assert.equal(label(ctx.effortFor(3, 'mechanical', 'routine')).startsWith('sonnet/'), true);
  // other tiers carry no minEffort, so their mechanical -1 still applies
  assert.equal(ctx.modelTiers().tiers.sonnet.minEffort, undefined);
  assert.equal(ctx.modelTiers().tiers.opus.minEffort, undefined);
});

test('a tier whose efforts exclude minEffort is left alone, and an effortless haiku stays effortless', () => {
  const t = ctx.modelTiers().tiers.haiku;
  const saved = t.efforts;
  try {
    t.efforts = [];
    assert.equal(label(ctx.effortFor(1, 'mechanical', 'routine')), 'haiku/');
    t.efforts = ['low', 'high'];
    assert.equal(label(ctx.effortFor(1, 'mechanical', 'routine')), 'haiku/low');
  } finally { t.efforts = saved; }
});

test('recommend --weight 1 --kind mechanical names haiku with medium', () => {
  const r = runScript('scripts/recommend.mjs', ['--weight', '1', '--kind', 'mechanical', '--json'], { cwd: fx.dir });
  const j = JSON.parse(r.stdout);
  const flat = JSON.stringify(j);
  assert.match(flat, /"effort":"medium"/);
  assert.doesNotMatch(flat, /haiku\/low/);
});

// 0.31.17: a mistyped minEffort still fails open (no route change) but is now reported.
test('a mistyped minEffort leaves the route unchanged and is reported by tierEffortProblems', () => {
  assert.deepEqual(ctx.tierEffortProblems(), [], 'shipped config is clean');
  const t = ctx.modelTiers().tiers.haiku;
  const saved = t.minEffort;
  try {
    const before = label(ctx.effortFor(1, 'bounded', 'routine'));
    t.minEffort = 'medim';
    assert.equal(label(ctx.effortFor(1, 'mechanical', 'routine')), 'haiku/low', 'floor skipped, as before');
    assert.equal(label(ctx.effortFor(1, 'bounded', 'routine')), before);
    const problems = ctx.tierEffortProblems();
    assert.equal(problems.length, 1);
    assert.equal(problems[0].alias, 'haiku');
    assert.match(problems[0].problem, /tiers\.haiku\.minEffort is "medim".*routes are unchanged/);
    t.minEffort = 3;
    assert.equal(ctx.tierEffortProblems().length, 1, 'a number is reported too');
  } finally { t.minEffort = saved; }
});

test('the scout and --check-agent-descriptions report a mistyped minEffort; the shipped config is silent', () => {
  const scout = () => {
    const r = runScript('scripts/detect.mjs', [], { cwd: fx.dir, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return r.json.signals.filter((s) => s.kind === 'tier_min_effort_invalid');
  };
  assert.equal(scout().length, 0);
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(join(fx.stateDir, 'model-tiers.json'), JSON.stringify({ tiers: { haiku: { minEffort: 'medim' } } }));
  const hit = scout();
  assert.equal(hit.length, 1);
  assert.match(hit[0].detail, /minEffort is "medim"/);
  assert.equal(hit[0].dispatch, 'manual-check');
  const chk = runScript('scripts/routing-table.mjs', ['--check-agent-descriptions'], { cwd: fx.dir });
  assert.notEqual(chk.status, 0);
  assert.match(chk.stderr, /tier-min-effort/);
});
