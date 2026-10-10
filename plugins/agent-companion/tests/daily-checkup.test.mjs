// The daily checkup (scripts/lib/daily-checkup.mjs, scripts/daily-checkup.mjs), the scout
// launch, and the SessionStart line (hooks/scout-surface.mjs). Fixtures are synthetic
// transcripts in a temp root with fixed 2026 timestamps; nothing reads the operator's
// real transcripts and nothing touches the network.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runHook, runScript } from './helpers.mjs';
import {
  unitsOf, dayStartMs, weekStartMs, dayKeyOf, runCheckup, readHistory, checkupPaths, buildDayRecord,
  scanTranscripts, readRollout, countCeilingNudges, launchCheckup, checkupDue, pendingSurface, markSurfaced,
  formatLine, resetUnitCache, DAY_MS,
} from '../scripts/lib/daily-checkup.mjs';

const T = (s) => Date.parse(s);
const NOW = T('2026-10-10T09:00:00Z'); // 09:00Z: the day 2026-10-09 (08:00Z to 08:00Z) is closed
const DAY = '2026-10-09';

// One assistant line. `cr` is cache-read tokens; the other fields default to 0.
function asst(id, ts, model, u = {}, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: id,
    uuid: extra.uuid || `u-${id}-${ts}`,
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: u.i || 0,
        output_tokens: u.o || 0,
        cache_read_input_tokens: u.cr || 0,
        cache_creation_input_tokens: (u.w5 || 0) + (u.w1 || 0),
        cache_creation: { ephemeral_5m_input_tokens: u.w5 || 0, ephemeral_1h_input_tokens: u.w1 || 0 },
      },
    },
  });
}
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
// 10M cache-read tokens: 2.0 units on Sonnet, 3.0 on Opus, 1.0 on Haiku.
const TEN_M = { cr: 10_000_000 };

function put(file, lines, { append = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const text = `${lines.join('\n')}\n`;
  if (append) appendFileSync(file, text); else writeFileSync(file, text);
}

function subFile(root, sess, agent, agentType, promptText, lines) {
  const f = join(root, 'projA', sess, 'subagents', `agent-${agent}.jsonl`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType, description: 'x', model: 'sonnet' }));
  const first = JSON.stringify({ type: 'user', timestamp: '2026-10-09T10:00:00Z', uuid: `prompt-${agent}`, message: { role: 'user', content: promptText } });
  put(f, [first, ...lines]);
  return f;
}

function mk() {
  const fx = makeFixture();
  const root = join(fx.dir, 'transcripts');
  mkdirSync(root, { recursive: true });
  return { fx, root };
}

const run = (root, nowT = NOW, extra = {}) => runCheckup({ root, nowT, holdMs: 0, ...extra });
const record = (day = DAY) => readHistory().find((r) => r.day === day);

