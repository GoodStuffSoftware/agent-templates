// Delegation guard, on payloads shaped like the REAL ones.
//
// The shapes come from the harness's own hook-input schema (Claude Code
// 2.1.281): a main-thread PreToolUse carries session_id, transcript_path,
// cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id
// and effort — and NO agent_id and NO agent_type. A subagent's carries the
// LEAD's session_id plus agent_id and agent_type. An --agent session's main
// thread carries agent_type without agent_id. The guard used to require
// agent_type === 'main', which none of these carry; its old tests passed only
// because they supplied it themselves.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT, childEnv, decisionOf } from './helpers.mjs';
import {
  EXECUTION_TOOLS, RESET_TOOLS, countCall, delegationMode, delegationThreshold, delegationScope,
  outOfScope, isServedCall, attendedCoverage, LOCK_MAX_AGE_MS,
} from '../hooks/lib/delegation.mjs';
import { acquireLock, releaseLock } from '../hooks/lib/file-lock.mjs';
import { callerIsSubagent, isMainThread } from '../hooks/lib/context.mjs';

const TOOL_INPUT = {
  Bash: { command: 'git status', description: 'Show status' },
  PowerShell: { command: 'Get-ChildItem', description: 'List files' },
  Read: { file_path: 'C:/repo/a.txt' },
  Grep: { pattern: 'foo' },
  Glob: { pattern: '**/*.mjs' },
  Edit: { file_path: 'C:/repo/a.txt', old_string: 'a', new_string: 'b' },
  Write: { file_path: 'C:/repo/b.txt', content: 'x' },
  NotebookEdit: { notebook_path: 'C:/repo/n.ipynb', new_source: 'x' },
};

// Every hook run gets the attended variable set the way an attended
// (terminal, desktop, IDE) session's hooks see it, unless a test overrides
// it; runHook() strips whatever the test runner itself inherited.
function harness(extraEnv = {}) {
  const fx = makeFixture();
  const env = {
    CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    ...extraEnv,
  };
  let n = 0;
  const SID = 'sess-deleg';
  const base = (tool, sid) => {
    n += 1;
    return {
      session_id: sid,
      transcript_path: join(fx.dir, 'projects', 'repo', `${sid}.jsonl`),
      cwd: fx.dir,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: TOOL_INPUT[tool] || {},
      tool_use_id: `toolu_${String(n).padStart(4, '0')}`,
      effort: { level: 'xhigh' },
    };
  };
  const main = (tool, { sid = SID, env: e = {}, agentType } = {}) => {
    const payload = { ...base(tool, sid), ...(agentType ? { agent_type: agentType } : {}) };
    return result(runHook('hooks/delegation-guard.mjs', payload, { env: { ...env, ...e } }));
  };
  const sub = (tool, { sid = SID, agentType = 'general-purpose', env: e = {} } = {}) => {
    const payload = { ...base(tool, sid), agent_id: 'agent-sub-one', agent_type: agentType };
    return result(runHook('hooks/delegation-guard.mjs', payload, { env: { ...env, ...e } }));
  };
  const post = (tool, { sid = SID, subagent = false, env: e = {} } = {}) => {
    const payload = {
      ...base(tool, sid), hook_event_name: 'PostToolUse',
      tool_response: { status: 'async_launched' },
      ...(subagent ? { agent_id: 'agent-sub-one', agent_type: 'general-purpose' } : {}),
    };
    return result(runHook('hooks/delegation-guard.mjs', payload, { env: { ...env, ...e }, args: ['--event', 'reset'] }));
  };
  const streakFile = join(fx.stateDir, 'state', 'delegation-streak.json');
  const streaks = () => { try { return JSON.parse(readFileSync(streakFile, 'utf8')); } catch { return null; } };
  const denials = () => readJsonl(join(fx.stateDir, 'telemetry', 'denials.jsonl'));
  return { ...fx, env, main, sub, post, streaks, streakFile, denials, SID };
}

function result(res) {
  assert.equal(res.status, 0, res.stderr);
  return {
    raw: res.stdout.trim(),
    decision: res.json?.hookSpecificOutput?.permissionDecision ?? null,
    reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '',
    context: res.json?.hookSpecificOutput?.additionalContext || '',
  };
}

const BLOCK = { CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'block' };

// --- the shared detection ----------------------------------------------------

