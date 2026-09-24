// Env hygiene for every git child process the plugin spawns that could WRITE.
//
// WHY THIS EXISTS. git exports repository-LOCATING variables into the
// environment of anything it runs: hooks, `rebase --exec`, `bisect run`,
// `submodule foreach`, `!` aliases. Any process started underneath one of
// those (a test run from a pre-push hook, a scheduled scout launched from a
// session that was itself started by one) inherits them, and git honours them
// OVER both `-C <dir>` and the positional directory of `git init <dir>`:
//
//   GIT_DIR=<some repo>/.git  git init -b main <new dir>
//       -> "Reinitialized existing Git repository in <some repo>/.git", and
//          on Windows (a backslash path, so git cannot see the "/.git" suffix
//          it uses to guess the repo type) it writes core.bare = true.
//   GIT_DIR=<some repo>/.git  git -C <new dir> config user.name ...
//       -> writes the identity into <some repo>/.git/config.
//
// Both happened to a real checkout: memory-vault.mjs's ensureInit() turned a
// project's shared .git/config bare and stamped the vault's identity into it,
// and every command in the main checkout then failed with "this operation
// must be run in a work tree". With a forward-slash GIT_DIR the same sequence
// instead commits the vault's content into that project's history.
//
// WHAT IS STRIPPED. Only the variables that decide WHICH repository, work
// tree, index or object store git operates on. Everything else passes through
// on purpose:
//   - GIT_AUTHOR_* / GIT_COMMITTER_* — callers set these deliberately.
//   - GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n /
//     GIT_CONFIG_PARAMETERS — per-process config injection. The leak-sweep
//     canary relies on it (url.<base>.insteadOf) to clone without network.
//   - GIT_SSH_COMMAND, GIT_ASKPASS, GIT_TERMINAL_PROMPT — clone/fetch auth.
//   - GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM — hermetic
//     test setups point these at throwaway files.
// GIT_CONFIG (the legacy "`git config` reads and writes THIS file" variable)
// IS stripped: it redirects config writes, which is exactly the failure class.
//
// Windows env names are case-insensitive, so matching is too: a `Git_Dir`
// left behind would still be honoured by git.exe.
//
// This module never spawns anything itself except the read-only
// `rev-parse` in enclosingGitRepo(), which runs with the cleaned env.

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { execFileSyncHidden } from './proc.mjs';

export const REPO_LOCATING_GIT_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_QUARANTINE_PATH',
  'GIT_CONFIG',
]);

const STRIP = new Set(REPO_LOCATING_GIT_VARS);

export function isRepoLocatingGitVar(name) {
  return STRIP.has(String(name).toUpperCase());
}

// A NEW object: `env` with every repo-locating variable removed (in any
// case), then `overrides` laid on top. Overrides are the caller's explicit
// choice and are not filtered — but a repo-locating key in them is still
// refused, because nothing in this plugin has a reason to set one and a
// merged `{ ...process.env, X }` passed as `overrides` must not smuggle the
// inherited value back in.
export function cleanGitEnv(env = process.env, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || isRepoLocatingGitVar(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (isRepoLocatingGitVar(k)) continue;
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

// `git <args>` with the env cleaned and the window hidden. `opts.env`, when
// given, is cleaned the same way — so a caller passing `{ ...process.env, X }`
// cannot reintroduce an inherited GIT_DIR by accident.
export function gitClean(args, opts = {}) {
  return execFileSyncHidden('git', args, {
    encoding: 'utf8',
    ...opts,
    env: cleanGitEnv(opts.env || process.env),
  });
}

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

// A directory that IS a git dir: a `.git`, or a bare repository (HEAD file
// plus objects/ and refs/ — the same three things git's own
// is_git_directory() checks for).
function looksLikeGitDir(p) {
  return isFile(join(p, 'HEAD')) && isDir(join(p, 'objects')) && isDir(join(p, 'refs'));
}

export function samePath(a, b) {
  const n = (p) => resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// Is `target` (which need not exist yet) the same as, or inside, an existing
// git repository — either its work tree or its git dir? Returns
//   { kind: 'work-tree', root, via }   target is at/under a checkout at `root`
//   { kind: 'git-dir',   root, via }   target is at/under a git dir at `root`
//   null                               neither
// `via` says which check found it ('fs' or 'git').
//
// Two independent checks, and either one refusing is enough:
//   1. A filesystem walk from `target` to the root, needing no git at all and
//      reading no environment: any ancestor holding a `.git` entry (dir or
//      worktree/submodule gitfile), named `.git`, or shaped like a bare repo.
//   2. `git rev-parse --absolute-git-dir` from the nearest EXISTING ancestor,
//      with the cleaned env — git's own discovery, which also covers
//      layouts the walk does not model. git missing is not a failure: the
//      walk's answer stands.
export function enclosingGitRepo(target) {
  const start = resolve(String(target));
  let nearestExisting = null;
  for (let a = start; ; a = dirname(a)) {
    if (nearestExisting === null && isDir(a)) nearestExisting = a;
    if (basename(a).toLowerCase() === '.git') return { kind: 'git-dir', root: a, via: 'fs' };
    if (existsSync(join(a, '.git'))) return { kind: 'work-tree', root: a, via: 'fs' };
    if (looksLikeGitDir(a)) return { kind: 'git-dir', root: a, via: 'fs' };
    const up = dirname(a);
    if (up === a) break;
  }
  if (nearestExisting) {
    try {
      const gitDir = gitClean(['-C', nearestExisting, 'rev-parse', '--absolute-git-dir'], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
      }).trim();
      if (gitDir) {
        let top = '';
        try {
          top = gitClean(['-C', nearestExisting, 'rev-parse', '--show-toplevel'], {
            stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
          }).trim();
        } catch { /* inside a git dir, not a work tree: --show-toplevel fails */ }
        return top
          ? { kind: 'work-tree', root: top, via: 'git' }
          : { kind: 'git-dir', root: gitDir, via: 'git' };
      }
    } catch { /* not a repository, or git unavailable: the walk's null stands */ }
  }
  return null;
}
