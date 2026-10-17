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
// v2 (same trial window, operator-endorsed): Opus 5.5 low took roughly half
// the turns with equal correctness on the benchmark tasks, and this plan has
// no separate Opus weekly window -- so explore,
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
// opus/medium is below the elevated-consequence effort floor (F5, still
// high — this was NOT lowered globally, so it still floors a grid-path
// elevated route or any other declared CONSEQUENCE: elevated). Instead,
// integration's own trial override carries an explicit F5 waiver
// (waivesFloor/source, the same shape a per-user routing-profile row uses),
// honoured because the evidence is the operator's own first-hand
// observation. large-refactor and novel-design stay at opus/high, already at
// the floor; critical-change is unaffected (F1/xhigh, not F5). A separate,
// non-waivable floor (F6) still refuses opus/low for any architecture-class
// type (integration, large-refactor, novel-design, critical-change) at every
// layer, waiver or not — see tests/architecture-floor.test.mjs. See
// tests/architecture-floor-diff.test.mjs for the differential proof that no
// route other than integration's own trial moved.
//
// v3 amendment (2026-09-27, operator-approved, reviewBy 2026-10-04 for the
// four moved rows so their review sees a week of data; others stay 2026-09-30):
// live evidence moves four rows. bounded-feature and debug-root-cause go
// opus/low -> opus/medium (low -> medium is Opus 5.5's largest cheap
// capability step; opus/low fell short on the hard architecture task).
// large-refactor and novel-design go opus/high -> opus/xhigh (only xhigh
// passed the subtle-rule architecture task 4/4). Nothing routes to max. The
// v2 cost claim for opus/low is corrected: real-world tasks put it at
// 1.05-1.53x Sonnet 5 medium at API prices, so its case is capability, not
// price. The other opus/low rows keep their route and trialSince.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, makeFixture, runScript } from './helpers.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

// v5 (2026-10-16 verdicts, DECISIONS.md; the lead chose sonnet/high for
// bounded-feature): verify moves to sonnet/low, bounded-feature and
// integration move to sonnet/high. integration's F5 waiver is gone (sonnet/high
// meets the elevated floor of high). reviewBy is removed from the settled rows
// (mechanical-edit, operate, debug-root-cause, novel-design); large-refactor,
// long-autonomous-run and subagent-worker are reviewed on 2026-10-30; explore
// keeps its 2026-10-16 review.
const SHIPPED_ROWS = {
  // type: [model, effort, trialSince, reviewBy or null (no review date: settled)]
  explore: ['haiku', 'medium', '2026-10-02', '2026-10-16'],
  'mechanical-edit': ['sonnet', 'low', '2026-10-02', null],
  'subagent-worker': ['sonnet', 'low', '2026-10-02', '2026-10-30'],
  operate: ['sonnet', 'low', '2026-10-02', null],
  verify: ['sonnet', 'low', '2026-10-02', null],
  'bounded-feature': ['sonnet', 'high', '2026-09-27', null],
  integration: ['sonnet', 'high', '2026-09-24', null],
  'debug-root-cause': ['opus', 'medium', '2026-09-27', null],
  'novel-design': ['opus', 'xhigh', '2026-09-27', null],
  'large-refactor': ['opus', 'high', '2026-10-02', '2026-10-30'],
  'long-autonomous-run': ['opus', 'high', '2026-10-02', '2026-10-30'],
};
const rowOf = (type) => {
  const [model, effort, trialSince, reviewBy] = SHIPPED_ROWS[type];
  return { type, model, effort, trialSince, reviewBy };
};
const REVIEW_DATED = Object.keys(SHIPPED_ROWS).filter((t) => SHIPPED_ROWS[t][3]);

// 2026-10-02 (trial v4): the simple types leave opus/low. Cache reads cost the
// same on Opus 5.5 and Sonnet 5, so opus/low is about 1.2-1.55x Sonnet 5
// medium; reads go to haiku, the rest to sonnet/low. verify moved on again in
// v5 (sonnet/low); its reason no longer carries the opus/low cost text.
const CHANGED = [
  ['explore', 'haiku', 'medium'],
  ['verify', 'sonnet', 'low'],
  ['mechanical-edit', 'sonnet', 'low'],
  ['subagent-worker', 'sonnet', 'low'],
  ['operate', 'sonnet', 'low'],
];
// The rows whose reason still states the corrected opus/low cost (v4 text).
const V4_COST_TEXT = ['explore', 'mechanical-edit', 'subagent-worker', 'operate'];
const V4_SINCE = '2026-10-02';

