// Regression: memory-vault.mjs must never write to a repository other than
// its own vault, whatever the caller's environment says.
//
// The incident: a sync run with an inherited absolute GIT_DIR (as git exports
// to hooks and to anything they start) made `git init <vault>` re-initialise
// THAT repository — core.bare = true on Windows — and `git -C <vault> config
// user.*` stamp the vault's identity into its shared .git/config. Every
// command in its main checkout then failed with "this operation must be run
// in a work tree". With a forward-slash GIT_DIR the vault's content was
// committed into that repository's history instead.
//
// Every repository here is a throwaway under the fixture temp dir, the state
// root and corpus are fixture paths, and GIT_* is only ever set on the CHILD
// process — never on this test process.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runScript, assertNotRealHome } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';
const VAULT_NAME = 'agent-companion memory-vault';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

// A throwaway project repo with one commit and a linked worktree — the shape
// the incident broke.
function makeProject(root) {
  const repo = join(root, 'project');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main', repo]);
  git(['-C', repo, 'config', 'user.name', 'fixture']);
  git(['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['-C', repo, 'add', '-A']);
  git(['-C', repo, 'commit', '-q', '-m', 'seed']);
  const wt = join(root, 'project-wt');
  git(['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'side']);
  return { repo, wt };
}

function makeCorpus(root) {
  const mem = join(root, 'corpus', 'proj-a', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), '# index\n');
  return join(root, 'corpus');
}

// Everything about the project repo that the incident changed, captured so
// "after" can be compared byte for byte.
function snapshot(repo) {
  return {
    config: readFileSync(join(repo, '.git', 'config')),
    head: git(['-C', repo, 'rev-parse', 'HEAD']),
    refs: git(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)']),
    status: git(['-C', repo, 'status', '--porcelain']),
  };
}

function assertProjectUntouched(repo, wt, before, label) {
  const after = readFileSync(join(repo, '.git', 'config'));
  assert.ok(after.equals(before.config),
    `${label}: project .git/config changed:\n${after.toString()}`);
  assert.doesNotMatch(after.toString(), /memory-vault/, `${label}: vault identity leaked into the project config`);
  assert.equal(git(['-C', repo, 'rev-parse', 'HEAD']), before.head, `${label}: project HEAD moved`);
  assert.equal(git(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)']), before.refs, `${label}: project refs changed`);
  // Both checkouts still work — the incident's visible symptom.
  assert.equal(git(['-C', repo, 'status', '--porcelain']), before.status, `${label}: main checkout status changed`);
  git(['-C', wt, 'status', '--porcelain']);
}

const LEAKED_ENVS = [
  ['absolute GIT_DIR (native separators)', (repo) => ({ GIT_DIR: join(repo, '.git') })],
  ['absolute GIT_DIR (forward slashes)', (repo) => ({ GIT_DIR: join(repo, '.git').replace(/\\/g, '/') })],
  ['GIT_DIR + GIT_WORK_TREE', (repo) => ({ GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo })],
  ['linked-worktree GIT_DIR + GIT_INDEX_FILE', (repo) => ({
    GIT_DIR: join(repo, '.git', 'worktrees', 'project-wt'),
    GIT_INDEX_FILE: join(repo, '.git', 'worktrees', 'project-wt', 'index'),
  })],
  ['GIT_COMMON_DIR + GIT_OBJECT_DIRECTORY', (repo) => ({
    GIT_DIR: join(repo, '.git'), GIT_COMMON_DIR: join(repo, '.git'), GIT_OBJECT_DIRECTORY: join(repo, '.git', 'objects'),
  })],
];

for (const [label, leak] of LEAKED_ENVS) {
  test(`sync with an inherited ${label} leaves the project repository byte-identical`, () => {
    const fx = makeFixture();
    try {
      const { repo, wt } = makeProject(fx.dir);
      const corpus = makeCorpus(fx.dir);
      const leaked = leak(repo);
      for (const v of Object.values(leaked)) assertNotRealHome(v, label);
      const before = snapshot(repo);

      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: repo,
        env: {
          AGENT_COMPANION_MEMORY_ROOT: corpus,
          CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
          ...leaked,
        },
        timeout: 60000,
      });

      assertProjectUntouched(repo, wt, before, label);
      assert.equal(res.status, 0, `sync exited ${res.status}: ${res.stderr}`);
      assert.equal(res.json?.committed, true, `sync should commit into the vault: ${res.stdout}`);

      // The vault got the commit and the identity, in its OWN repository.
      const vault = join(fx.stateDir, 'memory-vault');
      const vaultConfig = readFileSync(join(vault, '.git', 'config'), 'utf8');
      assert.match(vaultConfig, new RegExp(`name = ${VAULT_NAME}`));
      assert.doesNotMatch(vaultConfig, /bare = true/);
      assert.equal(git(['-C', vault, 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index');
    } finally {
      fx.cleanup();
    }
  });
}

// --- ensureInit refuses a location inside another repository --------------

function refusalCase(label, stateDirFor, kindRe) {
  test(`init refuses, writing nothing, when the vault would sit ${label}`, () => {
    const fx = makeFixture();
    try {
      const { repo, wt } = makeProject(fx.dir);
      const corpus = makeCorpus(fx.dir);
      const stateDir = stateDirFor(repo, fx.dir);
      const before = snapshot(repo);
      const gitDirListing = readdirSync(join(repo, '.git')).sort();

      const res = runScript(SCRIPT, ['init', '--json'], {
        cwd: fx.dir,
        env: {
          AGENT_COMPANION_STATE_DIR: stateDir,
          AGENT_COMPANION_MEMORY_ROOT: corpus,
          CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
        },
      });

      assert.notEqual(res.status, 0, 'init must refuse');
      assert.match(res.stderr, /refusing to initialize — .* is inside an existing git repository/);
      assert.match(res.stderr, kindRe);
      assert.ok(!existsSync(stateDir), `nothing may be created at ${stateDir}`);
      assert.deepEqual(readdirSync(join(repo, '.git')).sort(), gitDirListing, '.git gained or lost entries');
      assertProjectUntouched(repo, wt, before, label);
    } finally {
      fx.cleanup();
    }
  });
}

refusalCase('inside a project work tree', (repo) => join(repo, 'nested', 'state'), /its work tree at /);
refusalCase('inside a project .git dir', (repo) => join(repo, '.git', 'agent-companion'), /its git dir at /);
refusalCase('inside a linked worktree', (repo, root) => join(root, 'project-wt', 'state'), /its work tree at /);

test('init refuses a location inside a bare repository', () => {
  const fx = makeFixture();
  try {
    const bare = join(fx.dir, 'origin.git');
    git(['init', '-q', '--bare', bare]);
    const configBefore = readFileSync(join(bare, 'config'));
    const stateDir = join(bare, 'state');
    const res = runScript(SCRIPT, ['init', '--json'], {
      cwd: fx.dir,
      env: { AGENT_COMPANION_STATE_DIR: stateDir, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /inside an existing git repository \(its git dir at /);
    assert.ok(!existsSync(stateDir));
    assert.ok(readFileSync(join(bare, 'config')).equals(configBefore));
  } finally {
    fx.cleanup();
  }
});

test('a marker-bearing vault whose .git is gone is refused, not written through to the enclosing repo', () => {
  const fx = makeFixture();
  try {
    const { repo, wt } = makeProject(fx.dir);
    const corpus = makeCorpus(fx.dir);
    // A vault directory INSIDE the project's work tree carrying the marker
    // but no .git of its own: any git call that discovers from here lands in
    // the project repository.
    const stateDir = join(repo, 'nested', 'state');
    const vault = join(stateDir, 'memory-vault');
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, '.memory-vault.json'), JSON.stringify({ kind: 'agent-companion-memory-vault', schema: 1 }));
    const before = { ...snapshot(repo), status: git(['-C', repo, 'status', '--porcelain']) };

    const res = runScript(SCRIPT, ['init', '--json'], {
      cwd: repo,
      env: {
        AGENT_COMPANION_STATE_DIR: stateDir,
        AGENT_COMPANION_MEMORY_ROOT: corpus,
        CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      },
    });

    assert.notEqual(res.status, 0, 'init must refuse');
    assert.match(res.stderr, /refusing to write — git resolves .* not to the vault's own/);
    assert.ok(!existsSync(join(vault, '.gitattributes')), 'no backfill may be written');
    assertProjectUntouched(repo, wt, before, 'marker without .git');
  } finally {
    fx.cleanup();
  }
});

test('an existing vault keeps working when its path is inside a repository (it created itself)', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    const first = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(first.status, 0, first.stderr);
    // Turn the fixture home into a repository AFTER the vault exists — the
    // shape of an operator who later versions their whole config dir.
    git(['init', '-q', '-b', 'main', fx.dir]);
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const second = runScript(SCRIPT, ['sync', '--json'], { env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json?.committed, true);
    assert.equal(git(['-C', join(fx.stateDir, 'memory-vault'), 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index v2');
  } finally {
    fx.cleanup();
  }
});
