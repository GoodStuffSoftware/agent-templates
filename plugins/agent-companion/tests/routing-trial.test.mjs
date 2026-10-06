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
import { detectEnv } from './detect-env.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));

// 2026-10-02 (trial v4): the five simple types leave opus/low. Cache reads
// cost the same on Opus 5.5 and Sonnet 5, so opus/low is about 1.2-1.55x
// Sonnet 5 medium; reads and checks go to haiku, the rest to sonnet/low.
const CHANGED = [
  ['explore', 'haiku', ''],
  ['verify', 'haiku', ''],
  ['mechanical-edit', 'sonnet', 'low'],
  ['subagent-worker', 'sonnet', 'low'],
  ['operate', 'sonnet', 'low'],
];
const V4_SINCE = '2026-10-02';
const V4_REVIEW_BY = '2026-10-16';

// The 2026-09-27 amendment (trial v3): these four moved, so their
// trialSince is the amendment date and their reviewBy is a week later.
const AMENDED = [
  ['bounded-feature', 'opus', 'medium'],
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
const AMENDED_REVIEW_BY = '2026-10-04';

for (const [type, model, effort] of AMENDED) {
  test(`recommend --type ${type} routes to ${model}/${effort} under the trial (v3, since ${AMENDED_SINCE})`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
    assert.ok(res.json.trial, `${type} must report trial metadata`);
    assert.equal(res.json.trial.trialSince, AMENDED_SINCE);
    assert.equal(res.json.trial.reviewBy, AMENDED_REVIEW_BY);
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

test('the five v4 rows state the corrected opus/low cost (about 1.2-1.55x Sonnet medium)', () => {
  for (const [type] of CHANGED) {
    const r = cfg.taskTypes[type].override.reason;
    assert.match(r, /cache reads cost the same/i, type);
    assert.match(r, /1\.2-1\.55x Sonnet 5 MEDIUM/, type);
  }
});

test('base routing: explore and verify route to haiku, mechanical-edit, operate and subagent-worker to sonnet/low (no profile)', () => {
  for (const [type, model, effort] of CHANGED) {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model, type);
    assert.equal(res.json.effort, effort, type);
  }
  // everything the correction must NOT touch
  for (const [type, model, effort] of [['bounded-feature', 'opus', 'medium'], ['integration', 'opus', 'medium'], ['debug-root-cause', 'opus', 'medium']]) {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.json.model, model, type);
    assert.equal(res.json.effort, effort, type);
  }
});

for (const [type, model, effort] of CHANGED) {
  test(`recommend --type ${type} routes to ${model}/${effort} under the trial`, () => {
    const res = runScript('scripts/recommend.mjs', ['--type', type, '--json']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
    assert.ok(res.json.trial, `${type} must report trial metadata`);
    assert.equal(res.json.trial.trialSince, V4_SINCE);
    assert.equal(res.json.trial.reviewBy, V4_REVIEW_BY);
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
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.model, model);
    assert.equal(res.json.effort, effort);
    assert.equal(res.json.trial.trialSince, V4_SINCE);
    assert.equal(res.json.trial.reviewBy, V4_REVIEW_BY);
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

test('integration (v3): the 0.29.2 "effort" decision moved it to opus/medium via its own explicit F5 waiver (the elevated floor itself stays high)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'integration', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'medium');
  assert.equal(res.json.trial.gridResolution, 'sonnet/high');
  // The waiver itself is proven via the human-readable --explain text (the
  // structured --json route shape does not carry it): "why" and "explain"
  // must both say the row's own waiver is honoured, not a lowered floor.
  const explained = runScript('scripts/recommend.mjs', ['--type', 'integration', '--explain']);
  assert.match(explained.stdout, /waiver:\s+F5 elevated effort floor — HONOURED: operator-observed row waives the elevated effort floor \(F5\)/);
  assert.match(explained.stdout, /floors:\s+F5 waived: effort medium kept below high/);
});

test('debug-root-cause explicitly overrides the diagnostic kind\'s +1 effort delta, not a silent kind change', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'opus');
  assert.equal(res.json.effort, 'medium', 'v3: level with bounded-feature at medium, even though the diagnostic kind would normally add +1');
  assert.equal(res.json.trial.overridesKindDelta, true);
  // The grid resolution recorded alongside the override must show what the
  // diagnostic +1 delta would otherwise have produced (sonnet/xhigh: weight 4
  // routes to sonnet/high, diagnostic shifts effort up one step) — proving
  // the override is a deliberate, visible departure, not an unlabelled one.
  assert.equal(res.json.trial.gridResolution, 'sonnet/xhigh');
  assert.match(res.json.rationale, /EXPLICIT override/i);
});

test('debug-root-cause (v3) sits level with bounded-feature, not one rung above it', () => {
  const debug = runScript('scripts/recommend.mjs', ['--type', 'debug-root-cause', '--json']);
  const feature = runScript('scripts/recommend.mjs', ['--type', 'bounded-feature', '--json']);
  assert.equal(debug.json.effort, feature.json.effort);
  assert.notEqual(debug.json.effort, 'low');
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

test('every override in config/model-tiers.json carries evidence, trialSince and reviewBy', () => {
  // integration's trial moved again on 2026-09-24 (0.29.2 "effort" decision),
  // so it carries a later trialSince than the rest of the 2026-09-23 window;
  // every override still shares the same reviewBy.
  const trialSinceByType = {
    integration: '2026-09-24',
    'bounded-feature': '2026-09-27',
    'debug-root-cause': '2026-09-27',
    'large-refactor': '2026-09-27',
    'novel-design': '2026-09-27',
  };
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    if (!t.override) continue;
    const ov = t.override;
    assert.ok(ov.model, `${name}.override.model`);
    assert.ok(ov.reason, `${name}.override.reason`);
    assert.ok(ov.evidence?.source, `${name}.override.evidence.source`);
    const v4 = CHANGED.some(([type]) => type === name) || ARCH_V4.some(([type]) => type === name);
    assert.equal(ov.trialSince, v4 ? V4_SINCE : (trialSinceByType[name] || '2026-09-23'), `${name}.override.trialSince`);
    const amended = AMENDED.some(([type]) => type === name);
    assert.equal(ov.reviewBy, v4 ? V4_REVIEW_BY : (amended ? AMENDED_REVIEW_BY : '2026-09-30'), `${name}.override.reviewBy`);
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
      env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: '2026-10-01T00:00:00.000Z' } }),
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    // integration (reviewBy 2026-09-30) is the only row due on 2026-10-01.
    assert.equal(sigs.length, 1, `expected exactly 1 routing_trial_review_due signal, got ${sigs.length}`);
    const names = sigs.map((s) => s.detail);
    assert.ok(names.some((d) => d.startsWith('integration routing trial due for review')));
    // The five v4 rows review on 2026-10-16, so they are not due yet.
    for (const [type] of CHANGED) {
      assert.ok(!names.some((d) => d.startsWith(`${type} routing trial due`)), `${type} is not due before ${V4_REVIEW_BY}`);
    }
    // The four v3 rows review on 2026-10-04, so they are not due yet.
    for (const [type] of AMENDED) {
      assert.ok(!names.some((d) => d.startsWith(`${type} routing trial due`)), `${type} is not due before ${AMENDED_REVIEW_BY}`);
    }
    assert.match(sigs[0].detail, /routing trial due for review: compare spawn telemetry outcomes and escalation rates since 2026-09-24/);
    assert.match(sigs[0].detail, /reviewBy 2026-09-30/);
    for (const s of sigs) assert.equal(s.dispatch, 'routing-review');
    void stateDir;
  } finally {
    cleanup();
  }
});

