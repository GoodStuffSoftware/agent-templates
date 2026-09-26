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
  POLL_TOOLS, DEFAULT_NOOP_STREAK, DEFAULT_SHORT_DELAY_S, DEFAULT_MONITOR_REARM_STREAK,
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

test('evaluate: ScheduleWakeup at the noop-streak threshold AND a short delay hints, with a concrete streak count', () => {
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't2'),
  ];
  const result = evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, records });
  assert.ok(result, 'expected a hint at the threshold');
  assert.equal(result.kind, 'schedule-wakeup-noop-streak');
  assert.equal(result.streak, DEFAULT_NOOP_STREAK);
  assert.match(result.hint, /one completion/i);
  assert.match(result.hint, /2 consecutive no-op wakes/);
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
  const records = [assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1')];
  const result = evaluate({
    toolName: 'ScheduleWakeup',
    input: { delaySeconds: 60, noop: true },
    records,
    opts: { noopStreak: 1 },
  });
  assert.ok(result, 'a lowered threshold of 1 must fire on a single prior noop');
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
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, '2026-01-01T00:00:00Z'),
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true, reason: 'poll', prompt: 'x' }, '2026-01-01T00:01:00Z'),
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
      assistantToolUse('ScheduleWakeup', { delaySeconds: 60, noop: true }, 't1'),
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