// The 2026-09-27 amendment (trial v3) rows that still sit where it put them,
// plus bounded-feature, which v5 moved to sonnet/high (trialSince unchanged).
const AMENDED = [
  ['bounded-feature', 'sonnet', 'high'],
  ['debug-root-cause', 'opus', 'medium'],
  ['novel-design', 'opus', 'xhigh'],
];
// 2026-10-02 (trial v4): large-refactor and long-autonomous-run move from
// opus/xhigh to opus/high (xhigh: 17.7 plan units per spawn, 21% re-spawned;
// high: 16.6, 10%). novel-design and critical-change stay on xhigh.
const ARCH_V4 = [
  ['large-refactor', 'opus', 'high'],
  ['long-autonomous-run', 'opus', 'high'],
];
const AMENDED_SINCE = '2026-09-27';

function assertTrial(res, type) {
  const want = rowOf(type);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, want.model, type);
  assert.equal(res.json.effort, want.effort, type);
  assert.ok(res.json.trial, `${type} must report trial metadata`);
  assert.equal(res.json.trial.trialSince, want.trialSince, type);
  if (want.reviewBy) assert.equal(res.json.trial.reviewBy, want.reviewBy, type);
  else assert.ok(!res.json.trial.reviewBy, `${type} is settled: no reviewBy`);
}

for (const [type, model, effort] of AMENDED) {
  test(`recommend --type ${type} routes to ${model}/${effort} under the trial (since ${AMENDED_SINCE}, settled: no reviewBy)`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assertTrial(res, type);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
  });
}

test('nothing in the shipped table routes to max', () => {
  for (const name of Object.keys(cfg.taskTypes)) {
    if (cfg.taskTypes[name].weight === 'parity') continue;
    const res = runScript('scripts/recommend.mjs', ['--type', name, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(res.json.effort, 'max', `${name} must not route to max`);
  }
});

test('no shipped trial reason still claims Opus low is cheaper than, or costs the same as, Sonnet', () => {
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    if (!t.override) continue;
    assert.doesNotMatch(t.override.reason, /cheaper than (every )?sonnet/i, `${name}.override.reason`);
    // The v2 premise ("about the same as Sonnet on the plan") was wrong; a
    // reason may quote it only to say it was wrong.
    for (const m of t.override.reason.matchAll(/(costs?|priced?|runs?) (about )?the same as sonnet[^.]*\./gi)) {
      assert.match(m[0], /was wrong/i, `${name}.override.reason repeats the corrected premise: ${m[0]}`);
    }
  }
});

test('the four v4 rows that kept their reason state the corrected opus/low cost (about 1.2-1.55x Sonnet medium)', () => {
  for (const type of V4_COST_TEXT) {
    const r = cfg.taskTypes[type].override.reason;
    assert.match(r, /cache reads cost the same/i, type);
    assert.match(r, /1\.2-1\.55x Sonnet 5 MEDIUM/, type);
  }
});

test('base routing: explore routes to haiku; verify, mechanical-edit, operate and subagent-worker to sonnet/low (no profile)', () => {
  for (const [type, model, effort] of CHANGED) {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model, type);
    assert.equal(res.json.effort, effort, type);
  }
  // everything the correction must NOT touch
  for (const [type, model, effort] of [['bounded-feature', 'sonnet', 'high'], ['integration', 'sonnet', 'high'], ['debug-root-cause', 'opus', 'medium']]) {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.json.model, model, type);
    assert.equal(res.json.effort, effort, type);
  }
});

for (const [type, model, effort] of CHANGED) {
  test(`recommend --type ${type} routes to ${model}/${effort} under the trial`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(model, rowOf(type).model);
    assert.equal(effort, rowOf(type).effort);
    assertTrial(res, type);
  });
}

