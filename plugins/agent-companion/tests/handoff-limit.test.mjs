// Worker handoff limits (0.31.60): hooks/subagent-context.mjs (PreToolUse, inside a subagent) tells a worker at the soft limit
// (110K) and again every +15K, and past the hard limit (150K) denies every call except the handoff itself; hooks/runaway-check.mjs
// (SubagentStop) tells the lead to continue a "DONE: partial, handoff at <path>" worker with a fresh one and asks a worker that
// ends past the soft limit with no handoff to write one, once. Library: hooks/lib/handoff-limit.mjs. Fixture transcripts, invented names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import { gitOnly, gitCheck, isHandoffPath, handoffReturnPath, finalIsComplete, handoffFileWritten } from '../hooks/lib/handoff-limit.mjs';

const SID = 'sess-handoff';
const AGENT = 'worker-handoff-test-1';
const ON = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '150000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_REPEAT_TOKENS: '15000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '110000', CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_HIGH_TOKENS: '110000' }; // the high-rung line pinned to 110K: the older tests use ac-sonnet-high with one line
// The shipped 0.31.65 defaults (warn 110K; handoff 110K lower rungs, 130K higher rungs; hard 150K): the options unset.
const DEFAULTS = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS: '150000' };

const turn = (id, ctx) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000 } },
})}\n`;
const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;
const toolCall = (name, file, id = 'toolu_w1') => `${JSON.stringify({ type: 'assistant', requestId: `r_${id}`, message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 119000, cache_creation_input_tokens: 1000 }, content: [{ type: 'tool_use', id, name, input: { file_path: file, content: 'x' } }] } })}\n`;
const toolResult = (id, isError = false) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'File has not been read yet' : 'ok' }] } })}\n`;
const bashCall = (command, id = 'toolu_b1') => `${JSON.stringify({ type: 'assistant', requestId: `r_${id}`, message: { id: `m_${id}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 119000, cache_creation_input_tokens: 1000 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n`;
const writeCall = (file) => toolCall('Write', file) + toolResult('toolu_w1');

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
const text = (r) => String(r.json?.hookSpecificOutput?.additionalContext || '').replace(/ Put the line `transcript: [^`]*` at the top of the handoff file .*$/m, ''); // 0.31.66 sentence, pinned in subagent-context.test.mjs
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
    assert.equal(text(first), '[agent-companion] Context at 118K, limit 150K: finish the current step, commit and push any work in progress to your branch, write a handoff file <task>-handoff.md next to your detail file (done, remaining, files touched, branch and sha, the exact next step; keep the file under about 4,000 chars, name files and line ranges instead of pasting code, and give the exact next step), then end with "DONE: partial, handoff at <path>".');
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
      ['Write', { file_path: '/work/src/handoff.ts' }], ['Edit', { file_path: '/work/hooks/lib/handoff-limit.mjs' }], ['Read', { file_path: '/work/notes-handoff.txt' }],
      ['Bash', { command: 'git push --force origin main' }],
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
    const hf = join(fx.dir, 'task-handoff.md').replace(/\\/g, '/');
    writeFileSync(hf, '# handoff\n');
    const msg = `STATUS: partial\nDONE: partial, handoff at ${hf}`;
    assert.equal(endRun(lead, msg).stdout.trim(), '', 'the worker is not blocked');
    const drain = (e = {}) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: lead, prompt: 'go', ...e }, { env: ON });
    const t = text(drain());
    assert.ok(t.includes(`handed off: "DONE: partial, handoff at ${hf}"`), t);
    assert.match(t, /Spawn a fresh worker of the same agent type \(ac-sonnet-high\) and model \(claude-sonnet-5-5\) right away, with that file as its brief/);
    assert.match(t, /A new spawn, not a resume/);
    endRun(lead, msg);
    assert.equal(drain().stdout.trim(), '', 'once per worker');
    assert.deepEqual(rows().map((x) => x.action), ['return'], 'one return row per continuation told to the lead');
    assert.equal(rows()[0].agent_id, AGENT);
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
    writeFileSync(join(fx.dir, 't-handoff.md'), '# handoff\n');
    const cases = [
      ['STATUS: done', big, ON],
      ['Finished.\nDONE: all green', big, ON],
      [`STATUS: partial\nDONE: partial, handoff at ${join(fx.dir, 't-handoff.md').replace(/\\/g, '/')}`, big, ON],
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
  for (const c of ['git add .', 'git commit -m "x"', 'git push -u origin b', 'git status', 'git diff HEAD~1', 'git log -5', 'git -C /w status', 'git --no-pager log', 'cd /w; git add -A; git commit -m "x"']) assert.equal(gitOnly(c), true, c);
  for (const c of ['', 'git', 'git reset --hard', 'git stash', 'git fetch', 'git rebase main', 'git status | cat', 'git status &', 'git status 2>&1', 'echo $(git status)', 'git commit -m `x`', 'FOO=1 git status', 'git commit -m "unterminated', 'rm -rf x', 'git status; curl x']) assert.equal(gitOnly(c), false, c);
  assert.equal(isHandoffPath('/a/b/task-handoff.md'), true);
  assert.equal(isHandoffPath('C:\\a\\HANDOFF.md'), true);
  assert.equal(isHandoffPath('/a/handoff/app.js'), false, 'the file name counts, not the folder');
  assert.equal(isHandoffPath(undefined), false);
  const d = mkdtempSync(join(tmpdir(), 'hrp-'));
  try {
    const f = join(d, 'a-handoff.md').replace(/\\/g, '/');
    writeFileSync(f, '# handoff\n');
    assert.equal(handoffReturnPath(`x\nDONE: partial, handoff at ${f}\n`), f, 'a real last line with an existing file');
    assert.equal(handoffReturnPath('x\nDONE: partial, handoff at a-handoff.md', d), 'a-handoff.md', 'relative path resolves against cwd');
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${join(d, 'gone-handoff.md').replace(/\\/g, '/')}`), null, 'a file that is not there');
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${f}\nand then some more text`), f, '0.31.66: the line may be anywhere in the final message');
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${f}\nKnowledge check: none needed\n`), f, 'followed by a trailing line');
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${join(d, 'gone-handoff.md').replace(/\\/g, '/')}\nmore`), null, 'anywhere, but the file must exist');
    assert.equal(handoffReturnPath('Rule: "DONE: partial, handoff at <path>" gets a fresh same-rung continuation, not a resume'), null, 'the injected rule text, mid-message');
    assert.equal(handoffReturnPath('x\nRule: "DONE: partial, handoff at <path>" gets a fresh same-rung continuation, not a resume'), null, 'the rule text as the last line');
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.equal(handoffReturnPath('DONE: partial, handoff at <path>'), null);
  assert.equal(handoffReturnPath('DONE: all good'), null);
  assert.equal(finalIsComplete('STATUS: done'), true);
  assert.equal(finalIsComplete('DONE: shipped'), true);
  assert.equal(finalIsComplete('DONE: partial, handoff at x'), false);
  assert.equal(finalIsComplete('STATUS: partial'), false);
  assert.equal(finalIsComplete('STATUS: blocked'), false);
});

