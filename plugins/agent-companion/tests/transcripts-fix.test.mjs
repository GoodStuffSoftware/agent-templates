// lib/transcripts.mjs: the fix round after review (F1-F7, maxMs order,
// cross-file resolution). Every fixture is SYNTHETIC, built in the shape of
// real transcripts; no real transcript content is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  readTranscript, scanCorpus, gapsOf, isResumeAfterIdle, resumeAfterIdleGaps, viaOf,
} from '../scripts/lib/transcripts.mjs';
import { computeCacheTtl } from '../scripts/lib/cache-ttl.mjs';
import { buildTranscriptReport } from '../scripts/lib/transcript-report.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const MIN = 60 * 1000;
let n = 0;
const uuid = () => `fx-${++n}`;

function user(ms, { toolResult = false, isMeta = false, origin = null, text = 'hi', id } = {}) {
  const rec = {
    type: 'user', uuid: id || uuid(), timestamp: at(ms), sessionId: 's1',
    message: { role: 'user', content: toolResult ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] : [{ type: 'text', text }] },
  };
  if (isMeta) rec.isMeta = true;
  if (origin) rec.origin = { kind: origin };
  return rec;
}
function asst(ms, { requestId, read = 0, write5m = 0, write1h = 0, output = 1, id, blocks = [{ type: 'text', text: 'ok' }] } = {}) {
  return {
    type: 'assistant', uuid: id || uuid(), timestamp: at(ms), sessionId: 's1', requestId,
    message: {
      id: `msg-${requestId}`, model: 'claude-sonnet-5', content: blocks,
      usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } },
    },
  };
}
function boundary(ms, id) {
  return { type: 'system', subtype: 'compact_boundary', uuid: id || uuid(), timestamp: at(ms), compactMetadata: { trigger: 'auto', preTokens: 5000, postTokens: 300 } };
}
function write(path, recs) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// --- F1: via, ttl, resume after idle ------------------------------------------

test('F1: via tells a SendMessage (both shapes) from a prompt, a harness record and a tool result', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'p', 'sess', 'subagents', 'agent-a.jsonl');
    write(p, [
      user(0), asst(1000, { requestId: 'r1', write5m: 1000 }),
      user(2000, { toolResult: true }), asst(3000, { requestId: 'r2', read: 1000 }),
      user(20 * MIN, { isMeta: true, origin: 'coordinator' }), asst(20 * MIN + 1, { requestId: 'r3', write5m: 1000 }),
      user(40 * MIN, { text: '<teammate-message teammate_id="lead">go on</teammate-message>' }), asst(40 * MIN + 1, { requestId: 'r4', write5m: 1000 }),
      user(41 * MIN, { isMeta: true, origin: 'task-notification' }), asst(41 * MIN + 1, { requestId: 'r5', read: 1000 }),
      user(42 * MIN, { isMeta: true }), asst(42 * MIN + 1, { requestId: 'r6', read: 1000 }),
      user(43 * MIN), asst(43 * MIN + 1, { requestId: 'r7', read: 1000 }),
    ]);
    const res = await readTranscript(p, { kind: 'subagent' });
    const gs = gapsOf(res.requests);
    assert.deepEqual(gs.map((g) => g.via), ['toolResult', 'message', 'message', 'meta', 'meta', 'prompt']);
    assert.deepEqual(gs.map((g) => g.origin), [null, 'coordinator', 'teammate-message', 'task-notification', null, null]);
    assert.equal(viaOf(null), 'none');
  } finally { cleanup(); }
});

test('F1: ttl comes from the bucket the last writer wrote into, else the kind default', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const main = join(dir, 'p', 'm.jsonl');
    write(main, [
      user(0), asst(1, { requestId: 'a1', read: 0 }),
      user(MIN), asst(MIN + 1, { requestId: 'a2', write5m: 500 }),
      user(2 * MIN), asst(2 * MIN + 1, { requestId: 'a3', read: 500 }),
      user(3 * MIN), asst(3 * MIN + 1, { requestId: 'a4', read: 500, write1h: 900 }),
      user(4 * MIN), asst(4 * MIN + 1, { requestId: 'a5', read: 1400 }),
    ]);
    const gs = gapsOf((await readTranscript(main, { kind: 'main' })).requests);
    assert.deepEqual(gs.map((g) => [g.ttl, g.ttlSource]), [['1h', 'default'], ['5m', 'write'], ['5m', 'write'], ['1h', 'write']]);
    assert.equal(gs[3].ttlMs, 60 * MIN);

    const sub = join(dir, 'p', 'sess', 'subagents', 'agent-b.jsonl');
    write(sub, [user(0), asst(1, { requestId: 'b1' }), user(MIN), asst(MIN + 1, { requestId: 'b2', read: 1 })]);
    const [g] = gapsOf((await readTranscript(sub, { kind: 'subagent' })).requests);
    assert.deepEqual([g.ttl, g.ttlSource, g.kind], ['5m', 'default', 'subagent']);
  } finally { cleanup(); }
});