test('callerIsSubagent / isMainThread: agent_id decides, agent_type does not', () => {
  assert.equal(isMainThread({ session_id: 's', tool_name: 'Bash' }), true, 'real main-thread shape');
  assert.equal(isMainThread({ session_id: 's', agent_type: 'my-agent' }), true, '--agent main thread');
  assert.equal(isMainThread({ session_id: 's', agent_id: 'a1', agent_type: 'general-purpose' }), false, 'subagent');
  assert.equal(isMainThread({ session_id: 's', agent_id: 'a1' }), false, 'subagent without a type');
  assert.equal(isMainThread({}), false, 'unparsed payload is never main');
  assert.equal(isMainThread({ tool_name: 'Bash' }), false, 'no session_id is never main');
  assert.equal(isMainThread(null), false);
  assert.equal(callerIsSubagent({ agent_id: 'a1' }), true);
  assert.equal(callerIsSubagent({ agent_type: 'main' }), false);
  assert.equal(callerIsSubagent(undefined), false);
});

test('spawn-guard and runaway-notice use the shared helper, not a variant of their own', () => {
  for (const f of ['hooks/spawn-guard.mjs', 'hooks/runaway-notice.mjs', 'hooks/delegation-guard.mjs']) {
    const src = readFileSync(join(PLUGIN_ROOT, f), 'utf8');
    assert.doesNotMatch(src, /!!\s*p\.agent_id|if\s*\(\s*p\.agent_id\s*\)/, `${f} re-implements the main-thread test`);
    assert.doesNotMatch(src, /agent_type\s*===\s*'main'/, `${f} tests agent_type for the main thread`);
  }
});

// --- counting on real shapes ----------------------------------------------------

test('block: a real main-thread payload is counted and the call reaching the threshold is denied', () => {
  const h = harness(BLOCK);
  try {
    for (const tool of ['Read', 'Grep', 'Bash']) {
      const r = h.main(tool);
      assert.equal(r.raw, '', `${tool}: a call under the threshold gets no output at all (no "allow" that would skip the permission prompt)`);
    }
    assert.equal(h.streaks()[h.SID].streak, 3);
    const r = h.main('Edit');
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /threshold is 4/);
    assert.match(r.reason, /Edit call was NOT run/);
    assert.deepEqual(h.denials().map((d) => [d.guard, d.outcome, d.tool_name]), [['delegation', 'deny', 'Edit']]);
    assert.equal(h.streaks()[h.SID].fired, 1);
  } finally { h.cleanup(); }
});

test('block: the escape hatch — the denied call, repeated, runs', () => {
  const h = harness(BLOCK);
  try {
    for (let i = 0; i < 3; i += 1) h.main('Bash');
    assert.equal(h.main('Bash').decision, 'deny');
    assert.equal(h.main('Bash').raw, '', 'the repeat passes');
    assert.equal(h.streaks()[h.SID].streak, 1, 'the repeat opens a new streak');
  } finally { h.cleanup(); }
});

test('a subagent\'s calls are never counted or blocked, even under the lead\'s session_id', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    for (const tool of EXECUTION_TOOLS) {
      for (const agentType of ['general-purpose', 'agent-companion:ac-opus-low', 'Explore']) {
        assert.equal(h.sub(tool, { agentType }).raw, '', `${agentType} ${tool}`);
      }
    }
    assert.equal(h.streaks(), null, 'no state written for subagent calls');
    assert.deepEqual(h.denials(), []);

    // Interleaved with the lead in the same session: only the lead's calls count.
    assert.equal(h.main('Read').raw, '');
    for (let i = 0; i < 5; i += 1) assert.equal(h.sub('Bash').raw, '');
    assert.equal(h.streaks()[h.SID].streak, 1);
    assert.equal(h.main('Read').decision, 'deny', 'the lead\'s second call reaches threshold 2');
  } finally { h.cleanup(); }
});

test('an --agent session\'s main thread (agent_type, no agent_id) is the main thread', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    assert.equal(h.main('Read', { agentType: 'my-lead' }).raw, '');
    assert.equal(h.main('Read', { agentType: 'my-lead' }).decision, 'deny');
  } finally { h.cleanup(); }
});

test('a payload that did not parse, or has no session_id, is never counted', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = runHook('hooks/delegation-guard.mjs', { tool_name: 'Bash', hook_event_name: 'PreToolUse' }, { env: h.env });
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), '');
    }
    assert.equal(h.streaks(), null);
  } finally { h.cleanup(); }
});

