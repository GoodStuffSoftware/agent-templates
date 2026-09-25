// safe.directory for a vault owned by another account (0.29.2 round 3: F1,
// F2 of the round-2 re-review).
//
// Every vault git call runs with HOME set to the null device, so the
// operator's system and global safe.directory entries are passed to it with
// -c. An entry relative to HOME ("~/...") used to be passed as written, so it
// resolved under the null device and never matched: a vault the operator had
// trusted that way was refused on every run, where 0.29.1 synced it. And the
// entries were read inside the vault, so one inside `includeIf "gitdir:..."`
// counted, although git itself ignores it for safe.directory.
//
// Each case runs a real sync. git's own knob GIT_TEST_ASSUME_DIFFERENT_OWNER=1,
// set in the vault's env only, makes git treat the vault as owned by another
// account, so it needs an entry to trust it. The operator's config is the
// fixture's $HOME/.gitconfig (HOME is the fixture dir; system config is off);
// the real one is never read. The expected answer in every row is git's own,
// which is also what 0.29.1 did: its vault calls read this config directly.
// This file uses nothing but the script's command line, so it runs unchanged
// against a 0.29.1 tree too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runScript } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';
const VAULT_REL = '.claude/agent-companion/memory-vault'; // the default vault, under the fixture's HOME

function fwd(p) { return p.replace(/\\/g, '/'); }

// The test's own view of the vault: plain git, no ownership knob.
function inspect(vault, args) {
  const r = spawnSync('git', ['-C', vault, ...args], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  return { status: r.status, out: String(r.stdout || '').trim() };
}

function makeCorpus(root) {
  const mem = join(root, 'corpus', 'proj-a', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), '# index\n');
  return join(root, 'corpus');
}

// The env of a sync whose operator config is `gitconfig`, with HOME = the
// fixture dir (so `~/.claude/agent-companion/memory-vault` is the vault).
function operatorEnv(fx, corpus, gitconfig, { differentOwner = true, extra = {} } = {}) {
  writeFileSync(join(fx.dir, '.gitconfig'), gitconfig);
  const env = {
    AGENT_COMPANION_MEMORY_ROOT: corpus,
    CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
    HOME: fx.dir,
    XDG_CONFIG_HOME: join(fx.dir, 'no-xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: undefined,
    GIT_CONFIG_SYSTEM: undefined,
    GIT_TEST_ASSUME_DIFFERENT_OWNER: differentOwner ? '1' : undefined,
    ...extra,
  };
  // Windows env names are case-insensitive: drop any other spelling.
  for (const k of Object.keys(process.env)) {
    if (/^(home|xdg_config_home|git_config_global|git_config_system|git_config_nosystem|git_test_assume_different_owner)$/i.test(k)
      && !(k in env)) env[k] = undefined;
  }
  return env;
}

function include(fx, name, text) {
  writeFileSync(join(fx.dir, name), text);
  return fwd(join(fx.dir, name));
}

// [label, operator ~/.gitconfig (given the fixture and vault path), trusted?]
const CASES = [
  ['`*`', () => '[safe]\n\tdirectory = *\n', true],
  ['the vault\'s absolute path', (fx, vault) => `[safe]\n\tdirectory = ${fwd(vault)}\n`, true],
  ['`~/` + the vault\'s path under HOME', () => `[safe]\n\tdirectory = ~/${VAULT_REL}\n`, true],
  ['`~/` inside an unconditional include.path', (fx) =>
    `[include]\n\tpath = ${include(fx, 'inc-plain.gitconfig', `[safe]\n\tdirectory = ~/${VAULT_REL}\n`)}\n`, true],
  ['a key with no value (empties the list), then `~/`', () =>
    `[safe]\n\tdirectory\n\tdirectory = ~/${VAULT_REL}\n`, true],
  ['no entry at all', () => '[core]\n\tquotepath = true\n', false],
  ['`~/` naming another directory', () => '[safe]\n\tdirectory = ~/somewhere-else\n', false],
  ['`*`, then an empty value (empties the list)', () => '[safe]\n\tdirectory = *\n\tdirectory =\n', false],
  ['`*`, then a key with no value (empties the list)', () => '[safe]\n\tdirectory = *\n\tdirectory\n', false],
  ['`*` inside includeIf "gitdir:**" (git ignores it for safe.directory)', (fx) =>
    `[includeIf "gitdir:**"]\n\tpath = ${include(fx, 'inc-gitdir.gitconfig', '[safe]\n\tdirectory = *\n')}\n`, false],
  ['`*` inside includeIf "onbranch:**" (git ignores it for safe.directory)', (fx) =>
    `[includeIf "onbranch:**"]\n\tpath = ${include(fx, 'inc-branch.gitconfig', '[safe]\n\tdirectory = *\n')}\n`, false],
];

for (const [label, config, trusted] of CASES) {
  test(`a vault owned by another account, operator safe.directory = ${label}: ${trusted ? 'syncs' : 'is refused'}`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const vault = join(fx.dir, ...VAULT_REL.split('/'));
      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir, env: operatorEnv(fx, corpus, config(fx, vault)), timeout: 60000,
      });
      if (trusted) {
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.json?.committed, true, res.stdout);
        assert.equal(inspect(vault, ['show', 'HEAD:projects/proj-a/memory/MEMORY.md']).out, '# index');
        assert.doesNotMatch(readFileSync(join(vault, '.git', 'config'), 'utf8'), /safe/i,
          'nothing about safe.directory is written into the vault\'s config');
      } else {
        assert.notEqual(res.status, 0, `git would refuse this vault, so the sync must fail:\n${res.stdout}`);
        assert.notEqual(inspect(vault, ['rev-parse', '--verify', '-q', 'HEAD']).status, 0, 'nothing was committed');
      }
    } finally {
      fx.cleanup();
    }
  });
}

