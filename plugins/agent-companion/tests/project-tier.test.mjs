// Project tiers: the repo/worktree resolver, the tolerant loader, tierFor, the text and the risk floors.
// Repositories are throwaway folders under a fixture temp dir (hand-built `.git` layouts, plus one real git worktree).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import {
  projectOf, repoOf, loadTiers, tierFor, tierDetail, tiersPath, normalisePath, isPathKey, TIER_IDS, DEFAULT_TIER,
} from '../hooks/lib/project-tier.mjs';
import {
  TIERS, RISK_FLOORS, BATCH_RULE, tierLine, writerClause, reviewerClause, cellText, riskFloor, pathClass, FLOOR_COMMAND,
} from '../hooks/lib/tier-text.mjs';

const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...cleanGitEnv(), ...IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}
const norm = (p) => p.replace(/\\/g, '/');
const writeTiers = (obj) => writeFileSync(tiersPath(), typeof obj === 'string' ? obj : JSON.stringify(obj));

// A main checkout `<root>/<name>` with a directory `.git`.
function mainRepo(root, name) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function relPath(from, to) {
  const a = norm(from).split('/');
  const b = norm(to).split('/');
  while (a.length && b.length && a[0].toLowerCase() === b[0].toLowerCase()) { a.shift(); b.shift(); }
  return [...a.map(() => '..'), ...b].join('/');
}

// A linked worktree folder `wt` of `main`, built by hand: a `.git` FILE plus the gitdir with a commondir.
function fakeWorktree(main, wt, { relative = false } = {}) {
  const gitdir = join(main, '.git', 'worktrees', 'n1');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${relative ? relPath(wt, gitdir) : norm(gitdir)}\n`);
}

function withFixture(fn) {
  const fx = makeFixture();
  try { return fn(fx); } finally { fx.cleanup(); }
}

test('projectOf: main checkout, nested folder, outside any repo', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  mkdirSync(join(main, 'src', 'deep'), { recursive: true });
  assert.equal(projectOf(main), 'acme-app');
  assert.equal(projectOf(join(main, 'src', 'deep')), 'acme-app');
  const bare = join(dir, 'nowhere', 'x');
  mkdirSync(bare, { recursive: true });
  assert.equal(projectOf(bare), null);
  assert.equal(projectOf(''), null);
  assert.equal(projectOf(undefined), null);
}));

test('projectOf: a worktree under .claude/worktrees and a sibling worktree both name the main repo', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const inside = join(main, '.claude', 'worktrees', 'agent-1');
  const sibling = join(dir, 'work', 'acme-app-fix');
  fakeWorktree(main, inside);
  fakeWorktree(main, sibling);
  assert.equal(projectOf(inside), 'acme-app');
  assert.equal(projectOf(sibling), 'acme-app');
  const r = repoOf(sibling);
  assert.equal(r.mainRoot, norm(main));
  assert.equal(r.ownRoot, norm(sibling));
}));

test('projectOf: a relative gitdir (worktree.useRelativePaths) resolves too', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const wt = join(dir, 'work', 'acme-rel');
  fakeWorktree(main, wt, { relative: true });
  assert.equal(projectOf(wt), 'acme-app');
}));

test('projectOf: a bare common dir foo.git is the project foo; a submodule is its own project', () => withFixture(({ dir }) => {
  const bareDir = join(dir, 'srv', 'foo.git');
  const gitdir = join(bareDir, 'worktrees', 'w');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  const wt = join(dir, 'srv', 'foo-wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${norm(gitdir)}\n`);
  assert.equal(projectOf(wt), 'foo');

  const sup = mainRepo(join(dir, 'work'), 'super');
  const modGitdir = join(sup, '.git', 'modules', 'lib');
  mkdirSync(modGitdir, { recursive: true });
  const sub = join(sup, 'vendor', 'lib');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, '.git'), `gitdir: ${norm(modGitdir)}\n`); // no commondir
  assert.equal(projectOf(sub), 'lib');
  assert.equal(projectOf(sup), 'super');
}));

