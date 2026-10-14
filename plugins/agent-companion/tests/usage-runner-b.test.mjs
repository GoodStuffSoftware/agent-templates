// Batch 5b of the daily usage analysis (0.31.18): the checkup pipeline order and its time budget, the
// SessionStart surfacing of the summary with the unattended guard, and the canonical rung label.
// Synthetic facts in a temp state root; nothing reads the operator's data, no model is called.
import { makeFixture, runHook, runScript } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addDays, dayRange } from '../scripts/lib/usage/days.mjs';
import {
  makeHooks, readResult, readLatest, readStatus, regressionSetKey, usagePaths,
} from '../scripts/lib/usage/runner.mjs';
import { validateLayer, normalizeRung } from '../scripts/lib/usage/config.mjs';
import { matchField } from '../scripts/lib/usage/cohort.mjs';
import { runPipeline, PIPELINE_ORDER } from '../scripts/lib/usage/pipeline.mjs';
import {
  latestFile, surfacedFile, routinePinsFile, pendingUsageSummary, unattendedReason, routineFolders,
} from '../scripts/lib/usage/surface.mjs';
import { checkupPaths, launchCheckup, ANALYSIS_BUDGET_SECONDS } from '../scripts/lib/daily-checkup.mjs';

const HOOK = 'hooks/scout-surface.mjs';
const SONNET = 'claude-sonnet-5-5';
const SPEC = { inUsd: 1, outRatio: 5, r: 0.1, w5: 1.25, w1: 2, mult: 1 };
const zero = () => [0, 0, 0, 0, 0, 0];
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ----------------------------------------------------------------- helpers --

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
}

function writeFacts(root, day) {
  const dir = join(root, 'state', 'usage-facts');
  mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    hour: `${day}T10:00:00.000Z`, sid: `sess-${day}-${i}`, proj: 'alpha', cwd: null,
    tok: { [SONNET]: { m: [10 + Number(day.slice(8)), 0, 0, 0, 0, 1], s: zero() } },
    pr: { n: 1, len: [1, 0, 0, 0], corr: 0 }, ag: 0, sm: 0, gc: 0,
  }));
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({
    schema: 'agent-companion/usage-facts', factsVersion: 1, extractorVersion: 2, day,
    from: `${day}T08:00:00.000Z`, to: `${addDays(day, 1)}T08:00:00.000Z`, dataThrough: `${addDays(day, 1)}T07:59:00.000Z`,
    scanFrom: `${day}T08:00:00.000Z`, computedAt: `${addDays(day, 1)}T09:00:00.000Z`, weightsUsed: { [SONNET]: { ...SPEC } }, rows, spawns: [],
  }));
}

// What the runner leaves for the hook: the 3-line summary of a day, keyed by its regression set.
function writeLatest(root, { day = dayAgo(2), ids = [] } = {}) {
  const f = latestFile(root);
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(f, JSON.stringify({
    schema: 'agent-companion/usage-analysis-latest', day, revision: 1, inputsDigest: 'x',
    lines: [`[agent-companion] usage ${day.slice(5)}: 100.0 u = 3.7% of week (M)`, ids.length ? `regressions: ${ids.join(' ; ')}` : 'regressions: none', `report: ${root.replace(/\\/g, '/')}/reports/usage/usage-${day}.md`],
    regressionIds: ids, regressions: [], surfaceKey: regressionSetKey(ids), report: 'x',
  }));
}

// A history line the checkup's SessionStart line is built from (closed within the last 72 hours).
function writeHistory(day = dayAgo(2)) {
  const to = new Date(Date.parse(`${addDays(day, 1)}T08:00:00Z`)).toISOString();
  appendFileSync(checkupPaths().history, `${JSON.stringify({
    day, from: `${day}T08:00:00.000Z`, to, pct: { total: 5 }, week: { pctSoFar: 10, paceAtResetPct: 14 }, targetPct: 14, vsTargetPct: -9,
  })}\n`);
}