// --- modes -------------------------------------------------------------------

test('warn is the shipped default: the guard does not stop the call, the model is told, the firing is recorded as warn', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.delegation_guard.default, 'warn');
  assert.equal(manifest.userConfig.delegation_guard.type, 'string');
  assert.equal(manifest.userConfig.delegation_threshold.default, 4);

  const h = harness();
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(h.main('Bash').raw, '');
    const r = h.main('Bash');
    assert.equal(r.decision, null, 'warn never decides: the normal permission flow applies');
    assert.match(r.context, /delegation_guard: warn/);
    assert.match(r.context, /threshold is 4/);
    assert.match(r.context, /This guard did not stop the call\./);
    assert.doesNotMatch(r.context, /The call ran/, 'at PreToolUse the call has not run: the prompt, another hook or the operator can still stop it');
    assert.deepEqual(h.denials().map((d) => [d.guard, d.outcome]), [['delegation', 'warn']]);
    assert.equal(h.streaks()[h.SID].fired, 1, 'fired feeds the standing-rules delegation-drift gate');
  } finally { h.cleanup(); }
});

test('off counts nothing; legacy booleans map to warn/off; unknown values fall to warn', () => {
  const h = harness({ CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'off' });
  try {
    for (let i = 0; i < 6; i += 1) assert.equal(h.main('Bash').raw, '');
    assert.equal(h.streaks(), null);
  } finally { h.cleanup(); }
  assert.equal(delegationMode('true'), 'warn');
  assert.equal(delegationMode(true), 'warn');
  assert.equal(delegationMode('false'), 'off');
  assert.equal(delegationMode('0'), 'off');
  for (const v of ['none', 'None', 'disabled', 'DISABLE', ' no ']) assert.equal(delegationMode(v), 'off', v);
  assert.equal(delegationMode('BLOCK'), 'block');
  assert.equal(delegationMode('blok'), 'warn');
  assert.equal(delegationMode(undefined), 'warn');
  assert.equal(delegationThreshold('1'), 2, 'minimum 2');
  assert.equal(delegationThreshold('nope'), 4);
  assert.equal(delegationThreshold('6'), 6);
});

test('countCall: fires at the threshold and restarts the streak', () => {
  assert.deepEqual(countCall(0, 4), { streak: 1, fires: false, next: 1 });
  assert.deepEqual(countCall(3, 4), { streak: 4, fires: true, next: 0 });
  assert.deepEqual(countCall(undefined, 2), { streak: 1, fires: false, next: 1 });
});

// --- what resets it, and what is never blocked --------------------------------

test('an Agent spawn or SendMessage that ran resets the lead\'s streak; a subagent\'s does not', () => {
  const h = harness(BLOCK);
  try {
    for (const resetTool of RESET_TOOLS) {
      for (let i = 0; i < 3; i += 1) assert.equal(h.main('Read').raw, '');
      assert.equal(h.post(resetTool).raw, '');
      assert.equal(h.streaks()[h.SID].streak, 0, `${resetTool} resets`);
    }
    for (let i = 0; i < 3; i += 1) h.main('Read');
    h.post('Agent', { subagent: true });
    assert.equal(h.streaks()[h.SID].streak, 3, 'a subagent spawning its own worker is not the lead delegating');
    // A PreToolUse on Agent (a spawn not yet run, maybe about to be denied) resets nothing.
    const pre = runHook('hooks/delegation-guard.mjs', {
      session_id: h.SID, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' },
    }, { env: h.env });
    assert.equal(pre.stdout.trim(), '');
    assert.equal(h.streaks()[h.SID].streak, 3);
    assert.equal(h.main('Read').decision, 'deny');
  } finally { h.cleanup(); }
});

