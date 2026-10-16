// Hook-process timing telemetry (hooks/lib/context.mjs, option hook_timing_telemetry) and its
// report (scripts/hook-timing.mjs, scripts/lib/hook-timing.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { analyze, judgeEvent, median, percentile, readTimingRows, inWindow } from '../scripts/lib/hook-timing.mjs';

const tele = (fx, name = 'hook-timing.jsonl') => join(fx.stateDir, 'telemetry', name);
const rowsOf = (fx, name) => (existsSync(tele(fx, name)) ? readJsonl(tele(fx, name)) : []);

const post = (extra) => ({
  session_id: 'sess-ht', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call-1',
  tool_input: { command: 'node scripts/ci-local.mjs' }, tool_response: { stdout: 'ok', stderr: '' }, ...extra,
});
// A spawn the guard denies (a ladder rung with no TYPE line), so the decision path is the one timed.
const denySpawn = (extra) => ({
  session_id: 'sess-ht', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'call-2', agent_type: 'main',
  tool_input: { subagent_type: 'agent-companion:ac-sonnet-medium', run_in_background: true, name: 'w', isolation: 'worktree', prompt: 'ROLE: writer\ndo the thing' },
  ...extra,
});
const TYPE_DENY = { CLAUDE_PLUGIN_OPTION_TYPE_LINE_REQUIRED: 'deny' };

// ---------------------------------------------------------------- the hook side --

test('a hook process appends one row: hook, event, tool, call key, session, cpu and wall', () => {
  const fx = makeFixture();
  try {
    const r = runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const rows = rowsOf(fx);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.hook, 'bash-exit');
    assert.equal(row.event, 'PostToolUse');
    assert.equal(row.tool, 'Bash');
    assert.equal(row.call, 'call-1');
    assert.equal(row.session_id, 'sess-ht');
    assert.equal(row.v, 2);
    assert.ok(row.cpu_ms > 0, `cpu_ms ${row.cpu_ms}`);
    assert.ok(row.wall_ms > 0, `wall_ms ${row.wall_ms}`);
    assert.ok(Number.isInteger(row.t0) && Number.isInteger(row.t1) && row.t1 >= row.t0);
    assert.ok(Math.abs((row.t1 - row.t0) - row.wall_ms) <= 1, 'wall is the start-to-exit span');
    assert.ok(Math.abs(Date.parse(row.at) - row.t1) <= 1);
    assert.ok(row.t1 <= Date.now() + 1000 && row.t0 > Date.now() - 60000, 'start time is the process start, in epoch ms');
  } finally { fx.cleanup(); }
});

test('a payload with no tool_use_id records a null call key', () => {
  const fx = makeFixture();
  try {
    runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post({ tool_use_id: undefined }) });
    assert.equal(rowsOf(fx)[0].call, null);
  } finally { fx.cleanup(); }
});

test('option off: no row. On or off, a denying hook prints the same and exits the same', () => {
  const fx = makeFixture();
  try {
    const on = runHook('hooks/spawn-guard.mjs', denySpawn({ cwd: fx.dir }), { env: TYPE_DENY });
    assert.equal(on.json?.hookSpecificOutput?.permissionDecision, 'deny', on.stdout + on.stderr);
    assert.equal(rowsOf(fx).length, 1, 'the denying process still records');
    assert.equal(rowsOf(fx)[0].hook, 'spawn-guard');
    assert.equal(rowsOf(fx)[0].tool, 'Agent');
    const off = runHook('hooks/spawn-guard.mjs', denySpawn({ cwd: fx.dir }), { env: { ...TYPE_DENY, CLAUDE_PLUGIN_OPTION_HOOK_TIMING_TELEMETRY: 'false' } });
    assert.equal(rowsOf(fx).length, 1, 'option off writes nothing more');
    assert.equal(off.status, on.status);
    assert.equal(off.stdout, on.stdout);
  } finally { fx.cleanup(); }
});

test('an unwritable telemetry path stays silent: same output, same exit code', () => {
  const fx = makeFixture();
  try {
    const blocker = join(fx.dir, 'a-file');
    writeFileSync(blocker, 'x');
    const env = { ...TYPE_DENY, AGENT_COMPANION_STATE_DIR: join(blocker, 'state') };
    const on = runHook('hooks/spawn-guard.mjs', denySpawn({ cwd: fx.dir }), { env });
    const off = runHook('hooks/spawn-guard.mjs', denySpawn({ cwd: fx.dir }), { env: { ...env, CLAUDE_PLUGIN_OPTION_HOOK_TIMING_TELEMETRY: 'false' } });
    assert.equal(on.status, off.status);
    assert.equal(on.stdout, off.stdout);
    assert.equal(on.stderr, off.stderr);
  } finally { fx.cleanup(); }
});

test('fixture and canary sessions never reach the timing stream', () => {
  const fx = makeFixture();
  try {
    for (const sid of ['test-ht', 'verify-ht', 'fixture-ht', 'canary-ht']) runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post({ session_id: sid }) });
    assert.equal(rowsOf(fx).length, 0);
    assert.equal(rowsOf(fx, 'fixtures.jsonl').filter((r) => r.stream === 'hook-timing.jsonl').length, 0);
  } finally { fx.cleanup(); }
});

