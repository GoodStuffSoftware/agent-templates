// Operator-approved routing trial, 2026-09-23 -> reviewBy 2026-09-30
// (config/model-tiers.json taskTypes.*.override). Benchmark evidence per task
// TYPE, not per weight: Opus 5.5 low/medium/xhigh all scored 7/7 on real bug
// fixes but medium cost ~1.56x plan usage and xhigh ~3.1x for no quality
// gain; Sonnet passed every synthetic task at every effort; Haiku cost ~2x
// Sonnet per task and was the only model to fail. This file asserts the
// resolved (model, effort) for every changed type, the explicit no-medium
// override on debug-root-cause, that unmeasured types are untouched, and that
// the scout raises a finding once reviewBy has passed.
//
// v2 (same trial window, operator-endorsed): Opus 5.5 low measured cheaper
// than every Sonnet setting on easy/hard tasks and about even on plan usage
// for real fixes, with roughly half the turns and equal correctness, and
// this plan has no separate Opus weekly window -- so explore,
// mechanical-edit, subagent-worker, verify, and operate move from v1's
// sonnet/low to opus/low. integration, large-refactor, and novel-design pick
// up their own v2 overrides too: integration (unmeasured by benchmark) moved
// model-only to opus/high on operator first-hand evidence that Sonnet
// struggles on some of the operator's multi-file technical work;
// large-refactor and novel-design (both already opus-routed) move from their
// natural xhigh/max down to opus/high, the trial's middle ground, because
// xhigh measured ~3.1x low's tokens for no quality gain and effort scaling on
// architecture work itself is unmeasured. critical-change (consequence floor)
// and long-autonomous-run (already grid-resolves to opus/xhigh) are
// deliberately left alone.
//
// v3 (2026-09-24, 0.29.2 "effort" architecture decision, DECISIONS.md,
// review 2026-09-30): integration moves again, opus/high -> opus/medium —
// the operator judged v2's opus/high heavier than integration work needs.
// Landing on medium required lowering the elevated-consequence effort floor
// (F5) from high to medium (config/model-tiers.json), since the floor would
// otherwise have raised any elevated-consequence trial straight back to
// high. large-refactor and novel-design deliberately stay at opus/high
// (already above the lower floor); critical-change is unaffected (F1/xhigh).
// A separate, non-waivable floor (F6) still refuses opus/low for any
// architecture-class type (integration, large-refactor, novel-design,
// critical-change) at every layer — see tests/architecture-floor.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, makeFixture, runScript } from './helpers.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

const CHANGED = [
  ['explore', 'opus', 'low'],
  ['mechanical-edit', 'opus', 'low'],
  ['subagent-worker', 'opus', 'low'],
  ['verify', 'opus', 'low'],
  ['operate', 'opus', 'low'],
  ['bounded-feature', 'opus', 'low'],
  ['debug-root-cause', 'opus', 'low'],
  ['large-refactor', 'opus', 'high'],
  ['novel-design', 'opus', 'high'],
];

for (const [type, model, effort] of CHANGED) {
  test(`recommend --type ${type} routes to ${model}/${effort} under the trial`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
    assert.ok(res.json.trial, `${type} must report trial metadata`);
    assert.equal(res.json.trial.trialSince, '2026-09-23');
    assert.equal(res.json.trial.reviewBy, '2026-09-30');
  });
}

// integration is checked separately (not in CHANGED above): its trial moved
// AGAIN on 2026-09-24 (0.29.2 "effort" architecture decision, opus/high ->
// opus/medium), so its trialSince differs from the rest of the 2026-09-23
// window while reviewBy stays the same.
test('recommend --type integration routes to opus/medium under the routing trial (v3, since 2026-09-24)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'integration', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'medium');
  assert.ok(res.json.trial, 'integration must report trial metadata');
  assert.equal(res.json.trial.trialSince, '2026-09-24');
  assert.equal(res.json.trial.reviewBy, '2026-09-30');
});

test('novel-design explicitly overrides the novel-design kind\'s +2 effort delta, not a silent kind change', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'novel-design', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'high');
  assert.equal(res.json.trial.overridesKindDelta, true);
  // weight 5 -> xhigh, pushed up two ranks by the novel-design kind's +2
  // delta, clamped at max -- the override is a deliberate departure from
  // that escalation, not an unlabelled one.
  assert.equal(res.json.trial.gridResolution, 'opus/max');
});

test('large-refactor overrides the plain weight-5 xhigh resolution down to high (no kind delta involved)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'large-refactor', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'high');
  assert.equal(res.json.trial.gridResolution, 'opus/xhigh');
});