test('never blocked: delegation, messaging, tool discovery, operator questions, task and bus tools', () => {
  const NEVER = [
    'Agent', 'SendMessage', 'ToolSearch', 'AskUserQuestion', 'TaskStop', 'TaskOutput', 'TodoWrite',
    'ScheduleWakeup', 'Monitor', 'Skill', 'WebFetch', 'WebSearch',
    'mcp__plugin_coordbus_agent-bus__agent_inbox', 'mcp__plugin_coordbus_agent-bus__task_upsert',
    // A claude.ai connector serves the same tools under a per-connector UUID prefix.
    'mcp__00000000-0000-4000-8000-000000000000__agent_send', 'mcp__00000000-0000-4000-8000-000000000000__agent_inbox_wait',
  ];
  // 1. The hook is never even invoked for them: hooks.json's matcher is exactly EXECUTION_TOOLS.
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entries = hooks.PreToolUse.filter((e) => e.hooks.some((x) => x.args.some((a) => a.endsWith('/hooks/delegation-guard.mjs'))));
  assert.equal(entries.length, 1);
  const re = new RegExp(entries[0].matcher);
  for (const t of EXECUTION_TOOLS) assert.ok(re.test(t), `matcher misses ${t}`);
  for (const t of NEVER) assert.equal(re.test(t), false, `matcher would send ${t} to the guard`);
  const post = hooks.PostToolUse.filter((e) => e.hooks.some((x) => x.args.some((a) => a.endsWith('/hooks/delegation-guard.mjs'))));
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].hooks[0].args.slice(1), ['--event', 'reset']);
  for (const t of RESET_TOOLS) assert.ok(new RegExp(post[0].matcher).test(t), `reset matcher misses ${t}`);

  // 2. Even if a hand-edited matcher did send them, the guard itself does not count them.
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    h.main('Bash');
    for (const t of NEVER) assert.equal(h.main(t).raw, '', `${t} must pass untouched`);
    assert.equal(h.streaks()[h.SID].streak, 1, 'none of them advanced the streak');
  } finally { h.cleanup(); }
});

// --- the deny text, and the spawn it points at --------------------------------

test('the deny names the next step (Agent + a ladder rung + TYPE, backgrounded), the threshold, and the escape hatch', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '3' });
  try {
    h.main('Grep'); h.main('Read');
    const r = h.main('Bash');
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /execution-class call 3 in a row/);
    assert.match(r.reason, /threshold is 3 \(delegation_threshold\)/);
    assert.match(r.reason, /Agent tool/);
    assert.match(r.reason, /subagent_type: "agent-companion:ac-[a-z]+(-[a-z]+)?"/);
    assert.match(r.reason, /run_in_background: true/);
    assert.ok(r.reason.includes('prompt: "TYPE: <task type>\\n<brief>"'), r.reason);
    assert.match(r.reason, /Rungs now: agent-companion:ac-[a-z]+(-[a-z]+)? for explore/);
    assert.match(r.reason, /repeat it\. The count has been reset, so it will run/);
    assert.match(r.reason, /inherit_guard: block refuses/);
  } finally { h.cleanup(); }
});

test('the deny names the browser variants for UI work, since the numbered rungs have no browser', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    h.main('Read');
    const r = h.main('Read');
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /UI or browser work: agent-companion:ac-browser or agent-companion:ac-browser-opus \(the rungs have no browser\)/);
  } finally { h.cleanup(); }
});

test('the deny example rung is the rung the routing table gives subagent-worker (no hard-coded opus/low)', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    h.main('Read');
    const reason = h.main('Read').reason;
    const example = /subagent_type: "([^"]+)"/.exec(reason)?.[1];
    const routed = runScript('scripts/recommend.mjs', ['--type', 'subagent-worker', '--json'], { cwd: h.dir });
    assert.equal(routed.status, 0, routed.stderr);
    assert.equal(example, routed.json.spawnAgentNamespaced, 'example must be the rung recommend.mjs names for subagent-worker');
    // The base table sends subagent-worker to sonnet/low, so the old hard-coded
    // opus/low rung must not be what the example says, and haiku (which
    // validates, it does not operate) must not be either.
    assert.notEqual(example, 'agent-companion:ac-haiku');
    assert.notEqual(example, 'agent-companion:ac-opus-low');
    // and each type the message groups sits under its own current rung
    const rungsLine = /Rungs now: (.*?). Other types/s.exec(reason)?.[1] || '';
    const groups = new Map(rungsLine.split('; ').map((g) => {
      const [rung, types] = g.split(' for ');
      return [rung, (types || '').split(', ')];
    }));
    for (const type of ['explore', 'mechanical-edit', 'verify', 'bounded-feature', 'debug-root-cause']) {
      const rr = runScript('scripts/recommend.mjs', ['--type', type, '--json'], { cwd: h.dir });
      assert.ok((groups.get(rr.json.spawnAgentNamespaced) || []).includes(type), `${type} -> ${rr.json.spawnAgentNamespaced} in: ${rungsLine}`);
    }
  } finally { h.cleanup(); }
});