test('F1: a resume after idle is a prompt or a message past the TTL, never a slow tool', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'p', 'sess', 'subagents', 'agent-c.jsonl');
    write(p, [
      user(0), asst(1000, { requestId: 'r1', write5m: 1000 }),
      user(9 * MIN, { toolResult: true }), asst(9 * MIN + 1, { requestId: 'r2', write5m: 1000 }), // slow tool, expired
      user(18 * MIN, { isMeta: true, origin: 'peer' }), asst(18 * MIN + 1, { requestId: 'r3', write5m: 1000 }), // message, expired
      user(19 * MIN), asst(19 * MIN + 1, { requestId: 'r4', read: 1000 }), // prompt inside the TTL
      user(30 * MIN, { isMeta: true, origin: 'task-notification' }), asst(30 * MIN + 1, { requestId: 'r5', write5m: 1000 }),
    ]);
    const gs = gapsOf((await readTranscript(p, { kind: 'subagent' })).requests);
    const resumed = resumeAfterIdleGaps(gs);
    assert.deepEqual(resumed.map((g) => g.index), [2]);
    assert.equal(resumed[0].cause, 'idle-expiry');
    assert.equal(isResumeAfterIdle(gs[3]), false);
    assert.equal(isResumeAfterIdle(gs[3], { includeTaskNotifications: true }), true);
  } finally { cleanup(); }
});

// --- F3: cause -------------------------------------------------------------------

test('F3: a rewrite is idle-expiry past the TTL, prefix-change inside it, compaction across one', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'p', 'sess', 'subagents', 'agent-d.jsonl');
    write(p, [
      user(0), asst(1000, { requestId: 'r1', write5m: 1000 }),
      user(2 * MIN, { isMeta: true }), asst(2 * MIN + 1, { requestId: 'r2', write5m: 1000 }), // inside 5m, rewrote
      user(10 * MIN), asst(10 * MIN + 1, { requestId: 'r3', write5m: 1000 }), // past 5m
      boundary(11 * MIN), user(11 * MIN + 1), asst(11 * MIN + 2, { requestId: 'r4', write5m: 300 }),
      user(12 * MIN, { toolResult: true }), asst(12 * MIN + 1, { requestId: 'r5', read: 300, write5m: 5 }),
    ]);
    const gs = gapsOf((await readTranscript(p, { kind: 'subagent' })).requests);
    assert.deepEqual(gs.map((g) => [g.outcome, g.cause]), [
      ['rewrite', 'prefix-change'], ['rewrite', 'idle-expiry'], ['rewrite', 'compaction'], ['hit', null],
    ]);
  } finally { cleanup(); }
});

// --- F4 / D2 ---------------------------------------------------------------------

test('F4: the second of two requests with no user record between has no connecting record', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'm.jsonl');
    write(p, [user(0), asst(1000, { requestId: 'r1', read: 100 }), asst(7 * MIN, { requestId: 'r2', read: 100 })]);
    const res = await readTranscript(p, { kind: 'main' });
    assert.equal(res.requests[1].connectingUser, null);
    assert.equal(res.requests[1].startTs, T0 + 7 * MIN);
    assert.equal(gapsOf(res.requests)[0].via, 'none');
  } finally { cleanup(); }
});

test('D2: an interleaved later run moves the end time; an earlier-timestamped copy does not', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 's.jsonl');
    write(p, [
      user(0),
      asst(1000, { requestId: 'A', read: 100 }),
      asst(1500, { requestId: 'B', read: 100 }),
      asst(4000, { requestId: 'A', read: 100, output: 9, blocks: [{ type: 'tool_use', id: 't', name: 'Grep', input: {} }] }),
      asst(500, { requestId: 'A', read: 100, blocks: [{ type: 'thinking' }] }),
    ]);
    const a = (await readTranscript(p, { kind: 'subagent' })).requests.find((r) => r.id === 'A');
    assert.equal(a.endTs, T0 + 4000);
    assert.equal(a.lastBlockType, 'tool_use');
  } finally { cleanup(); }
});

// --- F2: cross-file resolution ----------------------------------------------------

