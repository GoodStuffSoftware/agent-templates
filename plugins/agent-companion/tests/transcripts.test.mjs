// lib/transcripts.mjs ??? the shared transcript reader. Every fixture here is
// SYNTHETIC, hand-built in the shape of real Claude Code transcripts; no real
// transcript content is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import {
  readTranscript, discoverTranscripts, scanCorpus, gapsOf, spawnBaselineOf, describePath,
  CompactionTracker, readRecords, usageOf, transcriptsRoot,
} from '../scripts/lib/transcripts.mjs';
import { priceUsage, pricingTable } from '../scripts/lib/pricing.mjs';
import { parseFile, computeCacheTtl } from '../scripts/lib/cache-ttl.mjs';
import { buildTranscriptReport } from '../scripts/lib/transcript-report.mjs';

// --- fixture builders ------------------------------------------------------------

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const MIN = 60 * 1000;
let uuidN = 0;
const uuid = () => `u-${++uuidN}`;

function user(ms, { toolResult = false, isMeta = false, isCompactSummary = false, text = 'hi', id } = {}) {
  const content = toolResult ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] : [{ type: 'text', text }];
  const rec = { type: 'user', uuid: id || uuid(), timestamp: at(ms), sessionId: 's1', message: { role: 'user', content } };
  if (isMeta) rec.isMeta = true;
  if (isCompactSummary) rec.isCompactSummary = true;
  return rec;
}

function asst(ms, {
  requestId, model = 'claude-sonnet-5', input = 0, write5m = 0, write1h = 0, read = 0, output = 0,
  flatWrite, blocks = [{ type: 'text', text: 'ok' }], id, noUsage = false, noRequestId = false, messageId,
} = {}) {
  const usage = {
    input_tokens: input,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
    cache_read_input_tokens: read,
    output_tokens: output,
  };
  if (flatWrite !== undefined) { usage.cache_creation_input_tokens = flatWrite; delete usage.cache_creation; }
  const rec = {
    type: 'assistant', uuid: id || uuid(), timestamp: at(ms), sessionId: 's1',
    message: { id: messageId || `msg-${requestId}`, model, content: blocks },
  };
  if (!noUsage) rec.message.usage = usage;
  if (!noRequestId) rec.requestId = requestId;
  return rec;
}

function boundary(ms, { trigger = 'auto', preTokens = 900000, postTokens = 20000, id } = {}) {
  return {
    type: 'system', subtype: 'compact_boundary', uuid: id || uuid(), timestamp: at(ms),
    compactMetadata: { trigger, preTokens, postTokens, durationMs: 1000 },
  };
}

const attachment = (ms) => ({ type: 'attachment', uuid: uuid(), timestamp: at(ms), attachment: { kind: 'file' } });

function write(path, recs, { raw = [], noTrailingNewline = false } = {}) {
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = [...recs.map((r) => JSON.stringify(r)), ...raw];
  writeFileSync(path, lines.join('\n') + (noTrailingNewline ? '' : '\n'), 'utf8');
}

// =============================================================================
// Dedup rules D1-D5

test('D1: one request written as several lines counts once; usage is the field-wise max, not a sum', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      user(0),
      asst(1000, { requestId: 'r1', input: 5, write5m: 100, read: 50, output: 3, blocks: [{ type: 'thinking' }] }),
      asst(1500, { requestId: 'r1', input: 5, write5m: 100, read: 50, output: 40, blocks: [{ type: 'tool_use', name: 'Read' }] }),
    ]);
    const { requests } = await readTranscript(f);
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.deepEqual(r.usage, { input: 5, output: 40, cacheRead: 50, cacheWrite: 100, cacheWrite5m: 100, cacheWrite1h: 0 });
    assert.equal(r.lines, 2);
    assert.equal(r.contextTokens, 155, 'context = input + cacheRead + cacheWrite');
    assert.deepEqual(r.toolUseNames, ['Read']);
    assert.equal(r.lastBlockType, 'tool_use');
  } finally { cleanup(); }
});

