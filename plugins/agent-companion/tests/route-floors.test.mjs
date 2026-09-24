// resolveRoute() floors F1-F5 and the layer seam (ADR 0003 §1-§2), on
// SYNTHETIC task types — the shipped table breaks no floor (route-golden
// proves that), so the floor paths are only reachable with test data. The
// types are supplied through the operator override file the loader already
// merges (<stateRoot>/model-tiers.json; its taskTypes replaces the shipped
// taskTypes whole), written before the first modelTiers() call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const trial = (model, effort) => ({ model, effort, reason: 'synthetic', evidence: { source: 'test', date: '2026-09-24' }, trialSince: '2026-09-24', reviewBy: '2026-10-01' });
mkdirSync(fx.stateDir, { recursive: true });
writeFileSync(join(fx.stateDir, 'model-tiers.json'), JSON.stringify({
  taskTypes: {
    'x-fable': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('fable', 'high') },
    'x-mythos': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('mythos', 'high') },
    'x-bad-effort': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('haiku', 'low') },
    'x-retired': { weight: 3, kind: 'bounded', consequence: 'routine', override: trial('haiku', '') },
    'x-critical-low': { weight: 2, kind: 'mechanical', consequence: 'critical', override: trial('opus', 'low') },
    'x-critical-haiku': { weight: 2, kind: 'mechanical', consequence: 'critical', override: trial('haiku', '') },
    'x-elevated-low': { weight: 3, kind: 'bounded', consequence: 'elevated', override: trial('opus', 'low') },
    'x-elevated-haiku': { weight: 1, kind: 'mechanical', consequence: 'elevated', override: trial('haiku', '') },
    'x-review': { weight: 'parity', kind: 'diagnostic', consequence: 'inherit', override: trial('haiku', '') },
    'x-plain': { weight: 4, kind: 'bounded', consequence: 'routine' },
  },
}));
const ctx = await import('../hooks/lib/context.mjs');
const BEFORE = '2026-09-24T12:00:00Z';
const AFTER = '2026-10-20T12:00:00Z'; // haiku's retiresAfter has passed
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;

test('profile layer is a seam: present in the stack, yields nothing, revision null', () => {
  const r = ctx.resolveRoute({ type: 'x-plain', now: BEFORE });
  assert.equal(r.profileRevision, null);
  assert.deepEqual(r.stack.map((s) => s.layer), ['profile', 'trial', 'grid']);
  assert.equal(r.stack[0].present, false);
  assert.equal(r.stack[0].candidate, null);
  assert.equal(r.layer, 'grid');
  assert.equal(r.source, 'shipped-grid');
  assert.equal(r.cacheTtl, null);
  assert.deepEqual(r.stale, []);
});

