// Batch 1 of the daily usage analysis (0.31.18): the metric registry under scripts/lib/usage/metrics/.
// (1) register parity: the 14 register metrics evaluate byte-identically to the pre-move code
//     (golden generated from decision-register.mjs before the move);
// (2) id freeze: the 14 ids, their sources and the catalog projection;
// (3) weight sources: haiku and fable plan weights are NOT layered from planUsageMultipliers
//     (the table has no entry for them), so they live in the checkup's unit spec only.
// Synthetic fixtures; nothing reads the operator's register, telemetry or network.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRIC_CATALOG, validateRegister } from '../scripts/lib/decision-register.mjs';
import * as registry from '../scripts/lib/usage/metrics/index.mjs';
import { unitsOf, resetUnitCache } from '../scripts/lib/daily-checkup.mjs';
import { planPriceSpecFor, planBaselineModel } from '../scripts/lib/pricing.mjs';
import { modelTiers } from '../hooks/lib/context.mjs';
import { runParity, METRIC_IDS } from './metric-registry-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const FROZEN = [
  'unitsPerSpawn', 'mainUnitsPerDay', 'shareOver150kPct', 'compactionsPer100Spawns', 'ceilingNudgesPerDay',
  'leadEffortShare', 'reviewsPerWriter', 'haikuSpawns', 'leadRebriefsPer100Spawns', 'reviewFixShareByLeadEffort',
  'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare', 'mainUnitsPerLeadSpawn', 'shareOverCeilingPct',
];

test('parity: all 14 register metrics give byte-identical evaluations on fixture history and spawns', () => {
  const golden = readFileSync(join(here, 'fixtures', 'metric-registry', 'parity.golden.json'), 'utf8');
  const now = JSON.stringify(runParity(), null, 1) + '\n';
  assert.equal(now, golden);
  // the fixture really exercises every metric: each has qualifying days
  const parsed = JSON.parse(now);
  for (const id of FROZEN) assert.ok(parsed[id].plain.days.some((d) => d.qualifies), `${id} has no qualifying day in the fixture`);
});

test('id freeze: the 14 register ids, in order, with their sources', () => {
  assert.deepEqual(METRIC_IDS, FROZEN);
  assert.deepEqual(Object.keys(METRIC_CATALOG), FROZEN);
  assert.deepEqual([...registry.FROZEN_REGISTER_IDS], FROZEN);
  assert.deepEqual(METRIC_CATALOG, {
    unitsPerSpawn: 'history', mainUnitsPerDay: 'history', shareOver150kPct: 'history', compactionsPer100Spawns: 'history', ceilingNudgesPerDay: 'history',
    leadEffortShare: 'spawns', reviewsPerWriter: 'spawns', haikuSpawns: 'spawns', leadRebriefsPer100Spawns: 'spawns', reviewFixShareByLeadEffort: 'spawns',
    leadRoutingDeniesPer100Spawns: 'spawns', leadUnderProvisionedShare: 'spawns', mainUnitsPerLeadSpawn: 'history', shareOverCeilingPct: 'history',
  });
  assert.deepEqual(registry.registerCatalog(), METRIC_CATALOG, 'the register catalog is a projection of the registry');
  assert.deepEqual([...registry.LEAD_LEVEL_METRICS].sort(), ['leadRebriefsPer100Spawns', 'leadRoutingDeniesPer100Spawns', 'leadUnderProvisionedShare', 'reviewFixShareByLeadEffort']);
  assert.deepEqual([...registry.PER_DAY_TOTALS].sort(), ['ceilingNudgesPerDay', 'mainUnitsPerDay']);
});

