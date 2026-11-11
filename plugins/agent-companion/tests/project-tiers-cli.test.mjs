// scripts/project-tiers.mjs: list, show, set, unset, floor. Real throwaway repos (and one real worktree)
// under a fixture temp dir; the config lives in the fixture's state dir, never the real home.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runScript, runHook, readJsonl } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import { tiersPath, tierDetail, tierFor } from '../hooks/lib/project-tier.mjs';

const GIT_OK = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const IDENT = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...cleanGitEnv(), ...IDENT } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}
const norm = (p) => p.replace(/\\/g, '/');
const cli = (args, opts = {}) => runScript('scripts/project-tiers.mjs', args, opts);

// A main repo `acme-app` with one commit and a linked worktree `acme-wt`.
function withRepoAndWorktree(fn) {
  const fx = makeFixture();
  try {
    const main = join(fx.dir, 'work', 'acme-app');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'seed\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'seed');
    const wt = join(fx.dir, 'work', 'acme-wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    return fn({ ...fx, main, wt });
  } finally {
    fx.cleanup();
  }
}

test('show: a repo and a worktree of it name the main repo, the tier and the source', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main, wt }) => {
  const a = cli(['show', main]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^project: acme-app$/m);
  assert.match(a.stdout, /^project_tier: risk \(Risk-tiered\)$/m);
  assert.match(a.stdout, /^source: default /m);
  const b = cli(['show', wt]);
  assert.match(b.stdout, /^project: acme-app$/m);
  assert.ok(b.stdout.toLowerCase().includes(`repo: ${norm(main).toLowerCase()}`), b.stdout);
  assert.match(b.stdout, /^worktree: /m);
}));

test('set then show round-trips, by name and by path (a worktree path stores the main repo root)', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main, wt }) => {
  let r = cli(['set', 'acme-app', 'push']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['show', wt]);
  assert.match(r.stdout, /^project_tier: push \(Push on your word\)$/m);
  assert.match(r.stdout, /^source: assigned by name "acme-app"$/m);

  r = cli(['set', wt, 'gates']); // a worktree path -> the main repo's root
  assert.equal(r.status, 0, r.stderr);
  const stored = JSON.parse(readFileSync(tiersPath(), 'utf8'));
  assert.equal(stored.projects['acme-app'], 'push');
  const pathKey = Object.keys(stored.projects).find((k) => k.includes('/'));
  assert.ok(pathKey && pathKey.toLowerCase() === norm(main).toLowerCase(), `stored ${pathKey}`);
  assert.equal(stored.projects[pathKey], 'gates');
  r = cli(['show', main]);
  assert.match(r.stdout, /^project_tier: gates \(Full gates\)$/m);
  assert.match(r.stdout, /^source: assigned by path /m); // the path wins over the name

  r = cli(['set', main, 'risk']); // the same repo again replaces the path entry, no duplicate
  assert.equal(Object.keys(JSON.parse(readFileSync(tiersPath(), 'utf8')).projects).filter((k) => k.includes('/')).length, 1);
  r = cli(['unset', wt]);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['unset', 'ACME-APP']); // names are case-insensitive
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(tiersPath(), 'utf8')).projects, {});
  assert.match(cli(['show', main]).stdout, /^source: default /m);
  assert.notEqual(cli(['unset', 'acme-app']).status, 0, 'nothing left to remove');
}));

test('a new file has the documented shape; other fields in an existing file are kept', () => {
  const fx = makeFixture();
  try {
    assert.equal(cli(['set', 'acme-app', 'gates']).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(tiersPath(), 'utf8')), { default: 'risk', sessionLine: true, reviewEveryChange: false, projects: { 'acme-app': 'gates' } });
    writeFileSync(tiersPath(), JSON.stringify({ default: 'push', sessionLine: false, note: 'mine', projects: { other: 'gates' } }));
    assert.equal(cli(['set', 'acme-app', 'push']).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(tiersPath(), 'utf8')), { default: 'push', sessionLine: false, note: 'mine', projects: { other: 'gates', 'acme-app': 'push' } });
    assert.ok(!readdirSync(join(tiersPath(), '..')).some((f) => f.endsWith('.tmp')), 'no temp file left behind');
  } finally {
    fx.cleanup();
  }
});

