// Publication-leak sweep — the scout's after-the-fact backstop for a leak
// that reached origin despite the local pre-push gate. Covers the library
// directly (sweepRepo/filterNew/fingerprintHit), the detect.mjs signal
// end-to-end (empty option = silent; a real hit fires once, then dedupes
// against the baseline), and the canary script that proves the whole
// pipeline still works.
//
// No network: every "repo" here is a local bare git repo built in a temp
// dir, exactly like leak-sweep-canary.mjs builds its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import {
  sweepRepo, sweepRepoInPlace, sweepAllCloud, isSessionCheckout, normalizeGitUrl,
  filterNew, fingerprintHit, STRICT_MARKER_FILE, redactRepoIdentifiers,
} from '../scripts/lib/publication-sweep.mjs';

const REAL_LEAK_CHECK = join(PLUGIN_ROOT, '..', '..', 'scripts', 'leak-check.mjs');

// Assembled from pieces at runtime — a literal here would trip this repo's
// OWN leak-check (the private-path pattern does not recognise "zzztestuser"
// as a placeholder, same reason leak-sweep-canary.mjs builds its strings
// this way).
const SYNTHETIC_LEAK_LINE = ['private path: C:', '\\Users\\', 'zzz', 'testuser', '\\dev\\thing'].join('');

function git(args, cwd, env) {
  const res = spawnSync('git', args, {
    cwd, encoding: 'utf8', env: cleanGitEnv(env || process.env), timeout: 30000, windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// Target-script execution requires the clone source to be a github.com URL
// with a trusted owner (M2). Tests reach a LOCAL bare repo under such a URL
// by having git rewrite the URL prefix for this process only
// (url.<base>.insteadOf via GIT_CONFIG_* env) — no network, and the real
// ownership gate runs unmodified.
async function withGithubAlias(bareDir, url, fn) {
  const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(bareDir).href}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = url;
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// A bare origin whose default branch holds `files` (path -> content).
function buildRepoWith(files) {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  const bareDir = join(base, 'origin.git');
  const workDir = join(base, 'work');
  git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
  mkdirSync(workDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main', workDir]);
  git(['remote', 'add', 'origin', bareDir], workDir);
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(workDir, rel, '..'), { recursive: true });
    writeFileSync(join(workDir, rel), body);
  }
  git(['add', '-A'], workDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
  git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
  return { base, bareDir, workDir, gitEnv, cleanup: () => { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } } };
}

// A target script that proves it ran by emitting a hit only it produces.
const MARKER_SCRIPT = [
  '#!/usr/bin/env node',
  'console.log("  NOTES.md:1  [zb-own-script-ran]  x  ::  x");',
  'console.log("leak-check: FAILED — 1 hit(s)");',
  'process.exitCode = 1;',
  '',
].join('\n');

// Build a throwaway bare "origin" whose default branch's NOTES.md carries a
// synthetic (never a real-looking) private-path leak, plus a copy of this
// repo's own leak-check.mjs so the sweep exercises "the target runs its own
// script". Returns { base, bareDir, workDir, cleanup, gitEnv }.
function buildLeakyRepo(leakLine = SYNTHETIC_LEAK_LINE) {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  const bareDir = join(base, 'origin.git');
  const workDir = join(base, 'work');
  git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
  mkdirSync(workDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main', workDir]);
  git(['remote', 'add', 'origin', bareDir], workDir);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  mkdirSync(join(workDir, 'scripts'), { recursive: true });
  copyFileSync(REAL_LEAK_CHECK, join(workDir, 'scripts', 'leak-check.mjs'));
  writeFileSync(join(workDir, 'NOTES.md'), `${leakLine}\n`);
  git(['add', '-A'], workDir, gitEnv);
  git(['commit', '--quiet', '-m', 'leak'], workDir, gitEnv);
  git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
  return {
    base, bareDir, workDir, gitEnv,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } },
  };
}

test('sweepRepo: finds a private-path leak on the published default branch', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepo(repo.bareDir, {});
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'), 'expected a private-path hit');
    for (const h of result.hits) assert.equal(typeof h.fingerprint, 'string');
  } finally { repo.cleanup(); }
});

test('sweepRepo: reduced mode still catches the private-path class', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepo(repo.bareDir, { reduced: true });
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
  } finally { repo.cleanup(); }
});

test('sweepRepo: a clean repo sweeps silent', async () => {
  const repo = buildLeakyRepo('nothing to see here');
  try {
    const result = await sweepRepo(repo.bareDir, {});
    assert.equal(result.error, null);
    assert.deepEqual(result.hits, []);
  } finally { repo.cleanup(); }
});

test('sweepRepo: a repo with NO leak-check of its own is still scanned, by the plugin\'s own generic checker', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    // No scripts/ directory at all — this repo ships no leak-check.mjs.
    writeFileSync(join(workDir, 'README.md'), `no leak-check here, but here's a path: ${SYNTHETIC_LEAK_LINE}\n`);
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
    const result = await sweepRepo(bareDir, {});
    assert.equal(result.error, null, 'no own checker is normal, not an error');
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'), 'the plugin\'s own generic checker must still catch it');
  } finally { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
});

// --- item 2: never execute a swept repo's own script by default ------------

test('item 2: a repo WITH its own leak-check.mjs is NOT executed by default (no strictRepoUrls/allowedOwners) — plugin checker only', async () => {
  const repo = buildLeakyRepo(); // buildLeakyRepo() commits a copy of THIS repo's own leak-check.mjs
  try {
    const result = await sweepRepo(repo.bareDir, {}); // no strictRepoUrls, no allowedOwners
    assert.equal(result.error, null);
    // Universal class (private-path) still fires via the PLUGIN checker —
    // proves a real checker ran — but the target's own script never did.
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
  } finally { repo.cleanup(); }
});

test('item 2: mayExecuteTargetScript requires BOTH explicit listing AND a verified owner', async () => {
  const { mayExecuteTargetScript } = await import('../scripts/lib/publication-sweep.mjs');
  const repo = 'https://github.com/someowner/somerepo.git';
  assert.equal(mayExecuteTargetScript(repo, {}), false, 'neither listed nor owned');
  assert.equal(mayExecuteTargetScript(repo, { strictRepoUrls: [repo] }), false, 'listed but no allowedOwners at all');
  assert.equal(mayExecuteTargetScript(repo, { strictRepoUrls: [repo], allowedOwners: new Set(['someoneelse']) }), false, 'listed but wrong owner');
  assert.equal(mayExecuteTargetScript(repo, { allowedOwners: new Set(['someowner']) }), false, 'owned but not explicitly listed');
  assert.equal(mayExecuteTargetScript(repo, { strictRepoUrls: [repo], allowedOwners: new Set(['someowner']) }), true, 'listed AND owned');
});

test('item 2: scrubbedEnv keeps only PATH/HOME/TEMP/SYSTEMROOT-shaped vars and LEAK_CHECK_* — never arbitrary env', async () => {
  const { scrubbedEnv } = await import('../scripts/lib/publication-sweep.mjs');
  const env = scrubbedEnv({ LEAK_CHECK_DEV_ROOT: '/tmp/x', SOME_SECRET_TOKEN: 'should-not-appear' });
  assert.equal(env.LEAK_CHECK_DEV_ROOT, '/tmp/x');
  assert.equal(env.SOME_SECRET_TOKEN, undefined);
  const allowed = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'ComSpec', 'windir', 'LEAK_CHECK_DEV_ROOT']);
  for (const k of Object.keys(env)) assert.ok(allowed.has(k), `unexpected key in scrubbed env: ${k}`);
});

