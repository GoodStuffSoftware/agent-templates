// Guard (b) — polling wakes (cache-advisor deliverable 7).
//
// Two layers, tested separately: the pure detection logic in
// hooks/lib/poll-guard.mjs (no I/O), and the PreToolUse hook wrapper
// (hooks/poll-guard.mjs) as a child process against a synthetic transcript
// fixture — never a real one (BRIEF.md rule 3: real transcripts are
// read-only and never committed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import {
  evaluate, priorCallsOf, trailingNoopStreak, trailingSameDescriptionStreak,
  hasInFlightLaunch, gatedMonitorStreak,
  POLL_TOOLS, DEFAULT_NOOP_STREAK, DEFAULT_SHORT_DELAY_S, DEFAULT_MONITOR_REARM_STREAK,
  DEFAULT_MONITOR_SHORT_TIMEOUT_MS,
} from '../hooks/lib/poll-guard.mjs';

// --- pure logic --------------------------------------------------------------

test('poll-guard exports the two tools it watches', () => {
  assert.deepEqual([...POLL_TOOLS].sort(), ['Monitor', 'ScheduleWakeup']);
});

function assistantToolUse(name, input, ts) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { content: [{ type: 'tool_use', name, input }] },
  };
}

test('priorCallsOf pulls only the named tool, in file order, and ignores malformed records', () => {
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 300, noop: true }, 't1'),
    { type: 'assistant', message: {} }, // no content array
    null,
    { type: 'user' }, // wrong type
    assistantToolUse('Monitor', { description: 'watch x' }, 't2'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 300, noop: false }, 't3'),
  ];
  const wakes = priorCallsOf(records, 'ScheduleWakeup');
  assert.equal(wakes.length, 2);
  assert.equal(wakes[0].input.noop, true);
  assert.equal(wakes[1].input.noop, false);
});

test('trailingNoopStreak counts only the trailing run of noop:true, stops at the first non-noop', () => {
  const calls = (noops) => noops.map((noop) => ({ input: { noop } }));
  assert.equal(trailingNoopStreak(calls([true, true, true])), 3);
  assert.equal(trailingNoopStreak(calls([false, true, true])), 2);
  assert.equal(trailingNoopStreak(calls([true, false, true, true])), 2);
  assert.equal(trailingNoopStreak(calls([false, false])), 0);
  assert.equal(trailingNoopStreak([]), 0);
});

test('trailingNoopStreak treats a stop:true call as breaking the streak without counting it', () => {
  const calls = [{ input: { noop: true } }, { input: { noop: true } }, { input: { stop: true } }];
  assert.equal(trailingNoopStreak(calls), 0);
});

test('trailingSameDescriptionStreak is case/whitespace-insensitive and stops at a different description', () => {
  const calls = [
    { input: { description: 'watch CI run' } },
    { input: { description: '  Watch CI Run  ' } },
    { input: { description: 'watch ci run' } },
  ];
  assert.equal(trailingSameDescriptionStreak(calls, 'Watch CI run'), 3);
  assert.equal(trailingSameDescriptionStreak(calls, 'something else'), 0);
  assert.equal(trailingSameDescriptionStreak([], 'x'), 0);
  assert.equal(trailingSameDescriptionStreak(calls, ''), 0);
});

// A background launch the harness will notify on completion, per the
// review-b fix: this is the corroborating evidence that turns a short-delay
// noop streak into an actual banned poll of harness-tracked work, rather
// than a sanctioned watch on external state (findings 1/2,
// tests/poll-guard-review-findings.test.mjs).
function backgroundAgentLaunch(ts, name) {
  return assistantToolUse('Agent', { subagent_type: 'general-purpose', run_in_background: true, ...(name ? { name } : {}) }, ts);
}

// The harness's own completion signal for a backgrounded Agent — verified
// shape (scripts/lib/transcripts.mjs origin.kind === 'task-notification';
// tests/standing-rules.test.mjs, tests/transcripts-fix.test.mjs):
// `type:"user"`, `isMeta:true`, text wrapped as
// `<task-notification><summary>Agent "NAME" completed</summary></task-notification>`.
function taskNotification(name, ts) {
  return {
    type: 'user',
    timestamp: ts,
    isMeta: true,
    origin: { kind: 'task-notification' },
    message: { content: [{ type: 'text', text: `<task-notification>\n<summary>Agent "${name}" completed</summary>\n</task-notification>` }] },
  };
}

test('evaluate: ScheduleWakeup with stop:true is never a poll, whatever the history', () => {
  const records = Array(5).fill(0).map((_, i) => assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, `t${i}`));
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { stop: true }, records });
  assert.equal(result, null);
});