test('set refuses an unknown tier, a missing name, a non-repo path; unset refuses a missing entry', () => {
  const fx = makeFixture();
  try {
    let r = cli(['set', 'acme-app', 'strict']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown tier "strict"/);
    assert.ok(!existsSync(tiersPath()), 'nothing written');
    for (const bad of [['set'], ['set', 'acme-app'], ['set', '', 'push']]) {
      r = cli(bad);
      assert.notEqual(r.status, 0, bad.join(' '));
      assert.match(r.stderr, /set needs a project and a tier\. Usage: project-tiers\.mjs list/, bad.join(' '));
    }
    assert.ok(!existsSync(tiersPath()), 'still nothing written');
    const plain = join(fx.dir, 'plain');
    mkdirSync(plain, { recursive: true });
    r = cli(['set', plain, 'push']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not inside a git repository/);
    assert.notEqual(cli(['bogus']).status, 0);
  } finally {
    fx.cleanup();
  }
});

test('a malformed file survives: list and show name the problem, set and unset leave it untouched', () => {
  const fx = makeFixture();
  try {
    writeFileSync(tiersPath(), '{ nope');
    let r = cli(['list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /problem: not valid JSON/);
    assert.match(r.stdout, /default: risk/);
    r = cli(['show', fx.dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^problem: not valid JSON/m);
    r = cli(['set', 'acme-app', 'push']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /left untouched/);
    assert.equal(readFileSync(tiersPath(), 'utf8'), '{ nope');
    assert.notEqual(cli(['unset', 'acme-app']).status, 0);
    assert.equal(readFileSync(tiersPath(), 'utf8'), '{ nope');
    writeFileSync(tiersPath(), JSON.stringify({ projects: ['x'] }));
    assert.notEqual(cli(['set', 'acme-app', 'push']).status, 0);
    assert.equal(readFileSync(tiersPath(), 'utf8'), JSON.stringify({ projects: ['x'] }));
  } finally {
    fx.cleanup();
  }
});

test('list shows the defaults with no file, and every entry once there is one', () => {
  const fx = makeFixture();
  try {
    let r = cli(['list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no file yet: every project is tier risk/);
    cli(['set', 'acme-app', 'push']);
    cli(['set', 'other-app', 'gates']);
    r = cli(['list']);
    assert.match(r.stdout, /acme-app -> push \(Push on your word\)/);
    assert.match(r.stdout, /other-app -> gates \(Full gates\)/);
    assert.match(cli([]).stdout, /Project tiers/);
  } finally {
    fx.cleanup();
  }
});

test('show outside a repo: no project, source none', () => {
  const fx = makeFixture();
  try {
    const r = cli(['show', fx.dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^project: \(none: not inside a repo\)$/m);
    assert.match(r.stdout, /^source: none /m);
  } finally {
    fx.cleanup();
  }
});

test('floor: low, mid and high for real commit ranges; errors print "floor unknown" and exit 0', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  const base = git(main, 'rev-parse', 'HEAD');
  const add = (rel, text, msg) => {
    mkdirSync(join(main, rel, '..'), { recursive: true });
    writeFileSync(join(main, rel), text);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', msg);
    return git(main, 'rev-parse', 'HEAD');
  };
  const docs = add('docs/notes.md', 'a\nb\n', 'docs');
  let r = cli(['floor', `${base}..${docs}`], { cwd: main });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^floor: low$/m);

  const src = add('src/app.js', 'export const x = 1;\n', 'new source file');
  r = cli(['floor', `${base}..${src}`], { cwd: main });
  assert.match(r.stdout, /^floor: mid$/m);
  assert.match(r.stdout, /a new source file/);

  const ci = add('.github/workflows/ci.yml', 'name: ci\n', 'ci');
  r = cli(['floor', `${base}..${ci}`], { cwd: main });
  assert.match(r.stdout, /^floor: high$/m);
  assert.match(r.stdout, /CI\/build\/deploy\/hook: \.github\/workflows\/ci\.yml/);

  // package.json: a dependency change is not a build change; a scripts change is
  const p0 = add('package.json', JSON.stringify({ name: 'x', scripts: { test: 'a' }, dependencies: {} }), 'pkg');
  const p1 = add('package.json', JSON.stringify({ name: 'x', scripts: { test: 'a' }, dependencies: { y: '1' } }), 'dep');
  const p2 = add('package.json', JSON.stringify({ name: 'x', scripts: { test: 'b' }, dependencies: { y: '1' } }), 'script');
  assert.match(cli(['floor', `${p0}..${p1}`], { cwd: main }).stdout, /^floor: low$/m);
  assert.match(cli(['floor', `${p1}..${p2}`], { cwd: main }).stdout, /^floor: high$/m);

  for (const bad of [['floor'], ['floor', 'nonsense'], ['floor', 'aaaaaaa..bbbbbbb'], ['floor', '--output=x..y']]) {
    r = cli(bad, { cwd: main });
    assert.equal(r.status, 0, `${bad}: ${r.stderr}`);
    assert.match(r.stdout, /^floor unknown: /, bad.join(' '));
  }
  r = cli(['floor', `${base}..${docs}`], { cwd: join(main, '..') }); // not a repo
  assert.match(r.stdout, /^floor unknown: /);
}));

test('floor: a...b diffs from the merge base, a..b stays a two-dot diff', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  const commit = (rel, text, msg) => {
    mkdirSync(join(main, rel, '..'), { recursive: true });
    writeFileSync(join(main, rel), text);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', msg);
  };
  git(main, 'checkout', '-q', '-b', 'topic');
  commit('docs/notes.md', 'a\nb\n', 'docs on the topic branch');
  git(main, 'checkout', '-q', 'main');
  commit('.github/workflows/ci.yml', 'name: ci\n', 'ci lands on main after the branch point');
  // topic changed only a doc since the branch point; main has moved on with a CI file
  let r = cli(['floor', 'main...topic'], { cwd: main });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^floor: low$/m, r.stdout);
  assert.doesNotMatch(r.stdout, /ci\.yml/);
  // the two-dot diff of the two tips also sees main's CI file (as a deletion)
  r = cli(['floor', 'main..topic'], { cwd: main });
  assert.match(r.stdout, /^floor: high$/m, r.stdout);
  assert.match(r.stdout, /ci\.yml/);
  // an unknown ref on either side still prints "floor unknown"
  assert.match(cli(['floor', 'main...nope'], { cwd: main }).stdout, /^floor unknown: /);
}));

