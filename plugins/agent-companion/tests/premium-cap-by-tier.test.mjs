// premium_cap counts by the resolved TIER, regardless of route (ADR 0003
// open question 8, decided 2026-09-24; slice 1b fix c).
//
// Before: a spawn whose route named opus (every trial-v2 type, and any
// future profile row) was exempt from the WARRANT and — because the guard
// returned early for it — from the fan-out cap too, so the cap no longer
// bounded concurrent opus agents for most task types. Now the route still
// exempts the warrant, but every premium-tier spawn (post-autofill) counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function harness(extraEnv = {}) {
  const fx = makeFixture();
  const env = { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '2', ...extraEnv };
  let n = 0;
  const spawn = (prompt, model, sid = 'sess-cap-tier') => {
    n += 1;
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: fx.dir,
      tool_input: { subagent_type: 'general-purpose', ...(model ? { model } : {}), run_in_background: true, name: `w${n}`, prompt },
    }, { env });
    assert.equal(res.status, 0, res.stderr);
    return { decision: res.json?.hookSpecificOutput?.permissionDecision, reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '' };
  };
  const window = () => { try { return JSON.parse(readFileSync(join(fx.stateDir, 'state', 'premium-window.json'), 'utf8')).length; } catch { return 0; } };
  const denials = () => readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl')).map((d) => d.guard);
  return { ...fx, spawn, window, denials };
}

test('routed opus spawns (no warrant needed) now count toward the cap, and the third is denied', () => {
  const h = harness();
  try {
    assert.equal(h.spawn('TYPE: debug-root-cause\ngo', 'opus').decision, 'allow');
    assert.equal(h.spawn('TYPE: debug-root-cause\ngo', 'opus').decision, 'allow');
    assert.equal(h.window(), 2);
    const third = h.spawn('TYPE: debug-root-cause\ngo', 'opus');
    assert.equal(third.decision, 'deny');
    assert.match(third.reason, /Premium fan-out cap/);
    assert.match(third.reason, /exempts it from the WARRANT but not from this cap/);
    assert.deepEqual(h.denials(), ['premium-cap']);
    assert.equal(h.window(), 2, 'a cap-denied spawn must not extend the window');
  } finally { h.cleanup(); }
});

test('an autofilled opus (no model named, TYPE routes to opus) counts too', () => {
  const h = harness();
  try {
    assert.equal(h.spawn('TYPE: debug-root-cause\ngo', null).decision, 'allow');
    assert.equal(h.window(), 1);
  } finally { h.cleanup(); }
});

test('non-premium tiers never count, routed or not', () => {
  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(h.spawn('WEIGHT: 3\ngo', 'sonnet').decision, 'allow');
    assert.equal(h.spawn('TYPE: explore\nWEIGHT: 1\ngo', 'haiku').decision, 'allow');
    assert.equal(h.window(), 0);
  } finally { h.cleanup(); }
});

test('a canary probe on a routed opus spawn does not consume the cap', () => {
  const h = harness();
  try {
    assert.equal(h.spawn('TYPE: debug-root-cause\ngo', 'opus', 'canary-cap-probe').decision, 'allow');
    assert.equal(h.window(), 0);
  } finally { h.cleanup(); }
});

test('premium_cap off: routed opus spawns are neither counted nor capped', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_PREMIUM_CAP: 'false' });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(h.spawn('TYPE: debug-root-cause\ngo', 'opus').decision, 'allow');
    assert.equal(h.window(), 0);
  } finally { h.cleanup(); }
});
