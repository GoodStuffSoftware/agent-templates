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
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, symlinkSync, chmodSync,
  renameSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  makeFixture, runScript, assertNotRealHome, PLUGIN_ROOT,
} from './helpers.mjs';
import { cleanGitEnv, NULL_DEVICE } from '../scripts/lib/git-env.mjs';
import {
  vaultGitEnv, vaultSubcommand, parseScopedConfig, carriedConfigArgs, commitIdentityArgs,
} from '../scripts/memory-vault.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';
const VAULT_NAME = 'agent-companion memory-vault';

// No auto-maintenance/gc: a recent git detaches `maintenance run --auto`
// after a commit, and its transient objects/maintenance.lock (or a repack)
// raced hashTree() below on the Linux CI runner (ENOENT on lstat).
const NO_AUTO_MAINT = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

function git(args, cwd) {
  const r = spawnSync('git', [...NO_AUTO_MAINT, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
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

// Both entry points. sync used to write its lock, the state root's README
// and state/memory-vault-status.json BEFORE ensureInit() refused (V7), so its
// "Nothing was written" was untrue — inside the project's work tree.
function refusalCase(label, stateDirFor, kindRe) {
  for (const cmd of ['init', 'sync']) refusalCaseFor(cmd, label, stateDirFor, kindRe);
}

function refusalCaseFor(cmd, label, stateDirFor, kindRe) {
  test(`${cmd} refuses, writing nothing, when the vault would sit ${label}`, () => {
    const fx = makeFixture();
    try {
      const { repo, wt } = makeProject(fx.dir);
      const corpus = makeCorpus(fx.dir);
      const stateDir = stateDirFor(repo, fx.dir);
      const before = snapshot(repo);
      const gitDirListing = readdirSync(join(repo, '.git')).sort();
      const treeBefore = hashTree(join(repo, '.git'));

      const res = runScript(SCRIPT, [cmd, '--json'], {
        cwd: fx.dir,
        env: {
          AGENT_COMPANION_STATE_DIR: stateDir,
          AGENT_COMPANION_MEMORY_ROOT: corpus,
          CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
        },
      });

      assert.notEqual(res.status, 0, `${cmd} must refuse`);
      assert.match(res.stderr, /refusing to initialize — .* is inside an existing git repository/);
      assert.match(res.stderr, kindRe);
      assert.ok(!existsSync(stateDir), `nothing may be created at ${stateDir}`);
      assert.deepEqual(readdirSync(join(repo, '.git')).sort(), gitDirListing, '.git gained or lost entries');
      assert.deepEqual(hashTree(join(repo, '.git')), treeBefore, 'project .git must be byte-identical');
      assertProjectUntouched(repo, wt, before, label);
    } finally {
      fx.cleanup();
    }
  });
}

refusalCase('inside a project work tree', (repo) => join(repo, 'nested', 'state'), /its work tree at /);
refusalCase('inside a project .git dir', (repo) => join(repo, '.git', 'agent-companion'), /its git dir at /);
refusalCase('inside a linked worktree', (repo, root) => join(root, 'project-wt', 'state'), /its work tree at /);

for (const cmd of ['init', 'sync']) {
  test(`${cmd} refuses a location inside a bare repository`, () => {
    const fx = makeFixture();
    try {
      const bare = join(fx.dir, 'origin.git');
      git(['init', '-q', '--bare', bare]);
      const treeBefore = hashTree(bare);
      const stateDir = join(bare, 'state');
      const res = runScript(SCRIPT, [cmd, '--json'], {
        cwd: fx.dir,
        env: { AGENT_COMPANION_STATE_DIR: stateDir, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
      });
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /inside an existing git repository \(its git dir at /);
      assert.ok(!existsSync(stateDir));
      assert.deepEqual(hashTree(bare), treeBefore, 'the bare repository must be byte-identical');
    } finally {
      fx.cleanup();
    }
  });
}

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

// Every file under `dir`, path -> sha256, links recorded as links (never
// followed). "Byte-identical" for a whole .git, objects included.
function hashTree(dir, out = {}, base = dir) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { out[p.slice(base.length)] = 'LINK'; continue; }
    if (st.isDirectory()) { hashTree(p, out, base); continue; }
    out[p.slice(base.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}

const MARKER = JSON.stringify({ kind: 'agent-companion-memory-vault', schema: 1, createdAt: 'x' });

// V1. assertVaultGitDir used to realpath BOTH sides of its comparison, so a
// vault/.git that is a junction (or symlink) to a project's .git resolved to
// the same place on both sides and passed — and sync committed the corpus
// into the project. Junctions need no privilege on Windows; elsewhere the
// same shape is a directory symlink.
for (const cmd of ['init', 'sync']) {
  test(`${cmd} refuses a marker vault whose .git is a junction/symlink to a project's .git`, () => {
    const fx = makeFixture();
    try {
      const { repo, wt } = makeProject(fx.dir);
      const corpus = makeCorpus(fx.dir);
      const vault = join(fx.stateDir, 'memory-vault');
      mkdirSync(vault, { recursive: true });
      writeFileSync(join(vault, '.memory-vault.json'), MARKER);
      symlinkSync(join(repo, '.git'), join(vault, '.git'), 'junction');
      const before = snapshot(repo);
      const treeBefore = hashTree(join(repo, '.git'));

      const res = runScript(SCRIPT, [cmd, '--json'], {
        cwd: fx.dir,
        env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
        timeout: 60000,
      });

      assert.deepEqual(hashTree(join(repo, '.git')), treeBefore, 'project .git must be byte-identical');
      assertProjectUntouched(repo, wt, before, `${cmd} via .git junction`);
      assert.notEqual(res.status, 0, `${cmd} must refuse: ${res.stdout}`);
      assert.match(res.stderr, /is not a real directory of the vault's own/);
      assert.ok(!existsSync(join(vault, '.gitattributes')), 'no backfill may be written');
      assert.deepEqual(readdirSync(fx.stateDir), ['memory-vault'], 'no lock, status file or README may be written');
    } finally {
      fx.cleanup();
    }
  });
}

// V6. A marker dropped into a real repository used to be honoured: sync
// backfilled .gitattributes and committed the corpus into it. The marker is
// honoured only when the vault's own config carries the vault identity AND
// its history is rooted in the initialize commit.
for (const [label, setup] of [
  ['a real repository with its own identity and history', (v) => {
    git(['-C', v, 'config', 'user.name', 'owner']);
    git(['-C', v, 'config', 'user.email', 'owner@example.invalid']);
  }],
  ['a real repository that copied the vault identity but not its history', (v) => {
    git(['-C', v, 'config', 'user.name', VAULT_NAME]);
    git(['-C', v, 'config', 'user.email', 'memory-vault@agent-companion.local']);
  }],
]) {
  test(`sync refuses a planted marker in ${label}`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const vault = join(fx.stateDir, 'memory-vault');
      mkdirSync(vault, { recursive: true });
      git(['init', '-q', '-b', 'main', vault]);
      setup(vault);
      writeFileSync(join(vault, 'code.txt'), 'owner work\n');
      writeFileSync(join(vault, '.memory-vault.json'), MARKER);
      git(['-C', vault, 'add', 'code.txt']);
      git(['-C', vault, 'commit', '-q', '-m', 'owner work']);
      const treeBefore = hashTree(join(vault, '.git'));

      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir,
        env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
        timeout: 60000,
      });

      assert.notEqual(res.status, 0, `sync must refuse: ${res.stdout}`);
      assert.match(res.stderr, /carries a memory-vault marker but is not a vault this plugin created/);
      assert.deepEqual(hashTree(join(vault, '.git')), treeBefore, "the repository's .git must be byte-identical");
      assert.ok(!existsSync(join(vault, '.gitattributes')), 'no backfill may be written');
      assert.ok(!existsSync(join(vault, 'projects')), 'no corpus may be copied in');
      assert.deepEqual(readdirSync(fx.stateDir), ['memory-vault'], 'no lock, status file or README may be written');
    } finally {
      fx.cleanup();
    }
  });
}

// status is read-only: it used to resolve the status file through stateDir(),
// which creates the state root, its README.txt and state/ as a side effect.
test('status creates nothing, even where init and sync would refuse', () => {
  const fx = makeFixture();
  try {
    const { repo } = makeProject(fx.dir);
    const stateDir = join(repo, 'nested', 'state');
    const res = runScript(SCRIPT, ['status', '--json'], {
      cwd: fx.dir,
      env: { AGENT_COMPANION_STATE_DIR: stateDir, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.initialized, false);
    assert.ok(!existsSync(join(repo, 'nested')), 'status wrote into the project work tree');
  } finally {
    fx.cleanup();
  }
});

// V8. The refusal used to recommend AGENT_COMPANION_STATE_DIR, which moves
// ALL agent-companion state (config, toggles, standing rules), not just the
// vault. AGENT_COMPANION_VAULT_DIR moves the vault alone.
test('the inside-a-repository refusal recommends AGENT_COMPANION_VAULT_DIR and warns what STATE_DIR moves', () => {
  const fx = makeFixture();
  try {
    const { repo } = makeProject(fx.dir);
    const res = runScript(SCRIPT, ['init', '--json'], {
      cwd: fx.dir,
      env: { AGENT_COMPANION_STATE_DIR: join(repo, 'nested', 'state'), CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Relocate the vault alone by setting AGENT_COMPANION_VAULT_DIR to an absolute path/);
    assert.match(res.stderr, /AGENT_COMPANION_STATE_DIR would move the vault too, but it moves ALL agent-companion state/);
  } finally {
    fx.cleanup();
  }
});

test('AGENT_COMPANION_VAULT_DIR moves the vault alone: a state root inside a repository no longer blocks it', () => {
  const fx = makeFixture();
  try {
    const { repo, wt } = makeProject(fx.dir);
    const corpus = makeCorpus(fx.dir);
    const stateDir = join(repo, 'nested', 'state');
    const vault = join(fx.dir, 'elsewhere', 'my-vault');
    const before = snapshot(repo);
    const treeBefore = hashTree(join(repo, '.git'));

    const res = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir,
      env: {
        AGENT_COMPANION_STATE_DIR: stateDir,
        AGENT_COMPANION_VAULT_DIR: vault,
        AGENT_COMPANION_MEMORY_ROOT: corpus,
        CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      },
      timeout: 60000,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
    assert.equal(git(['-C', vault, 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index');
    assert.ok(!existsSync(join(stateDir, 'memory-vault')), 'the vault must not be created under the state root');
    assert.deepEqual(hashTree(join(repo, '.git')), treeBefore, 'project .git must be byte-identical');
    assert.equal(git(['-C', repo, 'rev-parse', 'HEAD']), before.head);
    git(['-C', wt, 'status', '--porcelain']);
  } finally {
    fx.cleanup();
  }
});

test('a relative AGENT_COMPANION_VAULT_DIR is refused with nothing written', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const res = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir,
      env: {
        AGENT_COMPANION_VAULT_DIR: join('relative', 'vault'),
        AGENT_COMPANION_MEMORY_ROOT: corpus,
        CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /AGENT_COMPANION_VAULT_DIR is ".*", a relative path/);
    assert.ok(!existsSync(join(fx.dir, 'relative')), 'no vault may be created relative to the cwd');
    assert.ok(!existsSync(fx.stateDir), 'no lock or status file may be written');
  } finally {
    fx.cleanup();
  }
});

// V5. gitClean() keeps per-process config injection (the leak-sweep canary
// needs it), so an inherited GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT reached
// vault commits: a parent's core.hooksPath ran the parent's hooks inside the
// vault and an include.path rewrote the vault's author. (A hooksPath from the
// operator's global config ran them too: see S2 and G3 below, which reach
// git through every config-file route.)
function makeHooks(root) {
  const hooks = join(root, 'parent-hooks');
  mkdirSync(hooks, { recursive: true });
  const flag = join(root, 'HOOK_RAN');
  for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\necho ${h} >> "${flag.replace(/\\/g, '/')}"\nexit 0\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const include = join(root, 'include.cfg');
  writeFileSync(include, '[user]\n\tname = INCLUDED-IDENT\n\temail = included@example.invalid\n');
  return { hooks: hooks.replace(/\\/g, '/'), flag, include: include.replace(/\\/g, '/') };
}

const INJECTED_ENVS = [
  ['GIT_CONFIG_PARAMETERS core.hooksPath', (h) => ({ GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${h.hooks}'` })],
  ['GIT_CONFIG_PARAMETERS include.path', (h) => ({ GIT_CONFIG_PARAMETERS: `'include.path'='${h.include}'` })],
  ['GIT_CONFIG_COUNT core.hooksPath', (h) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: h.hooks })],
];

for (const [label, inject] of INJECTED_ENVS) {
  test(`vault commits ignore an inherited ${label}: no hook runs, the author is the vault's`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const h = makeHooks(fx.dir);
      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir,
        env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', ...inject(h) },
        timeout: 60000,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json?.committed, true, res.stdout);
      assert.ok(!existsSync(h.flag), `a hook ran on a vault commit: ${existsSync(h.flag) ? readFileSync(h.flag, 'utf8') : ''}`);
      const authors = git(['-C', join(fx.stateDir, 'memory-vault'), 'log', '--format=%an <%ae>']).split('\n');
      assert.equal(authors.length, 2, 'init + sync commits');
      for (const a of authors) assert.equal(a, `${VAULT_NAME} <memory-vault@agent-companion.local>`);
    } finally {
      fx.cleanup();
    }
  });
}

// G4. isolatedGitEnv() passes GIT_AUTHOR_* / GIT_COMMITTER_* through (other
// callers set them on purpose), so an inherited name, email or date overrode
// the vault's identity and the real commit time. Windows env names are
// case-insensitive, so a lower-case spelling is covered too.
for (const [label, identityEnv] of [
  ['upper-case', {
    GIT_AUTHOR_NAME: 'Inherited Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_AUTHOR_DATE: '2001-02-03T04:05:06Z',
    GIT_COMMITTER_NAME: 'Inherited Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid', GIT_COMMITTER_DATE: '2001-02-03T04:05:06Z',
  }],
  ...(process.platform === 'win32' ? [['lower-case (Windows)', {
    git_author_name: 'Inherited Author', git_author_date: '2001-02-03T04:05:06Z', git_committer_email: 'committer@example.invalid',
  }]] : []),
]) {
  test(`G4: vault commits ignore inherited ${label} GIT_AUTHOR_*/GIT_COMMITTER_* identity and dates`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir,
        env: { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', ...identityEnv },
        timeout: 60000,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json?.committed, true, res.stdout);
      const lines = git(['-C', join(fx.stateDir, 'memory-vault'), 'log', '--format=%an <%ae>|%cn <%ce>|%aI|%cI']).split('\n');
      assert.equal(lines.length, 2, 'init + sync commits');
      const year = String(new Date().getUTCFullYear());
      for (const l of lines) {
        const [author, committer, ad, cd] = l.split('|');
        assert.equal(author, `${VAULT_NAME} <memory-vault@agent-companion.local>`, l);
        assert.equal(committer, `${VAULT_NAME} <memory-vault@agent-companion.local>`, l);
        assert.ok(!ad.startsWith('2001') && !cd.startsWith('2001'), `an inherited date leaked: ${l}`);
        assert.ok(Math.abs(Date.parse(cd) - Date.now()) < 3600000 || cd.startsWith(year), `commit date is not now: ${l}`);
      }
    } finally {
      fx.cleanup();
    }
  });
}

// G5. status() ran `git status` with no guards and without
// --no-optional-locks. `git status` refreshes the index and writes it back,
// so with a vault .git that was a junction to a project's .git, status
// rewrote the PROJECT's index.
test('G5: status on a vault whose .git is a junction to a project refuses and leaves the project .git byte-identical', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    const first = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(first.status, 0, first.stderr);
    const vault = join(fx.stateDir, 'memory-vault');
    const { repo, wt } = makeProject(fx.dir);
    // The project tracks a file byte-identical to one in the vault's work
    // tree, so an index refresh through the junction has a stat change it
    // would write back.
    writeFileSync(join(repo, 'README.md'), readFileSync(join(vault, 'README.md')));
    git(['-C', repo, 'add', '-A']);
    git(['-C', repo, 'commit', '-q', '-m', 'readme']);
    renameSync(join(vault, '.git'), join(vault, '.git-orig'));
    symlinkSync(join(repo, '.git'), join(vault, '.git'), 'junction');
    const before = snapshot(repo);
    // An index older than its entries makes every entry racily clean, so
    // any `git status` that reaches this index re-checks and rewrites it. That
    // makes the unguarded write deterministic instead of timing-dependent.
    const past = new Date('2001-01-01T00:00:00Z');
    utimesSync(join(repo, '.git', 'index'), past, past);
    const treeBefore = hashTree(join(repo, '.git'));

    for (const args of [['status', '--json'], ['status']]) {
      const res = runScript(SCRIPT, args, { cwd: fx.dir, env, timeout: 60000 });
      assert.deepEqual(hashTree(join(repo, '.git')), treeBefore, `project .git changed under \`${args.join(' ')}\``);
      assert.notEqual(res.status, 0, `status must refuse: ${res.stdout}`);
      assert.match(res.stderr, /status refused — refusing to write — .* is not a real directory of the vault's own/);
      if (args.includes('--json')) {
        assert.equal(res.json?.initialized, true);
        assert.match(res.json?.refused || '', /not a real directory of the vault's own/);
        assert.equal(res.json?.dirty, undefined, 'no work-tree git call may run on a refused vault');
      } else {
        assert.match(res.stdout, /REFUSED {8}: /);
      }
    }
    assertProjectUntouched(repo, wt, before, 'status via .git junction');
  } finally {
    fx.cleanup();
  }
});

test('G5: status still reports an ordinary vault, and a vault whose initialize commit never landed, without refusing', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    const vault = join(fx.stateDir, 'memory-vault');
    mkdirSync(vault, { recursive: true });
    git(['init', '-q', '-b', 'main', vault]);
    git(['-C', vault, 'config', '--file', join(vault, '.git', 'config'), 'user.email', 'memory-vault@agent-companion.local']);
    writeFileSync(join(vault, '.memory-vault.json'), MARKER);
    const half = runScript(SCRIPT, ['status', '--json'], { cwd: fx.dir, env });
    assert.equal(half.status, 0, half.stderr);
    assert.equal(half.json?.refused, undefined, half.stdout);
    assert.equal(half.json?.lastCommit, null);

    const sync = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(sync.status, 0, sync.stderr);
    // Finishing supplied the commit's name itself (0.29.1 integration: on a
    // Linux host with an empty account name the commit failed with "empty
    // ident name"; Windows masked it with the account's user name).
    assert.equal(git(['-C', vault, 'config', '--file', join(vault, '.git', 'config'), '--get', 'user.name']), 'agent-companion memory-vault');
    const ok = runScript(SCRIPT, ['status', '--json'], { cwd: fx.dir, env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json?.refused, undefined);
    assert.equal(ok.json?.dirty, false);
    assert.equal(ok.json?.lastCommit?.subject.startsWith('memory-vault sync'), true, ok.stdout);
  } finally {
    fx.cleanup();
  }
});

// G6. sync writes its lock and status file under the state root BEFORE the
// vault is created. An AGENT_COMPANION_VAULT_DIR that was the state root,
// was inside it, or contained it therefore got written to first. The refusal
// that followed ("already exists and is not a memory vault") claimed that
// nothing was written, which was false.
const OVERLAPS = [
  ['the state root itself', (fx) => fx.stateDir, /which is the state root itself/],
  ['the state/ dir that holds the lock', (fx) => join(fx.stateDir, 'state'), /which is inside the state root/],
  ['a directory inside state/', (fx) => join(fx.stateDir, 'state', 'vault'), /which is inside the state root/],
  ['another directory inside the state root', (fx) => join(fx.stateDir, 'other-vault'), /which is inside the state root/],
  ['a directory that contains the state root', (fx) => join(fx.dir, '.claude'), /which is a directory that contains the state root/],
];

for (const [label, vaultFor, re] of OVERLAPS) {
  for (const cmd of ['init', 'sync']) {
    test(`G6: ${cmd} refuses, writing nothing, an AGENT_COMPANION_VAULT_DIR that is ${label}`, () => {
      const fx = makeFixture();
      try {
        const corpus = makeCorpus(fx.dir);
        const vault = vaultFor(fx);
        const res = runScript(SCRIPT, [cmd, '--json'], {
          cwd: fx.dir,
          env: { AGENT_COMPANION_VAULT_DIR: vault, AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
        });
        assert.notEqual(res.status, 0, `${cmd} must refuse: ${res.stdout}`);
        assert.match(res.stderr, /refusing to initialize — AGENT_COMPANION_VAULT_DIR is /);
        assert.match(res.stderr, re);
        assert.match(res.stderr, /Nothing was written/);
        assert.ok(!existsSync(fx.stateDir), `the state root must not be created: ${existsSync(fx.stateDir) ? readdirSync(fx.stateDir) : ''}`);
        assert.ok(!existsSync(vault), 'the vault directory must not be created');
      } finally {
        fx.cleanup();
      }
    });
  }
}

test('G6: an AGENT_COMPANION_VAULT_DIR that reaches the state root through a junction/symlink is refused', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    mkdirSync(fx.stateDir, { recursive: true });
    const alias = join(fx.dir, 'alias');
    symlinkSync(fx.stateDir, alias, 'junction');
    const res = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir,
      env: { AGENT_COMPANION_VAULT_DIR: join(alias, 'state'), AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.notEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /which is inside the state root/);
    assert.deepEqual(readdirSync(fx.stateDir), [], 'nothing may be written under the state root');
  } finally {
    fx.cleanup();
  }
});

test('G6: AGENT_COMPANION_VAULT_DIR set to the default location inside the state root is accepted', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const res = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir,
      env: {
        AGENT_COMPANION_VAULT_DIR: join(fx.stateDir, 'memory-vault'),
        AGENT_COMPANION_MEMORY_ROOT: corpus,
        CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      },
      timeout: 60000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
  } finally {
    fx.cleanup();
  }
});

