// Tests for scripts/ci-local.mjs's own argument handling and pre-push ref
// filtering. Deliberately narrow: this exercises the pure parsing/classifying
// functions only, never the real suites (running scripts-tests,
// agent-companion-tests or leak-check FROM WITHIN this file would make the
// unit tests take as long as the whole CI run they're meant to gate quickly
// before). Suite execution itself is proven separately, by hand, per
// CONTRIBUTING.md's pre-push section and the ci-local proofs in the PR.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs, classifyRef, parsePrePushStdin, isDeletedRef, readCheckoutDepth,
  SUITE_NAMES, DEFAULT_ORDER,
} from '../ci-local.mjs';

// --- parseArgs ---------------------------------------------------------

test('parseArgs: no arguments runs the default order, no parity, no hook', () => {
  const opts = parseArgs([]);
  assert.deepEqual(opts.suites, DEFAULT_ORDER);
  assert.equal(opts.ciParity, false);
  assert.equal(opts.prePushHook, false);
  assert.equal(opts.ref, 'HEAD');
});

test('parseArgs: --suite selects exactly that suite', () => {
  const opts = parseArgs(['--suite', 'leak-check']);
  assert.deepEqual(opts.suites, ['leak-check']);
});

test('parseArgs: --suite is repeatable', () => {
  const opts = parseArgs(['--suite', 'leak-check', '--suite', 'scripts-tests']);
  assert.deepEqual(opts.suites, ['leak-check', 'scripts-tests']);
});

test('parseArgs: --suite rejects an unknown suite name', () => {
  assert.throws(() => parseArgs(['--suite', 'nope']), /unknown suite "nope"/);
});

test('parseArgs: --suite with no value throws', () => {
  assert.throws(() => parseArgs(['--suite']), /--suite requires a value/);
});

test('parseArgs: --ci-parity sets the flag', () => {
  assert.equal(parseArgs(['--ci-parity']).ciParity, true);
});

test('parseArgs: --ref overrides the default ref', () => {
  assert.equal(parseArgs(['--ref', 'abc123']).ref, 'abc123');
});

test('parseArgs: --ref with no value throws', () => {
  assert.throws(() => parseArgs(['--ref']), /--ref requires a value/);
});

test('parseArgs: --pre-push-hook sets the flag', () => {
  assert.equal(parseArgs(['--pre-push-hook']).prePushHook, true);
});

test('parseArgs: --help sets the flag without requiring other args', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: an unknown flag throws with a clear message', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument "--bogus"/);
});

test('every suite name is a real, known suite', () => {
  for (const name of DEFAULT_ORDER) assert.ok(SUITE_NAMES.includes(name));
});

// --- classifyRef ---------------------------------------------------------

test('classifyRef: wip/** is skipped', () => {
  assert.equal(classifyRef('refs/heads/wip/ac-ci-local'), 'skip');
  assert.equal(classifyRef('wip/anything'), 'skip');
});

test('classifyRef: backup/** is skipped', () => {
  assert.equal(classifyRef('refs/heads/backup/main-pre-release-2026-09-23'), 'skip');
  assert.equal(classifyRef('backup/foo'), 'skip');
});

test('classifyRef: main gets --ci-parity treatment', () => {
  assert.equal(classifyRef('refs/heads/main'), 'parity');
  assert.equal(classifyRef('main'), 'parity');
});

test('classifyRef: release/** gets --ci-parity treatment', () => {
  assert.equal(classifyRef('refs/heads/release/0.29.0'), 'parity');
  assert.equal(classifyRef('release/ac-0.29.0'), 'parity');
});

test('classifyRef: an ordinary feature branch gets the normal (non-parity) suite', () => {
  assert.equal(classifyRef('refs/heads/feat/ac-routing-profile-s2'), 'normal');
  assert.equal(classifyRef('some-branch'), 'normal');
});

test('classifyRef: a branch that merely starts with "main" or "release" but is not that ref is not special-cased', () => {
  assert.equal(classifyRef('refs/heads/main-side-quest'), 'normal');
  assert.equal(classifyRef('refs/heads/releaser'), 'normal');
});

// --- parsePrePushStdin / isDeletedRef -------------------------------------

test('parsePrePushStdin: parses the git pre-push protocol (local ref, local sha, remote ref, remote sha)', () => {
  const stdin = 'refs/heads/wip/x deadbeef refs/heads/wip/x feedface\n'
    + 'refs/heads/main abc refs/heads/main def\n';
  const refs = parsePrePushStdin(stdin);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    localRef: 'refs/heads/wip/x', localSha: 'deadbeef', remoteRef: 'refs/heads/wip/x', remoteSha: 'feedface',
  });
  assert.equal(refs[1].remoteRef, 'refs/heads/main');
});

test('parsePrePushStdin: ignores blank lines', () => {
  const refs = parsePrePushStdin('\n\nrefs/heads/main a b c\n\n');
  assert.equal(refs.length, 1);
});

test('parsePrePushStdin: empty input yields no refs', () => {
  assert.deepEqual(parsePrePushStdin(''), []);
  assert.deepEqual(parsePrePushStdin(undefined), []);
});

test('isDeletedRef: an all-zero sha is a delete', () => {
  assert.equal(isDeletedRef('0000000000000000000000000000000000000000'), true);
  assert.equal(isDeletedRef('0'), true);
});

test('isDeletedRef: a real sha is not a delete', () => {
  assert.equal(isDeletedRef('deadbeef'), false);
  assert.equal(isDeletedRef(''), false);
  assert.equal(isDeletedRef(undefined), false);
});

// --- readCheckoutDepth -----------------------------------------------------

const temps = [];
function tmpFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-depth-'));
  temps.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test('readCheckoutDepth: an explicit fetch-depth is read as a number', () => {
  const path = tmpFile('wf.yml', 'steps:\n  - uses: actions/checkout@v7\n    with:\n      fetch-depth: 0\n');
  assert.equal(readCheckoutDepth(path), 0);
});

test('readCheckoutDepth: a positive fetch-depth is read as a number', () => {
  const path = tmpFile('wf.yml', 'with:\n  fetch-depth: 25\n');
  assert.equal(readCheckoutDepth(path), 25);
});

test('readCheckoutDepth: no fetch-depth line means the actions/checkout default of 1', () => {
  const path = tmpFile('wf.yml', 'steps:\n  - uses: actions/checkout@v7\n');
  assert.equal(readCheckoutDepth(path), 1);
});

test('readCheckoutDepth: a missing file means the default of 1', () => {
  assert.equal(readCheckoutDepth(join(tmpdir(), 'does-not-exist-ci-local.yml')), 1);
});