test('only hook processes record: a plugin script run writes no row', () => {
  const fx = makeFixture();
  try {
    const r = runScript('scripts/hook-timing.mjs', ['--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(tele(fx)), false);
  } finally { fx.cleanup(); }
});

test('growth is bounded: a full file is rotated once and the live file restarts', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'telemetry'), { recursive: true });
    const cap = 8 * 1024 * 1024;
    writeFileSync(tele(fx), Buffer.alloc(cap, 'x'));
    runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post() });
    assert.equal(statSync(tele(fx, 'hook-timing.1.jsonl')).size, cap);
    assert.equal(rowsOf(fx).length, 1);
    // A second rotation replaces the rotated file; there are never more than two.
    writeFileSync(tele(fx), Buffer.alloc(cap, 'y'));
    runHook('hooks/bash-exit.mjs', { cwd: fx.dir, ...post() });
    assert.equal(readFileSync(tele(fx, 'hook-timing.1.jsonl')).subarray(0, 1).toString(), 'y');
    assert.equal(rowsOf(fx).length, 1);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- the report --

const BASE = Date.parse('2026-10-16T12:00:00.000Z');
let n = 0;
const row = (o) => ({ v: 2, at: new Date(BASE + o.t1).toISOString(), hook: 'h', event: 'PreToolUse', tool: 'Bash', call: 'c1', session_id: 's1', ...o, t0: BASE + o.t0, t1: BASE + o.t1, n: n++ });

// Call c1 (Bash): Pre = 3 hooks that overlap (parallel); Post = 2 hooks one after the other.
const C1 = [
  row({ hook: 'a', cpu_ms: 40, wall_ms: 50, t0: 1000, t1: 1050 }),
  row({ hook: 'b', cpu_ms: 45, wall_ms: 55, t0: 1005, t1: 1060 }),
  row({ hook: 'c', cpu_ms: 42, wall_ms: 45, t0: 1010, t1: 1055 }),
  row({ hook: 'd', event: 'PostToolUse', cpu_ms: 40, wall_ms: 50, t0: 2000, t1: 2050 }),
  row({ hook: 'e', event: 'PostToolUse', cpu_ms: 35, wall_ms: 40, t0: 2060, t1: 2100 }),
];
// Call c3 (Bash): one Pre process.
const C3 = [row({ hook: 'a', call: 'c3', cpu_ms: 50, wall_ms: 60, t0: 3000, t1: 3060 })];
// Call c2 (Read), a day later: one Pre process.
const DAY = 24 * 60 * 60 * 1000;
const C2 = [row({ hook: 'f', call: 'c2', tool: 'Read', cpu_ms: 36, wall_ms: 44, t0: DAY + 1000, t1: DAY + 1044 })];
// A session event with no call key.
const S1 = [row({ hook: 'g', event: 'SessionStart', tool: null, call: null, cpu_ms: 60, wall_ms: 70, t0: 500, t1: 570 })];

test('judgeEvent: parallel uses the span, sequential the sum of walls, partial overlap the span', () => {
  const p = (t0, t1) => ({ t0, t1, wall_ms: t1 - t0 });
  assert.deepEqual(judgeEvent([p(0, 50), p(5, 60), p(10, 55)]), { kind: 'parallel', wallMs: 60 });
  assert.deepEqual(judgeEvent([p(0, 50), p(60, 100)]), { kind: 'sequential', wallMs: 90 });
  assert.deepEqual(judgeEvent([p(0, 50), p(40, 80), p(70, 120)]), { kind: 'mixed', wallMs: 120 });
  assert.deepEqual(judgeEvent([p(0, 50)]), { kind: 'single', wallMs: 50 });
});

test('median and p90 (nearest rank)', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(median([]), null);
});

