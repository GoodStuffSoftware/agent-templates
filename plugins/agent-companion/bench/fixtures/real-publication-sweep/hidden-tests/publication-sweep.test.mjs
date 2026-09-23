// Hidden scoring test for the real-publication-sweep task. No network:
// every "repo" is a local bare git repo built in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  sweepRepo, sweepRepoInPlace, sweepAllCloud, isSessionCheckout, normalizeGitUrl,
} from '../src/publication-sweep.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_LEAK_LINE = ['private path: C:', '\\Users\\', 'zzz', 'testuser', '\\dev\\thing'].join('');
const FAKE_LEAK_CHECK = readFileSync(join(__dirname, '..', 'support', 'fake-leak-check-source.mjs'), 'utf8');

function git(args, cwd, env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: env || process.env, timeout: 30000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// Build a throwaway bare "origin" whose default branch's NOTES.md carries a
// synthetic (never a real-looking) private-path leak, plus a minimal
// stand-in leak-check.mjs so the sweep exercises "the target runs its own
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
  writeFileSync(join(workDir, 'scripts', 'leak-check.mjs'), FAKE_LEAK_CHECK);
  writeFileSync(join(workDir, 'NOTES.md'), `${leakLine}\n`);
  git(['add', '-A'], workDir, gitEnv);
  git(['commit', '--quiet', '-m', 'leak'], workDir, gitEnv);
  git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
  return {
    base, bareDir, workDir, gitEnv,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } },
  };
}

// --- pre-existing suite: sweepRepo (clone-based) must still work ---

test('sweepRepo: finds a private-path leak on the published default branch', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepo(repo.bareDir, {});
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
  } finally { repo.cleanup(); }
});

// --- new tests from the fix: the in-place cloud path ---

test('normalizeGitUrl: ssh, https and scp-style forms of the same repo compare equal', () => {
  const a = normalizeGitUrl('git@github.com:example-org/example-repo.git');
  const b = normalizeGitUrl('https://github.com/example-org/example-repo.git');
  const c = normalizeGitUrl('https://github.com/example-org/example-repo');
  const d = normalizeGitUrl('ssh://git@github.com/example-org/example-repo.git');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, d);
  assert.notEqual(a, normalizeGitUrl('git@github.com:someone-else/other-repo.git'));
});

test("isSessionCheckout: matches a repo entry equal to the checkout's own origin, not an unrelated one", () => {
  const repo = buildLeakyRepo();
  try {
    assert.equal(isSessionCheckout(repo.bareDir, repo.workDir), true);
    assert.equal(isSessionCheckout(join(repo.base, 'not-the-origin.git'), repo.workDir), false);
  } finally { repo.cleanup(); }
});

test('sweepRepoInPlace: scans the checkout directly (no clone), always reduced', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepoInPlace(repo.bareDir, repo.workDir, {});
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
    assert.ok(!result.hits.some((h) => h.label === 'derived-project-name'));
  } finally { repo.cleanup(); }
});

test("sweepRepoInPlace: refuses to scan when HEAD does not match origin's default branch", async () => {
  const repo = buildLeakyRepo();
  try {
    writeFileSync(join(repo.workDir, 'NOTES2.md'), 'unpublished change\n');
    git(['add', '-A'], repo.workDir, repo.gitEnv);
    git(['commit', '--quiet', '-m', 'unpublished'], repo.workDir, repo.gitEnv);
    const result = await sweepRepoInPlace(repo.bareDir, repo.workDir, {});
    assert.equal(result.hits.length, 0);
    assert.match(result.error, /does not match origin/);
  } finally { repo.cleanup(); }
});

test('sweepAllCloud: the entry matching this checkout is scanned in place; a non-matching entry is skipped, never cloned', async () => {
  const repo = buildLeakyRepo();
  try {
    const other = join(repo.base, 'definitely-not-this-checkout.git');
    const { results } = await sweepAllCloud([repo.bareDir, other], { cwd: repo.workDir });
    const matched = results.find((r) => r.repo === repo.bareDir);
    const skipped = results.find((r) => r.repo === other);
    assert.equal(matched.skipped, undefined);
    assert.equal(matched.error, null);
    assert.ok(matched.hits.some((h) => h.label === 'private-path:windows-profile'));
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.hits.length, 0);
    assert.equal(skipped.error, null);
    assert.ok(skipped.note);
  } finally { repo.cleanup(); }
});