// G7. A one-off inline AGENT_COMPANION_VAULT_DIR moves only that run. The
// scheduled scout's sync and the audit read the variable from their own
// environment, so every refusal that says to set it also says to set it
// persistently, and the README says how.
test('G7: every refusal that recommends AGENT_COMPANION_VAULT_DIR says to set it persistently', () => {
  const fx = makeFixture();
  try {
    const { repo } = makeProject(fx.dir);
    const corpus = makeCorpus(fx.dir);
    const base = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
    const cases = [
      ['inside a repository', { AGENT_COMPANION_STATE_DIR: join(repo, 'nested', 'state') }],
      ['relative', { AGENT_COMPANION_VAULT_DIR: join('relative', 'vault') }],
      ['overlapping the state root', { AGENT_COMPANION_VAULT_DIR: join(fx.stateDir, 'state') }],
    ];
    for (const [label, env] of cases) {
      const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env: { ...base, ...env } });
      assert.notEqual(res.status, 0, label);
      assert.match(res.stderr, /AGENT_COMPANION_VAULT_DIR/, label);
      assert.match(res.stderr,
        /Set it persistently \(the "env" block of Claude Code's settings\.json, or a user environment variable\) so the scheduled scout and the audit use it too/,
        `${label}: ${res.stderr}`);
    }
  } finally {
    fx.cleanup();
  }
});