test('projectOf: a real git worktree names the main repo', { skip: spawnSync('git', ['--version'], { windowsHide: true }).status !== 0 }, () => withFixture(({ dir }) => {
  const main = join(dir, 'real-main-repo');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'a\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'seed');
  const wt = join(dir, 'real-wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  assert.equal(projectOf(wt), 'real-main-repo');
  assert.equal(repoOf(wt).mainRoot.toLowerCase(), norm(main).toLowerCase());
}));

test('loadTiers: no file means the defaults and no problems', () => withFixture(() => {
  const c = loadTiers();
  assert.equal(c.exists, false);
  assert.equal(c.default, 'risk');
  assert.equal(c.sessionLine, true);
  assert.equal(c.reviewEveryChange, false);
  assert.deepEqual(c.entries, []);
  assert.deepEqual(c.problems, []);
}));

test('loadTiers: malformed JSON, wrong shape and unknown values fall back and are listed; nothing throws', () => withFixture(() => {
  writeTiers('{ not json');
  let c = loadTiers();
  assert.equal(c.default, 'risk');
  assert.match(c.problems.join('\n'), /not valid JSON/);

  writeTiers('["push"]');
  c = loadTiers();
  assert.match(c.problems.join('\n'), /not an object/);

  writeTiers({ default: 'strict', sessionLine: 'yes', reviewEveryChange: 1, projects: { a: 'push', b: 'nope', c: 5, ' ': 'push', d: ' GATES ' } });
  c = loadTiers();
  assert.equal(c.default, 'risk');
  assert.equal(c.sessionLine, true);
  assert.equal(c.reviewEveryChange, false);
  assert.deepEqual(c.entries.map((e) => [e.key, e.tier]), [['a', 'push'], ['d', 'gates']]);
  assert.equal(c.problems.length, 6);

  writeTiers({ projects: ['a'] });
  assert.match(loadTiers().problems.join('\n'), /"projects" must be an object/);
}));

test('loadTiers: valid values are read; a BOM is tolerated', () => withFixture(() => {
  writeTiers(`\uFEFF${JSON.stringify({ default: 'Gates', sessionLine: false, reviewEveryChange: true, projects: { 'Acme-App': 'push', 'C:\\dev\\acme': 'gates' } })}`);
  const c = loadTiers();
  assert.equal(c.default, 'gates');
  assert.equal(c.sessionLine, false);
  assert.equal(c.reviewEveryChange, true);
  assert.deepEqual(c.entries.map((e) => [e.key, e.tier, e.isPath]), [['Acme-App', 'push', false], ['C:\\dev\\acme', 'gates', true]]);
  assert.deepEqual(c.problems, []);
}));

test('tierFor: no config file is tier risk with source default; outside a repo is source none', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  assert.deepEqual(tierFor(main), { project: 'acme-app', tier: 'risk', source: 'default' });
  const out = join(dir, 'plain');
  mkdirSync(out, { recursive: true });
  assert.deepEqual(tierFor(out), { project: null, tier: 'risk', source: 'none' });
  assert.deepEqual(tierFor(undefined), { project: null, tier: 'risk', source: 'none' });
}));

test('tierFor: a name key matches case-insensitively from any worktree; the default applies to other projects', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const wt = join(dir, 'work', 'acme-wt');
  fakeWorktree(main, wt);
  mainRepo(join(dir, 'work'), 'other');
  writeTiers({ default: 'gates', projects: { 'ACME-App': 'push' } });
  assert.deepEqual(tierFor(wt), { project: 'acme-app', tier: 'push', source: 'assigned' });
  assert.deepEqual(tierFor(join(dir, 'work', 'other')), { project: 'other', tier: 'gates', source: 'default' });
}));