test('evaluate: ScheduleWakeup below the noop-streak threshold does not hint', () => {
  const records = [assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1')];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.equal(result, null, `1 prior noop should be below the default streak of ${DEFAULT_NOOP_STREAK}`);
});

test('evaluate: ScheduleWakeup at the noop-streak threshold AND a short delay, with an in-flight background launch, hints with a concrete streak count', () => {
  const records = [
    backgroundAgentLaunch('t0'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, records });
  assert.ok(result, 'expected a hint at the threshold with harness-tracked work in flight');
  assert.equal(result.kind, 'schedule-wakeup-noop-streak');
  assert.equal(result.streak, DEFAULT_NOOP_STREAK);
  assert.match(result.hint, /one completion/i);
  assert.match(result.hint, /2 consecutive no-op wakes/);
});

test('evaluate: the SAME noop streak with no in-flight background launch anywhere in the tail does not hint (FIX: finding 1, external-state polling)', () => {
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, records });
  assert.equal(result, null, 'no corroborating harness-tracked launch: this must not fire the banned-poll hint');
});

test('evaluate: a backgrounded Bash task in flight is corroborating evidence too (not just Agent)', () => {
  const records = [
    assistantToolUse('Bash', { command: 'npm run build', run_in_background: true }, 't0'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.ok(result, 'a backgrounded Bash launch is harness-tracked work in flight');
});

test('evaluate: a FOREGROUND Agent call (no run_in_background) is not in-flight evidence', () => {
  const records = [
    assistantToolUse('Agent', { subagent_type: 'general-purpose' }, 't0'), // no run_in_background: true
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.equal(result, null, 'a foreground spawn already returned before this loop started; it is not in-flight work');
});

test('evaluate: a single 1200s+ idle-hold ScheduleWakeup never hints, even with in-flight background work (long fallback, not a poll)', () => {
  const records = [
    backgroundAgentLaunch('t0'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 1200, noop: true }, 't1'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 1200, noop: true }, records });
  assert.equal(result, null, 'a 1200s+ fallback delay is the tool\'s own long-wait guidance, not a poll cadence');
});

test('evaluate: a single long fallback wake (below the streak threshold) with in-flight work still does not hint', () => {
  const records = [backgroundAgentLaunch('t0'), assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1')];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.equal(result, null, 'in-flight work alone is not sufficient without the streak too');
});

// FIX (main's follow-up on finding 1): "in flight" means launched AND NOT
// YET COMPLETED. A launch whose own completion notification already
// appears later in the tail is resolved -- it must not keep the hint alive
// just because it happened at some point in the history.
test('evaluate: a launch that already COMPLETED (its task-notification is in the tail) is not in-flight evidence -- no hint', () => {
  const records = [
    backgroundAgentLaunch('t0', 'worker-1'),
    taskNotification('worker-1', 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't3'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.equal(result, null, 'launched then completed: nothing is actually in flight any more, so this reads as external-state polling');
});

test('evaluate: a launch that is STILL in flight (no matching completion) does hint, even with an unrelated completion present', () => {
  const records = [
    backgroundAgentLaunch('t0', 'worker-1'),
    backgroundAgentLaunch('t1', 'worker-2'),
    taskNotification('worker-1', 't2'), // resolves worker-1 only
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't3'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't4'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.ok(result, 'worker-2 is still outstanding: this is still harness-tracked work in flight');
});

test('hasInFlightLaunch: a named launch paired with its own completion resolves; an unrelated completion does not resolve a different name', () => {
  assert.equal(hasInFlightLaunch([backgroundAgentLaunch('t0', 'worker-1'), taskNotification('worker-1', 't1')]), false);
  assert.equal(hasInFlightLaunch([backgroundAgentLaunch('t0', 'worker-1'), taskNotification('worker-2', 't1')]), true);
  assert.equal(hasInFlightLaunch([backgroundAgentLaunch('t0', 'worker-1')]), true, 'no completion at all: still outstanding');
});

test('evaluate: ScheduleWakeup with the same noop streak but a long delay does not hint (it reads as a deliberate fallback)', () => {
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 1800, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 1800, noop: true }, 't2'),
  ];
  const result = evaluate({
    toolName: 'ScheduleWakeup',
    input: { delaySeconds: DEFAULT_SHORT_DELAY_S + 1, noop: true },
    records,
  });
  assert.equal(result, null);
});

test('evaluate: a real streak-breaking noop:false in the middle resets the count', () => {
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: false }, 't2'), // did real work
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't3'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true }, records });
  assert.equal(result, null, 'a noop:false in the middle must break the trailing streak');
});