test('unit maths: the Sonnet price vector times the plan weight', () => {
  resetUnitCache();
  // 1000 in, 500 out, 2000 5m write, 1000 1h write, 100000 read:
  // (1000*2 + 500*10 + 2000*2.5 + 1000*4 + 100000*0.2) / 1e6 = 0.036 on Sonnet
  const u = { input: 1000, output: 500, cacheRead: 100000, cacheWrite: 3000, cacheWrite5m: 2000, cacheWrite1h: 1000 };
  assert.ok(Math.abs(unitsOf(u, SONNET) - 0.036) < 1e-9);
  assert.ok(Math.abs(unitsOf(u, OPUS) - 0.054) < 1e-9, 'Opus is 1.5x');
  assert.ok(Math.abs(unitsOf(u, 'claude-haiku-4-5') - 0.018) < 1e-9, 'Haiku is 0.5x (the study constant)');
  assert.ok(Math.abs(unitsOf(u, 'claude-fable-5-1') - 0.18) < 1e-9, 'Fable is 5x (the study constant)');
  assert.ok(Math.abs(unitsOf(u, 'claude-mystery-9') - 0.054) < 1e-9, 'an unplaced model counts as Opus');
  // a flat cache write with no 5m/1h split is priced as 5m
  const flat = { input: 0, output: 0, cacheRead: 0, cacheWrite: 4_000_000, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.ok(Math.abs(unitsOf(flat, SONNET) - 10) < 1e-9);
  assert.equal(unitsOf(u, ''), unitsOf(u, 'unknown-thing'), 'no model: same as unplaced');
});

test('day and week boundaries: 08:00Z days, Friday 16:00Z weeks', () => {
  assert.equal(new Date(dayStartMs(T('2026-10-09T07:59:59Z'))).toISOString(), '2026-10-08T08:00:00.000Z');
  assert.equal(new Date(dayStartMs(T('2026-10-09T08:00:00Z'))).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(new Date(dayStartMs(T('2026-10-10T07:59:59.999Z'))).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(dayKeyOf(dayStartMs(T('2026-10-10T08:00:00Z'))), '2026-10-10');
  assert.equal(new Date(weekStartMs(T('2026-10-09T15:59:59Z'))).toISOString(), '2026-10-02T16:00:00.000Z');
  assert.equal(new Date(weekStartMs(T('2026-10-09T16:00:00Z'))).toISOString(), '2026-10-09T16:00:00.000Z');
});

test('a request belongs to the day its own timestamp is in; the week resets Friday 16:00Z inside that day', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [
      asst('a1', '2026-10-09T07:59:59Z', SONNET, TEN_M), // previous day (2.0)
      asst('a2', '2026-10-09T08:00:00Z', SONNET, TEN_M), // this day, before the week reset (2.0)
      asst('a3', '2026-10-09T15:59:59Z', SONNET, TEN_M), // this day, last second of the old week (2.0)
      asst('a4', '2026-10-09T16:00:00Z', OPUS, TEN_M), // this day, first second of the new week (3.0)
      asst('a5', '2026-10-10T07:59:59Z', SONNET, TEN_M), // this day, new week (2.0)
      asst('a6', '2026-10-10T08:00:00Z', SONNET, TEN_M), // next day (2.0)
    ]);
    run(root);
    const r = record();
    assert.ok(r, 'the 2026-10-09 line was written');
    assert.equal(r.units.main, 9);
    assert.equal(r.units.subagent, 0);
    assert.equal(r.from, '2026-10-09T08:00:00.000Z');
    assert.equal(r.to, '2026-10-10T08:00:00.000Z');
    assert.equal(r.week.start, '2026-10-09T16:00:00.000Z');
    assert.equal(r.week.units, 5, 'week so far counts from the 16:00Z reset only');
    assert.equal(r.pct.total, Math.round((9 / 2677) * 10000) / 100);
    assert.equal(r.targetPct, 14);
    // 5 units is 0.19% of 2677; the week is 16 of 168 hours old at the end of the day
    assert.equal(r.week.elapsedPct, 9.5);
    assert.equal(r.week.paceAtResetPct, Math.round(((5 / 2677) * 100 / (16 / 168)) * 10) / 10);
    assert.equal(record('2026-10-08').units.total, 2, 'the 07:59:59Z request is in the previous day');
    assert.equal(readHistory().find((x) => x.day === '2026-10-10'), undefined, 'the open day is not written');
  } finally { fx.cleanup(); }
});

