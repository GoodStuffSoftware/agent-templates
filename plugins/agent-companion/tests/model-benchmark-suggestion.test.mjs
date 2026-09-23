// detect.mjs suggests the model-benchmark skill on three conditions: a new
// model alias in the routing table's lineup, an alias-floor/harness-version
// drift signal, or a routing trial past its reviewBy. Advisory only — the
// scout never runs the benchmark itself (real model calls, real plan
// usage). See scripts/detect.mjs's suggestModelBenchmark().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';

function writeBaseline(extra) {
  writeFileSync(stateFile('baseline.json'), JSON.stringify({ checkedAt: '2026-01-01T00:00:00.000Z', ...extra }));
}

test('a genuinely NEW model alias in config/model-tiers.json triggers new_model_in_lineup AND the benchmark suggestion', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    // Seed a baseline that already saw every alias EXCEPT a made-up new one.
    writeBaseline({ knownModelAliases: ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({
      tiers: {
        'brand-new-tier': { rank: 5, premium: true, match: 'brand-new-tier', available: true },
      },
    }));
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const lineupSig = res.json.signals.find((s) => s.kind === 'new_model_in_lineup');
    assert.ok(lineupSig, `expected new_model_in_lineup; got: ${JSON.stringify(res.json.signals)}`);
    assert.match(lineupSig.detail, /brand-new-tier/);
    assert.equal(lineupSig.dispatch, 'routing-review');

    const benchSig = res.json.signals.find((s) => s.kind === 'model_benchmark_suggested');
    assert.ok(benchSig, `expected model_benchmark_suggested; got: ${JSON.stringify(res.json.signals)}`);
    assert.match(benchSig.detail, /brand-new-tier/);
    assert.match(benchSig.detail, /model-benchmark skill/);
    assert.match(benchSig.detail, /never runs it itself/);
    assert.equal(benchSig.dispatch, 'model-benchmark');
  } finally { cleanup(); }
});

test('no new alias since the last run: no new_model_in_lineup, no benchmark suggestion from that path', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeBaseline({ knownModelAliases: ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] });
    // Deliberately unchanged from the shipped config's own alias set.
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'new_model_in_lineup'), undefined);
    void stateDir;
  } finally { cleanup(); }
});

test('the FIRST ever run (no baseline.knownModelAliases at all) does not fire new_model_in_lineup for every shipped alias', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // No baseline.json at all -- a genuinely fresh install.
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'new_model_in_lineup'), undefined,
      'a fresh install must not treat every already-shipped alias as "new"');
  } finally { cleanup(); }
});

test('routing_trial_review_due also fires the benchmark suggestion (reuses the existing fake-clock test setup)', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], {
      cwd: dir,
      env: { AGENT_COMPANION_FAKE_NOW: '2026-10-01T00:00:00.000Z' },
    });
    assert.equal(res.status, 0, res.stderr);
    const trialSigs = res.json.signals.filter((s) => s.kind === 'routing_trial_review_due');
    assert.ok(trialSigs.length > 0, 'expected at least one routing_trial_review_due (see tests/routing-trial.test.mjs)');
    const benchSigs = res.json.signals.filter((s) => s.kind === 'model_benchmark_suggested');
    assert.ok(benchSigs.length >= trialSigs.length, `expected a benchmark suggestion per overdue trial; got ${benchSigs.length} for ${trialSigs.length} trials`);
    assert.ok(benchSigs.some((s) => s.dispatch === 'model-benchmark'));
  } finally { cleanup(); }
});

test('harness_version_changed also fires the benchmark suggestion', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeBaseline({ version: 'v-definitely-not-the-real-one' });
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const versionSig = res.json.signals.find((s) => s.kind === 'harness_version_changed');
    if (!versionSig) return; // `claude --version` unreadable in this environment: nothing to assert
    const benchSig = res.json.signals.find((s) => s.kind === 'model_benchmark_suggested' && s.detail.includes('version changed'));
    assert.ok(benchSig, `expected a benchmark suggestion alongside harness_version_changed; got: ${JSON.stringify(res.json.signals)}`);
  } finally { cleanup(); }
});