test('G7: the README documents setting AGENT_COMPANION_VAULT_DIR persistently for the scheduled scout and the audit', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('**Moving the vault.**'), readme.indexOf('**Never a session transcript.**'));
  assert.match(section, /\*\*Set it persistently\.\*\*/);
  assert.match(section, /"env": \{\s*"AGENT_COMPANION_VAULT_DIR": /);
  assert.match(section, /scheduled calibration scout/);
  assert.match(section, /memory-vault-drift/);
  assert.match(section, /setx AGENT_COMPANION_VAULT_DIR/);
});

// Round-2 info note. A commondir planted in the vault's own real .git makes
// git read and write the named repository's refs and objects. The history
// check alone does not catch it when the named repository is ANOTHER vault,
// because that one is rooted in the initialize commit too, so the sync
// committed into it.
for (const cmd of ['sync', 'status']) {
  test(`${cmd} refuses a vault whose .git carries a planted commondir, leaving the named repository byte-identical`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' };
      const other = join(fx.dir, 'other-vault');
      const made = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env: { ...env, AGENT_COMPANION_VAULT_DIR: other }, timeout: 60000 });
      assert.equal(made.status, 0, made.stderr);
      const first = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
      assert.equal(first.status, 0, first.stderr);
      const vault = join(fx.stateDir, 'memory-vault');
      writeFileSync(join(vault, '.git', 'commondir'), `${join(other, '.git').replace(/\\/g, '/')}\n`);
      writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
      const treeBefore = hashTree(join(other, '.git'));
      const headBefore = git(['-C', other, 'rev-parse', 'HEAD']);

      const res = runScript(SCRIPT, [cmd, '--json'], { cwd: fx.dir, env, timeout: 60000 });

      assert.equal(git(['-C', other, 'rev-parse', 'HEAD']), headBefore, 'the named repository gained a commit');
      assert.deepEqual(hashTree(join(other, '.git')), treeBefore, 'the named repository .git must be byte-identical');
      assert.notEqual(res.status, 0, `${cmd} must refuse: ${res.stdout}`);
      assert.match(res.stderr, /has a commondir file/);
    } finally {
      fx.cleanup();
    }
  });
}

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