test('tierFor: a path key wins over a name key; compared case-insensitively with slashes normalised', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  const wt = join(dir, 'work', 'acme-wt');
  fakeWorktree(main, wt);
  writeTiers({ projects: { 'acme-app': 'push', [norm(main).toUpperCase()]: 'gates' } });
  assert.equal(tierFor(main).tier, 'gates');
  assert.equal(tierFor(wt).tier, 'gates'); // the worktree resolves to the main repo's path
  assert.equal(tierDetail(wt).by, 'path');
  if (process.platform === 'win32') { // a backslash path key is a Windows form; elsewhere a backslash is part of a file name
    writeTiers({ projects: { 'acme-app': 'push', [`${norm(main).replace(/\//g, '\\')}\\`]: 'gates' } });
    assert.equal(tierFor(main).tier, 'gates');
  }
  writeTiers({ projects: { 'acme-app': 'push', [join(dir, 'elsewhere')]: 'gates' } });
  assert.equal(tierFor(main).tier, 'push');
  assert.equal(tierDetail(main).by, 'name');
}));

test('tierFor survives an unreadable config (a directory where the file should be)', () => withFixture(({ dir }) => {
  const main = mainRepo(join(dir, 'work'), 'acme-app');
  mkdirSync(tiersPath(), { recursive: true });
  assert.deepEqual(tierFor(main), { project: 'acme-app', tier: 'risk', source: 'default' });
  assert.ok(loadTiers().problems.length >= 1);
}));

test('normalisePath and isPathKey', () => {
  if (process.platform === 'win32') assert.equal(normalisePath('C:\\Dev\\Acme\\'), 'C:/Dev/Acme');
  assert.equal(isPathKey('acme-app'), false);
  assert.equal(isPathKey('dev/acme'), true);
  assert.equal(isPathKey('C:\\dev\\acme'), true);
  assert.equal(isPathKey('.'), true);
  assert.deepEqual(TIER_IDS, ['push', 'risk', 'gates']);
  assert.equal(DEFAULT_TIER, 'risk');
});

test('text: tiers, labels and lines; fields say project_tier', () => {
  assert.deepEqual(Object.keys(TIERS), ['push', 'risk', 'gates']);
  assert.deepEqual(Object.values(TIERS).map((t) => t.label), ['Push on your word', 'Risk-tiered', 'Full gates']);
  for (const id of TIER_IDS) {
    const line = tierLine(id, 'acme-app');
    assert.match(line, new RegExp(`^\\[agent-companion\\] Project acme-app, project_tier ${id} \\(${TIERS[id].label}\\)`));
    assert.match(line, /E2E once per batch and tree/);
  }
  assert.match(tierLine('risk', null), /^\[agent-companion\] No project \(outside a repo\): project_tier risk by default/);
  assert.ok(tierLine('gates', 'x').length < 420);
});

test('text: reviewEveryChange turns every "no reviewer" cell into one reviewer by reading', () => {
  for (const id of TIER_IDS) {
    for (const r of ['low', 'mid', 'high']) {
      assert.doesNotMatch(cellText(id, r, 'writer', true), /no reviewer/, `${id}/${r}`);
    }
    assert.doesNotMatch(tierLine(id, 'x', { reviewEveryChange: true }), /no reviewer/);
  }
  assert.match(cellText('risk', 'low', 'writer', false), /no reviewer/);
  assert.match(cellText('push', 'low', 'writer', true), /one reviewer by reading/);
});

test('text: writer clause is short, names the floors line and the absolute floor command; the leg clause carries the leg rules', () => {
  const w = writerClause('risk', 'acme-app');
  assert.ok(w.includes(RISK_FLOORS));
  assert.ok(w.includes(FLOOR_COMMAND));
  assert.match(FLOOR_COMMAND, /^node "[^"]*\/scripts\/project-tiers\.mjs" floor <base>\.\.<head>$/);
  assert.match(w, /RISK: low\|mid\|high/);
  assert.match(w, /REVIEW: <the cell you applied>/);
  assert.ok(w.length < 1300, `writer clause is ${w.length} chars`);
  const leg = writerClause('risk', 'acme-app', { kind: 'leg' });
  for (const re of [/one leg of a larger job/, /no self-chosen sections or milestone stops/, /Unit tests are cheap/, /Run no end-to-end tests, CI or full build/, /lead runs one pass after all legs/, /write or extend e2e tests/, /Commit, push, then report/, /applies the change-risk table once to the whole diff/]) {
    assert.match(leg, re);
  }
  const plain = writerClause('risk', 'acme-app', { kind: 'plain' });
  assert.ok(plain.includes(BATCH_RULE));
});