// --- item 6: a checker exception must never read as clean -------------------

test('item 6: a plugin-checker crash reports a sweep_error naming the repo, not silent hits: []', async () => {
  const repo = buildLeakyRepo('nothing to see here');
  try {
    // Force a real, reachable exception in the plugin checker: an
    // unreadable tokenFile makes deriveTokens() throw "cannot read token
    // file ...", which scanRepo()/runPluginChecker() do not catch.
    const badTokenFile = join(repo.base, 'does-not-exist-tokens.txt');
    const result = await sweepRepo(repo.bareDir, { tokenFile: badTokenFile });
    assert.ok(result.error, 'a checker exception must surface as .error, not read as clean');
    assert.match(result.error, /plugin checker crashed/i);
  } finally { repo.cleanup(); }
});

test('item 6: a bad target-script invocation (exit 2) does not stop the plugin checker from running', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    // A "leak-check.mjs" that always exits 2 (a bad invocation), plus a real
    // private-path leak the PLUGIN checker must still catch.
    mkdirSync(join(workDir, 'scripts'), { recursive: true });
    writeFileSync(join(workDir, 'scripts', 'leak-check.mjs'), '#!/usr/bin/env node\nprocess.exitCode = 2;\n');
    writeFileSync(join(workDir, 'NOTES.md'), `${SYNTHETIC_LEAK_LINE}\n`);
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);
    const url = 'https://github.com/zbtrusted/zbexit2.git';
    const result = await withGithubAlias(bareDir, url, () => sweepRepo(url, {
      strictRepoUrls: [url],
      allowedOwners: new Set(['zbtrusted']),
    }));
    assert.ok(result.error, 'the exit-2 must be reported');
    assert.match(result.error, /exit 2/);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'), 'the plugin checker must still have run and found the real leak');
  } finally { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
});

test('sweepRepo: an unreachable repo reports an error and never throws', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const result = await sweepRepo(join(base, 'does-not-exist.git'), { timeout: 5000 });
    assert.equal(result.hits.length, 0);
    assert.ok(result.error);
  } finally { try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ } }
});

test('filterNew / fingerprintHit: stable across runs, dedupes a previously-seen hit', () => {
  const hitA = { rel: 'NOTES.md', line: 1, label: 'private-path:windows-profile', token: 'x', text: 'x' };
  const fp1 = fingerprintHit('repo-a', hitA);
  const fp2 = fingerprintHit('repo-a', hitA);
  assert.equal(fp1, fp2, 'fingerprint must be stable for identical repo+rel+line+label');
  const fpOtherRepo = fingerprintHit('repo-b', hitA);
  assert.notEqual(fp1, fpOtherRepo, 'fingerprint must vary by repo');

  const hits = [{ ...hitA, fingerprint: fp1 }];
  assert.deepEqual(filterNew(hits, []), hits, 'empty baseline: everything is new');
  assert.deepEqual(filterNew(hits, [fp1]), [], 'seen fingerprint: nothing new');
  assert.deepEqual(filterNew(hits, new Set([fp1])), [], 'accepts a Set too');
});

test('item 7: fingerprint tolerates a LINE SHIFT (same repo+file+label+token, different line)', () => {
  const hitLine1 = { rel: 'NOTES.md', line: 1, label: 'private-path:windows-profile', token: 'x', text: 'x' };
  const hitLine9 = { rel: 'NOTES.md', line: 9, label: 'private-path:windows-profile', token: 'x', text: 'x (shifted by an unrelated edit)' };
  assert.equal(fingerprintHit('repo-a', hitLine1), fingerprintHit('repo-a', hitLine9), 'a line shift alone must not change the fingerprint');

  const hitDifferentToken = { ...hitLine1, token: 'y' };
  assert.notEqual(fingerprintHit('repo-a', hitLine1), fingerprintHit('repo-a', hitDifferentToken), 'a different token at the SAME location must still fire as new');
});

test('item 7: filterNewOrStale re-fires a still-present hit once its baseline record turns stale (weekly cadence)', async () => {
  const { filterNewOrStale } = await import('../scripts/lib/publication-sweep.mjs');
  const hit = { rel: 'NOTES.md', line: 1, label: 'private-path:windows-profile', token: 'x', text: 'x', fingerprint: fingerprintHit('repo-a', { rel: 'NOTES.md', line: 1, label: 'private-path:windows-profile', token: 'x' }) };
  const now = Date.parse('2026-06-15T00:00:00Z');
  const recentSeen = { [hit.fingerprint]: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() }; // 2 days old
  assert.deepEqual(filterNewOrStale([hit], recentSeen, { maxAgeDays: 7, now }), [], 'a recently-accepted hit must not re-fire');
  const staleSeen = { [hit.fingerprint]: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() }; // 8 days old
  assert.deepEqual(filterNewOrStale([hit], staleSeen, { maxAgeDays: 7, now }), [hit], 'an 8-day-old accepted hit must re-fire (weekly cadence)');
  assert.deepEqual(filterNewOrStale([hit], {}, { maxAgeDays: 7, now }), [hit], 'never-seen is always new');
});

// --- second adversarial review: M2, M4, L1 ---------------------------------

