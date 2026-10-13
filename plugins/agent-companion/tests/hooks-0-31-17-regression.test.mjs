// Reviewer-added tests for agent-companion 0.31.17, part 1 (hooks). Review: REVIEW-0-31-17-hooks.md.
// Written against release head the review baseline. Run: node --test plugins/agent-companion/tests/hooks-0-31-17-regression.test.mjs
//
// Names starting "FAILS on the review baseline:" assert the behavior the review asks for and are EXPECTED TO FAIL
// until the finding is fixed. Every other test passes today; those are controls (they pin what already
// works, so a fix for a finding cannot regress it) or evidence for a must-test question in the brief.
// Synthetic fixtures only: a throwaway home under the test sandbox, no real ~/.claude, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { readWorkers } from '../hooks/lib/advisory-b.mjs';
import { NESTED_QUANT } from '../hooks/lib/struggle.mjs';

const ADV = 'hooks/advisory-b.mjs';
const CLOUD = 'hooks/cloud-routine-pin.mjs';
const CHECK = 'hooks/routine-pin-check.mjs';
const PLACE = 'hooks/routine-placement.mjs';
const SID = 'lead-sess-1';
const run = (event, payload, env) => runHook(ADV, payload, { args: ['--event', event], env });
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const CREATE = 'mcp__scheduled-tasks__create_scheduled_task';

// ---------------------------------------------------------------- fixtures for the worker ledger
const MIN = 60000;
const ago = (min) => new Date(Date.now() - min * MIN);
const rec = (min, o) => JSON.stringify({ timestamp: ago(min).toISOString(), ...o });
const userText = (min, text) => rec(min, { type: 'user', message: { role: 'user', content: text } });
const asstText = (min, text) => rec(min, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (min, id, name, input) => rec(min, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (min, id, text) => rec(min, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function layout(fx) {
  const proj = join(fx.dir, '.claude', 'projects', 'slug');
  const transcript = join(proj, `${SID}.jsonl`);
  const subDir = join(proj, SID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(transcript, '{}\n');
  return { transcript, subDir, proj };
}
// A worker as the hooks see it: a ledger start row, the telemetry start row, a name file, and a subagent
// transcript whose records are `lines` and whose mtime is `mtimeAgoMin` minutes ago.
function worker(fx, subDir, id, name, { startedAgoMin, lines, mtimeAgoMin }) {
  const ledger = join(fx.stateDir, 'state', 'worker-ledger');
  mkdirSync(ledger, { recursive: true });
  const at = ago(startedAgoMin).toISOString();
  writeFileSync(join(ledger, `${SID}.jsonl`), `${JSON.stringify({ at, ev: 'start', agent_id: id, agent_type: 'general-purpose' })}\n`, { flag: 'a' });
  const tel = join(fx.stateDir, 'telemetry');
  mkdirSync(tel, { recursive: true });
  writeFileSync(join(tel, 'subagent-starts.jsonl'), `${JSON.stringify({ v: 2, at, session_id: SID, agent_id: id, agent_type: 'general-purpose' })}\n`, { flag: 'a' });
  writeFileSync(join(subDir, `agent-${id}.meta.json`), JSON.stringify({ name, agentType: 'general-purpose' }));
  const f = join(subDir, `agent-${id}.jsonl`);
  writeFileSync(f, `${lines.join('\n')}\n`);
  const t = ago(mtimeAgoMin);
  utimesSync(f, t, t);
  return f;
}
const ledgerRows = (fx) => readFileSync(join(fx.stateDir, 'state', 'worker-ledger', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const runningIds = (fx, transcript) => [...readWorkers(SID, { transcriptPath: transcript })].filter(([, w]) => w.running).map(([id]) => id).sort();

// ---------------------------------------------------------------- TaskStop by worker NAME (finding 1)
// Real traffic (48 local_agent TaskStop calls in ~/.claude/projects, last 60 days): 35 passed the worker's
// NAME as tool_input.task_id; only 13 passed the agent id. The structured result always carries the agent
// id: {"message":"Successfully stopped task: worker-stop-one (...)","task_id":"worker-stop-one","task_type":"local_agent",...}
test('FAILS on the review baseline: TaskStop by worker NAME (73% of real stops) writes the stop row for the agent id in the result', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'worker-stop-one', 'cache-ttl-analysis', {
      startedAgoMin: 40, mtimeAgoMin: 1,
      lines: [userText(40, 'analyse'), asstText(1, 'still working')],
    });
    const p = { session_id: SID, transcript_path: transcript, tool_name: 'TaskStop' };
    run('task-stop', {
      ...p, tool_input: { task_id: 'cache-ttl-analysis' },
      tool_response: { message: 'Successfully stopped task: worker-stop-one (Analyze subagent 1h cache TTL savings)', task_id: 'worker-stop-one', task_type: 'local_agent', command: 'Analyze subagent 1h cache TTL savings' },
    });
    const rows = ledgerRows(fx);
    assert.equal(rows.filter((r) => r.ev === 'stop').length, 1, 'a stop row for the stopped worker');
    assert.equal(rows[rows.length - 1].agent_id, 'worker-stop-one');
    assert.equal(ctx(run('tick', { session_id: SID, transcript_path: transcript })), '', 'F14 must not flag a worker the operator just stopped');
  } finally { fx.cleanup(); }
});

test('control: TaskStop by agent id (27% of real stops) writes the stop row', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'worker-stop-two', 'bench-flakes', { startedAgoMin: 40, mtimeAgoMin: 1, lines: [asstText(1, 'working')] });
    run('task-stop', {
      session_id: SID, transcript_path: transcript, tool_name: 'TaskStop', tool_input: { task_id: 'worker-stop-two' },
      tool_response: { message: 'Successfully stopped task: worker-stop-two (x)', task_id: 'worker-stop-two', task_type: 'local_agent' },
    });
    assert.equal(ledgerRows(fx).filter((r) => r.ev === 'stop').length, 1);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- 15-minute idle bound (finding 2)
// Real traffic: 28 of 3875 subagent transcripts (30 days) contain one tool call that took more than 15 min
// to return (Bash/PowerShell test gates of 16.7-26.4 min, foreground Agent calls). While such a call runs
// the transcript is silent and the worker is dropped from the ledger.
const LONG_CALL = [
  userText(40, 'run the gate'),
  toolUse(21, 'tu1', 'PowerShell', { command: 'node scripts/ci-local.mjs' }), // no tool_result yet: the call is still running
];

test('FAILS on the review baseline: a worker blocked 21 min in one tool call is still running in the ledger', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'test-gate-runner', { startedAgoMin: 40, mtimeAgoMin: 21, lines: LONG_CALL });
    assert.deepEqual(runningIds(fx, transcript), ['a1']);
  } finally { fx.cleanup(); }
});

