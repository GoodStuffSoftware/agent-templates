// Proves the fall-back mechanism (a tier's `replacement`) actually stops the
// routing table from ever naming `ac-haiku` -- or the bare `haiku` alias -- as a
// spawn target once a tier is flagged retired (`tiers.haiku.retired: true`).
// The shipped haiku tier (Haiku 5.5) carries no retirement state, since the
// planned Haiku 4.5 retirement was cancelled, so this file stages the whole
// shape as a state-dir override (retiresAfter, retired, replacement), the way
// the table looked while the retirement was planned.
// The date alone no longer does that: tests/haiku-retired-flag.test.mjs
// proves the NO-fall-back case (date passed, flag unset). tests/retirement-
// window.test.mjs proves the scout's WARNING. This file is the dedicated,
// exhaustive sweep of the flagged case: every shipped task type resolved
// as-is, every raw weight x kind combination (bypassing any type/trial), and
// a code-review writer pinned to haiku.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
// The staged retirement, merged over the shipped haiku tier (the per-tier merge
// keeps every other key).
const RETIRES_AFTER = '2026-10-15';
mkdirSync(fx.stateDir, { recursive: true });
writeFileSync(join(fx.stateDir, 'model-tiers.json'), JSON.stringify({
  tiers: { haiku: { retiresAfter: RETIRES_AFTER, retired: true, replacement: { model: 'sonnet', effort: 'low' } } },
}));
const ctx = await import('../hooks/lib/context.mjs');
const {
  resolveRoute, rungFor, taskTypeNames, modelTiers,
} = ctx;

// The date is irrelevant once the flag is set; any clock gives the same answer.
const AFTER = '2026-10-16T12:00:00Z';
const EARLY = '2026-09-01T12:00:00Z'; // long before retiresAfter, flag still set

function assertNeverHaiku(route, label) {
  assert.notEqual(route.model, 'haiku', `${label}: resolved model must not be haiku after retirement`);
  const rung = route.model && route.model !== 'fable' ? rungFor(route.model, route.effort) : null;
  if (rung) assert.notEqual(rung.agent, 'ac-haiku', `${label}: ladder rung must not be ac-haiku after retirement`);
}

// --- sanity: the flag, not the clock, does the work ------------------------
test('sanity: with the flag set, retirement() reports retired on any date and the merge kept the staged replacement', () => {
  for (const now of [EARLY, AFTER]) {
    const r = ctx.retirement('haiku', now);
    assert.equal(r.retired, true, now);
    assert.equal(r.replacement.model, 'sonnet');
    assert.equal(r.replacement.effort, 'low');
  }
  assert.equal(modelTiers().tiers.haiku.retiresAfter, RETIRES_AFTER);
  assert.equal(modelTiers().tiers.haiku.resolvesTo.modelId, 'claude-haiku-5-5', 'the override must not have replaced the whole tier');
});

test('sanity: weight 1/2 with the flag set resolve to the staged replacement even before the date', () => {
  for (const w of [1, 2]) {
    const r = resolveRoute({ weight: w, weightExplicit: true, now: EARLY, profile: false });
    assert.equal(r.model, 'sonnet', `weight ${w}`);
    assert.equal(r.effort, 'low', `weight ${w}`);
  }
});

test('sanity: the same raw weights resolve to the staged replacement after the date too', () => {
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
for (const effort of ['', 'low', 'medium']) {
  const tag = effort || '(none)';
  test(`code-review writer=haiku/${tag}: after retirement the reviewer stands in on the staged replacement`, () => {
    const r = resolveRoute({
      type: 'code-review', writer: { model: 'haiku', effort }, now: AFTER, profile: false,
    });
    assertNeverHaiku(r, `code-review writer haiku/${tag}`);
    assert.equal(r.model, 'sonnet', 'the staged replacement for haiku is sonnet');
    assert.equal(r.effort, effort || 'low', 'reviewer effort is at least the writer\'s, floored to the replacement\'s own effort when the writer took none');
  });
}
