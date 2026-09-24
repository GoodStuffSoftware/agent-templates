#!/usr/bin/env node
// scripts/ci-local.mjs — the ONE place that knows what "the suite" is. Both
// GitHub Actions workflows (.github/workflows/leak-check.yml and
// agent-companion-tests.yml) call this file for their actual work, and a
// contributor runs the exact same file locally before pushing (via
// `.githooks/pre-push`, or by hand). Local and CI cannot drift because there
// is only one command, not two copies of one.
//
// Background: overnight, a shallow-clone checkout, a missing `claude` CLI on
// the runner, and a sha-like token in a test comment produced 60+ red CI
// emails whose causes were each invisible locally until CI ran. This script
// exists so the same failures show up before a push, not after.
//
// Suites (mirror the two workflow files' steps 1:1):
//   scripts-tests           node --test scripts/tests/*.test.mjs
//   leak-check               node scripts/leak-check.mjs
//   agent-companion-tests    node --test plugins/agent-companion/tests/*.test.mjs
//
// Usage:
//   node scripts/ci-local.mjs                       run all three suites, in place
//   node scripts/ci-local.mjs --suite leak-check     run just one suite
//   node scripts/ci-local.mjs --ci-parity            all three, each from a fresh
//                                                     shallow clone that mirrors CI
//   node scripts/ci-local.mjs --ci-parity --suite agent-companion-tests --ref <sha>
//                                                     one suite, one historical ref
//   node scripts/ci-local.mjs --pre-push-hook        read pushed refs from stdin
//                                                     (git pre-push protocol) and
//                                                     run whatever they require
//
// Exit code: 0 if every suite that ran passed; 1 otherwise; 2 on a bad
// invocation (unknown flag/suite).

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Suite registry
// ---------------------------------------------------------------------------

function testFiles(cwd, relDir) {
  const dir = join(cwd, relDir);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => join(relDir, f));
}

export const SUITES = {
  'scripts-tests': {
    // Runs from leak-check.yml's first step.
    workflowFile: '.github/workflows/leak-check.yml',
    command: (cwd) => ['--test', ...testFiles(cwd, 'scripts/tests')],
  },
  'leak-check': {
    // Runs from leak-check.yml's second step.
    workflowFile: '.github/workflows/leak-check.yml',
    command: () => ['scripts/leak-check.mjs'],
  },
  'agent-companion-tests': {
    // Runs from agent-companion-tests.yml's only step. This is the suite
    // that needed fetch-depth: 0 (see readCheckoutDepth() below) because a
    // bench task-pack fixture pins a historical commit and reads it with
    // `git show <sha>:<path>`, which a depth-1 clone can't resolve.
    workflowFile: '.github/workflows/agent-companion-tests.yml',
    command: (cwd) => ['--test', ...testFiles(cwd, 'plugins/agent-companion/tests')],
  },
};

export const SUITE_NAMES = Object.keys(SUITES);
export const DEFAULT_ORDER = ['scripts-tests', 'leak-check', 'agent-companion-tests'];

