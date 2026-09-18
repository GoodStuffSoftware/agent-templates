import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, readJsonl } from './helpers.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { stateDir, telemetryDir } from '../hooks/lib/context.mjs';

function legacyDir(fixtureDir, name) {
  const d = join(fixtureDir, '.claude', 'plugins', 'data', name);
  mkdirSync(d, { recursive: true });
  return d;
}

function appendRow(file, obj) {
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

test('first import: 3 legacy dirs, overlapping rows, fixtures, unsorted timestamps, 50 dup unknown-types', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const A = legacyDir(dir, 'agent-companion-a');
    const B = legacyDir(dir, 'agent-companion-b');
    const C = legacyDir(dir, 'agent-companion-c');

    // --- spawns.jsonl: overlap, fixture session, unsorted, one row with no `at` ---
    const rowX = { v: 1, at: '2026-01-01T00:00:00.000Z', session_id: 'sess-1', model: 'sonnet' };
    const rowY = { v: 1, at: '2026-01-03T00:00:00.000Z', session_id: 'sess-2', model: 'sonnet' };
    const rowZ = { v: 1, at: '2026-01-02T12:00:00.000Z', session_id: 'sess-3', model: 'sonnet' };
    const rowW = { v: 1, at: '2026-01-01T06:00:00.000Z', session_id: 'sess-4', model: 'sonnet' };
    const rowNoAt = { v: 1, session_id: 'sess-5', model: 'sonnet' }; // no `at` at all
    const rowFixture = { v: 1, at: '2026-01-02T00:00:00.000Z', session_id: 'verify-opt-case-test-1', model: 'sonnet' };

    appendRow(join(A, 'spawns.jsonl'), rowX);
    appendRow(join(A, 'spawns.jsonl'), rowY);
    appendRow(join(A, 'spawns.jsonl'), rowFixture);
    appendRow(join(B, 'spawns.jsonl'), rowX); // exact duplicate of A's row
    appendRow(join(B, 'spawns.jsonl'), rowZ);
    appendRow(join(C, 'spawns.jsonl'), rowW);
    appendRow(join(C, 'spawns.jsonl'), rowNoAt);

    // --- unknown-agent-types.jsonl: 50 dup rows across 2 types ---
    let total = 0;
    for (let i = 0; i < 30; i++) {
      appendRow(join([A, B, C][i % 3], 'unknown-agent-types.jsonl'), {
        v: 1, at: new Date(2026, 0, 1, 0, 0, i).toISOString(), agent_type: 'ghost-type-a',
      });
      total++;
    }
    for (let i = 0; i < 20; i++) {
      appendRow(join([A, B, C][i % 3], 'unknown-agent-types.jsonl'), {
        v: 1, at: new Date(2026, 0, 1, 1, 0, i).toISOString(), agent_type: 'ghost-type-b',
      });
      total++;
    }
    assert.equal(total, 50);

    // --- state files for the state-file import rules ---
    writeFileSync(join(A, 'baseline.json'), JSON.stringify({ checkedAt: '2026-01-01T00:00:00.000Z', version: 'v-old' }));
    writeFileSync(join(B, 'baseline.json'), JSON.stringify({ checkedAt: '2026-01-05T00:00:00.000Z', version: 'v-new' }));

    writeFileSync(join(A, 'scout-latest.json'), JSON.stringify({ checkedAt: '2026-01-02T00:00:00.000Z', changed: false, signals: [] }));
    writeFileSync(join(C, 'scout-latest.json'), JSON.stringify({ checkedAt: '2026-01-06T00:00:00.000Z', changed: true, signals: [{ kind: 'x', detail: 'd', dispatch: 'none' }] }));

    writeFileSync(join(A, 'version-notice-state.json'), JSON.stringify({
      'sess-a': { loadedAt: 1000, shown: ['x'], at: 5000 },
      'sess-shared': { loadedAt: 1, shown: [], at: 1000 },
    }));
    writeFileSync(join(B, 'version-notice-state.json'), JSON.stringify({
      'sess-b': { loadedAt: 2000, shown: ['y'], at: 6000 },
      'sess-shared': { loadedAt: 2, shown: ['z'], at: 2000 }, // newer `at`: should win over A's
    }));

    writeFileSync(join(A, 'upload-state.json'), JSON.stringify({
      machineId: 'machine-a', label: 'label-a', offsets: { 'spawns.jsonl': 1 }, lastSentAt: 1234,
    }));

    // --- run the import ---
    const result = syncLegacy();
    assert.equal(result.skipped, null, `sync should not skip: ${result.skipped}`);

    // spawns.jsonl: sorted by `at`, deduped, fixture routed out, no-`at` row last.
    const spawns = readJsonl(join(telemetryDir(), 'spawns.jsonl'));
    assert.equal(spawns.length, 5, `expected 5 deduped production spawn rows, got ${spawns.length}`);
    assert.deepEqual(spawns.map((r) => r.session_id), ['sess-1', 'sess-4', 'sess-3', 'sess-2', 'sess-5']);
    assert.ok(!spawns.some((r) => r.session_id === 'verify-opt-case-test-1'), 'fixture row must not be in production spawns.jsonl');

    const fixtures = readJsonl(join(telemetryDir(), 'fixtures.jsonl'));
    const fixtureRow = fixtures.find((r) => r.session_id === 'verify-opt-case-test-1');
    assert.ok(fixtureRow, 'fixture-session row should land in fixtures.jsonl');
    assert.equal(fixtureRow.stream, 'spawns.jsonl');

    // unknown-agent-types.jsonl: exactly 2 rows, 2 markers.
    const unknownRows = readJsonl(join(telemetryDir(), 'unknown-agent-types.jsonl'));
    assert.equal(unknownRows.length, 2, `expected 2 unknown-agent-type rows, got ${unknownRows.length}`);
    assert.deepEqual(new Set(unknownRows.map((r) => r.agent_type)), new Set(['ghost-type-a', 'ghost-type-b']));

    const markersDir = join(stateDir(), 'agent-types');
    const markers = readdirSync(markersDir);
    assert.equal(markers.length, 2, `expected 2 marker files, got ${markers.length}: ${markers.join(', ')}`);

    // Backup: verbatim copies under migration/backup-<stamp>/<dirname>/.
    assert.ok(result.imported, 'expected an imported summary');
    const migratedFile = join(stateDir(), 'migrated.json');
    assert.ok(existsSync(migratedFile), 'migrated.json should have been written');
    const migrated = JSON.parse(readFileSync(migratedFile, 'utf8'));
    assert.ok(migrated.backup, 'migrated.json should record a backup path');
    assert.ok(existsSync(migrated.backup), `backup dir should exist: ${migrated.backup}`);
    assert.ok(existsSync(join(migrated.backup, 'agent-companion-a', 'spawns.jsonl')), 'backup should include dir a spawns.jsonl');
    assert.ok(existsSync(join(migrated.backup, 'agent-companion-b', 'spawns.jsonl')), 'backup should include dir b spawns.jsonl');
    assert.ok(existsSync(join(migrated.backup, 'agent-companion-a', 'baseline.json')), 'backup should include dir a baseline.json');
    const backedUpX = readJsonl(join(migrated.backup, 'agent-companion-a', 'spawns.jsonl'));
    assert.deepEqual(backedUpX[0], rowX, 'backup must be a verbatim copy of the source');

    assert.equal(migrated.rows['spawns.jsonl'].written, 5);
    assert.equal(migrated.rows['spawns.jsonl'].fixtures, 1);
    assert.ok(migrated.rows['spawns.jsonl'].dupes >= 1, 'expected at least 1 dupe (rowX repeated)');
    assert.equal(migrated.rows['unknown-agent-types.jsonl'].written, 2);
    assert.equal(migrated.rows['unknown-agent-types.jsonl'].dupes, 48);

    // baseline.json: newest checkedAt wins (dir B).
    const baseline = JSON.parse(readFileSync(join(stateDir(), 'baseline.json'), 'utf8'));
    assert.equal(baseline.version, 'v-new');
    assert.equal(baseline.checkedAt, '2026-01-05T00:00:00.000Z');

    // scout-latest.json: newest checkedAt wins (dir C).
    const scoutLatest = JSON.parse(readFileSync(join(stateDir(), 'scout-latest.json'), 'utf8'));
    assert.equal(scoutLatest.checkedAt, '2026-01-06T00:00:00.000Z');
    assert.equal(scoutLatest.changed, true);

    // version-notice-state.json: per-session merge, newest `.at` wins for the shared key.
    const vns = JSON.parse(readFileSync(join(stateDir(), 'version-notice-state.json'), 'utf8'));
    assert.deepEqual(vns['sess-a'], { loadedAt: 1000, shown: ['x'], at: 5000 });
    assert.deepEqual(vns['sess-b'], { loadedAt: 2000, shown: ['y'], at: 6000 });
    assert.deepEqual(vns['sess-shared'], { loadedAt: 2, shown: ['z'], at: 2000 });

    // upload-state.json: base fields kept, offsets reset to post-merge counts.
    const uploadState = JSON.parse(readFileSync(join(stateDir(), 'upload-state.json'), 'utf8'));
    assert.equal(uploadState.machineId, 'machine-a');
    assert.equal(uploadState.label, 'label-a');
    assert.equal(uploadState.offsets['spawns.jsonl'], 5);
    assert.equal(uploadState.offsets['unknown-agent-types.jsonl'], 2);
    assert.equal(uploadState.offsets['denials.jsonl'], 0);
    assert.equal(uploadState.offsets['subagent-starts.jsonl'], 0);
  } finally {
    cleanup();
  }
});
