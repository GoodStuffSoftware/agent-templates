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
  TIERS, RISK_FLOORS, BATCH_RULE, tierLine, writerClause, reviewerClause, cellText, riskFloor, pathClass, FLOOR_COMMAND, highPathKind,
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
  assert.equal(tierLine('risk', null), ''); // outside a repo there is no project to name: no line
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
  assert.match(RISK_FLOORS, /by folder name or whole file-name word, never docs, tests, styles or UI source/);
  assert.ok(w.includes(FLOOR_COMMAND));
  assert.match(FLOOR_COMMAND, /^node "[^"]*\/scripts\/project-tiers\.mjs" floor <base>\.\.<head>$/);
  assert.match(w, /RISK: low\|mid\|high/);
  assert.match(w, /REVIEW: <the cell you applied>/);
  assert.ok(w.length < 1300, `writer clause is ${w.length} chars`);
  // The two short kinds carry no floors prose and no floor command, and stay inside their size budget (a typical project name).
  const leg = writerClause('risk', 'acme-app', { kind: 'leg' });
  for (const re of [/one leg of a larger job/, /you spawn no reviewer; the lead applies the review table once to the whole change/, /no self-chosen sections/, /Run unit tests for what you touch, no full suite, e2e, CI or full build/, /lead runs one pass after all legs/, /Commit, push, then report RISK: low\|mid\|high with the reason/]) {
    assert.match(leg, re);
  }
  const plain = writerClause('risk', 'acme-app', { kind: 'plain' });
  for (const re of [/^Project acme-app, project_tier risk\./, /You spawn no reviewer: the lead applies the review table once to the whole change/, /Report RISK: low\|mid\|high with the reason/, /Run unit tests for what you touch, no full suite or e2e: the lead runs one pass for the batch/]) {
    assert.match(plain, re);
  }
  for (const id of TIER_IDS) {
    const p = writerClause(id, 'acme-app', { kind: 'plain' });
    const l = writerClause(id, 'acme-app', { kind: 'leg' });
    assert.ok(p.length <= 300, `plain ${id} is ${p.length} chars`);
    assert.ok(l.length <= 450, `leg ${id} is ${l.length} chars`);
    for (const c of [p, l]) {
      assert.ok(!c.includes('floors:') && !c.includes(FLOOR_COMMAND) && !c.includes('project-tiers.mjs'), 'no floors prose, no floor command');
    }
  }
  // The protocol and reviewer kinds keep the floors and the floor command.
  for (const c of [writerClause('risk', 'acme-app'), reviewerClause('risk', 'acme-app')]) assert.ok(c.includes(RISK_FLOORS) && c.includes(FLOOR_COMMAND));
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
  assert.equal(cellText('push', 'high', 'reviewer'), 'read only in this tier');
  assert.match(reviewerClause('push', 'acme-app'), /High: read only in this tier\./);
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

// Path kinds: folder names and whole file-name words, never a bare substring, never a UI source tree.
const HIGH_PATHS = [
  '.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile', 'Dockerfile', 'docker-compose.yml', '.husky/pre-push',
  '.githooks/pre-commit', 'hooks/hooks.json', 'plugins/sample/hooks/guard.mjs', 'scripts/deploy-prod.sh', 'deploy/site.conf',
  'scripts/release.mjs', 'migrations/0042_add_col.sql', 'prisma/schema.prisma', 'db/schema.sql', 'firestore.rules',
  'src/auth/login.ts', 'src/payments/checkout.ts', 'server/billing/stripe.ts',
  // more: other spellings of the same kinds
  'infra/Dockerfile.dev', 'ci/build.sh', 'scripts/ci-run.sh', 'vite.config.ts', 'tsconfig.build.json', 'android/app/build.gradle.kts',
  'db/migrate/20240101_add_users.rb', 'src/lib/schema.ts', 'src/lib/AuthGuard.ts', 'src/sign-in.ts', 'src/oauth-callback.ts',
  'lib/stripe.js', 'plugins/x/src/hooks/guard.mjs', 'scripts/hooks/pre-commit', 'src/pages/api/auth/login.ts', 'deploy.sh',
  'ops/release-train.py', 'Makefile',
];
const SIZE_ONLY_PATHS = [
  'src/hooks/useCart.ts', 'app/hooks/useTheme.tsx', 'src/styles/design-tokens.css', 'src/lib/tokenizer.ts', 'src/components/SessionList.tsx',
  'src/components/SchemaForm.tsx', 'src/components/ReleaseBanner.tsx', 'src/pages/AuthorPage.tsx', 'docs/release-notes.md',
  // more: look like a kind, are not one
  'src/components/auth/LoginForm.tsx', 'src/components/checkout/CartRow.tsx', 'src/views/billing/InvoiceList.vue', 'src/lib/release-notes.ts',
  'src/author-list.ts', 'src/sessions.ts', 'src/lib/tokens.ts', 'src/components/hooks/useAuth.ts', 'src/utils/preschema.ts', 'README.md',
  'tests/auth/login.test.ts', 'docs/deploy-guide.md', 'src/auth/login.css', 'src/lib/checkouts-report.ts',
];