test('F2: the original file owns a copied request even when the copy sorts first; usage is the max; counters say what changed', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    // b.jsonl is the original (earliest record); a.jsonl sorts first and is a
    // resumed session that starts with a copy of b's last request, written
    // before its stream finished (smaller output), then carries on.
    write(join(root, 'p', 'b.jsonl'), [
      user(0), asst(1000, { requestId: 'r0', write5m: 50 }),
      user(MIN), asst(MIN + 1000, { requestId: 'rx', read: 50, write5m: 10, output: 400 }),
    ]);
    write(join(root, 'p', 'a.jsonl'), [
      user(MIN), asst(MIN + 1000, { requestId: 'rx', read: 50, write5m: 10, output: 3 }),
      user(30 * MIN), asst(30 * MIN + 1000, { requestId: 'ry', read: 60, output: 5 }),
    ]);
    const owned = {};
    const scan = await scanCorpus({
      root,
      onFile: (res) => { for (const r of res.requests) if (!r.duplicate) owned[r.id] = { file: res.file.sessionId, output: r.usage.output, ts: r.ts }; },
    });
    assert.deepEqual(owned.rx, { file: 'b', output: 400, ts: T0 + MIN + 1000 });
    assert.equal(owned.ry.file, 'a');
    assert.deepEqual(scan.crossFile, { ids: 1, idsMaxDiffers: 1, ownerNotPathFirst: 1, compactionKeys: 0 });

    // cache-ttl resolves the same way
    const ttl = await computeCacheTtl({ days: 1, now: new Date(T0 + 40 * MIN), transcriptsRoot: root });
    assert.equal(ttl.mainRequestsScanned, 3);
    assert.equal(ttl.crossFileDuplicatesSkipped, 1);
    assert.deepEqual(ttl.crossFile, { ids: 1, idsMaxDiffers: 1, ownerNotPathFirst: 1, compactionKeys: 0 });
  } finally { cleanup(); }
});

test('F2: a copied compaction belongs to the original file, and its first request after is the original one', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const shared = [user(0), asst(1000, { requestId: 'r1', write5m: 5000 }), boundary(2000, 'bnd'), user(2001)];
    write(join(root, 'p', 'z.jsonl'), [...shared, asst(3000, { requestId: 'r2', write5m: 8000 })]);
    write(join(root, 'p', 'a.jsonl'), [...shared.slice(2), asst(3000, { requestId: 'r2', write5m: 8000 }), user(9000), asst(9001, { requestId: 'r3', read: 8000 })]);
    const got = [];
    await scanCorpus({ root, onFile: (res) => { for (const c of res.compactions) if (!c.duplicate) got.push([res.file.sessionId, c.firstRequestAfter?.contextTokens, c.requestsBefore]); } });
    assert.deepEqual(got, [['z', 8001, 1]]);
  } finally { cleanup(); }
});

// --- maxMs --------------------------------------------------------------------------

test('maxMs: a time-budgeted scan reads the newest files first and says how many it skipped', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const f = (name, ageMin) => {
      const path = join(root, name, 's.jsonl');
      write(path, [user(0), asst(1000, { requestId: `r-${name}` })]);
      const t = new Date(T0 - ageMin * MIN);
      utimesSync(path, t, t);
    };
    f('aaa', 300);
    f('mmm', 10);
    f('zzz', 200);
    let now = 0;
    const clock = () => { now += 10; return now; };
    const read = [];
    const scan = await scanCorpus({ root, maxMs: 15, clock, onFile: (res) => read.push(res.file.project) });
    assert.deepEqual(read, ['mmm']);
    assert.equal(scan.truncated, true);
    assert.equal(scan.filesSkipped, 2);
  } finally { cleanup(); }
});

// --- report and pricing ------------------------------------------------------------------

test('report: gaps split by via x ttl, and a resume-after-idle summary', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    write(join(root, 'p', 'sess', 'subagents', 'agent-q.jsonl'), [
      user(0), asst(1000, { requestId: 'r1', write5m: 1000 }),
      user(2 * MIN, { toolResult: true }), asst(2 * MIN + 1, { requestId: 'r2', read: 1000 }),
      user(20 * MIN, { isMeta: true, origin: 'coordinator' }), asst(20 * MIN + 1, { requestId: 'r3', write5m: 1000 }),
    ]);
    const r = await buildTranscriptReport({ root, days: 1, now: new Date(T0 + 60 * MIN) });
    assert.deepEqual(r.gapsByViaTtl.map((e) => [e.via, e.ttl, e.count]).sort(), [['message', '5m', 1], ['toolResult', '5m', 1]]);
    assert.equal(r.resumeAfterIdle.count, 1);
    assert.equal(r.resumeAfterIdle.causes['idle-expiry'], 1);
    assert.equal(r.interRequestGaps.reduce((s, b) => s + b.count, 0), 2);
  } finally { cleanup(); }
});

test('F7: the added prices are the live-read list prices', () => {
  const u = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.ok(Math.abs(priceUsage(u, 'claude-sonnet-4-6').usd - (3 + 15 + 0.3)) < 1e-9);
  assert.ok(Math.abs(priceUsage(u, 'claude-opus-4-7').usd - (5 + 25 + 0.5)) < 1e-9);
  assert.equal(priceUsage(u, 'claude-opus-4-7').alias, 'opus-4-7');
});
