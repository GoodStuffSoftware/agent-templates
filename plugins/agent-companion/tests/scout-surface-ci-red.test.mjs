// scout-surface.mjs's "main CI red" SessionStart note — cache-only, never a
// network call. It reads state/baseline.json's ciStatusCache (written by
// scripts/detect.mjs's main_ci_red check) and a LOCAL `git remote get-url
// origin` (no network — local git metadata only) for the CURRENT cwd's repo.
//
// Neither path here ever imports or calls anything gh-related: scout-surface.mjs
// only imports the pure helpers (githubOwnerRepoFromUrl, repoCacheKey) from
// ci-status.mjs, never checkRepoCiStatus — so there is no seam through which
// this hook could reach the network even by accident.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runHook } from './helpers.mjs';
import { stateFile, stateDir as acStateDir } from '../hooks/lib/context.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

function git(args, cwd) {
  const res = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', timeout: 15000, env: cleanGitEnv() });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

function makeRepoDir(originUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-scout-ci-red-'));
  git(['init', '--quiet', '-b', 'main', dir]);
  if (originUrl) git(['remote', 'add', 'origin', originUrl], dir);
  return dir;
}

function writeBaseline(obj) {
  writeFileSync(stateFile('baseline.json'), JSON.stringify(obj));
}

test('red cached entry for the CURRENT repo produces a one-line note', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({
      ciStatusCache: {
        'someowner/somerepo': {
          checkedAt: new Date().toISOString(), ok: true, red: true,
          workflows: [{ name: 'tests', redSince: '2026-09-24T08:00:00Z', latestUrl: 'https://github.com/someowner/somerepo/actions/runs/1', failingRunCount: 2 }],
        },
      },
    });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-1', cwd: repoDir }, { cwd: repoDir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.json, `expected JSON stdout; got: ${res.stdout}`);
    assert.match(res.json.hookSpecificOutput.additionalContext, /main CI red since 2026-09-24T08:00:00Z, tests/);
    assert.match(res.json.hookSpecificOutput.additionalContext, /actions\/runs\/1/);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('green cached entry: silent (passthrough)', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/greenrepo.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/greenrepo': { checkedAt: new Date().toISOString(), ok: true, red: false, workflows: [] } } });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-2', cwd: repoDir }, { cwd: repoDir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('no cache entry for this repo at all: silent', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/uncached.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/somethingelse': { checkedAt: new Date().toISOString(), ok: true, red: true, workflows: [{ name: 'x', redSince: 'y', latestUrl: 'z', failingRunCount: 1 }] } } });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-3', cwd: repoDir }, { cwd: repoDir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('no baseline.json at all yet: silent, never throws', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/nobaseline.git');
  try {
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-4', cwd: repoDir }, { cwd: repoDir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('not a git repo at all here: silent, never throws', () => {
  const { cleanup } = makeFixture();
  const plainDir = mkdtempSync(join(tmpdir(), 'ac-scout-ci-red-noreo-'));
  try {
    writeBaseline({ ciStatusCache: { 'someowner/somerepo': { checkedAt: new Date().toISOString(), ok: true, red: true, workflows: [{ name: 'x', redSince: 'y', latestUrl: 'z', failingRunCount: 1 }] } } });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-5', cwd: plainDir }, { cwd: plainDir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally { cleanup(); rmSync(plainDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('ci_status_signal off: no note even with a red cache, and no scout-latest.json means fully silent', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/somerepo': { checkedAt: new Date().toISOString(), ok: true, red: true, workflows: [{ name: 'tests', redSince: 'y', latestUrl: 'z', failingRunCount: 1 }] } } });
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-6', cwd: repoDir }, {
      cwd: repoDir,
      env: { CLAUDE_PLUGIN_OPTION_CI_STATUS_SIGNAL: 'false', CLAUDE_PLUGIN_OPTION_SCOUT_SURFACE: 'false' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('the CI-red note and the generic scout-signal block are independent: scout_surface off still shows the CI note', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/somerepo': { checkedAt: new Date().toISOString(), ok: true, red: true, workflows: [{ name: 'tests', redSince: 'y', latestUrl: 'z', failingRunCount: 1 }] } } });
    writeFileSync(join(acStateDir(), 'scout-latest.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), changed: true, signals: [{ kind: 'zero_denials', detail: 'x', dispatch: 'guardrail-canary' }],
    }));
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-7', cwd: repoDir }, {
      cwd: repoDir,
      env: { CLAUDE_PLUGIN_OPTION_SCOUT_SURFACE: 'false' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.json.hookSpecificOutput.additionalContext, /main CI red since/);
    assert.ok(!res.json.hookSpecificOutput.additionalContext.includes('zero_denials'), 'scout_surface off must still suppress the generic scout block');
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('both fire together: CI-red note plus the generic scout-signal block, combined in one output', () => {
  const { cleanup } = makeFixture();
  const repoDir = makeRepoDir('git@github.com:someowner/somerepo.git');
  try {
    writeBaseline({ ciStatusCache: { 'someowner/somerepo': { checkedAt: new Date().toISOString(), ok: true, red: true, workflows: [{ name: 'tests', redSince: 'y', latestUrl: 'z', failingRunCount: 1 }] } } });
    writeFileSync(join(acStateDir(), 'scout-latest.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), changed: true, signals: [{ kind: 'zero_denials', detail: 'x', dispatch: 'guardrail-canary' }],
    }));
    const res = runHook('hooks/scout-surface.mjs', { session_id: 'sess-8', cwd: repoDir }, { cwd: repoDir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.json.hookSpecificOutput.additionalContext, /main CI red since/);
    assert.match(res.json.hookSpecificOutput.additionalContext, /zero_denials/);
  } finally { cleanup(); rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 }); }
});
