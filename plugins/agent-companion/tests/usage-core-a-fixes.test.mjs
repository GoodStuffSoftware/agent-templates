// Regression tests for the 0.31.18 facts/config/journal review fixes (F1-F6 + the metrics info item).
// Synthetic fixtures only; nothing reads real transcripts or calls a model.
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { validateLayer, resolveLayers, loadConfig } from '../scripts/lib/usage/config.mjs';
import { configMetricRegistry } from '../scripts/lib/usage/metrics/index.mjs';
import { runCheckup, resetUnitCache, factsDir, launchAckIds, completedOf } from '../scripts/lib/daily-checkup.mjs';
import { boundCwd, nextRow, tailRows } from '../hooks/lib/settings-journal.mjs';

const BASE = { schema: 'agent-companion/usage-analysis', schemaVersion: 1 };
const sc = (id, over = {}) => ({ id, metric: 'day.units', compare: ['prior-day'], severity: 'alert', ...over });

// ---------------------------------------------------------------- F1
test('F1 a project scenario with no cohort, an empty cohort or foreign-field cohort is scoped to its own project', () => {
  const rec = validateLayer({
    ...BASE,
    scenarios: [sc('nocohort'), sc('emptycohort', { cohort: {} }), sc('otherfields', { cohort: { class: ['lead'] } })],
  }, 'project', { label: 'proj-x' });
  assert.equal(rec.scenarios.length, 3);
  for (const s of rec.scenarios) assert.deepEqual(s.cohort.project, ['proj-x'], s.id);
  assert.deepEqual(rec.scenarios[2].cohort.class, ['lead'], 'other cohort fields are kept');
  const r = resolveLayers({ shipped: null, user: null, projects: [rec] });
  assert.deepEqual(r.scenarios.get('project:proj-x/nocohort').def.cohort.project, ['proj-x']);
});

test('F1 a project scenario naming another project is still refused; user and shipped scenarios are not forced', () => {
  const bad = validateLayer({ ...BASE, scenarios: [sc('x', { cohort: { project: ['someone-else'] } })] }, 'project', { label: 'proj-x' });
  assert.equal(bad.scenarios.length, 0);
  assert.equal(bad.refusals.length, 1);
  const user = validateLayer({ ...BASE, scenarios: [sc('u.a')] }, 'user', {});
  assert.equal(user.scenarios[0].cohort, undefined);
});

// ---------------------------------------------------------------- F2
test('F2 environment.day.boundaryUtcHour other than 8 is refused with a clear message; 8 is accepted', () => {
  for (const h of [0, 7, 9, 23]) {
    const rec = validateLayer({ ...BASE, environment: { day: { boundaryUtcHour: h } } }, 'user', {});
    assert.equal(rec.environment, null, `hour ${h}`);
    const msg = rec.errors.map((e) => `${e.path} ${e.message}`).join('\n');
    assert.match(msg, /boundaryUtcHour/);
    assert.match(msg, /must be 8 in this release/);
    assert.match(msg, /08:00Z/);
  }
  const ok = validateLayer({ ...BASE, environment: { day: { boundaryUtcHour: 8 } } }, 'user', {});
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.environment.day.boundaryUtcHour, 8);
  const none = validateLayer({ ...BASE, environment: { day: {} } }, 'user', {});
  assert.equal(none.errors.length, 0);
});

// ---------------------------------------------------------------- info item
test('metrics registry: unknown metric ids and undeclared scenario params are refused when the registry is passed', () => {
  const metrics = configMetricRegistry();
  assert.ok(metrics['day.byClass'] && metrics['day.byClass'].params.defaults, 'the registry exposes params');
  const unknown = validateLayer({ ...BASE, scenarios: [sc('u.a', { metric: 'no.such.metric' })] }, 'user', { metrics });
  assert.match(JSON.stringify(unknown.errors), /unknown metric/);
  const badParam = validateLayer({ ...BASE, scenarios: [sc('u.b', { metric: 'day.byClass', params: { nope: 1 } })] }, 'user', { metrics });
  assert.match(JSON.stringify(badParam.errors), /does not declare parameter/);
  const good = validateLayer({ ...BASE, scenarios: [sc('u.c', { metric: 'day.byClass', params: { class: 'lead' } })] }, 'user', { metrics });
  assert.equal(good.errors.length, 0);
  assert.equal(good.scenarios.length, 1);
});

