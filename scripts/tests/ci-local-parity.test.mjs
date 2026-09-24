// Regression tests for the --ci-parity ref-safety fix in scripts/ci-local.mjs.
//
// Background: a killed (Ctrl-C, taskkill) --ci-parity run used to leave
// behind a `ci-local-parity-<pid>-<ts>` TAG in the REAL repo's shared refs
// (created in a step that had no matching cleanup on the kill path) plus its
// temp clone dirs. This repo is public and shared by many worktrees and
// sessions, so a ref written into it by a killed background run is a real
// hazard, not just clutter. The fix has two independent parts, tested here:
//
//   1. Parity mode no longer creates any ref in the source repo at all — it
//      fetches the exact commit by SHA (fetchShaIntoTempRepo, using
//      `uploadpack.allowAnySHA1InWant`) instead of tagging it first. Tested
//      below by recording every git invocation via setGitSpawnerForTests()
//      and asserting none of them is `tag` or `update-ref`.
//   2. A startup sweep (sweepStaleTempDirs) removes any leftover temp dirs
//      from a run that never reached its `finally` or its signal handler,
//      identified by an encoded pid that is no longer running and an age
//      past the (overridable, for this test) threshold.
//
// Run from the repo root:  node --test scripts/tests/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fetchShaIntoTempRepo, setGitSpawnerForTests, selectStaleTempDirs,
} from '../ci-local.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ci-local.mjs');

const temps = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function refNames(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname)']).split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

// ---------------------------------------------------------------------------
// 1. fetchShaIntoTempRepo: reaches an arbitrary SHA, creates zero refs in
//    the source repo, and never calls `git tag` or `git update-ref` against
//    it (or anywhere else).
// ---------------------------------------------------------------------------

test('fetchShaIntoTempRepo: fetches an exact SHA that is not any ref tip, without creating a ref in the source repo', () => {
  const src = tmp('ci-local-parity-src-');
  git(src, ['init', '-q']);
  writeFileSync(join(src, 'a.txt'), 'v1\n');
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-q', '-m', 'v1']);
  const targetSha = git(src, ['rev-parse', 'HEAD']).trim();
  // Advance HEAD so targetSha is no longer any ref's tip — this is exactly
  // the situation `uploadpack.allowAnySHA1InWant` exists for.
  writeFileSync(join(src, 'a.txt'), 'v1\nv2\n');
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-q', '-m', 'v2']);

  const refsBefore = refNames(src);
  assert.ok(!refsBefore.some((r) => r.startsWith('refs/tags/')), 'sanity: no tags before the fetch');

  const calls = [];
  setGitSpawnerForTests((args, opts) => {
    calls.push([...args]);
    return spawnSync('git', args, opts);
  });
  let dest;
  try {
    dest = tmp('ci-local-parity-dest-');
    fetchShaIntoTempRepo(dest, src, targetSha, 1);
  } finally {
    setGitSpawnerForTests(null);
  }

  // The checked-out content is v1's, not v2's — proves it fetched the exact
  // historical SHA, not just whatever HEAD happens to be now.
  assert.equal(readFileText(join(dest, 'a.txt')), 'v1\n');

  // No ref was created in the source repo by any of this.
  assert.deepEqual(refNames(src), refsBefore);

  // Every single git invocation this made is accounted for, and none of
  // them is `tag` or `update-ref`.
  assert.ok(calls.length > 0, 'sanity: the spy actually recorded calls');
  for (const args of calls) {
    assert.notEqual(args[0], 'tag', `unexpected git tag call: ${JSON.stringify(args)}`);
    assert.notEqual(args[0], 'update-ref', `unexpected git update-ref call: ${JSON.stringify(args)}`);
    assert.ok(!args.includes('update-ref'), `unexpected update-ref argument: ${JSON.stringify(args)}`);
  }
});

function readFileText(path) {
  return readFileSync(path, 'utf8');
}

test('fetchShaIntoTempRepo: depth 0 omits --depth (full history), same as before', () => {
  const src = tmp('ci-local-parity-src2-');
  git(src, ['init', '-q']);
  writeFileSync(join(src, 'a.txt'), 'only\n');
  git(src, ['add', 'a.txt']);
  git(src, ['commit', '-q', '-m', 'only']);
  const sha = git(src, ['rev-parse', 'HEAD']).trim();

  const calls = [];
  setGitSpawnerForTests((args, opts) => {
    calls.push([...args]);
    return spawnSync('git', args, opts);
  });
  let dest;
  try {
    dest = tmp('ci-local-parity-dest2-');
    fetchShaIntoTempRepo(dest, src, sha, 0);
  } finally {
    setGitSpawnerForTests(null);
  }
  const fetchCall = calls.find((c) => c[0] === 'fetch');
  assert.ok(fetchCall, 'a fetch call happened');
  assert.ok(!fetchCall.includes('--depth'), `depth 0 must omit --depth: ${JSON.stringify(fetchCall)}`);
});

// ---------------------------------------------------------------------------
// 2. selectStaleTempDirs: pure selection logic (name pattern, age, liveness)
// ---------------------------------------------------------------------------

test('selectStaleTempDirs: matches ci-local-peek-<pid>- and ci-local-parity-<pid>- names, ignores unrelated ones', () => {
  const now = 1_000_000_000;
  const names = [
    'ci-local-peek-123-abcdef',
    'ci-local-parity-456-ghijkl',
    'ci-local-peek-notapid-xxxxxx',
    'some-other-tempdir',
    'ci-local-peekish-999-zzzzzz', // must NOT match: not exactly "peek" or "parity"
  ];
  const selected = selectStaleTempDirs(names, {
    now,
    maxAgeMs: 0,
    getMtimeMs: () => now - 1, // always "old enough"
    isPidAlive: () => false, // always "dead"
  });
  assert.deepEqual(selected.sort(), ['ci-local-parity-456-ghijkl', 'ci-local-peek-123-abcdef'].sort());
});