test('text: no wording tells a worker to stop or wrap up by step count', () => {
  const all = [BATCH_RULE, RISK_FLOORS, writerClause('gates', 'p'), writerClause('gates', 'p', { kind: 'leg' }), writerClause('gates', 'p', { kind: 'plain' }), reviewerClause('gates', 'p'), ...Object.values(TIERS).map((t) => t.meaning)].join('\n');
  assert.doesNotMatch(all, /\b(after|within|at)\s+\d+\s+(steps|turns|calls|tool calls)\b/i);
  assert.doesNotMatch(all, /wrap up|step budget|too many steps/i);
});

test('text: the high-risk reviewer cell lets the reviewer run the project\'s own run or dev command, with no separate build', () => {
  for (const id of ['risk', 'gates']) {
    const hi = cellText(id, 'high', 'reviewer');
    assert.match(hi, /run or dev command/);
    assert.match(hi, /compile that command does itself/);
    assert.match(hi, /no separate full build, packaging or install/);
    assert.match(hi, /not checked for real/);
  }
  assert.equal(cellText('push', 'high', 'reviewer'), 'read only in this tier, even though the general instruction above allows a run');
  assert.match(reviewerClause('push', 'acme-app'), /High: read only in this tier, even though the general instruction above allows a run\./);
  assert.equal(cellText('risk', 'mid', 'reviewer'), 'read only');
  assert.ok(reviewerClause('risk', 'acme-app').includes('you may raise it, never lower it'));
});

test('floors: classification and the three levels', () => {
  assert.equal(pathClass('package-lock.json'), 'excluded');
  assert.equal(pathClass('README.md'), 'docs');
  assert.equal(pathClass('src/a.test.ts'), 'tests');
  assert.equal(pathClass('web/app.css'), 'styles');
  assert.equal(pathClass('config/app.json'), 'config');
  assert.equal(pathClass('src/app.ts'), 'source');

  const f = (path, n, extra = {}) => ({ path, added: n, deleted: 0, ...extra });
  assert.equal(riskFloor([]).floor, 'low');
  assert.equal(riskFloor([f('README.md', 500)]).floor, 'high'); // 300+ lines counts docs too
  assert.equal(riskFloor([f('docs/a.md', 100), f('package-lock.json', 9000)]).floor, 'low'); // the lockfile is excluded
  assert.equal(riskFloor([f('src/a.ts', 10)]).floor, 'low');
  assert.equal(riskFloor([f('src/a.ts', 10), f('src/b.ts', 1)]).floor, 'mid');
  assert.equal(riskFloor([f('src/a.ts', 45)]).floor, 'mid');
  assert.equal(riskFloor([f('src/a.ts', 3, { isNew: true })]).floor, 'mid');
  assert.equal(riskFloor([f('src/a.ts', 3), f('tests/a.test.ts', 400)]).floor, 'high');
  assert.equal(riskFloor(Array.from({ length: 8 }, (_, i) => f(`d/${i}.md`, 1))).floor, 'high');
  for (const p of ['.github/workflows/ci.yml', 'src/auth/guard.ts', 'db/migrations/001.sql', 'infra/Dockerfile', 'deploy/run.sh', 'src/billing.ts']) {
    assert.equal(riskFloor([f(p, 1)]).floor, 'high', p);
  }
  assert.equal(riskFloor([f('src/author-list.ts', 1)]).floor, 'low'); // "author" is not "auth"
  assert.equal(riskFloor([f('tests/session.test.ts', 1)]).floor, 'low'); // a test is not a high-risk path kind
  assert.equal(riskFloor([f('package.json', 1, { forceKind: 'CI/build/deploy/hook' })]).floor, 'high');
  const r = riskFloor([f('src/a.ts', 3), f('src/b.ts', 3)]);
  assert.match(r.reasons.join(' '), /2 source files/);
});
