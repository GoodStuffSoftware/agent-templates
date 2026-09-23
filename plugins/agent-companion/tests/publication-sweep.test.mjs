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
import {
  sweepRepo, sweepRepoInPlace, sweepAllCloud, isSessionCheckout, normalizeGitUrl,
  filterNew, fingerprintHit,
} from '../scripts/lib/publication-sweep.mjs';

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

test('sweepRepo: a repo with NO leak-check of its own is still scanned, by the plugin\'s own generic checker', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    // No scripts/ directory at all — this repo ships no leak-check.mjs.
    writeFileSync(join(workDir, 'README.md'), `no leak-check here, but here's a path: ${SYNTHETIC_LEAK_LINE}\n`);
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
    const result = await sweepRepo(bareDir, {});
    assert.equal(result.error, null, 'no own checker is normal, not an error');
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'), 'the plugin\'s own generic checker must still catch it');
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
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
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
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: join(dir, 'nope', 'does-not-exist.git'),
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(res.json.signals.some((s) => s.kind === 'publication_leak_sweep_error'));
  } finally { cleanup(); }
});

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

test('isSessionCheckout: matches a repo entry equal to the checkout\'s own origin, not an unrelated one', () => {
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
    // never a derived-project-name hit: sweepRepoInPlace always passes --no-derived
    assert.ok(!result.hits.some((h) => h.label === 'derived-project-name'));
  } finally { repo.cleanup(); }
});

