// The pre-push gate must test the tree being PUSHED, never the checkout the
// hook script happens to live in.
//
// The bug this pins: core.hooksPath set to an ABSOLUTE path into the main
// checkout made every linked worktree run the main checkout's
// .githooks/pre-push, which rooted itself on $0 and so ran the MAIN
// checkout's scripts/ci-local.mjs and suites. A worktree branch was gated on
// the main checkout's code and its own tests never ran.
//
// The end-to-end tests build a throwaway repository with a linked worktree,
// put the REAL .githooks/pre-push in both, and give each tree a stub
// scripts/ci-local.mjs that only says which tree it belongs to.
//
// Every git child is hermetic: the real global and system git config never
// load (a developer's commit.gpgsign, hooksPath or templateDir would change
// the result), and the temp repo carries its own user.name and user.email.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanGitEnv } from '../../plugins/agent-companion/scripts/lib/git-env.mjs';
import { hookTreeMismatch } from '../ci-local.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(REPO, '.githooks', 'pre-push');
const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

let emptyConfig = null;
function hermeticEnv() {
  if (!emptyConfig) {
    const d = mkdtempSync(join(tmpdir(), 'pre-push-gitcfg-'));
    temps.push(d);
    emptyConfig = join(d, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
  }
  return cleanGitEnv(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
}

// --- hookTreeMismatch (pure) ---------------------------------------------

const id = (p) => p;

test('hookTreeMismatch: the same tree is a match', () => {
  assert.equal(hookTreeMismatch('/r/main', '/r/main', { real: id, platform: 'linux' }), null);
});

test('hookTreeMismatch: a different tree blocks and names both', () => {
  const m = hookTreeMismatch('/r/main', '/r/wt', { real: id, platform: 'linux' });
  assert.match(m, /belongs to .*main.*being pushed is .*wt/);
});

test('hookTreeMismatch: git failing to name the tree blocks', () => {
  assert.match(hookTreeMismatch('/r/main', null, { real: id, platform: 'linux' }), /could not find the work tree/);
});

// `platform` selects the path rules (win32 -> path.win32), so this runs on every OS.
test('hookTreeMismatch: on Windows, case and separator spelling do not count as a different tree', () => {
  assert.equal(hookTreeMismatch('C:\\Users\\X\\repo', 'c:/users/x/repo', { real: id, platform: 'win32' }), null);
  assert.match(hookTreeMismatch('C:\\Users\\X\\repo', 'C:\\Users\\X\\other', { real: id, platform: 'win32' }), /belongs to/);
});

test('hookTreeMismatch: on Linux/macOS, a differently-cased path IS a different tree', () => {
  assert.match(hookTreeMismatch('/r/Main', '/r/main', { real: id, platform: 'linux' }), /belongs to/);
});

test('hookTreeMismatch: two spellings of one directory (a symlink, an 8.3 name) are one tree', () => {
  const real = (p) => (p.endsWith('link') ? '/r/main' : p);
  assert.equal(hookTreeMismatch('/r/main', '/r/link', { real, platform: 'linux' }), null);
});

// --- the real hook, end to end ---------------------------------------------

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, env: hermeticEnv(), encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const STUB = `import { fileURLToPath } from 'node:url';
console.log('STUB-CI-LOCAL ' + JSON.stringify(fileURLToPath(import.meta.url)));
`;

// A main checkout with the real hook and a stub ci-local, a bare remote,
// and a linked worktree on its own branch. core.hooksPath is set ABSOLUTE,
// into the main checkout — the configuration that caused the bug.
function fixture({ worktreeHasCiLocal = true } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pre-push-tree-')));
  temps.push(root);
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  const remote = join(root, 'remote.git');
  mkdirSync(join(main, '.githooks'), { recursive: true });
  mkdirSync(join(main, 'scripts'), { recursive: true });
  copyFileSync(HOOK, join(main, '.githooks', 'pre-push'));
  chmodSync(join(main, '.githooks', 'pre-push'), 0o755);
  writeFileSync(join(main, 'scripts', 'ci-local.mjs'), STUB);
  git(root, ['init', '-q', '-b', 'main', main]);
  git(main, ['config', 'user.name', 't']);
  git(main, ['config', 'user.email', 't@example.invalid']);
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'base']);
  git(root, ['init', '-q', '--bare', remote]);
  git(main, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  if (!worktreeHasCiLocal) {
    git(wt, ['rm', '-q', 'scripts/ci-local.mjs']);
  } else {
    writeFileSync(join(wt, 'scripts', 'wt-marker.txt'), 'x');
    git(wt, ['add', '-A']);
  }
  git(wt, ['commit', '-q', '-m', 'feature change']);
  git(main, ['config', 'core.hooksPath', join(main, '.githooks')]);
  return { main, wt, remote };
}

function push(cwd, remote, gitArgs = []) {
  return spawnSync('git', [...gitArgs, 'push', remote, 'HEAD:refs/heads/feature'], {
    cwd, env: hermeticEnv(), encoding: 'utf8', windowsHide: true,
  });
}

// `git --git-dir=<wt's gitdir> --work-tree=<wt> push`, run from ANOTHER
// checkout: git does not chdir into the work tree, so only GIT_WORK_TREE names it.
const explicitTree = (main, wt) => [
  `--git-dir=${join(main, '.git', 'worktrees', 'wt')}`, `--work-tree=${wt}`,
];

const ranIn = (out) => {
  const m = /STUB-CI-LOCAL (".*")/.exec(out);
  return m ? JSON.parse(m[1]) : null;
};

test('pre-push hook: an absolute core.hooksPath into the main checkout still runs the PUSHED worktree\'s ci-local', () => {
  const { main, wt, remote } = fixture();
  const r = push(wt, remote);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  const ran = ranIn(out);
  assert.ok(ran, `the stub ci-local never ran:\n${out}`);
  assert.equal(realpathSync.native(ran).toLowerCase(), realpathSync.native(join(wt, 'scripts', 'ci-local.mjs')).toLowerCase(), out);
  assert.notEqual(realpathSync.native(ran).toLowerCase(), realpathSync.native(join(main, 'scripts', 'ci-local.mjs')).toLowerCase());
});

test('pre-push hook: from the main checkout itself, the main checkout\'s ci-local runs', () => {
  const { main, remote } = fixture();
  const r = push(main, remote);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.equal(realpathSync.native(ranIn(out)).toLowerCase(), realpathSync.native(join(main, 'scripts', 'ci-local.mjs')).toLowerCase(), out);
});

test('pre-push hook: a pushed tree with no ci-local is REJECTED, never gated on another checkout\'s copy', () => {
  const { wt, remote } = fixture({ worktreeHasCiLocal: false });
  const r = push(wt, remote);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.equal(ranIn(out), null, `no ci-local may run:\n${out}`);
  assert.match(out, /tree being pushed has no CI-local gate/);
});

test('pre-push hook: an explicit --work-tree, pushed from another checkout, gates THAT tree', () => {
  const { main, wt, remote } = fixture();
  const r = push(main, remote, explicitTree(main, wt));
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  const ran = ranIn(out);
  assert.ok(ran, `the stub ci-local never ran:\n${out}`);
  assert.equal(realpathSync.native(ran).toLowerCase(), realpathSync.native(join(wt, 'scripts', 'ci-local.mjs')).toLowerCase(), out);
});

test('pre-push hook: an explicit --work-tree with no ci-local is REJECTED, not gated on the cwd checkout', () => {
  const { main, wt, remote } = fixture({ worktreeHasCiLocal: false });
  const r = push(main, remote, explicitTree(main, wt));
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.equal(ranIn(out), null, `no ci-local may run:\n${out}`);
  assert.match(out, /tree being pushed has no CI-local gate/);
});

// The REAL ci-local (this checkout's), run from a different tree, must BLOCK
// before it reads stdin or runs anything.
test('ci-local --pre-push-hook: run from a different tree than its own, it BLOCKS (real mismatch guard)', () => {
  const { wt } = fixture();
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'ci-local.mjs'), '--pre-push-hook', 'origin', 'url'], {
    cwd: wt, env: hermeticEnv(), input: '', encoding: 'utf8', windowsHide: true,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /BLOCKED — this ci-local\.mjs belongs to .*but the tree being pushed is/);
});