test('registry entries: shape, unique ids, M/E labels, a day() function', () => {
  const seen = new Set();
  for (const m of registry.listMetrics()) {
    assert.ok(!seen.has(m.id), `duplicate id ${m.id}`); seen.add(m.id);
    assert.ok(['history', 'spawns', 'facts', 'plan-meter', 'routines'].includes(m.source), m.id);
    assert.ok(['M', 'E'].includes(m.label), `${m.id} needs a measured/estimated label`);
    assert.ok(['ratio', 'sum', 'median', 'p90'].includes(m.pool), m.id);
    assert.equal(m.entity, 'day');
    assert.equal(typeof m.day, 'function');
    assert.ok(Array.isArray(m.needs) && m.needs.length > 0, m.id);
    assert.equal(registry.getMetric(m.id), m);
  }
  assert.equal(registry.getMetric('nope'), null);
  assert.equal(registry.getMetric('leadRebriefsPer100Spawns').label, 'E', 'the re-brief heuristic is unvalidated');
});

test('metricDayStat keeps its contract: a stat or { gap: true }, never a zero for missing data', () => {
  const { metricDayStat } = registry;
  assert.deepEqual(metricDayStat({ metric: 'mainUnitsPerDay', params: {} }, { units: { total: 100, main: 70 } }, undefined), { num: 70, den: 1, scale: 1, sample: 100 });
  assert.deepEqual(metricDayStat({ metric: 'shareOver150kPct', params: {} }, { units: { total: 100, subagent: 80 }, subagent: { unitsOver150k: 20 } }), { num: 20, den: 80, scale: 100, sample: 80 });
  assert.deepEqual(metricDayStat({ metric: 'shareOverCeilingPct', params: {} }, { units: { total: 100, subagent: 80 }, subagent: { unitsOver150k: 20, ceilingTokens: 175000, unitsOverCeiling: 12 } }), { num: 12, den: 80, scale: 100, sample: 80 });
  assert.deepEqual(metricDayStat({ metric: 'shareOverCeilingPct', params: {} }, { units: { total: 100, subagent: 80 }, subagent: { unitsOver150k: 20 } }), { gap: true }, 'a record without a ceiling (before 0.31.24) is a gap, never the 150K share');
  assert.deepEqual(metricDayStat({ metric: 'shareOverCeilingPct', params: {} }, { units: { total: 100, subagent: 80 }, subagent: { unitsOver150k: 20, ceilingTokens: null, unitsOverCeiling: null } }), { gap: true }, 'a day on two ceilings is a gap');
  const ceilingStat = registry.getMetric('shareOverCeilingPct').stat;
  assert.deepEqual(ceilingStat([{ kind: 'day', hist: { units: { subagent: 40 }, subagent: { ceilingTokens: 200000, unitsOverCeiling: 10 } } }]),
    { num: 10, den: 40, scale: 100, sample: 40, detail: { ceilingTokens: 200000, unitsOverCeiling: 10 } }, 'the runner reads the history record');
  assert.equal(ceilingStat([{ kind: 'day', hist: { units: { subagent: 40 }, subagent: { unitsOver150k: 9 } } }]).gap, true);
  assert.deepEqual(metricDayStat({ metric: 'mainUnitsPerDay', params: {} }, { units: { total: 0, main: 0 } }), { gap: true }, 'a zero-unit day is a gap');
  assert.deepEqual(metricDayStat({ metric: 'mainUnitsPerDay', params: {} }, { units: { total: 50, main: 5 }, limit: { hits: 1 } }), { gap: true }, 'a limit-hit day is a gap for per-day totals');
  assert.notDeepEqual(metricDayStat({ metric: 'shareOver150kPct', params: {} }, { units: { total: 50, subagent: 10 }, subagent: { unitsOver150k: 1 }, limit: { hits: 1 } }), { gap: true }, 'but not for ratio metrics');
  assert.deepEqual(metricDayStat({ metric: 'unitsPerSpawn', params: { type: 't' } }, null), { gap: true });
  assert.deepEqual(metricDayStat({ metric: 'unitsPerSpawn', params: { type: 't' } }, { spawns: { byType: {} } }), { gap: true });
  assert.deepEqual(metricDayStat({ metric: 'not-a-metric', params: {} }, { units: { total: 5 } }), { gap: true });
  assert.deepEqual(metricDayStat({ metric: 'mainUnitsPerDay' }, null), { gap: true }, 'missing params and record never throw');
});

