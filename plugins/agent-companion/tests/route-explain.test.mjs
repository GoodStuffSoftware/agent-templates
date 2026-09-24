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
  // integration: elevated preset; its trial (opus/high) wins, and the grid's
  // own F5 raise belongs to the shadowed grid candidate, not the answer.
  const r = ctx.resolveRoute({ type: 'integration', now: NOW });
  assert.equal(r.layer, 'trial');
  assert.deepEqual(r.floorsApplied, []);
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