test('D2: a request re-logged later in the file (earlier timestamp, smaller usage) is not a new request', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      user(0),
      asst(1000, { requestId: 'r1', input: 5, write5m: 100, output: 40 }),
      user(2000, { toolResult: true }),
      asst(3000, { requestId: 'r2', input: 5, read: 100, write5m: 20, output: 10 }),
      // re-log of r1: new uuid, earlier timestamp, partial usage
      asst(900, { requestId: 'r1', input: 1, write5m: 10, output: 2, blocks: [{ type: 'thinking' }] }),
    ]);
    const res = await readTranscript(f);
    assert.equal(res.requests.length, 2);
    assert.deepEqual(res.requests.map((r) => r.id), ['r1', 'r2'], 'the request keeps its first position');
    assert.equal(res.requests[0].usage.output, 40, 'the smaller re-logged usage does not lower the max');
    assert.equal(res.requests[0].lastBlockType, 'text', 're-logged content does not rewrite the first run');
    assert.equal(res.stats.reloggedLines, 1);
    // What cache-ttl used to do with this shape: a third request with a negative gap.
    const ttl = await parseFile(f, { kind: 'main' });
    assert.equal(ttl.length, 2);
    assert.ok(ttl.every((r) => r.gapMs == null || r.gapMs >= 0), 'no negative gap');
  } finally { cleanup(); }
});

test('D3: a line whose uuid already appeared in the file is skipped entirely', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    const a = asst(1000, { requestId: 'r1', write5m: 100, output: 5, id: 'same' });
    const copy = { ...asst(9000, { requestId: 'r9', write5m: 7, id: 'same' }) };
    write(f, [user(0), a, copy]);
    const res = await readTranscript(f);
    assert.equal(res.requests.length, 1);
    assert.equal(res.stats.duplicateUuidLines, 1);
  } finally { cleanup(); }
});

test('D4: a request copied into a second transcript counts once across files, and the gap chain survives', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const shared = [user(0), asst(1000, { requestId: 'r1', write5m: 1000, output: 5 })];
    write(join(root, 'p', 'a.jsonl'), shared);
    // b.jsonl is a resumed copy: same records, then its own request 10 minutes later
    write(join(root, 'p', 'b.jsonl'), [
      ...shared,
      user(10 * MIN, { isMeta: true }),
      asst(10 * MIN + 1000, { requestId: 'r2', read: 0, write5m: 1000, output: 5 }),
    ]);
    const seen = new Set();
    const a = await readTranscript(join(root, 'p', 'a.jsonl'), { seen });
    const b = await readTranscript(join(root, 'p', 'b.jsonl'), { seen });
    assert.equal(a.requests[0].duplicate, false);
    assert.equal(b.requests[0].duplicate, true);
    assert.equal(b.requests[1].duplicate, false);
    assert.equal(b.stats.crossFileDuplicates, 1);
    const gaps = gapsOf(b.requests);
    assert.equal(gaps.length, 1, 'the duplicate gets no gap of its own');
    assert.equal(gaps[0].gapMs, 10 * MIN, 'the next own request still measures against it');
    assert.equal(gaps[0].outcome, 'rewrite');

    let counted = 0;
    const scan = await scanCorpus({ root, onFile: (res) => { counted += res.requests.filter((r) => !r.duplicate).length; } });
    assert.equal(scan.filesRead, 2);
    assert.equal(counted, 2, 'r1 once, r2 once');
    let undeduped = 0;
    await scanCorpus({ root, crossFileDedup: false, onFile: (res) => { undeduped += res.requests.length; } });
    assert.equal(undeduped, 3);

    const now = new Date(T0 + 20 * MIN);
    const withDedup = await computeCacheTtl({ days: 1, now, transcriptsRoot: root });
    const without = await computeCacheTtl({ days: 1, now, transcriptsRoot: root, crossFileDedup: false });
    assert.equal(withDedup.mainRequestsScanned, 2);
    assert.equal(withDedup.crossFileDuplicatesSkipped, 1);
    assert.equal(without.mainRequestsScanned, 3);
  } finally { cleanup(); }
});