test('the register validates against the registry catalog: unknown metric and wrong source are refused', () => {
  const reg = (metric, source) => ({
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'd', title: 't', status: 'active', decided: '2026-10-10', decision: 'x', reverse: 'y',
      premises: [{ id: 'p1', text: 'c', label: 'E' }],
      triggers: [{ id: 'm', premise: 'p1', kind: 'metric', source, metric, params: {}, op: '>', threshold: 1, minSample: 1, minDays: 1 }],
    }],
  });
  assert.equal(validateRegister(reg('haikuSpawns', 'spawns'), { rollout: {} }).ok, true);
  assert.match(validateRegister(reg('haikuSpawns', 'history'), { rollout: {} }).errors.join('|'), /reads source "spawns"/);
  assert.match(validateRegister(reg('madeUp', 'history'), { rollout: {} }).errors.join('|'), /unknown metric/);
});

// --- weight sources -------------------------------------------------------------------------
// The design asked: do planPriceSpecFor and modelTiers() layer the routing profile's
// planUsageMultipliers? They do not: modelTiers() merges only the shipped table and the
// model-tiers.json state override (by tier alias), and the shipped table has no haiku or fable
// entry. Haiku (0.5, E) and fable (5, E) are the checkup's FALLBACK_MULT in its unit spec, so no
// route-golden output can move from them. This test pins that finding.

const USAGE = { input: 1000, output: 400, cacheRead: 50000, cacheWrite: 2000 };

test('weight sources: only sonnet and opus come from planUsageMultipliers; haiku and fable have none', () => {
  const mults = modelTiers().planUsageMultipliers;
  assert.deepEqual(Object.keys(mults).filter((k) => typeof mults[k] === 'object' && mults[k] && 'multiplier' in mults[k]).sort(), ['opus', 'sonnet']);
  assert.equal(mults.sonnet.multiplier, 1.0);
  assert.equal(mults.opus.multiplier, 1.5);
  assert.equal(planPriceSpecFor('claude-haiku-5-5'), null, 'no haiku plan weight is layered in');
  assert.equal(planPriceSpecFor('claude-fable-5-1'), null, 'no fable plan weight is layered in');
  assert.ok(planPriceSpecFor('claude-opus-5-5'));
  assert.ok(planBaselineModel(), 'the baseline price vector is pinned');
});

test('weight sources: units per model are the baseline price vector times 1.0 / 1.5 / 0.5 (E) / 5 (E)', () => {
  resetUnitCache();
  const son = unitsOf(USAGE, 'claude-sonnet-5-5');
  assert.ok(son > 0);
  const ratio = (model) => unitsOf(USAGE, model) / son;
  assert.ok(Math.abs(ratio('claude-opus-5-5') - 1.5) < 1e-12, 'opus 1.5 (M, tooltip)');
  assert.ok(Math.abs(ratio('claude-haiku-5-5') - 0.5) < 1e-12, 'haiku 0.5 (E, checkup unit spec)');
  assert.ok(Math.abs(ratio('claude-fable-5-1') - 5) < 1e-12, 'fable 5 (E, checkup unit spec)');
  resetUnitCache();
});

test('zero-token and no-I/O: the registry modules import only each other and call no process, network or write API', () => {
  for (const f of ['index.mjs', 'helpers.mjs']) {
    const src = readFileSync(join(here, '..', 'scripts', 'lib', 'usage', 'metrics', f), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gms)].map((m) => m[1]);
    for (const i of imports) assert.ok(i.startsWith('./'), `${f} imports ${i}`);
    assert.doesNotMatch(src, /\b(spawn|exec|fork|fetch|writeFile)\w*\(/, f);
  }
});