// --- 0.29.2 S1: housekeeping runs in the foreground, inside the sync lock --
// A vault commit can start `git maintenance run --auto` / `git gc --auto`,
// which by default detach and keep working on the vault's .git after the
// commit returns, overlapping the next sync. Every vault invocation now says
// maintenance.autoDetach=false and gc.autoDetach=false, and never zeroes
// gc.auto. git's own trace2 event stream records each process's full argv,
// -c options included, so this reads what git actually received.
function traceStarts(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'start' && Array.isArray(e.argv));
}

function hasConfigPair(argv, kv) {
  return argv.some((a, i) => a === '-c' && argv[i + 1] === kv);
}

test('S1: every vault commit (and every vault git call) runs housekeeping undetached; gc.auto is left alone', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const trace = join(fx.dir, 'trace2.jsonl');
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', GIT_TRACE2_EVENT: trace };
    const first = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const second = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json?.committed, true, second.stdout);

    // Top-level processes only (a child git spawns has a nested sid), and
    // only the vault's own: vaultGit() names --git-dir=.git; createVault()'s
    // init is the one call made before there is a work tree.
    const ours = traceStarts(trace).filter((e) => !String(e.sid || '').includes('/')
      && (e.argv.includes('--git-dir=.git') || e.argv.includes('init')));
    const commits = ours.filter((e) => e.argv.includes('commit'));
    assert.ok(commits.length >= 2, `expected the init and sync commits in the trace, saw ${commits.length}`);
    assert.ok(ours.some((e) => e.argv.includes('init')), 'the init call is traced');
    for (const e of ours) {
      const shown = e.argv.join(' ');
      assert.ok(hasConfigPair(e.argv, 'maintenance.autoDetach=false'), `missing maintenance.autoDetach=false: ${shown}`);
      assert.ok(hasConfigPair(e.argv, 'gc.autoDetach=false'), `missing gc.autoDetach=false: ${shown}`);
      assert.ok(!e.argv.some((a) => /^gc\.auto=/i.test(a)), `gc.auto must not be overridden: ${shown}`);
    }
  } finally {
    fx.cleanup();
  }
});