function hook(fx, { env = {}, cwd = fx.dir, payload = {} } = {}) {
  const res = runHook(HOOK, { session_id: 'sess-surface', cwd, ...payload }, {
    cwd,
    env: { AGENT_COMPANION_SESSIONS_DIR: join(fx.dir, 'no-sessions'), ...env },
  });
  assert.equal(res.status, 0, res.stderr);
  return { ctx: res.json?.hookSpecificOutput?.additionalContext || '', res };
}

// ----------------------------------------------------------- rung label --

test('rung: the canonical label is model/effort; model-effort is an alias normalized to the slash form', () => {
  assert.equal(normalizeRung('sonnet-high'), 'sonnet/high');
  assert.equal(normalizeRung('opus-xhigh'), 'opus/xhigh');
  assert.equal(normalizeRung('sonnet/high'), 'sonnet/high');
  assert.equal(normalizeRung('haiku'), 'haiku');
  assert.equal(normalizeRung('3'), '3');

  const base = { schema: 'agent-companion/usage-analysis', schemaVersion: 1 };
  const sc = (cohort) => ({ id: 'u.rung', metric: 'day.units', compare: ['prior-day'], threshold: { direction: 'up-is-worse', relPct: 25 }, severity: 'info', cohort });
  const ok = validateLayer({ ...base, scenarios: [sc({ rung: ['sonnet/high', 'sonnet-high', 'opus-medium', 'haiku'] })] }, 'user');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.scenarios[0].cohort.rung, ['sonnet/high', 'sonnet/high', 'opus/medium', 'haiku'], 'the alias is stored in the slash form');
  for (const bad of ['a/b/c', '/high', 'sonnet/', 'sonnet high', 'x'.repeat(200)]) {
    const r = validateLayer({ ...base, scenarios: [sc({ rung: [bad] })] }, 'user');
    assert.equal(r.scenarios.length, 0, `refused: ${bad.slice(0, 20)}`);
  }

  // a record's rung and a filter match in either spelling
  assert.equal(matchField('rung', ['sonnet-high'], { rung: 'sonnet/high' }), true);
  assert.equal(matchField('rung', ['sonnet/high'], { rung: 'sonnet-high' }), true);
  assert.equal(matchField('rung', ['sonnet/high'], { rung: 'sonnet/low' }), false);
  assert.equal(matchField('rung', ['sonnet/high'], {}), null, 'no rung on the record: unobservable');
});

test('rung: the spawn hook emits the label as the routing table writes it', () => {
  const fx = makeFixture();
  try {
    const day = '2026-10-09';
    const spawn = (id, rung) => ({
      id, sid: 'sess-a', aid: `a-${id}`, proj: 'alpha', type: 'bounded-feature', role: 'writer', rung, fit: 'ok', model: SONNET, mixed: false,
      start: `${day}T10:00:00.000Z`, end: `${day}T10:20:00.000Z`, partial: false,
      req: { n: 8, bucket: '6-15', cat: {} }, ctx: { buckets: [[5, 0, 0, 0, 0, 1], zero(), zero(), zero()], peak: 90000 },
      startup: zero(), comp: { n: 0, after: null }, extraTurns: 0, status: 'done', simple: { runs: 0, req: 0, tok: zero() }, rk: { d: null, n: null, h: null },
    });
    const store = { read: () => ({ facts: { weightsUsed: { [SONNET]: SPEC }, spawns: [spawn('toolu_1', 'sonnet/high'), spawn('toolu_2', 'opus/medium'), spawn('toolu_3', 'haiku')] } }) };
    const recs = makeHooks({ store, routineFolders: [] }).spawnRecords(day, null);
    assert.deepEqual(recs.map((r) => r.rung), ['sonnet/high', 'opus/medium', 'haiku']);
    assert.deepEqual(recs.map((r) => r.effort), ['high', 'medium', undefined]);
  } finally { fx.cleanup(); }
});

// ----------------------------------------------------- pipeline order --

