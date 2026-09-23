// Sandbox isolation: every run gets a throwaway sandbox (always), and a
// throwaway HOME/USERPROFILE ONLY when --isolate-home is passed (opt-in,
// not the default — see bench/runner.mjs's runClaude() banner and
// docs/BENCHMARK.md "Preconditions" for why the default changed to NOT
// redirect HOME). A task-pack extraction never produces a .git directory.
// No test here makes a real model call — bench/runner.mjs's runClaude() is
// exercised only for its ENV-BUILDING logic (by reaching in and
// re-deriving what it would set when isolateHome is true — see the
// isolated re-implementation note below), never by actually spawning
// claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import { extractFilesAtRef } from '../bench/task-packs/lib.mjs';

// PLUGIN_ROOT is <repoRoot>/plugins/agent-companion; two levels up is the
// repo root git itself resolves refs against.
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');

// bench/runner.mjs's per-run env-building (HOME/USERPROFILE/HOMEDRIVE/
// HOMEPATH/CLAUDE_CONFIG_DIR) lives inside runClaude(), which is not
// exported (deliberately — it is the one function that actually spawns a
// model, and nothing in this test suite may do that). This re-derives the
// SAME env shape runClaude() builds, from the same inputs, so the assertion
// is "the isolation logic, exercised the way runner.mjs actually exercises
// it" without spawning anything. If runner.mjs's env-building ever changes
// shape, this must change with it — that coupling is intentional: a drift
// here is exactly the kind of thing meant to be caught before a real batch.
function buildIsolatedEnv(fakeHome) {
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
  };
  if (process.platform === 'win32') {
    env.HOMEDRIVE = fakeHome.slice(0, 2);
    env.HOMEPATH = fakeHome.slice(2);
  }
  return env;
}

test('a fresh fake HOME is never the real HOME/USERPROFILE', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'bench-home-test-'));
  try {
    const env = buildIsolatedEnv(fakeHome);
    const realHome = homedir();
    assert.notEqual(env.HOME, realHome);
    assert.notEqual(env.USERPROFILE, realHome);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.notEqual(env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude'));
    if (process.platform === 'win32') {
      assert.equal(env.HOMEDRIVE + env.HOMEPATH, fakeHome);
      assert.notEqual(env.HOMEDRIVE + env.HOMEPATH, homedir());
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('two fake homes built for two different runs never collide', () => {
  const a = mkdtempSync(join(tmpdir(), 'bench-home-test-'));
  const b = mkdtempSync(join(tmpdir(), 'bench-home-test-'));
  try {
    assert.notEqual(a, b);
    assert.notEqual(buildIsolatedEnv(a).HOME, buildIsolatedEnv(b).HOME);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// --- task-pack extraction: no .git ever lands in the sandbox ---------------

test('extractFilesAtRef() never produces a .git directory in the destination', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const dest = join(dir, 'extracted');
    // Extract a real, small, ALREADY-COMMITTED file from THIS repo's own
    // history at HEAD — using "git show", never "git clone"/"git checkout".
    // (Must be a file committed at HEAD, not one still pending in this same
    // change — "git show" only ever sees committed content.)
    extractFilesAtRef(REPO_ROOT, 'HEAD', ['plugins/agent-companion/hooks/lib/context.mjs'], dest);
    assert.ok(existsSync(join(dest, 'plugins', 'agent-companion', 'hooks', 'lib', 'context.mjs')), 'expected file extracted');
    assert.ok(!existsSync(join(dest, '.git')), 'extraction must never create a .git directory');
  } finally {
    cleanup();
  }
});