test('scout raises the four v3 rows on their own reviewBy (2026-10-04)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: '2026-10-04T00:00:00.000Z' } }),
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    for (const [type] of AMENDED) {
      const s = sigs.find((x) => x.detail.startsWith(`${type} routing trial due for review`));
      assert.ok(s, `${type} must be due on ${AMENDED_REVIEW_BY}`);
      assert.match(s.detail, /since 2026-09-27 \(reviewBy 2026-10-04 has passed\)/);
    }
  } finally {
    cleanup();
  }
});

test('scout raises the five v4 rows on their own reviewBy (2026-10-16)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: '2026-10-16T00:00:00.000Z' } }),
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    for (const [type] of CHANGED) {
      const s = sigs.find((x) => x.detail.startsWith(`${type} routing trial due for review`));
      assert.ok(s, `${type} must be due on ${V4_REVIEW_BY}`);
      assert.match(s.detail, /since 2026-10-02 \(reviewBy 2026-10-16 has passed\)/);
    }
  } finally {
    cleanup();
  }
});

test('scout is silent on routing_trial_review_due before reviewBy', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: '2026-09-25T00:00:00.000Z' } }),
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
      env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: '2026-09-30T00:00:00.000Z' } }),
    });
    assert.equal(res.status, 0, res.stderr);
    const sigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    assert.ok(sigs.length > 0, 'reviewBy is inclusive: the finding must fire on the date itself');
  } finally {
    cleanup();
  }
});