// The no-hooks, no-fsmonitor and no-signing -c options, read from git's own
// trace. Under the hermetic env no config from outside the vault can set a
// hooksPath or signing at all, so the hostile-config tests below cannot see
// these options go missing. Two places still need them: the vault's own
// .git/config (the "vault's own .git/config" test below), and `git init`,
// which runs before that file exists, and tag.gpgsign, which only matters if
// a tag is ever made. This test pins all of them on every call that carries
// them: each vaultGit() call (it always names --work-tree=.) and the init.
test('S1: every vault call and the init carry the no-hooks, no-fsmonitor and no-signing -c options', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const trace = join(fx.dir, 'trace2.jsonl');
    const env = { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', GIT_TRACE2_EVENT: trace };
    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    const top = traceStarts(trace).filter((e) => !String(e.sid || '').includes('/'));
    const calls = top.filter((e) => e.argv.includes('--work-tree=.'));
    assert.ok(calls.some((e) => e.argv.includes('commit')), 'the vault commit is traced');
    for (const e of calls) {
      const shown = e.argv.join(' ');
      for (const kv of ['core.hooksPath=.git/agent-companion-no-hooks', 'core.fsmonitor=false', 'commit.gpgsign=false', 'tag.gpgsign=false']) {
        assert.ok(hasConfigPair(e.argv, kv), `missing -c ${kv}: ${shown}`);
      }
    }
    const inits = top.filter((e) => e.argv.includes('init'));
    assert.equal(inits.length, 1, 'one init call');
    const vault = join(fx.stateDir, 'memory-vault');
    assert.ok(hasConfigPair(inits[0].argv, `core.hooksPath=${join(vault, '.git', 'agent-companion-no-hooks')}`), inits[0].argv.join(' '));
    assert.ok(hasConfigPair(inits[0].argv, 'core.fsmonitor=false'), inits[0].argv.join(' '));
  } finally {
    fx.cleanup();
  }
});

