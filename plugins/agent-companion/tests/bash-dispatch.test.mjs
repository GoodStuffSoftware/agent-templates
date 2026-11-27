// hooks/bash-dispatch.mjs (0.31.79): one PreToolUse entry for Bash and PowerShell instead of six node processes.
// Covers: the hooks.json wiring (nothing dropped, nothing run twice), the output merge, equivalence with the separate hooks on a fixture
// set of Bash and PowerShell calls, isolation (a check that throws, exits badly or hangs costs only itself) and ordering.
// Invented data only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { CHECKS, mergeResults, dispatch } from '../hooks/bash-dispatch.mjs';

const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
const key = (script, args = []) => [script.replace(/^.*[\\/]/, ''), ...args].join(' ');

// What hooks.json starts on PreToolUse for one tool name, as "script args" strings, a dispatcher entry expanded to its checks.
function startedFor(tool) {
  const out = [];
  for (const e of hooksJson.PreToolUse) {
    if (e.matcher !== undefined && !new RegExp(e.matcher).test(tool)) continue;
    for (const h of e.hooks) {
      const [script, ...args] = h.args;
      if (script.endsWith('/hooks/bash-dispatch.mjs')) for (const c of CHECKS) out.push(key(c.script, c.args));
      else out.push(key(script, args));
    }
  }
  return out;
}

// ------------------------------------------------------------------ wiring --

test('wiring: Bash and PowerShell start the same six checks as the six separate entries did, once each', () => {
  const BEFORE_SHELL = ['delegation-guard.mjs', 'bash-tail.mjs', 'hold-message.mjs --event pre', 'bash-read.mjs', 'poll-guard.mjs', 'subagent-context.mjs'];
  for (const tool of ['Bash', 'PowerShell']) {
    const got = startedFor(tool);
    assert.deepEqual([...got].sort(), [...BEFORE_SHELL].sort(), `${tool}: ${got.join(', ')}`);
  }
});

test('wiring: the dispatcher is the only PreToolUse hook a shell call starts', () => {
  for (const tool of ['Bash', 'PowerShell']) {
    const hooks = hooksJson.PreToolUse.filter((e) => e.matcher === undefined || new RegExp(e.matcher).test(tool)).flatMap((e) => e.hooks);
    const scripts = hooks.map((h) => h.args[0].replace(/^.*[\\/]/, ''));
    assert.ok(scripts.includes('bash-dispatch.mjs'), tool);
    for (const gone of ['delegation-guard.mjs', 'bash-tail.mjs', 'hold-message.mjs', 'bash-read.mjs', 'poll-guard.mjs', 'subagent-context.mjs']) {
      assert.ok(!scripts.includes(gone), `${tool} still starts ${gone} on its own`);
    }
  }
});

test('wiring: every other tool keeps the hooks it had', () => {
  assert.deepEqual(startedFor('ScheduleWakeup').filter((x) => x.startsWith('poll-guard')), ['poll-guard.mjs']);
  assert.deepEqual(startedFor('Monitor').filter((x) => x.startsWith('poll-guard')), ['poll-guard.mjs']);
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob']) assert.ok(startedFor(t).includes('delegation-guard.mjs'), t);
  for (const t of ['Edit', 'Read', 'Agent', 'SendMessage', 'ScheduleWakeup', 'Monitor', 'mcp__x__y', 'WebFetch', 'TaskStop']) {
    assert.equal(startedFor(t).filter((x) => x === 'subagent-context.mjs').length, 1, `${t}: subagent-context once`);
  }
  for (const t of ['Edit', 'Read', 'Grep', 'Agent', 'ScheduleWakeup']) {
    for (const shellOnly of ['bash-tail.mjs', 'bash-read.mjs', 'hold-message.mjs --event pre']) assert.ok(!startedFor(t).includes(shellOnly), `${t} must not start ${shellOnly}`);
  }
});