test('the weekly limit and pace target are options', () => {
  const { fx, root } = mk();
  const keep = { l: process.env.CLAUDE_PLUGIN_OPTION_WEEKLY_LIMIT_UNITS, t: process.env.CLAUDE_PLUGIN_OPTION_DAILY_PACE_TARGET_PCT };
  try {
    process.env.CLAUDE_PLUGIN_OPTION_WEEKLY_LIMIT_UNITS = '100';
    process.env.CLAUDE_PLUGIN_OPTION_DAILY_PACE_TARGET_PCT = '10';
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    run(root);
    const r = record();
    assert.equal(r.limitUnits, 100);
    assert.equal(r.targetPct, 10);
    assert.equal(r.pct.total, 2);
    assert.equal(r.vsTargetPct, -8);
  } finally {
    for (const [k, v] of [['CLAUDE_PLUGIN_OPTION_WEEKLY_LIMIT_UNITS', keep.l], ['CLAUDE_PLUGIN_OPTION_DAILY_PACE_TARGET_PCT', keep.t]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fx.cleanup();
  }
});

test('incremental cursor: a later run reads only the new bytes, and no line is written twice', () => {
  const { fx, root } = mk();
  try {
    const f = join(root, 'projA', 's1.jsonl');
    put(f, [asst('a1', '2026-10-08T12:00:00Z', SONNET, TEN_M), asst('a2', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    const first = run(root, T('2026-10-10T09:00:00Z'));
    assert.ok(first.written.includes('2026-10-09'));
    assert.equal(record('2026-10-09').units.total, 2);
    const before = readHistory().length;

    const idle = run(root, T('2026-10-10T10:00:00Z'));
    assert.equal(idle.filesRead, 0, 'nothing grew: nothing is read');
    assert.equal(idle.bytesRead, 0);
    assert.deepEqual(idle.written, []);

    const size0 = statSync(f).size;
    put(f, [asst('a3', '2026-10-10T12:00:00Z', SONNET, TEN_M), asst('a4', '2026-10-10T13:00:00Z', OPUS, TEN_M)], { append: true });
    const added = statSync(f).size - size0;
    const second = run(root, T('2026-10-11T09:00:00Z'));
    assert.equal(second.filesRead, 1);
    assert.equal(second.bytesRead, added, 'exactly the appended bytes');
    assert.deepEqual(second.written, ['2026-10-10']);
    assert.equal(record('2026-10-10').units.total, 5);
    assert.equal(record('2026-10-09').units.total, 2, 'an earlier line is untouched');
    assert.equal(readHistory().length, before + 1);
    const state = JSON.parse(readFileSync(checkupPaths().state, 'utf8'));
    assert.equal(Object.values(state.files)[0].o, statSync(f).size);
  } finally { fx.cleanup(); }
});

test('a half-written last line is not consumed until it is complete', () => {
  const { fx, root } = mk();
  try {
    const f = join(root, 'projA', 's1.jsonl');
    put(f, [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    const line2 = asst('a2', '2026-10-09T13:00:00Z', SONNET, TEN_M);
    appendFileSync(f, line2.slice(0, 40)); // no newline: a write in progress
    run(root);
    assert.equal(record().units.total, 2);
    appendFileSync(f, `${line2.slice(40)}\n`);
    // the day is already written; read the totals from the scan state instead
    const scan = scanTranscripts({ root, nowT: NOW, holdMs: 0 });
    const rec = buildDayRecord(scan.state, dayStartMs(T('2026-10-09T12:00:00Z')));
    assert.equal(rec.units.total, 4, 'the completed line is counted once, at its turn');
  } finally { fx.cleanup(); }
});

test('the first run looks back at most 8 days', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [
      asst('old', '2026-09-20T12:00:00Z', SONNET, TEN_M),
      asst('edge', '2026-10-02T12:00:00Z', SONNET, TEN_M), // 8d 21h before now: outside
      asst('in', '2026-10-04T12:00:00Z', SONNET, TEN_M),
    ]);
    run(root);
    const days = readHistory().map((r) => r.day);
    assert.equal(days[0], '2026-10-03', 'the first whole day inside the 8 days');
    assert.ok(NOW - T(`${days[0]}T08:00:00Z`) <= 8 * DAY_MS);
    assert.equal(record('2026-10-03').units.total, 0);
    assert.equal(record('2026-10-04').units.total, 2);
    assert.equal(readHistory().reduce((a, r) => a + r.units.total, 0), 2, 'older requests are not counted');
    const state = JSON.parse(readFileSync(checkupPaths().state, 'utf8'));
    assert.equal(new Date(state.scanFromMs).toISOString(), '2026-10-03T08:00:00.000Z');
  } finally { fx.cleanup(); }
});

test('a request is counted once: its streamed lines (max output) and its copies in other files', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [
      asst('r1', '2026-10-09T12:00:00Z', SONNET, { o: 1 }),
      asst('r1', '2026-10-09T12:00:01Z', SONNET, { o: 1_000_000 }),
      asst('r1', '2026-10-09T12:00:02Z', SONNET, { o: 400_000 }),
    ]);
    // a forked session copies the request into a new file (same id, same timestamp)
    put(join(root, 'projA', 's2.jsonl'), [asst('r1', '2026-10-09T12:00:00Z', SONNET, { o: 1_000_000 })]);
    run(root);
    assert.equal(record().units.main, 10, '1M output tokens at 10 units per million, once');
  } finally { fx.cleanup(); }
});

test('a file written to in the last 2 minutes holds its trailing request back until the next run', () => {
  const { fx, root } = mk();
  try {
    const f = join(root, 'projA', 's1.jsonl');
    put(f, [
      asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M),
      JSON.stringify({ type: 'user', timestamp: '2026-10-09T12:00:05Z', uuid: 'tr1', message: { role: 'user', content: 'x' } }),
      asst('a2', '2026-10-09T12:01:00Z', SONNET, { o: 1 }),
    ]);
    const held = runCheckup({ root, nowT: NOW, holdMs: 10 * 60 * 1000 }); // the file was just written
    assert.equal(record().units.main, 2, 'a2 (still streaming) is not counted yet');
    const state = JSON.parse(readFileSync(checkupPaths().state, 'utf8'));
    assert.ok(Object.values(state.files)[0].o < statSync(f).size, 'the cursor stops before the trailing run');
    assert.ok(held.filesRead >= 1);
    // later the request is complete: its final line grows
    put(f, [asst('a2', '2026-10-09T12:01:02Z', SONNET, { o: 1_000_000 })], { append: true });
    const scan = scanTranscripts({ root, nowT: NOW, holdMs: 0 });
    assert.equal(buildDayRecord(scan.state, dayStartMs(T('2026-10-09T12:00:00Z'))).units.main, 12, 'a2 counted once, with its final output');
  } finally { fx.cleanup(); }
});

