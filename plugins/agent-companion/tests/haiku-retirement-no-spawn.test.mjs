// Proves the retirement date staged in config/model-tiers.json
// (tiers.haiku.retiresAfter/replacement) actually stops the routing table
// from ever naming `ac-haiku` — or the bare `haiku` alias — as a spawn
// target once the date passes. tests/retirement-window.test.mjs proves the
// scout's WARNING fires inside the 30-day window; tests/route-parity.test.mjs
// already covers the single code-review/haiku-writer case as part of its own
// F1-F5 matrix. This file is the dedicated, exhaustive sweep: every shipped
// task type resolved as-is, every raw weight x kind combination (bypassing
// any type/trial), and a code-review writer pinned to haiku — each checked
// at the day before retiresAfter (still allowed) and the day after (retired).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const {
  resolveRoute, rungFor, taskTypeNames, modelTiers,
} = ctx;

// Pin this file to the retirement date actually in the shipped config, so a
// future change to that date fails loudly here instead of this test quietly
// checking the wrong two days.
const RETIRES_AFTER = modelTiers().tiers.haiku.retiresAfter;
assert.equal(
  RETIRES_AFTER,
  '2026-10-15',
  'tiers.haiku.retiresAfter moved in config/model-tiers.json — update BEFORE/AFTER below to match',
);

const BEFORE = '2026-10-14T12:00:00Z'; // one day before retiresAfter: still allowed
const AFTER = '2026-10-16T12:00:00Z'; // one full day past retiresAfter: retired

function assertNeverHaiku(route, label) {
  assert.notEqual(route.model, 'haiku', `${label}: resolved model must not be haiku after retirement`);
  const rung = route.model && route.model !== 'fable' ? rungFor(route.model, route.effort) : null;
  if (rung) assert.notEqual(rung.agent, 'ac-haiku', `${label}: ladder rung must not be ac-haiku after retirement`);
}

// --- sanity: the fake clock actually matters --------------------------------
// A raw weight with no named type bypasses every shipped ROUTING TRIAL
// override and hits the plain grid — the one place haiku is still a live
// default before retirement (every named weight-1/2 task type currently
// carries a trial override away from haiku already). Proving BEFORE really
// does resolve to haiku here means AFTER resolving away from it below is the
// retirement mechanism doing the work, not an artifact of the trials.
test('sanity: weight 1/2 with no declared type resolves to haiku before retirement (plain grid)', () => {
  for (const w of [1, 2]) {
    const r = resolveRoute({
      weight: w, weightExplicit: true, now: BEFORE, profile: false,
    });
    assert.equal(r.model, 'haiku', `weight ${w} before retirement`);
  }
});

test('sanity: the same raw weights resolve to the staged replacement after retirement', () => {
  for (const w of [1, 2]) {
    const r = resolveRoute({
      weight: w, weightExplicit: true, now: AFTER, profile: false,
    });
    assert.equal(r.model, 'sonnet', `weight ${w} after retirement`);
    assert.equal(r.effort, 'low', `weight ${w} after retirement`);
    assert.equal(r.retiredFrom ?? null, null); // retiredFrom is a routeForWeight-only field, not surfaced on resolveRoute's grid result
  }
});

// --- every shipped task type, resolved as-is --------------------------------
// code-review is a parity type (needs --writer) and is covered in its own
// section below, not here.
const NAMED_TYPES = taskTypeNames({ profile: false }).filter((n) => n !== 'code-review');
assert.ok(NAMED_TYPES.length > 0, 'expected at least one shipped task type to sweep');
for (const name of NAMED_TYPES) {
  test(`task type "${name}" as-is: never routes to haiku after retirement`, () => {
    const r = resolveRoute({ type: name, now: AFTER, profile: false });
    assertNeverHaiku(r, `type ${name}`);
  });
}

// --- every raw weight x kind (bypassing any type/trial) ---------------------
const WEIGHTS = [1, 2, 3, 4, 5];
const KINDS = ['mechanical', 'bounded', 'diagnostic', 'novel-design'];
for (const w of WEIGHTS) {
  for (const k of KINDS) {
    test(`weight ${w} x kind ${k}: never routes to haiku after retirement`, () => {
      const r = resolveRoute({
        weight: w, kind: k, weightExplicit: true, kindExplicit: true, now: AFTER, profile: false,
      });
      assertNeverHaiku(r, `weight ${w}/${k}`);
    });
  }
}

// --- code-review with a writer pinned to haiku ------------------------------
for (const effort of ['', 'low']) {
  const tag = effort || '(none)';
  test(`code-review writer=haiku/${tag}: before retirement the writer model passes through unchanged`, () => {
    const r = resolveRoute({
      type: 'code-review', writer: { model: 'haiku', effort }, now: BEFORE, profile: false,
    });
    assert.equal(r.model, 'haiku');
  });
  test(`code-review writer=haiku/${tag}: after retirement the reviewer stands in on the staged replacement`, () => {
    const r = resolveRoute({
      type: 'code-review', writer: { model: 'haiku', effort }, now: AFTER, profile: false,
    });
    assertNeverHaiku(r, `code-review writer haiku/${tag}`);
    assert.equal(r.model, 'sonnet', 'the staged replacement for haiku is sonnet');
    assert.equal(r.effort, effort || 'low', 'reviewer effort is at least the writer\'s, floored to the replacement\'s own effort when the writer took none');
  });
}