test('wiring: CHECKS order and timeouts are the old entries\' (delegation-guard, bash-tail, hold-message, bash-read, poll-guard, subagent-context)', () => {
  assert.deepEqual(CHECKS.map((c) => [c.script, c.args.join(' '), c.timeoutMs]), [
    ['delegation-guard.mjs', '', 10000], ['bash-tail.mjs', '', 10000], ['hold-message.mjs', '--event pre', 5000],
    ['bash-read.mjs', '', 10000], ['poll-guard.mjs', '', 10000], ['subagent-context.mjs', '', 5000],
  ]);
  const entry = hooksJson.PreToolUse.find((e) => e.hooks.some((h) => h.args[0].endsWith('/hooks/bash-dispatch.mjs')));
  assert.equal(entry.matcher, '^(Bash|PowerShell)$');
  assert.ok(entry.hooks[0].timeout * 1000 > Math.max(...CHECKS.map((c) => c.timeoutMs)), 'the entry outlasts its longest check');
});

test('fallback: the README snippet restores the separate entries, one per check, with the old timeouts', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const at = readme.indexOf('Bash hook dispatcher');
  assert.ok(at >= 0, 'README documents the dispatcher');
  const m = /```json\n([\s\S]*?)\n```/.exec(readme.slice(at));
  assert.ok(m, 'README carries the fallback snippet');
  const entries = JSON.parse(m[1]);
  const flat = entries.flatMap((e) => e.hooks.map((h) => ({ matcher: e.matcher, script: h.args[0].replace(/^.*[\\/]/, ''), args: h.args.slice(1), timeout: h.timeout })));
  for (const c of CHECKS) {
    const f = flat.find((x) => x.script === c.script && x.args.join(' ') === c.args.join(' '));
    assert.ok(f, `snippet lacks ${c.script}`);
    assert.equal(f.timeout * 1000, c.timeoutMs, `${c.script} timeout`);
    assert.ok(new RegExp(f.matcher ?? '').test('Bash') && new RegExp(f.matcher ?? '').test('PowerShell'), `${c.script} must cover Bash and PowerShell`);
  }
  assert.equal(flat.length, CHECKS.length);
});

// ------------------------------------------------------------------ merging --

const ok = (name, stdout, extra = {}) => ({ name, status: 'ok', code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', ...extra });
const pre = (o) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } });

