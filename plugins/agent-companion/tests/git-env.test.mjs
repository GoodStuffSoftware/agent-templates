// scripts/lib/git-env.mjs — the env hygiene every writing git child process
// in this plugin goes through. Every repository here is a throwaway under a
// fixture temp dir; no test sets GIT_* in this process's own environment
// (each passes it per call), so nothing can leak into a sibling test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture } from './helpers.mjs';
import {
  REPO_LOCATING_GIT_VARS, isRepoLocatingGitVar, cleanGitEnv, gitClean, enclosingGitRepo, samePath,
  isolatedGitEnv, isConfigInjectionGitVar, isIdentityGitVar, hermeticGitEnv, isHermeticGitVar, NULL_DEVICE, HERMETIC_GIT_ENV,
  REDIRECTING_GIT_VARS, isRedirectingGitVar,
} from '../scripts/lib/git-env.mjs';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

function makeRepo(root, name = 'repo') {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main', repo]);
  git(['-C', repo, 'config', 'user.name', 'fixture']);
  git(['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['-C', repo, 'add', '-A']);
  git(['-C', repo, 'commit', '-q', '-m', 'seed']);
  return repo;
}

test('the strip list covers every variable that relocates a git repository', () => {
  for (const name of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE',
    'GIT_CONFIG',
  ]) {
    assert.ok(REPO_LOCATING_GIT_VARS.includes(name), `${name} must be stripped`);
    assert.equal(isRepoLocatingGitVar(name), true);
  }
});

test('cleanGitEnv strips repo-locating vars in any case and keeps everything else', () => {
  const input = {
    PATH: '/bin',
    GIT_DIR: '/elsewhere/.git',
    Git_Work_Tree: '/elsewhere',          // Windows env names are case-insensitive
    git_index_file: '/elsewhere/.git/index',
    GIT_OBJECT_DIRECTORY: 'x',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: 'x',
    GIT_COMMON_DIR: 'x',
    GIT_CEILING_DIRECTORIES: 'x',
    GIT_NAMESPACE: 'x',
    GIT_CONFIG: '/elsewhere/config',
    // Deliberately kept: callers rely on these.
    GIT_AUTHOR_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'c@example.invalid',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.x.insteadOf',
    GIT_CONFIG_VALUE_0: 'y',
    GIT_CONFIG_GLOBAL: '/tmp/gc',
    GIT_SSH_COMMAND: 'ssh',
  };
  const snapshot = { ...input };
  const out = cleanGitEnv(input);
  assert.deepEqual(input, snapshot, 'the input object must not be mutated');
  assert.deepEqual(Object.keys(out).sort(), [
    'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'PATH',
  ]);
});

test('cleanGitEnv applies overrides but never lets one reintroduce a repo-locating var', () => {
  const out = cleanGitEnv({ PATH: '/bin', KEEP: '1', DROP: '1' }, {
    EXTRA: 'e', DROP: undefined, GIT_DIR: '/smuggled/.git', git_work_tree: '/smuggled',
  });
  assert.deepEqual(out, { PATH: '/bin', KEEP: '1', EXTRA: 'e' });
});

test('isolatedGitEnv also drops inherited config injection, in any case, and keeps the rest', () => {
  const out = isolatedGitEnv({
    PATH: '/bin',
    GIT_DIR: '/elsewhere/.git',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/elsewhere/hooks'",
    Git_Config_Count: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    git_config_value_0: '/elsewhere/hooks',
    GIT_CONFIG_KEY_1: 'include.path',
    GIT_CONFIG_VALUE_1: '/elsewhere/inc',
    GIT_TEMPLATE_DIR: '/elsewhere/.git',
    GIT_AUTHOR_NAME: 'a',
    GIT_CONFIG_GLOBAL: '/tmp/gc',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  assert.deepEqual(Object.keys(out).sort(), ['GIT_AUTHOR_NAME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH']);
  for (const k of ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_7', 'GIT_CONFIG_VALUE_12', 'GIT_TEMPLATE_DIR']) {
    assert.equal(isConfigInjectionGitVar(k), true, k);
  }
  assert.equal(isConfigInjectionGitVar('GIT_CONFIG_GLOBAL'), false);
  // gitClean() is unchanged: the canary still gets its injected config.
  assert.equal(cleanGitEnv({ GIT_CONFIG_COUNT: '1' }).GIT_CONFIG_COUNT, '1');
});

test('isIdentityGitVar names exactly the author/committer name, email and date vars, in any case', () => {
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'git_author_date', 'Git_Committer_Email']) {
    assert.equal(isIdentityGitVar(k), true, k);
  }
  for (const k of ['GIT_AUTHOR', 'GIT_AUTHOR_NAMEX', 'GIT_DIR', 'GIT_CONFIG_GLOBAL', 'EMAIL', 'GIT_SSH_COMMAND']) {
    assert.equal(isIdentityGitVar(k), false, k);
  }
  // The shared helpers still pass identity through; only the vault strips it.
  assert.equal(isolatedGitEnv({ GIT_AUTHOR_DATE: 'x' }).GIT_AUTHOR_DATE, 'x');
});

// 0.29.2: git finds global and system config through GIT_CONFIG_GLOBAL,
// GIT_CONFIG_SYSTEM, HOME and XDG_CONFIG_HOME, so any of them could inject a
// setting into a vault call. hermeticGitEnv() pins all of them.
test('hermeticGitEnv pins every config-file route to the null device, in any case; isolatedGitEnv still keeps them', () => {
  const input = {
    PATH: '/bin',
    GIT_DIR: '/elsewhere/.git',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/elsewhere/hooks'",
    GIT_CONFIG_GLOBAL: '/hostile/global',
    git_config_system: '/hostile/system',
    GIT_CONFIG_NOSYSTEM: '0',
    Home: '/hostile/home',
    xdg_config_home: '/hostile/xdg',
    GIT_AUTHOR_NAME: 'a',
    GIT_SSH_COMMAND: 'ssh',
  };
  const snapshot = { ...input };
  const out = hermeticGitEnv(input);
  assert.deepEqual(input, snapshot, 'the input object must not be mutated');
  assert.deepEqual(Object.keys(out).sort(), [
    'GIT_ATTR_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM',
    'GIT_SSH_COMMAND', 'HOME', 'PATH', 'XDG_CONFIG_HOME',
  ]);
  assert.deepEqual({
    GIT_CONFIG_GLOBAL: out.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: out.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_NOSYSTEM: out.GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM: out.GIT_ATTR_NOSYSTEM,
    HOME: out.HOME, XDG_CONFIG_HOME: out.XDG_CONFIG_HOME,
  }, HERMETIC_GIT_ENV);
  assert.equal(NULL_DEVICE, process.platform === 'win32' ? 'NUL' : '/dev/null');
  for (const k of ['GIT_CONFIG_GLOBAL', 'git_config_system', 'GIT_CONFIG_NOSYSTEM', 'Git_Attr_NoSystem', 'home', 'XDG_CONFIG_HOME']) {
    assert.equal(isHermeticGitVar(k), true, k);
  }
  for (const k of ['GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBALX', 'HOMEDRIVE', 'USERPROFILE', 'XDG_DATA_HOME']) {
    assert.equal(isHermeticGitVar(k), false, k);
  }
  // Other callers are unchanged.
  const other = isolatedGitEnv(input);
  assert.equal(other.GIT_CONFIG_GLOBAL, '/hostile/global');
  assert.equal(other.git_config_system, '/hostile/system');
  assert.equal(other.Home, '/hostile/home');
});

// 0.29.2 round 3: GIT_ATTR_SOURCE makes git read .gitattributes from another
// tree, and Git for Windows' GIT_REDIRECT_STDIN/STDOUT/STDERR send a stream
// to a named file. 0.29.7: GIT_EXEC_PATH names the directory git runs its
// own programs from, and Git for Windows' GIT_ASK_YESNO a program git asks
// whether to retry. hermeticGitEnv() removes them, in any case, and sets
// nothing in their place.
test('hermeticGitEnv removes GIT_ATTR_SOURCE, GIT_REDIRECT_*, GIT_EXEC_PATH and GIT_ASK_YESNO, in any case; isolatedGitEnv still keeps them', () => {
  const input = {
    PATH: '/bin',
    GIT_ATTR_SOURCE: 'hostile-tree',
    git_redirect_stdout: '/elsewhere/out',
    Git_Redirect_Stderr: '2>&1',
    GIT_REDIRECT_STDIN: '/elsewhere/in',
    GIT_ATTR_NOSYSTEM: '0',
    GIT_EXEC_PATH: '/elsewhere/libexec/git-core',
    git_ask_yesno: '/elsewhere/ask',
    Git_Exec_Path: '/elsewhere/other-libexec',
  };
  const snapshot = { ...input };
  const out = hermeticGitEnv(input);
  assert.deepEqual(input, snapshot, 'the input object must not be mutated');
  assert.deepEqual(Object.keys(out).filter((k) => /^git_(attr|redirect|exec|ask)_/i.test(k)), ['GIT_ATTR_NOSYSTEM']);
  assert.equal(out.GIT_ATTR_NOSYSTEM, '1', 'GIT_ATTR_NOSYSTEM is pinned, not passed through');
  assert.deepEqual([...REDIRECTING_GIT_VARS].sort(),
    ['GIT_ASK_YESNO', 'GIT_ATTR_SOURCE', 'GIT_EXEC_PATH', 'GIT_REDIRECT_STDERR', 'GIT_REDIRECT_STDIN', 'GIT_REDIRECT_STDOUT']);
  for (const k of ['GIT_ATTR_SOURCE', 'git_attr_source', 'GIT_REDIRECT_STDOUT', 'Git_Redirect_Stdin',
    'GIT_EXEC_PATH', 'git_exec_path', 'GIT_ASK_YESNO', 'Git_Ask_YesNo']) {
    assert.equal(isRedirectingGitVar(k), true, k);
  }
  for (const k of ['GIT_ATTR_NOSYSTEM', 'GIT_ATTR', 'GIT_REDIRECT', 'GIT_EXEC', 'GIT_ASKPASS', 'GIT_EXEC_PATHS']) {
    assert.equal(isRedirectingGitVar(k), false, k);
  }
  const other = isolatedGitEnv(input);
  assert.equal(other.GIT_ATTR_SOURCE, input.GIT_ATTR_SOURCE, 'other callers are unchanged');
  assert.equal(other.git_redirect_stdout, '/elsewhere/out');
  assert.equal(other.GIT_EXEC_PATH, input.GIT_EXEC_PATH);
  assert.equal(other.git_ask_yesno, input.git_ask_yesno);
});

test('git under hermeticGitEnv reads no global config, whether named by GIT_CONFIG_GLOBAL, HOME or XDG_CONFIG_HOME', () => {
  const fx = makeFixture();
  try {
    const repo = join(fx.dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', repo]);
    const cfg = '[user]\n\tname = FROM-OUTSIDE\n';
    const file = join(fx.dir, 'g.gitconfig');
    writeFileSync(file, cfg);
    const home = join(fx.dir, 'home');
    mkdirSync(join(home, 'git'), { recursive: true });
    writeFileSync(join(home, '.gitconfig'), cfg);
    writeFileSync(join(home, 'git', 'config'), cfg);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_SYSTEM: file, HOME: home, XDG_CONFIG_HOME: home };
    const plain = spawnSync('git', ['-C', repo, 'config', '--get', 'user.name'], { encoding: 'utf8', windowsHide: true, env: isolatedGitEnv(env) });
    assert.equal(plain.stdout.trim(), 'FROM-OUTSIDE', 'control: without the hermetic env the setting is read');
    for (const route of [{ GIT_CONFIG_GLOBAL: file }, { GIT_CONFIG_SYSTEM: file }, { HOME: home }, { XDG_CONFIG_HOME: home }]) {
      const r = spawnSync('git', ['-C', repo, 'config', '--show-origin', '--list'],
        { encoding: 'utf8', windowsHide: true, env: hermeticGitEnv({ ...process.env, ...route }) });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /FROM-OUTSIDE/, JSON.stringify(Object.keys(route)));
      assert.doesNotMatch(r.stdout, /^file:(?!\.git\/config)/m, 'only the repository\'s own config is read');
    }
  } finally {
    fx.cleanup();
  }
});

