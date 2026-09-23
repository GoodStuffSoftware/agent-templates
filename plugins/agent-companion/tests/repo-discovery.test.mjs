// repo-discovery.mjs — auto-discovery for the publication-leak sweep.
//
// Everything here is injected: exec, checkVisibility, and the ~/.claude.json
// path are all fake. No test touches the network, `gh`, or the real
// machine's dev root / home.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  discoverViaGh, discoverFromClaudeProjects, discoverLocalCheckouts,
  readClaudeJsonProjectPaths, parseExtraSpec, defaultDevRoots,
} from '../scripts/lib/repo-discovery.mjs';
import { normalizeGitUrl } from '../scripts/lib/publication-sweep.mjs';

function git(args, cwd, env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: env || process.env, timeout: 30000 });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };

function makeRepo(base, name, originUrl) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(['init', '--quiet', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(['add', '-A'], dir, GIT_ENV);
  git(['commit', '--quiet', '-m', 'init'], dir, GIT_ENV);
  if (originUrl) git(['remote', 'add', 'origin', originUrl], dir);
  return dir;
}

test('parseExtraSpec: plain entries include, !-prefixed entries exclude', () => {
  const { include, exclude } = parseExtraSpec('owner/a, !owner/b ,  https://github.com/owner/c.git,!owner/d');
  assert.deepEqual(include, ['owner/a', 'https://github.com/owner/c.git']);
  assert.deepEqual(exclude, ['owner/b', 'owner/d']);
});

test('discoverViaGh: parses NDJSON, drops archived and forks', () => {
  const ndjson = [
    JSON.stringify({ full_name: 'me/keep-1', archived: false, fork: false, html_url: 'https://github.com/me/keep-1' }),
    JSON.stringify({ full_name: 'me/archived', archived: true, fork: false }),
    JSON.stringify({ full_name: 'me/a-fork', archived: false, fork: true }),
    JSON.stringify({ full_name: 'me/keep-2', archived: false, fork: false }),
  ].join('\n');
  const exec = () => ndjson;
  const { ok, repos } = discoverViaGh({ exec });
  assert.equal(ok, true);
  assert.deepEqual(repos.map((r) => r.fullName).sort(), ['me/keep-1', 'me/keep-2']);
});

test('discoverViaGh: gh missing degrades with ok:false and a reason, never throws', () => {
  const exec = () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; };
  const { ok, repos, reason } = discoverViaGh({ exec });
  assert.equal(ok, false);
  assert.deepEqual(repos, []);
  assert.match(reason, /not installed/);
});

test('discoverViaGh: gh present but unauthenticated/erroring also degrades, not throws', () => {
  const exec = () => { const e = new Error('command failed'); e.stderr = 'gh: To use GitHub CLI, please authenticate'; throw e; };
  const { ok, reason } = discoverViaGh({ exec });
  assert.equal(ok, false);
  assert.match(reason, /gh api failed/);
});

test('readClaudeJsonProjectPaths: returns null when missing (caller falls back)', () => {
  assert.equal(readClaudeJsonProjectPaths({ claudeJsonPath: undefined }), null);
  assert.equal(readClaudeJsonProjectPaths({ claudeJsonPath: '/definitely/not/here/.claude.json', existsFn: () => false }), null);
});

test('readClaudeJsonProjectPaths: returns null on unparseable JSON (caller falls back)', () => {
  const paths = readClaudeJsonProjectPaths({
    claudeJsonPath: '/fake/.claude.json', existsFn: () => true, readFn: () => 'not json{{{',
  });
  assert.equal(paths, null);
});

test('readClaudeJsonProjectPaths: returns the projects map keys', () => {
  const fixture = JSON.stringify({ projects: { '/a/b': {}, '/c/d': {} }, otherStuff: 1 });
  const paths = readClaudeJsonProjectPaths({
    claudeJsonPath: '/fake/.claude.json', existsFn: () => true, readFn: () => fixture,
  });
  assert.deepEqual(paths.sort(), ['/a/b', '/c/d']);
});