test('a config path that is a folder is reported as not a file, by list and by set', () => {
  const fx = makeFixture();
  try {
    mkdirSync(tiersPath(), { recursive: true });
    let r = cli(['list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /problem: is not a file/);
    assert.doesNotMatch(r.stdout, /not valid JSON/);
    r = cli(['set', 'acme-app', 'push']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not a file/);
    assert.doesNotMatch(r.stderr, /not valid JSON/);
  } finally {
    fx.cleanup();
  }
});

test('landing: set and clear for a project and for the default; show and list print it; untouched entries are not rewritten', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  const read = () => JSON.parse(readFileSync(tiersPath(), 'utf8'));
  writeFileSync(tiersPath(), JSON.stringify({ default: 'risk', projects: { 'other-app': 'gates' } }));
  let r = cli(['show', main]);
  assert.match(r.stdout, /^landing: not set /m);
  r = cli(['list']);
  assert.match(r.stdout, /^ {2}landing: not set /m);

  r = cli(['landing', 'acme-app', 'direct']); // a project with no entry: a tier-less object that follows the default tier
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read().projects['acme-app'], { landing: 'direct' });
  assert.equal(read().projects['other-app'], 'gates', 'an untouched entry stays a string');
  r = cli(['show', main]);
  assert.match(r.stdout, /^landing: direct /m);
  assert.match(r.stdout, /^project_tier: risk /m);

  r = cli(['set', 'acme-app', 'push']); // set keeps working and keeps the landing mode
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read().projects['acme-app'], { tier: 'push', landing: 'direct' });
  r = cli(['list']);
  assert.match(r.stdout, /acme-app -> push \(Push on your word\), landing direct/);
  r = cli(['landing', 'acme-app', 'pr']);
  assert.deepEqual(read().projects['acme-app'], { tier: 'push', landing: 'pr' });
  r = cli(['landing', 'acme-app', 'clear']); // back to the plain tier string
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read().projects['acme-app'], 'push');
  r = cli(['landing', 'acme-app', 'clear']);
  assert.equal(r.status, 0, r.stderr); // clearing what is not there is a no-op on an existing entry
  r = cli(['landing', 'no-such-app', 'clear']);
  assert.notEqual(r.status, 0);

  r = cli(['landing', '--default', 'direct']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read().landing, 'direct');
  r = cli(['show', main]);
  assert.match(r.stdout, /^landing: direct /m); // acme-app has its own entry with no landing: the default applies
  assert.match(cli(['list']).stdout, /^ {2}landing: direct$/m);
  r = cli(['landing', '--default', 'clear']);
  assert.ok(!('landing' in read()));

  r = cli(['landing', 'acme-app', 'rebase']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown landing mode/);
  r = cli(['landing', 'acme-app']);
  assert.notEqual(r.status, 0);
  assert.equal(read().projects['acme-app'], 'push');
}));