test('the rung the deny names passes the spawn guard with inherit_guard AND foreground_guard at block, from an opus lead', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    h.main('Read');
    const reason = h.main('Read').reason;
    const rung = /subagent_type: "([^"]+)"/.exec(reason)?.[1];
    assert.ok(rung, reason);

    const lead = join(h.dir, 'lead.jsonl');
    writeFileSync(lead, `${JSON.stringify({
      type: 'assistant', effort: 'xhigh', timestamp: '2026-09-27T10:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] },
    })}\n`);
    const env = {
      ...h.env,
      CLAUDE_PLUGIN_OPTION_INHERIT_GUARD: 'block',
      CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block',
    };
    const spawnAs = (toolInput) => {
      const res = runHook('hooks/spawn-guard.mjs', {
        session_id: h.SID, transcript_path: lead, cwd: h.dir, permission_mode: 'default',
        hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_spawn',
        tool_input: { description: 'Find the config reader', ...toolInput },
      }, { env });
      assert.equal(res.status, 0, res.stderr);
      return {
        decision: decisionOf(res.json),
        reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '',
      };
    };
    for (const prompt of ['TYPE: explore\nfind where the config is read', 'find where the config is read']) {
      const ok = spawnAs({ subagent_type: rung, run_in_background: true, prompt });
      assert.equal(ok.decision, 'proceed', `${rung} with ${JSON.stringify(prompt)}: ${ok.reason}`);
    }
    // The shape the deny warns against is the one inherit_guard refuses.
    const bad = spawnAs({ subagent_type: 'general-purpose', run_in_background: true, prompt: 'find where the config is read' });
    assert.equal(bad.decision, 'deny');
    assert.match(bad.reason, /Inherit guard/);
  } finally { h.cleanup(); }
});

// --- concurrency -------------------------------------------------------------

test('parallel calls in one message are counted exactly once each (state lock)', async () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '3' });
  try {
    const one = (i) => new Promise((resolve) => {
      const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'delegation-guard.mjs')], {
        env: childEnv(h.env), windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out.trim()));
      child.stdin.end(JSON.stringify({
        session_id: h.SID, hook_event_name: 'PreToolUse', tool_name: 'Read',
        tool_input: { file_path: `C:/repo/${i}.txt` }, tool_use_id: `toolu_p${i}`,
      }));
    });
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => one(i)));
    const denied = outs.filter((o) => o && JSON.parse(o).hookSpecificOutput?.permissionDecision === 'deny');
    assert.equal(denied.length, 2, `6 calls at threshold 3 fire exactly twice: ${JSON.stringify(outs)}`);
    assert.equal(h.streaks()[h.SID].fired, 2);
  } finally { h.cleanup(); }
});

test('stale sessions are pruned from the streak file', () => {
  const h = harness(BLOCK);
  try {
    h.main('Read');
    const st = h.streaks();
    st['old-session'] = { streak: 2, fired: 1, touched: Date.now() - 8 * 24 * 60 * 60 * 1000 };
    st['legacy-no-stamp'] = { streak: 1, fired: 0 };
    writeFileSync(h.streakFile, JSON.stringify(st));
    h.main('Read');
    const after = h.streaks();
    assert.ok(after[h.SID]);
    assert.equal(after['old-session'], undefined);
    assert.equal(after['legacy-no-stamp'], undefined);
    assert.ok(existsSync(h.streakFile));
  } finally { h.cleanup(); }
});

// --- scope: headless sessions are the delegates ---------------------------------

test('scope "attended" (default): a session whose hooks see CLAUDE_CODE_SESSION_ATTENDED=0 is never counted or blocked', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.delegation_guard_scope.default, 'attended');
  assert.equal(manifest.userConfig.delegation_guard_scope.type, 'string');

  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    const headless = { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } };
    for (const tool of EXECUTION_TOOLS) assert.equal(h.main(tool, headless).raw, '', `${tool} from a -p session`);
    assert.equal(h.post('Agent', headless).raw, '');
    assert.equal(h.streaks(), null, 'nothing written for a headless session');
    assert.deepEqual(h.denials(), []);

    // The attended lead in another session is still counted and blocked.
    assert.equal(h.main('Read', { sid: 'sess-lead' }).raw, '');
    assert.equal(h.main('Read', { sid: 'sess-lead' }).decision, 'deny');
    assert.equal(h.streaks()['sess-lead'].attended, '1', 'what the env said is recorded');
  } finally { h.cleanup(); }
});

