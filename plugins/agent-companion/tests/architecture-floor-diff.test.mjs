// Differential proof for the 0.29.2 "effort" track: the resolver LOGIC it
// changed (a trial override may carry its own F5 waiver; the new F6
// architecture floor) moves exactly one route on the shipped table —
// integration's own trial, to opus/medium — and nothing else.
//
// How it stays robust to later table edits: the 0.29.2 tracks' common base
// resolver (hooks/lib/context.mjs only, vendored byte for byte under
// fixtures/architecture-floor-diff/reference/; its sha256 is in BASELINE.json,
// and the exact commit id lives in 0292-SPEC.md, outside this repo) is staged
// against the CURRENT config, next to the current resolver on the same
// config. A table edit (a trial retuned, a reviewBy extended, a trial ended)
// moves both sides alike, so it stays green; only a change to the resolution
// logic, or a new waiver on some other trial row, shows up as a difference.
// Only model, effort and winning layer are compared, never rationale text.
//
// The invariant checked over every task type crossed with every declared
// weight x kind x consequence (route-golden.test.mjs's matrix):
//   - every differing case names integration and wins through its trial on
//     both sides;
//   - its new answer is exactly INTEGRATION_WANT (opus/medium) — so a trial
//     moved to opus/xhigh (no difference at all) or anything else fails;
//   - at least one case differs (the test is not vacuous).
// When the 2026-09-30 review of integration's trial changes its answer,
// INTEGRATION_WANT is the one value to update here (and, if the waiver is
// dropped, this file's reason to exist ends with it).
//
// Why a difference exists at all: the base resolver ignores a trial row's
// waivesFloor and lifts integration's opus/medium to the elevated floor
// (F5, high); the current one honours the row's operator-observed waiver.
// The first version of this track lowered the elevated floor globally
// instead, which moved every elevated route; this file is the proof that the
// row-scoped waiver moved only integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_ROOT, makeFixture } from './helpers.mjs';
import { buildCases, CLOCKS } from './fixtures/route-golden/cases.mjs';
import { stageResolver } from './fixtures/route-golden/live-gate.mjs';

const REFERENCE_DIR = join(PLUGIN_ROOT, 'tests', 'fixtures', 'architecture-floor-diff', 'reference');
const REFERENCE_FILES = ['hooks/lib/context.mjs'];
const baseline = JSON.parse(readFileSync(join(REFERENCE_DIR, 'BASELINE.json'), 'utf8'));
const INTEGRATION_WANT = { model: 'opus', effort: 'medium' };

function sha256Text(path) {
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

const fx = makeFixture();
const staged = [];
test.after(() => { for (const s of staged) s.cleanup(); fx.cleanup(); });

const BASE_CONTEXT = readFileSync(join(REFERENCE_DIR, 'hooks', 'lib', 'context.mjs'), 'utf8');
const CUR_CONTEXT = readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'context.mjs'), 'utf8');
const CUR_CONFIG = readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8');

async function stage(contextSource, configText) {
  const s = await stageResolver({ contextSource, configText });
  staged.push(s);
  return s.mod;
}

const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const shape = (r) => ({ model: r.model, effort: r.effort || '', layer: r.layer });

// The differential over one config text: base and current resolver, same
// config. Returns every differing case and the ones outside the invariant.
async function differential(configText) {
  const base = await stage(BASE_CONTEXT, configText);
  const cur = await stage(CUR_CONTEXT, configText);
  const cfg = cur.modelTiers();
  const cases = buildCases({
    typeNames: Object.keys(cfg.taskTypes || {}),
    kinds: Object.keys(cfg.taskKinds || {}),
    consequences: Object.keys(cfg.consequence || {}),
  });
  const changed = [];
  const violations = [];
  for (const now of CLOCKS) {
    for (const c of cases) {
      const o = shape(base.resolveRoute({ ...c.args, now }));
      const n = shape(cur.resolveRoute({ ...c.args, now }));
      if (JSON.stringify(o) === JSON.stringify(n)) continue;
      const tag = `${now.slice(0, 10)} ${c.key}: ${label(o)}@${o.layer} -> ${label(n)}@${n.layer}`;
      changed.push(tag);
      const ok = c.args.type === 'integration' && o.layer === 'trial' && n.layer === 'trial'
        && n.model === INTEGRATION_WANT.model && n.effort === INTEGRATION_WANT.effort;
      if (!ok) violations.push(tag);
    }
  }
  return { changed, violations };
}

function assertInvariant({ changed, violations }) {
  assert.ok(changed.length > 0, 'no case differs from the base resolver: integration\'s waived trial should (the test would otherwise be vacuous, and integration is not at opus/medium)');
  assert.deepEqual(violations.slice(0, 20), [], `${violations.length} case(s) differ outside "integration's trial, at ${label(INTEGRATION_WANT)}" (showing up to 20)`);
}

test('the vendored reference is the pinned baseline resolver, byte for byte', () => {
  for (const rel of REFERENCE_FILES) {
    const want = baseline.sha256?.[rel] || '';
    assert.match(want, /^[0-9a-f]{64}$/, `baseline sha256 for ${rel}`);
    assert.equal(sha256Text(join(REFERENCE_DIR, rel)), want, `reference/${rel} is not the baseline file — it must never be edited`);
  }
});

test('the base resolver predates trial waivers: on the current config it lifts integration\'s trial to the elevated floor', async () => {
  const base = await stage(BASE_CONTEXT, CUR_CONFIG);
  const r = base.resolveRoute({ type: 'integration' });
  assert.deepEqual(shape(r), { model: 'opus', effort: 'high', layer: 'trial' });
});

test('differential: on the current table, only integration\'s own trial differs from the base resolver, and it is exactly opus/medium', async () => {
  assertInvariant(await differential(CUR_CONFIG));
});

test('the differential rejects integration at opus/xhigh, and a waived trial on any other type', async () => {
  const cfg = JSON.parse(CUR_CONFIG);
  const xhigh = structuredClone(cfg);
  xhigh.taskTypes.integration.override.effort = 'xhigh';
  const x = await differential(JSON.stringify(xhigh));
  assert.throws(() => assertInvariant(x), /no case differs/);

  const other = structuredClone(cfg);
  other.taskTypes['large-refactor'].override = {
    ...other.taskTypes['large-refactor'].override, effort: 'medium', waivesFloor: 'elevated', source: 'operator-observed',
  };
  const o = await differential(JSON.stringify(other));
  assert.throws(() => assertInvariant(o), /outside/);
});

test('a grid-path elevated route (no type, explicit weight/consequence) still floors to high, not medium', async () => {
  const cur = await stage(CUR_CONTEXT, CUR_CONFIG);
  const r = cur.resolveRoute({ weight: 3, weightExplicit: true, consequence: 'elevated', consequenceExplicit: true });
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort medium -> high', within: 'grid' }]);
});

test('a declared CONSEQUENCE: elevated on an unrelated type also still floors to high', async () => {
  const cur = await stage(CUR_CONTEXT, CUR_CONFIG);
  // bounded-feature's own preset consequence is routine; an explicit elevated
  // departs from it, skipping the trial layer entirely and going to the grid.
  const r = cur.resolveRoute({ type: 'bounded-feature', consequence: 'elevated', consequenceExplicit: true });
  assert.equal(r.layer, 'grid');
  assert.equal(label(r), 'sonnet/high');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F5', raised: 'effort medium -> high', within: 'grid' }]);
});
