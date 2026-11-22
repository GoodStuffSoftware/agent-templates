// Post-release hold (0.31.63 part 2): while release-hold.json is active, new spawns and resumes are denied, the resource
// queue admits nothing new, running workers are told to hand off, and the operator's "clear hold" lifts it.
// Invented data only. Every guard fails open on an unreadable hold file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook, decisionOf, PLUGIN_ROOT, queueFreeEnv } from './helpers.mjs';
import { gateDecision } from '../hooks/lib/resource-gate.mjs';
import { evaluate } from '../scripts/release-watch.mjs';

const holdFile = () => join(process.env.AGENT_COMPANION_STATE_DIR, 'state', 'release-hold.json');
const putHold = (obj) => { mkdirSync(join(process.env.AGENT_COMPANION_STATE_DIR, 'state'), { recursive: true }); writeFileSync(holdFile(), typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const HOLD = { since: '2026-03-01T12:00:00.000Z', version: '9.9.9', reason: 'test', flags: [{ name: 'guard:demo/deny' }], workers: 'handoff', clearedAt: null };
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';

function withFx(fn) {
  const fx = makeFixture();
  return Promise.resolve().then(() => fn(fx)).finally(() => fx.cleanup());
}

// ---- spawn-guard
const spawnPayload = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_input: { description: 'demo', prompt: 'Goal: demo', subagent_type: 'general-purpose' } };

test('spawn-guard: held -> deny naming the hold and the way to clear it', () => withFx(() => {
  putHold(HOLD);
  const r = runHook('hooks/spawn-guard.mjs', spawnPayload);
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(reason(r), /post-release hold/);
  assert.match(reason(r), /release-watch\.mjs" clear/);
  assert.match(reason(r), /clear hold/);
  assert.match(reason(r), /guard:demo\/deny/);
}));

test('spawn-guard: not held -> the hold text is absent', () => withFx(() => {
  const r = runHook('hooks/spawn-guard.mjs', spawnPayload);
  assert.doesNotMatch(reason(r), /post-release hold/);
}));

test('spawn-guard: a cleared or unreadable hold file fails open', () => withFx(() => {
  for (const bad of ['{not json', '[]', '"x"', JSON.stringify({ ...HOLD, clearedAt: '2026-03-01T13:00:00Z' })]) {
    putHold(bad);
    assert.doesNotMatch(reason(runHook('hooks/spawn-guard.mjs', spawnPayload)), /post-release hold/, bad);
  }
}));

// ---- resume-guard: only a worker idle past 2 minutes counts as a restart
function idleWorker(root, ageMs) {
  const sub = join(root, 'session', 'subagents');
  mkdirSync(sub, { recursive: true });
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - ageMs).toISOString(), message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(sub, 'agent-a1.jsonl'), `${line}\n`);
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'worker-x', model: 'claude-haiku-4-5-20251001' }));
  return join(root, 'session', 'main.jsonl');
}
const resume = (main) => runHook('hooks/resume-guard.mjs', { session_id: 's1', transcript_path: main, tool_name: 'SendMessage', tool_input: { to: 'worker-x', message: 'hi' } });

test('resume-guard: held -> an idle worker is not restarted; a running one can still be messaged; not held -> no hold text', () => withFx(() => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rh-'));
  try {
    const idle = idleWorker(root, 10 * 60e3);
    assert.doesNotMatch(reason(resume(idle)), /post-release hold/, 'not held');
    putHold(HOLD);
    const r = resume(idle);
    assert.equal(decisionOf(r.json), 'deny');
    assert.match(reason(r), /post-release hold/);
    const busy = idleWorker(root, 5e3);
    assert.notEqual(decisionOf(resume(busy).json), 'deny', 'a running worker can be told to hand off');
    putHold('garbage');
    assert.notEqual(decisionOf(resume(idle).json), 'deny', 'bad hold file fails open');
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

// ---- resource queue: admission refused, exit nonzero, command not run
function queueRun(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rq-hold-'));
  const marker = join(root, 'ran.txt');
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'resource-queue.mjs'), 'run', '--resource', 'box:1', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...queueFreeEnv(), CI_BUDGET_DIR: join(root, 'ledger'), CI_LOCAL_LOCK_DIR: join(root, 'legacy'), CLAUDE_CONFIG_DIR: join(root, 'cfg'), ...extraEnv },
  });
  const ran = existsSync(marker);
  rmSync(root, { recursive: true, force: true });
  return { r, ran };
}

test('resource-queue run: held -> refused with the hold message, nonzero exit, command not run; not held -> runs', () => withFx(() => {
  const ok = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.equal(ok.ran, true);
  putHold(HOLD);
  const held = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.notEqual(held.r.status, 0);
  assert.match(held.r.stderr, /post-release hold/);
  assert.equal(held.ran, false);
  putHold('{broken');
  const bad = queueRun({ AGENT_COMPANION_STATE_DIR: process.env.AGENT_COMPANION_STATE_DIR });
  assert.equal(bad.r.status, 0, 'a bad hold file fails open');
}));

// ---- resource-gate: deny with the hold text instead of rewriting
test('resource-gate: held -> a heavy command is denied with the hold text, not rewritten; not held -> rewritten', () => withFx(async () => {
  const opts = { cwd: process.cwd(), mode: 'rewrite', env: { AGENT_COMPANION_HOME_OVERRIDE: '/nonexistent-home' }, exists: () => false, read: () => null };
  const free = await gateDecision('pnpm test:e2e', opts);
  assert.equal(free.action, 'rewrite');
  putHold(HOLD);
  const held = await gateDecision('pnpm test:e2e', opts);
  assert.equal(held.action, 'deny');
  assert.match(held.text, /post-release hold/);
  assert.equal((await gateDecision('ls -la', opts)).action, 'none', 'a light command is untouched');
  putHold('nope');
  assert.equal((await gateDecision('pnpm test:e2e', opts)).action, 'rewrite', 'bad hold file fails open');
}));