test('M2: a local checkout under a dir named like a trusted owner, whose origin is a stranger\'s repo, is NOT executable', async () => {
  const { mayExecuteTargetScript, resolveCloneSource, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  const base = mkdtempSync(join(tmpdir(), 'ac-m2-'));
  try {
    const checkout = join(base, 'zbtrusted', 'zbrepo');
    mkdirSync(checkout, { recursive: true });
    git(['init', '--quiet', '-b', 'main'], checkout);
    git(['remote', 'add', 'origin', 'https://github.com/zbstranger/zbrepo.git'], checkout);
    assert.equal(ownerOf(checkout), null, 'a local path has no owner — its directory name proves nothing');
    assert.equal(ownerOf(resolveCloneSource(checkout)), 'zbstranger', 'the owner comes from the real origin');
    const opts = { strictRepoUrls: [checkout], allowedOwners: new Set(['zbtrusted']) };
    assert.equal(mayExecuteTargetScript(checkout, opts), false, 'trusted-looking dir name + stranger origin = never executed');
    assert.equal(mayExecuteTargetScript(checkout, { ...opts, allowedOwners: new Set(['zbstranger']) }), true,
      'the same entry IS executable once the REAL origin owner is the trusted one');
    // Non-github hosts and bare paths never have an owner.
    assert.equal(ownerOf('https://gitlab.com/zbtrusted/zbrepo.git'), null);
    assert.equal(ownerOf(join(base, 'zbtrusted', 'origin.git')), null);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test('M2: end to end — a listed stranger-owned repo\'s script never runs; a trusted-owner one does', async () => {
  const repo = buildRepoWith({ 'scripts/leak-check.mjs': MARKER_SCRIPT, 'NOTES.md': 'clean\n' });
  try {
    const strangerUrl = 'https://github.com/zbstranger/zbrepo.git';
    const denied = await withGithubAlias(repo.bareDir, strangerUrl, () => sweepRepo(strangerUrl, {
      strictRepoUrls: [strangerUrl], allowedOwners: new Set(['zbtrusted']), devRoots: [],
    }));
    assert.equal(denied.error, null, denied.error);
    assert.ok(!denied.hits.some((h) => h.label === 'zb-own-script-ran'), 'the stranger\'s script must not have executed');

    const trustedUrl = 'https://github.com/zbtrusted/zbrepo.git';
    const allowed = await withGithubAlias(repo.bareDir, trustedUrl, () => sweepRepo(trustedUrl, {
      strictRepoUrls: [trustedUrl], allowedOwners: new Set(['zbtrusted']), devRoots: [],
    }));
    assert.equal(allowed.error, null, allowed.error);
    assert.ok(allowed.hits.some((h) => h.label === 'zb-own-script-ran'), 'a listed, trusted-owner repo\'s script does run');
  } finally { repo.cleanup(); }
});

test('M3: the executed target script sees a temp HOME, no inherited secrets, and the real LEAK_CHECK_* context', async () => {
  const probe = [
    '#!/usr/bin/env node',
    'import { homedir } from "node:os";',
    'const home = homedir();',
    'const leaked = Object.keys(process.env).filter((k) => k === "ZB_SECRET_TOKEN");',
    'const tag = [home.includes("ac-pubsweep-") ? "temphome" : "realhome", leaked.length ? "secret" : "nosecret", process.env.LEAK_CHECK_USER ? "user" : "nouser"].join("-");',
    'console.log(`  NOTES.md:1  [zb-probe]  ${tag}  ::  x`);',
    'console.log("leak-check: FAILED — 1 hit(s)");',
    'process.exitCode = 1;',
    '',
  ].join('\n');
  const repo = buildRepoWith({ 'scripts/leak-check.mjs': probe, 'NOTES.md': 'clean\n' });
  process.env.ZB_SECRET_TOKEN = 'zb-should-not-pass';
  try {
    const url = 'https://github.com/zbtrusted/zbprobe.git';
    const r = await withGithubAlias(repo.bareDir, url, () => sweepRepo(url, {
      strictRepoUrls: [url], allowedOwners: new Set(['zbtrusted']), devRoots: [],
    }));
    assert.equal(r.error, null, r.error);
    const probeHit = r.hits.find((h) => h.label === 'zb-probe');
    assert.ok(probeHit, JSON.stringify(r.hits));
    assert.equal(probeHit.token, 'temphome-nosecret-user');
  } finally { delete process.env.ZB_SECRET_TOKEN; repo.cleanup(); }
});

test('M4: a target script that CRASHES (exit 1, no summary, no hits) is a sweep error, not clean-plus-plugin-hits', async () => {
  const crash = '#!/usr/bin/env node\nthrow new Error("zb boom");\n';
  const repo = buildRepoWith({ 'scripts/leak-check.mjs': crash, 'NOTES.md': `${SYNTHETIC_LEAK_LINE}\n` });
  try {
    const url = 'https://github.com/zbtrusted/zbcrash.git';
    const r = await withGithubAlias(repo.bareDir, url, () => sweepRepo(url, {
      strictRepoUrls: [url], allowedOwners: new Set(['zbtrusted']), devRoots: [],
    }));
    assert.ok(r.error, 'a crash must surface as an error');
    assert.match(r.error, /crashed/);
    assert.ok(r.hits.some((h) => h.label === 'private-path:windows-profile'), 'the plugin checker still ran and its hits are kept');
  } finally { repo.cleanup(); }
});

test('M4: sweepRepoInPlace applies the same rule (crash = error)', async () => {
  const crash = '#!/usr/bin/env node\nthrow new Error("zb boom");\n';
  const repo = buildRepoWith({ 'scripts/leak-check.mjs': crash, 'NOTES.md': 'clean\n' });
  try {
    const r = await sweepRepoInPlace(repo.bareDir, repo.workDir, {});
    assert.ok(r.error);
    assert.match(r.error, /crashed/);
  } finally { repo.cleanup(); }
});

test('M4: interpretTargetScan — summary line or parsed hits required', async () => {
  const { interpretTargetScan } = await import('../scripts/lib/publication-sweep.mjs');
  const hitLine = '  a.md:1  [x]  t  ::  t';
  assert.equal(interpretTargetScan({ status: 0, stdout: 'leak-check: OK — none.\n', stderr: '' }).error, null);
  assert.ok(interpretTargetScan({ status: 0, stdout: '', stderr: '' }).error, 'exit 0 with no OK line');
  assert.equal(interpretTargetScan({ status: 1, stdout: '', stderr: `leak-check: FAILED — 1 hit(s):\n${hitLine}\n` }).hits.length, 1);
  assert.ok(interpretTargetScan({ status: 1, stdout: '', stderr: 'Error: boom\n    at x' }).error, 'crash');
  assert.ok(interpretTargetScan({ status: 1, stdout: '', stderr: 'leak-check: FAILED — 3 hit(s):\n' }).error, 'FAILED but unparseable');
  assert.ok(interpretTargetScan({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }).error, 'timeout/kill');
});

test('L1: fingerprints are keyed — a different key gives a different fingerprint; no key = stable per process', async () => {
  const { randomBytes } = await import('node:crypto');
  const hit = { rel: 'NOTES.md', line: 1, label: 'derived-project-name', token: 'zorbl' };
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  assert.equal(fingerprintHit('r', hit, { key: k1 }), fingerprintHit('r', hit, { key: k1 }));
  assert.notEqual(fingerprintHit('r', hit, { key: k1 }), fingerprintHit('r', hit, { key: k2 }), 'unguessable without the key');
  assert.equal(fingerprintHit('r', hit), fingerprintHit('r', hit), 'default per-process key is stable within the run');
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update('zorbl').digest('hex');
  const unkeyed = createHash('sha256').update(`r\u0000NOTES.md\u0000derived-project-name\u0000${tokenHash}`).digest('hex').slice(0, 24);
  assert.notEqual(fingerprintHit('r', hit, { key: k1 }), unkeyed, 'the old guessable construction no longer matches');
});

test('L1: loadFingerprintKey creates a 32-byte key once and returns the same key after', async () => {
  const { loadFingerprintKey } = await import('../scripts/lib/publication-sweep.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ac-fpkey-'));
  try {
    const a = loadFingerprintKey(dir);
    const b = loadFingerprintKey(dir);
    assert.equal(a.length, 32);
    assert.ok(a.equals(b), 'persisted, not regenerated');
    assert.match(readFileSync(join(dir, 'leak-fingerprint.key'), 'utf8'), /^[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L1: a SECOND occurrence of an accepted token in the same file is a new fingerprint; a line shift is not', async () => {
  const { fingerprintHits } = await import('../scripts/lib/publication-sweep.mjs');
  const h = (line) => ({ rel: 'NOTES.md', line, label: 'derived-project-name', token: 'zorbl', text: 'x' });
  const accepted = fingerprintHits('r', [h(3)]).map((x) => x.fingerprint);
  const shifted = fingerprintHits('r', [h(9)]).map((x) => x.fingerprint);
  assert.deepEqual(shifted, accepted, 'a line shift alone keeps the fingerprint');
  const twice = fingerprintHits('r', [h(9), h(20)]);
  const fresh = filterNew(twice, accepted);
  assert.equal(fresh.length, 1, 'the added copy fires once');
  const twiceAbove = fingerprintHits('r', [h(1), h(9)]);
  assert.equal(filterNew(twiceAbove, accepted).length, 1, 'a copy added ABOVE the accepted one also fires exactly once');
});

test('detect.mjs: publication_leak_repos empty (default) — no signal, no git activity', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], { env: { ...process.env, AGENT_COMPANION_HOME_OVERRIDE: dir } });
    assert.equal(res.status, 0);
    assert.ok(res.json, 'detect.mjs must emit JSON');
    assert.ok(!res.json.signals.some((s) => s.kind.startsWith('publication_leak')));
  } finally { cleanup(); }
});

test('detect.mjs: a configured leaky repo fires publication_leak once, then dedupes on the next run', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: repo.bareDir,
    };
    const runA = runScript('scripts/detect.mjs', [], { env, timeout: 60000 });
    assert.equal(runA.status, 0, runA.stderr);
    const sigA = runA.json.signals.find((s) => s.kind === 'publication_leak');
    assert.ok(sigA, `expected a publication_leak signal, got: ${JSON.stringify(runA.json.signals)}`);

    const runB = runScript('scripts/detect.mjs', [], { env, timeout: 60000 });
    assert.equal(runB.status, 0, runB.stderr);
    assert.ok(
      !runB.json.signals.some((s) => s.kind === 'publication_leak'),
      'the same hit must not re-fire once accepted into the baseline',
    );
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: an unreachable configured repo reports publication_leak_sweep_error, not a crash', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: join(dir, 'nope', 'does-not-exist.git'),
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(res.json.signals.some((s) => s.kind === 'publication_leak_sweep_error'));
  } finally { cleanup(); }
});

