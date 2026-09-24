// ADR 0003 slice 1 acceptance gate: resolveRoute() changes no routing.
//
// tests/fixtures/route-golden/expected.json holds what resolveExpected()
// returned BEFORE resolveRoute() existed, generated from the pinned commit
// recorded in its `source` block by generate.mjs (never by the code under
// test, never by hand). For every case in cases.mjs — every shipped task type
// plus "no type" and an unknown type, crossed with every declared weight,
// kind and consequence (preset-equal values and departures alike), at a clock
// before and after the haiku retirement date — this asserts:
//   1. resolveRoute() gives the same (model, effort);
//   2. the resolveExpected() wrapper returns the identical object, rationale
//      and trial metadata included (it is the compatibility surface);
//   3. no floor fired, except in the one permitted carve-out below.
//
// THE CARVE-OUT (ADR §9 slice 1: "except where a shipped override would
// break a floor"). The old resolver returned a trial override BEFORE any
// consequence floor ran. So a caller passing a consequence WITHOUT
// consequenceExplicit (the type is still "as-is", so its trial applies) got
// the trial unfloored: debug-root-cause + critical came back opus/low. With
// floors applied after every layer, those cases now get F1 (critical) or F5
// (elevated). Exactly 17 cases per clock (34 in all): every trial type x
// {elevated, critical} given without the explicit flag, minus integration,
// large-refactor and novel-design x elevated, whose trials already sit at
// the high floor. Operator-decided 2026-09-24: keep floors-after-trial.
// No shipped caller reaches this shape; tests/route-reachability.test.mjs
// pins that.
//
// THE RESTATED-PRESET CHANGE (slice 1b, operator-approved 2026-09-24; ADR
// §1: only a value that DEPARTS from the preset skips layers 1-2). An
// explicit weight/kind/consequence EQUAL to the type's preset used to count
// as a departure and fall to the grid ("TYPE: integration" + "WEIGHT: 4" ->
// sonnet/high). It now restates the type. So each case is compared with the
// baseline of the same case with its preset-equal explicit fields dropped —
// which is the old answer whenever nothing was dropped. The number of cases
// whose answer this changes is pinned below.
//
// Any OTHER difference, or a different count, fails here — a data finding to
// report, not a fixture to regenerate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, makeFixture } from './helpers.mjs';
import { buildCases, CLOCKS } from './fixtures/route-golden/cases.mjs';

// Hermetic BEFORE the first modelTiers() call: no per-machine override file.
const fx = makeFixture();
const ctx = await import('../hooks/lib/context.mjs');
test.after(() => fx.cleanup());

const golden = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'route-golden', 'expected.json'), 'utf8'));
const cfg = ctx.modelTiers();
const cases = buildCases({
  typeNames: Object.keys(cfg.taskTypes || {}),
  kinds: Object.keys(cfg.taskKinds || {}),
  consequences: Object.keys(cfg.consequence || {}),
});
// JSON round-trip: the fixture cannot hold `undefined` or NaN, so compare in
// the same representation.
const plain = (v) => JSON.parse(JSON.stringify(v));

function expectedFor(key, ci) {
  const bar = key.indexOf('|');
  const row = golden.cases[key.slice(0, bar)]?.[key.slice(bar + 1)];
  return row ? golden.results[row[ci]] : undefined;
}

test('the fixture was generated from a pinned commit and covers exactly the current case matrix', () => {
  assert.ok(golden.source?.commitSubject && golden.source?.commitDate, 'fixture must name the baseline commit');
  for (const rel of ['hooks/lib/context.mjs', 'config/model-tiers.json']) {
    assert.match(golden.source?.sha256?.[rel] || '', /^[0-9a-f]{64}$/, `baseline sha256 for ${rel}`);
  }
  assert.deepEqual(golden.clocks, CLOCKS);
  assert.equal(golden.caseCount, cases.length * CLOCKS.length,
    'the case matrix changed (a task type, kind or consequence was added or removed) — regenerate from a trusted baseline ref');
  for (const c of cases) assert.ok(expectedFor(c.key, 0), `fixture has no entry for ${c.key}`);
});

const CARVE_OUT_PER_CLOCK = 17;
const FLOOR_LABEL = { critical: 'F1', elevated: 'F5' };
// Candidate carve-out: a trial type as-is, with a consequence given but not
// flagged explicit. Whether a floor actually fires is asserted, not assumed.
const isCarveOutShape = (c) => !!c.args.type && c.args.consequence !== undefined && !c.args.consequenceExplicit
  && !!cfg.taskTypes?.[c.args.type]?.override && (c.args.consequence === 'critical' || c.args.consequence === 'elevated');

