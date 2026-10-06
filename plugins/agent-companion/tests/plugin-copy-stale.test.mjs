// detect.mjs's `plugin_copy_stale` scout signal: an installed copy of the plugin
// (the CLI cache entry, or the desktop app's own rpm copy) that has lagged the
// marketplace version for more than 6 hours. It reuses scripts/version.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runScript } from './helpers.mjs';
import { detectEnv } from './detect-env.mjs';
import { HOUR, machine } from './version-fixture.mjs';

const NOW = Date.parse('2026-10-02T20:00:00.000Z');

function detect(fx, env = {}) {
  const res = runScript('scripts/detect.mjs', [], {
    cwd: fx.dir,
    env: detectEnv({ env: { AGENT_COMPANION_FAKE_NOW: new Date(NOW).toISOString(), ...env } }),
    timeout: 90000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, `detect.mjs printed no JSON: ${res.stdout}`);
  return res.json.signals.filter((s) => s.kind === 'plugin_copy_stale');
}

test('a desktop copy two releases behind for more than 6 hours fires, names the copy, the sessions and the fix', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.24', desktop: '0.29.22', marketplace: '0.29.24', publishedMsAgo: 10 * HOUR });
    const sigs = detect(fx);
    assert.equal(sigs.length, 1, JSON.stringify(sigs));
    const s = sigs[0];
    assert.equal(s.dispatch, 'desktop-plugin-refresh');
    assert.match(s.detail, /desktop copy \(plugin_FIX0\) is 0\.29\.22/);
    assert.match(s.detail, /marketplace has had 0\.29\.24 for 10 h/);
    assert.match(s.detail, /Desktop Code-tab sessions/);
    assert.match(s.detail, /disable, then re-enable, agent-companion in the DESKTOP plugin manager/);
    assert.match(s.detail, /confirm with \/ac version/);
    assert.doesNotMatch(s.detail, /Untested|not verified/);
  } finally { fx.cleanup(); }
});

test('a CLI copy behind for more than 6 hours fires with the plugin-update dispatch', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.23', desktop: '0.29.24', marketplace: '0.29.24', publishedMsAgo: 8 * HOUR });
    const sigs = detect(fx);
    assert.equal(sigs.length, 1, JSON.stringify(sigs));
    assert.equal(sigs[0].dispatch, 'plugin-update');
    assert.match(sigs[0].detail, /CLI cache copy \(user scope\) is 0\.29\.23/);
    assert.match(sigs[0].detail, /CLI sessions/);
    assert.match(sigs[0].detail, /claude plugin marketplace update agent-templates/);
  } finally { fx.cleanup(); }
});

test('both a CLI and a desktop copy behind: one signal each', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.23', desktop: '0.29.22', marketplace: '0.29.24', publishedMsAgo: 12 * HOUR });
    const sigs = detect(fx);
    assert.deepEqual(sigs.map((s) => s.dispatch).sort(), ['desktop-plugin-refresh', 'plugin-update']);
  } finally { fx.cleanup(); }
});

test('within the 6 hour grace after a release, nothing fires', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.23', desktop: '0.29.22', marketplace: '0.29.24', publishedMsAgo: 5 * HOUR });
    assert.deepEqual(detect(fx), []);
  } finally { fx.cleanup(); }
});

test('every copy current: nothing fires', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { publishedMsAgo: 30 * HOUR });
    assert.deepEqual(detect(fx), []);
  } finally { fx.cleanup(); }
});

test('a copy AHEAD of the marketplace is not stale', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.25', desktop: '0.29.25', marketplace: '0.29.24', publishedMsAgo: 30 * HOUR });
    assert.deepEqual(detect(fx), []);
  } finally { fx.cleanup(); }
});

test('no desktop app data and no install record: no signal and no crash', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(detect(fx), []);
    machine(fx.dir, NOW, { desktop: null, publishedMsAgo: 30 * HOUR });
    assert.deepEqual(detect(fx), []);
  } finally { fx.cleanup(); }
});

test('in a cloud session the machine\'s copies are not judged', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.23', desktop: '0.29.22', marketplace: '0.29.24', publishedMsAgo: 12 * HOUR });
    assert.deepEqual(detect(fx, { CLAUDE_CODE_REMOTE_SESSION_ID: 'cloud-session-1' }), []);
  } finally { fx.cleanup(); }
});

test('the signal text names no path (the scout scrubs, but the signal should not need it)', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, NOW, { cli: '0.29.23', desktop: '0.29.22', marketplace: '0.29.24', publishedMsAgo: 12 * HOUR });
    for (const s of detect(fx)) assert.doesNotMatch(s.detail, /[\/](Users|home|AppData|\.claude)[\/]/i);
  } finally { fx.cleanup(); }
});
