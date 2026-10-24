// Keep-warm for a lead session (hooks/lib/keep-warm.mjs, driven from hooks/advisory-b.mjs) and the lead
// count on the "Shared resources:" line (hooks/lib/resource-line.mjs). Synthetic fixtures only.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { maxPings, isBackgroundSpawn, KEEP_WARM_DELAY_S, KEEP_WARM_MARKER } from '../hooks/lib/keep-warm.mjs';
import {
  activeLeads, renderSharedResources, resourceSignature, sharedResourcesNote, LINE_MAX_CHARS, LEAD_WINDOW_MS,
} from '../hooks/lib/resource-line.mjs';
import { evaluate } from '../hooks/lib/poll-guard.mjs';

const HOOK = 'hooks/advisory-b.mjs';
const SID = 'kw-lead-1';
const run = (event, payload, env) => runHook(HOOK, payload, { args: ['--event', event], env });
const ctx = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const bgSpawn = (extra = {}) => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent',
  tool_input: { name: 'helper', run_in_background: true, prompt: 'x' },
  tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }, ...extra,
});
const startWorker = (id, sid = SID) => run('worker-start', { session_id: sid, agent_id: id, agent_type: 'general-purpose' });
const stopWorker = (id, sid = SID) => run('worker-stop', { session_id: sid, agent_id: id, agent_type: 'general-purpose' });
const ping = (sid = SID, env) => run('user-prompt', { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: KEEP_WARM_MARKER }, env);
const arm = (input = { delaySeconds: KEEP_WARM_DELAY_S, prompt: KEEP_WARM_MARKER, reason: 'keep warm' }, tool = 'ScheduleWakeup') =>
  run('tick', { session_id: SID, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} });