test('cleanGitEnv defaults to process.env and returns a copy', () => {
  const out = cleanGitEnv();
  assert.notEqual(out, process.env);
  assert.equal(out.PATH ?? out.Path, process.env.PATH ?? process.env.Path);
});

test('gitClean ignores a GIT_DIR passed in its env and acts on the -C directory', () => {
  const fx = makeFixture();
  try {
    const victim = makeRepo(fx.dir, 'victim');
    const other = makeRepo(fx.dir, 'other');
    const env = { ...process.env, GIT_DIR: join(victim, '.git'), GIT_WORK_TREE: victim };
    // Sanity: without cleaning, git really does follow GIT_DIR.
    const raw = spawnSync('git', ['-C', other, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8', windowsHide: true, env,
    });
    assert.ok(samePath(raw.stdout.trim(), join(victim, '.git')), `uncleaned git should follow GIT_DIR (got ${raw.stdout})`);
    const cleaned = gitClean(['-C', other, 'rev-parse', '--absolute-git-dir'], { env }).trim();
    assert.ok(samePath(cleaned, join(other, '.git')), `gitClean must resolve the -C dir (got ${cleaned})`);
  } finally {
    fx.cleanup();
  }
});

test('enclosingGitRepo: null outside any repo, and finds work trees, git dirs, bare repos and linked worktrees', () => {
  const fx = makeFixture();
  try {
    const plain = join(fx.dir, 'plain', 'not', 'yet', 'created');
    assert.equal(enclosingGitRepo(plain), null, 'a fixture dir outside any repo must not be flagged');

    const repo = makeRepo(fx.dir);
    const inTree = enclosingGitRepo(join(repo, 'sub', 'state', 'memory-vault'));
    assert.equal(inTree?.kind, 'work-tree');
    assert.ok(samePath(inTree.root, repo));
    assert.equal(enclosingGitRepo(repo)?.kind, 'work-tree', 'the repo root itself counts');

    const inGitDir = enclosingGitRepo(join(repo, '.git', 'agent-companion', 'memory-vault'));
    assert.equal(inGitDir?.kind, 'git-dir');

    const bare = join(fx.dir, 'bare.git');
    git(['init', '-q', '--bare', bare]);
    const inBare = enclosingGitRepo(join(bare, 'memory-vault'));
    assert.equal(inBare?.kind, 'git-dir');
    assert.ok(samePath(inBare.root, bare));

    const wt = join(fx.dir, 'linked');
    git(['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'side']);
    const inWt = enclosingGitRepo(join(wt, 'x'));
    assert.equal(inWt?.kind, 'work-tree');
    assert.ok(samePath(inWt.root, wt));
  } finally {
    fx.cleanup();
  }
});
