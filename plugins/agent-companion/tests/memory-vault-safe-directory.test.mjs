// safe.directory for a vault owned by another account (0.29.2 round 3: F1,
// F2 of the round-2 re-review; 0.29.7: V1, V2 of the round-3 verification).
//
// Every vault git call runs with HOME set to the null device, so it cannot
// read the operator's system and global safe.directory entries itself.
// Round 2 passed them on with -c: an entry relative to HOME ("~/...") then
// resolved under the null device and never matched, and one inside
// `includeIf "gitdir:..."` counted, although git itself ignores it for
// safe.directory. Round 3 passed every entry, expanded, with its own -c, and
// a few hundred overflowed the Windows command line. Now the operator's own
// git decides once, and a trusted vault's calls carry one entry naming it.
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

// A gitfile planted at the path round 3 used for its "outside any repository"
// lookup (<vault>/.git/agent-companion-no-repository) made that lookup run in
// a repository again, so `includeIf "gitdir:..."` applied and its `*`
// counted. Only whoever can write the vault's .git can plant one, which for a
// vault owned by another account is that account: safe.directory's own
// threat model. git ignores the block, so the vault must be refused.
test('a vault owned by another account stays refused when a gitfile is planted where round 3 looked outside any repository', () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const vault = join(fx.dir, ...VAULT_REL.split('/'));
    const first = runScript(SCRIPT, ['sync', '--json'], {
      cwd: fx.dir, env: operatorEnv(fx, corpus, '', { differentOwner: false }), timeout: 60000,
    });
    assert.equal(first.status, 0, first.stderr);
    const head = inspect(vault, ['rev-parse', 'HEAD']).out;
    writeFileSync(join(vault, '.git', 'agent-companion-no-repository'), `gitdir: ${fwd(join(vault, '.git'))}\n`);
    writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
    const cfg = `[includeIf "gitdir:**"]\n\tpath = ${include(fx, 'inc-gitdir.gitconfig', '[safe]\n\tdirectory = *\n')}\n`;
    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env: operatorEnv(fx, corpus, cfg), timeout: 60000 });
    assert.notEqual(res.status, 0, `git ignores the block for safe.directory, so the sync must fail:\n${res.stdout}`);
    assert.equal(inspect(vault, ['rev-parse', 'HEAD']).out, head, 'nothing was committed');
  } finally {
    fx.cleanup();
  }
});

// 0.29.7 (V1 of the round-3 verification). Every system and global entry
// used to be passed as its own -c on every vault call. On Windows, about 500
// ordinary entries overflowed the 32,767-character command line, so every
// vault call failed (ENAMETOOLONG), for a vault the operator owns as well,
// and the sync blamed a missing repository. 0.29.1 handled 2,000. The vault
// now lets the operator's git decide and carries one entry, whatever the
// count. Each entry here is about 45 characters; the `~/` ones expand to the
// fixture's HOME, as they did in round 3.
function manyEntries(n, form) {
  const root = process.platform === 'win32' ? 'D:/source/repos' : '/srv/source/repos';
  const one = (i) => `${form === 'tilde' ? '~/source/repos' : root}/some-team/some-project-${String(i).padStart(4, '0')}`;
  return Array.from({ length: n }, (_, i) => `\tdirectory = ${one(i)}\n`).join('');
}

// git's own trace2 event stream records each git process's argv: every call
// carries at most one safe.directory, so the command line stays short on any
// platform (CI runs Linux, where the old argv still fit).
function safeDirectoryArgCounts(trace) {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.event === 'start' && Array.isArray(e.argv))
    .map((e) => ({
      safe: e.argv.filter((a, i) => e.argv[i - 1] === '-c' && /^safe\.directory(=|$)/i.test(a)).length,
      chars: e.argv.join(' ').length,
    }));
}

