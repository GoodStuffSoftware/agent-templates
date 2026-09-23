import test from 'node:test';
import assert from 'node:assert/strict';
import { runDetection } from '../src/detect.mjs';

// --- pre-existing suite: unreadable harness must still short-circuit ---

test('runDetection: harness_version_unreadable when the version cannot be read', () => {
  const signals = runDetection({ runningVersion: null, harnessReadable: false });
  assert.ok(signals.some((s) => s.kind === 'harness_version_unreadable'));
});

// --- new: the alias-resolution version-floor check ---

test('runDetection: fires alias_resolution_below_version_floor when running version is below the configured floor', () => {
  const signals = runDetection({ runningVersion: '2.1.278', harnessReadable: true });
  const hit = signals.find((s) => s.kind === 'alias_resolution_below_version_floor');
  assert.ok(hit, 'expected alias_resolution_below_version_floor to fire');
  assert.match(hit.detail, /2\.1\.278/);
  assert.match(hit.detail, /2\.1\.280/);
});

test('runDetection: silent at exactly the floor version', () => {
  const signals = runDetection({ runningVersion: '2.1.280', harnessReadable: true });
  assert.ok(!signals.some((s) => s.kind === 'alias_resolution_below_version_floor'));
});

test('runDetection: silent above the floor version', () => {
  const signals = runDetection({ runningVersion: '2.1.281', harnessReadable: true });
  assert.ok(!signals.some((s) => s.kind === 'alias_resolution_below_version_floor'));
});

test('runDetection: silent and does not throw two major versions below the floor', () => {
  const signals = runDetection({ runningVersion: '1.9.0', harnessReadable: true });
  assert.ok(signals.some((s) => s.kind === 'alias_resolution_below_version_floor'));
});
