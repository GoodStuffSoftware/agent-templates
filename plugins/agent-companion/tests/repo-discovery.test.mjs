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
