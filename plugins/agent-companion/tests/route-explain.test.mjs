// resolveRoute() explain accuracy on the SHIPPED table (ADR 0003 §2):
// explain must describe the answer actually returned — which floors raised
// it, including the ones the grid applies inside effortFor().
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const NOW = '2026-09-24T12:00:00Z';
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const floorsLine = (r) => ctx.explainRoute(r).find((l) => l.startsWith('floors:'));

test('a grid answer raised by F1 inside effortFor() reports both raises, marked within the grid', () => {
  // explore is weight 1 (haiku); an explicit critical consequence departs
  // from the preset, so the grid answers and F1 lifts it to opus/xhigh.
  const r = ctx.resolveRoute({ type: 'explore', consequence: 'critical', consequenceExplicit: true, now: NOW });
  assert.equal(r.layer, 'grid');
  assert.equal(label(r), 'opus/xhigh');
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F1', raised: 'model haiku -> opus', within: 'grid' },
    { floor: 'F1', raised: 'effort low -> xhigh', within: 'grid' },
  ]);
  assert.match(floorsLine(r), /^floors:\s+F1 model haiku -> opus \(within the grid\); F1 effort low -> xhigh \(within the grid\)$/);
  // The rationale already told this story; no "; floors:" lift is appended.
  assert.match(r.rationale, /critical consequence raises the model to opus/);
  assert.doesNotMatch(r.rationale, /; floors: /);
});

test('a grid answer raised by F5 inside effortFor() reports the effort raise', () => {
  const r = ctx.resolveRoute({ weight: 3, weightExplicit: true, consequence: 'elevated', consequenceExplicit: true, now: NOW });
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort medium -> high', within: 'grid' }]);
});

test('a grid answer no floor touched still says "none fired"', () => {
  const r = ctx.resolveRoute({ weight: 3, weightExplicit: true, now: NOW });
  assert.deepEqual(r.floorsApplied, []);
  assert.match(floorsLine(r), /^floors:\s+none fired$/);
});

test('the grid floors are not reported when a higher layer won (the grid was only shadowed)', () => {
  // large-refactor: elevated preset; its trial (opus/high) wins, already at
  // the elevated floor, and carries no F5 waiver of its own (unlike
  // integration's, see below) -- so floorsApplied is empty, not something
  // borrowed from the shadowed grid candidate.
  const r = ctx.resolveRoute({ type: 'large-refactor', now: NOW });
  assert.equal(r.layer, 'trial');
  assert.deepEqual(r.floorsApplied, []);
});

// integration is the one type whose trial carries its own F5 waiver (the
// 0.29.2 "effort" architecture decision): opus/medium is below the elevated
// floor (high), so the waiver's raise-avoidance itself shows up in
// floorsApplied, distinct from the "not reported" case above.
test('a waiving trial (integration) reports the waiver in floorsApplied, not an empty list', () => {
  const r = ctx.resolveRoute({ type: 'integration', now: NOW });
  assert.equal(r.layer, 'trial');
  assert.equal(label(r), 'opus/medium');
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F5', waived: 'effort medium kept below high (operator-observed row waives F5)' },
  ]);
  assert.ok(r.waiver?.honored);
});

test('effortFor() keeps its return shape; the floors come only through the opt-in array', () => {
  const floors = [];
  const g = ctx.effortFor(1, 'mechanical', 'critical', { now: NOW, floors });
  assert.deepEqual(Object.keys(g).sort(), ['effort', 'model', 'rationale']);
  assert.equal(floors.length, 2);
  assert.deepEqual(ctx.effortFor(1, 'mechanical', 'critical', { now: NOW }), g);
});

test('recommend --explain prints the grid floors the reviewer found missing', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'explore', '--consequence', 'critical', '--explain']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /recommendation: opus\/xhigh/);
  assert.match(res.stdout, /floors:\s+F1 model haiku -> opus \(within the grid\); F1 effort low -> xhigh \(within the grid\)/);
  assert.doesNotMatch(res.stdout, /none fired/);
  const j = runScript('scripts/recommend.mjs', ['--type', 'explore', '--consequence', 'critical', '--explain', '--json']).json;
  assert.deepEqual(j.route.floorsApplied.map((f) => [f.floor, f.within]), [['F1', 'grid'], ['F1', 'grid']]);
});

// --- No route: layer null, and explain says so --------------------------------

test('a fractional weight resolves to no route: layer null, not a grid winner with an empty model', () => {
  const r = ctx.resolveRoute({ weight: 2.5, weightExplicit: true, now: NOW });
  assert.equal(r.model, '');
  assert.equal(r.effort, '');
  assert.equal(r.layer, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.floorsApplied, []);
  assert.equal(r.rationale, 'no routing row for weight 2.5');
  const grid = r.stack.find((s) => s.layer === 'grid');
  assert.deepEqual([grid.status, grid.candidate], ['unresolved', null]);
  // The compatibility shape is what resolveExpected() always returned here.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.resolveExpected({ weight: 2.5, weightExplicit: true, now: NOW }))),
    { model: '', effort: '', rationale: 'no routing row for weight 2.5', weight: 2.5, kind: 'bounded', consequence: 'routine', trial: null });
  const lines = ctx.explainRoute(r);
  assert.equal(lines.find((l) => l.startsWith('winner:')), 'winner:   none — no route (no routing row for weight 2.5)');
  assert.equal(lines.find((l) => l.startsWith('provenance:')), 'provenance: no route resolved');
});

test('a fractional weight on a trial type departs from the preset, skips the trial, and still has no route', () => {
  const r = ctx.resolveRoute({ type: 'debug-root-cause', weight: 2.5, weightExplicit: true, now: NOW });
  assert.equal(r.layer, null);
  assert.equal(r.model, '');
  assert.match(r.skipped[0].reason, /explicit weight departs/);
});

test('every other invalid weight is no route too (layer null)', () => {
  for (const [weight, why] of [[0, 'no routing row for weight 0'], [6, 'no routing row for weight 6'], [-1, 'no routing row for weight -1'],
    [Number.NaN, 'no routing row for weight null'], ['3', 'no routing row for weight "3"'], [undefined, 'no routing row for weight null']]) {
    const r = ctx.resolveRoute({ weight, weightExplicit: true, now: NOW });
    assert.deepEqual([r.layer, r.model, r.rationale], [null, '', why], String(weight));
    assert.match(ctx.explainRoute(r).find((l) => l.startsWith('winner:')), /^winner:\s+none — no route/);
  }
  // A parity type with no writer: no route, as it always was.
  assert.equal(ctx.resolveRoute({ type: 'code-review', now: NOW }).layer, null);
});

test('recommend --weight 2.5 --explain says "no route"', () => {
  const res = runScript('scripts/recommend.mjs', ['--weight', '2.5', '--explain']);
  assert.match(res.stdout, /winner:\s+none — no route \(no routing row for weight 2\.5\)/);
  const j = runScript('scripts/recommend.mjs', ['--weight', '2.5', '--explain', '--json']).json;
  assert.equal(j.route.layer, null);
  assert.equal(j.model, '');
});