describe('keep-warm', () => {
  test('the cap arithmetic: three pings at the default 180 minutes, none at 0', () => {
    assert.equal(maxPings(180), 3);
    assert.equal(maxPings(110), 2);
    assert.equal(maxPings(0), 0);
    assert.equal(maxPings('x'), 0);
    assert.equal(KEEP_WARM_DELAY_S, 3300, '55 minutes: inside the 1 h cache window');
  });

  test('a background spawn is told to arm ONE wakeup 55 min out; a foreground spawn is not', () => {
    const fx = makeFixture();
    try {
      startWorker('a1');
      const r = run('tick', bgSpawn());
      const c = ctx(r);
      assert.equal(r.status, 0);
      assert.match(c, /Keep-warm: 1 background helper running/);
      assert.match(c, /delaySeconds 3300/);
      assert.match(c, /prompt "keep-warm ping"/);
      assert.match(c, /ONE wakeup/);
      assert.match(c, /never poll/);
      assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
      // The harness' own async acknowledgement alone is enough (no run_in_background in the input).
      const fx2 = makeFixture();
      try {
        const r2 = run('tick', bgSpawn({ session_id: 'kw-other', tool_input: { name: 'h2', prompt: 'x' } }));
        assert.match(ctx(r2), /Keep-warm: 1 background helper running/, 'the ledger row may not exist yet: at least the new helper');
      } finally { fx2.cleanup(); }
    } finally { fx.cleanup(); }
    const fx3 = makeFixture();
    try {
      const fg = run('tick', { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' }, tool_response: { status: 'completed' } });
      assert.equal(ctx(fg), '');
      assert.equal(isBackgroundSpawn({ tool_name: 'Agent', tool_input: { run_in_background: false }, tool_response: { status: 'completed' } }), false);
      assert.equal(isBackgroundSpawn({ tool_name: 'Bash', tool_input: { run_in_background: true } }), false);
    } finally { fx3.cleanup(); }
  });

  test('silent for a subagent caller, with the option off, with the cap at 0, and for a second spawn right after', () => {
    const fx = makeFixture();
    try {
      assert.equal(ctx(run('tick', bgSpawn({ agent_id: 'sub-1' }))), '', 'a subagent is never told');
      assert.equal(ctx(run('tick', bgSpawn(), { CLAUDE_PLUGIN_OPTION_KEEP_WARM: '0' })), '');
      assert.equal(ctx(run('tick', bgSpawn(), { CLAUDE_PLUGIN_OPTION_KEEP_WARM_MAX_MINUTES: '0' })), '');
      assert.match(ctx(run('tick', bgSpawn())), /Keep-warm/);
      assert.equal(ctx(run('tick', bgSpawn())), '', 'a batch of spawns is told once');
    } finally { fx.cleanup(); }
  });

  test('an armed wakeup is recorded: a later spawn is not told again, a call without the marker is not recorded', () => {
    const fx = makeFixture();
    try {
      assert.equal(ctx(arm({ delaySeconds: 1200, prompt: 'check the build' })), '');
      assert.match(ctx(run('tick', bgSpawn())), /Keep-warm/, 'an unrelated wakeup is not a keep-warm one');
      const fx2 = makeFixture();
      try {
        assert.equal(ctx(arm()), '');
        assert.equal(ctx(run('tick', bgSpawn())), '', 'a wakeup is already pending');
        assert.equal(existsSync(join(fx2.stateDir, 'state', 'keep-warm', `${SID}.json`)), true);
      } finally { fx2.cleanup(); }
      const fx3 = makeFixture();
      try {
        assert.equal(ctx(arm({ cron: '5 14 23 10 *', recurring: false, prompt: 'keep-warm ping' }, 'CronCreate')), '');
        assert.equal(ctx(run('tick', bgSpawn())), '', 'a one-shot cron with the marker counts too');
      } finally { fx3.cleanup(); }
    } finally { fx.cleanup(); }
  });

  test('a ping with helpers running re-arms one more, up to the cap of 3 pings, then lets go', () => {
    const fx = makeFixture();
    try {
      startWorker('a1');
      startWorker('a2');
      const p1 = ctx(ping());
      assert.match(p1, /Keep-warm ping 1 of 3: 2 helpers still running/);
      assert.match(p1, /arm ONE more wakeup/);
      assert.match(p1, /delaySeconds 3300/);
      const p2 = ctx(ping());
      assert.match(p2, /ping 2 of 3/);
      assert.match(p2, /arm ONE more wakeup/);
      const p3 = ctx(ping());
      assert.match(p3, /ping 3 of 3/);
      assert.match(p3, /Cap reached/);
      assert.match(p3, /do not re-arm/);
      assert.doesNotMatch(p3, /arm ONE more/);
    } finally { fx.cleanup(); }
  });

  test('a ping with no helpers running says do not re-arm: no pings when nothing is running', () => {
    const fx = makeFixture();
    try {
      startWorker('a1');
      stopWorker('a1');
      const c = ctx(ping());
      assert.match(c, /no helpers running/);
      assert.match(c, /do not re-arm/);
      assert.doesNotMatch(c, /arm ONE more/);
      // A helper that stops between two pings ends the chain at the next one.
      startWorker('b1');
      assert.match(ctx(ping()), /ping 1 of 3/);
      stopWorker('b1');
      assert.match(ctx(ping()), /no helpers running/);
    } finally { fx.cleanup(); }
  });

  test('a new background spawn starts the count over; other prompts are ignored', () => {
    const fx = makeFixture();
    try {
      startWorker('a1');
      ping(); ping();
      assert.match(ctx(run('tick', bgSpawn())), /Keep-warm/); // pings reset (the 5-minute dedupe only applies to the note)
      assert.match(ctx(ping()), /ping 1 of 3/);
      assert.equal(ctx(run('user-prompt', { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'carry on' })), '');
      assert.equal(ctx(run('user-prompt', { session_id: SID, hook_event_name: 'UserPromptSubmit' })), '');
    } finally { fx.cleanup(); }
  });

  test('the ping prompt is never read as a poll by the poll guard', () => {
    const wake = (n, extra = {}) => ({
      type: 'assistant', timestamp: new Date(Date.now() - n * 60000).toISOString(),
      message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: KEEP_WARM_DELAY_S, prompt: KEEP_WARM_MARKER, noop: true, ...extra } }] },
    });
    const launch = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { name: 'h', run_in_background: true } }] } };
    // Three no-op wakes already on record and a background helper still outstanding: the worst case for the guard.
    const records = [launch, wake(165), wake(110), wake(55)];
    assert.equal(evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: KEEP_WARM_DELAY_S, prompt: KEEP_WARM_MARKER, noop: true }, records }), null);
    // The same wake at a short delay is what the guard exists to catch (control).
    assert.ok(evaluate({ toolName: 'ScheduleWakeup', input: { delaySeconds: 270, noop: true }, records: [launch, wake(3, { delaySeconds: 270 }), wake(2, { delaySeconds: 270 }), wake(1, { delaySeconds: 270 })] }));
  });

  test('cost: three pings at 55-minute spacing stay under the cold rebuild they prevent (sim numbers, 200K context)', () => {
    // r-keepwarm-sim-1017: one-shot ping 0.1287 u and rebuild premium 1.14 u at 200K on opus; 0.43 / 3.8 on fable.
    for (const [ping1, rebuild] of [[0.1287, 1.14], [0.429, 3.8], [0.0687, 0.57]]) {
      assert.ok(maxPings(180) * ping1 < rebuild, `${maxPings(180)} pings (${(maxPings(180) * ping1).toFixed(2)} u) vs ${rebuild} u`);
    }
  });
});