// integration is checked separately (not in CHANGED above): its trial moved
// on 2026-09-24 (0.29.2 "effort" decision, opus/high -> opus/medium) and again
// in v5 (2026-10-16 verdicts, opus/medium -> sonnet/high), so its trialSince
// differs from the rest of the 2026-09-23 window and it carries no reviewBy.
test('recommend --type integration routes to sonnet/high under the routing trial (v5, since 2026-09-24, settled)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'integration', '--json']);
  assertTrial(res, 'integration');
  assert.equal(res.json.model, 'sonnet');
  assert.equal(res.json.effort, 'high');
});

test('novel-design explicitly overrides the novel-design kind\'s +2 effort delta, not a silent kind change', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'novel-design', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'xhigh');
  assert.equal(res.json.trial.overridesKindDelta, true);
  // weight 5 -> xhigh, pushed up two ranks by the novel-design kind's +2
  // delta, clamped at max -- the override is a deliberate departure from
  // that escalation (stop at xhigh), not an unlabelled one.
  assert.equal(res.json.trial.gridResolution, 'opus/max');
});

for (const [type, model, effort] of ARCH_V4) {
  test(`${type} routes to ${model}/${effort} under trial v4 (since ${V4_SINCE}), while the plain grid still says opus/xhigh`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assertTrial(res, type);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
    assert.equal(res.json.trial.reviewBy, '2026-10-30');
    assert.equal(res.json.trial.gridResolution, 'opus/xhigh');
  });
}

test('novel-design and critical-change stay on opus/xhigh after the v4 architecture move', () => {
  for (const type of ['novel-design', 'critical-change']) {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.json.model, 'opus', type);
    assert.equal(res.json.effort, 'xhigh', type);
  }
});

test('integration (v5): sonnet/high meets the elevated effort floor (F5, high) by itself: the shipped row carries no waiver', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'integration', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'sonnet');
  assert.equal(res.json.effort, 'high');
  assert.equal(res.json.trial.gridResolution, 'sonnet/high');
  // No waiver in the config, and none in the human-readable --explain text.
  // (The waiver path itself is proven in tests/architecture-floor-diff.test.mjs.)
  const ov = cfg.taskTypes.integration.override;
  assert.ok(!Object.keys(ov).some((k) => /waive/i.test(k)), `integration.override must carry no waiver key: ${Object.keys(ov).join(',')}`);
  const explained = runScript('scripts/recommend.mjs', ['--type', 'integration', '--explain']);
  assert.doesNotMatch(explained.stdout, /waiver:/);
  assert.doesNotMatch(explained.stdout, /F5 waived/);
});

test('debug-root-cause explicitly overrides the diagnostic kind\'s +1 effort delta, not a silent kind change', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'medium', 'v3: opus/medium, even though the diagnostic kind would normally add +1');
  assert.equal(res.json.trial.overridesKindDelta, true);
  // The grid resolution recorded alongside the override must show what the
  // diagnostic +1 delta would otherwise have produced (sonnet/xhigh: weight 4
  // routes to sonnet/high, diagnostic shifts effort up one step) — proving
  // the override is a deliberate, visible departure, not an unlabelled one.
  assert.equal(res.json.trial.gridResolution, 'sonnet/xhigh');
  assert.match(res.json.rationale, /EXPLICIT override/i);
});

test('debug-root-cause (opus/medium) is the one writer type that stays on opus; bounded-feature (v5) is sonnet/high, and neither is at low effort', () => {
  const debug = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  const feature = runScript('scripts/recommend.mjs', ['--type', 'bounded-feature', '--json']);
  assert.equal(debug.json.model, 'opus');
  assert.equal(feature.json.model, 'sonnet');
  assert.ok(debug.json.rung > feature.json.rung, `debug-root-cause rung ${debug.json.rung} is above bounded-feature rung ${feature.json.rung}`);
  assert.notEqual(debug.json.effort, 'low');
  assert.notEqual(feature.json.effort, 'low');
});

