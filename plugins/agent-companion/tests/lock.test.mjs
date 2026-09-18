import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { stateDir } from '../hooks/lib/context.mjs';

test('a held fresh lock returns skipped: locked', () => {
  const { cleanup } = makeFixture();
  try {
    const sd = stateDir();
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, 'sync.lock'), JSON.stringify({ pid: 999999, at: Date.now() }), { flag: 'wx' });

    const result = syncLegacy();
    assert.equal(result.skipped, 'locked');
    assert.deepEqual(result.imported, {});
  } finally {
    cleanup();
  }
});

test('a stale lock (older than 60s) is taken over and the sync proceeds', () => {
  const { cleanup } = makeFixture();
  try {
    const sd = stateDir();
    mkdirSync(sd, { recursive: true });
    const staleAt = Date.now() - 61000;
    writeFileSync(join(sd, 'sync.lock'), JSON.stringify({ pid: 999999, at: staleAt }), { flag: 'wx' });

    const result = syncLegacy();
    assert.equal(result.skipped, null);
    assert.ok(result.imported, 'expected an imported summary');
    assert.deepEqual(Object.keys(result.imported).sort(), ['denials.jsonl', 'spawns.jsonl', 'subagent-starts.jsonl', 'unknown-agent-types.jsonl'].sort());
  } finally {
    cleanup();
  }
});

test('a corrupt (non-JSON) lock falls back to file mtime for staleness, instead of blocking forever', () => {
  const { cleanup } = makeFixture();
  try {
    const sd = stateDir();
    mkdirSync(sd, { recursive: true });
    const lockFile = join(sd, 'sync.lock');
    writeFileSync(lockFile, 'this is not json {{{ garbage \x00\x01 content');

    // Backdate the lock file's mtime 2 minutes, well past the 60s staleness
    // threshold. Without a fallback to mtime, an unparseable `at` field left
    // the lock's age permanently unknown (-1), which read as "always held" —
    // a corrupt lock stopped every future sync, not just this one.
    const twoMinutesAgo = new Date(Date.now() - 120000);
    utimesSync(lockFile, twoMinutesAgo, twoMinutesAgo);

    const result = syncLegacy();
    assert.equal(result.skipped, null, `expected the corrupt-but-stale lock to be taken over, got: ${result.skipped}`);
    assert.ok(result.imported, 'expected an imported summary');

    // The lock must be released (not left behind) once the sync completes.
    assert.equal(existsSync(lockFile), false, 'lock file should be released after a successful sync');
  } finally {
    cleanup();
  }
});
