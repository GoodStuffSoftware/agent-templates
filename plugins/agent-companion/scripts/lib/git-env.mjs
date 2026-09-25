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
//     (memory-vault.mjs strips them for its own calls; see isIdentityGitVar.)
//   - GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n /
//     GIT_CONFIG_PARAMETERS — per-process config injection. The leak-sweep
//     canary relies on it (url.<base>.insteadOf) to clone without network.
//   - GIT_SSH_COMMAND, GIT_ASKPASS, GIT_TERMINAL_PROMPT — clone/fetch auth.
//   - GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM — hermetic
//     test setups point these at throwaway files. (hermeticGitEnv() below
//     pins them to the null device for the memory vault.)
// GIT_CONFIG (the legacy "`git config` reads and writes THIS file" variable)
// IS stripped: it redirects config writes, which is exactly the failure class.
//
// Windows env names are case-insensitive, so matching is too: a `Git_Dir`
// left behind would still be honoured by git.exe.
//
// isolatedGitEnv() / gitIsolated() below go one step further and also drop
// that inherited config injection, for callers that never inject any.
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

// --- stricter: no inherited config injection either ------------------------
// gitClean() keeps per-process config injection on purpose (the leak-sweep
// canary clones through url.<base>.insteadOf set that way). A caller that
// never injects config itself — memory-vault.mjs — has no use for an
// INHERITED injection, and one is harmful there: a parent's
// `core.hooksPath` runs the parent's hooks on every vault commit, an
// `include.path` can rewrite the vault's author, `init.templateDir` /
// GIT_TEMPLATE_DIR seed the vault's .git from another repository's.
// isolatedGitEnv() is cleanGitEnv() minus those too.
const CONFIG_INJECTION = new Set(['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_TEMPLATE_DIR']);

export function isConfigInjectionGitVar(name) {
  const up = String(name).toUpperCase();
  return CONFIG_INJECTION.has(up) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(up);
}

export function isolatedGitEnv(env = process.env, overrides = {}) {
  const out = cleanGitEnv(env, overrides);
  for (const k of Object.keys(out)) if (isConfigInjectionGitVar(k)) delete out[k];
  return out;
}

// --- hermetic: no config from outside the repository at all ---------------
// isolatedGitEnv() still lets git read the global and system config files,
// and those are reachable from the environment in more ways than one:
// GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM name them outright, and HOME and
// XDG_CONFIG_HOME decide where git looks for $HOME/.gitconfig,
// $XDG_CONFIG_HOME/git/config and the default ignore and attributes files
// (git/ignore, git/attributes). A parent that sets any of them can inject
// any setting into a git child: an excludes file that silently leaves files
// out of a commit, a clean filter that runs a program on every add, a
// hooksPath. hermeticGitEnv() closes all of them for a caller that needs
// nothing from outside its own repository (memory-vault.mjs):
//   GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM  -> the null device
//   GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM -> 1
//   HOME, XDG_CONFIG_HOME                -> the null device, so every per-user
//                                           file git derives from them is a
//                                           path under a device that can hold
//                                           no files, and git finds none
// Every case spelling of those names is removed first (Windows env names
// are case-insensitive). The repository's own .git/config is still read, and
// `-c` on the command line still applies.
export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const HERMETIC_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  HOME: NULL_DEVICE,
  XDG_CONFIG_HOME: NULL_DEVICE,
});

const HERMETIC_NAMES = new Set(Object.keys(HERMETIC_GIT_ENV));

export function isHermeticGitVar(name) {
  return HERMETIC_NAMES.has(String(name).toUpperCase());
}

export function hermeticGitEnv(env = process.env) {
  const out = isolatedGitEnv(env);
  for (const k of Object.keys(out)) if (isHermeticGitVar(k)) delete out[k];
  return Object.assign(out, HERMETIC_GIT_ENV);
}

// --- identity and dates -----------------------------------------------------
// GIT_AUTHOR_{NAME,EMAIL,DATE} / GIT_COMMITTER_{NAME,EMAIL,DATE} override the
// repository's own user.* config and the clock on every commit. They pass
// through cleanGitEnv() and isolatedGitEnv() because callers elsewhere set them
// deliberately. memory-vault.mjs strips them for its own calls: an inherited
// value (a rebase --exec, a scripted commit with pinned dates) otherwise stamps
// someone else's name and a false date onto the backup's history.
export function isIdentityGitVar(name) {
  return /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/i.test(String(name));
}

// `git <args>` with isolatedGitEnv() and the window hidden.
export function gitIsolated(args, opts = {}) {
  return execFileSyncHidden('git', args, {
    encoding: 'utf8',
    ...opts,
    env: isolatedGitEnv(opts.env || process.env),
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
