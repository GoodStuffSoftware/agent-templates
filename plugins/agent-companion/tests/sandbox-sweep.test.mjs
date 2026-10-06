// The startup sweep of sandbox directories a killed test run left behind
// (tests/sandbox-sweep.mjs). It must remove those, and must NEVER remove the
// directory of a run that is still alive: other suites run on the same machine
// at the same time. Every directory here is one this test creates, under its
// own scratch root, so nothing in the real temp dir is touched.

import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  sweepStaleSandboxes, selectStaleSandboxes, pidAlive, DEAD_OWNER_MIN_AGE_MS, LEGACY_MIN_AGE_MS,
} from './sandbox-sweep.mjs';

const OLD = DEAD_OWNER_MIN_AGE_MS * 3;   // old enough for a dead owner's dir
const VERY_OLD = LEGACY_MIN_AGE_MS * 2;  // old enough for a pid-less dir

// A pid that belonged to a process that has exited.
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.ok(res.pid > 0);
  assert.equal(pidAlive(res.pid), false, 'a finished child must read as not alive');
  return res.pid;
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ac-sweeptest-'));
  const mk = (name, ageMs) => {
    const d = join(root, name);
    mkdirSync(join(d, 'home'), { recursive: true });
    writeFileSync(join(d, 'home', 'x'), 'x');
    const t = new Date(Date.now() - ageMs);
    utimesSync(d, t, t);
    return d;
  };
  return { root, mk, done: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

test('a dead owner\'s sandbox is swept, a live owner\'s never is, whatever its age', () => {
  const { root, mk, done } = makeRoot();
  try {
    const dead = deadPid();
    const staleSuite = mk(`ac-suite-${dead}-aB3dEf`, OLD);
    const staleTest = mk(`ac-test-${dead}-aB3dEf`, OLD);
    const live = mk(`ac-suite-${process.pid}-aB3dEf`, VERY_OLD); // this very process
    const liveTest = mk(`ac-test-${process.pid}-aB3dEf`, VERY_OLD);
    const removed = sweepStaleSandboxes(root);
    assert.deepEqual(removed.sort(), [`ac-suite-${dead}-aB3dEf`, `ac-test-${dead}-aB3dEf`].sort());
    assert.equal(existsSync(staleSuite), false);
    assert.equal(existsSync(staleTest), false);
    assert.equal(existsSync(live), true, 'a directory owned by a live process must survive');
    assert.equal(existsSync(liveTest), true);
  } finally { done(); }
});

test('a dead owner\'s FRESH directory is kept (a run that just ended, or a pid read too early)', () => {
  const { root, mk, done } = makeRoot();
  try {
    const dead = deadPid();
    const fresh = mk(`ac-suite-${dead}-aB3dEf`, 1000);
    assert.deepEqual(sweepStaleSandboxes(root), []);
    assert.equal(existsSync(fresh), true);
  } finally { done(); }
});

test('a directory with no pid in its name goes by age alone, and only when very old', () => {
  const { root, mk, done } = makeRoot();
  try {
    const old = mk('ac-suite-aB3dEf', VERY_OLD);
    const oldTest = mk('ac-test-08now0', VERY_OLD);
    const recent = mk('ac-suite-Zy9xWv', OLD);       // older than a dead owner's grace, far younger than the fallback
    const recentTest = mk('ac-test-0rE5Ze', 1000);
    assert.deepEqual(sweepStaleSandboxes(root).sort(), ['ac-suite-aB3dEf', 'ac-test-08now0']);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(oldTest), false);
    assert.equal(existsSync(recent), true, 'it may belong to a run of an older harness that is still going');
    assert.equal(existsSync(recentTest), true);
  } finally { done(); }
});

test('names that are not ours, a plain file and a symlink are never touched', () => {
  const { root, mk, done } = makeRoot();
  try {
    const dead = deadPid();
    const others = [
      mk('ac-test-home-aB3dEf', VERY_OLD),        // owned by resolver.test.mjs
      mk('ac-test-config-aB3dEf', VERY_OLD),
      mk('ac-suite-aB3dEf-extra', VERY_OLD),
      mk(`ac-suite-${dead}-short`, VERY_OLD),
      mk('something-else', VERY_OLD),
      mk(`xac-suite-${dead}-aB3dEf`, VERY_OLD),
    ];
    const file = join(root, `ac-suite-${dead}-fIlE01`);
    writeFileSync(file, 'not a directory');
    const t = new Date(Date.now() - VERY_OLD);
    utimesSync(file, t, t);
    const target = mk('link-target', VERY_OLD);
    let link = null;
    try { symlinkSync(target, join(root, `ac-suite-${dead}-lInK01`), 'junction'); link = join(root, `ac-suite-${dead}-lInK01`); } catch { /* no symlink right on this machine */ }
    assert.deepEqual(sweepStaleSandboxes(root), []);
    for (const p of [...others, file, target, ...(link ? [link] : [])]) assert.equal(existsSync(p), true, `${p} must survive`);
  } finally { done(); }
});

test('selectStaleSandboxes is a pure decision over injected inputs', () => {
  const now = 1_000_000_000_000;
  const alive = new Set([111]);
  const entries = [
    { name: 'ac-suite-111-aaaaaa', mtimeMs: now - VERY_OLD },
    { name: 'ac-suite-222-aaaaaa', mtimeMs: now - OLD },
    { name: 'ac-suite-222-bbbbbb', mtimeMs: now - 5 },
    { name: 'ac-test-cccccc', mtimeMs: now - VERY_OLD },
  ];
  assert.deepEqual(
    selectStaleSandboxes(entries, { now, isPidAlive: (p) => alive.has(p) }),
    ['ac-suite-222-aaaaaa', 'ac-test-cccccc'],
  );
});

test('a missing temp root is not an error', () => {
  assert.deepEqual(sweepStaleSandboxes(join(tmpdir(), 'ac-sweeptest-does-not-exist-xyz')), []);
});
