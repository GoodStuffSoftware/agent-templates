import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, readJsonl } from './helpers.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';

function legacyDir(fixtureDir, name) {
  const d = join(fixtureDir, '.claude', 'plugins', 'data', name);
  mkdirSync(d, { recursive: true });
  return d;
}
function appendRow(file, obj) {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}
function row(sid, at) {
  return { v: 1, at, session_id: sid, model: 'sonnet' };
}

test('incremental: append 3 rows, re-sync adds exactly 3, re-sync again adds 0', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const A = legacyDir(dir, 'agent-companion-a');
    const file = join(A, 'spawns.jsonl');

    appendRow(file, row('sess-1', '2026-02-01T00:00:00.000Z'));
    const first = syncLegacy();
    assert.equal(first.skipped, null);
    assert.equal(first.imported['spawns.jsonl'], 1);
    assert.equal(readJsonl(join(telemetryDir(), 'spawns.jsonl')).length, 1);

    appendRow(file, row('sess-2', '2026-02-01T01:00:00.000Z'));
    appendRow(file, row('sess-3', '2026-02-01T02:00:00.000Z'));
    appendRow(file, row('sess-4', '2026-02-01T03:00:00.000Z'));
    const second = syncLegacy();
    assert.equal(second.skipped, null);
    assert.equal(second.imported['spawns.jsonl'], 3, 'expected exactly 3 new rows imported');
    assert.equal(readJsonl(join(telemetryDir(), 'spawns.jsonl')).length, 4);

    const third = syncLegacy();
    assert.equal(third.skipped, null);
    assert.equal(third.imported['spawns.jsonl'], 0, 'a re-sync with nothing new must import 0');
    assert.equal(readJsonl(join(telemetryDir(), 'spawns.jsonl')).length, 4);
  } finally {
    cleanup();
  }
});

test('incremental: recreating a legacy file resets the cursor, dedup prevents re-adding old rows', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const A = legacyDir(dir, 'agent-companion-a');
    const file = join(A, 'spawns.jsonl');

    appendRow(file, row('sess-old-1', '2026-03-01T00:00:00.000Z'));
    appendRow(file, row('sess-old-2', '2026-03-01T01:00:00.000Z'));
    const first = syncLegacy();
    assert.equal(first.imported['spawns.jsonl'], 2);
    assert.equal(readJsonl(join(telemetryDir(), 'spawns.jsonl')).length, 2);

    // Recreate the file (e.g. a reinstall wrote a fresh copy) with DIFFERENT
    // head bytes but including one row identical to what was already synced.
    writeFileSync(file, ''); // truncate
    appendRow(file, row('sess-old-1', '2026-03-01T00:00:00.000Z')); // same as before: must dedup
    appendRow(file, row('sess-new-1', '2026-03-01T05:00:00.000Z')); // genuinely new

    const second = syncLegacy();
    assert.equal(second.skipped, null);
    // The cursor resets (head hash changed), so both lines are re-read, but
    // the line-hash dedup against the destination prevents sess-old-1 from
    // being re-added — only sess-new-1 should land.
    assert.equal(second.imported['spawns.jsonl'], 1, `expected exactly 1 new row, got ${JSON.stringify(second.imported)}`);
    const rows = readJsonl(join(telemetryDir(), 'spawns.jsonl'));
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.session_id === 'sess-old-1').length, 1, 'sess-old-1 must not be duplicated');
    assert.ok(rows.some((r) => r.session_id === 'sess-new-1'));
  } finally {
    cleanup();
  }
});
