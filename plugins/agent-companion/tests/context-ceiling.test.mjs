// Subagent context ceiling: hooks/subagent-context.mjs also nudges a subagent to
// write a checkpoint file and return when its context reaches
// subagent_ceiling_tokens (150K), once, and again past
// subagent_ceiling_repeat_tokens (175K). Gated by the rollout schedule
// <state root>/rollout.json ("context-ceiling": activeFrom). Advice only: never a
// deny. Library: hooks/lib/context-ceiling.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { rolloutActive, ceilingNoticeText } from '../hooks/lib/context-ceiling.mjs';

const SID = 'sess-ceil';
const AGENT = 'worker-ceil-test-1';
const ON = { AGENT_COMPANION_FAKE_NOW: '2026-10-15T00:00:00Z' };

const turn = (id, ctx) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
})}\n`;
const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;

function layout(fx, { schedule = { 'context-ceiling': '2026-10-14T08:00:00Z' } } = {}) {
  const proj = join(fx.dir, 'projects', 'proj-ceil');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  if (schedule !== null) {
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'rollout.json'), typeof schedule === 'string' ? schedule : JSON.stringify(schedule));
  }
  return { lead, agentFile: join(sub, `agent-${AGENT}.jsonl`) };
}

const pre = (lead, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'ac-sonnet-high', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', ...extra,
});
const run = (lead, env = ON, extra = {}) => runHook('hooks/subagent-context.mjs', pre(lead, extra), { env });
const ctxText = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const rows = () => readJsonl(join(telemetryDir(), 'context-ceiling.jsonl'));

test('below 150K: silent, nothing logged', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 120000) + turn('r2', 149999));
    const r = run(lead);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('the crossing: exactly one nudge, advice only, one log row', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 120000) + turn('r2', 155000));
    const r = run(lead);
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.deepEqual(Object.keys(r.json.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
    const t = ctxText(r);
    assert.match(t, /Context checkpoint: your context is about 155,000 tokens/);
    assert.match(t, /checkpoint file/);
    assert.match(t, /the goal, what is done, the remaining steps, key paths, and open findings/);
    assert.match(t, /checkpoint file path and a proposed split of the remaining work/);
    const logged = rows();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].agent_id, AGENT);
    assert.equal(logged[0].agent_type, 'ac-sonnet-high');
    assert.equal(logged[0].tokens, 155000);
    assert.equal(logged[0].tier, 1);
    assert.match(logged[0].at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  } finally { fx.cleanup(); }
});

test('between 150K and 175K: no repeat, however many calls', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 151000));
    assert.match(ctxText(run(lead)), /Context checkpoint/);
    appendFileSync(agentFile, turn('r2', 160000));
    assert.equal(run(lead).stdout.trim(), '');
    appendFileSync(agentFile, turn('r3', 174999));
    assert.equal(run(lead).stdout.trim(), '');
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('past 175K: a second and last nudge', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 152000));
    assert.match(ctxText(run(lead)), /^\[agent-companion\] Context checkpoint: /);
    appendFileSync(agentFile, turn('r2', 176000));
    const second = ctxText(run(lead));
    assert.match(second, /second and last notice/);
    assert.match(second, /about 176,000 tokens/);
    appendFileSync(agentFile, turn('r3', 200000));
    assert.equal(run(lead).stdout.trim(), '', 'never a third');
    assert.deepEqual(rows().map((x) => [x.tier, x.tokens]), [[1, 152000], [2, 176000]]);
  } finally { fx.cleanup(); }
});

test('first seen already past 175K: one nudge, not two', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 180000));
    assert.match(ctxText(run(lead)), /Context checkpoint: your context is about 180,000/);
    assert.equal(run(lead).stdout.trim(), '');
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('main session (no agent_id): nothing, even with a huge transcript', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    writeFileSync(lead, user('go') + turn('r1', 400000));
    const payload = pre(lead);
    delete payload.agent_id;
    delete payload.agent_type;
    const r = runHook('hooks/subagent-context.mjs', payload, { env: ON });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('missing or corrupt transcript: silent, exit 0', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    let r = run(lead); // agentFile does not exist
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    writeFileSync(agentFile, '{"type":"assistant","message":{"usage":\n\x00\x01 not json at all\n{"type":"assistant"');
    r = run(lead);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    writeFileSync(agentFile, '');
    r = run(lead);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(run(lead, ON, { transcript_path: 'Z:/nope/missing.jsonl', session_id: 'x' }).stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('never a deny: no decision field on any path, at any size', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    let nudged = 0;
    for (const ctx of [90000, 150000, 160000, 180000, 500000]) {
      writeFileSync(agentFile.replace(AGENT, `${AGENT}-${ctx}`), user('go') + turn(`r${ctx}`, ctx));
      const r = run(lead, ON, { agent_id: `${AGENT}-${ctx}` });
      // each agent id is a fresh agent, so every size >= 150K nudges
      const out = r.stdout.trim();
      if (out) {
        nudged += 1;
        assert.ok(!('permissionDecision' in r.json.hookSpecificOutput), `no permissionDecision at ${ctx}`);
        assert.ok(!('decision' in r.json), `no decision at ${ctx}`);
        assert.ok(!('updatedInput' in r.json.hookSpecificOutput), `no updatedInput at ${ctx}`);
      }
      assert.equal(r.status, 0);
    }
    assert.equal(nudged, 4, 'every size from 150K up nudged, none denied');
  } finally { fx.cleanup(); }
});

test('not yet active: before activeFrom nothing happens, no claim is burned', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 180000));
    const before = { AGENT_COMPANION_FAKE_NOW: '2026-10-14T07:59:59Z' };
    assert.equal(run(lead, before).stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
    // The same agent, once the time has passed, is still nudged (the quiet period used no claim).
    assert.match(ctxText(run(lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-14T08:00:00Z' })), /Context checkpoint/);
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('rollout gate: missing file, missing id, bad timestamp and corrupt file all mean OFF', () => {
  for (const schedule of [null, {}, { 'other-change': '2026-10-01T00:00:00Z' }, { 'context-ceiling': 'tomorrow-ish' }, { 'context-ceiling': 12345 }, '{not json', '[]']) {
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx, { schedule });
      writeFileSync(agentFile, user('go') + turn('r1', 180000));
      assert.equal(run(lead).stdout.trim(), '', `off for ${JSON.stringify(schedule)}`);
      assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
    } finally { fx.cleanup(); }
  }
});

test('rollout gate: a BOM-prefixed file (PowerShell 5.1) still works; a zone-less timestamp is UTC', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx, { schedule: '\uFEFF{"context-ceiling":"2026-10-14T08:00:00"}' });
    writeFileSync(agentFile, user('go') + turn('r1', 180000));
    assert.equal(run(lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-14T07:59:59Z' }).stdout.trim(), '');
    assert.match(ctxText(run(lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-14T08:00:00Z' })), /Context checkpoint/);
  } finally { fx.cleanup(); }
});

test('a compaction with no request after it yet is not read as a big context', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const b = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b-1', compactMetadata: { trigger: 'auto', preTokens: 217000 } })}\n`;
    writeFileSync(agentFile, user('go') + turn('r1', 217000) + b);
    // The existing compaction notice still fires; the ceiling does not read the stale pre-compaction size.
    const text = ctxText(run(lead));
    assert.match(text, /You just compacted/);
    assert.doesNotMatch(text, /Context checkpoint/);
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('rolloutActive: boundary and a sibling entry do not matter', () => {
  const fx = makeFixture();
  try {
    layout(fx, { schedule: { 'other-change': '2030-01-01T00:00:00Z', 'context-ceiling': '2026-10-14T08:00:00Z' } });
    assert.equal(rolloutActive('context-ceiling', Date.parse('2026-10-14T07:59:59.999Z')), false);
    assert.equal(rolloutActive('context-ceiling', Date.parse('2026-10-14T08:00:00Z')), true);
    assert.equal(rolloutActive('other-change', Date.parse('2026-10-14T08:00:00Z')), false);
    assert.equal(rolloutActive('absent', Date.parse('2031-01-01T00:00:00Z')), false);
  } finally { fx.cleanup(); }
});

