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
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-09-23T12:15:00.000Z');
    // Two rows seconds apart; two candidate transcripts seconds apart too,
    // where the SECOND row is actually the near-exact (2s) match for the
    // SECOND transcript, and the FIRST row is the near-exact match for the
    // FIRST transcript. A naive "each row takes its own nearest, in row
    // order" pass still gets this one right; the regression this guards is
    // the one measured on real data (see model-mismatch.mjs's own comment),
    // reproduced here structurally: the closer pairing must win regardless
    // of which row is processed first.
    appendFileSync(join(telemetryDir(), 'spawns.jsonl'), [
      spawnRow('2026-09-23T12:00:00.000Z', 'sess-batch', 'opus'),
      spawnRow('2026-09-23T12:00:10.000Z', 'sess-batch', 'sonnet'),
    ].join('\n') + '\n');
    subagentTranscript(dir, 'sess-batch', 'agent-a.jsonl', {
      headTs: '2026-09-23T12:00:02.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:04.000Z', model: 'claude-opus-5-5',
    });
    subagentTranscript(dir, 'sess-batch', 'agent-b.jsonl', {
      headTs: '2026-09-23T12:00:12.000Z', version: '2.1.290',
      tailTs: '2026-09-23T12:00:14.000Z', model: 'claude-sonnet-5',
    });
    const result = await scanModelMismatches({ now, transcriptsRoot: join(dir, 'proj') });
    assert.equal(result.matched, 2);
    assert.equal(result.mismatches.length, 0, `expected no mismatch, got: ${JSON.stringify(result.mismatches)}`);
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