test('normalizeGitUrl: ssh, https and scp-style forms of the same repo compare equal', () => {
  const a = normalizeGitUrl('git@github.com:example-org/example-repo.git');
  const b = normalizeGitUrl('https://github.com/example-org/example-repo.git');
  const c = normalizeGitUrl('https://github.com/example-org/example-repo');
  const d = normalizeGitUrl('ssh://git@github.com/example-org/example-repo.git');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, d);
  assert.notEqual(a, normalizeGitUrl('git@github.com:someone-else/other-repo.git'));
});

// --- privacy fix: sweepRepo()/sweepRepoInPlace() must never return a raw
// repo identity inside their `error` text (CI diagnosis 3: a failed
// `git clone`/`git fetch`'s own stderr embeds the source path/URL). This is
// deliberately exercised with SYNTHETIC stderr, not a real failing clone —
// git's exact wording is platform-dependent, so a real-clone assertion would
// be flaky; feeding the text directly makes the redaction itself
// deterministic everywhere.

test('redactRepoIdentifiers: strips a path-shaped repo entry embedded in synthetic stderr', () => {
  const entry = '/srv/checkouts/zbprivrepo';
  const stderr = `fatal: repository '${entry}' does not exist`;
  const out = redactRepoIdentifiers(stderr, entry);
  assert.doesNotMatch(out, /zbprivrepo/i);
  assert.match(out, /<repo-url>/);
});

test('redactRepoIdentifiers: strips a URL-shaped repo entry embedded in synthetic stderr', () => {
  const entry = 'https://github.com/myorg/zbprivrepo.git';
  const stderr = `Cloning into 'zbprivrepo'...\nfatal: could not read Username for '${entry}': terminal prompts disabled`;
  const out = redactRepoIdentifiers(stderr, entry);
  assert.doesNotMatch(out, /zbprivrepo/i);
  assert.match(out, /<repo-url>/);
});

test('redactRepoIdentifiers: strips a bare-name repo entry embedded in synthetic stderr', () => {
  const entry = 'zbprivrepo';
  const stderr = `fatal: '${entry}' does not appear to be a git repository`;
  const out = redactRepoIdentifiers(stderr, entry);
  assert.doesNotMatch(out, /zbprivrepo/i);
  assert.match(out, /<repo-url>/);
});

test('redactRepoIdentifiers: also strips the resolved clone SOURCE (extra) when it differs from a local-path entry', () => {
  const entry = '/srv/checkouts/zbprivrepo';
  const source = 'git@github.com:myorg/zbprivrepo.git';
  const stderr = `fatal: unable to access '${source}/': Could not resolve host: github.com`;
  const out = redactRepoIdentifiers(stderr, entry, [source]);
  assert.doesNotMatch(out, /zbprivrepo/i);
  assert.match(out, /<repo-url>/);
});

test('redactRepoIdentifiers: leaves unrelated text untouched and tolerates empty input', () => {
  assert.equal(redactRepoIdentifiers('', 'zbprivrepo'), '');
  assert.equal(redactRepoIdentifiers('network timeout', 'zbprivrepo'), 'network timeout');
});