test('FAILS on the review baseline: F14 flags a worker that is 40 min in and blocked in a 21 min tool call', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'test-gate-runner', { startedAgoMin: 40, mtimeAgoMin: 21, lines: LONG_CALL });
    assert.match(ctx(run('tick', { session_id: SID, transcript_path: transcript })), /^test-gate-runner has run 40 min/);
  } finally { fx.cleanup(); }
});

test('FAILS on the review baseline: F10 names a worker that is blocked in a long tool call', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'test-gate-runner', { startedAgoMin: 40, mtimeAgoMin: 21, lines: LONG_CALL });
    worker(fx, subDir, 'a2', 'active-writer', { startedAgoMin: 10, mtimeAgoMin: 1, lines: [asstText(1, 'working')] });
    const c = ctx(run('send', { session_id: SID, transcript_path: transcript, tool_input: { to: 'stranger-peer' } }));
    assert.match(c, /test-gate-runner/, c);
    assert.match(c, /active-writer/, c);
  } finally { fx.cleanup(); }
});

test('control: the same worker is reported again as soon as the long call returns (F14 fires after the fact)', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'test-gate-runner', { startedAgoMin: 40, mtimeAgoMin: 0, lines: [...LONG_CALL, toolResult(0, 'tu1', 'ok')] });
    assert.deepEqual(runningIds(fx, transcript), ['a1']);
    assert.match(ctx(run('tick', { session_id: SID, transcript_path: transcript })), /^test-gate-runner has run 40 min/);
  } finally { fx.cleanup(); }
});

test('control: an idle worker whose last record is a finished assistant turn (no pending tool call) is not running', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'finished-quietly', { startedAgoMin: 40, mtimeAgoMin: 21, lines: [userText(40, 'go'), asstText(21, 'Done. Report written.')] });
    assert.deepEqual(runningIds(fx, transcript), []);
    assert.equal(ctx(run('tick', { session_id: SID, transcript_path: transcript })), '');
  } finally { fx.cleanup(); }
});

