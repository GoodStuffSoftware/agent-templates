// A tier's retiresAfter should be surfaced by the scout every run once inside
// 30 days, not only on fixed milestones — a retirement date close enough to
// need a decision is worth a daily line, staged replacement or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';

function isoDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function writeOverride(stateDir, retiresAfter, { staged = true } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const cfg = {
    tiers: {
      haiku: {
        rank: 1,
        retiresAfter,
        ...(staged ? { replacement: { model: 'sonnet', effort: 'low' } } : {}),
      },
    },
  };
  writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify(cfg));
}

test('a staged tier 22 days from retirement is still flagged (inside the 30-day daily window)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeOverride(stateDir, isoDaysFromNow(22), { staged: true });
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'model_retirement_approaching');
    assert.ok(sig, `expected a model_retirement_approaching signal; got: ${JSON.stringify(res.json.signals)}`);
    assert.match(sig.detail, /haiku retires in 22 day/);
  } finally {
    cleanup();
  }
});

test('a tier 45 days out (past the 30-day window, on a fixed milestone) is still flagged', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeOverride(stateDir, isoDaysFromNow(45), { staged: true });
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'model_retirement_approaching');
    assert.ok(sig, `expected a milestone signal at 45 days; got: ${JSON.stringify(res.json.signals)}`);
  } finally {
    cleanup();
  }
});

test('a tier 50 days out (past the window, off the milestone list) is silent', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeOverride(stateDir, isoDaysFromNow(50), { staged: true });
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'model_retirement_approaching');
    assert.equal(sig, undefined, `expected no signal at 50 days; got: ${JSON.stringify(res.json.signals)}`);
  } finally {
    cleanup();
  }
});
