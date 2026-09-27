// Runaway-spawn flag: hooks/runaway-check.mjs (SubagentStop) measures the
// finished subagent's transcript, logs runaway.jsonl and queues a notice;
// hooks/runaway-notice.mjs (UserPromptSubmit, PostToolUse ^Agent$, lead
// payloads only) drains it into the lead's context exactly once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import {
  measureTranscript, derivedAgentTranscript, resolveAgentTranscript, pruneRunawayState,
} from '../hooks/lib/runaway.mjs';

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
    assert.equal(first.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
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

// Payload shapes as the harness sends them (field sets checked against real
// hook input: the main thread carries no agent_id and no agent_type; a hook
// firing inside a subagent carries both).
const leadPost = (sid) => ({
  session_id: sid, transcript_path: 'x/lead.jsonl', cwd: 'x', permission_mode: 'default',
  hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
  tool_input: { description: 'd', prompt: 'p', subagent_type: 'general-purpose' }, tool_response: { status: 'completed' },
});

test('PostToolUse on Agent drains for the lead only, once; a subagent-side payload never drains', () => {
  const fx = makeFixture();
  try {
    stop({ agent_id: 'agent-post', agent_transcript_path: writeTranscript(fx.dir, 5) }, { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' });
    const sub = runHook('hooks/runaway-notice.mjs', { ...leadPost('sess-rw'), agent_id: 'a1b2c3', agent_type: 'general-purpose' });
    assert.equal(sub.stdout.trim(), '', 'inside a subagent: no drain');
    const lead = runHook('hooks/runaway-notice.mjs', leadPost('sess-rw'));
    const o = lead.json?.hookSpecificOutput || {};
    assert.equal(o.hookEventName, 'PostToolUse');
    assert.match(o.additionalContext || '', /runaway spawn: ac-opus-medium/);
    assert.equal(runHook('hooks/runaway-notice.mjs', leadPost('sess-rw')).stdout.trim(), '', 'exactly once');
    assert.equal(runHook('hooks/runaway-notice.mjs', { ...leadPost('sess-rw'), hook_event_name: 'Stop' }).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('hooks.json registers the drainer on UserPromptSubmit and PostToolUse ^Agent$, and the check on SubagentStop', () => {
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const has = (ev, file, matcher) => (h[ev] || []).some((g) => (matcher === undefined || g.matcher === matcher)
    && g.hooks.some((x) => x.args.some((a) => a.endsWith(file))));
  assert.ok(has('UserPromptSubmit', 'runaway-notice.mjs'));
  assert.ok(has('PostToolUse', 'runaway-notice.mjs', '^Agent$'));
  assert.ok(has('SubagentStop', 'runaway-check.mjs'));
});

test('transcript path derived from the lead transcript_path: <dir>/<session>/subagents/agent-<id>.jsonl', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'projects', 'proj-x');
    const sub = join(proj, 'sess-der', 'subagents');
    mkdirSync(sub, { recursive: true });
    const real = writeTranscript(fx.dir, 5);
    writeFileSync(join(sub, 'agent-agent-first-id.jsonl'), readFileSync(real));
    const lead = join(proj, 'sess-der.jsonl');
    writeFileSync(lead, '');
    assert.equal(derivedAgentTranscript(lead, 'sess-der', 'agent-first-id'), join(sub, 'agent-agent-first-id.jsonl'));
    assert.equal(derivedAgentTranscript(lead, 'sess-der', '../x'), null, 'ids are never path fragments');
    // SubagentStop payload with no agent_transcript_path: derived from transcript_path.
    runHook('hooks/runaway-check.mjs', { hook_event_name: 'SubagentStop', session_id: 'sess-der', transcript_path: lead, agent_id: 'agent-first-id', agent_type: 'Explore' },
      { env: { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' } });
    assert.equal(readJsonl(join(telemetryDir(), 'runaway.jsonl')).length, 1);
    // Starts-log fallback: the row's own transcript_path, agent_transcript_path null (the real shape).
    writeFileSync(join(sub, 'agent-agent-second-id.jsonl'), readFileSync(real));
    writeFileSync(join(telemetryDir(), 'subagent-starts.jsonl'), JSON.stringify({ session_id: 'sess-der', agent_id: 'agent-second-id', transcript_path: lead, agent_transcript_path: null }) + '\n');
    assert.equal(resolveAgentTranscript({ agent_id: 'agent-second-id' }), join(sub, 'agent-agent-second-id.jsonl'));
  } finally { fx.cleanup(); }
});

test('no session_id: logged, never queued under a shared name; old queue/marker state is pruned', () => {
  const fx = makeFixture();
  try {
    runHook('hooks/runaway-check.mjs', { hook_event_name: 'SubagentStop', agent_id: 'agent-nosid', agent_transcript_path: writeTranscript(fx.dir, 5) },
      { env: { CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' } });
    assert.equal(readJsonl(join(telemetryDir(), 'runaway.jsonl')).length, 1);
    assert.equal(existsSync(join(stateDir(), 'runaway-queue', 'unknown.jsonl')), false);
    const q = join(stateDir(), 'runaway-queue');
    mkdirSync(q, { recursive: true });
    const stale = join(q, 'old.jsonl.123.draining');
    writeFileSync(stale, '{}\n');
    const old = new Date(Date.now() - 8 * 86400000);
    utimesSync(stale, old, old);
    pruneRunawayState();
    assert.equal(existsSync(stale), false);
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