describe('lead count', () => {
  const iso = (ms) => new Date(ms).toISOString();
  function ledger(dir, sid, rows, mtimeMs) {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${sid}.jsonl`);
    writeFileSync(f, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
    if (mtimeMs) utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
    return f;
  }
  const idle = { ok: true, resources: [], queue: [], reservations: [], recentClears: [] };

  test('activeLeads counts sessions with a helper start in the last hour, from the per-session ledger', () => {
    const base = mkdtempSync(join(tmpdir(), 'kw-leads-'));
    const now = Date.now();
    try {
      ledger(base, 's-a', [{ at: iso(now - 5 * 60000), ev: 'start', agent_id: 'x' }]);
      ledger(base, 's-b', [{ at: iso(now - 59 * 60000), ev: 'start', agent_id: 'x' }, { at: iso(now - 58 * 60000), ev: 'stop', agent_id: 'x' }]);
      ledger(base, 's-c', [{ at: iso(now - 61 * 60000), ev: 'start', agent_id: 'x' }], now - 5 * 60000); // started over an hour ago, file touched since
      ledger(base, 's-d', [{ at: iso(now - 90 * 60000), ev: 'start', agent_id: 'x' }], now - 90 * 60000); // idle for 90 minutes
      ledger(base, 's-e', [{ at: iso(now - 4 * 60000), ev: 'stop', agent_id: 'x' }]); // a stop is not a spawn
      ledger(base, 's-f', ['not json {', { at: iso(now - 2 * 60000), ev: 'start', agent_id: 'y' }]); // a torn row does not hide a good one
      writeFileSync(join(base, 'README.txt'), 'not a ledger');
      assert.equal(activeLeads({ now, dir: base }), 3, 'a, b and f');
      assert.equal(activeLeads({ now: now + 10 * 60000, dir: base }), 2, 'ten minutes on, b has aged out');
      assert.equal(activeLeads({ now, dir: join(base, 'missing') }), 0);
      assert.equal(LEAD_WINDOW_MS, 3600000);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('the line shows the count from two leads and warns above four; one lead shows nothing', () => {
    assert.equal(renderSharedResources(idle, { leads: 0 }), null);
    assert.equal(renderSharedResources(idle, { leads: 1 }), null);
    const three = renderSharedResources(idle, { leads: 3 });
    assert.match(three, /^Shared resources: leads active \(helper spawn in the last hour\): 3\.$/);
    const four = renderSharedResources(idle, { leads: 4 });
    assert.doesNotMatch(four, /More than 4/);
    const five = renderSharedResources(idle, { leads: 5 });
    assert.match(five, /leads active \(helper spawn in the last hour\): 5\./);
    assert.match(five, /More than 4 leads active: each extra lead adds cold re-reads/);
    assert.ok(five.length <= LINE_MAX_CHARS);
  });

  test('the count joins a busy queue line, and a crowded line keeps the warning and the release hint within 300 characters', () => {
    const holders = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, label: `long-holder-label-${i}`, project: 'a-long-project', ageMs: 5000, overTime: i === 0 ? { activity: 'idle' } : null }));
    const st = {
      ok: true,
      resources: [{ name: 'box', capacity: 16, held: 12, holders }],
      queue: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, label: `waiter-with-long-name-${i}`, project: 'proj', waitedMs: 1000, blockedBy: ['box'] })),
      reservations: [], recentClears: [],
    };
    const line = renderSharedResources(st, { now: Date.now(), leads: 7 });
    assert.ok(line.length <= LINE_MAX_CHARS, `${line.length}`);
    assert.match(line, /More than 4 leads active/);
    assert.match(line, /release a flagged one by hand: .* release h0\.$/);
    const small = renderSharedResources({ ...st, resources: [{ name: 'box', capacity: 8, held: 1, holders: [{ id: 'z', label: 'one', ageMs: 1000 }] }], queue: [] }, { now: Date.now(), leads: 3 });
    assert.match(small, /box 1\/8: one 1s; leads active \(helper spawn in the last hour\): 3\.$/);
  });

  test('the prompt-time line comes back only when the count crosses a level, not on every change of count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kw-sig-'));
    const sigFile = join(dir, 'sig');
    const note = (leads) => sharedResourcesNote({ session_id: 's1' }, { mode: 'change', status: idle, sigFile, leads });
    try {
      assert.equal(await note(1), null);
      assert.match(await note(2), /leads active .*: 2\./);
      assert.equal(await note(3), null, 'still a few');
      assert.equal(await note(4), null);
      assert.match(await note(5), /More than 4 leads active/);
      assert.equal(await note(9), null, 'still over the warning level');
      const back = await note(2);
      assert.match(back, /leads active .*: 2\.$/, 'back under the warning level: the line comes back, without the warning');
      assert.doesNotMatch(back, /More than 4/);
      assert.equal(await note(0), null);
      assert.equal(resourceSignature(idle, Date.now(), 1), '');
      assert.notEqual(resourceSignature(idle, Date.now(), 2), resourceSignature(idle, Date.now(), 5));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('advisory-b at session start shows the count read from the real ledger folder, and nothing with the line off', () => {
    const fx = makeFixture();
    try {
      const dir = join(fx.stateDir, 'state', 'worker-ledger');
      const now = Date.now();
      for (let i = 0; i < 5; i += 1) ledger(dir, `lead-${i}`, [{ at: iso(now - (i + 1) * 60000), ev: 'start', agent_id: `w${i}` }]);
      const r = run('session-start', { session_id: 'fresh-session' });
      assert.equal(r.status, 0);
      assert.match(ctx(r), /Shared resources: leads active \(helper spawn in the last hour\): 5\. More than 4 leads active: each extra lead adds cold re-reads/);
      const off = run('session-start', { session_id: 'fresh-session-2' }, { CLAUDE_PLUGIN_OPTION_SHARED_RESOURCES_LINE: '0' });
      assert.doesNotMatch(ctx(off), /leads active/);
      const quiet = run('user-prompt', { session_id: 'fresh-session', prompt: 'hello' });
      assert.doesNotMatch(ctx(quiet), /leads active/, 'unchanged since session start: not repeated');
    } finally { fx.cleanup(); }
  });

  test('the ledger the hook writes on a real worker start makes this session a lead', () => {
    const fx = makeFixture();
    try {
      for (const sid of ['lead-x', 'lead-y']) {
        startWorker('w1', sid);
      }
      const r = run('session-start', { session_id: 'someone-else' });
      assert.match(ctx(r), /leads active \(helper spawn in the last hour\): 2\./);
      assert.ok(readFileSync(join(fx.stateDir, 'state', 'worker-ledger', 'lead-x.jsonl'), 'utf8').includes('"start"'));
    } finally { fx.cleanup(); }
  });
});