// --- 0.29.2 S2: no configuration from outside the vault reaches any call --
// Every vault git call runs hermetic (hermeticGitEnv()): no global or system
// config file, whether git finds it through GIT_CONFIG_GLOBAL /
// GIT_CONFIG_SYSTEM, through HOME ($HOME/.gitconfig) or through
// XDG_CONFIG_HOME ($XDG_CONFIG_HOME/git/config, git/ignore,
// git/attributes). The hostile config below reaches git by each of those
// routes in turn. Each setting in it announces itself in the sentinel file
// if git ever acts on it:
//   - hooks, an fsmonitor program and a gpg program: the vault's -c options
//     stop these even without the hermetic env;
//   - a clean filter (via core.attributesFile), an excludes file, and git's
//     default per-user ignore file: nothing but the hermetic env stops these,
//     so every route below goes red when the hermetic env is removed.
// The same settings written into the vault's OWN .git/config reach git
// whatever the env says; only the -c options stop them (the "vault's own
// .git/config" test further down), so that test goes red when the -c
// options are removed.
function sh(p) { return p.replace(/\\/g, '/'); }

function makeHostileConfig(root) {
  const flag = join(root, 'HOSTILE_SENTINEL');
  const F = sh(flag);
  const hooks = join(root, 'hostile-hooks');
  mkdirSync(hooks, { recursive: true });
  for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction',
    'post-index-change', 'post-checkout']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\necho hook:${h} >> "${F}"\ncat >/dev/null 2>&1\nexit 0\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const prog = (name, body) => {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> "${F}"\n${body}\n`);
    chmodSync(p, 0o755);
    return sh(p);
  };
  const fsmonitor = prog('hostile-fsmonitor', 'exit 1');
  const gpg = prog('hostile-gpg', 'exit 1');
  const clean = prog('hostile-filter', 'cat');
  const excludes = join(root, 'hostile-excludes');
  writeFileSync(excludes, 'hostile-excluded.md\n');
  const attributes = join(root, 'hostile-attributes');
  writeFileSync(attributes, '* filter=hostile\n');
  // Settings the vault's -c options answer for.
  const guarded = [
    '[core]', `\thooksPath = ${sh(hooks)}`, `\tfsmonitor = ${fsmonitor}`,
    '[commit]', '\tgpgsign = true',
    '[tag]', '\tgpgsign = true',
    '[gpg]', `\tprogram = ${gpg}`,
  ];
  // Settings only the hermetic env keeps out.
  const unguarded = [
    '[core]', `\texcludesFile = ${sh(excludes)}`, `\tattributesFile = ${sh(attributes)}`,
    '[filter "hostile"]', `\tclean = ${clean}`, `\tsmudge = ${clean}`,
    '[user]', '\tname = HOSTILE-GLOBAL-IDENT', '\temail = hostile@example.invalid',
  ];
  const text = [...guarded, ...unguarded, ''].join('\n');
  const file = join(root, 'hostile.gitconfig');
  writeFileSync(file, text);
  const home = join(root, 'hostile-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), text);
  const xdg = join(root, 'hostile-xdg');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  writeFileSync(join(xdg, 'git', 'config'), text);
  // git's DEFAULT per-user ignore file, which it reads when no config sets
  // core.excludesFile: $XDG_CONFIG_HOME/git/ignore, or
  // $HOME/.config/git/ignore when XDG_CONFIG_HOME is unset. No config file
  // names it, so pinning GIT_CONFIG_GLOBAL does not keep it out; only the
  // XDG_CONFIG_HOME (and HOME) pins do.
  writeFileSync(join(xdg, 'git', 'ignore'), 'hostile-excluded.md\n');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  writeFileSync(join(home, '.config', 'git', 'ignore'), 'hostile-excluded.md\n');
  return { flag, file, home, xdg, guardedText: [...guarded, ''].join('\n') };
}

function sentinel(h) {
  return existsSync(h.flag) ? readFileSync(h.flag, 'utf8').trim().split(/\s+/).join(', ') : '';
}

// Every route by which a global or system config file reaches git. Windows
// env names are case-insensitive, so a lower-case spelling is covered too.
const CONFIG_ROUTES = [
  ['GIT_CONFIG_GLOBAL', (h) => ({ GIT_CONFIG_GLOBAL: h.file })],
  ['GIT_CONFIG_SYSTEM', (h) => ({ GIT_CONFIG_SYSTEM: h.file })],
  ['HOME (~/.gitconfig)', (h) => ({ HOME: h.home })],
  ['XDG_CONFIG_HOME (git/config)', (h) => ({ XDG_CONFIG_HOME: h.xdg })],
  ...(process.platform === 'win32' ? [['lower-case git_config_global (Windows)', (h) => ({ git_config_global: h.file })]] : []),
];

function vaultEnvFor(corpus, extra) {
  return { AGENT_COMPANION_MEMORY_ROOT: corpus, CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true', ...extra };
}

for (const [label, route] of CONFIG_ROUTES) {
  test(`S2: a hostile config reached through ${label} never touches sync or status: no program runs, nothing is left out`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      writeFileSync(join(corpus, 'proj-a', 'memory', 'hostile-excluded.md'), 'must be backed up\n');
      const h = makeHostileConfig(fx.dir);
      const env = vaultEnvFor(corpus, route(h));
      const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json?.committed, true, res.stdout);
      const vault = join(fx.stateDir, 'memory-vault');
      assert.equal(sentinel(h), '', 'a program from the hostile config ran during sync');
      assert.equal(git(['-C', vault, 'show', 'HEAD:projects/proj-a/memory/hostile-excluded.md']), 'must be backed up',
        'a hostile excludes file left a memory file out of the backup');
      for (const a of git(['-C', vault, 'log', '--format=%an <%ae>|%cn <%ce>']).split('\n')) {
        assert.equal(a, `${VAULT_NAME} <memory-vault@agent-companion.local>|${VAULT_NAME} <memory-vault@agent-companion.local>`);
      }
      assert.doesNotMatch(readFileSync(join(vault, '.git', 'config'), 'utf8'), /HOSTILE|hostile/,
        'nothing from the hostile config was written into the vault config');
      // status re-reads a stat-dirty file's content, which is where a clean
      // filter would run on the read path.
      const later = new Date(Date.now() + 5000);
      utimesSync(join(vault, 'projects', 'proj-a', 'memory', 'MEMORY.md'), later, later);
      const st = runScript(SCRIPT, ['status', '--json'], { cwd: fx.dir, env, timeout: 60000 });
      assert.equal(st.status, 0, st.stderr);
      assert.equal(sentinel(h), '', 'a program from the hostile config ran during status');
    } finally {
      fx.cleanup();
    }
  });

  // G3. `git init` runs hooks too (creating HEAD fires reference-transaction),
  // and a global core.fsmonitor program ran on every vault call.
  for (const cmd of ['init', 'sync']) {
    test(`G3: ${cmd} of a new vault runs no program from a config reached through ${label}`, () => {
      const fx = makeFixture();
      try {
        const corpus = makeCorpus(fx.dir);
        const h = makeHostileConfig(fx.dir);
        const res = runScript(SCRIPT, [cmd, '--json'], { cwd: fx.dir, env: vaultEnvFor(corpus, route(h)), timeout: 60000 });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(sentinel(h), '', `a program from the hostile config ran during vault ${cmd}`);
        assert.equal(git(['-C', join(fx.stateDir, 'memory-vault'), 'log', '--max-parents=0', '--format=%s']), 'memory-vault: initialize');
      } finally {
        fx.cleanup();
      }
    });
  }
}

// The -c options, on their own. A hooksPath, an fsmonitor program or commit
// signing set in the vault's OWN .git/config reaches git whatever the env
// says (the vault's config is the one file git still reads). The vault's
// -c options are what stop them.
test('S2: hooks, fsmonitor and signing set in the vault\'s own .git/config do not run on sync or status', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const env = vaultEnvFor(corpus, {});
    const first = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(first.status, 0, first.stderr);
    const vault = join(fx.stateDir, 'memory-vault');
    const h = makeHostileConfig(fx.dir);
    writeFileSync(join(vault, '.git', 'config'), readFileSync(join(vault, '.git', 'config'), 'utf8') + h.guardedText);
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
    assert.equal(sentinel(h), '', 'a hook, fsmonitor or gpg program from the vault\'s own config ran during sync');
    assert.doesNotMatch(git(['-C', vault, 'cat-file', 'commit', 'HEAD']), /gpgsig/, 'the vault commit was signed');
    const st = runScript(SCRIPT, ['status', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(st.status, 0, st.stderr);
    assert.equal(sentinel(h), '', 'an fsmonitor program from the vault\'s own config ran during status');
  } finally {
    fx.cleanup();
  }
});

// Git for Windows opens the file GIT_REDIRECT_STDOUT / GIT_REDIRECT_STDERR
// names as git's own stdout / stderr. Inherited, it made every vault git
// call write its output to that file, outside the vault, and the vault read
// nothing back.
test('S2: an inherited GIT_REDIRECT_STDOUT/STDERR reaches no git call made by init, sync or status', {
  skip: process.platform !== 'win32' && 'GIT_REDIRECT_* is a Git for Windows variable',
}, () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const out = join(fx.dir, 'redirected-stdout');
    const err = join(fx.dir, 'redirected-stderr');
    // CONTROL: the variable does reach a plain git child here.
    const probe = join(fx.dir, 'probe-stdout');
    spawnSync('git', ['--version'], { windowsHide: true, env: { ...cleanGitEnv(), GIT_REDIRECT_STDOUT: probe } });
    assert.ok(existsSync(probe), 'control: this git honours GIT_REDIRECT_STDOUT');
    const env = vaultEnvFor(corpus, { git_redirect_stdout: out, GIT_REDIRECT_STDERR: err });
    for (const cmd of ['init', 'sync', 'status']) {
      const res = runScript(SCRIPT, [cmd, '--json'], { cwd: fx.dir, env, timeout: 60000 });
      assert.equal(res.status, 0, `${cmd}: ${res.stderr}`);
    }
    assert.ok(!existsSync(out) && !existsSync(err), 'a git child wrote its output to the inherited redirect file');
    assert.equal(git(['-C', join(fx.stateDir, 'memory-vault'), 'show', 'HEAD:projects/proj-a/memory/MEMORY.md']), '# index');
  } finally {
    fx.cleanup();
  }
});

test('S2: vaultGitEnv is hermetic: config files, HOME and XDG_CONFIG_HOME pinned, every spelling replaced, identity dropped', () => {
  const env = {
    PATH: '/bin', GIT_CONFIG_GLOBAL: '/g', git_config_system: '/s', GIT_CONFIG_NOSYSTEM: '0', Home: '/h', HOME: '/h',
    xdg_config_home: '/x', GIT_ATTR_NOSYSTEM: '0', GIT_AUTHOR_NAME: 'x', GIT_CONFIG_PARAMETERS: "'a.b'='c'", EMAIL: 'e@example.invalid',
    Git_Attr_Source: 'hostile-tree', git_redirect_stdout: '/o', GIT_REDIRECT_STDERR: '/e',
  };
  const out = vaultGitEnv(env);
  assert.deepEqual(
    Object.keys(out).filter((k) => /^(git_config|git_attr|git_redirect|home$|xdg_config_home$)/i.test(k)).sort(),
    ['GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'HOME', 'XDG_CONFIG_HOME'],
  );
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME', 'XDG_CONFIG_HOME']) assert.equal(out[k], NULL_DEVICE, k);
  assert.equal(out.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(out.GIT_ATTR_NOSYSTEM, '1');
  assert.equal(out.GIT_AUTHOR_NAME, undefined);
  assert.equal(out.PATH, '/bin');
  assert.equal(out.EMAIL, 'e@example.invalid', 'EMAIL stays: it is git\'s own identity fallback, not config');
  assert.equal(env.HOME, '/h', 'the input is not mutated');
});

test('S2: vaultSubcommand finds the subcommand past global options', () => {
  const V = ['-c', 'core.longpaths=true', '-C', '/v', '--git-dir=.git', '--work-tree=.'];
  assert.equal(vaultSubcommand([...V, 'commit', '-q']), 'commit');
  assert.equal(vaultSubcommand([...V, '--no-optional-locks', 'status', '--porcelain']), 'status');
  assert.equal(vaultSubcommand(['-c', 'x=1', 'init', '-q', '/v']), 'init');
  assert.equal(vaultSubcommand(['add', '-A']), 'add');
  assert.equal(vaultSubcommand([]), '');
});

// --- what the vault still takes from the operator's config -----------------
test('S3: parseScopedConfig reads `git config --show-scope -z` output, including a key with no value', () => {
  const out = 'system\0core.autocrlf\ntrue\0global\0user.name\nA B\0global\0safe.directory\n*\0local\0Core.Eol\0';
  assert.deepEqual(parseScopedConfig(out), [
    { scope: 'system', key: 'core.autocrlf', value: 'true' },
    { scope: 'global', key: 'user.name', value: 'A B' },
    { scope: 'global', key: 'safe.directory', value: '*' },
    { scope: 'local', key: 'core.eol', value: null },
  ]);
  assert.deepEqual(parseScopedConfig(''), []);
});

test('S3: carriedConfigArgs passes the effective line-ending settings and protected safe.directory entries, nothing else', () => {
  const entries = [
    { scope: 'system', key: 'core.autocrlf', value: 'true' },
    { scope: 'global', key: 'core.autocrlf', value: 'input' },
    { scope: 'system', key: 'safe.directory', value: '/srv/a' },
    { scope: 'global', key: 'safe.directory', value: null },
    { scope: 'global', key: 'safe.directory', value: '*' },
    { scope: 'local', key: 'safe.directory', value: '/ignored-by-git-from-local-scope' },
    { scope: 'local', key: 'core.eol', value: null },
    { scope: 'global', key: 'user.email', value: 'op@example.invalid' },
  ];
  // In order; a key with no value (git: empty the list so far) keeps no value.
  assert.deepEqual(carriedConfigArgs(entries), [
    '-c', 'safe.directory=/srv/a', '-c', 'safe.directory', '-c', 'safe.directory=*',
    '-c', 'core.autocrlf=input', '-c', 'core.eol',
  ]);
  assert.deepEqual(carriedConfigArgs([]), []);
});

test('S3: commitIdentityArgs fills only what the vault\'s own config leaves unset', () => {
  const operator = [
    { scope: 'global', key: 'user.name', value: 'Op Name' },
    { scope: 'global', key: 'user.email', value: 'op@example.invalid' },
    { scope: 'local', key: 'user.email', value: 'never-from-the-lookup@example.invalid' },
  ];
  const own = (email) => [{ scope: 'local', key: 'user.name', value: VAULT_NAME },
    ...(email ? [{ scope: 'local', key: 'user.email', value: email }] : [])];
  // The owner's own identity is never replaced.
  assert.deepEqual(commitIdentityArgs(own('owner@example.invalid'), operator, {}), []);
  // Unset email: the operator's configured one.
  assert.deepEqual(commitIdentityArgs(own(''), operator, {}), ['-c', 'user.email=op@example.invalid']);
  // Unset email, no operator identity: git's EMAIL fallback, else the vault's own.
  assert.deepEqual(commitIdentityArgs(own(''), [], { EMAIL: 'env@example.invalid' }), []);
  assert.deepEqual(commitIdentityArgs(own(''), [], {}), ['-c', 'user.email=memory-vault@agent-companion.local']);
  // Nothing set in the vault at all.
  assert.deepEqual(commitIdentityArgs([], [], {}),
    ['-c', `user.name=${VAULT_NAME}`, '-c', 'user.email=memory-vault@agent-companion.local']);
});