test('options: subagent_ceiling_tokens 0 is off; a custom ceiling and repeat line are honoured', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 160000));
    assert.equal(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0' }).stdout.trim(), '');
    assert.equal(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '170000' }).stdout.trim(), '');
    assert.match(ctxText(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '155000' })), /past the 155,000-token ceiling/);
  } finally { fx.cleanup(); }
});

test('the existing compaction/size notice is unchanged and combines with the ceiling', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 320000));
    const both = ctxText(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' }));
    assert.match(both, /Your context is past 300,000 tokens/);
    assert.match(both, /Context checkpoint/);
    // Ceiling not yet active: only the original text, byte for byte.
    const fx2 = makeFixture();
    try {
      const l2 = layout(fx2);
      writeFileSync(l2.agentFile, user('go') + turn('r1', 320000));
      const only = ctxText(run(l2.lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-01T00:00:00Z', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' }));
      assert.equal(only, '[agent-companion] Your context is past 300,000 tokens. Finish the current step, return your results, and if more work remains, say what is left so the lead can split it.');
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('notice wording', () => {
  assert.match(ceilingNoticeText(1, 152345, 150000, 175000), /about 152,345 tokens, past the 150,000-token ceiling/);
  assert.match(ceilingNoticeText(2, 180000, 150000, 175000), /still growing past 175,000/);
});