test('pipeline: scan, then analysis, then status, then the register; the analysis gets the session budget', () => {
  const fx = makeFixture();
  try {
    const calls = [];
    const deps = {
      stateRoot: fx.stateDir,
      scan: (o) => { calls.push(['scan', o]); return { written: [], bytesRead: 12 }; },
      analysis: (o) => { calls.push(['analysis', o]); return { computed: ['2026-10-09'], skipped: [], deferred: [{ day: '2026-10-10', kind: 'settling', reason: 'r' }], remaining: 0, partial: false, durationMs: 3 }; },
      status: (root, o) => { calls.push(['status', root, o]); },
      register: (o) => { calls.push(['register', o]); },
    };
    const now = Date.parse('2026-10-11T12:00:00Z');
    const { out, order } = runPipeline({ nowT: now, deps });
    assert.deepEqual(order, PIPELINE_ORDER.slice());
    assert.deepEqual(calls.map((c) => c[0]), ['scan', 'analysis', 'status', 'register']);
    assert.equal(calls[1][1].maxSeconds, ANALYSIS_BUDGET_SECONDS, 'a session start passes the session budget, not the 300 s ceiling');
    assert.equal(calls[1][1].root, fx.stateDir);
    assert.equal(calls[2][2].out.deferred.length, 1, 'the status file gets the deferred days');
    assert.equal(calls[2][2].run.bytesRead, 12);
    assert.deepEqual(out.analysis.computed, ['2026-10-09']);
    assert.equal(out.analysis.deferred[0].kind, 'settling');
    assert.equal(out.bytesRead, 12, 'the scan fields stay at the top level');

    // a failed scan does not stop the analysis (it works from the facts already on disk) and is reported
    calls.length = 0;
    const failed = runPipeline({ nowT: now, deps: { ...deps, scan: () => { throw new Error('boom'); } } });
    assert.deepEqual(failed.order, ['scan', 'analysis', 'status']);
    assert.match(failed.out.error, /boom/);

    // an analysis error: no status, the register still runs
    calls.length = 0;
    const bad = runPipeline({ nowT: now, deps: { ...deps, analysis: () => ({ error: 'nope' }) } });
    assert.deepEqual(bad.order, ['scan', 'analysis', 'register']);
    assert.match(bad.errors.join(' '), /analysis: nope/);
  } finally { fx.cleanup(); }
});