test('spawns by TYPE:/ROLE:/rung with units per spawn; compactions and the share above 150K', () => {
  const { fx, root } = mk();
  try {
    subFile(root, 'sess1', 'w1', 'agent-companion:ac-sonnet-high', 'TYPE: bounded-feature\nROLE: writer\n\nDo the thing.', [
      asst('w1a', '2026-10-09T10:01:00Z', SONNET, { cr: 100_000_000 }), // ctx 100M: above 150K, 20 units
      asst('w1b', '2026-10-09T10:02:00Z', SONNET, { cr: 50_000 }), // ctx 50K: 0.01 units
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T10:03:00Z', uuid: 'cb1', compactMetadata: { trigger: 'auto', preTokens: 217000 } }),
    ]);
    subFile(root, 'sess1', 'r1', 'agent-companion:ac-opus-medium', 'TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\n', [
      asst('r1a', '2026-10-09T11:00:00Z', OPUS, { cr: 10_000_000 }), // 3 units, ctx 10M
    ]);
    subFile(root, 'sess1', 'x1', 'Explore', 'Look around, no declarations here.', [
      asst('x1a', '2026-10-09T11:30:00Z', 'claude-haiku-4-5', { cr: 100_000 }), // 0.01 units
    ]);
    put(join(root, 'projA', 'sess1.jsonl'), [asst('m1', '2026-10-09T09:00:00Z', SONNET, TEN_M)]);
    run(root);
    const r = record();
    assert.equal(r.units.main, 2);
    assert.equal(r.spawns.total, 3);
    assert.equal(r.spawns.byType['bounded-feature'].n, 1);
    assert.equal(r.spawns.byType['code-review'].n, 1);
    assert.equal(r.spawns.byType.none.n, 1);
    assert.equal(r.spawns.byRole.writer.n, 1);
    assert.equal(r.spawns.byRole.reviewer.n, 1);
    assert.equal(r.spawns.byRung['sonnet/high'].n, 1);
    assert.equal(r.spawns.byRung['opus/medium'].n, 1);
    assert.equal(r.spawns.byRung.Explore.n, 1);
    assert.equal(r.spawns.byRung['sonnet/high'].units, 20);
    assert.equal(r.spawns.byRung['sonnet/high'].unitsPerSpawn, 20.01);
    assert.equal(r.spawns.byRung['opus/medium'].unitsPerSpawn, 3);
    assert.equal(r.spawns.byType['code-review'].units, 3);
    assert.equal(r.subagent.compactions, 1);
    assert.equal(r.subagent.compactionsPer100Spawns, 33.3);
    // above 150K: w1a (20) and r1a (3) of 23.02 subagent units
    assert.equal(r.subagent.unitsOver150k, 23);
    assert.equal(r.subagent.shareOver150kPct, Math.round((23 / 23.02) * 1000) / 10);
  } finally { fx.cleanup(); }
});