test('D4: a compaction copied into a second transcript counts once', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const recs = [user(0), asst(1000, { requestId: 'r1', write5m: 10 }), boundary(2000, { id: 'b1' }), user(2001, { isCompactSummary: true, id: 'sum1' })];
    write(join(root, 'p', 'a.jsonl'), recs);
    write(join(root, 'p', 'b.jsonl'), recs);
    const report = await buildTranscriptReport({ root, days: 1, now: new Date(T0 + MIN) });
    assert.equal(report.compactions.count, 1);
  } finally { cleanup(); }
});

test('D5: "<synthetic>" model lines are never requests; a line with no requestId falls back to message.id', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      user(0),
      asst(1000, { requestId: 'r1', model: '<synthetic>' }),
      asst(2000, { requestId: 'x', noRequestId: true, messageId: 'msg-only', write5m: 3 }),
      { type: 'assistant', uuid: uuid(), timestamp: at(3000), message: { model: 'claude-sonnet-5' } },
    ]);
    const res = await readTranscript(f);
    assert.equal(res.stats.syntheticLines, 1);
    assert.equal(res.stats.noKeyLines, 1);
    assert.deepEqual(res.requests.map((r) => r.id), ['msg-only']);
  } finally { cleanup(); }
});

// =============================================================================
// Robustness

test('truncated last line, unknown record types, missing usage: skipped and counted, never thrown', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'some-future-type', payload: { type: 'assistant' } },
      user(0),
      asst(1000, { requestId: 'r1', noUsage: true }),
    ], { raw: ['{"type":"assistant","requestId":"r2","message":{"model":"claude-sonn'], noTrailingNewline: true });
    const res = await readTranscript(f);
    assert.equal(res.requests.length, 1);
    assert.deepEqual(res.requests[0].usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    assert.equal(res.stats.unparseable, 1);
    assert.equal(res.stats.truncatedTail, true);
  } finally { cleanup(); }
});

test('a corrupt line in the middle of a file is not a truncated tail', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    mkdirSync(join(dir, 'p'), { recursive: true });
    writeFileSync(f, `${JSON.stringify(user(0))}\n{not json\n${JSON.stringify(asst(1000, { requestId: 'r1' }))}\n`);
    const res = await readTranscript(f);
    assert.equal(res.stats.unparseable, 1);
    assert.equal(res.stats.truncatedTail, false);
    assert.equal(res.requests.length, 1);
  } finally { cleanup(); }
});

test('a transcripts root that does not exist: no files, no throw, an empty report', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'nope');
    const d = discoverTranscripts(root);
    assert.deepEqual(d, { files: [], truncated: false, exists: false });
    const scan = await scanCorpus({ root });
    assert.equal(scan.filesRead, 0);
    assert.equal(scan.exists, false);
    const report = await buildTranscriptReport({ root });
    assert.equal(report.totals.requests, 0);
    assert.equal(report.scan.rootExists, false);
  } finally { cleanup(); }
});

test('a missing file reads as empty, not a throw', async () => {
  const res = await readTranscript(join(PLUGIN_ROOT, 'does-not-exist.jsonl'));
  assert.equal(res.requests.length, 0);
});

test('a large file streams: many requests and a very long line', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 'big.jsonl');
    mkdirSync(join(dir, 'p'), { recursive: true });
    writeFileSync(f, '');
    const N = 5000;
    let chunk = '';
    for (let i = 0; i < N; i++) {
      chunk += `${JSON.stringify(user(i * 1000))}\n${JSON.stringify(asst(i * 1000 + 500, { requestId: `r${i}`, read: i, output: 1 }))}\n`;
      if (i % 500 === 499) { appendFileSync(f, chunk); chunk = ''; }
    }
    appendFileSync(f, `${JSON.stringify(user(N * 1000, { toolResult: true, text: 'x'.repeat(2_000_000) }))}\n`);
    const res = await readTranscript(f);
    assert.equal(res.requests.length, N);
    assert.equal(res.stats.lines, 2 * N + 1);
  } finally { cleanup(); }
});