test('landing: an unknown value in the file shows under problems in list and show', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  writeFileSync(tiersPath(), JSON.stringify({ landing: 'squash', projects: { 'acme-app': { tier: 'gates', landing: 'later' } } }));
  const l = cli(['list']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /problem: "landing" must be one of pr, direct/);
  assert.match(l.stdout, /problem: project "acme-app": landing "later"/);
  assert.match(cli(['show', main]).stdout, /^landing: not set /m);
}));

test('landing: a malformed file is refused by the landing command and left untouched', { skip: !GIT_OK }, () => withRepoAndWorktree(() => {
  writeFileSync(tiersPath(), '{ nope');
  const r = cli(['landing', 'acme-app', 'direct']);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(tiersPath(), 'utf8'), '{ nope');
}));

// ---- review round 0.31.51: tier and landing resolve on their own ----

test('landing on a path never changes a tier assigned by name: show, resolver and the spawn row agree', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main, stateDir }) => {
  const read = () => JSON.parse(readFileSync(tiersPath(), 'utf8'));
  writeFileSync(tiersPath(), JSON.stringify({ default: 'risk', projects: { 'acme-app': 'gates' } }));
  const r = cli(['landing', main, 'direct']);
  assert.equal(r.status, 0, r.stderr);
  const projects = read().projects;
  assert.equal(projects['acme-app'], 'gates', 'the name entry is untouched');
  assert.deepEqual(Object.values(projects).filter((v) => typeof v === 'object'), [{ landing: 'direct' }], 'the path entry holds only the landing mode');

  const s = cli(['show', main]);
  assert.match(s.stdout, /^project_tier: gates /m);
  assert.match(s.stdout, /^source: assigned by name "acme-app"$/m);
  assert.match(s.stdout, /^landing: direct /m);
  assert.match(s.stdout, /^landing_source: assigned by path /m);

  const d = tierDetail(main);
  assert.deepEqual([d.tier, d.source, d.by, d.landing, d.landingSource, d.landingBy], ['gates', 'assigned', 'name', 'direct', 'assigned', 'path']);
  assert.deepEqual(tierFor(main), { project: 'acme-app', tier: 'gates', source: 'assigned' });

  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: 'sess-tier-landing', agent_type: 'main', cwd: main,
    tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'TYPE: explore\nlook around', run_in_background: true, name: 'w' },
  });
  assert.equal(res.status, 0, res.stderr);
  const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
  assert.equal(rows.at(-1).project_tier, 'gates');
  assert.equal(rows.at(-1).tier_source, 'assigned');
}));

test('the reverse: a tier set by path never hides a landing mode set by name, and each field falls back on its own', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  writeFileSync(tiersPath(), JSON.stringify({ default: 'risk', landing: 'pr', projects: { 'acme-app': { landing: 'direct' } } }));
  let r = cli(['set', main, 'push']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['show', main]);
  assert.match(r.stdout, /^project_tier: push /m);
  assert.match(r.stdout, /^source: assigned by path /m);
  assert.match(r.stdout, /^landing: direct /m);
  assert.match(r.stdout, /^landing_source: assigned by name "acme-app"$/m);
  // a project with no entry: the tier falls back to the default and the landing mode to the top-level one
  const otherRepo = join(main, '..', 'other-app');
  mkdirSync(join(otherRepo, '.git'), { recursive: true });
  const other = tierDetail(otherRepo);
  assert.deepEqual([other.tier, other.source, other.landing, other.landingSource], ['risk', 'default', 'pr', 'default']);
}));