test('a later run adds units to a subagent file without counting its spawn again', () => {
  const { fx, root } = mk();
  try {
    const f = subFile(root, 'sess1', 'w1', 'agent-companion:ac-sonnet-low', 'TYPE: mechanical-edit\nROLE: fixer\n', [
      asst('w1a', '2026-10-09T10:01:00Z', SONNET, TEN_M),
    ]);
    run(root);
    put(f, [asst('w1b', '2026-10-09T10:05:00Z', SONNET, TEN_M)], { append: true });
    const scan = scanTranscripts({ root, nowT: NOW, holdMs: 0 });
    const rec = buildDayRecord(scan.state, dayStartMs(T('2026-10-09T12:00:00Z')));
    assert.equal(rec.spawns.total, 1);
    assert.equal(rec.spawns.byRole.fixer.units, 4);
    assert.equal(rec.spawns.byRole.fixer.unitsPerSpawn, 4);
  } finally { fx.cleanup(); }
});

test('rollout tagging: active and switched-on changes; a missing, corrupt or odd rollout file records none', () => {
  const { fx, root } = mk();
  try {
    const rollout = join(fx.stateDir, 'rollout.json');
    assert.deepEqual(readRollout(), [], 'absent');
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(rollout, '{ not json');
    assert.deepEqual(readRollout(), [], 'corrupt');
    writeFileSync(rollout, '["a"]');
    assert.deepEqual(readRollout(), [], 'wrong shape');
    // a BOM (PowerShell 5.1) is tolerated; a zoneless time is UTC; junk values are skipped
    writeFileSync(rollout, `﻿${JSON.stringify({
      'earlier-change': '2026-10-08T08:00:00Z',
      'this-day-change': '2026-10-09T08:00:00Z',
      'zoneless-change': '2026-10-09T20:00:00',
      'next-day-change': '2026-10-10T08:00:00Z',
      'bad-change': 'soon',
      'number-change': 5,
    })}`);
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    run(root);
    const r = record();
    assert.deepEqual(r.changes.active.map((c) => c.id), ['earlier-change', 'this-day-change', 'zoneless-change']);
    assert.deepEqual(r.changes.switchedOn, ['this-day-change', 'zoneless-change']);
    assert.equal(r.changes.active[2].activeFrom, '2026-10-09T20:00:00.000Z');
    assert.deepEqual(record('2026-10-08').changes.switchedOn, ['earlier-change']);
    assert.deepEqual(record('2026-10-04').changes.active, []);
  } finally { fx.cleanup(); }
});

test('no rollout file: the record names no changes', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    run(root);
    assert.deepEqual(record().changes, { active: [], switchedOn: [] });
  } finally { fx.cleanup(); }
});

test('context-ceiling nudges are counted from the telemetry log; a missing or damaged log is 0 or skipped', () => {
  const { fx, root } = mk();
  try {
    const a = T('2026-10-09T08:00:00Z');
    assert.equal(countCeilingNudges(a, a + DAY_MS), 0, 'missing log');
    const log = join(fx.stateDir, 'telemetry', 'context-ceiling.jsonl');
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, [
      JSON.stringify({ at: '2026-10-09T07:59:59Z', agent_id: 'a' }),
      JSON.stringify({ at: '2026-10-09T08:00:00Z', agent_id: 'b', tier: 1 }),
      'not json',
      JSON.stringify({ at: '2026-10-09T20:00:00Z', agent_id: 'c', tier: 2 }),
      JSON.stringify({ at: '2026-10-10T08:00:00Z', agent_id: 'd' }),
      JSON.stringify({ agent_id: 'no time' }),
    ].join('\n'));
    assert.equal(countCeilingNudges(a, a + DAY_MS), 2);
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    run(root);
    assert.equal(record().ceilingNudges, 2);
    assert.equal(record('2026-10-08').ceilingNudges, 1);
  } finally { fx.cleanup(); }
});