// --- review fixes (0.31.60): the allowlist is default-deny ---------------------------------------------------
const heredoc = (pre, delim, body, tail = ')"') => `${pre}"$(cat <<${delim}\n${body}\n${delim.replace(/['"]/g, '')}\n${tail}`;

test('gitCheck: the three commit-message shapes pass, every heredoc escape is refused', () => {
  // (a) quoted literals; (b) quoted-delimiter heredoc anchored at the end; (c) -F with a handoff .md
  for (const c of [
    "git commit -m 'wip: a; b && c'", 'git commit -m "wip: a; b"', "git commit -a -m 'x' -m 'second paragraph'",
    heredoc('git commit -m ', "'EOF'", 'wip\n\nsecond paragraph with `ticks` and $(not run) and a "quote"'),
    heredoc('git add -A && git commit -m ', '"MSG"', 'wip'),
    'git commit -F docs/task-handoff.md', 'git commit -F C:/w/HANDOFF-notes.md',
  ]) assert.equal(gitCheck(c), null, c);
  const bad = [
    // the review's three escapes
    "git commit -m \"$(cat <<'EOF' ; touch /tmp/pwn\nmsg\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\ntouch /tmp/pwn\nEOF\n)\"",
    'git commit -m "$(cat <<EOF\n$(touch /tmp/pwn)\nEOF\n)"',
    'git commit -m "$(cat <<EOF\n`touch /tmp/pwn`\nEOF\n)"',
    // more shapes: text after the closing line, a second command after it, other substitution, heredoc not after -m
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\n)\"\ntouch /tmp/pwn",
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\n)\" && touch /tmp/pwn",
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\n) ; touch x\"",
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\n)",
    "git commit -m \"$(touch x <<'EOF'\nhi\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF'\nhi\nEOF\n touch x\n)\"",
    "git log \"$(cat <<'EOF'\n--output=/tmp/x\nEOF\n)\"",
    "git commit -F \"$(cat <<'EOF'\nx\nEOF\n)\"",
    "git commit -m \"$(cat <<-'EOF'\nhi\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF'\n$(touch x)\nEOF\n)\" -m \"$(id)\"",
    // commit message shapes
    'git commit -m wip', 'git commit -m "a $HOME"', 'git commit -m "a `x`"', 'git commit -m "a \\" b"', 'git commit -m "$(date)"', "git commit -m $'x'",
    'git commit', 'git commit -F notes.txt', 'git commit -F src/handoff.ts', 'git commit -F -', 'git commit -F /dev/stdin -m x', 'git commit --amend -m x', 'git commit -m x --no-verify',
    'git commit -m x path/file.js',
  ];
  for (const c of bad) assert.notEqual(gitCheck(c), null, JSON.stringify(c));
});