test('floors: path kinds floor high by folder name or whole file-name word', () => {
  for (const p of HIGH_PATHS) {
    assert.equal(riskFloor([{ path: p, added: 1, deleted: 0 }]).floor, 'high', p);
  }
  assert.equal(highPathKind('.github/workflows/ci.yml'), 'CI/build/deploy/hook');
  assert.equal(highPathKind('prisma/schema.prisma'), 'data/schema');
  assert.equal(highPathKind('src/payments/checkout.ts'), 'sign-in/payments');
});

test('floors: paths that only look like a kind floor by size, never high, and docs, tests and styles stay exempt', () => {
  for (const p of SIZE_ONLY_PATHS) {
    assert.notEqual(riskFloor([{ path: p, added: 1, deleted: 0 }]).floor, 'high', p);
  }
  // exempt classes are skipped even where the name matches a kind
  for (const p of ['docs/release-notes.md', 'tests/auth/login.test.ts', 'src/auth/login.css']) assert.equal(riskFloor([{ path: p, added: 1, deleted: 0 }]).floor, 'low', p);
  // size still applies to them
  assert.equal(riskFloor([{ path: 'src/components/SessionList.tsx', added: 320, deleted: 0 }]).floor, 'high');
  assert.equal(riskFloor([{ path: 'src/hooks/useCart.ts', added: 41, deleted: 0 }]).floor, 'mid');
  // empty and odd input never throws
  for (const p of ['', '/', null, undefined]) assert.equal(highPathKind(p), null);
  assert.equal(highPathKind('a\\b\\auth\\login.ts'), 'sign-in/payments');
});

// ---- landing mode: pr | direct, per project or as a default ----

test('landing: string entries, object entries and the top-level default; a project beats the default; absent is null', () => withFixture(({ dir }) => {
  const work = join(dir, 'work');
  mainRepo(work, 'plain-app'); mainRepo(work, 'obj-app'); mainRepo(work, 'tierless-app');
  writeTiers({ default: 'risk', projects: { 'plain-app': 'push', 'obj-app': { tier: 'gates', landing: 'direct' } } });
  const c = loadTiers();
  assert.deepEqual(c.problems, []);
  assert.equal(c.landing, null);
  assert.deepEqual(c.entries.map((e) => [e.key, e.tier, e.landing]), [['plain-app', 'push', null], ['obj-app', 'gates', 'direct']]);
  assert.equal(tierDetail(join(work, 'plain-app')).landing, null, 'a string entry says nothing about landing');
  assert.equal(tierDetail(join(work, 'plain-app')).tier, 'push');
  assert.deepEqual([tierDetail(join(work, 'obj-app')).tier, tierDetail(join(work, 'obj-app')).landing], ['gates', 'direct']);

  writeTiers({ landing: 'pr', projects: { 'plain-app': 'push', 'obj-app': { tier: 'gates', landing: 'direct' }, 'tierless-app': { landing: 'direct' } } });
  assert.equal(loadTiers().landing, 'pr');
  assert.equal(tierDetail(join(work, 'plain-app')).landing, 'pr', 'the default applies to a project without its own');
  assert.equal(tierDetail(join(work, 'obj-app')).landing, 'direct', 'a project entry wins over the default');
  const t = tierDetail(join(work, 'tierless-app'));
  assert.deepEqual([t.tier, t.landing, t.source], ['risk', 'direct', 'default'], 'a landing-only entry follows the default tier');
  assert.equal(tierFor(join(work, 'obj-app')).landing, undefined, 'tierFor (telemetry) gains no field');
}));

