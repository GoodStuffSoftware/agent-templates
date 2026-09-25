// Differential proof for the 0.29.2 "effort" track (lead review): across
// EVERY task type crossed with EVERY declared weight x kind x consequence
// combination (the same matrix route-golden.test.mjs uses), the ONLY routes
// that changed versus the 0.29.2 tracks' common base commit (see
// tests/fixtures/architecture-floor-diff/reference/BASELINE.json; the exact
// commit id lives in 0292-SPEC.md, kept outside this repo, not here) are ones
// resolving through integration's own routing trial.
//
// This exists because the first version of this track lowered
// consequence.elevated.effortFloor (F5) globally from high to medium to make
// integration's trial land on opus/medium -- which silently changed F5 for
// every OTHER elevated route too (grid-path elevated tasks, any declared
// CONSEQUENCE: elevated, and any future trial row). The fix: restore the
// global floor to high, and give integration's trial row its own explicit,
// operator-observed F5 waiver instead (the same waiver shape a per-user
// routing-profile row already uses). This test is the proof that nothing
// else moved.
//
// hooks/lib/context.mjs and config/model-tiers.json at that base commit are
// vendored byte for byte under fixtures/architecture-floor-diff/reference/
// (the same technique tests/route-golden.test.mjs uses for its own pinned
// baseline) rather than read via `git show <sha>` at test time, so this file
// never has to spell out a literal commit hash (leak-check's git-sha-like
// rule) and so the gate does not depend on the checkout having history depth
// beyond the working tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_ROOT, makeFixture } from './helpers.mjs';
import { buildCases, CLOCKS } from './fixtures/route-golden/cases.mjs';
import { stageResolver, atClock } from './fixtures/route-golden/live-gate.mjs';

const REFERENCE_DIR = join(PLUGIN_ROOT, 'tests', 'fixtures', 'architecture-floor-diff', 'reference');
const REFERENCE_FILES = ['hooks/lib/context.mjs', 'config/model-tiers.json'];
const baseline = JSON.parse(readFileSync(join(REFERENCE_DIR, 'BASELINE.json'), 'utf8'));

function sha256Text(path) {
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

const fx = makeFixture();
const staged = [];
test.after(() => { for (const s of staged) s.cleanup(); fx.cleanup(); });

const BASE_CONTEXT = readFileSync(join(REFERENCE_DIR, 'hooks', 'lib', 'context.mjs'), 'utf8');
const BASE_CONFIG = readFileSync(join(REFERENCE_DIR, 'config', 'model-tiers.json'), 'utf8');
const CUR_CONTEXT = readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs'), 'utf8');
const CUR_CONFIG = readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8');

async function stage(contextSource, configText) {
  const s = await stageResolver({ contextSource, configText });
  staged.push(s);
  return s.mod;
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;

test('the vendored reference is the pinned baseline, byte for byte', () => {
  for (const rel of REFERENCE_FILES) {
    const want = baseline.sha256?.[rel] || '';
    assert.match(want, /^[0-9a-f]{64}$/, `baseline sha256 for ${rel}`);
    assert.equal(sha256Text(join(REFERENCE_DIR, rel)), want, `reference/${rel} is not the baseline file — it must never be edited`);
  }
});

test('the baseline really is the 0.29.2 tracks\' pre-effort-track state: integration is opus/high there, floor is high', async () => {
  const base = await stage(BASE_CONTEXT, BASE_CONFIG);
  const cfg = base.modelTiers();
  assert.equal(cfg.taskTypes.integration.override.effort, 'high');
  assert.equal(cfg.consequence.elevated.effortFloor, 'high');
});

test('differential: across the full type x weight x kind x consequence matrix, only integration\'s own trial route changed', async () => {
  const base = await stage(BASE_CONTEXT, BASE_CONFIG);
  const cur = await stage(CUR_CONTEXT, CUR_CONFIG);
  const cfg = cur.modelTiers();
  const cases = buildCases({
    typeNames: Object.keys(cfg.taskTypes || {}),
    kinds: Object.keys(cfg.taskKinds || {}),
    consequences: Object.keys(cfg.consequence || {}),
  });

  const changed = [];
  const unexpectedlyChanged = [];
  for (const clock of CLOCKS) {
    for (const c of cases) {
      const oldE = plain(atClock(clock, () => base.resolveExpected(c.args)));
      const newE = plain(atClock(clock, () => cur.resolveExpected(c.args)));
      if (JSON.stringify(oldE) === JSON.stringify(newE)) continue;

      const newRoute = cur.resolveRoute({ ...c.args, now: clock });
      const tag = `${clock.slice(0, 10)} ${c.key}: ${label({ model: oldE.model, effort: oldE.effort })} -> ${label(newE)}`;
      changed.push(tag);
      // The ONLY permitted difference: this case names (or restates as)
      // integration, and the new answer actually won through ITS TRIAL —
      // not a departure that fell to the grid, not another layer.
      const isIntegrationTrial = c.args.type === 'integration' && newRoute.layer === 'trial';
      if (!isIntegrationTrial) unexpectedlyChanged.push(tag);
    }
  }
  // Sanity: the gate is not vacuous. Integration's own as-is case (and its
  // restated-preset siblings) really did change, or this test would pass by
  // never finding a difference at all.
  assert.ok(changed.length > 0, 'expected at least one changed case (integration\'s own trial) -- the differential found none, which would make this test vacuous');
  assert.deepEqual(unexpectedlyChanged.slice(0, 20), [], `${unexpectedlyChanged.length} case(s) changed outside integration's trial (showing up to 20)`);
});

test('a grid-path elevated route (no type, explicit weight/consequence) still floors to high, not medium', async () => {
  const cur = await stage(CUR_CONTEXT, CUR_CONFIG);
  const r = cur.resolveRoute({ weight: 3, weightExplicit: true, consequence: 'elevated', consequenceExplicit: true });
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort medium -> high', within: 'grid' }]);
});

test('a declared CONSEQUENCE: elevated on an unrelated type also still floors to high', async () => {
  const cur = await stage(CUR_CONTEXT, CUR_CONFIG);
  // bounded-feature's own preset consequence is routine; an explicit elevated
  // departs from it, skipping the trial layer entirely and going to the grid.
  const r = cur.resolveRoute({ type: 'bounded-feature', consequence: 'elevated', consequenceExplicit: true });
  assert.equal(r.layer, 'grid');
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort medium -> high', within: 'grid' }]);
});
