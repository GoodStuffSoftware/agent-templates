#!/usr/bin/env node
// leak-sweep-canary.mjs — proves the publication-leak sweep actually catches
// something, rather than merely existing. Mirrors the guard-canary check's
// job (audit.mjs's guard-canary / routing-doc): a signal that never fires is
// indistinguishable from a guard that stopped working, so this builds a
// throwaway repo with a SYNTHETIC leak, sweeps it for real, and asserts the
// full lifecycle: hit reported -> fixed -> silent -> same hit re-appearing
// is deduped against a prior baseline (never re-fires a standing finding).
//
// Self-contained on purpose: only Node builtins, `git` on PATH, and its two
// sibling files (lib/publication-sweep.mjs, and a COPY of THIS repo's own
// scripts/leak-check.mjs, committed into the throwaway repo so the sweep
// exercises the real target-repo-runs-its-own-script path). No network,
// no plugin telemetry, no state-root writes — every artifact lives under a
// mkdtemp() directory that is removed before exit either way.
//
// Every leak string is assembled from small pieces at runtime rather than
// written as a literal, so this file itself never contains a real-looking
// private path or project name that the repo's OWN leak-check could flag.
//
// FULL mode exercises sweepRepo() — clone the configured repo's origin into
// a throwaway dir, then run its script from THAT clone. This is the LOCAL
// production path.
//
// REDUCED mode exercises sweepRepoInPlace() instead — NOT sweepRepo(). A
// cloud sandbox already runs from a checkout of its own source repo, and a
// clone-then-execute-from-the-clone (what sweepRepo() does, and what FULL
// mode tests) is exactly the "code from external" shape a cloud session's
// classifier can deny — confirmed live: the clone-based sweep was blocked
// in the actual cloud routine. So reduced mode builds a throwaway "checkout"
// directory directly (no clone involved at any point) and scans it in
// place, the same way the cloud production path does. Never git-clones.
//
// Usage:
//   node leak-sweep-canary.mjs             # full mode: clone + scan (local production path)
//   node leak-sweep-canary.mjs --reduced   # cloud-shaped mode: in-place scan, no clone, --no-derived
//
// Exit 0 = the sweep pipeline works. Non-zero + one-line reason on stderr =
// broken; treat that the same as a failed guard-canary (report it, do not
// paper over it as "sweep found nothing") — including a classifier DENIAL of
// this script itself: if the environment blocks this canary from running at
// all, that is "leak sweep broken", not silence (see the routine text).

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sweepRepo, sweepRepoInPlace, filterNew } from './lib/publication-sweep.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reduced = process.argv.includes('--reduced');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(res.stderr || res.error?.message || '').split('\n')[0]}`);
  }
  return res;
}

function fail(reason) {
  console.error(`leak-sweep-canary: FAILED — ${reason}`);
  process.exitCode = 1;
}

// Synthetic pieces — never a literal recognisable token in this source file.
const P = (...parts) => parts.join('');
const SYN_USER = P('zzz', 'canary', 'user');
const SYN_PROJECT = P('zzz', 'canary', 'proj', 'widgets'); // 4+ letters, not a GENERIC_WORDS segment
const PRIVATE_PATH_LEAK = P('C:', '\\Users\\', SYN_USER, '\\dev\\thing\\notes.txt');

const base = mkdtempSync(join(tmpdir(), 'ac-canary-'));
const bareDir = join(base, 'origin.git');
const workDir = join(base, 'work');
const devRootDir = join(base, 'devroot');

let exitReason = null;