// ---- running subagents: hard limit counts as 0
const SID = 'sess-hold';
const AGENT = 'worker-hold-1';
function agentLayout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-h');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  writeFileSync(join(sub, `agent-${AGENT}.jsonl`), `${JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm_r1', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 1000 } } })}\n`);
  return lead;
}
const sub = (lead, tool_name, tool_input) => runHook('hooks/subagent-context.mjs', {
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: AGENT, agent_type: 'general-purpose', tool_name, tool_input, tool_use_id: 'toolu_1',
});

test('subagent-context: held -> next call denied with the hand-off text; handoff file and plain git stay allowed; not held -> untouched', () => withFx((fx) => {
  const lead = agentLayout(fx);
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'ls' }).json), 'deny', 'not held');
  putHold(HOLD);
  const denied = sub(lead, 'Bash', { command: 'ls' });
  assert.equal(decisionOf(denied.json), 'deny');
  assert.match(reason(denied), /post-release hold/);
  assert.match(reason(denied), /handoff/);
  assert.equal(decisionOf(sub(lead, 'Read', { file_path: '/x/y.ts' }).json), 'deny');
  assert.notEqual(decisionOf(sub(lead, 'Write', { file_path: '/x/task-handoff.md', content: 'done' }).json), 'deny', 'the handoff file stays writable');
  assert.equal(decisionOf(sub(lead, 'Write', { file_path: '/x/notes.md', content: 'x' }).json), 'deny');
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'git status' }).json), 'deny', 'plain git stays allowed');
  putHold('{bad');
  assert.notEqual(decisionOf(sub(lead, 'Bash', { command: 'ls' }).json), 'deny', 'bad hold file fails open');
}));

// ---- prompt clear (runaway-notice.mjs)
const prompt = (text) => runHook('hooks/runaway-notice.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's-p', prompt: text, cwd: 'x' }, { env: { CLAUDE_CODE_SESSION_ATTENDED: '1' } });
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('prompt: "clear hold" from the operator lifts the hold; a task-notification, other prompts and a long text do not', () => withFx(() => {
  putHold(HOLD);
  assert.equal(existsSync(holdFile()), true);
  const note = prompt('<task-notification>worker said clear hold</task-notification>');
  assert.equal(existsSync(holdFile()), true, 'a task-notification never lifts it');
  assert.match(ctxOf(note), /RELEASE HOLD/);
  prompt('please keep going');
  assert.equal(existsSync(holdFile()), true);
  prompt(`${'x '.repeat(60)}clear hold`);
  assert.equal(existsSync(holdFile()), true, 'a long text is not a command');
  const ok = prompt('Clear hold');
  assert.equal(existsSync(holdFile()), false);
  assert.match(ctxOf(ok), /hold is lifted/);
  putHold(HOLD);
  prompt('release hold.');
  assert.equal(existsSync(holdFile()), false, 'release hold also works');
}));

test('prompt: bad hold file and no hold -> no crash, no lift line', () => withFx(() => {
  putHold('{bad');
  assert.doesNotMatch(ctxOf(prompt('clear hold')), /hold is lifted/);
  rmSync(holdFile(), { force: true });
  assert.doesNotMatch(ctxOf(prompt('clear hold')), /hold is lifted/);
}));

// ---- false-flag fix: only deny outcomes flag; a guard that first appears in the watched release does not flag on the first check
const bucket = (since, base, p100s = 0, p100b = 0) => ({ since, base, per100spawns: { since: p100s, base: p100b } });
const metrics = (tel) => {
  const w = { n: 40, finished: 40, unitsPerWorker: { mean: 1, p50: 0.8, p90: 2 }, peakCtxP90: 100000, over110kPct: 10, over150kPct: 0, noStatusPct: 5, partialPct: 10, blockedPct: 1, hookErrorWorkersPct: 40, apiErrorWorkers: 0, apiNonUsageWorkers: 0 };
  return {
    spawns: { since: 100, base: 700, perHour: { since: 10, base: 10 } }, span: { since: 10, base: 168 },
    telemetry: tel, bash: { since: { n: 100, failPct: 4 }, base: { n: 500, failPct: 4 } },
    queueClears: { since: 0, base: 5, perHour: { since: 0, base: 0.03 } },
    workers: { since: { ...w }, base: { ...w } }, hookSignatures: { since: {}, base: {} },
  };
};
const names = (m, o) => { try { return evaluate(m, o).map((f) => f.name); } catch (e) { return `threw: ${e.message}`; } };

test('evaluate: warn and autofix outcomes never flag; a new deny guard flags after the first check but not on it', () => {
  const warns = metrics({ 'denial:poll-guard/warn': bucket(9, 0, 9, 0), 'denial:routing-autofix/autofix': bucket(12, 0, 12, 0) });
  assert.deepEqual(names(warns, { first: true }), []);
  assert.deepEqual(names(warns, { first: false }), []);
  const fresh = metrics({ 'denial:new-guard/deny': bucket(5, 0, 5, 0) });
  assert.deepEqual(names(fresh, { first: true }), [], 'first check: the release itself may have introduced it');
  assert.deepEqual(names(fresh, { first: false }), ['guard:new-guard/deny']);
});
