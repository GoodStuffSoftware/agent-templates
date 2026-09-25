// F6 (hooks/lib/context.mjs resolveRoute()): NO architecture-class task type
// (integration, large-refactor, novel-design, critical-change, or any local
// type carrying `architectureClass: true`) may ever resolve to opus/low, at
// any layer. Added 2026-09-24 alongside the "effort" architecture decision
// that moved integration's trial from opus/high to opus/medium, which
// required lowering the elevated-consequence effort floor (F5) from high to
// medium (config/model-tiers.json) -- this file pins that architecture-class
// types still cannot slip below opus/medium once that floor moved, whatever
// layer or config mistake might otherwise let them.
//
// Each staged resolver is a FRESH module instance (tests/fixtures/route-
// golden/live-gate.mjs's stageResolver), so a synthetic config never leaks
// into another test's cache — the same technique route-golden.test.mjs uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, makeFixture } from './helpers.mjs';
import { stageResolver } from './fixtures/route-golden/live-gate.mjs';

const fx = makeFixture();
const staged = [];
test.after(() => { for (const s of staged) s.cleanup(); fx.cleanup(); });

const CUR_CONTEXT = readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs'), 'utf8');
const SHIPPED_CONFIG = readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8');
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;

async function stage(configText) {
  const s = await stageResolver({ contextSource: CUR_CONTEXT, configText });
  staged.push(s);
  return s.mod;
}

// --- Trial layer: the shipped table itself -----------------------------

test('every shipped architecture-class task type is flagged, and none resolves to opus/low', async () => {
  const ctx = await stage(SHIPPED_CONFIG);
  const cfg = ctx.modelTiers();
  const archTypes = Object.entries(cfg.taskTypes || {}).filter(([, t]) => t && t.architectureClass);
  const names = archTypes.map(([n]) => n).sort();
  assert.deepEqual(names, ['critical-change', 'integration', 'large-refactor', 'novel-design']);
  const RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  for (const [name] of archTypes) {
    const r = ctx.resolveRoute({ type: name });
    assert.notEqual(label(r), 'opus/low', `${name} must never resolve to opus/low`);
    if (r.model === 'opus' && r.effort) {
      assert.ok(RANK[r.effort] >= RANK.medium, `${name} resolved to opus/${r.effort}, below the architecture-class floor (medium)`);
    }
  }
});

test('the 0.29.2 "effort" decision: integration sits at opus/medium; large-refactor and novel-design stay opus/high; critical-change stays opus/xhigh (F1)', async () => {
  const ctx = await stage(SHIPPED_CONFIG);
  const want = {
    integration: 'opus/medium',
    'large-refactor': 'opus/high',
    'novel-design': 'opus/high',
    'critical-change': 'opus/xhigh',
  };
  for (const [name, wantLabel] of Object.entries(want)) {
    const r = ctx.resolveRoute({ type: name });
    assert.equal(label(r), wantLabel, name);
  }
  // integration and large-refactor/novel-design win via the shipped trial;
  // critical-change has no override and wins via the grid, floored by F1.
  const intg = ctx.resolveRoute({ type: 'integration' });
  assert.equal(intg.layer, 'trial');
  const crit = ctx.resolveRoute({ type: 'critical-change' });
  assert.equal(crit.layer, 'grid');
  assert.ok(crit.floorsApplied.some((f) => f.floor === 'F1'));
});

test('F6 (trial layer): a shipped-style trial override naming opus/low for an architecture-class type is floored to opus/medium, not refused', async () => {
  const cfg = JSON.parse(SHIPPED_CONFIG);
  cfg.taskTypes = {
    'x-arch-trial': {
      weight: 3, kind: 'bounded', consequence: 'routine', architectureClass: true, summary: 'synthetic',
      override: {
        model: 'opus', effort: 'low', reason: 'synthetic trial below the architecture floor',
        evidence: { source: 'test', date: '2026-09-24' }, trialSince: '2026-09-24', reviewBy: '2026-10-01',
      },
    },
  };
  const ctx = await stage(JSON.stringify(cfg));
  const r = ctx.resolveRoute({ type: 'x-arch-trial' });
  assert.equal(r.layer, 'trial'); // F6 floors the winning layer; it does not refuse the trial
  assert.equal(label(r), 'opus/medium');
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F6', raised: 'effort low -> medium (architecture-class task type never routes to opus/low)' },
  ]);
});