test('landing: an unknown value is ignored, listed under problems, and never breaks the tier', () => withFixture(({ dir }) => {
  const work = join(dir, 'work');
  mainRepo(work, 'obj-app');
  writeTiers({ landing: 'rebase', projects: { 'obj-app': { tier: 'gates', landing: 'ship-it' }, 'bad-app': { tier: 'gates', landing: 7 }, 'worse-app': { landing: 'x' } } });
  const c = loadTiers();
  assert.equal(c.landing, null);
  assert.ok(c.problems.some((p) => p.includes('"landing"') && p.includes('"rebase"')), c.problems.join('\n'));
  assert.ok(c.problems.some((p) => p.includes('obj-app') && p.includes('"ship-it"')), c.problems.join('\n'));
  assert.ok(c.problems.some((p) => p.includes('bad-app')), c.problems.join('\n'));
  assert.ok(c.problems.some((p) => p.includes('worse-app')), c.problems.join('\n'));
  const d = tierDetail(join(work, 'obj-app'));
  assert.deepEqual([d.tier, d.landing, d.source], ['gates', null, 'assigned']);
}));

test('landing: a malformed file gives no landing and no throw', () => withFixture(() => {
  writeTiers('{ not json');
  const c = loadTiers();
  assert.equal(c.landing, null);
  assert.ok(c.problems.length >= 1);
  writeTiers({ landing: ['pr'], projects: { a: { tier: 'push', landing: { x: 1 } } } });
  assert.equal(loadTiers().landing, null);
  assert.ok(loadTiers().problems.length >= 2);
}));

test('landing text: the writer clause (protocol and plain) and the session line carry one sentence per mode; the leg and reviewer clauses never do', () => {
  const D = 'No pull requests in this project: commit and push to the branch the brief names.';
  const P = 'Land through a pull request.';
  for (const kind of ['protocol', 'plain']) {
    const unset = writerClause('risk', 'acme-app', { kind });
    assert.ok(!unset.includes('pull request'), `${kind} unset`);
    assert.equal(writerClause('risk', 'acme-app', { kind, landing: 'direct' }), `${unset} ${D}`);
    assert.equal(writerClause('risk', 'acme-app', { kind, landing: 'pr' }), `${unset} ${P}`);
    assert.equal(writerClause('risk', 'acme-app', { kind, landing: 'bogus' }), unset, 'an unknown mode adds nothing');
  }
  const leg = writerClause('risk', 'acme-app', { kind: 'leg' });
  assert.equal(writerClause('risk', 'acme-app', { kind: 'leg', landing: 'direct' }), leg);
  assert.equal(reviewerClause('risk', 'acme-app', { landing: 'direct' }), reviewerClause('risk', 'acme-app'));
  const line = tierLine('risk', 'acme-app');
  assert.ok(!line.includes('pull request'));
  assert.equal(tierLine('risk', 'acme-app', { landing: 'direct' }), `${line} ${D}`);
  assert.equal(tierLine('risk', 'acme-app', { landing: 'pr' }), `${line} ${P}`);
  assert.ok(writerClause('risk', 'acme-app', { kind: 'plain' }).length <= 300, 'plain clause without landing stays within 300');
});

test('landing text: no landing sentence outside a git repo (no project), as with the session line', () => {
  for (const kind of ['protocol', 'plain']) {
    const none = writerClause('risk', null, { kind });
    assert.equal(writerClause('risk', null, { kind, landing: 'direct' }), none, `${kind} direct`);
    assert.equal(writerClause('risk', null, { kind, landing: 'pr' }), none, `${kind} pr`);
    assert.ok(!none.includes('pull request'));
  }
  assert.equal(tierLine('risk', null, { landing: 'direct' }), '');
});

test('batch rule: a gate or CI on the landing path that runs the suite is the pass; else whoever lands runs it once locally', () => {
  assert.match(BATCH_RULE, /where a push gate or CI on the landing path runs the full suite or e2e, that run is the pass/);
  assert.match(BATCH_RULE, /where neither does \(for example direct merges while CI runs only on pull requests\), whoever lands runs it once locally before landing/);
  assert.match(BATCH_RULE, /An unchanged tree is never rerun/);
  assert.doesNotMatch(BATCH_RULE, /counts everywhere/);
});

