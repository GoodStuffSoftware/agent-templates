// Subagent context ceiling: hooks/subagent-context.mjs also nudges a sonnet/high-or-above
// or opus subagent to write a HANDOFF file and return when its context reaches
// subagent_ceiling_tokens (150K), once per worker (a second notice only if
// subagent_ceiling_repeat_tokens is set; default 0). Never haiku, sonnet/low or
// sonnet/medium. Gated by the rollout schedule
// <state root>/rollout.json ("context-ceiling": activeFrom). Advice only: never a
// deny. Library: hooks/lib/context-ceiling.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';
import { rolloutActive, ceilingNoticeText, ceilingRung } from '../hooks/lib/context-ceiling.mjs';

const SID = 'sess-ceil';
const AGENT = 'worker-ceil-test-1';
const ON = { AGENT_COMPANION_FAKE_NOW: '2026-10-15T00:00:00Z' };

const turn = (id, ctx, model = 'claude-sonnet-5-5') => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model, usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
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
const logged0 = () => rows()[0];
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
    assert.match(t, /Handoff checkpoint: your context is about 155,000 tokens/);
    assert.match(t, /handoff file/);
    assert.match(t, /state \(what is done and what is verified\), files touched, next step, open questions/);
    assert.match(t, /fresh worker on the same rung/);
    assert.equal(logged0().rung_class, 'sonnet-high+');
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
    assert.match(ctxText(run(lead)), /Handoff checkpoint/);
    appendFileSync(agentFile, turn('r2', 160000));
    assert.equal(run(lead).stdout.trim(), '');
    appendFileSync(agentFile, turn('r3', 174999));
    assert.equal(run(lead).stdout.trim(), '');
    assert.equal(rows().length, 1);
  } finally { fx.cleanup(); }
});

test('past 175K: still only one nudge (the repeat line defaults to off)', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 152000));
    assert.match(ctxText(run(lead)), /^\[agent-companion\] Handoff checkpoint: /);
    appendFileSync(agentFile, turn('r2', 176000));
    assert.equal(run(lead).stdout.trim(), '');
    appendFileSync(agentFile, turn('r3', 180000));
    assert.equal(run(lead).stdout.trim(), '', 'exactly one nudge at 180K');
    assert.deepEqual(rows().map((x) => [x.tier, x.tokens]), [[1, 152000]]);
  } finally { fx.cleanup(); }
});

test('repeat option set to 175000: a second and last nudge', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const env = { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_REPEAT_TOKENS: '175000' };
    writeFileSync(agentFile, user('go') + turn('r1', 152000));
    assert.match(ctxText(run(lead, env)), /^\[agent-companion\] Handoff checkpoint: /);
    appendFileSync(agentFile, turn('r2', 176000));
    const second = ctxText(run(lead, env));
    assert.match(second, /second and last notice/);
    appendFileSync(agentFile, turn('r3', 200000));
    assert.equal(run(lead, env).stdout.trim(), '', 'never a third');
    assert.deepEqual(rows().map((x) => [x.tier, x.tokens]), [[1, 152000], [2, 176000]]);
  } finally { fx.cleanup(); }
});

test('first seen already past 175K: one nudge, not two', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 180000));
    assert.match(ctxText(run(lead)), /Handoff checkpoint: your context is about 180,000/);
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
    assert.match(ctxText(run(lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-14T08:00:00Z' })), /Handoff checkpoint/);
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
    assert.match(ctxText(run(lead, { AGENT_COMPANION_FAKE_NOW: '2026-10-14T08:00:00Z' })), /Handoff checkpoint/);
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
    assert.doesNotMatch(text, /Handoff checkpoint/);
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
    assert.match(ctxText(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '155000' })), /past the 155,000-token line for this rung/);
  } finally { fx.cleanup(); }
});

