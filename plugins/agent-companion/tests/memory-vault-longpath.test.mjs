// memory-vault at long vault paths (V2 of the vault-guard review).
//
// Writing the vault identity with `git config --file <absolute path>` made
// Git for Windows build <vault>\.git\config.lock as a full path, which passes
// 260 characters for vault paths of 243 characters and up. The config write
// failed after `git init` had already run, leaving a repository with no
// marker, and every later sync refused with a message about an "existing
// git repository" that sent the operator looking in the wrong place.
//
// Separately, Git for Windows cannot find a repository at all when
// <vault>\.git\objects reaches 260 characters (a vault path over 246): that
// check runs before any config is read, so core.longpaths cannot lift it.
// Those lengths must be refused up front with nothing written.
//
// Hermetic: the child gets an EMPTY global config and no system config, so
// an operator's own core.longpaths cannot mask the failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runScript } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

const SCRIPT = 'scripts/memory-vault.mjs';
const WIN = process.platform === 'win32';
const WIN_MAX_VAULT_PATH = 246;

function git(args, cwd, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: cleanGitEnv(process.env, env) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

// A state root whose vault (<state>/memory-vault) is exactly `len` characters.
function stateRootForVaultLength(base, len) {
  const suffix = `${WIN ? '\\' : '/'}memory-vault`;
  const parent = join(base, 's');
  const pad = len - parent.length - 1 - suffix.length;
  assert.ok(pad >= 1, `fixture base too long for a ${len}-character vault`);
  const state = join(parent, 'x'.repeat(pad));
  assert.equal((state + suffix).length, len);
  return state;
}

function hermeticGitEnv(dir) {
  const globalCfg = join(dir, 'empty-global.gitconfig');
  writeFileSync(globalCfg, '');
  return { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' };
}

for (let len = 243; len <= 250; len += 1) {
  const refused = WIN && len > WIN_MAX_VAULT_PATH;
  test(`a ${len}-character vault path ${refused ? 'is refused up front, nothing written' : 'initializes and syncs'}`, () => {
    const fx = makeFixture();
    try {
      const corpus = join(fx.dir, 'c');
      mkdirSync(join(corpus, 'p', 'memory'), { recursive: true });
      writeFileSync(join(corpus, 'p', 'memory', 'MEMORY.md'), '# idx\n');
      const state = stateRootForVaultLength(fx.dir, len);
      const vault = join(state, 'memory-vault');
      const gitEnv = hermeticGitEnv(fx.dir);
      const env = {
        ...gitEnv,
        AGENT_COMPANION_STATE_DIR: state,
        AGENT_COMPANION_MEMORY_ROOT: corpus,
        CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true',
      };

      const init = runScript(SCRIPT, ['init', '--json'], { cwd: fx.dir, env, timeout: 60000 });
      const sync = runScript(SCRIPT, ['sync', '--json'], { cwd: fx.dir, env, timeout: 60000 });

      if (refused) {
        assert.notEqual(init.status, 0, 'init must refuse');
        assert.match(init.stderr, /Git for Windows cannot find a repository whose path is longer than 246/);
        assert.notEqual(sync.status, 0, 'sync must refuse');
        assert.match(sync.stderr, /Git for Windows cannot find a repository whose path is longer than 246/);
        assert.ok(!existsSync(vault), 'no partial vault may be left behind');
        assert.ok(!existsSync(state), 'sync may not write its lock or status file before refusing');
        return;
      }
      assert.equal(init.status, 0, `init failed: ${init.stderr}`);
      assert.equal(init.json?.created, true);
      assert.equal(sync.status, 0, `sync failed: ${sync.stderr}`);
      assert.equal(sync.json?.committed, true, sync.stdout);
      assert.ok(existsSync(join(vault, '.memory-vault.json')), 'marker written');
      const log = git(['-c', 'core.longpaths=true', '-C', vault, 'log', '--format=%ae|%s'], fx.dir, gitEnv);
      assert.match(log, /^memory-vault@agent-companion\.local\|memory-vault sync: /m);
      assert.match(log, /^memory-vault@agent-companion\.local\|memory-vault: initialize$/m);
    } finally {
      fx.cleanup();
    }
  });
}

test('a vault directory holding a repository but no marker is refused as a partial vault, not "inside a repository"', () => {
  const fx = makeFixture();
  try {
    const vault = join(fx.stateDir, 'memory-vault');
    mkdirSync(vault, { recursive: true });
    git(['init', '-q', '-b', 'main', vault], fx.dir);
    const res = runScript(SCRIPT, ['init', '--json'], {
      cwd: fx.dir, env: { CLAUDE_PLUGIN_OPTION_MEMORY_VAULT: 'true' },
    });
    assert.notEqual(res.status, 0, 'init must refuse');
    assert.match(res.stderr, /already holds a git repository but no memory-vault marker/);
    assert.doesNotMatch(res.stderr, /inside an existing git repository/);
    assert.ok(!existsSync(join(vault, '.memory-vault.json')), 'no marker may be written');
    assert.ok(!existsSync(join(vault, 'README.md')), 'nothing may be written into it');
  } finally {
    fx.cleanup();
  }
});