// ---- 0.31.51: the project from the brief (a session folder that is not inside a repo) ----

// A non-repo session folder `ws` that holds repos under `ws/repos` and worktrees under `ws/worktrees`.
function withWorkspace(fn) {
  return withFixture((fx) => {
    const ws = join(fx.dir, 'ws');
    mkdirSync(join(ws, 'repos'), { recursive: true });
    mkdirSync(join(ws, 'worktrees'), { recursive: true });
    return fn({ ...fx, ws });
  });
}
const fromBrief = (ws, brief) => tierDetail(ws, { brief });

test('brief: one repo path names the project; tier and landing come from the lookup a session inside that repo gets', () => withWorkspace(({ ws }) => {
  const repo = mainRepo(join(ws, 'repos'), 'acme-app');
  writeTiers({ default: 'risk', landing: 'pr', projects: { 'acme-app': { tier: 'gates', landing: 'direct' } } });
  const d = fromBrief(ws, `Work in ${norm(repo)} and report.`);
  assert.deepEqual([d.project, d.projectSource, d.tier, d.source, d.by, d.landing], ['acme-app', 'brief', 'gates', 'assigned', 'name', 'direct']);
  assert.equal(d.mainRoot, normalisePath(repo));
  // the same answer as a session inside the repo, except where the project came from
  const inside = tierDetail(repo);
  assert.deepEqual([inside.project, inside.tier, inside.source, inside.landing, inside.projectSource], ['acme-app', 'gates', 'assigned', 'direct', 'cwd']);
  // a path entry works too
  writeTiers({ projects: { [norm(repo)]: 'push' } });
  const p = fromBrief(ws, `see ${norm(repo)}`);
  assert.deepEqual([p.tier, p.source, p.by, p.projectSource], ['push', 'assigned', 'path', 'brief']);
  // no entry: the default, still a project
  writeTiers({ default: 'gates' });
  const q = fromBrief(ws, `see ${norm(repo)}`);
  assert.deepEqual([q.project, q.tier, q.source, q.projectSource], ['acme-app', 'gates', 'default', 'brief']);
}));

test('brief: a worktree path counts as its main repo', () => withWorkspace(({ dir, ws }) => {
  const main = mainRepo(join(ws, 'repos'), 'acme-app');
  const wt = join(ws, 'worktrees', 'feat-1');
  fakeWorktree(main, wt);
  const d = fromBrief(ws, `Your worktree is ${norm(wt)}.`);
  assert.deepEqual([d.project, d.projectSource, d.mainRoot, d.ownRoot], ['acme-app', 'brief', normalisePath(main), normalisePath(wt)]);
  // a worktree under the session folder whose main repo is elsewhere still counts as "under" it
  const far = mainRepo(join(dir, 'elsewhere'), 'far-app');
  const wt2 = join(ws, 'worktrees', 'far-1');
  fakeWorktree(far, wt2);
  const other = mainRepo(join(dir, 'elsewhere'), 'other-app');
  assert.equal(fromBrief(ws, `${norm(wt2)} and ${norm(other)}`).project, 'far-app');
}));

test('brief: two distinct repos is unresolved; a worktree and its main repo are one repo', () => withWorkspace(({ ws }) => {
  const a = mainRepo(join(ws, 'repos'), 'acme-app');
  const b = mainRepo(join(ws, 'repos'), 'beta-app');
  const d = fromBrief(ws, `compare ${norm(a)} with ${norm(b)}`);
  assert.deepEqual([d.project, d.projectSource, d.source, d.tier], [null, 'none', 'none', 'risk']);
  const wt = join(ws, 'worktrees', 'a-1');
  fakeWorktree(a, wt);
  assert.equal(fromBrief(ws, `${norm(a)} ${norm(wt)}`).project, 'acme-app');
}));

