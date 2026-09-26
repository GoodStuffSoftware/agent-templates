// Review findings against lib/transcripts.mjs (track "reader" review).
// Each test pins a finding and FAILS on the reviewed SHA; the fix makes it
// pass. Every fixture is SYNTHETIC, built in the shape of real transcripts;
// the numbers in comments are aggregates measured on a real corpus, nothing
// copied from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { readTranscript, scanCorpus, gapsOf } from '../scripts/lib/transcripts.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const MIN = 60 * 1000;
let n = 0;
const uuid = () => `rv-${++n}`;

const user = (ms, { toolResult = false } = {}) => ({
  type: 'user', uuid: uuid(), timestamp: at(ms), sessionId: 's1',
  message: { role: 'user', content: toolResult ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] : [{ type: 'text', text: 'hi' }] },
});
const asst = (ms, { requestId, read = 0, write5m = 0, output = 1, blocks = [{ type: 'text', text: 'ok' }], id } = {}) => ({
  type: 'assistant', uuid: id || uuid(), timestamp: at(ms), sessionId: 's1', requestId,
  message: {
    id: `msg-${requestId}`, model: 'claude-sonnet-5', content: blocks,
    usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: 0 } },
  },
});
const write = (path, recs, prefix = '') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, prefix + recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

// RF1. D4 says cross-file copies are identical, so which file claims one does
// not matter. Measured on a real corpus: 6,832 of 29,089 multi-file
// requestIds differ between copies (output_tokens in all of them; a copy
// captured before the stream finished), and path order claimed the smaller
// copy in 892. The claimed copy must carry the field-wise max (D1) across
// every copy, or totals undercount.
test('RF1: a cross-file copy with a larger usage than the claimed copy still feeds the max', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    // a.jsonl sorts first and holds a partial copy; b.jsonl holds the full request.
    write(join(root, 'p', 'a.jsonl'), [user(0), asst(1000, { requestId: 'req-x', read: 100, output: 3, id: 'ua' })]);
    write(join(root, 'p', 'b.jsonl'), [user(0), asst(1000, { requestId: 'req-x', read: 100, output: 500, id: 'ub' })]);
    let out = 0;
    await scanCorpus({ root, onFile: (res) => { for (const r of res.requests) if (!r.duplicate) out += r.usage.output; } });
    assert.equal(out, 500);
  } finally { cleanup(); }
});

// RF2. gapsOf outcome 'hit' means cacheRead >= cacheWrite. A request that
// read the whole previous context back and then appended more than that
// (a large tool result or attachment) is a cache HIT, but the rule calls it a
// rewrite. Seen on real data at a few-second gap: read 35,936 of a 35,938
// previous context, write 42,840.
test('RF2: a full cache read followed by a large append is a hit, not a rewrite', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'm.jsonl');
    write(p, [
      user(0), asst(1000, { requestId: 'r1', read: 35000, write5m: 938 }),
      user(8000, { toolResult: true }), asst(9000, { requestId: 'r2', read: 35936, write5m: 42840 }),
    ]);
    const res = await readTranscript(p, { kind: 'main' });
    const [g] = gapsOf(res.requests);
    assert.equal(g.outcome, 'hit');
  } finally { cleanup(); }
});

// RF3. A request's start is the last user record seen, which is never
// consumed: two requests with no user record between them share one start,
// and the gap reads 0 however long it really was (4 of 139,783 pairs in 30
// days on a real corpus; one of them a >5 min gap that came back a rewrite).
test('RF3: with no user record between two requests, the second start is its own first line', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'm.jsonl');
    write(p, [user(0), asst(1000, { requestId: 'r1', read: 100 }), asst(7 * MIN, { requestId: 'r2', write5m: 100 })]);
    const res = await readTranscript(p, { kind: 'main' });
    const [g] = gapsOf(res.requests);
    assert.ok(g.gapMs >= 6 * MIN, `gapMs ${g.gapMs}`);
    assert.equal(g.band, '5to60');
  } finally { cleanup(); }
});

// RF4. A UTF-8 byte-order mark makes the first line unparseable, so its
// record is lost (counted as unparseable, not thrown).
test('RF4: a leading byte-order mark does not cost the first record', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'm.jsonl');
    write(p, [asst(1000, { requestId: 'r1', read: 100 }), user(2000), asst(3000, { requestId: 'r2', read: 100 })], '﻿');
    const res = await readTranscript(p, { kind: 'main' });
    assert.equal(res.requests.length, 2);
    assert.equal(res.stats.unparseable, 0);
  } finally { cleanup(); }
});

// RF5. The advisor's resume guard needs "resumed after idle", not "a slow
// tool". On a real 30-day corpus, 707 subagent gaps past the 5 min TTL were
// tool round-trips against 401 after a prompt, and the report's resumeGaps
// buckets mix both (and main 1h with subagent 5m). gapsOf should say what
// connected the two requests.
test('RF5: gapsOf says whether a gap was a tool round-trip, a prompt or a compaction', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 'm.jsonl');
    write(p, [
      user(0), asst(1000, { requestId: 'r1', read: 100, blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      user(8 * MIN, { toolResult: true }), asst(8 * MIN + 1000, { requestId: 'r2', write5m: 100 }),
      user(20 * MIN), asst(20 * MIN + 1000, { requestId: 'r3', write5m: 100 }),
    ]);
    const res = await readTranscript(p, { kind: 'main' });
    const gs = gapsOf(res.requests);
    assert.deepEqual(gs.map((g) => g.via), ['toolResult', 'prompt']);
  } finally { cleanup(); }
});

// RF6. The D2 path (a request whose lines resume after another request's
// lines) merges usage but drops the content: tool_use names on the later
// lines are lost. On a real corpus D2 fires only for such interleaves (374
// lines, all <100 lines apart, later timestamps, output growing).
test('RF6: an interleaved request keeps the tool_use names from its later lines', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const p = join(dir, 's.jsonl');
    write(p, [
      user(0),
      asst(1000, { requestId: 'A', read: 100, output: 3 }),
      asst(1500, { requestId: 'B', read: 100, output: 3 }),
      asst(2000, { requestId: 'A', read: 100, output: 900, blocks: [{ type: 'tool_use', id: 't9', name: 'Grep', input: {} }] }),
    ]);
    const res = await readTranscript(p, { kind: 'subagent' });
    const a = res.requests.find((r) => r.id === 'A');
    assert.equal(a.usage.output, 900);
    assert.ok(a.toolUseNames.includes('Grep'), `toolUseNames ${JSON.stringify(a.toolUseNames)}`);
  } finally { cleanup(); }
});

// RF7. Models present in a real corpus with no price: claude-sonnet-4-6
// (8,927 requests over the whole corpus, 395 in the last 30 days) and
// claude-opus-4-7 (815). Their spend is left out of every total. Prices must
// come from a live lookup before they are added to config/model-pricing.json.
test('RF7: older model ids seen in real transcripts are priced', () => {
  const u = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.ok(priceUsage(u, 'claude-sonnet-4-6'), 'claude-sonnet-4-6 unpriced');
  assert.ok(priceUsage(u, 'claude-opus-4-7'), 'claude-opus-4-7 unpriced');
});