test('pipeline: the usage_analysis option turns the analysis stage off; the register stays', () => {
  const fx = makeFixture();
  const keep = process.env.CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS;
  try {
    process.env.CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS = 'false';
    const { order } = runPipeline({
      nowT: Date.parse('2026-10-11T12:00:00Z'),
      deps: { scan: () => ({}), analysis: () => assert.fail('off'), status: () => assert.fail('off'), register: () => {} },
    });
    assert.deepEqual(order, ['scan', 'register']);
  } finally {
    if (keep === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS; else process.env.CLAUDE_PLUGIN_OPTION_USAGE_ANALYSIS = keep;
    fx.cleanup();
  }
});

test('checkup CLI: one run scans, analyses the settled days that have no result and writes the status; a fake claude is never called', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const tdir = join(fx.dir, 'transcripts');
    mkdirSync(tdir, { recursive: true });
    const day = '2026-10-09';
    const asst = (id, ts, u) => JSON.stringify({
      type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, cwd: '/work/proj-a',
      message: { id: `msg_${id}`, model: SONNET, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: u, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    mkdirSync(join(tdir, 'proj-a'), { recursive: true });
    writeFileSync(join(tdir, 'proj-a', 'sess-1.jsonl'), `${[
      JSON.stringify({ type: 'user', timestamp: `${day}T10:00:00Z`, uuid: 'p1', cwd: '/work/proj-a', message: { role: 'user', content: 'Please add the thing to the parser and run the tests' } }),
      asst('m1', `${day}T10:00:05Z`, 4000),
      asst('m2', `${day}T10:30:00Z`, 6000),
    ].join('\n')}\n`);

    const bin = join(fx.dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const log = join(fx.dir, 'claude-calls.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho called >> "${log.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'claude.cmd'), `@echo called>>"${log}"\r\n`);
    const before = snapshot(tdir);
    const sep = process.platform === 'win32' ? ';' : ':';
    const res = runScript('scripts/daily-checkup.mjs', ['--root', tdir, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0', '--max-seconds', '5'], {
      env: { PATH: `${bin}${sep}${process.env.PATH}` },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.json.factsWritten, [day], 'the scan wrote the facts');
    assert.deepEqual(res.json.analysis.computed, [day], 'the analysis ran in the same run, after the scan');
    assert.ok(readResult(root, day));
    assert.equal(readStatus(root).lastRun.computed[0], day);
    assert.ok(readLatest(root));
    assert.ok(!existsSync(log), 'the fake claude was never called');
    assert.deepEqual(snapshot(tdir), before, 'the transcript root is read-only');
    const stray = Object.keys(snapshot(fx.dir)).filter((p) => !p.startsWith('transcripts/') && !p.startsWith('fakebin/') && !p.startsWith('.claude/agent-companion/'));
    assert.deepEqual(stray, [], 'nothing is written outside the state root');
    assert.ok(!existsSync(usagePaths(root).surfaced), 'the CLI never marks a summary shown');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------- time budget --

test('time budget: the checkup passes its budget to the analysis, which keeps progress and resumes', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const days = dayRange('2026-10-01', '2026-10-06');
    for (const d of days) writeFacts(root, d);
    const empty = join(fx.dir, 'no-transcripts');
    mkdirSync(empty, { recursive: true });
    const args = ['--root', empty, '--now', '2026-10-07T12:00:00Z', '--hold-ms', '0'];

    // a budget of 0 s: the first day still runs (progress), the rest wait for the next run
    const first = runScript('scripts/daily-checkup.mjs', [...args, '--max-seconds', '0']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.analysis.computed.length, 1);
    assert.equal(first.json.analysis.computed[0], days[0], 'oldest first');
    assert.equal(first.json.analysis.partial, true);
    assert.equal(first.json.analysis.remaining, days.length - 1);
    assert.ok(first.json.analysis.deferred.every((d) => d.kind === 'time-budget'));
    assert.equal(readStatus(root).lastRun.partial, true);

    // the next run (no budget given: the session default) picks up every deferred day
    const second = runScript('scripts/daily-checkup.mjs', args);
    assert.deepEqual(second.json.analysis.computed, days.slice(1));
    assert.equal(second.json.analysis.partial, false);
    assert.deepEqual(second.json.analysis.deferred, []);
    assert.equal(readStatus(root).deferred.length, 0);
  } finally { fx.cleanup(); }
});

test('time budget: the background launch carries the budget, hidden and detached; the hook computes nothing itself', () => {
  const fx = makeFixture();
  const keep = process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH;
  try {
    const calls = [];
    delete process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH;
    const r = launchCheckup({ nowT: Date.parse('2026-10-11T12:00:00Z'), spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; } });
    assert.equal(r.launched, true);
    assert.match(calls[0].args[0], /daily-checkup\.mjs$/);
    assert.deepEqual(calls[0].args.slice(1), ['--max-seconds', String(ANALYSIS_BUDGET_SECONDS)]);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.detached, true);
    assert.ok(ANALYSIS_BUDGET_SECONDS > 0 && ANALYSIS_BUDGET_SECONDS <= 60);
  } finally {
    if (keep !== undefined) process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH = keep;
    fx.cleanup();
  }

  // a session start with unanalysed settled days on disk: the hook returns without computing any of them
  const fx2 = makeFixture();
  try {
    for (const d of dayRange('2026-10-01', '2026-10-06')) writeFacts(fx2.stateDir, d);
    const t0 = Date.now();
    const { res } = hook(fx2);
    assert.equal(res.status, 0);
    assert.ok(Date.now() - t0 < 14000, 'well inside the hook timeout');
    assert.ok(!existsSync(usagePaths(fx2.stateDir).resultsDir), 'the hook runs no analysis');
  } finally { fx2.cleanup(); }
});

// ---------------------------------------------------- surfacing + guard --

test('surfacing: an attended session sees the summary once; the same regression set stays quiet', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    writeLatest(root, { ids: ['u.units'] });
    const a = hook(fx);
    assert.match(a.ctx, /usage \d\d-\d\d: 100\.0 u/);
    assert.match(a.ctx, /regressions: u\.units/);
    assert.match(a.ctx, /report: /);
    assert.equal(JSON.parse(readFileSync(surfacedFile(root), 'utf8')).key, regressionSetKey(['u.units']));

    assert.doesNotMatch(hook(fx).ctx, /usage \d\d-\d\d/, 'shown once');

    // a newer day with the SAME regression set: still quiet
    writeLatest(root, { day: dayAgo(1), ids: ['u.units'] });
    assert.doesNotMatch(hook(fx).ctx, /usage \d\d-\d\d/);
  } finally { fx.cleanup(); }
});

test('surfacing: it comes back only when the set of regression ids changes', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const shows = () => /usage \d\d-\d\d: 100\.0 u/.test(hook(fx).ctx);
    writeLatest(root, { ids: ['a'] });
    assert.equal(shows(), true);
    assert.equal(shows(), false);

    writeLatest(root, { ids: ['a', 'b'] });
    assert.equal(shows(), true, 'a regression was added');
    assert.equal(shows(), false);

    writeLatest(root, { ids: ['b', 'a'] });
    assert.equal(shows(), false, 'the same ids in another order are the same set');

    writeLatest(root, { ids: ['b'] });
    assert.equal(shows(), true, 'a regression cleared');
    assert.equal(shows(), false);

    writeLatest(root, { ids: [] });
    assert.equal(shows(), true, 'all clear is a change too');
    assert.equal(shows(), false);

    // a summary older than 72 hours past its close is not news
    writeLatest(root, { day: dayAgo(6), ids: ['z'] });
    assert.equal(shows(), false);
    assert.equal(pendingUsageSummary({ root }), null);
  } finally { fx.cleanup(); }
});