test('selectStaleTempDirs: a dir younger than maxAgeMs is kept even with a dead pid', () => {
  const now = 1_000_000_000;
  const names = ['ci-local-peek-1-aaaaaa'];
  const selected = selectStaleTempDirs(names, {
    now, maxAgeMs: 60_000, getMtimeMs: () => now - 1000, isPidAlive: () => false,
  });
  assert.deepEqual(selected, []);
});

test('selectStaleTempDirs: a dir with a still-alive owning pid is kept even when old', () => {
  const now = 1_000_000_000;
  const names = ['ci-local-parity-1-aaaaaa'];
  const selected = selectStaleTempDirs(names, {
    now, maxAgeMs: 0, getMtimeMs: () => now - 10_000_000, isPidAlive: () => true,
  });
  assert.deepEqual(selected, []);
});

test('selectStaleTempDirs: an unreadable mtime (getMtimeMs returns null) is skipped, not thrown', () => {
  const names = ['ci-local-peek-1-aaaaaa'];
  const selected = selectStaleTempDirs(names, {
    now: 0, maxAgeMs: 0, getMtimeMs: () => null, isPidAlive: () => false,
  });
  assert.deepEqual(selected, []);
});

// ---------------------------------------------------------------------------
// 3. Integration: a real --ci-parity run, killed mid-run via a real child
//    process kill, leaves no ref in the source repo, and its temp dir is
//    gone after the next run's startup sweep.
// ---------------------------------------------------------------------------

// Mirrors the technique in leak-sweep-canary.mjs / leak-check-parity.test.mjs:
// build a throwaway repo containing a COPY of THIS (fixed) ci-local.mjs, so
// the child process being killed is the real production code path, run
// against a disposable repo instead of the real one.
function buildThrowawayRepo() {
  const repo = tmp('ci-local-parity-throwaway-');
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(repo, 'scripts', 'tests'), { recursive: true });
  // No fetch-depth line -> readCheckoutDepth() defaults to 1, so parity mode
  // only ever needs the depth-1 peek clone (simpler to reason about here).
  writeFileSync(join(repo, '.github', 'workflows', 'leak-check.yml'), 'name: leak-check\n');
  // A deliberately slow test so a real child-process kill has a wide window
  // to land while the temp clone's own suite run is in progress.
  writeFileSync(join(repo, 'scripts', 'tests', 'slow.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('slow', async () => {",
    '  await new Promise((r) => { setTimeout(r, 5000); });',
    '  assert.ok(true);',
    '});',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'scripts', 'ci-local.mjs'), readFileText(SCRIPT));

  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

function waitForMatchingTempDir(pid, timeoutMs) {
  const re = new RegExp(`^ci-local-(?:peek|parity)-${pid}-`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      let names;
      try {
        names = readdirSync(tmpdir());
      } catch (err) {
        rejectPromise(err);
        return;
      }
      const found = names.filter((n) => re.test(n));
      if (found.length > 0) {
        resolvePromise(found.map((n) => join(tmpdir(), n)));
        return;
      }
      if (Date.now() > deadline) {
        resolvePromise([]); // let the caller decide how to treat "none found"
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

test('a --ci-parity run killed mid-run leaves no ref in the source repo, and its temp dir is gone after the next run\'s sweep', async () => {
  const repo = buildThrowawayRepo();
  const refsBaseline = refNames(repo);

  const child = spawn(process.execPath, [join(repo, 'scripts', 'ci-local.mjs'), '--ci-parity', '--suite', 'scripts-tests'], {
    cwd: repo,
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });

  const foundDirs = await waitForMatchingTempDir(child.pid, 10_000);
  assert.ok(foundDirs.length > 0, 'the parity run must have created its temp dir before we kill it (test setup problem otherwise, not a product bug)');

  child.kill(); // a real process kill, mid-run — never reaches ci-local.mjs's `finally`.
  const { code, signal } = await waitForExit(child);
  void code; void signal; // informational only; behavior is platform-dependent (see file header).

  // The core safety property: no ref was ever created in the source repo,
  // regardless of when or how the process died.
  assert.deepEqual(refNames(repo), refsBaseline);
  assert.ok(!refNames(repo).some((r) => r.startsWith('refs/tags/')), 'no tag exists in the source repo after the kill');

  // The "next run": a fast, no-op-suite invocation (--pre-push-hook with
  // empty stdin returns immediately after "no refs to check") that still
  // runs the startup sweep. CI_LOCAL_STALE_SWEEP_MAX_AGE_MS=0 is a
  // test-only override (see ci-local.mjs) so the sweep does not need to
  // wait out the real 1-hour default; the killed child's pid is already
  // dead by now, so the age is the only gate left to defeat.
  const nextRun = spawn(process.execPath, [join(repo, 'scripts', 'ci-local.mjs'), '--pre-push-hook'], {
    cwd: repo,
    env: { ...process.env, CI_LOCAL_STALE_SWEEP_MAX_AGE_MS: '0' },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  nextRun.stdin.end();
  await waitForExit(nextRun);

  for (const dir of foundDirs) {
    assert.ok(!existsSync(dir), `expected ${dir} to be removed by the startup sweep, but it still exists`);
  }

  // And still no ref, after the sweep ran too.
  assert.deepEqual(refNames(repo), refsBaseline);
});
