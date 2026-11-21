// Worker handoff limits (0.31.60): hooks/subagent-context.mjs (PreToolUse, inside a subagent) tells a worker at the soft limit
// (110K) and again every +15K, and past the hard limit (150K) denies every call except the handoff itself; hooks/runaway-check.mjs
// (SubagentStop) tells the lead to continue a "DONE: partial, handoff at <path>" worker with a fresh one and asks a worker that
// ends past the soft limit with no handoff to write one, once. Library: hooks/lib/handoff-limit.mjs. Fixture transcripts, invented names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import { gitOnly, isHandoffPath, handoffReturnPath, finalIsComplete } from '../hooks/lib/handoff-limit.mjs';

const SID = 'sess-handoff';
const AGENT = 'worker-handoff-test-1';
const ON = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '150000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_REPEAT_TOKENS: '15000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '110000' };

const turn = (id, ctx) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
})}\n`;
const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;
const writeCall = (file) => `${JSON.stringify({ type: 'assistant', requestId: 'w1', message: { id: 'mw', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: 'x' } }] } })}\n`;

function layout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-h');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  return { lead, agentFile: join(sub, `agent-${AGENT}.jsonl`) };
}

const pre = (lead, tool = 'Bash', input = { command: 'ls' }, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'ac-sonnet-high', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', ...extra,
});
const run = (lead, tool, input, env = ON, extra = {}) => runHook('hooks/subagent-context.mjs', pre(lead, tool, input, extra), { env });
const text = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';
const rows = () => readJsonl(join(telemetryDir(), 'handoff-limit.jsonl'));
const endRun = (lead, msg, extra = {}) => runHook('hooks/runaway-check.mjs', {
  hook_event_name: 'SubagentStop', session_id: SID, transcript_path: lead, agent_id: AGENT, agent_type: 'ac-sonnet-high', last_assistant_message: msg, ...extra,
}, { env: ON });

test('below the soft limit: nothing happens, nothing is logged', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 60000) + turn('r2', 109000));
    const r = run(lead);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'handoff-limit.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('crossing the soft limit: one notice naming both limits, then none until +15K, then one more', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 118000));
    const first = run(lead);
    assert.equal(text(first), '[agent-companion] Context at 118K, limit 150K: finish the current step, commit and push any work in progress to your branch, write a handoff file <task>-handoff.md next to your detail file (done, remaining, files touched, branch and sha, the exact next step), then end with "DONE: partial, handoff at <path>".');
    assert.deepEqual(Object.keys(first.json), ['hookSpecificOutput'], 'advice only below the hard limit');
    writeFileSync(agentFile, user('go') + turn('r1', 118000) + turn('r2', 130000));
    assert.equal(run(lead).stdout.trim(), '', 'under +15K: silent');
    writeFileSync(agentFile, user('go') + turn('r1', 118000) + turn('r2', 134000));
    assert.match(text(run(lead)), /^\[agent-companion\] Context at 134K, limit 150K: finish the current step/);
    assert.equal(run(lead).stdout.trim(), '', 'the same level again: silent');
    const r = rows();
    assert.deepEqual(r.map((x) => [x.limit, x.action, x.tokens]), [['soft', 'notice', 118000], ['soft', 'repeat', 134000]]);
    assert.equal(r[0].agent_id, AGENT);
    assert.equal(r[0].agent_type, 'ac-sonnet-high');
    assert.equal(r[0].session_id, SID);
    assert.ok(Date.parse(r[0].at) > 0);
  } finally { fx.cleanup(); }
});

test('above the hard limit: only the handoff goes through; everything else, an Agent spawn included, is denied with the handoff steps', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 155000));
    const no = [
      ['Bash', { command: 'ls' }], ['Bash', { command: 'npm test' }], ['Write', { file_path: 'C:/work/src/app.js' }], ['Edit', { file_path: '/work/src/app.js' }],
      ['Read', { file_path: '/work/src/app.js' }], ['Agent', { description: 'x', prompt: 'y' }], ['Grep', { pattern: 'x' }], ['SendMessage', { to: 'main', message: 'x' }],
      ['Bash', { command: 'git log | head' }], ['Bash', { command: 'git status && rm -rf build' }], ['Bash', { command: 'git commit -m "$(rm x)"' }],
      ['Bash', { command: 'git status > out.txt' }], ['Bash', { command: 'git checkout main' }], ['Bash', { command: 'git -c core.hooksPath=x commit -m a' }],
    ];
    for (const [tool, input] of no) {
      const r = run(lead, tool, input);
      assert.equal(denied(r), true, `${tool} ${JSON.stringify(input)}`);
    }
    const msg = reason(run(lead, 'Agent', { description: 'x', prompt: 'y' }));
    assert.match(msg, /Context at 155K is past the hard limit of 150K/);
    assert.match(msg, /commit and push any work in progress to your branch/);
    assert.match(msg, /<task>-handoff\.md next to your detail file \(done, remaining, files touched, branch and sha, the exact next step/);
    assert.match(msg, /"DONE: partial, handoff at <path>"/);
    assert.doesNotMatch(msg, /\b(stop|halt)\b/i, 'it asks for a handoff, never a stop');
    const yes = [
      ['Write', { file_path: 'C:/work/docs/task-handoff.md', content: 'x' }], ['Edit', { file_path: '/work/task-handoff.md' }], ['Write', { file_path: 'C:\\work\\HANDOFF-notes.md' }],
      ['Read', { file_path: '/work/task-handoff.md' }],
      ['Bash', { command: 'git add -A' }], ['Bash', { command: 'git commit -m "wip: a; b && c"' }], ['Bash', { command: 'git push origin feat/x' }],
      ['Bash', { command: 'git status' }], ['Bash', { command: 'git diff --stat' }], ['Bash', { command: 'git log --oneline -3' }],
      ['Bash', { command: 'git add -A && git commit -m "wip" && git push' }], ['Bash', { command: 'cd /work && git status' }], ['PowerShell', { command: 'git push' }],
      ['Bash', { command: 'git commit -m "$(cat <<\'EOF\'\nwip: a message\n\nsecond paragraph\nEOF\n)"' }],
    ];
    for (const [tool, input] of yes) {
      const r = run(lead, tool, input);
      assert.equal(denied(r), false, `${tool} ${JSON.stringify(input)}`);
    }
    const d = rows().filter((x) => x.action === 'deny');
    assert.equal(d.length, no.length + 1, 'every deny is one row');
    assert.deepEqual([d[0].limit, d[0].tokens, d[0].tool, d[0].agent_id], ['hard', 155000, 'Bash', AGENT]);
  } finally { fx.cleanup(); }
});

test('a read-only worker past the hard limit is denied the same way, with the findings wording', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('TYPE: code-review\nROLE: reviewer\nreview it') + turn('r1', 155000));
    const m = reason(run(lead, 'Bash', { command: 'ls' }));
    assert.match(m, /handoff/);
    assert.doesNotMatch(m, /commit and push/);
    assert.match(m, /"DONE: partial, handoff at <path>"/);
  } finally { fx.cleanup(); }
});

test('a main-session tool call is never affected, whatever the context', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 200000));
    writeFileSync(lead, user('go') + turn('m1', 200000));
    const p = pre(lead);
    delete p.agent_id; delete p.agent_type;
    const r = runHook('hooks/subagent-context.mjs', p, { env: ON });
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'handoff-limit.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('a missing, empty or garbled transcript is a no-op', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    assert.equal(run(lead).stdout.trim(), '', 'no transcript file');
    writeFileSync(agentFile, '');
    assert.equal(run(lead).stdout.trim(), '', 'empty');
    writeFileSync(agentFile, '{"type":"assistant","message":{"usage":{"input_tokens":"x"\n\u0000\u0000not json at all\n{"type":"assistant"}\n');
    assert.equal(run(lead, 'Write', { file_path: 'a.js' }).stdout.trim(), '', 'garbled');
    assert.equal(run(lead, 'Bash', { command: 'ls' }, ON, { transcript_path: join(fx.dir, 'nope.jsonl') }).stdout.trim(), '', 'a transcript path that does not exist');
    assert.equal(existsSync(join(telemetryDir(), 'handoff-limit.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('the switch off: no notice, no repeat, no deny, no log', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const off = { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_HANDOFF_LIMITS: 'false' };
    writeFileSync(agentFile, user('go') + turn('r1', 118000));
    assert.equal(run(lead, 'Bash', { command: 'ls' }, off).stdout.trim(), '');
    writeFileSync(agentFile, user('go') + turn('r1', 118000) + turn('r2', 170000));
    assert.equal(run(lead, 'Bash', { command: 'ls' }, off).stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'handoff-limit.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('an exempt agent type (bare or prefixed) is a no-op; another type is not', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 170000));
    for (const [list, type] of [['ac-sonnet-high', 'ac-sonnet-high'], ['ac-sonnet-high', 'agent-companion:ac-sonnet-high'], ['Other-Type, AC-Sonnet-High', 'ac-sonnet-high'], ['agent-companion:ac-sonnet-high', 'agent-companion:ac-sonnet-high']]) {
      const r = run(lead, 'Bash', { command: 'ls' }, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_HANDOFF_EXEMPT_TYPES: list }, { agent_type: type });
      assert.equal(r.stdout.trim(), '', `${list} / ${type}`);
    }
    assert.equal(existsSync(join(telemetryDir(), 'handoff-limit.jsonl')), false);
    const r = run(lead, 'Bash', { command: 'ls' }, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_HANDOFF_EXEMPT_TYPES: 'ac-haiku' });
    assert.equal(denied(r), true, 'a type not on the list is still held to the limit');
  } finally { fx.cleanup(); }
});

test('explicit values are honoured: soft 0 gives no notice, hard 0 gives no deny, a custom hard line moves the deny', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 130000));
    assert.equal(run(lead, 'Bash', { command: 'ls' }, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0' }).stdout.trim(), '', 'soft 0: no notice');
    assert.equal(denied(run(lead, 'Bash', { command: 'ls' }, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '120000' })), true, 'a custom hard line');
    writeFileSync(agentFile, user('go') + turn('r1', 130000) + turn('r2', 190000));
    assert.equal(run(lead, 'Bash', { command: 'ls' }, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '0' }).json.hookSpecificOutput.permissionDecision, undefined, 'hard 0: no deny');
  } finally { fx.cleanup(); }
});

test('the step-150 marker no longer says nothing will interrupt the run while the hard limit governs the worker', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('TYPE: bounded-feature\nbuild it'));
    const seed = () => { mkdirSync(join(stateDir(), 'long-runs'), { recursive: true }); writeFileSync(join(stateDir(), 'long-runs', `${AGENT}.cnt`), '.'.repeat(149)); };
    const base = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0', CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0', CLAUDE_PLUGIN_OPTION_STEP_BUDGET: 'false' };
    seed();
    assert.equal(text(run(lead, 'Bash', { command: 'ls' }, { ...base, CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '150000' })), '', 'handoff governs: no marker');
    // the crossing is still logged for the lead
    assert.equal(readJsonl(join(stateDir(), 'long-runs.jsonl')).length, 1);
    // hard limit off: the marker is the 0.31.58 text
    const fx2 = makeFixture();
    try {
      const l2 = layout(fx2);
      writeFileSync(l2.agentFile, user('TYPE: bounded-feature\nbuild it'));
      mkdirSync(join(stateDir(), 'long-runs'), { recursive: true }); writeFileSync(join(stateDir(), 'long-runs', `${AGENT}.cnt`), '.'.repeat(149));
      assert.match(text(run(l2.lead, 'Bash', { command: 'ls' }, base)), /nothing will interrupt your run/);
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

// --- the lead side -------------------------------------------------------------------------------------
test('a worker that ends "DONE: partial, handoff at <path>": the lead is told once to spawn a fresh worker of the same type and model with that file', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 100000));
    const msg = 'STATUS: partial\nDONE: partial, handoff at C:/work/docs/task-handoff.md';
    assert.equal(endRun(lead, msg).stdout.trim(), '', 'the worker is not blocked');
    const drain = (e = {}) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: lead, prompt: 'go', ...e }, { env: ON });
    const t = text(drain());
    assert.match(t, /handed off: "DONE: partial, handoff at C:\/work\/docs\/task-handoff\.md"/);
    assert.match(t, /Spawn a fresh worker of the same agent type \(ac-sonnet-high\) and model \(claude-sonnet-5-5\) right away, with that file as its brief/);
    assert.match(t, /A new spawn, not a resume/);
    endRun(lead, msg);
    assert.equal(drain().stdout.trim(), '', 'once per worker');
    // the same text reaches the lead right after a foreground Agent call
    const fx2 = makeFixture();
    try {
      const l2 = layout(fx2);
      writeFileSync(l2.agentFile, user('go') + turn('r1', 100000));
      endRun(l2.lead, msg);
      const post = runHook('hooks/runaway-notice.mjs', { hook_event_name: 'PostToolUse', session_id: SID, transcript_path: l2.lead, tool_name: 'Agent', tool_input: {}, tool_response: {} }, { env: ON });
      assert.match(text(post), /Spawn a fresh worker of the same agent type/);
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('SubagentStop: past the soft limit with no completed STATUS and no handoff, the worker is asked ONCE to write the handoff', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 120000));
    const b = endRun(lead, 'STATUS: partial\nI got most of it done.');
    assert.equal(b.json.decision, 'block');
    assert.match(b.json.reason, /write a handoff file <task>-handoff\.md next to your detail file/);
    assert.match(b.json.reason, /"DONE: partial, handoff at <path>"/);
    assert.doesNotMatch(b.json.reason, /\b(stop|halt)\b/i);
    assert.deepEqual(rows().map((x) => x.action), ['end-block']);
    const again = endRun(lead, 'STATUS: partial\nStill no file.');
    assert.equal(again.stdout.trim(), '', 'never a second block: it cannot loop');
  } finally { fx.cleanup(); }
});

test('SubagentStop: no block for a finished run, a handoff return, a handoff file already written, a worker under the soft limit, or the switch off', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    const big = user('go') + turn('r1', 120000);
    const cases = [
      ['STATUS: done', big, ON],
      ['Finished.\nDONE: all green', big, ON],
      ['STATUS: partial\nDONE: partial, handoff at /w/t-handoff.md', big, ON],
      ['STATUS: partial', big + writeCall('/w/task-handoff.md'), ON],
      ['STATUS: partial', user('go') + turn('r1', 90000), ON],
      ['STATUS: partial', big, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_HANDOFF_LIMITS: 'false' }],
      ['STATUS: partial', big, { ...ON, CLAUDE_PLUGIN_OPTION_SUBAGENT_HANDOFF_EXEMPT_TYPES: 'ac-sonnet-high' }],
    ];
    for (const [msg, body, env] of cases) {
      writeFileSync(agentFile, body);
      const r = runHook('hooks/runaway-check.mjs', { hook_event_name: 'SubagentStop', session_id: SID, transcript_path: lead, agent_id: AGENT, agent_type: 'ac-sonnet-high', last_assistant_message: msg }, { env });
      assert.equal(r.stdout.trim(), '', msg);
    }
  } finally { fx.cleanup(); }
});

// --- the helpers -----------------------------------------------------------------------------------------
test('unit: gitOnly, isHandoffPath, handoffReturnPath, finalIsComplete', () => {
  for (const c of ['git add .', 'git commit -m "x"', 'git push -u origin b', 'git status', 'git diff HEAD~1', 'git log -5', 'git -C /w status', 'git --no-pager log', 'cd /w; git add -A; git commit -m x']) assert.equal(gitOnly(c), true, c);
  for (const c of ['', 'git', 'git reset --hard', 'git stash', 'git fetch', 'git rebase main', 'git status | cat', 'git status &', 'git status 2>&1', 'echo $(git status)', 'git commit -m `x`', 'FOO=1 git status', 'git commit -m "unterminated', 'rm -rf x', 'git status; curl x']) assert.equal(gitOnly(c), false, c);
  assert.equal(isHandoffPath('/a/b/task-handoff.md'), true);
  assert.equal(isHandoffPath('C:\\a\\HANDOFF.md'), true);
  assert.equal(isHandoffPath('/a/handoff/app.js'), false, 'the file name counts, not the folder');
  assert.equal(isHandoffPath(undefined), false);
  assert.equal(handoffReturnPath('x\nDONE: partial, handoff at /w/a-handoff.md\n'), '/w/a-handoff.md');
  assert.equal(handoffReturnPath('DONE: partial, handoff at <path>'), null);
  assert.equal(handoffReturnPath('DONE: all good'), null);
  assert.equal(finalIsComplete('STATUS: done'), true);
  assert.equal(finalIsComplete('DONE: shipped'), true);
  assert.equal(finalIsComplete('DONE: partial, handoff at x'), false);
  assert.equal(finalIsComplete('STATUS: partial'), false);
  assert.equal(finalIsComplete('STATUS: blocked'), false);
});