test('sweepRepo: a real clone failure never leaks the repo entry in .error', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-pubsweep-missing-'));
  const missing = join(tmpRoot, 'zbprivrepo');
  try {
    const r = await sweepRepo(missing, { timeout: 15000 });
    assert.ok(r.error, 'a missing source must surface as an error');
    assert.doesNotMatch(r.error, /zbprivrepo/i, r.error);
    assert.match(r.error, /<repo-url>/, r.error);
  } finally { rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('isSessionCheckout: matches a repo entry equal to the checkout\'s own origin, not an unrelated one', () => {
  const repo = buildLeakyRepo();
  try {
    assert.equal(isSessionCheckout(repo.bareDir, repo.workDir), true);
    assert.equal(isSessionCheckout(join(repo.base, 'not-the-origin.git'), repo.workDir), false);
  } finally { repo.cleanup(); }
});

test('sweepRepoInPlace: scans the checkout directly (no clone), always reduced', async () => {
  const repo = buildLeakyRepo();
  try {
    const result = await sweepRepoInPlace(repo.bareDir, repo.workDir, {});
    assert.equal(result.error, null);
    assert.ok(result.hits.some((h) => h.label === 'private-path:windows-profile'));
    // never a derived-project-name hit: sweepRepoInPlace always passes --no-derived
    assert.ok(!result.hits.some((h) => h.label === 'derived-project-name'));
  } finally { repo.cleanup(); }
});

test('sweepRepoInPlace: refuses to scan when HEAD does not match origin\'s default branch', async () => {
  const repo = buildLeakyRepo();
  try {
    // Make an unpushed local commit so workDir's HEAD diverges from origin.
    writeFileSync(join(repo.workDir, 'NOTES.md'), 'unpublished change\n');
    git(['add', '-A'], repo.workDir, repo.gitEnv);
    git(['commit', '--quiet', '-m', 'unpublished'], repo.workDir, repo.gitEnv);
    const result = await sweepRepoInPlace(repo.bareDir, repo.workDir, {});
    assert.equal(result.hits.length, 0);
    assert.match(result.error, /does not match origin/);
  } finally { repo.cleanup(); }
});

test('sweepAllCloud: the entry matching this checkout is scanned in place; a non-matching entry is skipped, never cloned', async () => {
  const repo = buildLeakyRepo();
  try {
    const other = join(repo.base, 'definitely-not-this-checkout.git');
    const { results } = await sweepAllCloud([repo.bareDir, other], { cwd: repo.workDir });
    const matched = results.find((r) => r.repo === repo.bareDir);
    const skipped = results.find((r) => r.repo === other);
    assert.equal(matched.skipped, undefined);
    assert.equal(matched.error, null);
    assert.ok(matched.hits.some((h) => h.label === 'private-path:windows-profile'));
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.hits.length, 0);
    assert.equal(skipped.error, null);
    assert.ok(skipped.note);
  } finally { repo.cleanup(); }
});

test('detect.mjs (cloud): scans the checkout in place, skips a non-matching configured repo, never clones', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const otherRepo = join(repo.base, 'not-this-checkout.git');
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_CODE_REMOTE_SESSION_ID: 'test-cloud-session',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: join(dir, 'no-dev-root'),
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: `${repo.bareDir},${otherRepo}`,
    };
    // cwd is the "session checkout" — detect.mjs must scan THIS in place and
    // must not attempt to clone otherRepo (which does not even exist).
    const res = runScript('scripts/detect.mjs', [], { env, cwd: repo.workDir, timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    const leakSig = res.json.signals.find((s) => s.kind === 'publication_leak');
    assert.ok(leakSig, `expected publication_leak, got: ${JSON.stringify(res.json.signals)}`);
    assert.match(leakSig.detail, /cloud, in-place/);
    const noteSig = res.json.signals.find((s) => s.kind === 'publication_leak_sweep_note');
    assert.ok(noteSig, 'expected a note about the skipped (non-checkout) repo');
    // item 16: signal text is scrubbed of local absolute paths before it
    // ever lands in a signal — assert the SCRUBBED shape, not the raw path.
    assert.match(noteSig.detail, /not this cloud session's own checkout/);
    assert.doesNotMatch(noteSig.detail, /AppData/, 'a local absolute path must not appear raw in signal text');
    assert.ok(!res.json.signals.some((s) => s.kind === 'publication_leak_sweep_error'), 'the skipped repo must not be reported as an error — it was never attempted');
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: publication_leak_sweep off (default) — the master switch, not just an empty repo list', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildLeakyRepo();
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      // publication_leak_sweep left OFF on purpose, even though a repo IS configured.
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: repo.bareDir,
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(!res.json.signals.some((s) => s.kind.startsWith('publication_leak')), 'off is off, regardless of publication_leak_repos');
  } finally { cleanup(); repo.cleanup(); }
});

test('detect.mjs: auto-discovery via the dev-root fallback fires publication_repo_newly_public once, then dedupes', async () => {
  const { dir, cleanup } = makeFixture();
  const devRoot = join(dir, 'discover-dev-root');
  mkdirSync(devRoot, { recursive: true });
  const projDir = join(devRoot, 'auto-discovered-proj');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'README.md'), 'clean\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  git(['add', '-A'], projDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, gitEnv);
  git(['remote', 'add', 'origin', 'git@github.com:example-org/auto-discovered-proj.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: '1', // every candidate treated as public, no network
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_OWNERS: 'example-org',
    };
    const runA = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(runA.status, 0, runA.stderr);
    const newPub = runA.json.signals.find((s) => s.kind === 'publication_repo_newly_public');
    assert.ok(newPub, `expected publication_repo_newly_public, got: ${JSON.stringify(runA.json.signals)}`);
    assert.match(newPub.detail, /example-org\/auto-discovered-proj/);

    const runB = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(runB.status, 0, runB.stderr);
    assert.ok(
      !runB.json.signals.some((s) => s.kind === 'publication_repo_newly_public'),
      'the same repo must not re-fire as "newly public" once acknowledged',
    );
  } finally { cleanup(); }
});

test('M5 detect.mjs: unknown visibility fires publication_leak_visibility_unknown with a count and no names', async () => {
  const { dir, cleanup } = makeFixture();
  const devRoot = join(dir, 'discover-dev-root');
  mkdirSync(devRoot, { recursive: true });
  const projDir = join(devRoot, 'zbunknownproj');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'README.md'), 'clean\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  git(['add', '-A'], projDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, gitEnv);
  git(['remote', 'add', 'origin', 'git@github.com:example-org/zbunknownproj.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: 'unknown',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_OWNERS: 'example-org',
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    const unk = res.json.signals.find((s) => s.kind === 'publication_leak_visibility_unknown');
    assert.ok(unk, `expected publication_leak_visibility_unknown, got: ${JSON.stringify(res.json.signals)}`);
    assert.match(unk.detail, /^1 candidate repo/);
    assert.doesNotMatch(unk.detail, /zbunknownproj|example-org/, 'count only, never names');
    assert.ok(!res.json.signals.some((s) => s.kind === 'publication_repo_newly_public'), 'unknown is never treated as public');
    assert.deepEqual(res.json.baseline.publicationVisibilityCache, {}, 'an unknown answer is never cached');
  } finally { cleanup(); }
});

test('detect.mjs: publication_leak_repos excludes (!entry) remove a discovered repo from the sweep', async () => {
  const { dir, cleanup } = makeFixture();
  const devRoot = join(dir, 'discover-dev-root');
  mkdirSync(devRoot, { recursive: true });
  const projDir = join(devRoot, 'excluded-proj');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'README.md'), 'clean\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
  git(['add', '-A'], projDir, gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, gitEnv);
  git(['remote', 'add', 'origin', 'git@github.com:example-org/excluded-proj.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: '1',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_OWNERS: 'example-org',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_REPOS: '!example-org/excluded-proj',
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 30000 });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      !res.json.signals.some((s) => s.kind === 'publication_repo_newly_public'),
      'an excluded repo must never be discovered/covered at all',
    );
  } finally { cleanup(); }
});

