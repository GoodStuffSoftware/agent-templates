// A tier's retiresAfter drives WARNINGS only. Anthropic's dates are "no sooner
// than", so a model may keep resolving after one; the routing table falls back to
// a tier's `replacement` only when the operator sets that tier's `retired` to
// true. Haiku used to carry such a date (Haiku 4.5, 2026-10-15); that retirement
// was cancelled when Haiku 5.5 shipped, so the shipped haiku tier carries no
// retirement state. The mechanism is still live for any tier, so this file STAGES
// the old shape on haiku (in memory for the router, as a state-dir override for
// the scout) and proves the NO-fall-back side (date passed, flag unset: haiku
// still routes, still a valid reviewer and spawn target, and the scout keeps
// warning with the "set retired: true" text) and that setting the flag silences
// the warning. The flagged side is swept in tests/haiku-retirement-no-spawn.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const { resolveRoute, retirement, isModelAvailable, rungFor, modelTiers } = ctx;

const RETIRES_AFTER = '2026-10-15';
const STAGED = { retiresAfter: RETIRES_AFTER, retired: false, replacement: { model: 'sonnet', effort: 'low' } };
const AFTER = '2026-10-20T12:00:00Z'; // past retiresAfter, flag unset
const FAR_AFTER = '2027-03-01T12:00:00Z';

// Run `fn` with haiku carrying the staged retirement in the in-memory tier data.
function staged(fn, extra = {}) {
  const haiku = modelTiers().tiers.haiku;
  const saved = { ...haiku };
  try {
    Object.assign(haiku, STAGED, extra);
    return fn();
  } finally {
    for (const k of Object.keys(haiku)) delete haiku[k];
    Object.assign(haiku, saved);
  }
}

test('shipped config: haiku is Haiku 5.5 and carries no retirement state', () => {
  const t = modelTiers().tiers.haiku;
  assert.equal(t.resolvesTo.modelId, 'claude-haiku-5-5');
  assert.equal(t.resolvesTo.retirementNotBefore, '2027-10-07');
  for (const k of ['retiresAfter', 'retired', 'retiredNote', 'replacement']) assert.equal(k in t, false, k);
  assert.equal(retirement('haiku', AFTER), null);
  assert.equal(retirement('haiku', FAR_AFTER), null);
  assert.equal(isModelAvailable('haiku', FAR_AFTER), true);
});

test('no fall-back: past retiresAfter with the flag unset, retirement() says pastDate but not retired', () => {
  staged(() => {
    for (const now of [AFTER, FAR_AFTER]) {
      const r = retirement('haiku', now);
      assert.equal(r.pastDate, true, now);
      assert.equal(r.retired, false, now);
      assert.ok(r.daysLeft < 0);
    }
    const before = retirement('haiku', '2026-10-01T12:00:00Z');
    assert.equal(before.pastDate, false);
    assert.equal(before.retired, false);
  });
});

test('no fall-back: haiku is still an available model after the date', () => {
  staged(() => {
    assert.equal(isModelAvailable('haiku', AFTER), true);
    assert.equal(isModelAvailable('claude-haiku-5-5', FAR_AFTER), true);
  });
});

test('no fall-back: raw weight 1/2 still resolve to haiku after the date', () => {
  staged(() => {
    for (const w of [1, 2]) {
      const r = resolveRoute({ weight: w, weightExplicit: true, now: AFTER, profile: false });
      assert.equal(r.model, 'haiku', `weight ${w}`);
      assert.equal(rungFor(r.model, r.effort || null)?.agent, 'ac-haiku');
    }
  });
});

test('no fall-back: explore (the haiku trial row) still routes to haiku after the date', () => {
  staged(() => {
    for (const type of ['explore']) {
      const r = resolveRoute({ type, now: AFTER, profile: false });
      assert.equal(r.model, 'haiku', type);
      assert.equal(r.layer, 'trial', type);
      assert.equal(r.skipped.length, 0, `${type}: no F4 skip while haiku still resolves`);
    }
  });
});

test('no fall-back: a haiku writer is reviewed on haiku (not sonnet) after the date', () => {
  staged(() => {
    const r = resolveRoute({ type: 'code-review', writer: { model: 'haiku', effort: 'medium' }, now: AFTER, profile: false });
    assert.equal(r.model, 'haiku');
  });
});

test('retired: true counts even with no retiresAfter (a later release deleting the date must not silently re-route to a retired model)', () => {
  staged(() => {
    const haiku = modelTiers().tiers.haiku;
    delete haiku.retiresAfter;
    assert.equal(retirement('haiku', AFTER), null, 'no date and no flag: no retirement record');
    haiku.retired = true;
    const r = retirement('haiku', AFTER);
    assert.equal(r.retired, true);
    assert.equal(r.retiresAfter, null);
    assert.equal(r.daysLeft, null);
    assert.equal(r.pastDate, false);
    assert.equal(isModelAvailable('haiku', AFTER), false);
    assert.equal(resolveRoute({ weight: 1, weightExplicit: true, now: AFTER, profile: false }).model, 'sonnet');
    assert.equal(resolveRoute({ type: 'explore', now: AFTER, profile: false }).model, 'sonnet');
  });
});

// --- the scout: warnings, never routing --------------------------------------

function detect(fakeNow, override) {
  const f = makeFixture();
  try {
    if (override) {
      mkdirSync(f.stateDir, { recursive: true });
      writeFileSync(join(f.stateDir, 'model-tiers.json'), JSON.stringify(override));
    }
    const res = runScript('scripts/detect.mjs', [], { cwd: f.dir, env: { AGENT_COMPANION_FAKE_NOW: fakeNow }, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    return res.json.signals.find((s) => s.kind === 'model_retirement_approaching');
  } finally {
    f.cleanup();
  }
}

const STAGE_OVERRIDE = { tiers: { haiku: STAGED } };

test('scout: the shipped config raises no retirement warning, before or after the old 2026-10-15 date', () => {
  for (const now of ['2026-10-05T12:00:00.000Z', '2026-10-20T12:00:00.000Z', '2027-03-01T12:00:00.000Z']) {
    assert.equal(detect(now), undefined, now);
  }
});

test('scout: past the date with the flag unset warns, says haiku may still resolve, and names the flag', () => {
  const sig = detect('2026-10-20T12:00:00.000Z', STAGE_OVERRIDE);
  assert.ok(sig, 'expected a model_retirement_approaching signal');
  assert.match(sig.detail, /haiku is 5 day\(s\) past its retiresAfter date \(2026-10-15\)/);
  assert.match(sig.detail, /set retired: true once haiku stops resolving/);
  assert.match(sig.detail, /replacement staged: sonnet \(effort low\) takes over only once tiers\.haiku\.retired is true/);
});

test('scout: inside the 30-day window the text also names the flag, not an automatic date switch', () => {
  const sig = detect('2026-10-05T12:00:00.000Z', STAGE_OVERRIDE);
  assert.ok(sig);
  assert.match(sig.detail, /haiku retires in 10 day\(s\) \(2026-10-15\)/);
  assert.match(sig.detail, /set retired: true once haiku stops resolving/);
  assert.doesNotMatch(sig.detail, /takes over automatically/);
});

test('scout: once the operator sets retired: true the warning stops', () => {
  const sig = detect('2026-10-20T12:00:00.000Z', { tiers: { haiku: { ...STAGED, retired: true } } });
  assert.equal(sig, undefined, JSON.stringify(sig));
});