try {
  // --- build the throwaway "origin" and a working clone ------------------
  run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
  mkdirSync(workDir, { recursive: true });
  run('git', ['init', '--quiet', '-b', 'main', workDir]);
  run('git', ['-C', workDir, 'remote', 'add', 'origin', bareDir]);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid', GIT_COMMITTER_NAME: 'canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid' };

  // Commit a copy of THIS repo's own leak-check.mjs — the sweep must exercise
  // the target repo running its OWN script, not this plugin's copy.
  const realLeakCheck = join(__dirname, '..', '..', '..', 'scripts', 'leak-check.mjs');
  if (!existsSync(realLeakCheck)) throw new Error(`cannot find scripts/leak-check.mjs at ${realLeakCheck} — canary must run from a full repo checkout`);
  mkdirSync(join(workDir, 'scripts'), { recursive: true });
  copyFileSync(realLeakCheck, join(workDir, 'scripts', 'leak-check.mjs'));

  // --- commit 1: the leak -------------------------------------------------
  const leakLines = [`private path: ${PRIVATE_PATH_LEAK}`];
  if (!reduced) leakLines.push(`derived project: ${SYN_PROJECT}`);
  writeFileSync(join(workDir, 'NOTES.md'), `${leakLines.join('\n')}\n`);
  run('git', ['-C', workDir, 'add', '-A'], { env: gitEnv });
  run('git', ['-C', workDir, 'commit', '--quiet', '-m', 'leak commit'], { env: gitEnv });
  run('git', ['-C', workDir, 'push', '--quiet', 'origin', 'main'], { env: gitEnv });

  if (!reduced) mkdirSync(join(devRootDir, SYN_PROJECT), { recursive: true });
  const sweepOpts = {
    env: { LEAK_CHECK_DEV_ROOT: devRootDir, LEAK_CHECK_CLAUDE_PROJECTS: join(base, 'no-claude-projects') },
  };
  // FULL mode: sweepRepo() clones bareDir into ITS OWN throwaway dir (the
  // local production path). REDUCED mode: sweepRepoInPlace() scans workDir
  // ITSELF — workDir's origin remote already points at bareDir, so it IS
  // "this checkout", and no clone happens anywhere in this branch.
  const doSweep = () => (reduced ? sweepRepoInPlace(bareDir, workDir, {}) : sweepRepo(bareDir, sweepOpts));

  // --- 1. hit reported -----------------------------------------------------
  const runA = await doSweep();
  if (runA.error) throw new Error(`sweep of the leak commit errored: ${runA.error}`);
  const wantLabels = reduced
    ? ['private-path:windows-profile']
    : ['private-path:windows-profile', 'derived-project-name'];
  for (const label of wantLabels) {
    if (!runA.hits.some((h) => h.label === label)) {
      fail(`leak commit swept clean of the "${label}" class — the sweep is not catching what it should`);
    }
  }
  if (process.exitCode) { exitReason = 'assertion failed on the leak commit'; throw new Error(exitReason); }

  // --- 2. baseline dedupe: same hits, second look = nothing new -----------
  const seen = new Set(runA.hits.map((h) => h.fingerprint));
  const freshAgainstOwnBaseline = filterNew(runA.hits, seen);
  if (freshAgainstOwnBaseline.length !== 0) {
    fail('filterNew() did not dedupe a hit against its own fingerprint — the "no daily re-fire" guarantee is broken');
    throw new Error('dedupe-self failed');
  }
  const freshAgainstEmptyBaseline = filterNew(runA.hits, []);
  if (freshAgainstEmptyBaseline.length !== runA.hits.length) {
    fail('filterNew() dropped hits against an EMPTY baseline — a first-ever run would wrongly report nothing');
    throw new Error('dedupe-empty failed');
  }

  // --- 3. commit a clean fix -> silence ------------------------------------
  writeFileSync(join(workDir, 'NOTES.md'), 'nothing to see here\n');
  run('git', ['-C', workDir, 'add', '-A'], { env: gitEnv });
  run('git', ['-C', workDir, 'commit', '--quiet', '-m', 'fix: remove the leak'], { env: gitEnv });
  run('git', ['-C', workDir, 'push', '--quiet', 'origin', 'main'], { env: gitEnv });
  const runB = await doSweep();
  if (runB.error) throw new Error(`sweep of the clean commit errored: ${runB.error}`);
  if (runB.hits.length !== 0) {
    fail(`clean commit still reported ${runB.hits.length} hit(s) — the sweep (or its target leak-check copy) is stuck`);
    throw new Error('not silent after fix');
  }

  // --- 4. the SAME leak reappears -> raw hits return, but they dedupe -----
  writeFileSync(join(workDir, 'NOTES.md'), `${leakLines.join('\n')}\n`);
  run('git', ['-C', workDir, 'add', '-A'], { env: gitEnv });
  run('git', ['-C', workDir, 'commit', '--quiet', '-m', 'leak returns'], { env: gitEnv });
  run('git', ['-C', workDir, 'push', '--quiet', 'origin', 'main'], { env: gitEnv });
  const runC = await doSweep();
  if (runC.error) throw new Error(`sweep of the reappeared leak errored: ${runC.error}`);
  if (runC.hits.length === 0) {
    fail('the leak reappeared but the sweep reported nothing at all — it is not re-scanning');
    throw new Error('did not re-detect raw hits');
  }
  const freshAgainstRealBaseline = filterNew(runC.hits, seen);
  if (freshAgainstRealBaseline.length !== 0) {
    fail(`a previously-accepted hit re-fired as "new" (${freshAgainstRealBaseline.length}) — the fingerprint is not stable across runs`);
    throw new Error('fingerprint instability');
  }

  if (!process.exitCode) {
    console.log(`leak-sweep-canary: OK — sweep pipeline works (${reduced ? 'reduced' : 'full'} mode).`);
  }
} catch (err) {
  if (!process.exitCode) {
    console.error(`leak-sweep-canary: FAILED — ${err.message || err}`);
    process.exitCode = 1;
  }
} finally {
  try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}