// =============================================================================
// Paths and discovery

test('describePath: Windows and POSIX separators give the same answer', () => {
  const win = describePath('C:\\Users\\you\\.claude\\projects\\proj-a\\sess-1\\subagents\\agent-abc.jsonl');
  const posix = describePath('/home/you/.claude/projects/proj-a/sess-1/subagents/agent-abc.jsonl');
  for (const d of [win, posix]) {
    assert.equal(d.kind, 'subagent');
    assert.equal(d.project, 'proj-a');
    assert.equal(d.sessionId, 'sess-1');
    assert.equal(d.agentId, 'abc');
  }
  const main = describePath('C:/Users/you/.claude/projects/proj-a/sess-1.jsonl');
  assert.deepEqual([main.kind, main.project, main.sessionId], ['main', 'proj-a', 'sess-1']);
  const wf = describePath('/r/proj/sess/subagents/workflows/wf_1/agent-z.jsonl');
  assert.deepEqual([wf.kind, wf.workflowId, wf.agentId], ['subagent', 'wf_1', 'z']);
  const journal = describePath('/r/proj/sess/subagents/workflows/wf_1/journal.jsonl');
  assert.equal(journal.kind, 'other');
});

function layout(root) {
  write(join(root, 'proj', 'sess.jsonl'), [user(0)]);
  write(join(root, 'proj', 'sess', 'subagents', 'agent-a1.jsonl'), [user(0)]);
  writeFileSync(join(root, 'proj', 'sess', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'worker', name: 'w1', model: 'sonnet' }));
  write(join(root, 'proj', 'sess', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'), [user(0)]);
  write(join(root, 'proj', 'sess', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [{ type: 'x' }]);
  write(join(root, 'proj', 'sess', 'tool-results', 'extra.jsonl'), [{ type: 'x' }]);
}

test('discovery: main, subagent with sidecar meta; workflow agents and other JSONL only when asked', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    layout(root);
    const kinds = (opts) => discoverTranscripts(root, opts).files.map((f) => `${f.kind}:${f.path.split(/[\\/]/).pop()}`).sort();
    assert.deepEqual(kinds({}), ['main:sess.jsonl', 'subagent:agent-a1.jsonl']);
    assert.deepEqual(kinds({ workflows: true }), ['main:sess.jsonl', 'subagent:agent-a1.jsonl', 'subagent:agent-w1.jsonl']);
    assert.deepEqual(kinds({ other: true }), ['main:sess.jsonl', 'other:extra.jsonl', 'other:journal.jsonl', 'subagent:agent-a1.jsonl']);
    const sub = discoverTranscripts(root).files.find((f) => f.kind === 'subagent');
    assert.deepEqual([sub.agentType, sub.agentName, sub.declaredModel, sub.sessionId, sub.agentId], ['worker', 'w1', 'sonnet', 'sess', 'a1']);
    assert.equal(discoverTranscripts(root, { maxFiles: 1 }).truncated, true);
    assert.deepEqual(kinds({ project: (n) => n !== 'proj' }), []);
  } finally { cleanup(); }
});

test('discovery anyDepth: the same set from the projects root, and subagents found from a single project dir', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    layout(root);
    const kinds = (r, opts) => discoverTranscripts(r, { anyDepth: true, ...opts }).files.map((f) => `${f.kind}:${f.path.split(/[\\/]/).pop()}`).sort();
    assert.deepEqual(kinds(root, { workflows: true, other: true }),
      ['main:sess.jsonl', 'other:extra.jsonl', 'other:journal.jsonl', 'subagent:agent-a1.jsonl', 'subagent:agent-w1.jsonl']);
    assert.deepEqual(kinds(join(root, 'proj'), { main: false }), ['subagent:agent-a1.jsonl']);
    const f = discoverTranscripts(join(root, 'proj'), { anyDepth: true, main: false }).files[0];
    assert.equal(f.sessionId, 'sess');
  } finally { cleanup(); }
});