// ---------------------------------------------------------------------------
// Argument parsing (exported and unit-tested — see tests/ci-local-args.test.mjs)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    suites: null, ciParity: false, prePushHook: false, ref: 'HEAD', help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--suite') {
      const name = argv[i += 1];
      if (!name) throw new Error('--suite requires a value');
      if (!SUITE_NAMES.includes(name)) {
        throw new Error(`unknown suite "${name}" (known: ${SUITE_NAMES.join(', ')})`);
      }
      opts.suites = opts.suites || [];
      opts.suites.push(name);
    } else if (a === '--ci-parity') {
      opts.ciParity = true;
    } else if (a === '--pre-push-hook') {
      opts.prePushHook = true;
    } else if (a === '--ref') {
      const ref = argv[i += 1];
      if (!ref) throw new Error('--ref requires a value');
      opts.ref = ref;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument "${a}" (see --help)`);
    }
  }
  if (!opts.suites) opts.suites = [...DEFAULT_ORDER];
  return opts;
}

function printHelp() {
  console.log(`ci-local.mjs — shared entry point for this repo's CI suites

  --suite <name>       run one suite (repeatable). One of: ${SUITE_NAMES.join(', ')}
                        default: run all three, in order.
  --ci-parity           run from a fresh shallow clone that mirrors GitHub
                        Actions: claude hidden from PATH, checkout depth read
                        from the relevant workflow file, LF line endings.
  --ref <ref>           with --ci-parity, the ref/sha to test (default: HEAD).
  --pre-push-hook       read pushed refs from stdin (git pre-push protocol)
                        and run whatever they require. Used by .githooks/pre-push.
`);
}

// ---------------------------------------------------------------------------
// Ref classification for the pre-push hook (exported and unit-tested)
// ---------------------------------------------------------------------------

// wip/** and backup/** are never gated on push (see CONTRIBUTING.md); main
// and release/** get the full --ci-parity treatment; everything else gets
// the normal (in-place) suite.
export function classifyRef(refName) {
  const branch = String(refName || '').replace(/^refs\/heads\//, '');
  if (branch.startsWith('wip/') || branch.startsWith('backup/')) return 'skip';
  if (branch === 'main' || branch.startsWith('release/')) return 'parity';
  return 'normal';
}

// git's pre-push hook protocol: one line per pushed ref, whitespace-separated
// "<local ref> <local sha1> <remote ref> <remote sha1>". A push that deletes
// a ref sends local-sha1 as 40 zeros and local-ref as "(delete)"; those lines
// classify like any other ref name and simply run nothing useful against a
// deleted ref's sha, so callers should treat an all-zero local sha as a
// delete and skip it.
export function parsePrePushStdin(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return {
        localRef, localSha, remoteRef, remoteSha,
      };
    });
}

export function isDeletedRef(localSha) {
  return /^0+$/.test(String(localSha || ''));
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Running as a git hook (pre-push, etc.) means git already set GIT_DIR,
// GIT_WORK_TREE, GIT_CONFIG_PARAMETERS and friends in OUR process env, so
// that every plain `git` command the hook itself runs targets the repo the
// push came from — correct for git's own purposes, but fatal for us: every
// child process we spawn (a suite's own `git` calls, a suite's own clones,
// our own clone-and-tag machinery) inherits that same env, so a `git`
// command run with a DIFFERENT cwd (a fresh temp clone) still gets pointed
// at the ORIGINAL repo's gitdir regardless of cwd or `-C`, producing
// "fatal: this operation must be run in a work tree" and cross-repo
// remote/tag collisions inside what should be an independent checkout.
// Strip every GIT_*-prefixed var before spawning anything, so cwd-based git
// discovery works the way a suite run directly (not from a hook) expects.
export function stripGitEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!/^GIT_/i.test(k)) out[k] = v;
  }
  return out;
}

function baseChildEnv() {
  return stripGitEnv(process.env);
}

function runNode(args, cwd, env) {
  const res = spawnSync(process.execPath, args, {
    cwd, env: env || baseChildEnv(), stdio: 'inherit', windowsHide: true,
  });
  if (res.error) {
    console.error(`ci-local: failed to run node ${args.join(' ')}: ${res.error.message}`);
    return { status: 1 };
  }
  return { status: res.status === null ? 1 : res.status };
}

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd, env: baseChildEnv(), encoding: 'utf8', windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.error?.message || '').trim()}`);
  }
  return res.stdout;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows can hold a brief lock on a just-used file (git.exe / node.exe
// handles closing asynchronously); retry the removal a few times rather than
// failing the whole run over cleanup.
function rmDirWithRetries(dir, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        console.error(`ci-local: warning — could not remove temp dir ${dir}: ${err.message}`);
        return;
      }
      sleepSync(150 * (i + 1));
    }
  }
}

