// 0.31.40: Claude Code 2.1.311 fires SubagentStop once per agent. Before it, the event also fired about twice a
// minute while a subagent ran. The four SubagentStop handlers (hooks.json) are idempotent by marker and
// never needed the repeats; this checks each does its whole job on the FIRST and only firing, and that none
// reads a repeat as a signal (a counter, a dedupe window or a timer):
//   subagent-brevity (--event stop)  telemetry row, and the one-shot gate
//   runaway-check                    runaway.jsonl row and the queued notice
//   review-verdict (--event stop)    the verdict row of a background reviewer
//   advisory-b (--event worker-stop) the ledger stop row, which ends the worker's "running"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import { readWorkers } from '../hooks/lib/advisory-b.mjs';

const SID = 'sess-once';
const ID = 'agent-once-1';

function transcript(dir, n) {
  const lines = [{ type: 'user', message: { role: 'user', content: 'go' } }];
  for (let i = 0; i < n; i += 1) {
    lines.push({ type: 'assistant', requestId: `req_${i}`, message: { id: `msg_${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 1000 } } });
  }
  const p = join(dir, `${ID}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('hooks.json wires exactly these four handlers to SubagentStop', () => {
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const cmds = h.hooks.SubagentStop.flatMap((g) => g.hooks.map((x) => (x.args || []).join(' ')));
  for (const want of ['subagent-brevity.mjs --event stop', 'runaway-check.mjs', 'review-verdict.mjs --event stop', 'advisory-b.mjs --event worker-stop']) {
    assert.ok(cmds.some((c) => c.includes(want)), `${want} is wired`);
  }
  assert.equal(cmds.length, 4, 'a new SubagentStop handler needs its single-firing check here');
});

test('one SubagentStop for one agent: every handler does its whole job on that single firing', () => {
  const fx = makeFixture();
  try {
    const msg = `${'x'.repeat(60)}\nSTATUS: done\nVERDICT: PASS`;
    const tp = transcript(fx.dir, 5);
    const env = { CLAUDE_PLUGIN_OPTION_BREVITY_STOP_GATE: 'true', CLAUDE_PLUGIN_OPTION_BREVITY_REPORT_MAX_CHARS: '10', CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' };
    const stopPayload = { hook_event_name: 'SubagentStop', session_id: SID, agent_id: ID, agent_type: 'general-purpose', last_assistant_message: msg, agent_transcript_path: tp };

    // The launch of a background reviewer, so the verdict handler has an agent it remembers.
    const prompt = 'TYPE: code-review\nROLE: reviewer\nReview the diff.';
    runHook('hooks/review-verdict.mjs', {
      session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_once',
      tool_input: { description: 'review', prompt, subagent_type: 'general-purpose', name: 'rev-once', run_in_background: true },
      tool_response: { isAsync: true, status: 'async_launched', agentId: ID, description: 'review', prompt, outputFile: `/tmp/${ID}.output`, canReadOutputFile: true, canContinueAgent: true },
    });
    runHook('hooks/advisory-b.mjs', { hook_event_name: 'SubagentStart', session_id: SID, agent_id: ID, agent_type: 'general-purpose' }, { args: ['--event', 'worker-start'] });
    assert.equal(readWorkers(SID, { now: Date.now() }).get(ID)?.running, true, 'the worker is running before its stop');

    const brev = runHook('hooks/subagent-brevity.mjs', stopPayload, { env, args: ['--event', 'stop'] });
    const runaway = runHook('hooks/runaway-check.mjs', stopPayload, { env });
    const verdict = runHook('hooks/review-verdict.mjs', stopPayload, { env, args: ['--event', 'stop'] });
    const ledger = runHook('hooks/advisory-b.mjs', stopPayload, { env, args: ['--event', 'worker-stop'] });
    for (const r of [brev, runaway, verdict, ledger]) assert.equal(r.status, 0, r.stderr);

    // brevity: one row, and the one-shot gate fired on this first firing.
    const brevRows = readJsonl(join(telemetryDir(), 'brevity.jsonl'));
    assert.equal(brevRows.length, 1);
    assert.equal(brevRows[0].gated, true);
    assert.equal(brev.json?.decision, 'block');
    // runaway: flagged on the first firing, notice queued (output stays empty).
    const rw = readJsonl(join(telemetryDir(), 'runaway.jsonl'));
    assert.equal(rw.length, 1);
    assert.equal(rw[0].agent_id, ID);
    assert.equal(runaway.stdout.trim(), '');
    // verdict: recorded from this event's message.
    const vr = readJsonl(join(telemetryDir(), 'review-verdicts.jsonl'));
    assert.equal(vr.length, 1);
    assert.equal(vr[0].review_verdict, 'PASS');
    assert.equal(vr[0].agent_id, ID);
    // ledger: the stop row ends "running" and carries the final STATUS word.
    assert.equal(readWorkers(SID, { now: Date.now() }).get(ID)?.running, false);
    const rows = readFileSync(join(stateDir(), 'worker-ledger', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const stops = rows.filter((r) => r.ev === 'stop' && r.agent_id === ID);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].status, 'done');
  } finally {
    fx.cleanup();
  }
});

test('a worker that is continued and stops again is not counted or gated a second time', () => {
  // The only way a second SubagentStop reaches these handlers after 2.1.311: SendMessage continues a stopped worker.
  const fx = makeFixture();
  try {
    const tp = transcript(fx.dir, 5);
    const env = { CLAUDE_PLUGIN_OPTION_BREVITY_STOP_GATE: 'true', CLAUDE_PLUGIN_OPTION_BREVITY_REPORT_MAX_CHARS: '10', CLAUDE_PLUGIN_OPTION_RUNAWAY_TURNS: '3' };
    const payload = { hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'agent-twice', agent_type: 'general-purpose', last_assistant_message: 'y'.repeat(50), agent_transcript_path: tp };
    const first = runHook('hooks/subagent-brevity.mjs', payload, { env, args: ['--event', 'stop'] });
    const second = runHook('hooks/subagent-brevity.mjs', payload, { env, args: ['--event', 'stop'] });
    assert.equal(first.json?.decision, 'block');
    assert.equal(second.stdout.trim(), '');
    runHook('hooks/runaway-check.mjs', payload, { env });
    runHook('hooks/runaway-check.mjs', payload, { env });
    assert.equal(readJsonl(join(telemetryDir(), 'runaway.jsonl')).length, 1);
  } finally {
    fx.cleanup();
  }
});