test('sweepRepoInPlace: refuses to scan when HEAD does not match origin\'s default branch', async () => {
  const repo = buildLeakyRepo();
  try {
    // Make an unpushed local commit so workDir's HEAD diverges from origin.
    writeFileSync(join(repo.workDir, 'NOTES.md'), 'unpublished change\n');
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

test('detect.mjs (cloud): scans the checkout in place, skips a non-matching configured repo, never clones', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const otherRepo = join(repo.base, 'not-this-checkout.git');
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_CODE_REMOTE_SESSION_ID: 'test-cloud-session',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: `${repo.bareDir},${otherRepo}`,
    };
    // cwd is the "session checkout" — detect.mjs must scan THIS in place and
    // must not attempt to clone otherRepo (which does not even exist).
    const res = runScript('scripts/detect.mjs', [], { env, cwd: repo.workDir, timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    const leakSig = res.json.signals.find((s) => s.kind === 'publication_leak');
    assert.ok(leakSig, `expected publication_leak, got: ${JSON.stringify(res.json.signals)}`);
    assert.match(leakSig.detail, /cloud, in-place/);
    const noteSig = res.json.signals.find((s) => s.kind === 'publication_leak_sweep_note');
    assert.ok(noteSig, 'expected a note about the skipped (non-checkout) repo');
    assert.match(noteSig.detail, new RegExp(otherRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!res.json.signals.some((s) => s.kind === 'publication_leak_sweep_error'), 'the skipped repo must not be reported as an error — it was never attempted');
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: publication_leak_sweep off (default) — the master switch, not just an empty repo list', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      // publication_leak_sweep left OFF on purpose, even though a repo IS configured.
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: repo.bareDir,
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(!res.json.signals.some((s) => s.kind.startsWith('publication_leak')), 'off is off, regardless of publication_leak_repos');
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: auto-discovery via the dev-root fallback fires publication_repo_newly_public once, then dedupes', async () => {
  const { dir, cleanup } = makeFixture();
  const devRoot = join(dir, 'discover-dev-root');
  mkdirSync(devRoot, { recursive: true });
  const projDir = join(devRoot, 'auto-discovered-proj');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'README.md'), 'clean\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  git(['add', '-A'], projDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, gitEnv);
  git(['remote', 'add', 'origin', 'git@github.com:example-org/auto-discovered-proj.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: '1', // every candidate treated as public, no network
    };
    const runA = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(runA.status, 0, runA.stderr);
    const newPub = runA.json.signals.find((s) => s.kind === 'publication_repo_newly_public');
    assert.ok(newPub, `expected publication_repo_newly_public, got: ${JSON.stringify(runA.json.signals)}`);
    assert.match(newPub.detail, /example-org\/auto-discovered-proj/);

    const runB = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(runB.status, 0, runB.stderr);
    assert.ok(
      !runB.json.signals.some((s) => s.kind === 'publication_repo_newly_public'),
      'the same repo must not re-fire as "newly public" once acknowledged',
    );
  } finally { cleanup(); }
});

test('detect.mjs: publication_leak_repos excludes (!entry) remove a discovered repo from the sweep', async () => {
  const { dir, cleanup } = makeFixture();
  const devRoot = join(dir, 'discover-dev-root');
  mkdirSync(devRoot, { recursive: true });
  const projDir = join(devRoot, 'excluded-proj');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'README.md'), 'clean\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  git(['add', '-A'], projDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, gitEnv);
  git(['remote', 'add', 'origin', 'git@github.com:example-org/excluded-proj.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: '1',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: '!example-org/excluded-proj',
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      !res.json.signals.some((s) => s.kind === 'publication_repo_newly_public'),
      'an excluded repo must never be discovered/covered at all',
    );
  } finally { cleanup(); }
});

test('sweepRepo: publicNames exempts a PUBLIC sibling name from BOTH checkers, but a private-looking derived name still fires', async () => {
  // Both names must be DERIVABLE in the first place (real child dirs of a
  // dev root) for this to test the exemption rather than trivially passing
  // because neither was ever a candidate.
  const devRootDir = mkdtempSync(join(tmpdir(), 'ac-pubsweep-devroot-'));
  const PUBLIC_NAME = 'zzzpublicsiblingproj';
  const PRIVATE_NAME = 'zzzprivateonlyproj';
  mkdirSync(join(devRootDir, PUBLIC_NAME), { recursive: true });
  mkdirSync(join(devRootDir, PRIVATE_NAME), { recursive: true });
  const repo = buildLeakyRepo(`mentions our sibling ${PUBLIC_NAME} here\nand also a private name: ${PRIVATE_NAME}\n`);
  try {
    const result = await sweepRepo(repo.bareDir, {
      devRoots: [devRootDir],
      publicNames: [PUBLIC_NAME, `example-org/${PUBLIC_NAME}`],
    });
    assert.equal(result.error, null);
    assert.ok(
      !result.hits.some((h) => h.label === 'derived-project-name' && h.token.toLowerCase() === PUBLIC_NAME),
      'a discovered-public sibling name must never fire as a leak',
    );
    assert.ok(
      result.hits.some((h) => h.label === 'derived-project-name' && h.token.toLowerCase() === PRIVATE_NAME),
      'a derived name NOT in publicNames must still fire — proves the fixture actually exercises the derived-name class',
    );
  } finally { repo.cleanup(); rmSync(devRootDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('leak-scan-core scanRepo: vendor/minified/lockfile paths are skipped for every class', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-corevendor-'));
  try {
    // Assembled from 2-char pieces — no contiguous 7+ char hex run appears
    // literally in this file's own source (it is itself leak-checked).
    const leakyHex = ['01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67'].join('');
    mkdirSync(join(base, 'vendor'), { recursive: true });
    mkdirSync(join(base, 'dist'), { recursive: true });
    writeFileSync(join(base, 'vendor', 'lib.js'), `const h = "${leakyHex}";\n`);
    writeFileSync(join(base, 'dist', 'bundle.min.js'), `const h = "${leakyHex}";\n`);
    writeFileSync(join(base, 'package-lock.json'), `{"h":"${leakyHex}"}\n`);
    writeFileSync(join(base, 'real.js'), `const h = "${leakyHex}";\n`);
    git(['init', '--quiet', '-b', 'main'], base);
    git(['add', '-A'], base, { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' });
    git(['commit', '--quiet', '-m', 'init'], base, { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' });
    const { scanRepo } = await import('../scripts/lib/leak-scan-core.mjs');
    const { hits } = scanRepo({ root: base, devRoots: [], noDerived: true });
    const rels = hits.map((h) => h.rel);
    assert.ok(rels.includes('real.js'));
    assert.ok(!rels.includes('vendor/lib.js'));
    assert.ok(!rels.includes('dist/bundle.min.js'));
    assert.ok(!rels.includes('package-lock.json'));
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
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