test('scope "attended": an ABSENT variable counts (the pre-scope behaviour), and is recorded as "absent"', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2', CLAUDE_CODE_SESSION_ATTENDED: undefined });
  try {
    assert.equal(h.main('Bash').raw, '');
    assert.equal(h.streaks()[h.SID].attended, 'absent');
    assert.equal(h.main('Bash').decision, 'deny');
    assert.match(h.denials()[0].detail, /scope attended, attended absent/);
  } finally { h.cleanup(); }
});

test('scope "all": a headless session is counted and blocked like a lead', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2', CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD_SCOPE: 'all' });
  try {
    const headless = { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } };
    assert.equal(h.main('Bash', headless).raw, '');
    assert.equal(h.streaks()[h.SID].attended, '0');
    assert.equal(h.main('Bash', headless).decision, 'deny');
  } finally { h.cleanup(); }
  assert.equal(delegationScope('ALL'), 'all');
  assert.equal(delegationScope('attended'), 'attended');
  assert.equal(delegationScope('bogus'), 'attended', 'an unknown value keeps the safe default');
  assert.equal(delegationScope(undefined), 'attended');
  assert.equal(outOfScope('attended', { CLAUDE_CODE_SESSION_ATTENDED: '0' }), true);
  assert.equal(outOfScope('attended', { CLAUDE_CODE_SESSION_ATTENDED: '1' }), false);
  assert.equal(outOfScope('attended', {}), false, 'absent is in scope');
  assert.equal(outOfScope('attended', { CLAUDE_CODE_SESSION_ATTENDED: 'false' }), false, 'only exactly "0" is headless');
  assert.equal(outOfScope('all', { CLAUDE_CODE_SESSION_ATTENDED: '0' }), false);
});

test('a tool call served to a remote caller (session_id "served:...") is never counted', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2' });
  try {
    for (const sid of ['served:caller-session', 'served:unknown']) {
      for (let i = 0; i < 3; i += 1) assert.equal(h.main('Bash', { sid }).raw, '', sid);
    }
    assert.equal(h.streaks(), null);
    assert.equal(isServedCall({ session_id: 'served:x' }), true);
    assert.equal(isServedCall({ session_id: 'sess-served' }), false);
    assert.equal(isServedCall({}), false);
  } finally { h.cleanup(); }
});

test('attendedCoverage (the attended_env_missing signal): only recent entries that recorded a value count', () => {
  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  assert.deepEqual(attendedCoverage({
    a: { touched: now, attended: 'absent' },
    b: { touched: now, attended: '1' },
    c: { touched: now - 2 * 24 * 60 * 60 * 1000, attended: '1' }, // too old
    d: { touched: now }, // written before the field existed
  }, since), { recorded: 2, seen: 1 });
  assert.deepEqual(attendedCoverage(null, since), { recorded: 0, seen: 0 });
});

test('detect.mjs raises attended_env_missing when a day of counted calls never saw the variable', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sd = join(stateDir, 'state');
    mkdirSync(sd, { recursive: true });
    const f = join(sd, 'delegation-streak.json');
    const now = Date.now();
    const signal = () => {
      const res = runScript('scripts/detect.mjs', [], { cwd: dir });
      assert.equal(res.status, 0, res.stderr);
      return res.json.signals.find((s) => s.kind === 'attended_env_missing');
    };
    writeFileSync(f, JSON.stringify({ s1: { streak: 1, fired: 0, touched: now, attended: 'absent' }, s2: { streak: 2, fired: 0, touched: now, attended: 'absent' } }));
    const s = signal();
    assert.ok(s, 'fires');
    assert.equal(s.dispatch, 'harness-surface-diff');
    assert.match(s.detail, /2 session\(s\)/);
    writeFileSync(f, JSON.stringify({ s1: { streak: 1, fired: 0, touched: now, attended: 'absent' }, s2: { streak: 1, fired: 0, touched: now, attended: '1' } }));
    assert.equal(signal(), undefined, 'one session saw it: the harness still sets it');
    writeFileSync(f, JSON.stringify({ s1: { streak: 1, fired: 0, touched: now } }));
    assert.equal(signal(), undefined, 'entries from before the field existed say nothing');
  } finally { cleanup(); }
});

