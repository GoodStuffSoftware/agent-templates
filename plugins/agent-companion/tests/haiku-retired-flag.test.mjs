// tiers.haiku.retiresAfter drives WARNINGS only. Anthropic's date is "no
// sooner than", so haiku may keep resolving after it; the routing table falls
// back to tiers.haiku.replacement (sonnet/low) only when the operator sets
// tiers.haiku.retired to true. This file proves the NO-fall-back side (date
// passed, flag unset: haiku still routes, still a valid reviewer and spawn
// target, and the scout keeps warning with the "set retired: true" text) and
// that setting the flag silences the warning. The flagged side is swept in
// tests/haiku-retirement-no-spawn.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { detectEnv } from './detect-env.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const { resolveRoute, retirement, isModelAvailable, rungFor, modelTiers } = ctx;

const RETIRES_AFTER = modelTiers().tiers.haiku.retiresAfter;
const AFTER = '2026-10-20T12:00:00Z'; // past retiresAfter, flag unset
const FAR_AFTER = '2027-03-01T12:00:00Z';

test('shipped config: haiku carries retired: false and a staged sonnet/low replacement', () => {
  const t = modelTiers().tiers.haiku;
  assert.equal(t.retired, false);
  assert.equal(t.replacement.model, 'sonnet');
  assert.equal(t.replacement.effort, 'low');
});

test('no fall-back: past retiresAfter with the flag unset, retirement() says pastDate but not retired', () => {
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

test('no fall-back: haiku is still an available model after the date', () => {
  assert.equal(isModelAvailable('haiku', AFTER), true);
  assert.equal(isModelAvailable('claude-haiku-4-5', FAR_AFTER), true);
});

test('no fall-back: raw weight 1/2 still resolve to haiku after the date', () => {
  for (const w of [1, 2]) {
    const r = resolveRoute({ weight: w, weightExplicit: true, now: AFTER, profile: false });
    assert.equal(r.model, 'haiku', `weight ${w}`);
    assert.equal(rungFor(r.model, r.effort || null)?.agent, 'ac-haiku');
  }
});

test('no fall-back: explore and verify (the haiku trial rows) still route to haiku after the date', () => {
  for (const type of ['explore', 'verify']) {
    const r = resolveRoute({ type, now: AFTER, profile: false });
    assert.equal(r.model, 'haiku', type);
    assert.equal(r.layer, 'trial', type);
    assert.equal(r.skipped.length, 0, `${type}: no F4 skip while haiku still resolves`);
  }
});

test('no fall-back: a haiku writer is reviewed on haiku (not sonnet) after the date', () => {
  const r = resolveRoute({ type: 'code-review', writer: { model: 'haiku', effort: '' }, now: AFTER, profile: false });
  assert.equal(r.model, 'haiku');
});

test('retired: true counts even with no retiresAfter (a later release deleting the date must not silently re-route to a retired model)', () => {
  const haiku = modelTiers().tiers.haiku;
  const saved = { ...haiku };
  try {
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
  } finally {
    for (const k of Object.keys(haiku)) delete haiku[k];
    Object.assign(haiku, saved);
  }
});

// --- the scout: warnings, never routing --------------------------------------

function detect(fakeNow, override) {
  const f = makeFixture();
  try {
    if (override) {
      mkdirSync(f.stateDir, { recursive: true });
      writeFileSync(join(f.stateDir, 'model-tiers.json'), JSON.stringify(override));
    }
    const res = runScript('scripts/detect.mjs', [], { cwd: f.dir, env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: fakeNow } }) });
    assert.equal(res.status, 0, res.stderr);
    return res.json.signals.find((s) => s.kind === 'model_retirement_approaching');
  } finally {
    f.cleanup();
  }
}

test('scout: past the date with the flag unset warns, says haiku may still resolve, and names the flag', () => {
  const sig = detect('2026-10-20T12:00:00.000Z');
  assert.ok(sig, 'expected a model_retirement_approaching signal');
  assert.match(sig.detail, /haiku is 5 day\(s\) past its retiresAfter date \(2026-10-15\)/);
  assert.match(sig.detail, /set retired: true once haiku stops resolving/);
  assert.match(sig.detail, /replacement staged: sonnet \(effort low\) takes over only once tiers\.haiku\.retired is true/);
});

test('scout: inside the 30-day window the text also names the flag, not an automatic date switch', () => {
  const sig = detect('2026-10-05T12:00:00.000Z');
  assert.ok(sig);
  assert.match(sig.detail, /haiku retires in 10 day\(s\) \(2026-10-15\)/);
  assert.match(sig.detail, /set retired: true once haiku stops resolving/);
  assert.doesNotMatch(sig.detail, /takes over automatically/);
});

test('scout: once the operator sets retired: true the warning stops', () => {
  const sig = detect('2026-10-20T12:00:00.000Z', { tiers: { haiku: { retired: true } } });
  assert.equal(sig, undefined, JSON.stringify(sig));
});
