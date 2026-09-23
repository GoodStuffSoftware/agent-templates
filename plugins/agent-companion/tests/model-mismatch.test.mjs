// SPAWNING RULE 3 (operator-approved 2026-09-23): the model a spawn actually
// ran on must match what its definition's alias resolves to on the build
// that session ran. Exercises scripts/lib/model-mismatch.mjs directly — same
// transcriptsRoot-override pattern tests/coverage.test.mjs uses for the
// sibling telemetry-coverage check, so no real ~/.claude/projects data is
// ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { scanModelMismatches } from '../scripts/lib/model-mismatch.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';

function spawnRow(at, sessionId, model, extra = {}) {
  return JSON.stringify({ v: 2, at, session_id: sessionId, model, model_definition: null, ...extra });
}

function subagentTranscript(dir, sessionId, agentFile, { headTs, version, tailTs, model }) {
  const subDir = join(dir, 'proj', sessionId, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', timestamp: headTs, version, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: tailTs, message: { role: 'assistant', model } }),
  ];
  writeFileSync(join(subDir, agentFile), `${lines.join('\n')}\n`);
}

test('correct resolution: same alias, current-generation id — no finding', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-ok', 'opus')}\n`);
    subagentTranscript(dir, 'sess-ok', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:05.000Z', model: 'claude-opus-5-5',
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.matched, 1);
    assert.equal(result.mismatches.length, 0);
  } finally {
    cleanup();
  }
});

test('gross alias mismatch: sonnet requested, opus actually ran', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-gross', 'sonnet')}\n`);
    subagentTranscript(dir, 'sess-gross', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:05.000Z', model: 'claude-opus-5-5',
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].kind, 'alias_mismatch');
    assert.equal(result.mismatches[0].requestedAlias, 'sonnet');
    assert.equal(result.mismatches[0].actualAlias, 'opus');
  } finally {
    cleanup();
  }
});

test('stale generation: opus requested, resolved to the SUPERSEDED Opus 5 id — belowFloor true on an old build', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-stale', 'opus')}\n`);
    subagentTranscript(dir, 'sess-stale', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.275', // below the 2.1.280 floor
      tailTs: '2026-09-23T12:00:05.000Z', model: 'claude-opus-5', // the OLD, non-routable generation
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].kind, 'stale_generation');
    assert.equal(result.mismatches[0].belowFloor, true);
    assert.equal(result.mismatches[0].buildVersion, '2.1.275');
  } finally {
    cleanup();
  }
});

test('stale generation on a build AT/ABOVE the floor is still reported, with belowFloor false — a genuine anomaly, not expected', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-anomaly', 'opus')}\n`);
    subagentTranscript(dir, 'sess-anomaly', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.290', // at/above the floor
      tailTs: '2026-09-23T12:00:05.000Z', model: 'claude-opus-5', // still the OLD generation
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].belowFloor, false);
  } finally {
    cleanup();
  }
});

test('a spawn row with no matching transcript within tolerance is left unmatched, never reported as a mismatch', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-lonely', 'opus')}\n`);
    // no subagent transcript written at all
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.matched, 0);
    assert.equal(result.unmatched, 1);
    assert.equal(result.mismatches.length, 0);
  } finally {
    cleanup();
  }
});

test('near-simultaneous spawns in one session are matched by closest global pairing, not a per-row swap', async () => {
  // This fixture is built to FAIL under a naive "each row takes its own
  // nearest candidate, processed in row order" matcher, and to PASS under
  // the shipped one (sort every (row, candidate) pair by delta ascending,
  // assign greedily closest-first). A prior version of this test used two
  // pairs that were already each other's nearest match in BOTH orderings —
  // its own comment admitted "a naive... pass still gets this one right",
  // so it never actually exercised the swap bug the shipped algorithm
  // exists to prevent.
  //
  // Setup: row1 (sonnet) fires at T+0, row2 (opus) at T+1s. Candidate A's
  // transcript starts at T+1.015s — a near-exact (15ms) match for row2, but
  // still the row CLOSEST to row1 among the two candidates (1.015s beats
  // candidate B's 400s), since row1 has no closer option. Candidate B
  // starts at T+400s — far from both rows, but the only transcript that
  // "belongs" to row1 once A is correctly claimed by row2.
  //
  // A naive per-row-in-order matcher processes row1 first, and row1's own
  // nearest available candidate IS A (1.015s beats 400s) even though A is
  // really row2's near-exact match — so it wrongly claims A, leaving row2
  // to fall back to B (399s away, but still inside the 10-minute
  // tolerance). That pairing is backwards: row1 (sonnet) would be checked
  // against A's actual model (opus) and row2 (opus) against B's actual
  // model (sonnet) — TWO false alias_mismatch findings.
  //
  // The shipped matcher sorts all four (row, candidate) pairs by delta
  // ascending: (row2,A,15ms) is smallest and is assigned first, correctly
  // claiming both; only (row1,B,400000ms) remains for row1. Zero mismatches
  // is only reachable via the delta-sorted, closest-pair-first algorithm —
  // confirming the shipped matcher, not a per-row shortcut, produced this
  // result.
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'), [
      spawnRow('2026-09-23T12:00:00.000Z', 'sess-batch', 'sonnet'),
      spawnRow('2026-09-23T12:00:01.000Z', 'sess-batch', 'opus'),
    ].join('\n') + '\n');
    // Candidate A: really row2's transcript (opus) — near-exact 15ms match
    // for row2, but also row1's OWN nearest candidate (1.015s < 400s).
    subagentTranscript(dir, 'sess-batch', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:01.015Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:03.000Z', model: 'claude-opus-5-5',
    });
    // Candidate B: really row1's transcript (sonnet) — 400s from row1, the
    // only thing left once A is correctly claimed by row2.
    subagentTranscript(dir, 'sess-batch', 'agent-b.jsonl', {
      headTs: '2026-09-23T12:06:40.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:06:42.000Z', model: 'claude-sonnet-5',
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.matched, 2);
    assert.equal(result.mismatches.length, 0, `expected no mismatch (correct pairing is row2→A, row1→B), got: ${JSON.stringify(result.mismatches)}`);
  } finally {
    cleanup();
  }
});

test('an unrecognised requested model id is skipped — nothing known to compare against', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'),
      `${spawnRow('2026-09-23T12:00:00.000Z', 'sess-unknown', 'some-future-model-xyz')}\n`);
    subagentTranscript(dir, 'sess-unknown', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:05.000Z', model: 'claude-opus-5-5',
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.mismatches.length, 0);
  } finally {
    cleanup();
  }
});

test('no spawn telemetry in the window: reports cleanly, no throw', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.matched, 0);
    assert.equal(result.mismatches.length, 0);
  } finally {
    cleanup();
  }
});