test('gitCheck: git options are default-deny per verb', () => {
  const ok = [
    'git add a.js b.js', 'git add -A', 'git add --all', 'git add -u', 'git add .', 'git add -- a.js',
    'git commit -a -m "x"', 'git push', 'git push -u origin feat/x', 'git push --set-upstream origin HEAD', 'git push origin HEAD:feat/x', 'git push origin main', 'git push origin',
    'git status -s', 'git status --short -b', 'git status --branch --porcelain', 'git diff', 'git diff --stat --cached', 'git diff --staged --name-only', 'git diff --name-status HEAD~1 -- src/a.js',
    'git diff main..HEAD', 'git log --oneline -n 5', 'git log -5', 'git log --stat main..HEAD', 'git -C /w log --oneline', 'git --no-pager diff HEAD',
  ];
  for (const c of ok) assert.equal(gitCheck(c), null, c);
  const bad = [
    'git push --force origin main', 'git push -f', 'git push --force-with-lease', 'git push --force-if-includes', 'git push --forc origin main', 'git push origin +main', 'git push origin +HEAD:main',
    'git push origin :feat/x', 'git push --delete origin feat/x', 'git push -d origin feat/x', 'git push origin --delete feat/x', 'git push --mirror', 'git push --receive-pack=cmd /w/other main',
    'git push --exec=cmd origin main', 'git push https://example.com/r.git HEAD', 'git push /w/other main', 'git push origin main extra', 'git push origin a:b', 'git push origin HEAD:+x', 'git push --tags', 'git push --no-verify',
    'git log --output=/tmp/x', 'git diff --output=/tmp/x', 'git diff --output /tmp/x', 'git diff --no-index /dev/null /etc/hosts', 'git diff --ext-diff', 'git diff --textconv', 'git diff /dev/null /etc/hosts', 'git diff ../a ../b', 'git diff -- /etc/hosts', 'git log -- ../x', 'git diff C:/x/a C:/x/b',
    'git log --format=%H', 'git log -p', 'git log -n', 'git log -n x', 'git log -S x', 'git diff --color-moved', 'git diff -U9', 'git status -uall', 'git status --ignored',
    'git -c core.pager=cmd log', 'git log -c', 'git --git-dir=/x status', 'git --git-dir /x status', 'git status --git-dir=/x', 'git --work-tree=/x status', 'git -C', 'git -c a=b status',
    'git add -f x', 'git add --force x', 'git add -N x', 'git add -p', 'git add -i', 'git add -f', 'git add --intent-to-add x', 'git add \\-f',
    'git add a ; git reset --hard', 'git checkout .', 'git reset', 'git stash', 'git', 'git status | cat', 'git status &', 'git status 2>&1', 'git status; rm -rf x', 'git add {-f,x}', 'git status # c', 'ls',
  ];
  for (const c of bad) assert.notEqual(gitCheck(c), null, c);
});