test('analyze: per tool, parallel or sequence, estimate E, per-day totals', () => {
  const res = analyze([...C1, ...C3, ...C2, ...S1]);
  assert.equal(res.totals.processes, 8);
  assert.equal(res.totals.toolCalls, 3);

  const bash = res.byTool.find((t) => t.tool === 'Bash');
  assert.equal(bash.calls, 2);
  assert.equal(bash.processesPerCall.mean, 3); // (5 + 1) / 2
  assert.equal(bash.eventsPerCall, 1.5);
  // c1: cpu 40+45+42+40+35 = 202; wall = Pre span 60 + Post sum 90 = 150. c3: cpu 50, wall 60.
  assert.deepEqual(bash.cpuMsPerCall, { median: 126, p90: 202 });
  assert.deepEqual(bash.wallMsPerCall, { median: 105, p90: 150 });
  const read = res.byTool.find((t) => t.tool === 'Read');
  assert.equal(read.calls, 1);
  assert.equal(read.processesPerCall.mean, 1);
  assert.equal(read.estimate.processesSavedPerCall, 0);

  const pre = res.parallelism.find((p) => p.event === 'PreToolUse');
  const postE = res.parallelism.find((p) => p.event === 'PostToolUse');
  assert.equal(pre.verdict, 'parallel');
  assert.equal(postE.verdict, 'sequential');
  assert.equal(pre.medianSpanMs, 60);
  assert.equal(postE.medianSumOfWallsMs, 90);

  // Floor: no hook has 5 rows, so the lowest single row: 35 ms CPU, 40 ms wall.
  assert.equal(res.floor.cpuMs, 35);
  assert.equal(res.floor.wallMs, 40);
  // Pre (n=3): 2 saved, cpu 2*35 = 70, wall 60 - (40 + 10+15+5) = -10.
  // Post (n=2): 1 saved, cpu 35, wall 90 - (40 + 10+0) = 40.
  assert.deepEqual(bash.estimate, { label: 'E', processesSavedPerCall: 1.5, cpuMsSavedPerCall: 52.5, wallMsSavedPerCall: 15 });
  assert.deepEqual(res.totals.estimate, { label: 'E', processesSaved: 3, cpuMsSaved: 105, wallMsSaved: 30 });

  assert.deepEqual(res.perDay.map((d) => d.day), ['2026-10-16', '2026-10-17']);
  const d1 = res.perDay[0];
  assert.equal(d1.processes, 7);
  assert.equal(d1.toolCalls, 2);
  assert.equal(d1.cpuMs, 40 + 45 + 42 + 40 + 35 + 50 + 60);
  assert.equal(d1.toolCallWallMs, 150 + 60);
  assert.equal(d1.estimate.processesSaved, 3);
  assert.equal(res.perDay[1].toolCalls, 1);
  assert.equal(res.otherEvents[0].event, 'SessionStart');
});

test('analyze: the floor uses per-hook medians once a hook has enough rows', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(row({ hook: 'cheap', call: `k${i}`, cpu_ms: 30 + i, wall_ms: 40 + i, t0: i * 100, t1: i * 100 + 40 + i }));
  rows.push(row({ hook: 'rare', call: 'z', cpu_ms: 5, wall_ms: 6, t0: 900, t1: 906 }));
  const res = analyze(rows);
  assert.equal(res.floor.hook, 'cheap');
  assert.equal(res.floor.cpuMs, 32); // median of 30..34
});

test('analyze: an empty window is empty, not an error', () => {
  const res = analyze([]);
  assert.equal(res.totals.processes, 0);
  assert.deepEqual(res.byTool, []);
});

test('readTimingRows reads the rotated file then the live one and skips junk; inWindow cuts by end time', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'telemetry'), { recursive: true });
    writeFileSync(tele(fx, 'hook-timing.1.jsonl'), `${JSON.stringify(C1[0])}\nnot json\n`);
    writeFileSync(tele(fx), `${JSON.stringify(C1[1])}\n${JSON.stringify({ hook: 'x' })}\n`);
    const rows = readTimingRows();
    assert.deepEqual(rows.map((r) => r.hook), ['a', 'b']);
    assert.equal(inWindow(rows, { sinceMs: BASE + 1055 }).length, 1);
    assert.equal(inWindow(rows, { untilMs: BASE + 1055 }).length, 1);
  } finally { fx.cleanup(); }
});

test('CLI: --day and --json; text output names parallel or sequence and labels the estimate E', () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.stateDir, 'telemetry'), { recursive: true });
    writeFileSync(tele(fx), [...C1, ...C3, ...C2, ...S1].map((r) => JSON.stringify(r)).join('\n') + '\n');

    const j = runScript('scripts/hook-timing.mjs', ['--day', '2026-10-16', '--json']);
    assert.equal(j.status, 0, j.stderr);
    assert.equal(j.json.window, 'UTC day 2026-10-16');
    assert.equal(j.json.totals.toolCalls, 2);
    assert.deepEqual(j.json.perDay.map((d) => d.day), ['2026-10-16']);

    const t = runScript('scripts/hook-timing.mjs', ['--since', '2026-10-16', '--until', '2026-10-18']);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /PreToolUse\s+PARALLEL/);
    assert.match(t.stdout, /PostToolUse\s+SEQUENTIAL/);
    assert.match(t.stdout, /Estimate E/);
    assert.match(t.stdout, /Per-day totals/);
    assert.match(t.stdout, /Bash/);
    assert.match(t.stdout, /Read/);

    const bad = runScript('scripts/hook-timing.mjs', ['--day', 'nope']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a date/);

    const none = runScript('scripts/hook-timing.mjs', ['--day', '2025-01-01']);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no hook-timing rows/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- shipping --

test('the option is declared, defaults on, and is documented in the README and TELEMETRY.md', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.userConfig.hook_timing_telemetry.default, true);
  assert.equal(manifest.userConfig.hook_timing_telemetry.type, 'boolean');
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^\| `hook_timing_telemetry` \|/m);
  const doc = readFileSync(join(PLUGIN_ROOT, 'docs', 'TELEMETRY.md'), 'utf8');
  assert.match(doc, /### `hook-timing\.jsonl`/);
});