test('merge: no output at all is no output and exit 0', () => {
  assert.deepEqual(mergeResults([ok('a', ''), ok('b', '')]), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(mergeResults([]), { code: 0, stdout: '', stderr: '' });
});

test('merge: one voice is passed on byte for byte', () => {
  const raw = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no  \\n x"}}';
  assert.equal(mergeResults([ok('a', ''), ok('b', raw), ok('c', '')]).stdout, raw);
});

test('merge: deny beats defer beats ask beats allow, whatever the order, and the winner keeps its reason', () => {
  const v = (d, r) => ok(d, pre({ permissionDecision: d, permissionDecisionReason: r }));
  const all = [v('allow', 'ra'), v('ask', 'rk'), v('defer', 'rf'), v('deny', 'rd')];
  for (const order of [all, [...all].reverse(), [all[2], all[0], all[3], all[1]]]) {
    const j = JSON.parse(mergeResults(order).stdout).hookSpecificOutput;
    assert.equal(j.permissionDecision, 'deny');
    assert.equal(j.permissionDecisionReason, 'rd');
  }
  assert.equal(JSON.parse(mergeResults([v('allow', 'ra'), v('ask', 'rk')]).stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse(mergeResults([v('allow', 'ra'), v('defer', 'rf'), v('ask', 'rk')]).stdout).hookSpecificOutput.permissionDecision, 'defer');
  assert.equal(JSON.parse(mergeResults([v('ask', 'r1'), v('ask', 'r2')]).stdout).hookSpecificOutput.permissionDecisionReason, 'r1');
});

test('merge: two denies keep both reasons, in list order', () => {
  const v = (r) => ok('d', pre({ permissionDecision: 'deny', permissionDecisionReason: r }));
  const j = JSON.parse(mergeResults([v('first reason'), ok('x', pre({ additionalContext: 'note' })), v('second reason')]).stdout).hookSpecificOutput;
  assert.equal(j.permissionDecision, 'deny');
  assert.equal(j.permissionDecisionReason, 'first reason\n\nsecond reason');
  assert.equal(j.additionalContext, 'note');
});

test('merge: additionalContext and systemMessage are joined in list order; hookEventName stays', () => {
  const r = mergeResults([
    ok('a', pre({ additionalContext: 'ctx one' })), ok('b', { systemMessage: 'sys one' }),
    ok('c', pre({ additionalContext: 'ctx two' })), ok('d', { systemMessage: 'sys two' }),
  ]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.additionalContext, 'ctx one\nctx two');
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.systemMessage, 'sys one\nsys two');
  assert.equal(r.code, 0);
});

test('merge: updatedInput is carried and a decision-free voice does not add a decision', () => {
  const upd = { command: 'echo hi', description: 'd' };
  const j = JSON.parse(mergeResults([ok('a', pre({ updatedInput: upd })), ok('b', pre({ additionalContext: 'n' }))]).stdout).hookSpecificOutput;
  assert.deepEqual(j.updatedInput, upd);
  assert.equal('permissionDecision' in j, false);
  assert.equal(j.additionalContext, 'n');
});

test('merge: exit 2 blocks with the stderr reasons; any other non-zero exit, a failure or a timeout contributes nothing', () => {
  const r = mergeResults([
    ok('a', '', { code: 2, stderr: 'stop one\n' }), ok('b', pre({ additionalContext: 'kept' })),
    ok('c', pre({ permissionDecision: 'deny', permissionDecisionReason: 'from a failing hook' }), { code: 1 }),
    { name: 'd', status: 'failed', reason: 'timeout', code: null, stdout: '', stderr: '' }, ok('e', '', { code: 2, stderr: 'stop two' }),
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'stop one\nstop two');
  const j = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(j.additionalContext, 'kept');
  assert.equal('permissionDecision' in j, false, 'a hook that exited 1 has its output ignored');
});

test('merge: output that is not JSON is ignored', () => {
  assert.equal(mergeResults([ok('a', 'plain text'), ok('b', pre({ additionalContext: 'x' }))]).stdout, ok('b', pre({ additionalContext: 'x' })).stdout);
});

// ------------------------------------------------------------------ equivalence --

const SID = 'sess-dispatch-eq';
const base = (tool, command, extra = {}) => ({
  session_id: SID, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: 'call-eq-1', tool_input: { command }, ...extra,
});

// The reference: each check run as its own process, as the separate hooks.json entries ran them, combined the plain way.
function separately(payload, env, cwd) {
  const outs = [];
  for (const c of CHECKS) {
    const r = runHook(`hooks/${c.script}`, payload, { env, cwd, args: c.args });
    outs.push({ name: c.name, status: r.error ? 'failed' : 'ok', code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.json });
  }
  const decisions = outs.map((o) => o.json?.hookSpecificOutput).filter((h) => h && h.permissionDecision);
  const rank = { deny: 0, defer: 1, ask: 2, allow: 3 };
  const best = decisions.length ? decisions.map((h) => h.permissionDecision).sort((a, b) => rank[a] - rank[b])[0] : null;
  return {
    code: outs.some((o) => o.code === 2) ? 2 : 0,
    decision: best,
    denyReasons: decisions.filter((h) => h.permissionDecision === 'deny').map((h) => h.permissionDecisionReason),
    contexts: outs.map((o) => o.json?.hookSpecificOutput?.additionalContext).filter(Boolean),
    messages: outs.map((o) => o.json?.systemMessage).filter(Boolean),
    updated: outs.map((o) => o.json?.hookSpecificOutput?.updatedInput).filter(Boolean),
    voices: outs.filter((o) => o.stdout.trim()).length,
    outs,
  };
}

function viaDispatcher(payload, env, cwd) {
  const r = runHook('hooks/bash-dispatch.mjs', payload, { env, cwd });
  const h = r.json?.hookSpecificOutput;
  return { r, code: r.status, decision: h?.permissionDecision ?? null, h, json: r.json };
}

// Outputs carry per-call noise (a result-log path with a timestamp, a random tag); compare with it masked.
const mask = (s) => String(s).replace(/\d{10,}/g, '<n>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{27}/g, '<uuid>').replace(/(tail|bash-tail)[-_.][\w.-]+/g, '$1-<id>').replace(/ac-bash-tail[\\/][\w.-]+/g, 'ac-bash-tail/<id>').replace(/\b[0-9a-z]{8}-[0-9a-f]{6}\b/g, '<run>').replace(/ac-test-\d+-\w+/g, 'ac-test-<dir>');

function lines(n) { return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'; }

const FIXTURES = [
  { name: 'a plain ls', tool: 'Bash', command: 'ls -la' },
  { name: 'a plain PowerShell listing', tool: 'PowerShell', command: 'Get-ChildItem -Force' },
  { name: 'kill by image name (two checks deny, with different texts)', tool: 'Bash', command: 'taskkill /IM node.exe /F' },
  { name: 'PowerShell kill by name', tool: 'PowerShell', command: 'Stop-Process -Name node -Force' },
  { name: 'a push that deletes a remote branch', tool: 'Bash', command: 'git push origin :old-branch' },
  { name: 'an environment dump', tool: 'Bash', command: 'printenv' },
  { name: 'a full test suite (the resource gate denies)', tool: 'Bash', command: 'npm test', extra: { permission_mode: 'bypassPermissions' } },
  { name: 'a targeted test run (bash-tail rewrites it: an updatedInput)', tool: 'Bash', command: 'node --test tests/x.test.mjs', extra: { permission_mode: 'bypassPermissions' } },
  { name: 'a long sleep', tool: 'Bash', command: 'sleep 120 && echo done' },
  { name: 'a cargo build with a pipe', tool: 'Bash', command: 'cargo build 2>&1 | tail -5' },
  { name: 'a git diff', tool: 'Bash', command: 'git diff' },
  { name: 'a Bash call with an empty command', tool: 'Bash', command: '' },
  {
    name: 'a worker reading 500 lines at once (bash-read denies over the cap)', tool: 'Bash', command: "sed -n '1,500p' big.txt",
    setup: (dir) => writeFileSync(join(dir, 'big.txt'), lines(600)), extra: { agent_id: 'agent-eq-1', agent_type: 'general-purpose' },
  },
  {
    name: 'a worker reading a short range (bash-read allows, no output)', tool: 'Bash', command: "sed -n '1,20p' big.txt",
    setup: (dir) => writeFileSync(join(dir, 'big.txt'), lines(60)), extra: { agent_id: 'agent-eq-2', agent_type: 'general-purpose' },
  },
  {
    name: 'a release hold over every call (hold-message denies)', tool: 'Bash', command: 'ls',
    setup: () => {
      const dir = join(process.env.AGENT_COMPANION_STATE_DIR, 'state');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'release-hold.json'), JSON.stringify({ since: '2026-03-01T12:00:00.000Z', version: '9.9.9', reason: 'test', flags: [{ name: 'guard:demo/deny' }], workers: 'handoff', clearedAt: null }));
    },
    env: { CLAUDE_PLUGIN_OPTION_RELEASE_WATCH_HOLD_SCOPE: 'all' },
  },
  {
    name: 'delegation guard at its threshold (warn adds context)', tool: 'Bash', command: 'ls',
    warm: 1, env: { CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2', CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'warn' },
  },
  {
    name: 'delegation guard at its threshold (block denies), with another check also denying', tool: 'Bash', command: 'taskkill /IM node.exe /F',
    warm: 1, env: { CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PLUGIN_OPTION_DELEGATION_THRESHOLD: '2', CLAUDE_PLUGIN_OPTION_DELEGATION_GUARD: 'block' },
  },
];

for (const fixture of FIXTURES) {
  test(`equivalence: ${fixture.name}`, () => {
    const payload = base(fixture.tool, fixture.command, fixture.extra);
    const run = (fn) => {
      const fx = makeFixture();
      try {
        mkdirSync(join(fx.dir, 'work'), { recursive: true });
        const cwd = join(fx.dir, 'work');
        fixture.setup?.(cwd);
        for (let i = 0; i < (fixture.warm || 0); i += 1) fn({ ...payload, cwd }, fixture.env || {}, cwd); // earlier calls of the same session
        return fn({ ...payload, cwd }, fixture.env || {}, cwd);
      } finally { fx.cleanup(); }
    };
    const ref = run(separately);
    const got = run(viaDispatcher);
    assert.equal(got.code, ref.code, 'exit code');
    assert.equal(got.decision, ref.decision, `decision (separate: ${ref.decision}, dispatcher: ${got.decision})`);
    const h = got.h || {};
    if (ref.decision === 'deny') {
      assert.equal(mask(h.permissionDecisionReason), mask(ref.denyReasons.join('\n\n')), 'every deny reason kept, in order');
    }
    assert.equal(mask(h.additionalContext ?? ''), mask(ref.contexts.join('\n')), 'additionalContext joined');
    assert.equal(mask(got.json?.systemMessage ?? ''), mask(ref.messages.join('\n')), 'systemMessage joined');
    assert.equal(mask(JSON.stringify(h.updatedInput ?? null)), mask(JSON.stringify(ref.updated[0] ?? null)), 'updatedInput');
    if (ref.voices === 0) assert.equal(got.r.stdout.trim(), '', 'no voice: no output');
    if (ref.voices === 1) {
      const only = ref.outs.find((o) => o.stdout.trim());
      assert.equal(mask(got.r.stdout.trim()), mask(only.stdout.trim()), 'one voice: the hook\'s own output');
    }
  });
}

test('equivalence: the fixture set exercises denies, context, an updatedInput and silence', () => {
  // Guards the guard: a fixture set that all passes through would prove nothing about the merge.
  const seen = new Set();
  for (const f of FIXTURES) {
    const fx = makeFixture();
    try {
      mkdirSync(join(fx.dir, 'work'), { recursive: true });
      const cwd = join(fx.dir, 'work');
      f.setup?.(cwd);
      for (let i = 0; i < (f.warm || 0); i += 1) viaDispatcher({ ...base(f.tool, f.command, f.extra), cwd }, f.env || {}, cwd);
      const r = viaDispatcher({ ...base(f.tool, f.command, f.extra), cwd }, f.env || {}, cwd);
      if (r.decision === 'deny') seen.add('deny');
      if (r.h?.additionalContext) seen.add('context');
      if (r.h?.updatedInput) seen.add('updatedInput');
      if (!r.r.stdout.trim()) seen.add('silent');
    } finally { fx.cleanup(); }
  }
  for (const k of ['deny', 'context', 'updatedInput', 'silent']) assert.ok(seen.has(k), `no fixture produced: ${k} (saw ${[...seen].join(', ')})`);
});

// ------------------------------------------------------------------ isolation and ordering --

function checkScripts(fx) {
  const dir = join(fx.dir, 'checks');
  mkdirSync(dir, { recursive: true });
  const w = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const say = (o) => `process.stdout.write(${JSON.stringify(JSON.stringify(o))});`;
  const nap = (ms) => `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});`; // blocks without using CPU
  return {
    ctx: (text, ms = 0) => w(`ctx-${text}.mjs`, `${ms ? nap(ms) : ''}${say(pre({ additionalContext: text }))}`),
    deny: (text, ms = 0) => w(`deny-${text}.mjs`, `${ms ? nap(ms) : ''}${say(pre({ permissionDecision: 'deny', permissionDecisionReason: text }))}`),
    throws: w('throws.mjs', "throw new Error('boom');"),
    exit1: w('exit1.mjs', `${say(pre({ permissionDecision: 'deny', permissionDecisionReason: 'ignored' }))}process.exit(1);`),
    exit2: w('exit2.mjs', "process.stderr.write('blocked by exit 2'); process.exit(2);"),
    syncHang: w('sync-hang.mjs', `${nap(60000)}`),
    asyncHang: w('async-hang.mjs', 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n'),
    readsStdin: w('reads-stdin.mjs', [
      "import { readFileSync } from 'node:fs';",
      "const p = JSON.parse(readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'saw ' + p.tool_input.command } }));",
    ].join('\n')),
    args: w('args.mjs', [
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: process.argv.slice(2).join(',') } }));",
    ].join('\n')),
  };
}
const spec = (name, script, timeoutMs = 3000, args = []) => ({ name, script, args, timeoutMs });

