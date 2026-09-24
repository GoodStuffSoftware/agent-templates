// Calibration: "haiku validates, it does not OPERATE" (team-orchestration
// skill; a dated CONTRIBUTIONS_INBOX entry). Two task types encode the distinction
// so recommend.mjs routes them, not taste:
//   - `verify`  — read/confirm/screenshot, nothing changes -> weight 1
//   - `operate` — an ordered procedure or a change to a live system, even when
//                 every step looks trivial in isolation -> weight >= 3, sonnet+
//
// UPDATED 2026-09-23 (v1): the operator-approved routing trial (config/
// model-tiers.json taskTypes.*.override, reviewBy 2026-09-30) moved `verify`
// off haiku onto sonnet/low, per the measured finding that Sonnet passed
// every synthetic task at every effort while Haiku cost ~2x Sonnet per task
// and was the only model to fail. `verify`'s underlying weight (1, distinct
// from `operate`'s 3) is unchanged — only the resolved model/effort moved.
// Haiku remains available as an explicit choice, just no longer this type's
// default.
//
// UPDATED 2026-09-23 (v2, same trial window, operator-endorsed): Opus 5.5
// low measured cheaper than every Sonnet setting on easy/hard tasks and
// about even on plan usage for real fixes, with roughly half the turns and
// equal correctness; this plan has no separate Opus weekly window. verify
// and operate move again, from v1's sonnet/low to opus/low. The underlying
// weights (1 and >=3) and the plain grid resolutions checked below are
// unchanged by either version — only the resolved model/effort moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './helpers.mjs';

test('recommend --type verify routes to opus/low under the routing trial (weight still 1)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'verify', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'low');
  assert.equal(res.json.weight, 1);
  assert.ok(res.json.trial, 'expected trial metadata on an overridden type');
  assert.equal(res.json.trial.gridResolution, 'haiku', 'the plain grid must still resolve verify to haiku');
});

test('recommend --type operate routes to opus/low under the routing trial (weight still >= 3, never haiku)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'operate', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'low');
  assert.ok(res.json.weight >= 3, `operate weight ${res.json.weight} must be >= 3`);
  assert.equal(res.json.trial.gridResolution, 'sonnet/medium', 'the plain grid must still resolve operate to sonnet/medium');
});

// CHANGED in slice 1b (ADR 0003 §1, operator-approved 2026-09-24): this used
// `--type verify --weight 1`, which EQUALS verify's preset weight. An explicit
// value equal to the preset now restates the type and keeps its trial, so the
// departure case uses weight 2 (still haiku on the plain grid).
test('an explicit --weight that departs from the preset bypasses the operate/verify trial override and falls back to the plain grid', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'verify', '--weight', '2', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'haiku', 'an explicit --weight is a deliberate deviation from the preset, not the trial');
  assert.equal(res.json.trial, undefined);
});

test('an explicit --weight EQUAL to the preset keeps the verify trial (slice 1b)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'verify', '--weight', '1', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(`${res.json.model}/${res.json.effort}`, 'opus/low');
  assert.ok(res.json.trial);
});

test('a trivial-looking multi-step procedure against a live system must not resolve to weight 1/haiku', () => {
  // The whole point of the distinction: "each step looks trivial" is not a
  // reason to route at verify's weight. Simulate by weight alone (3) with no
  // task type, matching what `operate` resolves to.
  const res = runScript('scripts/recommend.mjs', ['--weight', '3', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.notEqual(res.json.model, 'haiku');
});

test('--list includes both new task types with distinct weights', () => {
  const res = runScript('scripts/recommend.mjs', ['--list']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\bverify\s+w=1\b/);
  assert.match(res.stdout, /\boperate\s+w=3\b/);
});