test('brief: a repo under the session folder beats one elsewhere; several under it is unresolved even with one elsewhere', () => withWorkspace(({ dir, ws }) => {
  const inWs = mainRepo(join(ws, 'repos'), 'acme-app');
  const outside = mainRepo(join(dir, 'elsewhere'), 'other-app');
  assert.equal(fromBrief(ws, `${norm(outside)} first, then ${norm(inWs)}`).project, 'acme-app');
  assert.equal(fromBrief(ws, `only ${norm(outside)}`).project, 'other-app', 'with none under the session folder, the one repo wins');
  const second = mainRepo(join(ws, 'repos'), 'beta-app');
  const d = fromBrief(ws, `${norm(inWs)} ${norm(second)} ${norm(outside)}`);
  assert.deepEqual([d.project, d.projectSource], [null, 'none']);
}));

test('brief: a path under the Claude config folder, or one that does not exist, is ignored', () => withWorkspace(({ dir, ws }) => {
  const real = mainRepo(join(ws, 'repos'), 'acme-app');
  const inClaude = mainRepo(join(dir, '.claude', 'plugins', 'cache'), 'plug-repo'); // <home>/.claude is the config folder in the fixture
  assert.equal(fromBrief(ws, `${norm(inClaude)}`).project, null, 'only a config-folder path: unresolved');
  assert.equal(fromBrief(ws, `${norm(inClaude)} and ${norm(real)}`).project, 'acme-app');
  assert.equal(fromBrief(ws, `${norm(join(ws, 'repos', 'gone-app'))} and ${norm(real)}`).project, 'acme-app', 'a missing path does not make it ambiguous');
  assert.equal(fromBrief(ws, `${norm(join(ws, 'repos', 'gone-app'))}`).project, null);
  // CLAUDE_CONFIG_DIR names another config folder: also excluded
  const custom = join(dir, 'custom-claude');
  const inCustom = mainRepo(join(custom, 'x'), 'cfg-repo');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = custom;
  try { assert.equal(fromBrief(ws, `${norm(inCustom)} ${norm(real)}`).project, 'acme-app'); } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  assert.equal(fromBrief(ws, `${norm(inCustom)}`).project, 'cfg-repo', 'without the override that folder is an ordinary one');
}));

