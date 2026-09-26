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

// A backgrounded Agent launch and its completion notification — see
// hooks/lib/poll-guard.mjs hasInFlightLaunch(); the corroborating "harness-
// tracked work in flight" evidence guard-b's fix (finding 1) requires.
function backgroundAgentLaunchLine(ts, name) {
  return assistantWakeLine(ts, { toolName: 'Agent', input: { run_in_background: true, ...(name ? { name } : {}) } });
}
function taskNotificationLine(ts, name) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    isMeta: true,
    origin: { kind: 'task-notification' },
    message: { content: [{ type: 'text', text: `<task-notification>\n<summary>Agent "${name}" completed</summary>\n</task-notification>` }] },
  });
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

test('scanPollGuardEpisodes: a noop-streak ScheduleWakeup run, with a backgrounded launch in flight, is counted as one episode, wakes = streak + 1', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess1', [
      backgroundAgentLaunchLine(plusMs(-1000)),
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
    // contextTokens sums the triggering call + its 2 prior ScheduleWakeup
    // calls' contexts (input 100 + read N for each of the 3 lines:
    // 1100+2100+3100 = 6300) -- the launch line's own context is never
    // counted in a ScheduleWakeup episode's re-read cost.
    assert.equal(ep.contextTokens, 1100 + 2100 + 3100);
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a noop-streak ScheduleWakeup run with NO backgrounded launch anywhere is not an episode (FIX finding 1)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess1b', [
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 1000 }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 2000 }),
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 3000 }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 0, 'no corroborating harness-tracked launch: this reads as external-state polling');
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a launch that already completed (its task-notification is in the file) is not an episode (FIX: in-flight means not yet completed)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess1d', [
      backgroundAgentLaunchLine(plusMs(-2000), 'worker-1'),
      taskNotificationLine(plusMs(-1000), 'worker-1'),
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true } }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 0, 'launched then completed: nothing is actually in flight, so this reads as external-state polling');
  } finally { cleanup(); }
});

test('scanPollGuardEpisodes: a continuous escalating watch merges into ONE episode, not one per tick (FIX decision 1, second half)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    writeSession(root, 'proj1', 'sess1c', [
      backgroundAgentLaunchLine(plusMs(-1000)),
      assistantWakeLine(plusMs(0), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
      assistantWakeLine(plusMs(1000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
      // From here on, every call is ALREADY flagged (streak keeps climbing
      // 2, 3, 4, 5) -- the review's own complaint was this reported as 4
      // separate escalating episodes instead of one continuous watch.
      assistantWakeLine(plusMs(2000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
      assistantWakeLine(plusMs(3000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
      assistantWakeLine(plusMs(4000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
      assistantWakeLine(plusMs(5000), { toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 100 }),
    ]);
    const result = await scanPollGuardEpisodes({ root });
    assert.equal(result.episodeCount, 1, `expected the whole continuous run to merge into 1 episode; got ${JSON.stringify(result.episodes)}`);
    // 6 ScheduleWakeup calls total; the first 2 never flag on their own
    // (streak below the default threshold of 2), flagging starts on the
    // 3rd (streak 2, wakes 3) and climbs through the 6th (streak 5, wakes
    // 6) -- the merged episode's final wakes/contextTokens cover the WHOLE
    // continuous run (all 6 calls: 6 x 200 context tokens each), not just
    // the last tick and not one row per escalating tick.
    assert.equal(result.episodes[0].wakes, 6);
    assert.equal(result.episodes[0].contextTokens, 1200);
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
      backgroundAgentLaunchLine(plusMs(-1000)),
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
    const streak3 = (offset) => [
      backgroundAgentLaunchLine(plusMs(offset - 1000)),
      ...[0, 1000, 2000].map((ms) => assistantWakeLine(plusMs(offset + ms), {
        toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, read: 500,
      })),
    ];
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