test('isolation: a check that throws, one that exits 1 and one that never answers do not stop the others', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const t0 = Date.now();
    const r = await dispatch('{"tool_name":"Bash","tool_input":{"command":"ls"}}', [
      spec('ctx-a', s.ctx('before')), spec('throws', s.throws), spec('exit1', s.exit1), spec('async-hang', s.asyncHang, 800),
      spec('sync-hang', s.syncHang, 800), spec('deny', s.deny('the guard says no')), spec('ctx-b', s.ctx('after')),
    ]);
    const took = Date.now() - t0;
    assert.ok(took < 5000, `the deadline cut the hang (${took} ms)`);
    const by = Object.fromEntries(r.results.map((x) => [x.name, x]));
    assert.equal(by['sync-hang'].status, 'failed');
    assert.equal(by['sync-hang'].reason, 'timeout', 'a synchronous hang is cut at its own deadline');
    assert.equal(by['async-hang'].status, 'failed');
    assert.equal(by.throws.code, 1);
    assert.equal(by.exit1.code, 1);
    assert.equal(by.deny.status, 'ok');
    const j = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(j.permissionDecision, 'deny');
    assert.equal(j.permissionDecisionReason, 'the guard says no', 'the exit-1 hook\'s deny was ignored, as Claude Code ignores it');
    assert.equal(j.additionalContext, 'before\nafter');
    assert.equal(r.code, 0);
  } finally { fx.cleanup(); }
});

