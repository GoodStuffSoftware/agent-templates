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