// Strip any PATH entry that would resolve one of `names` — used to hide
// `claude` the way the GitHub Actions runner lacks it.
function hideFromPath(env, names) {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const dirs = String(env[pathKey] || '').split(delimiter).filter(Boolean);
  const kept = dirs.filter((dir) => !names.some((name) => existsSync(join(dir, name))));
  return { ...env, [pathKey]: kept.join(delimiter) };
}

const CLAUDE_BIN_NAMES = ['claude', 'claude.exe', 'claude.cmd', 'claude.ps1'];

// Read the checkout depth a workflow file asks for, at the given path. A
// missing `fetch-depth:` line means actions/checkout's own default, which is
// 1 (shallow). This is a small regex, not a YAML parser — each workflow file
// here has exactly one Checkout step, so this is deliberately simple rather
// than pulling in a YAML dependency for one integer.
export function readCheckoutDepth(workflowPath) {
  if (!existsSync(workflowPath)) return 1;
  const text = readFileSync(workflowPath, 'utf8');
  const m = text.match(/fetch-depth:\s*(\d+)/);
  return m ? Number(m[1]) : 1;
}

function createTempTag(repoRoot, ref) {
  const sha = git(repoRoot, ['rev-parse', ref]).trim();
  const tagName = `ci-local-parity-${process.pid}-${Date.now()}`;
  git(repoRoot, ['tag', tagName, sha]);
  return { sha, tagName };
}

function deleteTempTag(repoRoot, tagName) {
  try {
    git(repoRoot, ['tag', '-d', tagName]);
  } catch (err) {
    console.error(`ci-local: warning — could not remove temp tag ${tagName}: ${err.message}`);
  }
}