function assertGuarded(fx, label, opts) {
  const root = fx.stateDir;
  const f = surfacedFile(root);
  const before = existsSync(f) ? readFileSync(f, 'utf8') : null;
  const out = hook(fx, opts);
  assert.doesNotMatch(out.ctx, /usage \d\d-\d\d/, `${label}: the usage summary is not shown`);
  assert.doesNotMatch(out.ctx, /Daily checkup/, `${label}: the daily checkup line is not shown`);
  assert.equal(existsSync(f) ? readFileSync(f, 'utf8') : null, before, `${label}: the usage summary is not marked shown`);
  assert.ok(!existsSync(checkupPaths().surfaced), `${label}: the checkup line is not marked shown`);
}

test('guard: an unattended session is never shown the summary and never marks it shown', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    writeLatest(root, { ids: ['u.units'] });
    writeHistory();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(routinePinsFile(root), JSON.stringify({ folders: { nightly: join(fx.dir, 'pinned', 'nightly').replace(/\\/g, '/'), template: '{{ROUTINE_DIR}}/x' } }));
    const pinned = join(fx.dir, 'pinned', 'nightly', 'sub');
    const low = join(fx.dir, 'work', 'routine-cwd-a');
    mkdirSync(pinned, { recursive: true });
    mkdirSync(low, { recursive: true });

    assertGuarded(fx, 'env CLAUDE_CODE_SESSION_ATTENDED=0', { env: { CLAUDE_CODE_SESSION_ATTENDED: '0' } });
    assertGuarded(fx, 'routine-cwd folder', { cwd: low, payload: { cwd: low } });
    assertGuarded(fx, 'routine-pins folder', { cwd: pinned, payload: { cwd: pinned } });
    assertGuarded(fx, 'scheduledTaskId on the payload', { payload: { scheduledTaskId: 'nightly-scout' } });

    // a scheduled-run session record the desktop app wrote for this cwd a moment ago
    const sessions = join(fx.dir, 'sessions', 'acct', 'org');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'local_run-1.json'), JSON.stringify({
      sessionId: 'local_run-1', scheduledTaskId: 'nightly-scout', cwd: fx.dir, createdAt: Date.now() - 20000, model: SONNET,
    }));
    assertGuarded(fx, 'scheduledTaskId on a session record', { env: { AGENT_COMPANION_SESSIONS_DIR: join(fx.dir, 'sessions') } });

    // none of those consumed anything: the next attended session sees both lines
    const attended = hook(fx);
    assert.match(attended.ctx, /usage \d\d-\d\d: 100\.0 u/);
    assert.match(attended.ctx, /Daily checkup/);
    assert.ok(existsSync(surfacedFile(root)));
    assert.ok(existsSync(checkupPaths().surfaced));
  } finally { fx.cleanup(); }
});