test('the shipped defaults validate clean against the metric registry', () => {
  const fx = makeFixture();
  try {
    const cfg = loadConfig({ root: fx.stateDir, writeSignal: false, metrics: configMetricRegistry() });
    assert.deepEqual(cfg.problems, []);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- F3 / F4: settings journal
const HOOK = 'hooks/settings-journal.mjs';
const jrows = (fx) => {
  const f = join(fx.stateDir, 'telemetry', 'settings-changes.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const settingsFile = (fx, obj) => {
  mkdirSync(join(fx.dir, '.claude'), { recursive: true });
  writeFileSync(join(fx.dir, '.claude', 'settings.json'), JSON.stringify(obj));
};
const start = (sid, model, effort) => ({ session_id: sid, cwd: '/work/alpha', source: 'startup', model, effort: { level: effort } });

test('F3 with a configured model and effort, alternating lead and routine sessions write no rows after the baseline', () => {
  const fx = makeFixture();
  try {
    settingsFile(fx, { model: 'claude-opus-5-5', effortLevel: 'high' });
    for (let i = 0; i < 4; i += 1) {
      runHook(HOOK, start(`lead${i}`, 'claude-opus-5-5', 'high'));
      runHook(HOOK, start(`routine${i}`, 'claude-sonnet-5-5', 'low'));
    }
    const got = jrows(fx);
    assert.equal(got.length, 1);
    assert.equal(got[0].model, 'claude-opus-5-5');
    assert.equal(got[0].effort, 'high');
  } finally { fx.cleanup(); }
});

test('F3 a real change of the settings files writes a row, and the setting: events follow it', async () => {
  const { settingEvents, settingInstant } = await import('../hooks/lib/settings-journal.mjs');
  const fx = makeFixture();
  try {
    settingsFile(fx, { model: 'claude-opus-5-5', effortLevel: 'high' });
    runHook(HOOK, start('s1', 'claude-sonnet-5-5', 'low'));
    settingsFile(fx, { model: 'claude-opus-5-5', effortLevel: 'xhigh' });
    runHook(HOOK, start('s2', 'claude-sonnet-5-5', 'low'));
    runHook(HOOK, start('s3', 'claude-opus-5-5', 'high'));
    settingsFile(fx, { model: 'claude-sonnet-5-5', effortLevel: 'xhigh' });
    runHook(HOOK, start('s4', 'claude-opus-5-5', 'high'));
    const got = jrows(fx);
    assert.deepEqual(got.map((r) => r.changed), [['baseline'], ['effort'], ['model']]);
    assert.deepEqual(got.map((r) => r.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    assert.ok(settingInstant(got, 'setting:effort=xhigh') > 0);
    assert.equal(settingEvents(got).filter((e) => e.key === 'model').length, 2);
  } finally { fx.cleanup(); }
});

test('F3 without a configured model the payload is a fallback, and a value already in the journal is a per-session value', () => {
  const fx = makeFixture();
  try {
    for (let i = 0; i < 5; i += 1) {
      runHook(HOOK, start(`lead${i}`, 'claude-opus-5-5', 'high'));
      runHook(HOOK, start(`routine${i}`, 'claude-sonnet-5-5', 'low'));
    }
    assert.equal(jrows(fx).length, 2, 'baseline plus the first sight of the routine values, then nothing');
  } finally { fx.cleanup(); }
});

test('F3 simultaneous session starts that see the same change append one row (lock around read-then-append)', async () => {
  const { spawn } = await import('node:child_process');
  const fx = makeFixture();
  try {
    runHook(HOOK, start('seed', 'claude-opus-5-5', 'high'));
    settingsFile(fx, { model: 'claude-sonnet-5-5', effortLevel: 'high' });
    const script = join(PLUGIN_ROOT, HOOK);
    const kids = [];
    for (let i = 0; i < 8; i += 1) {
      const k = spawn(process.execPath, [script], { env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      k.stdin.end(JSON.stringify(start(`par${i}`, 'claude-opus-5-5', 'high')));
      kids.push(new Promise((res) => k.on('exit', res)));
    }
    await Promise.all(kids);
    assert.equal(jrows(fx).filter((r) => r.model === 'claude-sonnet-5-5').length, 1);
    assert.ok(!existsSync(join(fx.stateDir, 'telemetry', 'settings-changes.jsonl.lock')), 'the lock is released');
  } finally { fx.cleanup(); }
});

test('F3 nextRow: a settings-sourced value is a change even when an earlier row shows it', () => {
  const rows = [
    { model: 'm1', effort: 'high', plugin_version: '1', options: 'none' },
    { model: 'm2', effort: 'high', plugin_version: '1', options: 'none' },
  ];
  const ctx = { at: 't', session_id: 's', cwd: null, history: rows.slice(0, -1) };
  const seen = { model: 'm1', effort: 'high', plugin_version: '1', options: 'none' };
  assert.deepEqual(nextRow(rows[1], { ...seen, fallback: { model: false } }, ctx).changed, ['model']);
  assert.equal(nextRow(rows[1], { ...seen, fallback: { model: true } }, ctx), null);
});

test('F4 cwd is bounded: a long path is cut and hashed, a short one is kept', () => {
  const long = `C:/work/${'d'.repeat(5000)}`;
  const b = boundCwd(long);
  assert.ok(b.length <= 160);
  assert.match(b, /~[0-9a-f]{12}$/);
  assert.notEqual(b, boundCwd(`${long}x`));
  assert.equal(boundCwd('/work/alpha'), '/work/alpha');
  assert.equal(boundCwd(undefined), null);
});

test('F4 a huge cwd writes one small baseline row and later starts add none', () => {
  const fx = makeFixture();
  try {
    const cwd = `C:/work/${'d'.repeat(9000)}`;
    for (const sid of ['b1', 'b2', 'b3']) runHook(HOOK, { ...start(sid, 'claude-opus-5-5', 'high'), cwd });
    const got = jrows(fx);
    assert.equal(got.length, 1);
    assert.ok(JSON.stringify(got[0]).length < 1000);
  } finally { fx.cleanup(); }
});

test('F4 an older oversized row (over the 4 KB tail) is still found: the tail window grows', () => {
  const fx = makeFixture();
  try {
    const file = join(fx.stateDir, 'telemetry', 'settings-changes.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const big = { v: 1, at: '2026-10-10T00:00:00.000Z', session_id: 'old', cwd: 'x'.repeat(9000), model: 'claude-opus-5-5', effort: 'high', plugin_version: '0', options: 'none', changed: ['baseline'] };
    writeFileSync(file, `${JSON.stringify(big)}\n`);
    assert.equal(tailRows(file).length, 1);
    runHook(HOOK, start('n1', 'claude-opus-5-5', 'high'));
    assert.equal(jrows(fx).length, 2, 'only the plugin_version differs from the old row; no repeated baselines');
    runHook(HOOK, start('n2', 'claude-opus-5-5', 'high'));
    assert.equal(jrows(fx).length, 2);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- F5 / F6: spawn completion
const TS = '2026-10-09T08:08:30Z';
const toolResult = (uuid, ts, toolUseId, text, extra = {}) => JSON.stringify({
  type: 'user', timestamp: ts, uuid, cwd: 'C:/work/projA',
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text }] }] }, ...extra,
});

test('F5 launchAckIds: only the launch-ack shape counts, not a reply that quotes the phrase', () => {
  const ackText = toolResult('a', TS, 'tu1', 'Async agent launched successfully. (This tool result is internal metadata)');
  assert.deepEqual([...launchAckIds(ackText)], ['tu1']);
  const ackStruct = toolResult('b', TS, 'tu2', 'started', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'x' } });
  assert.deepEqual([...launchAckIds(ackStruct)], ['tu2']);
  const quoted = toolResult('c', TS, 'tu3', 'I changed how an Async agent launched ack is detected; async_launched is the status');
  assert.equal(launchAckIds(quoted).size, 0);
  const plain = toolResult('d', TS, 'tu4', 'done');
  assert.equal(launchAckIds(plain).size, 0);
  const mixed = JSON.stringify({
    type: 'user', timestamp: TS, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tuA', content: 'Async agent launched successfully.' },
      { type: 'tool_result', tool_use_id: 'tuB', content: 'a finished reply' },
    ] },
  });
  assert.deepEqual([...launchAckIds(mixed)], ['tuA']);
});

test('F6 completedOf: a parent tool_result older than a continuation does not close the spawn; a newer one does', () => {
  const facts = { done: { tu1: 1000 } };
  assert.equal(completedOf(facts, { tu: 'tu1' }), true);
  assert.equal(completedOf(facts, { tu: 'tu1', cont: 500 }), true);
  assert.equal(completedOf(facts, { tu: 'tu1', cont: 2000 }), false);
  assert.equal(completedOf({ done: {} }, { tu: 'tu1' }), false);
  assert.equal(completedOf(facts, { tu: null }), false);
});

// A one-spawn scan: the parent holds the Agent call, the worker runs; day 2026-10-08 is closed and settled at RUN_AT.
const SONNET = 'claude-sonnet-5-5';
const asst = (id, ts, content, sr = null) => JSON.stringify({
  type: 'assistant', timestamp: ts, requestId: id, uuid: `u-${id}`, cwd: 'C:/work/projA',
  message: { id: `msg_${id}`, model: SONNET, content, stop_reason: sr, usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
});
const userLine = (uuid, ts, text) => JSON.stringify({ type: 'user', timestamp: ts, uuid, cwd: 'C:/work/projA', message: { role: 'user', content: text } });
const RUN_AT = Date.parse('2026-10-09T08:10:00Z');
function put(file, lines) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); }
function spawnFixture(parentResultText, workerTail) {
  const fx = makeFixture();
  const root = join(fx.dir, 'transcripts');
  put(join(root, 'projA', 'sessC.jsonl'), [
    userLine('p1', '2026-10-09T07:49:00Z', 'operator prompt that is long enough to be a task for sure'),
    asst('mr1', '2026-10-09T07:50:00Z', [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { description: 'd', prompt: 'brief' } }]),
    ...(parentResultText === null ? [] : [toolResult('mtr', '2026-10-09T07:56:00Z', 'toolu_x', parentResultText)]),
  ]);
  const wf = join(root, 'projA', 'sessC', 'subagents', 'agent-wc.jsonl');
  mkdirSync(dirname(wf), { recursive: true });
  writeFileSync(wf.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-companion:ac-sonnet-low', description: 'd', name: 'wc', toolUseId: 'toolu_x' }));
  put(wf, [
    userLine('b', '2026-10-09T07:50:30Z', 'TYPE: explore\nROLE: lookup\nlook'),
    asst('r1', '2026-10-09T07:55:00Z', [{ type: 'text', text: 'STATUS: done\nok' }], 'end_turn'),
    ...workerTail,
  ]);
  return { fx, root };
}

test('F5 end to end: a foreground reply quoting "Async agent launched" closes the spawn at once', () => {
  const { fx, root } = spawnFixture('I changed how an Async agent launched ack is detected; async_launched is the status', []);
  try {
    resetUnitCache();
    // Remove the end_turn signal so only the parent tool_result can close it.
    const wf = join(root, 'projA', 'sessC', 'subagents', 'agent-wc.jsonl');
    put(wf, [
      userLine('b', '2026-10-09T07:50:30Z', 'TYPE: explore\nROLE: lookup\nlook'),
      asst('r2', '2026-10-09T08:08:00Z', [{ type: 'tool_use', id: 'x2', name: 'Read', input: {} }]),
    ]);
    const r = runCheckup({ root, nowT: RUN_AT, holdMs: 0 });
    assert.deepEqual(r.factsWritten, ['2026-10-08']);
  } finally { fx.cleanup(); }
});

test('F6 end to end: a worker continued after its first completion keeps the day file waiting', () => {
  const { fx, root } = spawnFixture('first reply', [
    userLine('cont', '2026-10-09T08:05:00Z', 'continue with the second part'),
    asst('r3', '2026-10-09T08:08:00Z', [{ type: 'tool_use', id: 'x3', name: 'Read', input: {} }]),
  ]);
  try {
    resetUnitCache();
    const r = runCheckup({ root, nowT: RUN_AT, holdMs: 0 });
    assert.deepEqual(r.factsWritten, [], 'the continued part is still running');
    const open = JSON.parse(readFileSync(join(factsDir(), 'open.json'), 'utf8'));
    assert.equal(open.spawns.length, 1);
    assert.equal(open.spawns[0].extraTurns, 1);
  } finally { fx.cleanup(); }
});

test('F6 end to end: the continued worker lands once it finishes (its own end_turn), with the continuation folded in', () => {
  const { fx, root } = spawnFixture('first reply', [
    userLine('cont', '2026-10-09T08:05:00Z', 'continue with the second part'),
    asst('r3', '2026-10-09T08:08:00Z', [{ type: 'text', text: 'STATUS: done\nsecond part' }], 'end_turn'),
  ]);
  try {
    resetUnitCache();
    const r = runCheckup({ root, nowT: RUN_AT, holdMs: 0 });
    assert.deepEqual(r.factsWritten, ['2026-10-08']);
    const day = JSON.parse(readFileSync(join(factsDir(), '2026-10-08.json'), 'utf8'));
    assert.equal(day.spawns.length, 1);
    assert.equal(day.spawns[0].extraTurns, 1);
    assert.equal(day.spawns[0].req.n, 2, 'both parts counted in the one record');
  } finally { fx.cleanup(); }
});