test('discoverFromClaudeProjects: filters non-repo/nonexistent paths, dedupes worktrees to the main checkout, keeps only public github origins', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-discover-test-'));
  try {
    const pub = makeRepo(base, 'pub-repo', 'git@github.com:me/pub-repo.git');
    const priv = makeRepo(base, 'priv-repo', 'git@github.com:me/priv-repo.git');
    const nonGithub = makeRepo(base, 'gitlab-repo', 'git@gitlab.com:me/gitlab-repo.git');
    const notARepo = join(base, 'not-a-repo'); mkdirSync(notARepo);
    const claudeJsonPath = join(base, '.claude.json');
    writeFileSync(claudeJsonPath, JSON.stringify({
      projects: {
        [pub]: {}, [priv]: {}, [nonGithub]: {}, [notARepo]: {},
        [join(base, 'does-not-exist-at-all')]: {},
      },
    }));
    const visibility = new Map([['me/pub-repo', true], ['me/priv-repo', false]]);
    const checkVisibility = async (owner, repo) => visibility.get(`${owner}/${repo}`) ?? null;

    const { ok, repos } = await discoverFromClaudeProjects({ claudeJsonPath, checkVisibility });
    assert.equal(ok, true);
    assert.deepEqual(repos.map((r) => r.fullName), ['me/pub-repo']);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test('discoverFromClaudeProjects: missing/unparseable ~/.claude.json reports ok:false so the caller falls back', async () => {
  const r1 = await discoverFromClaudeProjects({ claudeJsonPath: undefined });
  assert.equal(r1.ok, false);
  const r2 = await discoverFromClaudeProjects({ claudeJsonPath: '/fake/.claude.json', existsFn: () => true, readFn: () => '{{{not json' });
  assert.equal(r2.ok, false);
});

test('discoverLocalCheckouts (fallback): walks a dev root, keeps only public github origins', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-discover-test-'));
  try {
    const devRoot = join(base, 'dev'); mkdirSync(devRoot, { recursive: true });
    makeRepo(devRoot, 'proj-a', 'git@github.com:me/proj-a.git');
    makeRepo(devRoot, 'proj-b', 'git@github.com:me/proj-b.git');
    const checkVisibility = async (owner, repo) => (repo === 'proj-a');
    const repos = await discoverLocalCheckouts({ devRoots: [devRoot], checkVisibility });
    assert.deepEqual(repos.map((r) => r.fullName), ['me/proj-a']);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test('normalizeGitUrl-based dedupe: the same repo from two sources (gh + claude.json) counts once', () => {
  // Exercised at the detect.mjs union level; here we just confirm the
  // building block both call sites rely on.
  assert.equal(
    normalizeGitUrl('https://github.com/me/keep-1.git'),
    normalizeGitUrl('git@github.com:me/keep-1.git'),
  );
});

test('defaultDevRoots: never returns the home dir itself', () => {
  const roots = defaultDevRoots({ cwd: '/somewhere/else', home: '/home/example' });
  assert.ok(!roots.includes('/home/example'));
});

// --- second adversarial review: M5 (visibility unknown), L3 (dev root) ----

test('M5/N3: cachedVisibility caches only PUBLIC answers for the TTL, never not-public or unknown ones, and counts unknowns', async () => {
  const { cachedVisibility } = await import('../scripts/lib/repo-discovery.mjs');
  let calls = 0;
  const answers = { 'zb/pub': true, 'zb/priv': false, 'zb/offline': null };
  const fn = async (o, r) => { calls++; return answers[`${o}/${r}`]; };
  const cache = {};
  let t = Date.parse('2026-01-01T00:00:00Z');
  const v = cachedVisibility(fn, cache, { now: () => t });
  assert.equal(await v.check('zb', 'pub'), true);
  assert.equal(await v.check('zb', 'priv'), false);
  assert.equal(await v.check('zb', 'offline'), null);
  assert.equal(calls, 3);
  assert.equal(v.stats.unknown, 1);
  assert.deepEqual(Object.keys(cache).sort(), ['zb/pub'], 'N3: only a public answer is cached — not-public and unknown never are');

  // Second run within the TTL: the public answer comes from the cache; the
  // not-public (N3) and unknown ones are both rechecked.
  const v2 = cachedVisibility(fn, cache, { now: () => t + 60 * 60 * 1000 });
  await v2.check('zb', 'pub'); await v2.check('zb', 'priv'); await v2.check('zb', 'offline');
  assert.equal(calls, 5, 'the not-public and the unknown repo were re-fetched; the public one was not');
  assert.equal(v2.stats.cached, 1);
  assert.equal(v2.stats.unknown, 1);

  // After the TTL a known answer is re-fetched; if that fetch fails, the
  // stale known answer is used but the lookup still counts as unknown.
  answers['zb/pub'] = null;
  t += 25 * 60 * 60 * 1000;
  const v3 = cachedVisibility(fn, cache, { now: () => t });
  assert.equal(await v3.check('zb', 'pub'), true, 'stale-but-known public keeps being swept through an outage');
  assert.equal(v3.stats.unknown, 1);
});

test('N3: a repo that turns public is seen as public on the NEXT run — a not-public answer is never cached', async () => {
  const { cachedVisibility } = await import('../scripts/lib/repo-discovery.mjs');
  let isPublic = false;
  let calls = 0;
  const fn = async () => { calls++; return isPublic; };
  const cache = {};
  const t = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(await cachedVisibility(fn, cache, { now: () => t }).check('myorg', 'zbnewpub'), false);
  assert.deepEqual(cache, {}, 'false is never cached');
  isPublic = true; // operator flips it public one minute later
  assert.equal(await cachedVisibility(fn, cache, { now: () => t + 60 * 1000 }).check('myorg', 'zbnewpub'), true);
  assert.equal(calls, 2, 'the second run rechecked instead of reusing a cached false');
  assert.equal(cache['myorg/zbnewpub'].public, true);
});

test('N3: a pre-existing cached false (old baseline) is ignored and a public answer replaces it; a false answer drops a stale true', async () => {
  const { cachedVisibility } = await import('../scripts/lib/repo-discovery.mjs');
  const t = Date.parse('2026-01-01T00:00:00Z');
  const cache = { 'myorg/zbold': { public: false, at: new Date(t).toISOString() } };
  assert.equal(await cachedVisibility(async () => true, cache, { now: () => t + 1000 }).check('myorg', 'zbold'), true);
  assert.equal(cache['myorg/zbold'].public, true);
  const later = t + 25 * 60 * 60 * 1000;
  assert.equal(await cachedVisibility(async () => false, cache, { now: () => later }).check('myorg', 'zbold'), false);
  assert.equal(cache['myorg/zbold'], undefined, 'a repo that went private loses its cached true');
});

test('M5: discovery with unknown visibility sweeps nothing but the caller can see the count', async () => {
  const { cachedVisibility } = await import('../scripts/lib/repo-discovery.mjs');
  const base = mkdtempSync(join(tmpdir(), 'rd-m5-'));
  try {
    makeRepo(base, 'zbone', 'git@github.com:zbowner/zbone.git');
    makeRepo(base, 'zbtwo', 'https://github.com/zbowner/zbtwo.git');
    const v = cachedVisibility(async () => null, {});
    const found = await discoverLocalCheckouts({ devRoots: [base], checkVisibility: v.check });
    assert.deepEqual(found, []);
    assert.equal(v.stats.unknown, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('L3: defaultDevRoots never returns the temp dir when cwd sits directly under it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rd-l3-'));
  try {
    const roots = defaultDevRoots({ cwd, home: join(tmpdir(), 'rd-l3-home') });
    assert.deepEqual(roots, [], `no temp-dir roots expected, got ${JSON.stringify(roots)}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