// --- Grid layer: prove F6 is a real backstop, not a name that never fires --

test('F6 (grid layer): an architecture-class type under a hypothetical consequence with a model floor but no effort floor still never resolves to opus/low', async () => {
  const cfg = JSON.parse(SHIPPED_CONFIG);
  // A consequence shape the shipped table does not carry today (model floor,
  // no effort floor) — exactly the kind of future config mistake F6 guards
  // against, since F1/F5 alone only protect critical/elevated consequences.
  cfg.consequence = { ...cfg.consequence, 'x-model-floor-only': { effortFloor: null, modelFloor: 'opus' } };
  cfg.taskTypes = {
    'x-arch-grid': { weight: 3, kind: 'bounded', consequence: 'x-model-floor-only', architectureClass: true, summary: 'synthetic' },
  };
  const ctx = await stage(JSON.stringify(cfg));
  // Sanity: without the architectureClass flag, this consequence really does
  // let the grid land on opus/low (proving the scenario is real, not moot).
  const plain = ctx.effortFor(3, 'bounded', 'x-model-floor-only');
  assert.equal(`${plain.model}/${plain.effort}`, 'opus/low');
  const r = ctx.resolveRoute({ type: 'x-arch-grid' });
  assert.equal(r.layer, 'grid');
  assert.equal(label(r), 'opus/medium');
  assert.deepEqual(r.floorsApplied.filter((f) => f.floor === 'F6'), [
    { floor: 'F6', raised: 'effort low -> medium (architecture-class task type never routes to opus/low)' },
  ]);
});

// --- Profile rows: refused at validation, never waivable -------------------

test('F6 (profile rows): a row naming opus/low for an architecture-class type is refused in both modes, even with an honoured F5 waiver', async () => {
  const ctx = await stage(SHIPPED_CONFIG);
  const typeDef = ctx.taskTypeDef('integration').def;
  const base = { state: 'trial', source: 'operator-observed', since: '2026-09-24' };
  for (const mode of ['read', 'write']) {
    const bare = ctx.profileRowRefusal('integration', { ...base, model: 'opus', effort: 'low' }, { typeDef, mode });
    assert.match(bare, /^F6:/, `${mode} mode, no waiver`);
    const waived = ctx.profileRowRefusal(
      'integration',
      { ...base, model: 'opus', effort: 'low', waivesFloor: 'elevated' },
      { typeDef, mode },
    );
    assert.match(waived, /^F6:/, `${mode} mode, F5 waiver present — F6 is not waivable`);
  }
});

test('F6 (profile rows): opus/medium — exactly at the architecture floor — is not refused by F6 (with its own F5 waiver, since the elevated floor is still high)', async () => {
  const ctx = await stage(SHIPPED_CONFIG);
  const typeDef = ctx.taskTypeDef('integration').def;
  const base = { state: 'trial', source: 'operator-observed', since: '2026-09-24' };
  // The elevated floor (F5) is high, unaffected by this track: a profile row
  // at opus/medium needs its OWN F5 waiver to pass at all. This isolates F6
  // from F5 — proving F6 itself draws the line at low, not at medium.
  assert.equal(
    ctx.profileRowRefusal('integration', { ...base, model: 'opus', effort: 'medium', waivesFloor: 'elevated' }, { typeDef, mode: 'write' }),
    '',
  );
});

test('F6 (profile rows): a non-architecture type is unaffected — opus/low is still only an F5 concern there', async () => {
  const ctx = await stage(SHIPPED_CONFIG);
  const typeDef = ctx.taskTypeDef('bounded-feature').def; // routine consequence, not architecture-class
  const base = { state: 'trial', source: 'operator-observed', since: '2026-09-24' };
  assert.equal(ctx.profileRowRefusal('bounded-feature', { ...base, model: 'opus', effort: 'low' }, { typeDef, mode: 'write' }), '');
});