test('set after landing keeps the landing mode; clearing landing from an entry that then holds nothing removes it', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  const read = () => JSON.parse(readFileSync(tiersPath(), 'utf8'));
  writeFileSync(tiersPath(), JSON.stringify({ default: 'risk', projects: { 'acme-app': 'gates' } }));
  assert.equal(cli(['landing', main, 'direct']).status, 0);
  assert.equal(cli(['set', main, 'push']).status, 0); // set on the path entry that has a landing mode keeps it
  const key = Object.keys(read().projects).find((k) => k !== 'acme-app');
  assert.deepEqual(read().projects[key], { tier: 'push', landing: 'direct' });
  assert.equal(read().projects['acme-app'], 'gates');
  assert.equal(cli(['landing', main, 'clear']).status, 0);
  assert.equal(read().projects[key], 'push', 'a tier left: back to the plain string');
  assert.equal(cli(['unset', main]).status, 0);
  assert.equal(cli(['landing', 'acme-app', 'direct']).status, 0);
  assert.deepEqual(read().projects['acme-app'], { tier: 'gates', landing: 'direct' });
  assert.equal(cli(['landing', 'acme-app', 'clear']).status, 0);
  assert.equal(read().projects['acme-app'], 'gates');
  // an entry with only a landing mode: clearing it leaves nothing, so the entry goes
  assert.equal(cli(['landing', main, 'pr']).status, 0);
  assert.equal(cli(['landing', main, 'clear']).status, 0);
  assert.deepEqual(Object.keys(read().projects), ['acme-app'], 'the emptied entry is removed');
  assert.match(cli(['show', main]).stdout, /^landing_source: none /m);
}));

test('a 0.31.50 file (tier strings, {tier, landing} objects, tier-less landing objects) reads the same', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main }) => {
  writeFileSync(tiersPath(), JSON.stringify({ default: 'push', projects: { 'acme-app': { tier: 'gates', landing: 'pr' } } }));
  const d = tierDetail(main);
  assert.deepEqual([d.tier, d.source, d.landing, d.landingSource], ['gates', 'assigned', 'pr', 'assigned']);
  writeFileSync(tiersPath(), JSON.stringify({ default: 'push', projects: { 'acme-app': { landing: 'direct' } } }));
  const e = tierDetail(main);
  assert.deepEqual([e.tier, e.source, e.landing], ['push', 'default', 'direct']);
}));

// ---- 0.31.51: the project from the brief ----

test('floor --repo: runs in the named repo (or a worktree of it) from a folder that is not a repo; a bad path prints "floor unknown"', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main, wt, dir }) => {
  const base = git(main, 'rev-parse', 'HEAD');
  mkdirSync(join(main, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(main, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'ci');
  const ci = git(main, 'rev-parse', 'HEAD');
  const elsewhere = join(dir, 'ws'); // the session folder: not a repo
  mkdirSync(elsewhere, { recursive: true });
  assert.match(cli(['floor', `${base}..${ci}`], { cwd: elsewhere }).stdout, /^floor unknown: /, 'without --repo the current folder decides');
  for (const repo of [main, wt, join(main, '.github')]) {
    const r = cli(['floor', `${base}..${ci}`, '--repo', repo], { cwd: elsewhere });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^floor: high$/m, repo);
  }
  const first = cli(['floor', '--repo', main, `${base}..${ci}`], { cwd: elsewhere });
  assert.match(first.stdout, /^floor: high$/m, 'the option may come before the range');
  for (const bad of [join(dir, 'nope'), '', join(main, 'README.md')]) {
    const r = cli(['floor', `${base}..${ci}`, '--repo', bad], { cwd: elsewhere });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^floor unknown: /, JSON.stringify(bad));
  }
}));

test('show --brief-file: a folder that is not in a repo reports the project the brief names, with project_source', { skip: !GIT_OK }, () => withRepoAndWorktree(({ main, wt, dir }) => {
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  const brief = join(dir, 'brief.txt');
  writeFileSync(brief, `Do the work in ${norm(wt)} please.\n`);
  assert.equal(cli(['set', 'acme-app', 'gates']).status, 0);
  let r = cli(['show', ws, '--brief-file', brief]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^project: acme-app$/m);
  assert.match(r.stdout, /^project_source: brief /m);
  assert.match(r.stdout, /^project_tier: gates \(Full gates\)$/m);
  assert.match(r.stdout, /^source: assigned by name "acme-app"$/m);
  assert.ok(r.stdout.includes(`repo: ${norm(main)}`), r.stdout);
  // without the brief the same folder is unresolved; a folder inside the repo says cwd
  r = cli(['show', ws]);
  assert.match(r.stdout, /^project: \(none: not inside a repo\)$/m);
  assert.match(r.stdout, /^project_source: none /m);
  assert.match(cli(['show', main]).stdout, /^project_source: cwd /m);
  // a brief that names nothing, or two repos, stays unresolved; a missing file is an error
  writeFileSync(brief, 'no paths here');
  assert.match(cli(['show', ws, '--brief-file', brief]).stdout, /^project_source: none /m);
  r = cli(['show', ws, '--brief-file', join(dir, 'missing.txt')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--brief-file needs a readable file/);
}));