test('control: F9 is independent of the idle bound; a lead blocked on a long foreground worker stays listed for 2 h', () => {
  const fx = makeFixture();
  try {
    const slug = (s) => s.replace(/[^A-Za-z0-9]/g, '-');
    const cwd = join(fx.dir, 'dev', 'app-a');
    const d = join(fx.dir, '.claude', 'projects', slug(cwd));
    mkdirSync(d, { recursive: true });
    const f = join(d, 'blocked-lead.jsonl');
    // last record 100 min old: the lead launched a foreground Agent call and has been waiting since
    writeFileSync(f, `${userText(110, 'Run the gate')}\n${toolUse(100, 'tuA', 'Agent', { description: 'x' })}\n`);
    const t = ago(100);
    utimesSync(f, t, t);
    assert.match(ctx(run('session-start', { session_id: SID, cwd })), /\(app-a, 1h 40m\)/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- mtime is not liveness for a subagent transcript (finding 3)
// advisory-b.mjs lastRecordMs() says: "The mtime alone is not proof of life: the desktop app and orphaned CLIs
// touch idle transcripts", and F9 was fixed for that. readWorkers() still trusts the subagent transcript's mtime.
// Real data: 134 of the 152 subagent transcripts modified in the last 15 min have a last record ~17 days older.
test('FAILS on the review baseline: a zombie started 3 days ago whose transcript was only touched (mtime now, last record 3 days old) is not running', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'old-zombie', {
      startedAgoMin: 3 * 24 * 60, mtimeAgoMin: 1,
      lines: [userText(3 * 24 * 60, 'go'), asstText(3 * 24 * 60 - 5, 'working')],
    });
    assert.deepEqual(runningIds(fx, transcript), []);
    assert.equal(ctx(run('tick', { session_id: SID, transcript_path: transcript })), '', 'no "has run 4320 min" note');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- RemoteTrigger deny: legitimate calls (must-test 2)
const jc = (model) => ({ ccr: { environment_id: 'env_1', session_context: model === undefined ? { allowed_tools: ['Bash'] } : { model, allowed_tools: ['Bash'] } } });
const rt = (input) => runHook(CLOUD, { tool_name: 'RemoteTrigger', tool_input: input });

test('RemoteTrigger: updates that do not touch job_config are never blocked (real body shapes), nor run/get/list', () => {
  for (const input of [
    { action: 'update', trigger_id: 't', body: { mcp_connections: [{ name: 'bus-x', url: 'https://x.example/mcp' }] } },
    { action: 'update', trigger_id: 't', body: { clear_mcp_connections: true } },
    { action: 'update', trigger_id: 't', body: JSON.stringify({ clear_mcp_connections: true }) },
    { action: 'update', trigger_id: 't', body: { mcp_connections: [] } },
    { action: 'update', trigger_id: 't', body: { mcp_connections: null } },
    { action: 'update', trigger_id: 't', body: { enabled: false } },
    { action: 'update', trigger_id: 't', body: { name: 'renamed' } },
    { action: 'update', trigger_id: 't', body: { enabled: true, name: 'x' } },
    { action: 'update', trigger_id: 't', body: { enabled_plugins: ['a'], extra_marketplaces: [] } },
    { action: 'UPDATE', trigger_id: 't', body: { enabled: false } },
    { action: 'run', trigger_id: 't' },
    { action: 'get', trigger_id: 't' },
    { action: 'list' },
    { action: 'list_runs', trigger_id: 't' },
    { action: 'get_run_log', trigger_id: 't', run_id: 'r' },
    { action: 'delete', trigger_id: 't' },
  ]) {
    const r = rt(input);
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(r.stdout.trim(), '', `blocked or noted: ${JSON.stringify(input)} -> ${r.stdout}`);
  }
});

test('RemoteTrigger: a body whose job_config keeps the model passes, as object, JSON-string job_config, or JSON-string body', () => {
  for (const input of [
    { action: 'update', trigger_id: 't', body: { job_config: jc('sonnet') } },
    { action: 'update', trigger_id: 't', body: { job_config: JSON.stringify(jc('opus')) } },
    { action: 'update', trigger_id: 't', body: JSON.stringify({ name: 'n', enabled: true, cron_expression: '0 9 * * *', job_config: jc('haiku') }) },
    { action: 'create', body: { name: 'n', cron_expression: '0 9 * * *', job_config: jc('sonnet'), mcp_connections: [] } },
  ]) {
    const r = rt(input);
    assert.equal(r.stdout.trim(), '', JSON.stringify(input));
  }
});

test('RemoteTrigger: a job_config without a model is denied (control), including a null/blank model and no session_context', () => {
  for (const body of [
    { job_config: jc(undefined) }, { job_config: jc(null) }, { job_config: jc('') }, { job_config: { ccr: { environment_id: 'e' } } },
    { name: 'n', enabled: true, job_config: jc(undefined) },
  ]) {
    const r = rt({ action: 'update', trigger_id: 't', body });
    assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(body));
  }
});

test('characterization (INFO): a create through session_request instead of job_config is not checked', () => {
  // The API accepts "job_config or session_request" (real HTTP 400: "One of job_config or session_request must be set").
  // The pin rule only looks at job_config, so a modelless session_request create passes. Unverified whether
  // session_request carries a model field at all; recorded so the decision is explicit.
  const r = rt({ action: 'create', body: { name: 'n', prompt: 'do it', cron_expression: '0 9 * * *', session_request: { prompt: 'x' } } });
  assert.equal(r.stdout.trim(), '');
});

// ---------------------------------------------------------------- post-create check (must-test 3)
function task(fx, id, model) {
  const d = join(fx.dir, '.claude', 'scheduled-tasks', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n${model ? `model: ${model}\n` : ''}---\nBody\n`);
}
// The real create_scheduled_task result: an MCP content array (29 of 29 successful real calls), with a Windows path.
const realResult = (id) => [{ type: 'text', text: `Scheduled task "${id}" created.\n\n**Task file:** C:\\Users\\someone\\.claude\\scheduled-tasks\\${id}\\SKILL.md\n**Schedule:** Manual only (no automatic schedule)\n` }];

test('post-create: real result shape (content array, as array and wrapped), input taskId present: note with the path', () => {
  const fx = makeFixture();
  try {
    task(fx, 'rv-routine', null);
    for (const tool_response of [realResult('rv-routine'), { content: realResult('rv-routine') }, 'Scheduled task "rv-routine" created.']) {
      const r = runHook(CHECK, { tool_name: CREATE, tool_input: { taskId: 'rv-routine', prompt: 'x' }, tool_response, cwd: fx.dir });
      assert.ok(ctx(r).includes('scheduled-tasks/rv-routine/SKILL.md'), JSON.stringify(tool_response));
    }
  } finally { fx.cleanup(); }
});

test('post-create: input taskId missing, every result shape that carries the path or a taskId field still finds the task', () => {
  const fx = makeFixture();
  try {
    task(fx, 'from-result', null);
    for (const tool_response of [
      realResult('from-result'),
      { content: realResult('from-result') },
      'Task file: C:\\Users\\x\\.claude\\scheduled-tasks\\from-result\\SKILL.md',
      'created at /home/x/.claude/scheduled-tasks/from-result/SKILL.md',
      { taskId: 'from-result' },
      '{"taskId":"from-result"}',
    ]) {
      const r = runHook(CHECK, { tool_name: CREATE, tool_input: { prompt: 'x' }, tool_response, cwd: fx.dir });
      assert.ok(ctx(r).includes('scheduled-tasks/from-result/SKILL.md'), JSON.stringify(tool_response));
    }
  } finally { fx.cleanup(); }
});

test('post-create: a result shape that carries no id, an error shape, a missing response, a pinned task: silent and exit 0', () => {
  const fx = makeFixture();
  try {
    task(fx, 'pinned', 'sonnet');
    task(fx, 'bare', null);
    for (const [tool_input, tool_response] of [
      [{ prompt: 'x' }, 'Created.'],
      [{ prompt: 'x' }, { isError: true, content: [{ type: 'text', text: 'Cannot subscribe a scheduled-task run session to completion notifications' }] }],
      [{ prompt: 'x' }, undefined],
      [{ taskId: 'pinned' }, realResult('pinned')],
      [{ taskId: '../bare' }, realResult('nothing-here')],
    ]) {
      const r = runHook(CHECK, { tool_name: CREATE, tool_input, tool_response, cwd: fx.dir });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', JSON.stringify({ tool_input, tool_response }));
    }
  } finally { fx.cleanup(); }
});

test('FAILS on the review baseline: when the app names the task differently from tool_input.taskId, the result path decides (no real instance in 29 calls)', () => {
  const fx = makeFixture();
  try {
    task(fx, 'my-daily-report', null); // what the app wrote
    const r = runHook(CHECK, {
      tool_name: CREATE, tool_input: { taskId: 'My Daily Report', prompt: 'x' },
      tool_response: realResult('my-daily-report'), cwd: fx.dir,
    });
    assert.ok(ctx(r).includes('scheduled-tasks/my-daily-report/SKILL.md'), `silent: ${r.stdout}`);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- routine placement note (finding 5)
test('FAILS on the review baseline: a top-level effortLevel folder pin is not described as both "none" and "applies" in one note', () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, 'top');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ effortLevel: 'low' }));
    const n = ctx(runHook(PLACE, { tool_name: CREATE, tool_input: { taskId: 'abc', prompt: 'x' }, cwd: dir }));
    assert.ok(n.includes('pin applies (top-level effortLevel low'), n);
    assert.ok(!n.includes('folder effort pin: none'), `contradiction: ${n.slice(0, 260)}`);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- Haiku-leak note and REASON (finding 6)
function spawnNote(prompt, sid, model) {
  const fx = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: fx.dir,
      tool_input: { subagent_type: 'general-purpose', model, prompt, run_in_background: true, name: 'w' },
    });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
    const hso = res.json?.hookSpecificOutput || {};
    return { row: rows[rows.length - 1], text: `${hso.additionalContext || ''} ${res.json?.systemMessage || ''}`, decision: hso.permissionDecision };
  } finally { fx.cleanup(); }
}

test('control: a Haiku-route spawn on sonnet gets the leak note; a real REASON line silences it', () => {
  assert.match(spawnNote('TYPE: explore\nROLE: lookup\nfind the file', 'rv-leak-1', 'sonnet').text, /trial leak/);
  assert.doesNotMatch(spawnNote('TYPE: explore\nROLE: lookup\nREASON: needs cross-file synthesis\nfind the file', 'rv-leak-2', 'sonnet').text, /trial leak/);
});

test('FAILS on the review baseline: an empty "REASON:" line does not silence the leak note', () => {
  const s = spawnNote('TYPE: explore\nROLE: lookup\nREASON:\nfind the file', 'rv-leak-3', 'sonnet');
  assert.match(s.text, /trial leak/);
});

// ---------------------------------------------------------------- struggle ReDoS guard (finding 7)
test('control: NESTED_QUANT catches the documented shapes', () => {
  for (const src of ['(a+)+', '(.*)*', '(a|b*){2,}', '(?:a+)+$', '(\\w+\\s?)+']) assert.ok(NESTED_QUANT.test(src), src);
  for (const src of ['foo|bar', '(foo|bar)+', 'a+b']) assert.ok(!NESTED_QUANT.test(src), src);
});

test('FAILS on the review baseline: NESTED_QUANT also catches a nested group whose inner group holds the quantifier', () => {
  for (const src of ['((a+))+', '(?:(a+))+$', '((.*))*']) assert.ok(NESTED_QUANT.test(src), `bypasses the guard: ${src}`);
});

// ---------------------------------------------------------------- added with the fixes
test('TaskStop by name resolves through the sidecar name when the result carries no id', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'worker-stop-one', 'cache-ttl-analysis', { startedAgoMin: 40, mtimeAgoMin: 1, lines: [asstText(1, 'working')] });
    run('task-stop', { session_id: SID, transcript_path: transcript, tool_name: 'TaskStop', tool_input: { task_id: 'cache-ttl-analysis' }, tool_response: {} });
    assert.equal(ledgerRows(fx).filter((r) => r.ev === 'stop').length, 1);
  } finally { fx.cleanup(); }
});

test('a worker blocked in an open tool call is dropped after the 90 min cap', () => {
  const fx = makeFixture();
  try {
    const { transcript, subDir } = layout(fx);
    worker(fx, subDir, 'a1', 'stuck', { startedAgoMin: 200, mtimeAgoMin: 100, lines: [userText(200, 'go'), toolUse(100, 'tu1', 'Bash', { command: 'x' })] });
    assert.deepEqual(runningIds(fx, transcript), []);
  } finally { fx.cleanup(); }
});

test('a legacy claude-haiku-4-5 writer gets no reviewer effort floor (the model takes no effort)', async () => {
  const ctxm = await import('../hooks/lib/context.mjs');
  const r = ctxm.resolveRoute({ type: 'code-review', writer: { model: 'claude-haiku-4-5', effort: '' }, profile: false });
  assert.equal(r.effort || '', '');
});