// Clones REPO_ROOT (never the real origin — this all runs offline against
// the local object store) at the given tag, at the given depth. --no-local
// forces the smart-transport negotiation path instead of the hardlink
// fast-path a same-disk clone would otherwise take, so --depth is actually
// honored the way it would be against a real remote. -c core.autocrlf=input
// keeps LF bytes as LF on checkout, matching a Linux CI runner regardless of
// this machine's global git config.
//
// depth === 0 means "no --depth flag", i.e. full history for that one
// branch/tag — this mirrors what fetch-depth: 0 is actually FOR here (an
// object being reachable via `git show <sha>:<path>`), not a literal
// all-branches-and-tags mirror of actions/checkout's fetch-depth: 0, which
// would be far slower against a 90-branch local repo for no benefit to the
// thing being tested. Documented limitation, not an oversight.
function shallowCloneRef(dest, repoRoot, tagName, depth) {
  const args = ['clone', '--no-local', '-c', 'core.autocrlf=input', '--branch', tagName, '--single-branch'];
  if (depth > 0) args.push('--depth', String(depth));
  args.push(repoRoot, dest);
  const res = spawnSync('git', args, { env: baseChildEnv(), encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git clone (parity, depth=${depth}) failed: ${(res.stderr || '').trim()}`);
  }
  // We just cloned from REPO_ROOT's local path, so `origin` in the clone
  // points at that local path, not the real GitHub remote — unlike a real
  // CI checkout, which clones from the actual repo URL. leak-check.mjs's
  // own-repo-name exemption (ownRepoNames()) reads `git remote get-url
  // origin` to recognize this repo's own public owner/repo name (e.g. in
  // README.md's install instructions) as NOT a leak; left pointing at a
  // local path, that exemption can't parse an owner/repo out of it and
  // leak-check falsely flags the repo's own name. Point the clone's origin
  // at REPO_ROOT's real origin (if it has one) so this suite sees exactly
  // what CI sees.
  try {
    const realOrigin = git(repoRoot, ['remote', 'get-url', 'origin']).trim();
    if (realOrigin) git(dest, ['remote', 'set-url', 'origin', realOrigin]);
  } catch {
    // REPO_ROOT has no `origin` remote configured — nothing to propagate.
  }
}

// ---------------------------------------------------------------------------
// Suite execution
// ---------------------------------------------------------------------------

function runSuiteLocal(name) {
  const suite = SUITES[name];
  return runNode(suite.command(REPO_ROOT), REPO_ROOT, baseChildEnv());
}

function runSuiteParity(name, ref) {
  const suite = SUITES[name];
  const dirsToClean = [];
  const { tagName } = createTempTag(REPO_ROOT, ref);
  try {
    // Step 1: a depth-1 peek clone, purely to read the workflow file AS IT
    // EXISTED AT THIS COMMIT. That is what tells parity mode the real
    // checkout depth to use, instead of guessing or hardcoding one.
    const peekDir = mkdtempSync(join(tmpdir(), 'ci-local-peek-'));
    dirsToClean.push(peekDir);
    shallowCloneRef(peekDir, REPO_ROOT, tagName, 1);
    const depth = readCheckoutDepth(join(peekDir, suite.workflowFile));

    let workDir = peekDir;
    if (depth !== 1) {
      workDir = mkdtempSync(join(tmpdir(), 'ci-local-parity-'));
      dirsToClean.push(workDir);
      shallowCloneRef(workDir, REPO_ROOT, tagName, depth);
    }

    const env = hideFromPath(baseChildEnv(), CLAUDE_BIN_NAMES);
    return runNode(suite.command(workDir), workDir, env);
  } finally {
    deleteTempTag(REPO_ROOT, tagName);
    for (const d of dirsToClean) rmDirWithRetries(d);
  }
}

function runSuite(name, ciParity, ref) {
  return ciParity ? runSuiteParity(name, ref) : runSuiteLocal(name);
}

function printSummary(results) {
  console.log('\nci-local summary:');
  for (const r of results) {
    console.log(`  ${r.status === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
}

// ---------------------------------------------------------------------------
// pre-push hook mode
// ---------------------------------------------------------------------------

function runPrePushHook() {
  let stdinText = '';
  try {
    stdinText = readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`ci-local pre-push: could not read stdin: ${err.message}`);
    return 1;
  }
  const refs = parsePrePushStdin(stdinText).filter((r) => !isDeletedRef(r.localSha));
  if (refs.length === 0) {
    console.log('ci-local pre-push: no refs to check.');
    return 0;
  }

  let overallStatus = 0;
  const ran = new Set();
  for (const { remoteRef, localSha } of refs) {
    const cls = classifyRef(remoteRef);
    if (cls === 'skip') {
      console.log(`ci-local pre-push: skipping ${remoteRef} (wip/** or backup/**, per CONTRIBUTING.md).`);
      continue;
    }
    const key = `${cls}:${localSha}`;
    if (ran.has(key)) continue;
    ran.add(key);
    console.log(`\nci-local pre-push: ${remoteRef} -> ${cls === 'parity' ? 'full suite, --ci-parity' : 'full suite'} against ${localSha}.`);
    const results = DEFAULT_ORDER.map((name) => ({
      name,
      ...runSuite(name, cls === 'parity', localSha),
    }));
    printSummary(results);
    if (results.some((r) => r.status !== 0)) overallStatus = 1;
  }

  if (overallStatus !== 0) {
    console.error('\nci-local pre-push: BLOCKED — fix the failing suite(s) above before pushing.');
    console.error('Never use --no-verify on a real branch; see CONTRIBUTING.md.');
  } else {
    console.log('\nci-local pre-push: all required checks passed.');
  }
  return overallStatus;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ci-local: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (opts.prePushHook) {
    process.exitCode = runPrePushHook();
    return;
  }
  const results = opts.suites.map((name) => ({
    name,
    ...(() => {
      console.log(`\n=== ci-local: ${name}${opts.ciParity ? ' (--ci-parity)' : ''} ===`);
      return runSuite(name, opts.ciParity, opts.ref);
    })(),
  }));
  printSummary(results);
  process.exitCode = results.some((r) => r.status !== 0) ? 1 : 0;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (isMain) main();