test('integration (v3): the 0.29.2 "effort" decision moved it to opus/medium, which required lowering the elevated-consequence floor from high to medium', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'integration', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'medium');
  assert.equal(res.json.trial.gridResolution, 'sonnet/high');
});

test('debug-root-cause explicitly overrides the diagnostic kind\'s +1 effort delta, not a silent kind change', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'low', 'operator directive: no medium, even though diagnostic kind would normally add +1');
  assert.equal(res.json.trial.overridesKindDelta, true);
  // The grid resolution recorded alongside the override must show what the
  // diagnostic +1 delta would otherwise have produced (sonnet/xhigh: weight 4
  // routes to sonnet/high, diagnostic shifts effort up one step) — proving
  // the override is a deliberate, visible departure, not an unlabelled one.
  assert.equal(res.json.trial.gridResolution, 'sonnet/xhigh');
  assert.match(res.json.rationale, /EXPLICIT override/i);
});

test('debug-root-cause never resolves to medium effort regardless of how it is reached', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  assert.notEqual(res.json.effort, 'medium');
});

const UNMEASURED = [
  ['critical-change', 4, 'bounded', 'critical'],
  ['long-autonomous-run', 5, 'bounded', 'elevated'],
];

for (const [type, weight, kind, consequence] of UNMEASURED) {
  test(`unmeasured type ${type} keeps its pre-trial grid routing (no override)`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.trial, undefined, `${type} must not carry trial metadata — it is unbenchmarked`);
    // Cross-check against a raw --weight/--kind/--consequence call, which can
    // only ever use the plain grid (no --type, so no override to bypass).
    const raw = runScript('scripts/recommend.mjs', ['--weight', String(weight), '--kind', kind, '--consequence', consequence, '--json']);
    assert.equal(res.json.model, raw.json.model, `${type} model must match the plain grid`);
    assert.equal(res.json.effort, raw.json.effort, `${type} effort must match the plain grid`);
  });
}

test('code-review (parity-sized) is unaffected by the trial — no override, weight stays "parity"', () => {
  assert.equal(cfg.taskTypes['code-review'].override, undefined);
  const res = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'sonnet/high', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'sonnet');
  assert.equal(res.json.trial, undefined);
});

test('every override in config/model-tiers.json carries evidence, trialSince and reviewBy', () => {
  // integration's trial moved again on 2026-09-24 (0.29.2 "effort" decision),
  // so it carries a later trialSince than the rest of the 2026-09-23 window;
  // every override still shares the same reviewBy.
  const trialSinceByType = { integration: '2026-09-24' };
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    if (!t.override) continue;
    const ov = t.override;
    assert.ok(ov.model, `${name}.override.model`);
    assert.ok(ov.reason, `${name}.override.reason`);
    assert.ok(ov.evidence?.source, `${name}.override.evidence.source`);
    assert.equal(ov.trialSince, trialSinceByType[name] || '2026-09-23', `${name}.override.trialSince`);
    assert.equal(ov.reviewBy, '2026-09-30', `${name}.override.reviewBy`);
  }
});

// --- Scout: routing trial due for review --------------------------------
// detect.mjs reads AGENT_COMPANION_FAKE_NOW (a fake clock, no real waiting
// for the calendar to reach 2026-09-30) so this is deterministic on any date.
test('scout raises routing_trial_review_due once reviewBy has passed', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: { AGENT_COMPANION_FAKE_NOW: '2026-10-01T00:00:00.000Z' },
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    assert.ok(sigs.length >= CHANGED.length, `expected at least ${CHANGED.length} routing_trial_review_due signals, got ${sigs.length}`);
    const names = sigs.map((s) => s.detail);
    assert.ok(names.some((d) => d.startsWith('debug-root-cause routing trial due for review')));
    assert.match(sigs[0].detail, /routing trial due for review: compare spawn telemetry outcomes and escalation rates since 2026-09-23/);
    assert.match(sigs[0].detail, /reviewBy 2026-09-30/);
    for (const s of sigs) assert.equal(s.dispatch, 'routing-review');
    void stateDir;
  } finally {
    cleanup();
  }
});

test('scout is silent on routing_trial_review_due before reviewBy', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: { AGENT_COMPANION_FAKE_NOW: '2026-09-25T00:00:00.000Z' },
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    assert.equal(sigs.length, 0, `expected no routing_trial_review_due signals before reviewBy; got: ${JSON.stringify(sigs)}`);
  } finally {
    cleanup();
  }
});

test('scout fires exactly on the reviewBy date itself (not only strictly after)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: { AGENT_COMPANION_FAKE_NOW: '2026-09-30T00:00:00.000Z' },
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    assert.ok(sigs.length > 0, 'reviewBy is inclusive: the finding must fire on the date itself');
  } finally {
    cleanup();
  }
});
