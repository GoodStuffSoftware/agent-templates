// Sweep of sandbox directories a killed test run left in the temp dir.
// Test-only support file; nothing in the plugin imports it.
//
// tests/isolate.mjs and tests/helpers.mjs (makeFixture) remove their temp
// directory from a process 'exit' handler, which does not run when the process
// is killed (a stopped terminal, a hard kill, a crashed runner). Those runs left
// `ac-suite-*` and `ac-test-*` directories behind, dozens at a time.
//
// WHICH DIRECTORIES. Names are `ac-suite-<pid>-<6 chars>` / `ac-test-<pid>-<6
// chars>` (the creator's pid is part of the name), or the older
// `ac-suite-<6 chars>` / `ac-test-<6 chars>` with no pid. Anything else in the
// temp dir (including `ac-test-home-*` and the like, which other tests own) is
// left alone.
//
// WHEN ONE IS STALE. Other suites run on the same machine at the same time, so a
// live run's directory must never be touched:
//   - a name that carries a pid is removed only when that process no longer
//     exists, and the directory is at least DEAD_OWNER_MIN_AGE_MS old;
//   - a name without a pid cannot be attributed to a process, so it is removed
//     by age alone, and only after LEGACY_MIN_AGE_MS (far longer than any test
//     file runs).
// A directory that is a symlink, or not a directory, is never removed.
// Every failure is swallowed: the sweep is housekeeping, never a reason for a
// test file to fail.

import { readdirSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEAD_OWNER_MIN_AGE_MS = 5 * 60 * 1000;
export const LEGACY_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const OWNED = /^ac-(?:suite|test)-(\d+)-[A-Za-z0-9]{6}$/;
const LEGACY = /^ac-(?:suite|test)-[A-Za-z0-9]{6}$/;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // sends nothing: only checks that the process exists
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

// Pure decision: which of `entries` ({ name, mtimeMs }) are stale.
export function selectStaleSandboxes(entries, { now = Date.now(), isPidAlive = pidAlive } = {}) {
  const stale = [];
  for (const { name, mtimeMs } of entries) {
    const age = now - mtimeMs;
    const owned = OWNED.exec(name);
    if (owned) {
      if (age >= DEAD_OWNER_MIN_AGE_MS && !isPidAlive(Number(owned[1]))) stale.push(name);
    } else if (LEGACY.test(name)) {
      if (age >= LEGACY_MIN_AGE_MS) stale.push(name);
    }
  }
  return stale;
}

// Removes the stale sandboxes under `root`; returns the names removed.
export function sweepStaleSandboxes(root = tmpdir(), { now = Date.now(), isPidAlive = pidAlive } = {}) {
  const removed = [];
  try {
    const entries = [];
    for (const name of readdirSync(root)) {
      if (!OWNED.test(name) && !LEGACY.test(name)) continue;
      try {
        const st = lstatSync(join(root, name));
        if (st.isDirectory() && !st.isSymbolicLink()) entries.push({ name, mtimeMs: st.mtimeMs });
      } catch { /* vanished or unreadable: not ours to sweep */ }
    }
    for (const name of selectStaleSandboxes(entries, { now, isPidAlive })) {
      try {
        rmSync(join(root, name), { recursive: true, force: true, maxRetries: 3 });
        removed.push(name);
      } catch { /* best effort: another sweep may be removing it too */ }
    }
  } catch { /* temp dir unreadable: nothing to do */ }
  return removed;
}