test('missing or corrupt input stays quiet: no transcripts, a bad state file, a bad seen file, junk lines', () => {
  const { fx, root } = mk();
  try {
    // corrupt state and seen files: treated as a first run, never thrown
    mkdirSync(dirname(checkupPaths().state), { recursive: true });
    writeFileSync(checkupPaths().state, '{{{ broken');
    writeFileSync(checkupPaths().seen, Buffer.from([1, 2, 3]));
    put(join(root, 'projA', 's1.jsonl'), [
      'garbage that is not json',
      '{"type":"assistant","message":{"usage":{}}}',
      asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M),
      '{"type":"assistant","timestamp":"2026-10-09T12:00:00Z","message":{"model":"<synthetic>","usage":{"input_tokens":5}}}',
      '{"type":"assistant", broken "usage"',
    ]);
    assert.doesNotThrow(() => run(root));
    assert.equal(record().units.total, 2);
  } finally { fx.cleanup(); }
});

test('an empty machine (no transcripts root) writes zero days and throws nothing', () => {
  const { fx } = mk();
  try {
    const empty = run(join(fx.dir, 'no-such-root'));
    assert.equal(empty.filesSeen, 0);
    assert.ok(readHistory().length >= 7);
    assert.ok(readHistory().every((r) => r.units.total === 0));
  } finally { fx.cleanup(); }
});

test('the CLI writes the history and exits 0 even when the transcripts root is missing', () => {
  const { fx, root } = mk();
  try {
    put(join(root, 'projA', 's1.jsonl'), [asst('a1', '2026-10-09T12:00:00Z', SONNET, TEN_M)]);
    const ok = runScript('scripts/daily-checkup.mjs', ['--root', root, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0']);
    assert.equal(ok.status, 0);
    assert.ok(ok.json.written.includes('2026-10-09'));
    assert.equal(record().units.total, 2);
    assert.ok(!existsSync(checkupPaths().lock), 'the lock is released');
    const bad = runScript('scripts/daily-checkup.mjs', ['--root', join(fx.dir, 'nope'), '--now', '2026-10-12T09:00:00Z']);
    assert.equal(bad.status, 0);
  } finally { fx.cleanup(); }
});

// --- launch -------------------------------------------------------------------------------

function withLaunchEnabled(fn) {
  const keep = process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH;
  delete process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH;
  try { return fn(); } finally { if (keep !== undefined) process.env.AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH = keep; }
}

test('launch: one detached, hidden, ignored-stdio process, only when due, at most once per 3 hours', () => {
  const { fx } = mk();
  try {
    const calls = [];
    const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.at(-1).unref = true; } }; };
    withLaunchEnabled(() => {
      assert.equal(checkupDue(NOW), true);
      const a = launchCheckup({ nowT: NOW, spawnFn });
      assert.equal(a.launched, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, process.execPath);
      assert.match(calls[0].args[0], /daily-checkup\.mjs$/);
      assert.equal(calls[0].opts.detached, true);
      assert.equal(calls[0].opts.windowsHide, true);
      assert.equal(calls[0].opts.stdio, 'ignore');
      assert.equal(calls[0].unref, true);
      assert.equal(launchCheckup({ nowT: NOW + 60 * 60 * 1000, spawnFn }).launched, false, 'within 3 hours of the attempt');
      assert.equal(launchCheckup({ nowT: NOW + 4 * 60 * 60 * 1000, spawnFn }).launched, true, 'a failed run is retried later');
    });
    // a finished run for the latest closed day makes it not due
    withLaunchEnabled(() => {
      runCheckup({ root: join(fx.dir, 'nope'), nowT: NOW, holdMs: 0 });
      assert.equal(checkupDue(NOW + 5 * 60 * 60 * 1000), false);
      assert.equal(launchCheckup({ nowT: NOW + 5 * 60 * 60 * 1000, spawnFn }).launched, false);
      assert.equal(checkupDue(NOW + DAY_MS), true, 'the next closed day is due');
    });
  } finally { fx.cleanup(); }
});