test('sweepRepo: publicNames exempts a PUBLIC sibling name from BOTH checkers, but a private-looking derived name still fires', async () => {
  // Both names must be DERIVABLE in the first place (real child dirs of a
  // dev root) for this to test the exemption rather than trivially passing
  // because neither was ever a candidate.
  const devRootDir = mkdtempSync(join(tmpdir(), 'ac-pubsweep-devroot-'));
  const PUBLIC_NAME = 'zzzpublicsiblingproj';
  const PRIVATE_NAME = 'zzzprivateonlyproj';
  mkdirSync(join(devRootDir, PUBLIC_NAME), { recursive: true });
  mkdirSync(join(devRootDir, PRIVATE_NAME), { recursive: true });
  const repo = buildLeakyRepo(`mentions our sibling ${PUBLIC_NAME} here\nand also a private name: ${PRIVATE_NAME}\n`);
  try {
    const result = await sweepRepo(repo.bareDir, {
      devRoots: [devRootDir],
      publicNames: [PUBLIC_NAME, `example-org/${PUBLIC_NAME}`],
    });
    assert.equal(result.error, null);
    assert.ok(
      !result.hits.some((h) => h.label === 'derived-project-name' && h.token.toLowerCase() === PUBLIC_NAME),
      'a discovered-public sibling name must never fire as a leak',
    );
    assert.ok(
      result.hits.some((h) => h.label === 'derived-project-name' && h.token.toLowerCase() === PRIVATE_NAME),
      'a derived name NOT in publicNames must still fire — proves the fixture actually exercises the derived-name class',
    );
  } finally { repo.cleanup(); rmSync(devRootDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('sweepRepo scoping: a NON-opt-in repo skips derived-name entirely but still catches a private path', async () => {
  const devRootDir = mkdtempSync(join(tmpdir(), 'ac-pubsweep-devroot-'));
  const PRIVATE_NAME = 'zzznonoptinprivateproj';
  mkdirSync(join(devRootDir, PRIVATE_NAME), { recursive: true });
  // No scripts/leak-check.mjs, no marker file — buildLeakyRepoBare() below
  // builds a repo with NEITHER, unlike buildLeakyRepo() which always copies
  // scripts/leak-check.mjs (making every other test's fixture "strict" by
  // definition — this test needs the opposite).
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    writeFileSync(join(workDir, 'NOTES.md'), `mentions ${PRIVATE_NAME} here\nand also ${SYNTHETIC_LEAK_LINE}\n`);
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);

    const result = await sweepRepo(bareDir, { devRoots: [devRootDir] });
    assert.equal(result.error, null);
    assert.equal(result.strict, false, 'no own script, no marker, not listed — must not be strict');
    assert.ok(
      !result.hits.some((h) => h.label === 'derived-project-name'),
      'derived-project-name must not fire at all for a non-opt-in repo',
    );
    assert.ok(
      result.hits.some((h) => h.label === 'private-path:windows-profile'),
      'a private-path hit is UNIVERSAL and must still fire regardless of strict',
    );
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
    rmSync(devRootDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('sweepRepo scoping: a .leak-check-strict marker file opts a repo in without its own leak-check.mjs', async () => {
  const devRootDir = mkdtempSync(join(tmpdir(), 'ac-pubsweep-devroot-'));
  const PRIVATE_NAME = 'zzzmarkeroptinproj';
  mkdirSync(join(devRootDir, PRIVATE_NAME), { recursive: true });
  const base = mkdtempSync(join(tmpdir(), 'ac-pubsweep-test-'));
  try {
    const bareDir = join(base, 'origin.git');
    const workDir = join(base, 'work');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareDir]);
    mkdirSync(workDir, { recursive: true });
    git(['init', '--quiet', '-b', 'main', workDir]);
    git(['remote', 'add', 'origin', bareDir], workDir);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    writeFileSync(join(workDir, STRICT_MARKER_FILE), '');
    writeFileSync(join(workDir, 'NOTES.md'), `mentions ${PRIVATE_NAME} here\n`);
    git(['add', '-A'], workDir, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], workDir, gitEnv);
    git(['push', '--quiet', 'origin', 'main'], workDir, gitEnv);

    const result = await sweepRepo(bareDir, { devRoots: [devRootDir] });
    assert.equal(result.error, null);
    assert.equal(result.strict, true, 'the marker file alone must opt the repo in');
    assert.ok(
      result.hits.some((h) => h.label === 'derived-project-name' && h.token.toLowerCase() === PRIVATE_NAME),
      'derived-project-name must fire once opted in via the marker file',
    );
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
    rmSync(devRootDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('leak-scan-core scanText: a pinned GitHub Actions SHA is exempt from git-sha-like (strict only)', async () => {
  const { scanText } = await import('../scripts/lib/leak-scan-core.mjs');
  const pinned = ['01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67'].join('');
  const line = `      - uses: actions/checkout@${pinned}\n`;
  const strictResult = scanText(line, { rel: '.github/workflows/ci.yml', strict: true });
  assert.ok(!strictResult.hits.some((h) => h.label === 'git-sha-like'), 'a pinned action SHA must not fire even in strict mode');
  // Same hex NOT after "uses: ...@" still fires in strict mode — proves the
  // exemption is shape-specific, not "any 40-hex-char run in a yml file".
  const otherLine = `      random: ${pinned}\n`;
  const strictOther = scanText(otherLine, { rel: '.github/workflows/ci.yml', strict: true });
  assert.ok(strictOther.hits.some((h) => h.label === 'git-sha-like'), 'an unrelated hex run must still fire in strict mode');
});

test('leak-scan-core scanRepo: git-sha-like is silent entirely when NOT strict, even for a plain hex run', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-corestrict-'));
  try {
    const pinned = ['01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67'].join('');
    writeFileSync(join(base, 'notes.txt'), `random hex: ${pinned}\n`);
    git(['init', '--quiet', '-b', 'main'], base);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
    git(['add', '-A'], base, gitEnv);
    git(['commit', '--quiet', '-m', 'init'], base, gitEnv);
    const { scanRepo } = await import('../scripts/lib/leak-scan-core.mjs');
    const notStrict = scanRepo({ root: base, devRoots: [], strict: false });
    assert.ok(!notStrict.hits.some((h) => h.label === 'git-sha-like'));
    const strict = scanRepo({ root: base, devRoots: [], strict: true });
    assert.ok(strict.hits.some((h) => h.label === 'git-sha-like'));
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test('leak-scan-core scanRepo: the vendor skip is SHA-ONLY and narrow — build/dist/vendor/sourcemaps still get every other class', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ac-corevendor-'));
  try {
    // Assembled from 2-char pieces — no contiguous 7+ char hex run appears
    // literally in this file's own source (it is itself leak-checked).
    const leakyHex = ['01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67'].join('');
    const PRIVATE_PATH_LEAK = ['C:', '\\Users\\', 'zzz', 'vendortest', '\\dev\\thing'].join('');
    mkdirSync(join(base, 'vendor'), { recursive: true });
    mkdirSync(join(base, 'dist'), { recursive: true });
    mkdirSync(join(base, 'build'), { recursive: true });
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(base, 'vendor', 'lib.js'), `const h = "${leakyHex}"; // ${PRIVATE_PATH_LEAK}\n`);
    writeFileSync(join(base, 'dist', 'bundle.js.map'), `{"sources":["${PRIVATE_PATH_LEAK.replace(/\\/g, '\\\\')}"]}\n`);
    writeFileSync(join(base, 'dist', 'bundle.min.js'), `const h = "${leakyHex}"; // ${PRIVATE_PATH_LEAK}\n`);
    writeFileSync(join(base, 'node_modules', 'pkg', 'index.js'), `const h = "${leakyHex}"; // ${PRIVATE_PATH_LEAK}\n`);
    writeFileSync(join(base, 'package-lock.json'), `{"h":"${leakyHex}"}\n`);
    writeFileSync(join(base, 'build', 'out.js'), `const h = "${leakyHex}"; // ${PRIVATE_PATH_LEAK}\n`);
    writeFileSync(join(base, 'real.js'), `const h = "${leakyHex}";\n`);
    git(['init', '--quiet', '-b', 'main'], base);
    git(['add', '-A'], base, { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' });
    git(['commit', '--quiet', '-m', 'init'], base, { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' });
    const { scanRepo } = await import('../scripts/lib/leak-scan-core.mjs');
    const { hits } = scanRepo({ root: base, devRoots: [], noDerived: true });
    const byRel = (r, label) => hits.some((h) => h.rel === r && h.label === label);

    assert.ok(byRel('real.js', 'git-sha-like'), 'an ordinary source file still gets git-sha-like');

    // SHA-only skip applies to *.min.js/css, lockfiles, node_modules/ ONLY.
    assert.ok(!byRel('dist/bundle.min.js', 'git-sha-like'), '*.min.js loses git-sha-like');
    assert.ok(!byRel('node_modules/pkg/index.js', 'git-sha-like'), 'node_modules/ loses git-sha-like');
    assert.ok(!byRel('package-lock.json', 'git-sha-like'), 'a lockfile loses git-sha-like');
    // ...but plain vendor/ and build/ are NOT in the SHA skip list at all
    // (only *.min.js/css, lockfiles, node_modules/ are) — proves the skip is
    // narrow by FILE SHAPE, not "any vendor/build-output directory".
    assert.ok(byRel('vendor/lib.js', 'git-sha-like'), 'vendor/ (not minified) still gets git-sha-like');
    assert.ok(byRel('build/out.js', 'git-sha-like'), 'build/ still gets git-sha-like');

    // ...but EVERY file still gets the private-path class, including the
    // ones that lost git-sha-like, including a sourcemap (a classic
    // absolute-path leak vector that must never be skipped wholesale).
    assert.ok(byRel('vendor/lib.js', 'private-path:windows-profile'));
    assert.ok(byRel('dist/bundle.min.js', 'private-path:windows-profile'));
    assert.ok(byRel('dist/bundle.js.map', 'private-path:windows-profile'), 'a sourcemap must be scanned for private paths');
    assert.ok(byRel('node_modules/pkg/index.js', 'private-path:windows-profile'));
    assert.ok(byRel('build/out.js', 'private-path:windows-profile'));
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 3 }); }
});

test('leak-sweep-canary.mjs: full mode passes', () => {
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'leak-sweep-canary.mjs')], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});

test('leak-sweep-canary.mjs: reduced mode passes', () => {
  const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'leak-sweep-canary.mjs'), '--reduced'], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});

// --- third adversarial review: N1 — the full detect -> scrub path ------------

test('N1 detect.mjs: a publication_leak alert for a PUBLIC repo keeps repo, file and line after scrubbing', async () => {
  const { dir, cleanup } = makeFixture();
  const repo = buildRepoWith({ 'README.md': `line one\nline two\n${SYNTHETIC_LEAK_LINE}\n` });
  const devRoot = join(dir, 'discover-dev-root');
  const projDir = join(devRoot, 'zbpubrepo');
  mkdirSync(projDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], projDir);
  writeFileSync(join(projDir, 'x.txt'), 'x\n');
  git(['add', '-A'], projDir, repo.gitEnv);
  git(['commit', '--quiet', '-m', 'init'], projDir, repo.gitEnv);
  // scp-form origin: the https insteadOf below must not rewrite discovery's view of it.
  git(['remote', 'add', 'origin', 'git@github.com:myorg/zbpubrepo.git'], projDir);
  try {
    const env = {
      ...process.env,
      AGENT_COMPANION_HOME_OVERRIDE: dir,
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_SWEEP: 'true',
      AGENT_COMPANION_DISCOVERY_NO_GH: '1',
      AGENT_COMPANION_DISCOVERY_DEV_ROOT: devRoot,
      AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: '1',
      CLAUDE_PLUGIN_OPTION_PUBLICATION_LEAK_OWNERS: 'myorg',
      // The sweep clones the discovered https URL; git rewrites it to the
      // local bare repo for this child only — no network.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo.bareDir).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/myorg/zbpubrepo',
    };
    const res = runScript('scripts/detect.mjs', [], { env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    const leak = res.json.signals.find((s) => s.kind === 'publication_leak');
    assert.ok(leak, `expected publication_leak, got: ${JSON.stringify(res.json.signals)}`);
    const want = 'https://github.com/myorg/zbpubrepo — README.md:3 [private-path:windows-profile]';
    assert.ok(leak.detail.includes(want), `expected "${want}" in: ${leak.detail}`);
    assert.doesNotMatch(leak.detail, /<repo-url>/);
  } finally { cleanup(); repo.cleanup(); }
});

// --- third adversarial review: N4 — the execution gate's URL shapes ----------

const N4_OPTS = (src) => ({ strictRepoUrls: [src], allowedOwners: new Set(['myorg']), resolvedSource: src });

test('N4: the own-script gate accepts https://github.com/o/r (with or without .git / userinfo)', async () => {
  const { mayExecuteTargetScript, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  for (const src of ['https://github.com/myorg/zbrepo.git', 'https://github.com/myorg/zbrepo', 'https://x-access-token:zbfake@github.com/myorg/zbrepo.git']) {
    assert.equal(ownerOf(src), 'myorg', src);
    assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), true, src);
  }
});

test('N4: the own-script gate accepts ssh://git@github.com/o/r', async () => {
  const { mayExecuteTargetScript } = await import('../scripts/lib/publication-sweep.mjs');
  const src = 'ssh://git@github.com/myorg/zbrepo.git';
  assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), true);
});

test('N4: the own-script gate accepts scp-form git@github.com:o/r', async () => {
  const { mayExecuteTargetScript } = await import('../scripts/lib/publication-sweep.mjs');
  const src = 'git@github.com:myorg/zbrepo.git';
  assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), true);
});

test('N4: the own-script gate rejects http://', async () => {
  const { mayExecuteTargetScript, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  const src = 'http://github.com/myorg/zbrepo.git';
  assert.equal(ownerOf(src), null);
  assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), false);
});