test('isolation: each check has its own deadline - a short one is cut while a longer one still answers', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const r = await dispatch('{}', [spec('short-hang', s.syncHang, 400), spec('slow-but-in-time', s.ctx('late', 700), 3000)]);
    assert.equal(r.results[0].status, 'failed');
    assert.equal(r.results[1].status, 'ok');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'late');
  } finally { fx.cleanup(); }
});

test('isolation: exit 2 from one check blocks with its stderr and the others still count', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const r = await dispatch('{}', [spec('two', s.exit2), spec('ctx', s.ctx('also'))]);
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'blocked by exit 2');
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'also');
  } finally { fx.cleanup(); }
});

test('isolation: the dispatch exits 0 with no output when every check throws, exits badly or hangs', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const r = await dispatch('{}', [spec('throws', s.throws), spec('exit1', s.exit1), spec('hang', s.syncHang, 300), spec('async-hang', s.asyncHang, 300)]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally { fx.cleanup(); }
});

test('isolation: the real entry point on a clean call prints nothing and exits 0', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-dispatch.mjs', { session_id: 'sess-clean', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: fx.dir }, { env: {} });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('ordering: output follows the list order, not the order the checks finish in', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const r = await dispatch('{}', [
      spec('slow', s.ctx('one', 500)), spec('mid', s.deny('d-two', 200)), spec('fast', s.ctx('three')), spec('fast-deny', s.deny('d-four')),
    ]);
    const j = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(j.additionalContext, 'one\nthree');
    assert.equal(j.permissionDecisionReason, 'd-two\n\nd-four');
    assert.deepEqual(r.results.map((x) => x.name), ['slow', 'mid', 'fast', 'fast-deny']);
    const reversed = await dispatch('{}', [spec('fast', s.ctx('three')), spec('slow', s.ctx('one', 300))]);
    assert.equal(JSON.parse(reversed.stdout).hookSpecificOutput.additionalContext, 'three\none');
  } finally { fx.cleanup(); }
});

test('each check gets the original input and its own argv, not the ones another check saw', async () => {
  const fx = makeFixture();
  try {
    const s = checkScripts(fx);
    const r = await dispatch('{"tool_input":{"command":"echo original"}}', [
      spec('a', s.readsStdin), spec('b', s.args, 3000, ['--event', 'pre']), spec('c', s.readsStdin),
    ]);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.equal(ctx, 'saw echo original\n--event,pre\nsaw echo original');
  } finally { fx.cleanup(); }
});

test('running as the hook: a payload on stdin, the merged JSON on stdout, exit 0', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-dispatch.mjs', { ...base('Bash', 'taskkill /IM node.exe /F'), cwd: fx.dir }, { env: {} });
    assert.equal(r.status, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.stderr.trim(), '');
  } finally { fx.cleanup(); }
});