test('launch: off by option and by environment', () => {
  const { fx } = mk();
  const keep = process.env.CLAUDE_PLUGIN_OPTION_DAILY_CHECKUP;
  try {
    const calls = [];
    const spawnFn = () => { calls.push(1); return { unref() {} }; };
    assert.equal(launchCheckup({ nowT: NOW, spawnFn }).launched, false, 'the suite environment forbids it');
    withLaunchEnabled(() => {
      process.env.CLAUDE_PLUGIN_OPTION_DAILY_CHECKUP = 'false';
      assert.equal(launchCheckup({ nowT: NOW, spawnFn }).launched, false);
    });
    assert.equal(calls.length, 0);
  } finally {
    if (keep === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_DAILY_CHECKUP; else process.env.CLAUDE_PLUGIN_OPTION_DAILY_CHECKUP = keep;
    fx.cleanup();
  }
});

test('a main session start launches the checkup in the background and does not wait for it', async () => {
  const { fx, root } = mk();
  try {
    const t0 = Date.now();
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's-main', cwd: fx.dir }, {
      cwd: fx.dir,
      env: { AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH: '', AGENT_COMPANION_TRANSCRIPTS_ROOT: root },
    });
    assert.equal(res.status, 0);
    assert.ok(Date.now() - t0 < 10000);
    // the detached child writes its status when it finishes
    const deadline = Date.now() + 20000;
    let status = null;
    while (Date.now() < deadline) {
      try { status = JSON.parse(readFileSync(checkupPaths().status, 'utf8')); } catch { /* not yet */ }
      if (status && status.lastRunMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(status && status.lastRunMs, 'the background run finished');
    assert.ok(existsSync(checkupPaths().history));
  } finally { fx.cleanup(); }
});

test('a subagent session start launches nothing', () => {
  const { fx, root } = mk();
  try {
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's', agent_id: 'agent-x', cwd: fx.dir }, {
      cwd: fx.dir,
      env: { AGENT_COMPANION_DAILY_CHECKUP_NO_LAUNCH: '', AGENT_COMPANION_TRANSCRIPTS_ROOT: root },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
    assert.ok(!existsSync(checkupPaths().status), 'no attempt was recorded');
  } finally { fx.cleanup(); }
});

// --- the SessionStart line -----------------------------------------------------------------

function seedHistory(fx, rows) {
  mkdirSync(dirname(checkupPaths().history), { recursive: true });
  writeFileSync(checkupPaths().history, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

function recFor(day, total, extra = {}) {
  const start = T(`${day}T08:00:00Z`);
  return {
    v: 1, day, from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString(),
    pct: { main: 1, subagent: total - 1, total }, targetPct: 14, vsTargetPct: Math.round((total - 14) * 100) / 100,
    week: { pctSoFar: 30.4, paceAtResetPct: 98.1 }, changes: { active: [], switchedOn: [] }, ...extra,
  };
}

const hookEnv = (fx) => ({ cwd: fx.dir });

test('SessionStart: one line for a main session, once per day, naming the day, target, week, changes and history path', () => {
  const { fx } = mk();
  try {
    seedHistory(fx, [recFor('2026-10-08', 9), recFor(DAY, 17.25, { changes: { active: [], switchedOn: ['ceiling-hook', 'sonnet-medium'] } })]);
    const fake = { AGENT_COMPANION_FAKE_NOW: '2026-10-10T09:00:00Z' };
    const first = runHook('hooks/scout-surface.mjs', { session_id: 's1', cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.equal(first.status, 0);
    const ctx = first.json.hookSpecificOutput.additionalContext;
    assert.equal(ctx.split('\n').length, 1, 'one line');
    assert.match(ctx, /Daily checkup 2026-10-09/);
    assert.match(ctx, /17\.3% of the weekly limit against the 14% target \(\+3\.3\)/);
    assert.match(ctx, /week so far 30\.4%, pace at reset 98\.1%/);
    assert.match(ctx, /switched on that day: ceiling-hook, sonnet-medium/);
    assert.ok(ctx.includes(checkupPaths().history), 'names the history path');
    const second = runHook('hooks/scout-surface.mjs', { session_id: 's2', cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.equal(second.stdout.trim(), '', 'already shown today');
    seedHistory(fx, [recFor('2026-10-08', 9), recFor(DAY, 17.25), recFor('2026-10-10', 6)]);
    const next = runHook('hooks/scout-surface.mjs', { session_id: 's3', cwd: fx.dir }, { ...hookEnv(fx), env: { AGENT_COMPANION_FAKE_NOW: '2026-10-11T09:00:00Z' } });
    assert.match(next.json.hookSpecificOutput.additionalContext, /Daily checkup 2026-10-10.*6% of the weekly limit.*\(-8\)/);
    assert.doesNotMatch(next.json.hookSpecificOutput.additionalContext, /switched on/, 'no changes that day: no clause');
  } finally { fx.cleanup(); }
});

test('SessionStart: a subagent gets nothing and does not use up the day', () => {
  const { fx } = mk();
  try {
    seedHistory(fx, [recFor(DAY, 17)]);
    const fake = { AGENT_COMPANION_FAKE_NOW: '2026-10-10T09:00:00Z' };
    const sub = runHook('hooks/scout-surface.mjs', { session_id: 's1', agent_id: 'agent-abc', cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.equal(sub.stdout.trim(), '');
    const viaPath = runHook('hooks/scout-surface.mjs', { session_id: 's1', transcript_path: join(fx.dir, 'p', 's', 'subagents', 'agent-q.jsonl'), cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.equal(viaPath.stdout.trim(), '');
    const main = runHook('hooks/scout-surface.mjs', { session_id: 's2', cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.match(main.json.hookSpecificOutput.additionalContext, /Daily checkup 2026-10-09/);
  } finally { fx.cleanup(); }
});

test('SessionStart: a missing, empty or corrupt history is silent; an old line is not news', () => {
  const { fx } = mk();
  try {
    const fake = { AGENT_COMPANION_FAKE_NOW: '2026-10-10T09:00:00Z' };
    const go = (id) => runHook('hooks/scout-surface.mjs', { session_id: id, cwd: fx.dir }, { ...hookEnv(fx), env: fake });
    assert.equal(go('a').stdout.trim(), '', 'no history file');
    seedHistory(fx, ['']);
    assert.equal(go('b').stdout.trim(), '', 'empty');
    seedHistory(fx, ['{ not json', 'also not', '[1,2]', '{"day":"2026-10-09"}', '{"day":"2026-10-09","pct":{"total":"x"},"week":{}}']);
    assert.equal(go('c').stdout.trim(), '', 'garbage and records without numbers');
    seedHistory(fx, [recFor('2026-10-01', 12)]);
    assert.equal(go('d').stdout.trim(), '', 'a line more than 3 days old');
    // a damaged last line falls back to the last good one
    seedHistory(fx, [recFor(DAY, 12), '{"day":"2026-10-1']);
    assert.match(go('e').json.hookSpecificOutput.additionalContext, /Daily checkup 2026-10-09/);
    // corrupt surfaced marker: the line shows again rather than failing
    writeFileSync(checkupPaths().surfaced, 'garbage');
    assert.match(go('f').json.hookSpecificOutput.additionalContext, /Daily checkup 2026-10-09/);
  } finally { fx.cleanup(); }
});

test('SessionStart: the daily_checkup option off silences the line', () => {
  const { fx } = mk();
  try {
    seedHistory(fx, [recFor(DAY, 17)]);
    const res = runHook('hooks/scout-surface.mjs', { session_id: 's1', cwd: fx.dir }, {
      ...hookEnv(fx), env: { AGENT_COMPANION_FAKE_NOW: '2026-10-10T09:00:00Z', CLAUDE_PLUGIN_OPTION_DAILY_CHECKUP: 'false' },
    });
    assert.equal(res.stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('pendingSurface / markSurfaced / formatLine in-process', () => {
  const { fx } = mk();
  try {
    seedHistory(fx, [recFor(DAY, 20)]);
    const p = pendingSurface({ nowT: NOW });
    assert.equal(p.rec.day, DAY);
    assert.match(p.line, /^\[agent-companion\] Daily checkup 2026-10-09 \(08:00Z to 08:00Z\): 20% of the weekly limit against the 14% target \(\+6\)/);
    markSurfaced(DAY);
    assert.equal(pendingSurface({ nowT: NOW }), null);
    assert.equal(formatLine(recFor(DAY, 5), '/h').endsWith('History: /h'), true);
    assert.equal(dayKeyOf(dayStartMs(NOW)), '2026-10-10');
  } finally { fx.cleanup(); }
});