// --- the spawn guard no longer touches the streak --------------------------------

function opusLead(dir) {
  const lead = join(dir, 'lead-opus.jsonl');
  writeFileSync(lead, `${JSON.stringify({
    type: 'assistant', effort: 'xhigh', timestamp: '2026-09-27T10:00:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }] },
  })}\n`);
  return lead;
}

test('repro A: a SUBAGENT\'s Agent spawn (agent_id, lead\'s session_id) leaves the lead\'s streak alone', () => {
  const h = harness(BLOCK);
  try {
    for (let i = 0; i < 3; i += 1) h.main('Read');
    assert.equal(h.streaks()[h.SID].streak, 3);
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: h.SID, agent_id: 'sub-1', agent_type: 'general-purpose', transcript_path: opusLead(h.dir), cwd: h.dir,
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_sub_spawn',
      tool_input: { subagent_type: 'agent-companion:ac-opus-low', description: 'x', prompt: 'TYPE: explore\nlook' },
    }, { env: h.env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(h.streaks()[h.SID].streak, 3, 'the spawn guard wrote nothing to the streak');
    assert.equal(h.main('Read').decision, 'deny', 'the lead\'s 4th call still fires');
  } finally { h.cleanup(); }
});

test('repro B: a lead spawn the spawn guard DENIES (inherit_guard: block) leaves the streak alone', () => {
  const h = harness({ ...BLOCK, CLAUDE_PLUGIN_OPTION_INHERIT_GUARD: 'block' });
  try {
    for (let i = 0; i < 3; i += 1) h.main('Read');
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: h.SID, transcript_path: opusLead(h.dir), cwd: h.dir, permission_mode: 'default',
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_denied_spawn',
      tool_input: { subagent_type: 'general-purpose', run_in_background: true, description: 'x', prompt: 'find where the config is read' },
    }, { env: h.env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(decisionOf(res.json), 'deny', JSON.stringify(res.json));
    assert.equal(h.streaks()[h.SID].streak, 3, 'a denied spawn is not delegation');
    assert.equal(h.main('Read').decision, 'deny');
  } finally { h.cleanup(); }
});

// --- a stuck lock ------------------------------------------------------------------

test('a stuck streak lock (live pid, an hour old) is broken at once, not waited on by every call', () => {
  const h = harness(BLOCK);
  try {
    mkdirSync(join(h.stateDir, 'state'), { recursive: true });
    const lock = `${h.streakFile}.lock`;
    // A live pid (this test process), as when a killed hook's pid is reused.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'stuck-holder', at: Date.now() - 60 * 60 * 1000 }));
    const t0 = Date.now();
    assert.equal(h.main('Read').raw, '');
    const ms = Date.now() - t0;
    assert.equal(existsSync(lock), false, 'the stuck lock was broken (and the new holder released its own)');
    assert.equal(h.streaks()[h.SID].streak, 1);
    // The old code waited the full 2 s on every call and never cleared it.
    assert.ok(ms < 2000, `took ${ms} ms`);
    const t1 = Date.now();
    h.main('Read');
    assert.ok(Date.now() - t1 < 2000, 'the next call does not wait either');
  } finally { h.cleanup(); }
});

test('file-lock maxAgeMs: a live owner\'s lock is broken once older than maxAgeMs, never before', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const lock = join(dir, 'x.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'old-live', at: Date.now() - (LOCK_MAX_AGE_MS + 1000) }));
    assert.equal(acquireLock(lock, { waitMs: 50, staleMs: 1000 }), null, 'without maxAgeMs a live owner\'s lock stands');
    const got = acquireLock(lock, { waitMs: 50, staleMs: 1000, maxAgeMs: LOCK_MAX_AGE_MS });
    assert.ok(got, 'with maxAgeMs it is broken');
    releaseLock(got);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'young-live', at: Date.now() }));
    assert.equal(acquireLock(lock, { waitMs: 50, staleMs: 1000, maxAgeMs: LOCK_MAX_AGE_MS }), null, 'a young live lock is never broken');
  } finally { cleanup(); }
});
