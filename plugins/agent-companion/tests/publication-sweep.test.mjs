// Publication-leak sweep — the scout's after-the-fact backstop for a leak
// that reached origin despite the local pre-push gate. Covers the library
// directly (sweepRepo/filterNew/fingerprintHit), the detect.mjs signal
// end-to-end (empty option = silent; a real hit fires once, then dedupes
// against the baseline), and the canary script that proves the whole
// pipeline still works.
//
// No network: every "repo" here is a local bare git repo built in a temp
// dir, exactly like leak-sweep-canary.mjs builds its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { sweepRepo, filterNew, fingerprintHit } from '../scripts/lib/publication-sweep.mjs';

const REAL_LEAK_CHECK = join(PLUGIN_ROOT, '..', '..', 'scripts', 'leak-check.mjs');

// Assembled from pieces at runtime — a literal here would trip this repo's
// OWN leak-check (the private-path pattern does not recognise "zzztestuser"
// as a placeholder, same reason leak-sweep-canary.mjs builds its strings
// this way).
const SYNTHETIC_LEAK_LINE = ['private path: C:', '\\Users\\', 'zzz', 'testuser', '\\dev\\thing'].join('');

function git(args, cwd, env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: env || process.env, timeout: 30000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// Build a throwaway bare "origin" whose default branch's NOTES.md carries a
// synthetic (never a real-looking) private-path leak, plus a copy of this
// repo's own leak-check.mjs so the sweep exercises "the target runs its own
// script". Returns { base, bareDir, workDir, cleanup, gitEnv }.
function buildLeakyRepo(leakLine = SYNTHETIC_LEAK_LINE) {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  const bareDir = join(base, 'origin.git');
  const workDir = join(base, 'work');
  git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
  mkdirSync(workDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main', workDir]);
  git(['remote', 'add', 'origin', bareDir], workDir);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  mkdirSync(join(workDir, 'scripts'), { recursive: true });
  copyFileSync(REAL_LEAK_CHECK, join(workDir, 'scripts', 'leak-check.mjs'));
  writeFileSync(join(workDir, 'NOTES.md'), `${leakLine}\n`);
  git(['add', '-A'], workDir, gitEnv);
  git(['commit', '--quiet', '-m', 'leak'], workDir, gitEnv);
  git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
  return {
    base, bareDir, workDir, gitEnv,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } },
  };
}

test('sweepRepo: finds a private-path leak on the published default branch', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepo(repo.bareDir, {});
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'), 'expected a private-path hit');
    for (const h of result.hits) assert.equal(typeof h.fingerprint, 'string');
  } finally { repo.cleanup(); }
});

test('sweepRepo: reduced mode still catches the private-path class', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepo(repo.bareDir, { reduced: true });
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
  } finally { repo.cleanup(); }
});

test('sweepRepo: a clean repo sweeps silent', async () => {
  const repo = buildLeakyRepo('nothing to see here');
  try {
    const result = await sweepRepo(repo.bareDir, {});
    assert.equal(result.error, null);
    assert.deepEqual(result.hits, []);
  } finally { repo.cleanup(); }
});

test('sweepRepo: missing scripts/leak-check.mjs in the published tree is an error, not a crash', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    writeFileSync(join(workDir, 'README.md'), 'no leak-check here\n');
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
    const result = await sweepRepo(bareDir, {});
    assert.equal(result.hits.length, 0);
    assert.match(result.error, /leak-check\.mjs/);
  } finally { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
});

test('sweepRepo: an unreachable repo reports an error and never throws', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const result = await sweepRepo(join(base, 'does-not-exist.git'), { timeout: 5000 });
    assert.equal(result.hits.length, 0);
    assert.ok(result.error);
  } finally { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
});

test('filterNew / fingerprintHit: stable across runs, dedupes a previously-seen hit', () => {
  const hitA = { rel: 'NOTES.md', line: 1, label: 'private-path:windows-profile', token: 'x', text: 'x' };
  const fp1 = fingerprintHit('repo-a', hitA);
  const fp2 = fingerprintHit('repo-a', hitA);
  assert.equal(fp1, fp2, 'fingerprint must be stable for identical repo+rel+line+label');
  const fpOtherRepo = fingerprintHit('repo-b', hitA);
  assert.notEqual(fp1, fpOtherRepo, 'fingerprint must vary by repo');

  const hits = [{ ...hitA, fingerprint: fp1 }];
  assert.deepEqual(filterNew(hits, []), hits, 'empty baseline: everything is new');
  assert.deepEqual(filterNew(hits, [fp1]), [], 'seen fingerprint: nothing new');
  assert.deepEqual(filterNew(hits, new Set([fp1])), [], 'accepts a Set too');
});

test('detect.mjs: publication_leak_repos empty (default) — no signal, no git activity', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], { env: { ...process.env, AGENT_COMPANION_HOME_OVERRIDE: dir } });
    assert.equal(res.status, 0);
    assert.ok(res.json, 'detect.mjs must emit JSON');
    assert.ok(!res.json.signals.some((s) => s.kind.startsWith('publication_leak')));
  } finally { cleanup(); }
});

test('detect.mjs: a configured leaky repo fires publication_leak once, then dedupes on the next run', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: repo.bareDir,
    };
    const runA = runScript('scripts/detect.mjs', [], { env, timeout: 60000 });
    assert.equal(runA.status, 0, runA.stderr);
    const sigA = runA.json.signals.find((s) => s.kind === 'publication_leak');
    assert.ok(sigA, `expected a publication_leak signal, got: ${JSON.stringify(runA.json.signals)}`);

    const runB = runScript('scripts/detect.mjs', [], { env, timeout: 60000 });
    assert.equal(runB.status, 0, runB.stderr);
    assert.ok(
      !runB.json.signals.some((s) => s.kind === 'publication_leak'),
      'the same hit must not re-fire once accepted into the baseline',
    );
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: an unreachable configured repo reports publication_leak_sweep_error, not a crash', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: join(dir, 'nope', 'does-not-exist.git'),
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(res.json.signals.some((s) => s.kind === 'publication_leak_sweep_error'));
  } finally { cleanup(); }
});

test('leak-sweep-canary.mjs: full mode passes', () => {
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'leak-sweep-canary.mjs')], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});

test('leak-sweep-canary.mjs: reduced mode passes', () => {
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'leak-sweep-canary.mjs'), '--reduced'], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});
