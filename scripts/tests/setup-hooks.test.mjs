// scripts/setup-hooks.mjs must write core.hooksPath into the repository it
// is RUN IN, even when an inherited GIT_DIR (a git hook, rebase --exec, ...)
// names a different repository. It strips the repo-locating variables with
// the shared cleanGitEnv() (plugins/agent-companion/scripts/lib/git-env.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanGitEnv } from '../../plugins/agent-companion/scripts/lib/git-env.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'setup-hooks.mjs');
const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function initRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  temps.push(repo);
  const r = spawnSync('git', ['init', '-q', repo], { env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr);
  return repo;
}

function localHooksPath(repo) {
  const r = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true,
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

for (const [label, leak] of [
  ['GIT_DIR (native separators)', (decoy) => ({ GIT_DIR: join(decoy, '.git') })],
  ['GIT_DIR (forward slashes) + GIT_WORK_TREE', (decoy) => ({
    GIT_DIR: join(decoy, '.git').replace(/\\/g, '/'), GIT_WORK_TREE: decoy.replace(/\\/g, '/'),
  })],
]) {
  test(`setup-hooks writes core.hooksPath into the repo it runs in, not the one an inherited ${label} names`, () => {
    const target = initRepo('setup-hooks-target-');
    const decoy = initRepo('setup-hooks-decoy-');
    const decoyConfigBefore = readFileSync(join(decoy, '.git', 'config'), 'utf8');
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: target, env: { ...process.env, ...leak(decoy) }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(localHooksPath(target), '.githooks');
    assert.equal(localHooksPath(decoy), null);
    assert.equal(readFileSync(join(decoy, '.git', 'config'), 'utf8'), decoyConfigBefore, "the decoy's config is byte-identical");
  });
}