test('guard: unattendedReason names its reason and fails toward attended', () => {
  const fx = makeFixture();
  try {
    const root = fx.stateDir;
    const base = { env: { AGENT_COMPANION_SESSIONS_DIR: join(fx.dir, 'none') }, root, cwd: fx.dir };
    assert.equal(unattendedReason(base), null);
    assert.match(unattendedReason({ ...base, env: { ...base.env, CLAUDE_CODE_SESSION_ATTENDED: '0' } }), /ATTENDED/);
    assert.equal(unattendedReason({ ...base, env: { ...base.env, CLAUDE_CODE_SESSION_ATTENDED: '1' } }), null, 'attended is attended');
    assert.match(unattendedReason({ ...base, cwd: 'C:\\work\\Routine-CWD-b' }), /routine folder/);
    assert.match(unattendedReason({ ...base, payload: { cwd: '/work/routine-cwd-a/sub' } }), /routine folder/);
    assert.equal(unattendedReason({ ...base, cwd: '/work/not-a-routine-cwd-x' }), null);
    assert.match(unattendedReason({ ...base, payload: { scheduled_task_id: 't' } }), /scheduledTaskId/);
    assert.equal(unattendedReason({ ...base, payload: { scheduledTaskId: '' } }), null);
    // unreadable or malformed routine-pins: no folders, no throw
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(routinePinsFile(root), '{ not json');
    assert.deepEqual(routineFolders(root), []);
    assert.equal(unattendedReason(base), null);
  } finally { fx.cleanup(); }
});

test('surface paths agree with the runner, and the hook-side modules stay lean and hidden', () => {
  const root = join('x', 'root');
  const p = usagePaths(root);
  assert.equal(latestFile(root), p.latest);
  assert.equal(surfacedFile(root), p.surfaced);
  assert.equal(routinePinsFile(root), p.routinePins);
  const base = new URL('..', import.meta.url);
  const surface = readFileSync(new URL('scripts/lib/usage/surface.mjs', base), 'utf8');
  assert.doesNotMatch(surface, /from '\.\/runner\.mjs'/, 'the hook does not load the runner');
  for (const f of ['scripts/lib/usage/surface.mjs', 'scripts/lib/usage/pipeline.mjs', 'scripts/daily-checkup.mjs']) {
    const src = readFileSync(new URL(f, base), 'utf8');
    assert.doesNotMatch(src, /child_process|\bspawn\w*\(|\bexec\w*\(|\bfork\(/, `${f}: no process of its own`);
    assert.doesNotMatch(src, /setTimeout|Atomics\.wait|notBefore|\bsleep\b/, `${f}: no waiter`);
    assert.doesNotMatch(src, /\bclaude\b\s*['"`,)]|messages\.create|fetch\(/, `${f}: no model call or network`);
  }
  // the one spawn in launchCheckup sets windowsHide
  const dc = readFileSync(new URL('scripts/lib/daily-checkup.mjs', base), 'utf8');
  const i = dc.indexOf('spawnFn(process.execPath');
  assert.ok(i > 0 && /windowsHide: true/.test(dc.slice(i, i + 250)));
});