test('past the hard limit a refused Bash command says why; 5 refused calls in a row add the stop line; a call let through resets it', () => {
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    writeFileSync(agentFile, user('go') + turn('r1', 155000));
    const first = reason(run(lead, 'Bash', { command: 'git push --force origin main' }));
    assert.match(first, /only plain git add\/commit\/push\/status\/diff\/log/);
    assert.match(first, /this command was refused: git push option --force is not allowed/);
    assert.doesNotMatch(first, /calls refused/);
    assert.match(reason(run(lead, 'Bash', { command: 'git status | cat' })), /a pipe is not allowed/);
    assert.doesNotMatch(reason(run(lead, 'Agent', { description: 'x', prompt: 'y' })), /command was refused/, 'only Bash and PowerShell carry a command reason');
    const r4 = reason(run(lead, 'Read', { file_path: '/w/a.js' }));
    assert.doesNotMatch(r4, /calls refused/);
    const r5 = reason(run(lead, 'Grep', { pattern: 'x' }));
    assert.match(r5, /^5 calls refused: write the handoff now or give your final reply\. \[agent-companion\]/);
    assert.match(reason(run(lead, 'Grep', { pattern: 'x' })), /^6 calls refused:/);
    assert.equal(denied(run(lead, 'Write', { file_path: '/w/task-handoff.md', content: 'x' })), false);
    assert.doesNotMatch(reason(run(lead, 'Grep', { pattern: 'x' })), /calls refused/, 'a call let through ended the streak');
    assert.equal(rows().filter((x) => x.action === 'deny').length, 7, 'no hard cap: every refused call is still one row');
  } finally { fx.cleanup(); }
});

test('the file allowance needs a .md file whose name contains handoff', () => {
  for (const f of ['/w/task-handoff.md', 'C:\\w\\HANDOFF.MD', '/w/handoff-notes.md']) assert.equal(isHandoffPath(f), true, f);
  for (const f of ['/w/handoff.ts', '/w/src/handoff', '/w/pre-commit-handoff', '/w/a.txt:handoff', '/w/handoff.md/..//b.txt', '/w/handoff/app.js', '/w/notes.md', '', undefined]) assert.equal(isHandoffPath(f), false, String(f));
});

test('handoffFileWritten: only a successful Write or Edit of a handoff .md counts; Read, a failed Write and other files do not', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.dir, 'agent.jsonl');
    const cases = [
      ['a successful Write', toolCall('Write', '/w/task-handoff.md') + toolResult('toolu_w1'), true],
      ['a successful Edit', toolCall('Edit', '/w/task-handoff.md') + toolResult('toolu_w1'), true],
      ['a Read only', toolCall('Read', '/w/task-handoff.md') + toolResult('toolu_w1'), false],
      ['a failed Write', toolCall('Write', '/w/task-handoff.md') + toolResult('toolu_w1', true), false],
      ['a failed Write then a good one', toolCall('Write', '/w/task-handoff.md', 'a1') + toolResult('a1', true) + toolCall('Write', '/w/task-handoff.md', 'a2') + toolResult('a2'), true],
      ['a Write of another file', toolCall('Write', '/w/notes.md') + toolResult('toolu_w1'), false],
      ['a Write of a source file with the word in its name', toolCall('Write', '/w/src/handoff.ts') + toolResult('toolu_w1'), false],
      ['a Write whose result is not in the tail yet', toolCall('Write', '/w/task-handoff.md'), true],
      ['a Bash heredoc to a handoff file', bashCall('cat > /w/task-handoff.md <<EOF\nnotes\nEOF') + toolResult('toolu_b1'), true],
      ['a Bash append', bashCall("echo 'more' >> /w/task-handoff.md") + toolResult('toolu_b1'), true],
      ['a Bash tee -a', bashCall('printf x | tee -a "/w/out/task-handoff.md"') + toolResult('toolu_b1'), true],
      ['a failed Bash write', bashCall('cat > /w/task-handoff.md <<EOF\nx\nEOF') + toolResult('toolu_b1', true), false],
      ['a Bash cat of a handoff file', bashCall('cat /w/task-handoff.md') + toolResult('toolu_b1'), false],
      ['a Bash write of another file', bashCall('echo x > /w/notes.md') + toolResult('toolu_b1'), false],
      ['nothing', user('go') + turn('r1', 1000), false],
      ['a garbled tail', 'not json "tool_use"\n{"type":"assistant","message":{"content":[{"type":"tool_use"', false],
    ];
    for (const [name, body, want] of cases) { writeFileSync(f, body); assert.equal(handoffFileWritten(f), want, name); }
    assert.equal(handoffFileWritten(join(fx.dir, 'missing.jsonl')), false);
  } finally { fx.cleanup(); }
});

