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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import {
  EXECUTION_TOOLS, RESET_TOOLS, countCall, delegationMode, delegationThreshold,
} from '../hooks/lib/delegation.mjs';
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

function harness(extraEnv = {}) {
  const fx = makeFixture();
  const env = {
    CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'),
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
  const post = (tool, { sid = SID, subagent = false } = {}) => {
    const payload = {
      ...base(tool, sid), hook_event_name: 'PostToolUse',
      tool_response: { status: 'async_launched' },
      ...(subagent ? { agent_id: 'agent-sub-one', agent_type: 'general-purpose' } : {}),
    };
    return result(runHook('hooks/delegation-guard.mjs', payload, { env, args: ['--event', 'reset'] }));
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

test('warn is the shipped default: the call runs, the model is told, the firing is recorded as warn', () => {
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
    assert.match(r.context, /The call ran/);
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
    assert.match(r.reason, /subagent_type: "agent-companion:ac-[a-z]+-[a-z]+"/);
    assert.match(r.reason, /run_in_background: true/);
    assert.ok(r.reason.includes('prompt: "TYPE: <task type>\\n<brief>"'), r.reason);
    assert.match(r.reason, /Rungs now: agent-companion:ac-[a-z]+-[a-z]+ for explore/);
    assert.match(r.reason, /repeat it\. The count has been reset, so it will run/);
    assert.match(r.reason, /inherit_guard: block refuses/);
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
        decision: res.json?.hookSpecificOutput?.permissionDecision,
        reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '',
      };
    };
    for (const prompt of ['TYPE: explore\nfind where the config is read', 'find where the config is read']) {
      const ok = spawnAs({ subagent_type: rung, run_in_background: true, prompt });
      assert.equal(ok.decision, 'allow', `${rung} with ${JSON.stringify(prompt)}: ${ok.reason}`);
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
        env: { ...process.env, ...h.env }, windowsHide: true,
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
