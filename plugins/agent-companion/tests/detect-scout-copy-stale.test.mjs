// scout_copy_stale (detect.mjs): the scout copy that is RUNNING is older than
// the marketplace's. Also the routine's STEP 0 order (marketplace first) and
// that every signal kind detect.mjs can emit is named in the routine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { machine } from './version-fixture.mjs';

const OWN = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const stale = (res) => (res.json?.signals || []).filter((s) => s.kind === 'scout_copy_stale');

function run(dir, env = {}) {
  const res = runScript('scripts/detect.mjs', [], { cwd: dir, env, timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, 'detect prints JSON');
  return res;
}

test('marketplace ahead of the running scout: one signal naming both versions', () => {
  const { dir, cleanup } = makeFixture();
  try {
    machine(dir, Date.now(), { cli: OWN, desktop: null, marketplace: '99.0.0' });
    const hits = stale(run(dir));
    assert.equal(hits.length, 1);
    assert.ok(hits[0].detail.includes(OWN), hits[0].detail);
    assert.ok(hits[0].detail.includes('99.0.0'), hits[0].detail);
    assert.equal(hits[0].dispatch, 'plugin-update');
  } finally { cleanup(); }
});

test('equal version, or a scout newer than the marketplace: no signal', () => {
  for (const marketplace of [OWN, '0.0.1']) {
    const { dir, cleanup } = makeFixture();
    try {
      machine(dir, Date.now(), { cli: OWN, desktop: null, marketplace });
      assert.deepEqual(stale(run(dir)), [], `marketplace ${marketplace}`);
    } finally { cleanup(); }
  }
});

test('in the cloud (CLAUDE_CODE_REMOTE_SESSION_ID set): no signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    machine(dir, Date.now(), { cli: OWN, desktop: null, marketplace: '99.0.0' });
    assert.deepEqual(stale(run(dir, { CLAUDE_CODE_REMOTE_SESSION_ID: 'test-session' })), []);
  } finally { cleanup(); }
});

test('an unreadable marketplace: no signal and no throw', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const m = machine(dir, Date.now(), { cli: OWN, desktop: null, marketplace: '99.0.0' });
    writeFileSync(join(m.claude, 'plugins', 'known_marketplaces.json'), '{ not json');
    writeFileSync(join(m.marketplacePath, '.claude-plugin', 'marketplace.json'), '{ not json');
    mkdirSync(join(m.marketplacePath, 'plugins', 'agent-companion', '.claude-plugin'), { recursive: true });
    writeFileSync(join(m.marketplacePath, 'plugins', 'agent-companion', '.claude-plugin', 'plugin.json'), '{ not json');
    assert.deepEqual(stale(run(dir)), []);
  } finally { cleanup(); }
});

const routine = readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8');

test('routine STEP 0 lists the marketplace line before the checkout line (header comment too)', () => {
  const step0 = routine.slice(routine.indexOf('## STEP 0'), routine.indexOf('## Where you are running'));
  const mk = step0.indexOf('marketplaces/*/plugins/agent-companion');
  const co = step0.indexOf('$(pwd)/plugins/agent-companion');
  assert.ok(mk >= 0 && co >= 0, 'both locators present');
  assert.ok(mk < co, 'marketplace first, checkout as the fallback');
  const head = routine.slice(0, routine.indexOf('You are the **agent-companion calibration scout**'));
  assert.ok(head.indexOf('marketplaces/*/plugins/agent-companion') < head.indexOf('$(pwd)/plugins/agent-companion'));
});

test('every signal kind detect.mjs can emit is named in the routine', () => {
  const src = readFileSync(join(PLUGIN_ROOT, 'scripts', 'detect.mjs'), 'utf8');
  const kinds = [...new Set([...src.matchAll(/sig\('([a-z_0-9]+)'/g)].map((m) => m[1]))];
  assert.ok(kinds.length >= 20, `found ${kinds.length} kinds`);
  assert.ok(kinds.includes('scout_copy_stale'));
  const missing = kinds.filter((k) => !routine.includes(`\`${k}\``));
  assert.deepEqual(missing, []);
});