for (const n of [600, 2000]) {
  for (const form of ['abs', 'tilde']) {
    test(`${n} ${form === 'abs' ? 'absolute' : '`~/`'} safe.directory entries: a vault the operator owns syncs, with one entry per call at most`, () => {
      const fx = makeFixture();
      try {
        const corpus = makeCorpus(fx.dir);
        const vault = join(fx.dir, ...VAULT_REL.split('/'));
        const trace = join(fx.dir, 'trace2.jsonl');
        const cfg = `[safe]\n${manyEntries(n, form)}`;
        for (const text of ['# index\n', '# index v2\n']) {
          writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), text);
          const res = runScript(SCRIPT, ['sync', '--json'], {
            cwd: fx.dir, env: operatorEnv(fx, corpus, cfg, { differentOwner: false, extra: { GIT_TRACE2_EVENT: trace } }), timeout: 60000,
          });
          assert.equal(res.status, 0, res.stderr);
          assert.equal(res.json?.committed, true, res.stdout);
        }
        assert.equal(inspect(vault, ['show', 'HEAD:projects/proj-a/memory/MEMORY.md']).out, '# index v2');
        const calls = safeDirectoryArgCounts(trace);
        assert.ok(calls.length > 5, `expected the vault's git calls in the trace, saw ${calls.length}`);
        for (const c of calls) {
          assert.ok(c.safe <= 1, `a git call carried ${c.safe} safe.directory entries`);
          assert.ok(c.chars < 4000, `a git call's command line is ${c.chars} characters`);
        }
      } finally {
        fx.cleanup();
      }
    });
  }

  test(`${n} safe.directory entries: an existing vault owned by another account syncs when one of them names it, and is refused when none does`, () => {
    const fx = makeFixture();
    try {
      const corpus = makeCorpus(fx.dir);
      const vault = join(fx.dir, ...VAULT_REL.split('/'));
      const first = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir, env: operatorEnv(fx, corpus, '', { differentOwner: false }), timeout: 60000,
      });
      assert.equal(first.status, 0, first.stderr);
      const head = inspect(vault, ['rev-parse', 'HEAD']).out;
      writeFileSync(join(corpus, 'proj-a', 'memory', 'MEMORY.md'), '# index v2\n');
      const refused = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir, env: operatorEnv(fx, corpus, `[safe]\n${manyEntries(n, 'abs')}`), timeout: 60000,
      });
      assert.notEqual(refused.status, 0, `no entry names the vault, so the sync must fail:\n${refused.stdout}`);
      assert.doesNotMatch(refused.stderr, /ENAMETOOLONG/, 'the refusal is git\'s, not an overflowing command line');
      assert.equal(inspect(vault, ['rev-parse', 'HEAD']).out, head, 'nothing was committed');
      const res = runScript(SCRIPT, ['sync', '--json'], {
        cwd: fx.dir, env: operatorEnv(fx, corpus, `[safe]\n${manyEntries(n, 'tilde')}\tdirectory = ~/${VAULT_REL}\n`), timeout: 60000,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json?.committed, true, res.stdout);
      assert.equal(inspect(vault, ['show', 'HEAD:projects/proj-a/memory/MEMORY.md']).out, '# index v2');
    } finally {
      fx.cleanup();
    }
  });
}

// The one entry carried is the vault as the operator's git names it, so it
// matches however the vault's path is spelled. Windows paths are
// case-insensitive, and git compares the entry with the directory's real
// name.
test('a vault owned by another account, reached through a differently-cased state path, syncs through `*`', {
  skip: process.platform !== 'win32' && 'paths are case-sensitive here',
}, () => {
  const fx = makeFixture();
  try {
    const corpus = makeCorpus(fx.dir);
    const vault = join(fx.dir, ...VAULT_REL.split('/'));
    const env = operatorEnv(fx, corpus, '[safe]\n\tdirectory = *\n', {
      extra: { AGENT_COMPANION_STATE_DIR: fx.stateDir.toUpperCase() },
    });
    const res = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.committed, true, res.stdout);
    assert.equal(inspect(vault, ['show', 'HEAD:projects/proj-a/memory/MEMORY.md']).out, '# index');
  } finally {
    fx.cleanup();
  }
});

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