// A bare `~` is HOME itself. Here HOME is the vault and the config file is
// named by GIT_CONFIG_GLOBAL, so the entry can only match if it is expanded
// against HOME, not against where the config file lives.
test('a vault owned by another account, operator safe.directory = `~` with HOME = the vault: syncs', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const vault = join(fx.dir, ...VAULT_REL.split('/'));
    const cfg = join(fx.dir, 'operator.gitconfig');
    writeFileSync(cfg, '[safe]\n\tdirectory = ~\n');
    const env = operatorEnv(fx, corpus, '', { extra: { HOME: vault, GIT_CONFIG_GLOBAL: cfg } });
    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
  } finally {
    fx.cleanup();
  }
});

// The regression as the re-review found it: a vault 0.29.1 made and synced,
// then owned by another account, trusted through a `~/` entry.
test('an existing vault owned by another account keeps syncing through a `~/` safe.directory entry', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const vault = join(fx.dir, ...VAULT_REL.split('/'));
    const tilde = `[safe]\n\tdirectory = ~/${VAULT_REL}\n`;
    const first = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir, env: operatorEnv(fx, corpus, tilde, { differentOwner: false }), timeout: 60000,
    });
    assert.equal(first.status, 0, first.stderr);
    const head = inspect(vault, ['rev-parse', 'HEAD']).out;
    const config = readFileSync(join(vault, '.git', 'config'));

    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const refused = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir, env: operatorEnv(fx, corpus, '[core]\n\tquotepath = true\n'), timeout: 60000,
    });
    assert.notEqual(refused.status, 0, 'control: with no entry, git refuses the vault');
    assert.equal(inspect(vault, ['rev-parse', 'HEAD']).out, head);

    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env: operatorEnv(fx, corpus, tilde), timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
    assert.equal(inspect(vault, ['rev-parse', 'HEAD~1']).out, head, 'the new commit follows the old HEAD');
    assert.equal(inspect(vault, ['show', 'HEAD:projects/proj-a/memory/MEMORY.md']).out, '# index v2');
    assert.ok(readFileSync(join(vault, '.git', 'config')).equals(config), 'the vault\'s config is unchanged');
    assert.ok(existsSync(join(vault, '.memory-vault.json')));
  } finally {
    fx.cleanup();
  }
});
