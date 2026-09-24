#!/usr/bin/env node
// scripts/setup-hooks.mjs — one-line setup for this repo's pre-push gate.
//
// Points git at the repo-tracked .githooks/ directory instead of the
// per-clone, untracked .git/hooks/ directory, so .githooks/pre-push actually
// runs. See CONTRIBUTING.md for what the hook does.
//
// Usage:
//   node scripts/setup-hooks.mjs             sets core.hooksPath in this
//                                             repo's shared config (.git/config
//                                             for a plain clone; the config
//                                             SHARED by every worktree of a
//                                             worktree checkout).
//   node scripts/setup-hooks.mjs --worktree  scopes the setting to THIS
//                                             worktree only, via
//                                             `git config --worktree`. This
//                                             requires extensions.worktreeConfig
//                                             to already be enabled — a
//                                             shared-config change of its own
//                                             — and this script deliberately
//                                             does NOT enable that for you.
//                                             It errors with the exact command
//                                             to run instead.

import { spawnSync } from 'node:child_process';
import { cleanGitEnv } from '../plugins/agent-companion/scripts/lib/git-env.mjs';

// cleanGitEnv() strips the repo-LOCATING variables (GIT_DIR, GIT_WORK_TREE,
// GIT_COMMON_DIR, GIT_CONFIG, ...). Run from inside a git hook, a rebase
// --exec or any other git-spawned process, those point git at whatever
// repository started that process, so an unstripped `git config
// core.hooksPath` would write into THAT repository's config instead of the
// one this script was run in (the incident git-env.mjs documents).
function git(args) {
  return spawnSync('git', args, { encoding: 'utf8', windowsHide: true, env: cleanGitEnv(process.env) });
}

function main() {
  const useWorktreeScope = process.argv.includes('--worktree');

  if (useWorktreeScope) {
    const check = git(['config', 'extensions.worktreeConfig']);
    if (check.status !== 0 || check.stdout.trim() !== 'true') {
      console.error(
        'setup-hooks: --worktree requires extensions.worktreeConfig=true, which is\n'
        + 'itself a SHARED repo-config change (it affects every worktree of this\n'
        + 'repository, not just this one) — this script will not turn it on for you.\n'
        + 'If you understand that trade-off and want it anyway, run:\n'
        + '  git config extensions.worktreeConfig true\n'
        + 'then re-run: node scripts/setup-hooks.mjs --worktree',
      );
      process.exitCode = 1;
      return;
    }
    const res = git(['config', '--worktree', 'core.hooksPath', '.githooks']);
    if (res.status !== 0) {
      console.error(`setup-hooks: git config --worktree failed: ${(res.stderr || '').trim()}`);
      process.exitCode = 1;
      return;
    }
    console.log('setup-hooks: core.hooksPath=.githooks set for THIS worktree only.');
    return;
  }

  const res = git(['config', 'core.hooksPath', '.githooks']);
  if (res.status !== 0) {
    console.error(`setup-hooks: git config failed: ${(res.stderr || '').trim()}`);
    process.exitCode = 1;
    return;
  }
  console.log("setup-hooks: core.hooksPath=.githooks set (this repository's shared git config).");
}

main();