test('SubagentStop: a Read of the handoff file does not stand in for writing it; a failed Write does not either', () => {
  for (const [body, blocked] of [
    [toolCall('Read', '/w/task-handoff.md') + toolResult('toolu_w1'), true],
    [toolCall('Write', '/w/task-handoff.md') + toolResult('toolu_w1', true), true],
    [toolCall('Edit', '/w/task-handoff.md') + toolResult('toolu_w1'), false],
  ]) {
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx);
      writeFileSync(agentFile, user('go') + turn('r1', 120000) + body);
      const r = endRun(lead, 'STATUS: partial\nnot finished');
      assert.equal(r.json?.decision === 'block', blocked);
    } finally { fx.cleanup(); }
  }
});

test('finalIsComplete also accepts a reviewer verdict; handoffReturnPath is capped and cleaned', () => {
  for (const m of ['VERDICT: PASS', ['x', 'VERDICT: FIX', '- blocker'].join('\n'), 'verdict: pass', 'STATUS: done']) assert.equal(finalIsComplete(m), true, m);
  for (const m of ['VERDICT:', 'VERDICTS pass', 'STATUS: partial']) assert.equal(finalIsComplete(m), false, m);
  const d = mkdtempSync(join(tmpdir(), 'hrp-'));
  try {
    const long = `${d.replace(/\\/g, '/')}/${'a'.repeat(500)}-handoff.md`;
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${long}`), null, 'an over-long path cannot exist');
    writeFileSync(join(d, 'ab[31m-handoff.md'), '# handoff\n');
    const dirty = `${d.replace(/\\/g, '/')}/a\u0007b\u001b[31m-handoff.md`;
    assert.equal(handoffReturnPath(`DONE: partial, handoff at ${dirty}`), `${d.replace(/\\/g, '/')}/ab[31m-handoff.md`, 'control characters removed');
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.equal(handoffReturnPath('DONE: partial, handoff at \u0007\u001b'), null);
});

// --- 0.31.65 three-level ceiling: warn 110K (once), handoff 110K lower rungs / 130K higher rungs, hard stop 150K ---
const at = (lead, agentFile, ctx, agentType, env = DEFAULTS) => {
  writeFileSync(agentFile, user('go') + turn('r1', ctx));
  return run(lead, 'Bash', { command: 'ls' }, env, { agent_type: agentType });
};

test('0.31.65 lower rungs: no warn, the handoff notice at 110K', () => {
  for (const agentType of ['ac-haiku', 'ac-sonnet-low', 'ac-sonnet-medium']) {
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx);
      assert.equal(at(lead, agentFile, 109000, agentType).stdout.trim(), '', `${agentType} at 109K`);
      assert.match(text(at(lead, agentFile, 111000, agentType)), /^\[agent-companion\] Context at 111K, limit 150K: finish the current step/, agentType);
      assert.deepEqual(rows().map((x) => [x.limit, x.action]), [['soft', 'notice']], `${agentType}: no warn row`);
    } finally { fx.cleanup(); }
  }
});

test('0.31.65 higher rungs: one warn at 110K, silence to 130K, the handoff notice at 130K', () => {
  for (const agentType of ['ac-sonnet-high', 'ac-sonnet-xhigh', 'ac-opus-medium', 'ac-opus-high', 'agent-companion:ac-opus-max']) {
    const line = /opus/.test(agentType) ? 120 : 130; // 0.31.66: the opus rungs hand off at 120K
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx);
      assert.equal(at(lead, agentFile, 109000, agentType).stdout.trim(), '', `${agentType} at 109K`);
      const w = text(at(lead, agentFile, 111000, agentType));
      assert.match(w, new RegExp(`^\\[agent-companion\\] Context at 111K \\(handoff notice at ${line}K, hard stop at 150K\\): keep your handoff file`), agentType);
      assert.equal(at(lead, agentFile, 112000, agentType).stdout.trim(), '', `${agentType}: the warn is once`);
      assert.equal(at(lead, agentFile, line * 1000 - 1000, agentType).stdout.trim(), '', `${agentType} between the lines`);
      assert.match(text(at(lead, agentFile, line * 1000 + 1000, agentType)), new RegExp(`^\\[agent-companion\\] Context at ${line + 1}K, limit 150K: finish the current step`), agentType);
      assert.deepEqual(rows().map((x) => [x.limit, x.action, x.tokens]), [['warn', 'warn', 111000], ['soft', 'notice', line * 1000 + 1000]], agentType);
    } finally { fx.cleanup(); }
  }
});

test('0.31.65 the hard stop is at 150K for every rung', () => {
  for (const agentType of ['ac-haiku', 'ac-sonnet-low', 'ac-sonnet-high', 'ac-opus-xhigh']) {
    const fx = makeFixture();
    try {
      const { lead, agentFile } = layout(fx);
      assert.equal(denied(at(lead, agentFile, 149000, agentType)), false, `${agentType} at 149K`);
      assert.equal(denied(at(lead, agentFile, 151000, agentType)), true, `${agentType} at 151K`);
    } finally { fx.cleanup(); }
  }
});

test('0.31.65 the options override the defaults', () => {
  const env = (o) => ({ ...DEFAULTS, ...o });
  const HI = 'CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_HIGH_TOKENS';
  const WARN = 'CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_WARN_TOKENS';
  const LOW = 'CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS';
  const fx = makeFixture();
  try {
    const { lead, agentFile } = layout(fx);
    // high line moved to 120K: the handoff notice at 121K for a high rung
    assert.match(text(at(lead, agentFile, 121000, 'ac-sonnet-high', env({ [HI]: '120000' }))), /Context at 121K, limit 150K/);
  } finally { fx.cleanup(); }
  const fy = makeFixture();
  try {
    const { lead, agentFile } = layout(fy);
    // high 0 falls back to the lower line (110K): the handoff notice at 111K
    assert.match(text(at(lead, agentFile, 111000, 'ac-opus-high', env({ [HI]: '0' }))), /Context at 111K, limit 150K/);
  } finally { fy.cleanup(); }
  const fz = makeFixture();
  try {
    const { lead, agentFile } = layout(fz);
    // warn 0: no warn at 115K for a high rung
    assert.equal(at(lead, agentFile, 115000, 'ac-sonnet-xhigh', env({ [WARN]: '0' })).stdout.trim(), '');
  } finally { fz.cleanup(); }
  const fw = makeFixture();
  try {
    const { lead, agentFile } = layout(fw);
    // the lower line moved to 90K: a lower rung is told at 91K
    assert.match(text(at(lead, agentFile, 91000, 'ac-sonnet-low', env({ [LOW]: '90000' }))), /Context at 91K, limit 150K/);
  } finally { fw.cleanup(); }
});

test('0.31.65 threshold library: rung classes and lines', async () => {
  const lib = await import('../hooks/lib/handoff-limit.mjs');
  for (const t of ['ac-sonnet-high', 'ac-sonnet-xhigh', 'ac-opus-low', 'ac-opus-max', 'agent-companion:ac-opus-high']) assert.equal(lib.isHighRung(t), true, t);
  for (const t of ['ac-haiku', 'ac-sonnet-low', 'ac-sonnet-medium', 'general-purpose', '', undefined]) assert.equal(lib.isHighRung(t), false, String(t));
  assert.equal(lib.handoffThreshold('ac-sonnet-low'), 110000);
  assert.equal(lib.handoffThreshold('ac-opus-high'), 120000, '0.31.66: opus rungs hand off at 120K');
  assert.equal(lib.handoffThreshold('agent-companion:ac-opus-max'), 120000);
  assert.equal(lib.handoffThreshold('ac-sonnet-high'), 130000);
  assert.equal(lib.handoffThreshold('ac-sonnet-xhigh'), 130000);
  assert.equal(lib.warnThreshold('ac-opus-high'), 110000);
  assert.equal(lib.warnThreshold('ac-sonnet-low'), 0, 'warn equals the lower line: none');
  assert.equal(lib.warnThreshold('ac-sonnet-high'), 110000);
  assert.match(lib.warnText(111000, 130000, 150000), /Context at 111K \(handoff notice at 130K, hard stop at 150K\)/);
});

test('0.31.65 threshold library: high rungs never hand off before the lower ones, nor past the hard stop', async () => {
  const lib = await import('../hooks/lib/handoff-limit.mjs');
  const keys = ['CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS', 'CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_HARD_TOKENS'];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env[keys[0]] = '300000'; // base raised above the high default
    delete process.env[keys[1]];
    assert.equal(lib.handoffThreshold('ac-opus-high'), 300000, 'not earlier than the lower rungs');
    delete process.env[keys[0]];
    process.env[keys[1]] = '120000'; // hard stop below the high line: the notice would never be heard
    assert.equal(lib.handoffThreshold('ac-opus-high'), 110000);
    assert.equal(lib.handoffThreshold('ac-sonnet-low'), 110000);
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