test('transcriptsRoot: explicit argument, then AGENT_COMPANION_TRANSCRIPTS_ROOT', () => {
  const saved = process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT;
  try {
    process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT = '/env/root';
    assert.equal(transcriptsRoot('/explicit'), '/explicit');
    assert.equal(transcriptsRoot(), '/env/root');
  } finally {
    if (saved === undefined) delete process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT; else process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT = saved;
  }
});

// =============================================================================
// Usage, compactions, gaps, spawn baseline

test('usage: cache writes split by TTL bucket; a flat-only write is still the total', () => {
  assert.deepEqual(usageOf({ cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 } }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite5m: 3, cacheWrite1h: 7 });
  assert.equal(usageOf({ cache_creation_input_tokens: 42 }).cacheWrite, 42);
  assert.deepEqual(usageOf(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

test('compaction: boundary and summary pair across attachment records; pre/post, first request after, requests after', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      user(0),
      asst(1000, { requestId: 'r1', read: 900000, write5m: 100 }),
      boundary(2000, { trigger: 'auto', preTokens: 900100, postTokens: 18000 }),
      attachment(2001), attachment(2002), attachment(2003),
      user(2004, { isCompactSummary: true }),
      asst(3000, { requestId: 'r2', write5m: 60000, output: 5 }),
      user(4000, { toolResult: true }),
      asst(5000, { requestId: 'r3', read: 60000, write5m: 500 }),
    ]);
    const res = await readTranscript(f);
    assert.equal(res.compactions.length, 1);
    const c = res.compactions[0];
    assert.deepEqual([c.trigger, c.preTokens, c.postTokens, c.hasBoundary, c.hasSummary], ['auto', 900100, 18000, true, true]);
    assert.equal(c.requestsBefore, 1);
    assert.equal(c.requestsAfter, 2);
    assert.equal(c.firstRequestAfter.contextTokens, 60000);
    assert.equal(res.requests[1].connectingUser.isCompaction, true);
    assert.equal(res.requests[1].compactionsBefore, 1);
    const gaps = gapsOf(res.requests);
    assert.equal(gaps[0].afterCompaction, true);
    // the cache-TTL view sees it as a compaction cause, as before
    const ttl = await parseFile(f, { kind: 'main' });
    assert.equal(ttl[1].cause.type, 'compaction');
  } finally { cleanup(); }
});

test('CompactionTracker: a boundary no summary followed is flushed; a summary found by its wording alone pairs with nothing', () => {
  const t = new CompactionTracker();
  const b = boundary(0);
  assert.equal(t.feed(b), null);
  const ev = t.feed(asst(1, { requestId: 'r' }));
  assert.equal(ev.boundary, b);
  assert.equal(ev.summary, null);
  const worded = user(2, { text: 'This session is being continued from a previous conversation that ran out of context. ...' });
  const ev2 = t.feed(worded);
  assert.equal(ev2.boundary, null);
  assert.equal(ev2.summary, worded);
  t.feed(boundary(3));
  assert.notEqual(t.flush(), null);
  assert.equal(t.flush(), null);
});

test('gaps: start-to-start per file, with the cache outcome of the request that followed', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [
      user(0),
      asst(500, { requestId: 'r1', write5m: 1000 }),
      user(2 * MIN, { toolResult: true }),
      asst(2 * MIN + 500, { requestId: 'r2', read: 1000, write5m: 50 }),
      user(70 * MIN, { isMeta: true }),
      asst(70 * MIN + 500, { requestId: 'r3', read: 0, write5m: 1050 }),
    ]);
    const res = await readTranscript(f);
    const gaps = gapsOf(res.requests);
    assert.deepEqual(gaps.map((g) => [g.gapMs, g.band, g.outcome]), [[2 * MIN, 'lt5', 'hit'], [68 * MIN, 'gt60', 'rewrite']]);
    assert.equal(gaps[1].prevContext, 1050);
    assert.equal(gaps[1].rereadTokens, 1050);
  } finally { cleanup(); }
});