test('the existing compaction/size notice is unchanged and combines with the ceiling', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 320000));
    const both = ctxText(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' }));
    assert.match(both, /Your context is past 300,000 tokens/);
    assert.match(both, /Handoff checkpoint/);
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
  assert.match(ceilingNoticeText(1, 152345, 150000, 0), /about 152,345 tokens, past the 150,000-token line for this rung/);
  assert.match(ceilingNoticeText(2, 180000, 150000, 175000), /still growing past 175,000/);
  const t = ceilingNoticeText(1, 152345, 150000, 0);
  for (const w of ['handoff', 'state', 'files touched', 'next step', 'open questions', 'same rung']) assert.match(t, new RegExp(w));
  assert.doesNotMatch(t, /permissionDecision|deny/);
});

const nudged = (agentType, { ctx = 150000, model, env = ON, id = AGENT } = {}) => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile.replace(AGENT, id), user('go') + turn('r1', ctx, model));
    const r = run(lead, env, { agent_type: agentType, agent_id: id });
    assert.equal(r.status, 0);
    const out = ctxText(r);
    const n = existsSync(join(telemetryDir(), 'context-ceiling.jsonl')) ? rows().length : 0;
    if (out) assert.ok(!('permissionDecision' in r.json.hookSpecificOutput));
    return { out, rows: n };
  } finally { fx.cleanup(); }
};

test('low rungs are silent at 160K: haiku, sonnet/low, sonnet/medium, bare and prefixed; no log row', () => {
  for (const base of ['ac-haiku', 'ac-sonnet-low', 'ac-sonnet-medium']) {
    for (const t of [base, `agent-companion:${base}`]) {
      const r = nudged(t, { ctx: 160000 });
      assert.equal(r.out, '', t);
      assert.equal(r.rows, 0, t);
    }
  }
});

test('sonnet/high and above and every opus rung fire at 150K, bare and prefixed', () => {
  for (const base of ['ac-sonnet-high', 'ac-sonnet-xhigh', 'ac-opus-low', 'ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh', 'ac-opus-max', 'ac-browser', 'ac-browser-opus']) {
    for (const t of [base, `agent-companion:${base}`]) {
      const r = nudged(t);
      assert.match(r.out, /Handoff checkpoint/, t);
      assert.equal(r.rows, 1, t);
    }
  }
});

test('non-ladder agent types are judged by the transcript model: opus fires, sonnet and haiku stay silent', () => {
  assert.match(nudged('general-purpose', { model: 'claude-opus-5-5' }).out, /Handoff checkpoint/);
  assert.equal(nudged('general-purpose', { model: 'claude-sonnet-5-5' }).out, '');
  assert.equal(nudged('general-purpose', { model: 'claude-haiku-5-5' }).out, '');
  assert.equal(nudged('ac-unknown-rung', { model: 'claude-opus-5-5' }).out, '');
  assert.equal(ceilingRung('ac-sonnet-medium', 'claude-opus-5-5'), null);
  assert.equal(ceilingRung('ac-opus-low', null), 'opus');
  assert.equal(ceilingRung('ac-sonnet-xhigh', null), 'sonnet-high+');
});

test('the rung set is table-driven: sonnet/medium edited to effort high now fires', () => {
  const ladder = JSON.parse(readFileSync(new URL('../config/model-tiers.json', import.meta.url), 'utf8')).ladder
    .map((r) => (r.agent === 'ac-sonnet-medium' ? { ...r, effort: 'high' } : r));
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(join(fx.stateDir, 'model-tiers.json'), JSON.stringify({ ladder }));
    writeFileSync(agentFile, user('go') + turn('r1', 155000));
    assert.match(ctxText(run(lead, ON, { agent_type: 'ac-sonnet-medium' })), /Handoff checkpoint/);
  } finally { fx.cleanup(); }
});

test('the 300K size notice still fires for a low rung, unchanged', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 320000));
    const out = ctxText(run(lead, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '300000' }, { agent_type: 'ac-haiku' }));
    assert.equal(out, '[agent-companion] Your context is past 300,000 tokens. Finish the current step, return your results, and if more work remains, say what is left so the lead can split it.');
    assert.equal(existsSync(join(telemetryDir(), 'context-ceiling.jsonl')), false);
  } finally { fx.cleanup(); }
});
