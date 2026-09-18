import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { telemetryCoverage } from '../scripts/lib/coverage.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';

function agentToolUseLine(timestamp, id) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] },
  });
}

function spawnRow(at) {
  return JSON.stringify({ v: 2, at, session_id: `sess-${at}`, model: 'sonnet' });
}

test('telemetryCoverage: silent, partial, ok statuses; today excluded from silent; dedup by tool_use.id', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const now = new Date('2026-05-10T12:00:00.000Z');
    const projectsRoot = join(dir, 'projects', 'fake-project');
    mkdirSync(projectsRoot, { recursive: true });
    const subagentsDir = join(projectsRoot, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });

    // Day 05-07 (3 days back): SILENT. 2 distinct ids, one re-logged (dup).
    const day07 = [
      agentToolUseLine('2026-05-07T10:00:00.000Z', 'toolu-a1'),
      agentToolUseLine('2026-05-07T10:05:00.000Z', 'toolu-a2'),
      agentToolUseLine('2026-05-07T10:06:00.000Z', 'toolu-a1'), // re-logged duplicate
    ];
    writeFileSync(join(projectsRoot, 'session-1.jsonl'), `${day07.join('\n')}\n`);

    // Day 05-08 (2 days back): PARTIAL. 4 distinct ids, only 1 telemetry row.
    const day08 = [
      agentToolUseLine('2026-05-08T09:00:00.000Z', 'toolu-b1'),
      agentToolUseLine('2026-05-08T09:01:00.000Z', 'toolu-b2'),
      agentToolUseLine('2026-05-08T09:02:00.000Z', 'toolu-b3'),
      agentToolUseLine('2026-05-08T09:03:00.000Z', 'toolu-b4'),
    ];
    writeFileSync(join(projectsRoot, 'session-2.jsonl'), `${day08.join('\n')}\n`);

    // Day 05-09 (1 day back): OK. 2 distinct ids, 2 telemetry rows. Written
    // under */subagents/ to also exercise the recursive walk.
    const day09 = [
      agentToolUseLine('2026-05-09T08:00:00.000Z', 'toolu-c1'),
      agentToolUseLine('2026-05-09T08:01:00.000Z', 'toolu-c2'),
    ];
    writeFileSync(join(subagentsDir, 'agent-x.jsonl'), `${day09.join('\n')}\n`);

    // Day 05-10 (today): would-be silent (2 transcript, 0 telemetry) but must
    // never be reported as `silent` -- only `partial`, with partialDay:true.
    const day10 = [
      agentToolUseLine('2026-05-10T11:00:00.000Z', 'toolu-d1'),
      agentToolUseLine('2026-05-10T11:01:00.000Z', 'toolu-d2'),
    ];
    writeFileSync(join(projectsRoot, 'session-3.jsonl'), `${day10.join('\n')}\n`);

    // Telemetry: only day 05-08 (1 row) and day 05-09 (2 rows).
    const spawnsFile = join(telemetryDir(), 'spawns.jsonl');
    const rows = [
      spawnRow('2026-05-08T09:00:00.000Z'),
      spawnRow('2026-05-09T08:00:00.000Z'),
      spawnRow('2026-05-09T08:01:00.000Z'),
    ];
    appendFileSync(spawnsFile, `${rows.join('\n')}\n`);

    const result = await telemetryCoverage({ days: 7, now, transcriptsRoot: projectsRoot });

    const byDay = Object.fromEntries(result.days.map((d) => [d.day, d]));

    assert.equal(byDay['2026-05-07'].status, 'silent');
    assert.equal(byDay['2026-05-07'].transcriptSpawns, 2, 'the re-logged duplicate must be deduped by tool_use.id');
    assert.equal(byDay['2026-05-07'].telemetryRows, 0);

    assert.equal(byDay['2026-05-08'].status, 'partial');
    assert.equal(byDay['2026-05-08'].transcriptSpawns, 4);
    assert.equal(byDay['2026-05-08'].telemetryRows, 1);

    assert.equal(byDay['2026-05-09'].status, 'ok');
    assert.equal(byDay['2026-05-09'].transcriptSpawns, 2);
    assert.equal(byDay['2026-05-09'].telemetryRows, 2);

    assert.notEqual(byDay['2026-05-10'].status, 'silent', 'today must never be reported as silent');
    assert.equal(byDay['2026-05-10'].partialDay, true);

    assert.equal(result.silentDays, 1);
    assert.equal(result.windowDays, 7);
    assert.equal(result.days.length, 7);
  } finally {
    cleanup();
  }
});