test('spawn baseline: the first request of a subagent is its cold write; a forked copy is not a cold start', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const sub = (id) => join(root, 'proj', 'sess', 'subagents', `agent-${id}.jsonl`);
    write(sub('a'), [user(0), asst(1000, { requestId: 'r1', write5m: 30000, read: 5000 })]);
    writeFileSync(sub('a').replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'worker' }));
    write(sub('b'), [user(0), asst(1000, { requestId: 'r1', write5m: 30000, read: 5000 }), user(9000), asst(9500, { requestId: 'r7', read: 35000 })]);
    writeFileSync(sub('b').replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'worker' }));
    const baselines = [];
    await scanCorpus({ root, onFile: (res) => { const b = spawnBaselineOf(res); if (b) baselines.push(b); } });
    assert.equal(baselines.length, 1);
    assert.deepEqual([baselines[0].agentType, baselines[0].contextTokens, baselines[0].cacheWrite], ['worker', 35000, 30000]);
  } finally { cleanup(); }
});

// =============================================================================
// Pricing and the report

test('priceUsage: price-derived, 1h writes at the 1h multiplier, unknown models unpriced', () => {
  const cfg = pricingTable();
  const r = priceUsage({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 2e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, 'claude-sonnet-5', cfg);
  const inP = cfg.models['sonnet-5'].in;
  assert.equal(r.basis, 'price-derived');
  assert.equal(r.alias, 'sonnet-5');
  assert.ok(Math.abs(r.usd - (inP + inP * cfg.writeMultiplier5m + inP * cfg.writeMultiplier1h)) < 1e-9);
  assert.equal(priceUsage({ input: 1 }, 'some-unknown-model', cfg), null);
});

test('transcript-report CLI: --json on a synthetic root', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const now = Date.now();
    const iso = (ms) => new Date(now - 60 * MIN + ms).toISOString();
    const recs = [
      { type: 'user', uuid: 'c1', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', uuid: 'c2', timestamp: iso(1000), requestId: 'q1', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 }, content: [] } },
      { type: 'user', uuid: 'c3', timestamp: iso(9 * MIN), message: { content: [{ type: 'tool_result' }] } },
      { type: 'assistant', uuid: 'c4', timestamp: iso(9 * MIN + 1000), requestId: 'q2', message: { id: 'm2', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 11 }, content: [] } },
    ];
    write(join(root, 'proj', 'sess.jsonl'), recs);
    const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'transcript-report.mjs'), '--json', '--days', '1', '--root', root], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env },
    });
    const r = JSON.parse(out);
    assert.equal(r.totals.requests, 2);
    assert.equal(r.costBasis, 'price-derived');
    assert.equal(r.perModel[0].model, 'claude-sonnet-5');
    assert.ok(r.perModel[0].usd > 0);
    const b = r.interRequestGaps.find((g) => g.label === '5-10m');
    assert.deepEqual([b.count, b.rewrites], [1, 1]);
    const human = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'transcript-report.mjs'), '--days', '1', '--root', root], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env },
    });
    assert.match(human, /per model \(costs are price-derived\)/);
  } finally { cleanup(); }
});

test('readRecords: prefilter skips parsing, stats count every line', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'p', 's1.jsonl');
    write(f, [user(0), asst(1, { requestId: 'r1' }), user(2)]);
    const stats = {};
    const got = [];
    for await (const rec of readRecords(f, { prefilter: (l) => l.includes('"assistant"'), stats })) got.push(rec.type);
    assert.deepEqual(got, ['assistant']);
    assert.equal(stats.lines, 3);
  } finally { cleanup(); }
});
