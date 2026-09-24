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
  mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync,
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

function realSpawnGit(args, opts) {
  return spawnSync('git', args, opts);
}

// Test-only seam: every git invocation this module makes goes through
// spawnGitImpl, so scripts/tests/*.test.mjs can record/observe them (e.g. to
// prove parity mode never runs `git tag` or `git update-ref` against the
// source repo) without monkeypatching node:child_process itself — its
// exports are non-configurable, so mock.method() on spawnSync fails outright
// (`TypeError: Cannot redefine property: spawnSync`); confirmed empirically.
let spawnGitImpl = realSpawnGit;

export function setGitSpawnerForTests(fn) {
  spawnGitImpl = fn || realSpawnGit;
}

function git(cwd, args) {
  const res = spawnGitImpl(args, {
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

// --ci-parity used to mark the commit under test with a temporary tag
// (`ci-local-parity-<pid>-<ts>`) in REPO_ROOT so a same-disk `git clone
// --branch <tag>` could reach it, then deleted the tag in a `finally`. A
// kill (Ctrl-C, taskkill) never reaches `finally`, so the tag was left
// behind — a ref written into the REAL repo's shared refs, which every
// worktree and session here shares. This repo is public and multi-worktree;
// parity mode must never write a ref into REPO_ROOT, killed or not.
//
// Fetching the exact commit by SHA with `uploadpack.allowAnySHA1InWant`
// reaches the same object without a ref existing for it at all — no tag,
// no branch, nothing to leak if the process dies mid-fetch. See
// fetchShaIntoTempRepo() below.

// Fetches exactly `sha` out of `repoRoot`'s local object store into a fresh
// repo at `dest` (created by the caller, e.g. via mkdtempSync), at the given
// depth — without creating or touching any ref in `repoRoot`.
//
// `git init` + `git fetch <path> <sha>` (rather than `git clone --branch`)
// is what makes this ref-free: a bare SHA is not something a normal fetch
// will serve unless the server side allows it, so
// `--upload-pack "git -c uploadpack.allowAnySHA1InWant=true upload-pack"`
// spawns upload-pack against REPO_ROOT with that one option turned on for
// this fetch only — REPO_ROOT's own on-disk config is never written to.
// Verified on both Git for Windows and Git Bash: fetching a SHA that is
// several commits behind every existing ref's tip succeeds, and
// `for-each-ref` on the source repo is unchanged afterward.
//
// -c core.autocrlf=input on the fresh repo keeps LF bytes as LF on checkout,
// matching a Linux CI runner regardless of this machine's global git
// config — same reason the old `clone` used `-c core.autocrlf=input`.
//
// depth === 0 means "no --depth flag", i.e. full history reachable from
// that one SHA — this mirrors what fetch-depth: 0 is actually FOR here (an
// object being reachable via `git show <sha>:<path>`), not a literal
// all-branches-and-tags mirror of actions/checkout's fetch-depth: 0, which
// would be far slower against a 90-branch local repo for no benefit to the
// thing being tested. Documented limitation, not an oversight.
export function fetchShaIntoTempRepo(dest, repoRoot, sha, depth) {
  // cwd is irrelevant to `git init <path>` (it takes the target as an
  // explicit argument) — repoRoot is passed only because git() requires a
  // cwd; nothing here is read from or written to it.
  git(repoRoot, ['init', '-q', dest]);
  git(dest, ['config', 'core.autocrlf', 'input']);

  const fetchArgs = ['fetch', '-q'];
  if (depth > 0) fetchArgs.push('--depth', String(depth));
  fetchArgs.push('--upload-pack', 'git -c uploadpack.allowAnySHA1InWant=true upload-pack', repoRoot, sha);
  git(dest, fetchArgs);
  git(dest, ['checkout', '-q', 'FETCH_HEAD']);

  // A plain `git fetch <path> <sha>` (no named remote) leaves `dest` with no
  // `origin` at all, unlike the old `clone`, which always created one.
  // leak-check.mjs's own-repo-name exemption (ownRepoNames()) reads `git
  // remote get-url origin` to recognize this repo's own public owner/repo
  // name (e.g. in README.md's install instructions) as NOT a leak; add an
  // `origin` pointing at REPO_ROOT's real origin (if it has one) so this
  // suite sees exactly what CI sees.
  try {
    const realOrigin = git(repoRoot, ['remote', 'get-url', 'origin']).trim();
    if (realOrigin) git(dest, ['remote', 'add', 'origin', realOrigin]);
  } catch {
    // REPO_ROOT has no `origin` remote configured — nothing to propagate.
  }
}

// One-time, local-only cleanup of tags a PRE-FIX version of this script left
// behind in REPO_ROOT (see the note above fetchShaIntoTempRepo). Runs on
// every invocation — cheap and a no-op once the leftovers are gone — and
// never touches the remote: `git tag -d` only ever removes a local ref.
export function cleanupLegacyParityTags(repoRoot) {
  let output;
  try {
    output = git(repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/tags/ci-local-parity-*']);
  } catch (err) {
    console.error(`ci-local: warning — could not check for legacy parity tags: ${err.message}`);
    return;
  }
  const refs = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const ref of refs) {
    const tagName = ref.replace(/^refs\/tags\//, '');
    try {
      git(repoRoot, ['tag', '-d', tagName]);
      console.log(`ci-local: removed leftover legacy parity tag ${tagName} (local only, never touched the remote).`);
    } catch (err) {
      console.error(`ci-local: warning — could not remove legacy parity tag ${tagName}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Interrupt handling and stale temp-dir cleanup
// ---------------------------------------------------------------------------

// Temp dirs currently "live" (created, not yet cleaned up) across every
// parity run this process has started. A signal handler can only clean up
// what it knows about, so every mkdtempSync'd dir used for parity is added
// here on creation and removed once rmDirWithRetries has run on it.
const activeTempDirs = new Set();

function trackTempDir(dir) {
  activeTempDirs.add(dir);
  return dir;
}

function untrackTempDir(dir) {
  rmDirWithRetries(dir);
  activeTempDirs.delete(dir);
}

let signalHandlersRegistered = false;

// Best-effort: on POSIX (and an interactive Ctrl-C on Windows) this runs
// before exit and removes whatever temp dirs this process created. A
// programmatic hard kill (taskkill /F, or Windows' unconditional
// termination of a signalled child process) bypasses any JS handler
// entirely — that gap is exactly why sweepStaleTempDirs() below exists as a
// second, independent line of defense that does not depend on this handler
// having run.
export function registerSignalHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      console.error(`\nci-local: caught ${signal} — removing ${activeTempDirs.size} temp dir(s) before exit.`);
      for (const dir of [...activeTempDirs]) untrackTempDir(dir);
      process.exit(1);
    });
  }
}

const STALE_TEMP_DIR_RE = /^ci-local-(?:peek|parity)-(\d+)-/;
const DEFAULT_STALE_SWEEP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour, per spec.

function staleSweepMaxAgeMs() {
  // Testability knob only: an integration test needs to prove a leftover
  // dir gets swept without actually waiting an hour. Not documented in
  // --help; normal use always gets the 1-hour default.
  const override = Number(process.env.CI_LOCAL_STALE_SWEEP_MAX_AGE_MS);
  return Number.isFinite(override) && override >= 0 ? override : DEFAULT_STALE_SWEEP_MAX_AGE_MS;
}

// Pure selection logic: given the basenames found under a temp root, decide
// which look like OUR leftover dirs (name matches the ci-local-<kind>-<pid>-
// pattern), are older than maxAgeMs, and whose owning pid is no longer
// alive. Every input is injected (no fs/process access in here) so this is
// unit-testable without touching a real filesystem or spawning anything.
export function selectStaleTempDirs(names, {
  now, maxAgeMs, getMtimeMs, isPidAlive,
}) {
  const stale = [];
  for (const name of names) {
    const m = STALE_TEMP_DIR_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    const mtimeMs = getMtimeMs(name);
    if (mtimeMs == null) continue;
    if (now - mtimeMs < maxAgeMs) continue;
    if (isPidAlive(pid)) continue;
    stale.push(name);
  }
  return stale;
}

function isPidAliveReal(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 sends nothing; it only checks whether the pid could be
    // signalled, i.e. whether it currently exists.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive. ESRCH (or
    // anything else) means it's gone.
    return err.code === 'EPERM';
  }
}

// Startup sweep: removes our own leftover temp dirs from a PRIOR run that
// never reached its `finally` (killed mid-run) or its signal handler
// (hard-killed). Runs on every invocation; a clean prior run leaves nothing
// to find, so this is a no-op in the common case.
export function sweepStaleTempDirs(root = tmpdir(), overrides = {}) {
  const {
    maxAgeMs = staleSweepMaxAgeMs(), now = Date.now(), isPidAlive = isPidAliveReal,
  } = overrides;
  let names;
  try {
    names = readdirSync(root);
  } catch (err) {
    console.error(`ci-local: warning — could not read ${root} for the stale temp-dir sweep: ${err.message}`);
    return [];
  }
  const stale = selectStaleTempDirs(names, {
    now,
    maxAgeMs,
    getMtimeMs: (name) => {
      try {
        return statSync(join(root, name)).mtimeMs;
      } catch {
        return null;
      }
    },
    isPidAlive,
  });
  for (const name of stale) {
    const full = join(root, name);
    rmDirWithRetries(full);
    console.log(`ci-local: startup sweep removed stale temp dir ${full} (owning process no longer running).`);
  }
  return stale;
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
  const sha = git(REPO_ROOT, ['rev-parse', ref]).trim();
  try {
    // Step 1: a depth-1 peek clone, purely to read the workflow file AS IT
    // EXISTED AT THIS COMMIT. That is what tells parity mode the real
    // checkout depth to use, instead of guessing or hardcoding one.
    const peekDir = trackTempDir(mkdtempSync(join(tmpdir(), `ci-local-peek-${process.pid}-`)));
    dirsToClean.push(peekDir);
    fetchShaIntoTempRepo(peekDir, REPO_ROOT, sha, 1);
    const depth = readCheckoutDepth(join(peekDir, suite.workflowFile));

    let workDir = peekDir;
    if (depth !== 1) {
      workDir = trackTempDir(mkdtempSync(join(tmpdir(), `ci-local-parity-${process.pid}-`)));
      dirsToClean.push(workDir);
      fetchShaIntoTempRepo(workDir, REPO_ROOT, sha, depth);
    }

    const env = hideFromPath(baseChildEnv(), CLAUDE_BIN_NAMES);
    return runNode(suite.command(workDir), workDir, env);
  } finally {
    for (const d of dirsToClean) untrackTempDir(d);
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
  registerSignalHandlers();
  sweepStaleTempDirs();
  cleanupLegacyParityTags(REPO_ROOT);
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