test('F2: a trial naming fable is skipped, never a destination; the grid answers', () => {
  const r = ctx.resolveRoute({ type: 'x-fable', now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.equal(label(r), 'sonnet/medium');
  assert.match(r.skipped[0].reason, /^F2:/);
  assert.equal(r.trial, null);
});

test('F2: any premium tier ranked at or above fable is skipped too (mythos)', () => {
  const r = ctx.resolveRoute({ type: 'x-mythos', now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.match(r.skipped[0].reason, /^F2:/);
});

test('F4: a trial whose effort the model does not take is skipped', () => {
  const r = ctx.resolveRoute({ type: 'x-bad-effort', now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.match(r.skipped[0].reason, /^F4: effort 'low' unsupported by haiku/);
});

test('F4: a trial on a retired alias is skipped from the day after retirement', () => {
  assert.equal(ctx.resolveRoute({ type: 'x-retired', now: BEFORE }).layer, 'trial');
  const r = ctx.resolveRoute({ type: 'x-retired', now: AFTER });
  assert.equal(r.layer, 'grid');
  assert.match(r.skipped[0].reason, /^F4: haiku is unavailable or retired/);
});

test('F1: a critical trial at opus/low is lifted to opus/xhigh and the raise is recorded', () => {
  const r = ctx.resolveRoute({ type: 'x-critical-low', now: BEFORE });
  assert.equal(r.layer, 'trial');
  assert.equal(label(r), 'opus/xhigh');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F1', raised: 'effort low -> xhigh' }]);
  assert.match(r.rationale, /floors: F1 effort low -> xhigh -> opus\/xhigh$/);
  // The compatibility wrapper carries the floored answer too.
  const e = ctx.resolveExpected({ type: 'x-critical-low', now: BEFORE });
  assert.equal(`${e.model}/${e.effort}`, 'opus/xhigh');
  assert.ok(e.trial);
});

test('F1: a critical trial on haiku gets BOTH the model floor and the effort floor', () => {
  const r = ctx.resolveRoute({ type: 'x-critical-haiku', now: BEFORE });
  assert.equal(label(r), 'opus/xhigh');
  assert.deepEqual(r.floorsApplied.map((f) => f.floor), ['F1', 'F1']);
  assert.match(r.floorsApplied[0].raised, /^model haiku -> opus/);
});

test('F5: an elevated trial at opus/low is lifted to the elevated effort floor (medium as of the 0.29.2 "effort" decision; no waiver path yet)', () => {
  const r = ctx.resolveRoute({ type: 'x-elevated-low', now: BEFORE });
  assert.equal(label(r), 'opus/medium');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort low -> medium' }]);
});

test('F5 cannot be expressed on a model that takes no effort (haiku stays effortless, as the grid does)', () => {
  const r = ctx.resolveRoute({ type: 'x-elevated-haiku', now: BEFORE });
  assert.equal(label(r), 'haiku');
  assert.deepEqual(r.floorsApplied, []);
  // Same as the grid's own answer for this shape.
  const g = ctx.effortFor(1, 'mechanical', 'elevated', { now: BEFORE });
  assert.equal(label(g), 'haiku');
});

test('F3: a parity type is sized to its writer; a trial cannot name its model', () => {
  const r = ctx.resolveRoute({ type: 'x-review', writer: { model: 'opus', effort: 'xhigh' }, now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.equal(r.source, 'reviewer-parity');
  assert.equal(label(r), 'opus/xhigh');
  assert.match(r.skipped[0].reason, /^F3:/);
  // Without a writer there is no route, exactly as resolveExpected() always said.
  const n = ctx.resolveRoute({ type: 'x-review', now: BEFORE });
  assert.equal(n.model, '');
  assert.equal(n.layer, null);
  assert.equal(n.rationale, 'no routing row for weight "parity"');
});

test('an explicit departure skips the trial even when the trial would break a floor', () => {
  const r = ctx.resolveRoute({ type: 'x-critical-low', weight: 3, weightExplicit: true, now: BEFORE });
  assert.equal(r.layer, 'grid');
  assert.deepEqual(r.departures, ['weight']);
  assert.match(r.skipped[0].reason, /explicit weight departs from the x-critical-low preset/);
  assert.equal(label(r), 'opus/xhigh'); // the grid applies the critical floor itself
  // ...and says so: the grid's own raises are reported, marked within the
  // grid, while nothing lifted the winning layer's candidate after the fact.
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F1', raised: 'model sonnet -> opus', within: 'grid' },
    { floor: 'F1', raised: 'effort low -> xhigh', within: 'grid' },
  ]);
  assert.doesNotMatch(r.rationale, /; floors: /);
});

test('explainRoute names every layer, the winner, the floors and a provenance line', () => {
  const lines = ctx.explainRoute(ctx.resolveRoute({ type: 'x-critical-low', now: BEFORE })).join('\n');
  assert.match(lines, /profile\s+absent/);
  assert.match(lines, /trial\s+won\s+opus\/low/);
  assert.match(lines, /grid\s+shadowed/);
  assert.match(lines, /winner:\s+trial -> opus\/xhigh/);
  assert.match(lines, /floors:\s+F1 effort low -> xhigh/);
  assert.match(lines, /provenance: shipped trial, since 2026-09-24, review by 2026-10-01/);
});