test('brief: forward and back slashes, ~/, quotes, backticks, trailing punctuation and :line suffixes', () => withWorkspace(({ dir, ws }) => {
  const repo = mainRepo(join(ws, 'repos'), 'acme-app');
  const f = norm(repo);
  mkdirSync(join(repo, 'hooks'), { recursive: true });
  writeFileSync(join(repo, 'hooks', 'a.mjs'), '');
  const forms = [f, `\`${f}\``, `"${f}"`, `'${f}'`, `(${f})`, `see ${f}.`, `${f},`, `${f}:`, `**${f}**`, `[${f}](x)`, `${f}/`, `${f}/hooks/a.mjs:12:3`, `path=${f};`, `- ${f}\n`];
  for (const form of forms) assert.equal(fromBrief(ws, `x ${form} y`).project, 'acme-app', form);
  if (process.platform === 'win32') {
    assert.equal(fromBrief(ws, f.replace(/\//g, '\\')).project, 'acme-app', 'backslashes');
    assert.equal(fromBrief(ws, `\`${f.replace(/\//g, '\\')}\`.`).project, 'acme-app', 'backslashes in backticks, then a full stop');
  }
  // ~/ is the home folder (the fixture's home here)
  assert.equal(fromBrief(ws, 'in ~/ws/repos/acme-app now').project, 'acme-app');
  assert.equal(norm(dir) + '/ws/repos/acme-app', f);
  // not paths: a URL, a relative path, a word that merely ends in a path
  assert.equal(fromBrief(ws, 'https://example.invalid/ws/repos/acme-app and ./ws/repos/acme-app and a/b/acme-app').project, null);
}));

test('brief: a session folder inside a repo never consults the brief', () => withWorkspace(({ ws, dir }) => {
  const mine = mainRepo(join(dir, 'work'), 'mine-app');
  const named = mainRepo(join(ws, 'repos'), 'acme-app');
  mkdirSync(join(mine, 'src'), { recursive: true });
  const d = tierDetail(join(mine, 'src'), { brief: `only ${norm(named)}` });
  assert.deepEqual([d.project, d.projectSource], ['mine-app', 'cwd']);
  assert.equal(tierDetail(ws).projectSource, 'none');
  assert.equal(tierDetail(ws, { brief: '' }).projectSource, 'none');
  assert.equal(tierDetail(ws, { brief: undefined }).projectSource, 'none');
  assert.equal(tierDetail(ws, { brief: { not: 'a string' } }).projectSource, 'none');
}));

test('brief: plugin-added lines (a tier clause naming plugin paths) are not read; no session folder still resolves', () => withWorkspace(({ ws }) => {
  const repo = mainRepo(join(ws, 'repos'), 'acme-app');
  const other = mainRepo(join(ws, 'repos'), 'beta-app');
  assert.equal(fromBrief(ws, `${norm(repo)}\n[agent-companion: tier] Floor: node "${norm(other)}/scripts/project-tiers.mjs" floor <base>..<head>`).project, 'acme-app');
  assert.equal(tierDetail(undefined, { brief: `${norm(repo)}` }).project, 'acme-app');
}));

test('brief: bounded work. 3 MB of path-like tokens, one 3 MB token, and more than 40 distinct candidates all return promptly', () => withWorkspace(({ ws }) => {
  const repo = mainRepo(join(ws, 'repos'), 'acme-app');
  const f = norm(repo);
  const timed = (brief) => { const t0 = Date.now(); const d = fromBrief(ws, brief); return { d, ms: Date.now() - t0 }; };
  const tokens = timed(`${f}\n${'/x/y/z '.repeat(Math.ceil(3_000_000 / 7))}`);
  assert.equal(tokens.d.project, 'acme-app');
  assert.ok(tokens.ms < 3000, `token flood took ${tokens.ms} ms`);
  const long = timed(`${f}\n/${'a'.repeat(3_000_000)}`);
  assert.equal(long.d.project, 'acme-app');
  assert.ok(long.ms < 3000, `one huge token took ${long.ms} ms`);
  const prose = timed(`${f}\n${'plain words without any path in them. '.repeat(80_000)}`);
  assert.equal(prose.d.project, 'acme-app');
  assert.ok(prose.ms < 3000, `3 MB of prose took ${prose.ms} ms`);
  // only the first 40 distinct candidates are looked at: a repo named after 40 other paths is not found
  const many = Array.from({ length: 40 }, (_, i) => norm(join(ws, 'repos', `gone-${i}`))).join(' ');
  assert.equal(fromBrief(ws, `${many} ${f}`).project, null);
  assert.equal(fromBrief(ws, `${f} ${many}`).project, 'acme-app');
}));

test('text: the floor command names the repo when the project came from the brief; the unresolved wording fits the size limits', () => {
  const w = writerClause('risk', 'acme-app', { floorRepo: 'C:/dev/ws/repos/acme-app' });
  assert.ok(w.includes(`${FLOOR_COMMAND} --repo "C:/dev/ws/repos/acme-app"`));
  const r = reviewerClause('gates', 'acme-app', { floorRepo: 'C:/dev/ws/repos/acme-app' });
  assert.ok(r.includes(`${FLOOR_COMMAND} --repo "C:/dev/ws/repos/acme-app"`));
  assert.ok(!writerClause('risk', 'acme-app').includes('--repo'), 'a project from the session folder keeps the plain command');
  for (const id of TIER_IDS) {
    const p = writerClause(id, null, { kind: 'plain' });
    const l = writerClause(id, null, { kind: 'leg' });
    assert.ok(p.length <= 300, `unresolved plain ${id} is ${p.length} chars`);
    assert.ok(l.length <= 450, `unresolved leg ${id} is ${l.length} chars`);
    for (const c of [p, l, writerClause(id, null), reviewerClause(id, null)]) {
      assert.ok(!c.includes('outside a repo'), c.slice(0, 80));
      assert.match(c, /^Project not resolved from (folder\/brief; default tier\.|the session folder or the brief \(default tier applies\))/);
    }
    assert.match(p, /^Project not resolved from folder\/brief; default tier\. You spawn no reviewer/);
    assert.match(writerClause(id, null), new RegExp(`^Project not resolved from the session folder or the brief \\(default tier applies\\), project_tier ${id} `));
    assert.match(reviewerClause(id, null), new RegExp(`project_tier ${id} \\(${TIERS[id].label}\\)\\. Your checks depend`));
  }
  assert.match(writerClause('risk', null), /^Project not resolved from the session folder or the brief \(default tier applies\), project_tier risk \(Risk-tiered\)\./);
});