function assertCarveOut(c, want, route, wrapped) {
  const cons = c.args.consequence;
  const spec = cfg.consequence[cons];
  // The baseline really was the unfloored trial.
  assert.ok(want.trial, `${c.key}: baseline should be the trial`);
  assert.equal(route.layer, 'trial', `${c.key}: the trial still wins; only the floor lifts it`);
  assert.equal(route.model, want.model, `${c.key}: model unchanged (the trial model already meets the model floor)`);
  // The floor fired, and the result is exactly that floor.
  assert.ok(route.floorsApplied.length >= 1, `${c.key}: no floor recorded`);
  assert.ok(route.floorsApplied.every((f) => f.floor === FLOOR_LABEL[cons]), `${c.key}: ${JSON.stringify(route.floorsApplied)}`);
  assert.equal(route.effort, spec.effortFloor, `${c.key}: effort should equal the ${cons} floor`);
  if (spec.modelFloor) {
    assert.ok(cfg.tiers[route.model].rank >= cfg.tiers[spec.modelFloor].rank, `${c.key}: below the ${cons} model floor`);
  }
  // The compatibility wrapper carries the same floored answer, the same
  // trial metadata, and the baseline rationale with the floor appended.
  assert.deepStrictEqual({ ...wrapped, effort: want.effort, rationale: want.rationale }, want, `${c.key}: wrapper drifted beyond the floor`);
  assert.equal(wrapped.effort, route.effort);
  assert.ok(wrapped.rationale.startsWith(want.rationale) && /floors: F[15] /.test(wrapped.rationale), `${c.key}: ${wrapped.rationale}`);
}

// 98 = the 10 trial types x every combination of preset-equal explicit
// fields (weight, kind, consequence; "inherit" also equals a routine preset),
// excluding "none explicit": 7 routine-preset types x 11 + 3 elevated x 7.
const RESTATED_PER_CLOCK = 98;
const normCons = (v) => (v === 'inherit' ? 'routine' : v);
// The key of the same case with every explicit field that EQUALS the type's
// preset dropped (to "not given").
function restatedKey(c) {
  const t = c.args.type ? cfg.taskTypes?.[c.args.type] : null;
  if (!t) return c.key;
  const [type, w, k, co] = c.key.split('|');
  const a = c.args;
  const w2 = a.weightExplicit && a.weight === t.weight ? 'w=-' : w;
  const k2 = a.kindExplicit && a.kind === (t.kind || 'bounded') ? 'k=-' : k;
  const c2 = a.consequenceExplicit && normCons(a.consequence) === normCons(t.consequence || 'routine') ? 'c=-' : co;
  return [type, w2, k2, c2].join('|');
}

CLOCKS.forEach((clock, ci) => {
  test(`resolveRoute matches the pre-ADR-0003 resolver on all ${cases.length} cases at ${clock} (floor carve-out: exactly ${CARVE_OUT_PER_CLOCK}; restated preset: exactly ${RESTATED_PER_CLOCK})`, () => {
    const mismatches = [];
    const floorHits = [];
    let carved = 0;
    let restated = 0;
    for (const c of cases) {
      const rk = restatedKey(c);
      const want = expectedFor(rk, ci);
      if (rk !== c.key && JSON.stringify(want) !== JSON.stringify(expectedFor(c.key, ci))) restated += 1;
      const route = ctx.resolveRoute({ ...c.args, now: clock });
      if (isCarveOutShape(c) && route.floorsApplied.length) {
        assertCarveOut(c, want, route, plain(ctx.resolveExpected({ ...c.args, now: clock })));
        carved += 1;
        continue;
      }
      if (route.model !== want.model || route.effort !== want.effort) {
        mismatches.push(`${c.key}: resolveRoute ${route.model}/${route.effort} (layer ${route.layer}) vs baseline ${want.model}/${want.effort}`);
      }
      const wrapped = plain(ctx.resolveExpected({ ...c.args, now: clock }));
      try { assert.deepStrictEqual(wrapped, want); } catch {
        mismatches.push(`${c.key}: resolveExpected shape differs\n  got  ${JSON.stringify(wrapped)}\n  want ${JSON.stringify(want)}`);
      }
      if (route.floorsApplied.length) floorHits.push(`${c.key}: ${JSON.stringify(route.floorsApplied)}`);
    }
    assert.deepEqual(floorHits, [], 'a floor fired outside the carve-out: a shipped layer breaks a floor — report it, do not regenerate');
    assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches`);
    assert.equal(carved, CARVE_OUT_PER_CLOCK, 'the floor carve-out changed size — report it, do not adjust the count');
    assert.equal(restated, RESTATED_PER_CLOCK, 'the restated-preset change reaches a different number of cases — report it, do not adjust the count');
  });
});

test('the golden matrix exercises every layer outcome it should', () => {
  // A guard against a matrix that silently stops reaching a branch.
  const seen = new Set();
  for (const c of cases) {
    const r = ctx.resolveRoute({ ...c.args, now: CLOCKS[0] });
    seen.add(r.layer);
    if (r.skipped.some((s) => s.layer === 'trial')) seen.add('trial-skipped');
  }
  for (const want of ['trial', 'grid', null, 'trial-skipped']) assert.ok(seen.has(want), `no case reached ${want}`);
  // And the retirement clock really changes something (weight 1-2 grid rows).
  const a = ctx.resolveRoute({ weight: 1, weightExplicit: true, now: CLOCKS[0] });
  const b = ctx.resolveRoute({ weight: 1, weightExplicit: true, now: CLOCKS[1] });
  assert.notEqual(`${a.model}/${a.effort}`, `${b.model}/${b.effort}`, 'the post-retirement clock no longer exercises the staged replacement');
});
