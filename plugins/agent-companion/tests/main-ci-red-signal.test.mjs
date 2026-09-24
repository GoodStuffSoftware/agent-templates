// main_ci_red — the detect.mjs signal end-to-end: scope (current project +
// already-known-public repos), the 10-minute cache, scrubbing of a private
// repo name, and the ci_status_signal off switch.
//
// No network and no real `gh`: AGENT_COMPANION_CI_STATUS_NO_GH forces the
// same "gh unavailable" degrade path checkRepoCiStatus itself takes when gh
// is genuinely missing/unauthenticated/offline (see scripts/detect.mjs and
// tests/ci-status.test.mjs), so a cache MISS in these tests always resolves
// to ok:false — proving whether the signal came from the cache or from a
// (deliberately failing) fresh check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runScript } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

function git(args, cwd) {
  const res = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', timeout: 15000, env: cleanGitEnv() });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// A repo dir with an origin remote but no commits — enough for `git remote
// get-url origin`, which is all detect.mjs's main_ci_red section reads.
function makeRepoDir(originUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-ci-red-test-'));
  git(['init', '--quiet', '-b', 'main', dir]);
  if (originUrl) git(['remote', 'add', 'origin', originUrl], dir);
  return dir;
}

function writeBaseline(extra) {
  writeFileSync(stateFile('baseline.json'), JSON.stringify({ checkedAt: '2026-01-01T00:00:00.000Z', ...extra }));
}

const FRESH = () => new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago: inside the 10min cache TTL
const STALE = () => new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago: outside it

test('ci_status_signal off: no main_ci_red even with a fresh red cache entry', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({
      ciStatusCache: {
        'someowner/somerepo': {
          checkedAt: FRESH(), ok: true, red: true,
          workflows: [{ name: 'tests', redSince: '2026-09-24T08:00:00Z', latestUrl: 'https://github.com/someowner/somerepo/actions/runs/1', failingRunCount: 2 }],
        },
      },
    });
    const res = runScript('scripts/detect.mjs', [], {
      cwd: repoDir,
      env: { CLAUDE_PLUGIN_OPTION_CI_STATUS_SIGNAL: 'false', AGENT_COMPANION_CI_STATUS_NO_GH: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined);
    void stateDir;
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('cache HIT: a fresh red cache entry fires main_ci_red WITHOUT a fresh gh call (NO_GH would blank a real check)', () => {
  const { dir, cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({
      ciStatusCache: {
        'someowner/somerepo': {
          checkedAt: FRESH(), ok: true, red: true,
          workflows: [{ name: 'tests', redSince: '2026-09-24T08:00:00Z', latestUrl: 'https://github.com/someowner/somerepo/actions/runs/1', failingRunCount: 2 }],
        },
      },
    });
    const res = runScript('scripts/detect.mjs', [], {
      cwd: repoDir,
      env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, // if the cache were ignored, this would force ok:false
    });
    assert.equal(res.status, 0, res.stderr);
    const sigRow = res.json.signals.find((s) => s.kind === 'main_ci_red');
    assert.ok(sigRow, `expected main_ci_red from the cache hit; got: ${JSON.stringify(res.json.signals)}`);
    assert.equal(sigRow.dispatch, 'manual-check');
    assert.match(sigRow.detail, /tests/);
    assert.match(sigRow.detail, /2026-09-24T08:00:00Z/);
    void dir;
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('cache MISS (stale entry): a fresh check is attempted and (via NO_GH) fails silently — no signal, cache updated to ok:false', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({
      ciStatusCache: {
        'someowner/somerepo': { checkedAt: STALE(), ok: true, red: true, workflows: [{ name: 'tests', redSince: 'x', latestUrl: 'y', failingRunCount: 1 }] },
      },
    });
    const res = runScript('scripts/detect.mjs', [], {
      cwd: repoDir,
      env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined,
      'a stale cache entry must not be reused as-is');
    const updated = res.json.baseline.ciStatusCache['someowner/somerepo'];
    assert.equal(updated.ok, false, 'the stale entry should have been replaced by a fresh (failed) check, not left red');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('a private (not known-public) repo name is scrubbed out of the signal text', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:zzzprivateowner/zzzprivaterepo.git');
  try {
    writeBaseline({
      ciStatusCache: {
        'zzzprivateowner/zzzprivaterepo': {
          checkedAt: FRESH(), ok: true, red: true,
          workflows: [{ name: 'tests', redSince: '2026-09-24T08:00:00Z', latestUrl: 'https://github.com/zzzprivateowner/zzzprivaterepo/actions/runs/1', failingRunCount: 1 }],
        },
      },
    });
    const res = runScript('scripts/detect.mjs', [], { cwd: repoDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    const sigRow = res.json.signals.find((s) => s.kind === 'main_ci_red');
    assert.ok(sigRow, `expected main_ci_red; got: ${JSON.stringify(res.json.signals)}`);
    assert.ok(!sigRow.detail.includes('zzzprivateowner/zzzprivaterepo'), `repo name leaked unscrubbed: ${sigRow.detail}`);
    assert.ok(!sigRow.detail.includes('zzzprivaterepo/actions/runs'), `run URL leaked unscrubbed: ${sigRow.detail}`);
    assert.match(sigRow.detail, /<repo/); // <repo> and/or <repo-url> markers from scrub.mjs
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('a repo already known public (from the publication-leak sweep baseline) keeps its bare owner/repo readable', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir(); // no origin here: this repo is reached via the known-public list, not cwd
  try {
    writeBaseline({
      publicationKnownPublicRepos: ['https://github.com/pub-owner/pub-repo'],
      ciStatusCache: {
        'pub-owner/pub-repo': {
          checkedAt: FRESH(), ok: true, red: true,
          workflows: [{ name: 'tests', redSince: '2026-09-24T08:00:00Z', latestUrl: 'https://github.com/pub-owner/pub-repo', failingRunCount: 1 }],
        },
      },
    });
    const res = runScript('scripts/detect.mjs', [], { cwd: repoDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    const sigRow = res.json.signals.find((s) => s.kind === 'main_ci_red');
    assert.ok(sigRow, `expected main_ci_red; got: ${JSON.stringify(res.json.signals)}`);
    assert.match(sigRow.detail, /pub-owner\/pub-repo/);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('a green cache entry never fires main_ci_red', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/greenrepo.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/greenrepo': { checkedAt: FRESH(), ok: true, red: false, workflows: [] } } });
    const res = runScript('scripts/detect.mjs', [], { cwd: repoDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('a non-GitHub origin (e.g. gitlab) is silently skipped — no signal, no crash', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@gitlab.com:someowner/somerepo.git');
  try {
    const res = runScript('scripts/detect.mjs', [], { cwd: repoDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('not a git repo at all (no cwd origin) — silent, never throws', () => {
  const { cleanup } = makeFixture();
  const plainDir = mkdtempSync(join(tmpdir(), 'ac-ci-red-noreo-'));
  try {
    const res = runScript('scripts/detect.mjs', [], { cwd: plainDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined);
  } finally { cleanup(); rmSync(plainDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('gh missing/unauthenticated/offline (AGENT_COMPANION_CI_STATUS_NO_GH, no cache) is silent, never a signal', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/nocachrepo.git');
  try {
    const res = runScript('scripts/detect.mjs', [], { cwd: repoDir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.signals.find((s) => s.kind === 'main_ci_red'), undefined);
    assert.equal(res.json.baseline.ciStatusCache['someowner/nocachrepo'].ok, false);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});