test('N4: the own-script gate rejects git://', async () => {
  const { mayExecuteTargetScript, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  const src = 'git://github.com/myorg/zbrepo.git';
  assert.equal(ownerOf(src), null);
  assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), false);
});

test('N4: the own-script gate rejects file://', async () => {
  const { mayExecuteTargetScript, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  const src = 'file://github.com/myorg/zbrepo.git';
  assert.equal(ownerOf(src), null);
  assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), false);
});

test('N4: the own-script gate rejects scheme-less github.com/o/r (git reads it as a local path)', async () => {
  const { mayExecuteTargetScript, ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  for (const src of ['github.com/myorg/zbrepo', 'github.com/myorg/zbrepo.git']) {
    assert.equal(ownerOf(src), null, src);
    assert.equal(mayExecuteTargetScript(src, N4_OPTS(src)), false, src);
  }
});

test('N4: the own-script gate rejects other ssh users/hosts and a dot-only repo name', async () => {
  const { ownerOf } = await import('../scripts/lib/publication-sweep.mjs');
  assert.equal(ownerOf('ssh://zbuser@github.com/myorg/zbrepo.git'), null);
  assert.equal(ownerOf('git@github.com.evil.example:myorg/zbrepo.git'), null);
  assert.equal(ownerOf('https://github.com/myorg/..'), null);
});

// --- third adversarial review: N5 (docs), N6/N7 (accepted behaviour, pinned) --

test('N5: docs never present the child\'s temp HOME as isolation, and name the only control', () => {
  const files = {
    lib: readFileSync(join(PLUGIN_ROOT, 'scripts', 'lib', 'publication-sweep.mjs'), 'utf8'),
    skill: readFileSync(join(PLUGIN_ROOT, 'skills', 'setup', 'SKILL.md'), 'utf8'),
    options: readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
    routine: readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8'),
  };
  for (const [name, body] of Object.entries(files)) {
    const flat = body.replace(/\s*(?:\/\/)?\s*\n\s*(?:\/\/)?\s*/g, ' ');
    assert.match(flat, /(?:no|not) isolation/i, `${name}: must say the temp HOME is not isolation`);
    assert.match(flat, /only control/i, `${name}: must name listing + verified owner as the only control`);
    assert.match(flat, /https/i, `${name}: must say the verified owner comes from an https/ssh github.com URL`);
    assert.doesNotMatch(flat, /(?:isolated|sandboxed) (?:temp )?HOME|HOME (?:isolation|sandbox)/i, `${name}: temp HOME described as isolation`);
  }
  // The routine used to say LOCAL runs every repo's own script, ungated.
  assert.doesNotMatch(files.routine.replace(/\s+/g, ' '), /throwaway dir and runs that repo's own/);
});

test('N6: an accepted token that MOVES within the same file keeps its fingerprint — silent until the 7-day re-fire', async () => {
  const { fingerprintHits, filterNewOrStale } = await import('../scripts/lib/publication-sweep.mjs');
  const key = Buffer.alloc(32, 7);
  const before = fingerprintHits('repo-a', [{ rel: 'NOTES.md', line: 2, label: 'l', token: 'zbtok', text: 'x' }], { key });
  const moved = fingerprintHits('repo-a', [{ rel: 'NOTES.md', line: 40, label: 'l', token: 'zbtok', text: 'y' }], { key });
  assert.equal(moved[0].fingerprint, before[0].fingerprint);
  const now = Date.parse('2026-06-15T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  assert.deepEqual(filterNewOrStale(moved, { [before[0].fingerprint]: new Date(now - 3 * day).toISOString() }, { now }), []);
  assert.equal(filterNewOrStale(moved, { [before[0].fingerprint]: new Date(now - 7 * day).toISOString() }, { now }).length, 1);
});

test('N7: a trusted target script\'s own "leak-check: OK" is accepted, and the plugin checker still reports its hits', async () => {
  const okScript = ['#!/usr/bin/env node', 'console.log("leak-check: OK — no real-world tokens found.");', ''].join('\n');
  const repo = buildRepoWith({ 'scripts/leak-check.mjs': okScript, 'NOTES.md': `${SYNTHETIC_LEAK_LINE}\n` });
  try {
    const url = 'https://github.com/myorg/zbokrepo.git';
    const r = await withGithubAlias(repo.bareDir, url, () => sweepRepo(url, {
      strictRepoUrls: [url], allowedOwners: new Set(['myorg']), devRoots: [],
    }));
    assert.equal(r.error, null, 'the OK line is trusted — no error');
    assert.ok(r.hits.some((h) => h.label === 'private-path:windows-profile'), 'the plugin checker ran anyway and its hit survives the OK');
  } finally { repo.cleanup(); }
});

// --- final review: F1 — public names must reach the core on the EXACT path ---

const F1_PUBLIC = ['myorg/acme-tools', 'myorg', 'acme-tools'];

async function f1Sweep(devDirs, body) {
  const dev = mkdtempSync(join(tmpdir(), 'ac-f1-dev-'));
  const projects = mkdtempSync(join(tmpdir(), 'ac-f1-proj-'));
  for (const d of devDirs) mkdirSync(join(dev, d), { recursive: true });
  const repo = buildRepoWith({ [STRICT_MARKER_FILE]: '', 'NOTES.md': body });
  try {
    return await sweepRepo(repo.bareDir, {
      devRoots: [dev], claudeProjectsDir: projects, users: ['qzhandle'], publicNames: F1_PUBLIC,
    });
  } finally {
    repo.cleanup();
    rmSync(dev, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  }
}

test('F1: public repo "acme-tools" does NOT exempt the derived private PREFIX "acme" in the plugin core sweep', async () => {
  const r = await f1Sweep(['acme-alpha', 'acme-beta'], 'the acme-gamma service is private\n');
  assert.equal(r.error, null, r.error);
  assert.ok(r.hits.some((h) => h.label === 'derived-prefix' && /acme/i.test(h.token)), JSON.stringify(r.hits));
});

test('F1: public repo "acme-tools" does NOT exempt the derived private NAME "acme" in the plugin core sweep', async () => {
  const r = await f1Sweep(['acme'], 'we ported this from acme last year\n');
  assert.equal(r.error, null, r.error);
  assert.ok(r.hits.some((h) => h.label === 'derived-project-name' && /acme/i.test(h.token)), JSON.stringify(r.hits));
});

test('F1: the exact public name itself is still exempt in the plugin core sweep', async () => {
  const r = await f1Sweep(['acme-tools', 'acme-tools-extra'], 'see acme-tools on github\n');
  assert.equal(r.error, null, r.error);
  assert.ok(!r.hits.some((h) => h.label.startsWith('derived-') && /^acme-?tools$/i.test(h.token)), JSON.stringify(r.hits));
});

// --- final review note (b): the routine's old-plugin fallback scrubs its output

function routineFallbackScript() {
  const body = readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /elif \[ -n "\$PUBLICATION_LEAK_REPOS_FALLBACK" \]; then[\s\S]*?node -e "\n([\s\S]*?)\n {2}"\nfi/.exec(body);
  assert.ok(m, 'fallback node -e block not found in the routine template');
  return m[1];
}

test('note (b): the routine fallback prints only through scrub.mjs (doc-level)', () => {
  const js = routineFallbackScript();
  assert.match(js, /scrub\.mjs/);
  assert.match(js, /makeScrubber/);
  assert.doesNotMatch(js.replace(/const say = \(\.\.\.parts\) => console\.log\(scrub\(/, ''), /console\.(log|error)\(/,
    'every printed line must go through say() -> scrub()');
});

test('note (b): the routine fallback, run for real, never prints a private repo name raw', () => {
  const repoRoot = join(PLUGIN_ROOT, '..', '..');
  const js = routineFallbackScript().replace('$(pwd)', pathToFileURL(repoRoot).href);
  const home = mkdtempSync(join(tmpdir(), 'ac-fallback-home-'));
  try {
    const res = spawnSync(process.execPath, ['-e', js], {
      cwd: home,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home,
        GIT_TERMINAL_PROMPT: '0',
        // Rewrite the private URL to a local path that does not exist: the
        // clone fails fast, offline, and git's error names the repo.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(join(home, 'missing')).href}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/myorg/',
        PUBLICATION_LEAK_REPOS_FALLBACK: 'https://github.com/myorg/zbprivrepo.git',
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /publication-leak sweep error:/);
    assert.doesNotMatch(res.stdout, /zbprivrepo/, res.stdout);
    assert.match(res.stdout, /<repo-url>/);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});