const UNMEASURED = [
  ['critical-change', 4, 'bounded', 'critical'],
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

test('every override in config/model-tiers.json carries evidence and trialSince; reviewBy is present exactly on the dated rows and absent on the settled ones', () => {
  const overrides = Object.entries(cfg.taskTypes).filter(([, t]) => t.override).map(([name]) => name).sort();
  assert.deepEqual(overrides, Object.keys(SHIPPED_ROWS).sort(), 'the table and this test name the same override rows');
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    if (!t.override) continue;
    const ov = t.override;
    const want = rowOf(name);
    assert.ok(ov.model, `${name}.override.model`);
    assert.ok(ov.reason, `${name}.override.reason`);
    assert.ok(ov.evidence?.source, `${name}.override.evidence.source`);
    assert.equal(ov.model, want.model, `${name}.override.model`);
    assert.equal(ov.effort, want.effort, `${name}.override.effort`);
    assert.equal(ov.trialSince, want.trialSince, `${name}.override.trialSince`);
    if (want.reviewBy) assert.equal(ov.reviewBy, want.reviewBy, `${name}.override.reviewBy`);
    else assert.equal(ov.reviewBy, undefined, `${name}.override.reviewBy is removed on a settled row`);
  }
});

// --- Scout: routing trial due for review --------------------------------
// detect.mjs reads AGENT_COMPANION_FAKE_NOW (a fake clock, no real waiting
// for the calendar) so this is deterministic on any date. Only a row that
// carries a reviewBy can be due: explore (2026-10-16) and large-refactor,
// long-autonomous-run and subagent-worker (2026-10-30).
function dueSignals(fakeNow) {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: { AGENT_COMPANION_FAKE_NOW: fakeNow } });
    assert.equal(res.status, 0, res.stderr);
    return res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
  } finally {
    cleanup();
  }
}
const dueTypes = (sigs) => sigs.map((s) => s.detail.split(' ')[0]).sort();

test('scout raises routing_trial_review_due once reviewBy has passed', () => {
  const sigs = dueSignals('2026-10-17T00:00:00.000Z');
  // explore (reviewBy 2026-10-16) is the only row due on 2026-10-17.
  assert.deepEqual(dueTypes(sigs), ['explore'], `expected only explore; got ${JSON.stringify(sigs.map((s) => s.detail))}`);
  assert.match(sigs[0].detail, /explore routing trial due for review: compare spawn telemetry outcomes and escalation rates since 2026-10-02/);
  assert.match(sigs[0].detail, /reviewBy 2026-10-16/);
  for (const s of sigs) assert.equal(s.dispatch, 'routing-review');
});

test('scout raises the three 2026-10-30 rows on their own reviewBy, on top of explore', () => {
  const sigs = dueSignals('2026-10-30T00:00:00.000Z');
  assert.deepEqual(dueTypes(sigs), ['explore', 'large-refactor', 'long-autonomous-run', 'subagent-worker']);
  for (const type of ['large-refactor', 'long-autonomous-run', 'subagent-worker']) {
    const s = sigs.find((x) => x.detail.startsWith(`${type} routing trial due for review`));
    assert.ok(s, `${type} must be due on 2026-10-30`);
    assert.match(s.detail, /since 2026-10-02 \(reviewBy 2026-10-30 has passed\)/);
  }
});

test('scout never raises a settled row (no reviewBy), however late the clock', () => {
  const sigs = dueSignals('2027-01-01T00:00:00.000Z');
  assert.deepEqual(dueTypes(sigs), REVIEW_DATED.slice().sort());
  for (const type of ['mechanical-edit', 'operate', 'verify', 'bounded-feature', 'integration', 'debug-root-cause', 'novel-design']) {
    assert.ok(!sigs.some((s) => s.detail.startsWith(`${type} routing trial due`)), `${type} is settled: no review date, no finding`);
  }
});

test('scout is silent on routing_trial_review_due before reviewBy', () => {
  const sigs = dueSignals('2026-10-15T00:00:00.000Z');
  assert.equal(sigs.length, 0, `expected no routing_trial_review_due signals before reviewBy; got: ${JSON.stringify(sigs)}`);
});

test('scout fires exactly on the reviewBy date itself (not only strictly after)', () => {
  const sigs = dueSignals('2026-10-16T00:00:00.000Z');
  assert.deepEqual(dueTypes(sigs), ['explore'], 'reviewBy is inclusive: the finding must fire on the date itself');
});
