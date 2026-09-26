// Measurement half of cache-advisor guard (b): scripts/lib/poll-guard-report.mjs.
// Synthetic fixtures only — real transcripts are read-only and never
// committed (BRIEF.md rule 3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { scanPollGuardEpisodes } from '../scripts/lib/poll-guard-report.mjs';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const plusMs = (ms) => new Date(T0 + ms).toISOString();

function assistantWakeLine(ts, { toolName, input, read = 0, write5m = 0, model = 'claude-sonnet-5-20260101' } = {}) {
  const usage = {
    input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: 0 },
    cache_read_input_tokens: read,
    output_tokens: 10,
  };
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: `req-${ts}`,
    message: { id: `req-${ts}`, model, usage, content: [{ type: 'tool_use', name: toolName, input }] },
  });
}

function writeSession(root, project, sessionId, lines) {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

test('scanPollGuardEpisodes: empty root reports exists:false and no episodes', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const result = await scanPollGuardEpisodes({ root: join(dir, 'nope') });
    assert.equal(result.exists, false);
    assert.equal(result.episodeCount, 0);
    assert.equal(result.totalWakes, 0);
    assert.equal(result.totalContextTokens, 0);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a noop-streak ScheduleWakeup run is counted as one episode, wakes = streak + 1', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess1', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 1000 }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 2000 }),
      // 3rd call: streak of 2 priors reaches the default threshold -> episode
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 3000 }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 1, `expected 1 episode; got ${JSON.stringify(result.episodes)}`);
    const ep = result.episodes[0];
    assert.equal(ep.wakes, 3, 'wakes = streak(2) + the triggering call itself');
    assert.equal(ep.toolName, 'ScheduleWakeup');
    // contextTokens sums the triggering call + its 2 prior calls' contexts
    // (input 100 + read N for each of the 3 lines: 1100+2100+3100 = 6300)
    assert.equal(ep.contextTokens, 1100 + 2100 + 3100);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a real noop:false call resets the streak, no episode', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess2', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: false } }),
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 0);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: Monitor re-armed on the same description is an episode too', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess3', [
      assistantWakeLine(plusMs(0), { toolName: 'Monitor', input: { description: 'watch cleanup worker', timeout_ms: 60000 } }),
      assistantWakeLine(plusMs(1000), { toolName: 'Monitor', input: { description: 'watch cleanup worker', timeout_ms: 60000 } }),
      assistantWakeLine(plusMs(2000), { toolName: 'Monitor', input: { description: 'watch cleanup worker', timeout_ms: 60000 } }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 1);
    assert.equal(result.episodes[0].kind, 'monitor-rearm-streak');
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a long-delay ScheduleWakeup fallback never counts, however many in a row', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess4', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 1800, noop: true } }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 1800, noop: true } }),
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 1800, noop: true } }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 0);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: opts thresholds are honoured, same as the live hook would apply them', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess5', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
    ]);
    const strict = await scanPollGuardEpisodes({ root }); // default streak 2: needs 3 calls, only 2 here
    assert.equal(strict.episodeCount, 0);
    const loose = await scanPollGuardEpisodes({ root, opts: { noopStreak: 1 } });
    assert.equal(loose.episodeCount, 1);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: two sessions each contribute their own episode; totals sum across files', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const streak3 = (offset) => [0, 1000, 2000].map((ms) => assistantWakeLine(plusMs(offset + ms), {
      toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 500,
    }));
    writeSession(root, 'proj1', 'sessA', streak3(0));
    writeSession(root, 'proj1', 'sessB', streak3(10000));
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 2);
    assert.equal(result.totalWakes, 6);
    assert.equal(result.byFile.length, 2);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: sinceMs filters out files older than the window (by mtime)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sessOld', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
    ]);
    const result = await scanPollGuardEpisodes({ root, sinceMs: Date.now() + 1000 * 60 * 60 * 24 * 365 });
    assert.equal(result.filesRead, 0, 'a future sinceMs must exclude every file by mtime');
    assert.equal(result.episodeCount, 0);
  } finally { cleanup(); }
});