test('evaluate: caller-supplied thresholds are honoured (opts override defaults)', () => {
  const records = [backgroundAgentLaunch('t0'), assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1')];
  const result = evaluate({
    toolName: 'ScheduleWakeup',
    input: { delaySeconds: 60, noop: true },
    records,
    opts: { noopStreak: 1 },
  });
  assert.ok(result, 'a lowered threshold of 1 must fire on a single prior noop, with harness-tracked work in flight');
});

test('evaluate: Monitor re-arming the identical description hits the default streak and hints', () => {
  const records = [
    assistantToolUse('Monitor', { description: 'watch cleanup worker', timeout_ms: 60000 }, 't1'),
    assistantToolUse('Monitor', { description: 'watch cleanup worker', timeout_ms: 60000 }, 't2'),
  ];
  const result = evaluate({
    toolName: 'Monitor',
    input: { description: 'watch cleanup worker', timeout_ms: 60000 },
    records,
  });
  assert.ok(result, 'expected a hint on the 3rd identical-description arm');
  assert.equal(result.kind, 'monitor-rearm-streak');
  assert.equal(result.streak, DEFAULT_MONITOR_REARM_STREAK);
  assert.match(result.hint, /3rd time in a row/);
});

test('evaluate: Monitor with a genuinely different description each time never hints', () => {
  const records = [
    assistantToolUse('Monitor', { description: 'watch build A' }, 't1'),
    assistantToolUse('Monitor', { description: 'watch build B' }, 't2'),
  ];
  const result = evaluate({ toolName: 'Monitor', input: { description: 'watch build C' }, records });
  assert.equal(result, null);
});

test('evaluate: a LONG-timeout Monitor re-armed genuinely early (elapsed < its own timeout_ms) still hints (FIX finding 2, positive branch)', () => {
  const t0 = Date.parse('2026-08-25T00:00:00.000Z');
  const t1 = t0 + 60000; // re-armed 60s later
  const nowTs = t1 + 60000; // about to re-arm again 60s after that
  const records = [
    assistantToolUse('Monitor', { description: 'watch deploy', timeout_ms: 3600000 }, new Date(t0).toISOString()),
    assistantToolUse('Monitor', { description: 'watch deploy', timeout_ms: 3600000 }, new Date(t1).toISOString()),
  ];
  const result = evaluate({
    toolName: 'Monitor',
    input: { description: 'watch deploy', timeout_ms: 3600000 },
    records,
    opts: { now: nowTs },
  });
  assert.ok(result, 'each rearm landed 60s after the prior one, far inside its 1h timeout: a real short-interval poll even though timeout_ms is long');
  assert.equal(result.kind, 'monitor-rearm-streak');
});

test('evaluate: a LONG-timeout Monitor re-armed only after its own timeout naturally expired never hints (FIX finding 2, negative branch)', () => {
  const HOUR_MS = 3600000;
  const t0 = Date.parse('2026-08-25T00:00:00.000Z');
  const t1 = t0 + HOUR_MS; // re-armed exactly when the prior watch's own timeout expired
  const nowTs = t1 + HOUR_MS;
  const records = [
    assistantToolUse('Monitor', { description: 'watch deploy', persistent: true, timeout_ms: HOUR_MS }, new Date(t0).toISOString()),
    assistantToolUse('Monitor', { description: 'watch deploy', persistent: true, timeout_ms: HOUR_MS }, new Date(t1).toISOString()),
  ];
  const result = evaluate({
    toolName: 'Monitor',
    input: { description: 'watch deploy', persistent: true, timeout_ms: HOUR_MS },
    records,
    opts: { now: nowTs },
  });
  assert.equal(result, null, 'each rearm only followed the prior watch\'s own long timeout naturally expiring: not a poll');
});

test('gatedMonitorStreak: a short timeout_ms counts as a short watch regardless of the measured gap', () => {
  const calls = [{ input: { timeout_ms: 60000 }, ts: '2026-01-01T00:00:00.000Z' }];
  const streak = gatedMonitorStreak(calls, Date.parse('2026-06-01T00:00:00.000Z'), { shortTimeoutMs: DEFAULT_MONITOR_SHORT_TIMEOUT_MS });
  assert.equal(streak, 1);
});

test('gatedMonitorStreak: an unparseable timestamp with a long timeout fails open (does not count)', () => {
  const calls = [{ input: { timeout_ms: 3600000 }, ts: 'not-a-date' }];
  const streak = gatedMonitorStreak(calls, Date.now(), { shortTimeoutMs: DEFAULT_MONITOR_SHORT_TIMEOUT_MS });
  assert.equal(streak, 0, 'no timestamp evidence and a non-short timeout: cannot show it was early, so it must not count');
});

test('hasInFlightLaunch: true for a backgrounded Agent, Bash, or Monitor call; false for none of those', () => {
  assert.equal(hasInFlightLaunch([]), false);
  assert.equal(hasInFlightLaunch([assistantToolUse('Agent', { run_in_background: true }, 't1')]), true);
  assert.equal(hasInFlightLaunch([assistantToolUse('Agent', {}, 't1')]), false, 'no run_in_background: true is a foreground (already-returned) call');
  assert.equal(hasInFlightLaunch([assistantToolUse('Bash', { run_in_background: true }, 't1')]), true);
  assert.equal(hasInFlightLaunch([assistantToolUse('Bash', {}, 't1')]), false);
  assert.equal(hasInFlightLaunch([assistantToolUse('Monitor', { description: 'x' }, 't1')]), true);
  assert.equal(hasInFlightLaunch([assistantToolUse('ScheduleWakeup', { delaySeconds: 60 }, 't1')]), false);
});

test('evaluate: an unrecognised tool name is never evaluated', () => {
  assert.equal(evaluate({ toolName: 'Bash', input: {}, records: [] }), null);
});

// --- the hook, as a child process, against a synthetic fixture ---------------

function writeTranscript(dir, lines) {
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

test('hook: fires a systemMessage hint and still allows, on a noop-streak ScheduleWakeup poll', () => {
  const { dir, cleanup } = makeFixture();
  try {
    mkdirSync(dir, { recursive: true });
    const transcriptPath = writeTranscript(dir, [
      backgroundAgentLaunch('2026-01-01T00:00:00Z'),
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, '2026-01-01T00:00:05Z'),
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, '2026-01-01T00:01:05Z'),
    ]);
    const payload = {
      session_id: 'poll-guard-hook-1',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' },
      transcript_path: transcriptPath,
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, `hook must exit 0: stderr=${res.stderr}`);
    assert.ok(res.json, `expected a JSON decision: stdout=${res.stdout}`);
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'allow', 'this guard is advisory: it must never deny');
    assert.match(res.json.systemMessage || '', /one completion/i);
  } finally {
    cleanup();
  }
});

