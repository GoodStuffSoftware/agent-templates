// config/model-tiers.json's aliasResolution.minClaudeCodeVersion is recorded
// as data but was never checked against the running harness anywhere
// (review finding H3) — an operator on an old Claude Code build got routing
// advice for a model their `opus` alias might not actually resolve to, with
// nothing surfacing the gap. detect.mjs now raises
// alias_resolution_below_version_floor when the installed version is below
// the floor, reusing the `claude --version` call section 1 already makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { makeFixture, runScript } from './helpers.mjs';

// Derive floors relative to the REAL installed `claude --version` on this
// machine, rather than hardcoding a version, so the test is correct whether
// this machine is ahead of or behind any particular Claude Code release.
function runningVersion() {
  const out = execSync('claude --version', { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`could not parse \`claude --version\` output: ${out}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function writeOverride(stateDir, minClaudeCodeVersion) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({
    aliasResolution: { minClaudeCodeVersion, note: 'test override: aliases may resolve to an older model below this floor' },
    tiers: {},
  }));
}

// Computed once, up front, at module load — never inside the test body — so
// the skip decision is made the same way `{ skip }` is documented to work:
// a CI runner with no `claude` CLI on PATH (exit 127) must SKIP this test
// with a clear reason, never silently pass it (a skip and a pass read very
// differently in a report). Only this first test depends on the real
// installed version; the other two in this file don't call runningVersion()
// and stay fully active either way.
let cachedRunningVersion;
let runningVersionError;
try {
  cachedRunningVersion = runningVersion();
} catch (err) {
  runningVersionError = err;
}

test('installed Claude Code below the alias-resolution floor: signal fires, names the floor and the running version', {
  skip: runningVersionError ? `claude CLI not available to derive a real running version: ${runningVersionError.message}` : false,
}, () => {
  const [maj, min, pat] = cachedRunningVersion;
  const floorAbove = `${maj}.${min}.${pat + 1}`; // guaranteed strictly above the running version
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeOverride(stateDir, floorAbove);
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'alias_resolution_below_version_floor');
    assert.ok(sig, `expected alias_resolution_below_version_floor; got: ${JSON.stringify(res.json.signals)}`);
    assert.match(sig.detail, new RegExp(floorAbove.replace(/\./g, '\\.')));
    assert.equal(sig.dispatch, 'routing-review');
  } finally { cleanup(); }
});

test('installed Claude Code at or above the alias-resolution floor: no signal', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeOverride(stateDir, '0.0.0'); // guaranteed at-or-below any real installed version
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'alias_resolution_below_version_floor');
    assert.equal(sig, undefined, `expected no signal; got: ${JSON.stringify(res.json.signals)}`);
  } finally { cleanup(); }
});

test('no aliasResolution.minClaudeCodeVersion in config: no signal, no throw', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    mkdirSync(stateDir, { recursive: true });
    // The override merges by TOP-LEVEL KEY (see context.mjs's modelTiers()),
    // so `aliasResolution: {}` here fully replaces the shipped config's
    // aliasResolution object (shallow spread), rather than merging into it —
    // the only way to simulate "no floor recorded" through the real
    // override mechanism this plugin ships.
    writeFileSync(join(stateDir, 'model-tiers.json'), JSON.stringify({ aliasResolution: {}, tiers: {} }));
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sig = res.json.signals.find((s) => s.kind === 'alias_resolution_below_version_floor');
    assert.equal(sig, undefined);
  } finally { cleanup(); }
});
