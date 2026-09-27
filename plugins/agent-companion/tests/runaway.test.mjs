// Runaway-spawn flag: hooks/runaway-check.mjs (SubagentStop) measures the
// finished subagent's transcript, logs runaway.jsonl and queues a notice;
// hooks/runaway-notice.mjs (UserPromptSubmit) and the main-thread delegation
// guard (PreToolUse) drain it into the lead's context exactly once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { measureTranscript } from '../hooks/lib/runaway.mjs';

// n requests, each written as two assistant lines sharing a requestId (the
// streaming shape), output growing on the second line.
function writeTranscript(dir, n, { model = 'claude-opus-5-5', output = 1000 } = {}) {
  const lines = [{ type: 'user', message: { role: 'user', content: 'go' } }];
  for (let i = 0; i < n; i += 1) {
    const base = { type: 'assistant', requestId: `req_${i}`, message: { id: `msg_${i}`, model, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000 } } };
    lines.push(base);
    lines.push({ ...base, message: { ...base.message, usage: { ...base.message.usage, output_tokens: output } } });
  }
  const p = join(dir, `agent-${n}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const stop = (extra, env) => runHook('hooks/runaway-check.mjs', {
  hook_event_name: 'SubagentStop', session_id: 'sess-rw', agent_type: 'ac-opus-medium', ...extra,
}, { env });

test('measureTranscript dedupes a request written over several lines and prices it', () => {
  const fx = makeFixture();
  try {
    const m = measureTranscript(writeTranscript(fx.dir, 4));
    assert.equal(m.turns, 4);
    assert.ok(m.usd > 0, 'priced');
    assert.equal(m.partial, false);
    const tail = measureTranscript(writeTranscript(fx.dir, 50), { maxBytes: 2000 });
    assert.equal(tail.partial, true);
    assert.ok(tail.turns < 50, 'a tail window is a lower bound');
    assert.equal(measureTranscript(join(fx.dir, 'missing.jsonl')), null);
  } finally { fx.cleanup(); }
});

test('over the turn threshold: one runaway.jsonl row, one notice, drained once', () => {
  const fx = makeFixture();
  try {
    const env = { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' };
    const path = writeTranscript(fx.dir, 5);
    const r = stop({ agent_id: 'agent-over', agent_transcript_path: path }, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'SubagentStop output stays empty: the notice is queued, not emitted here');
    const rows = readJsonl(join(telemetryDir(), 'runaway.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].turns, 5);
    assert.equal(rows[0].agent_id, 'agent-over');
    assert.deepEqual(rows[0].thresholds, { turns: 3, usd: 40 });

    // Same agent stopping again (continued with SendMessage): not flagged twice.
    stop({ agent_id: 'agent-over', agent_transcript_path: path }, env);
    assert.equal(readJsonl(join(telemetryDir(), 'runaway.jsonl')).length, 1);

    const first = runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-rw', prompt: 'hi' });
    const ctx = first.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /runaway spawn: ac-opus-medium/);
    assert.match(ctx, /5 turns > 3/);
    const second = runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-rw', prompt: 'hi' });
    assert.equal(second.stdout.trim(), '', 'exactly once');
  } finally { fx.cleanup(); }
});

test('under both thresholds: nothing logged, nothing queued', () => {
  const fx = makeFixture();
  try {
    stop({ agent_id: 'agent-under', agent_transcript_path: writeTranscript(fx.dir, 5) });
    assert.equal(existsSync(join(telemetryDir(), 'runaway.jsonl')), false);
    const n = runHook('hooks/runaway-notice.mjs', { session_id: 'sess-rw' });
    assert.equal(n.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('dollar threshold alone flags; transcript path falls back to subagent-starts.jsonl', () => {
  const fx = makeFixture();
  try {
    const path = writeTranscript(fx.dir, 2, { output: 200000 });
    writeFileSync(join(telemetryDir(), 'subagent-starts.jsonl'),
      `${JSON.stringify({ agent_id: 'agent-usd', agent_transcript_path: path })}\n`);
    stop({ agent_id: 'agent-usd' }, { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '0', CLAUDE_PLUGIN_OPTION_RUNAWAY_USD: '1' });
    const rows = readJsonl(join(telemetryDir(), 'runaway.jsonl'));
    assert.equal(rows.length, 1);
    assert.match(rows[0].reasons.join(' '), /> \$1/);
  } finally { fx.cleanup(); }
});

test('the main-thread delegation guard carries a queued notice; a subagent tool call does not drain it', () => {
  const fx = makeFixture();
  try {
    stop({ agent_id: 'agent-dg', agent_transcript_path: writeTranscript(fx.dir, 5) }, { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' });
    const sub = runHook('hooks/delegation-guard.mjs', { session_id: 'sess-rw', agent_type: 'general-purpose', agent_id: 'x', tool_name: 'Read' });
    assert.equal(sub.stdout.trim(), '');
    const lead = runHook('hooks/delegation-guard.mjs', { session_id: 'sess-rw', agent_type: 'main', tool_name: 'Read' });
    const o = lead.json?.hookSpecificOutput || {};
    assert.equal(o.permissionDecision, 'allow');
    assert.match(o.additionalContext || '', /runaway spawn/);
    const again = runHook('hooks/delegation-guard.mjs', { session_id: 'sess-rw', agent_type: 'main', tool_name: 'Read' });
    assert.equal(again.json?.hookSpecificOutput?.additionalContext, undefined);
  } finally { fx.cleanup(); }
});

test('fails open: missing transcript, garbage stdin', () => {
  const fx = makeFixture();
  try {
    const a = stop({ agent_id: 'agent-missing', agent_transcript_path: join(fx.dir, 'nope.jsonl') }, { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '1' });
    assert.equal(a.status, 0);
    assert.equal(a.stdout.trim(), '');
    mkdirSync(join(fx.dir, 'x'), { recursive: true });
    const b = runHook('hooks/runaway-check.mjs', undefined);
    assert.equal(b.status, 0);
  } finally { fx.cleanup(); }
});