test('hook: no hint (silent allow, empty stdout) on the very first ScheduleWakeup call — no history yet', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = writeTranscript(dir, []);
    const payload = {
      session_id: 'poll-guard-hook-2',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 60, noop: true, reason: 'first check', prompt: 'x' },
      transcript_path: transcriptPath,
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0);
    assert.equal((res.stdout || '').trim(), '', 'no hint yet: the hook should exit silently (passthrough)');
  } finally {
    cleanup();
  }
});

test('hook: the kill switch (poll_guard=false) suppresses the hint even on a real streak', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = writeTranscript(dir, [
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
    ]);
    const payload = {
      session_id: 'poll-guard-hook-3',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' },
      transcript_path: transcriptPath,
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: {
        CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
        CLAUDE_PLUGIN_OPTION_POLL_GUARD: 'false',
      },
    });
    assert.equal(res.status, 0);
    assert.equal((res.stdout || '').trim(), '', 'the kill switch must fully suppress the hint');
  } finally {
    cleanup();
  }
});

test('hook: a missing transcript file fails open (no hint, exit 0) rather than erroring', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'poll-guard-hook-4',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' },
      transcript_path: join(dir, 'does-not-exist.jsonl'),
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0, `must fail open: stderr=${res.stderr}`);
    assert.equal((res.stdout || '').trim(), '');
  } finally {
    cleanup();
  }
});

test('hook: an unrelated tool_name is passed straight through', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const payload = { session_id: 'poll-guard-hook-5', tool_name: 'Bash', tool_input: { command: 'ls' } };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0);
    assert.equal((res.stdout || '').trim(), '');
  } finally {
    cleanup();
  }
});

test('hook: Monitor re-arm streak on the same description also hints and still allows', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = writeTranscript(dir, [
      assistantToolUse('Monitor', { description: 'watch cleanup worker', timeout_ms: 60000 }, 't1'),
      assistantToolUse('Monitor', { description: 'watch cleanup worker', timeout_ms: 60000 }, 't2'),
    ]);
    const payload = {
      session_id: 'poll-guard-hook-6',
      tool_name: 'Monitor',
      tool_input: { description: 'watch cleanup worker', timeout_ms: 60000 },
      transcript_path: transcriptPath,
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow');
    assert.match(res.json?.systemMessage || '', /one completion/i);
  } finally {
    cleanup();
  }
});

test('hook: thresholds are configurable via plugin options', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const transcriptPath = writeTranscript(dir, [
      backgroundAgentLaunch('2026-01-01T00:00:00Z'),
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, '2026-01-01T00:00:05Z'),
    ]);
    const payload = {
      session_id: 'poll-guard-hook-7',
      tool_name: 'ScheduleWakeup',
      tool_input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' },
      transcript_path: transcriptPath,
    };
    const res = runHook('hooks/poll-guard.mjs', payload, {
      env: {
        CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
        CLAUDE_PLUGIN_OPTION_POLL_GUARD_NOOP_STREAK: '1',
      },
    });
    assert.equal(res.status, 0);
    assert.match(res.json?.systemMessage || '', /one completion/i, 'a lowered streak threshold must fire on 1 prior noop');
  } finally {
    cleanup();
  }
});
