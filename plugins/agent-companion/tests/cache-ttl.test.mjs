import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  parseFile, computeCacheTtl, classifyPricing, breakEvenSharePct, clamp,
  costToday, costWith1h, pricingTable,
} from '../scripts/lib/cache-ttl.mjs';

// --- fixture builders --------------------------------------------------------

function userLine(ts, { toolResult = false, isMeta = false, text = 'hi' } = {}) {
  const content = toolResult
    ? [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }]
    : [{ type: 'text', text }];
  const rec = { type: 'user', timestamp: ts, message: { role: 'user', content } };
  if (isMeta) rec.isMeta = true;
  return JSON.stringify(rec);
}

// usage keys: input, write5m, write1h, read, output — write total is derived
// unless writeFlatOverride is given (to exercise the flat-field fallback).
function assistantLine(ts, {
  requestId, model = 'claude-sonnet-5-20260101', input = 0, write5m = 0, write1h = 0,
  read = 0, output = 0, writeFlatOverride, blocks = [{ type: 'text', text: 'ok' }],
} = {}) {
  const usage = {
    input_tokens: input,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
    cache_read_input_tokens: read,
    output_tokens: output,
  };
  if (writeFlatOverride !== undefined) usage.cache_creation_input_tokens = writeFlatOverride;
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId,
    message: { id: requestId, model, usage, content: blocks },
  });
}

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const plusMs = (ms) => new Date(T0 + ms).toISOString();

function writeLines(path, lines) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

// =============================================================================

test('dedupe of multi-line responses: one request, usage = max across lines', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'one.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      // Streamed usage: the same requestId appears twice, second line carries
      // the final (larger) token counts. Must be counted as ONE request with
      // the MAX of each field, not summed and not counted twice.
      assistantLine(plusMs(1000), { requestId: 'r1', input: 100, write5m: 50, read: 0, output: 10 }),
      assistantLine(plusMs(1500), { requestId: 'r1', input: 100, write5m: 80, read: 0, output: 40 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests.length, 1, 'two lines sharing a requestId must collapse into one request');
    assert.equal(requests[0].usage.write5m, 80, 'usage takes the MAX across the request\'s lines');
    assert.equal(requests[0].usage.write, 80);
    assert.equal(requests[0].usage.output, 40);
  } finally {
    cleanup();
  }
});

test('band classification at 4:59 / 5:01 / 60:01', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const cases = [
      { label: '4:59', gapMs: 4 * 60000 + 59000, expect: 'lt5' },
      { label: '5:01', gapMs: 5 * 60000 + 1000, expect: '5to60' },
      { label: '60:01', gapMs: 60 * 60000 + 1000, expect: 'gt60' },
    ];
    for (const c of cases) {
      const file = join(dir, `band-${c.label.replace(':', '-')}.jsonl`);
      writeLines(file, [
        userLine(plusMs(0)),
        assistantLine(plusMs(0), { requestId: 'r1', input: 10, write5m: 10 }),
        userLine(plusMs(c.gapMs), { isMeta: true }),
        assistantLine(plusMs(c.gapMs), { requestId: 'r2', input: 10, write5m: 10 }),
      ]);
      const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
      assert.equal(requests.length, 2);
      assert.equal(requests[0].band, null, 'the first request in a file has no gap');
      assert.equal(requests[1].band, c.expect, `gap of ${c.label} must classify as ${c.expect}`);
    }
  } finally {
    cleanup();
  }
});

test('conversion clamp: clamps to [0, this request\'s write]', async () => {
  // clamp(prevPrefix - read, 0, write); prevPrefix = prev.input + prev.write + prev.read
  assert.equal(clamp(1400, 0, 200), 200, 'clamps DOWN to write when the raw value overshoots it');
  assert.equal(clamp(-50, 0, 200), 0, 'clamps UP to 0 when the raw value is negative');
  assert.equal(clamp(120, 0, 200), 120, 'passes through unchanged when already inside the bounds');

  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'conv.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      // prev request: input=1000, write=500, read=0 -> prevPrefix = 1500
      assistantLine(plusMs(0), { requestId: 'r1', input: 1000, write5m: 500, read: 0 }),
      userLine(plusMs(6 * 60000), { toolResult: true }),
      // this request lands in the 5-60 band; read=100, write=200
      // raw = prevPrefix(1500) - read(100) = 1400, clamped to this write (200) -> 200
      assistantLine(plusMs(6 * 60000), { requestId: 'r2', input: 10, write5m: 200, read: 100 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests[1].band, '5to60');
    assert.equal(requests[1].convertedTokens, 200, 'converted tokens clamp to the CURRENT request\'s write, not the raw prefix delta');
  } finally {
    cleanup();
  }
});

test('gap cause: long tool call (tool_result carried by the connecting user line)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'cause-tool.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), {
        requestId: 'r1', input: 10, write5m: 10,
        blocks: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }],
      }),
      userLine(plusMs(10 * 60000), { toolResult: true }),
      assistantLine(plusMs(10 * 60000), { requestId: 'r2', input: 10, write5m: 10 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests[1].band, '5to60');
    assert.equal(requests[1].cause.type, 'long-tool-call');
    assert.deepEqual(requests[1].cause.toolNames, ['Bash']);
    assert.equal(requests[1].cause.waitMs, 10 * 60000);
  } finally {
    cleanup();
  }
});

test('gap cause: resume by lead (previous turn ended with text; next input isMeta)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'cause-resume.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), {
        requestId: 'r1', input: 10, write5m: 10,
        blocks: [{ type: 'text', text: 'done for now' }],
      }),
      userLine(plusMs(20 * 60000), { isMeta: true }),
      assistantLine(plusMs(20 * 60000), { requestId: 'r2', input: 10, write5m: 10 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests[1].band, '5to60');
    assert.equal(requests[1].cause.type, 'resume-by-lead');
  } finally {
    cleanup();
  }
});

test('gap cause: neither shape -> unknown', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'cause-unknown.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), { requestId: 'r1', input: 10, write5m: 10, blocks: [{ type: 'text', text: 'done' }] }),
      userLine(plusMs(15 * 60000)), // plain text, not isMeta, no tool_result
      assistantLine(plusMs(15 * 60000), { requestId: 'r2', input: 10, write5m: 10 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests[1].cause.type, 'unknown');
  } finally {
    cleanup();
  }
});

test('cost math against a hand-computed expected value', () => {
  const price = { in: 2, out: 10, readMultiplier: 0.1 }; // sonnet-5 shape
  const usage = { input: 1_000_000, write: 200_000, read: 500_000, output: 100_000 };
  // Cost today = I*in + W*1.25*in + R*rm*in + O*out   (in/out per-token, $/MTok / 1e6)
  const inUsd = 2 / 1e6;
  const outUsd = 10 / 1e6;
  const expectedToday = 1_000_000 * inUsd + 200_000 * 1.25 * inUsd + 500_000 * 0.1 * inUsd + 100_000 * outUsd;
  assert.equal(costToday(usage, price), expectedToday);
  assert.ok(Math.abs(expectedToday - 3.6) < 1e-9, `sanity on the hand math itself: ${expectedToday}`);

  // Cost with 1h, conv = 50,000: (W-conv)*2*in + (R+conv)*rm*in, rest unchanged.
  const conv = 50_000;
  const expected1h = 1_000_000 * inUsd + (200_000 - conv) * 2 * inUsd + (500_000 + conv) * 0.1 * inUsd + 100_000 * outUsd;
  assert.equal(costWith1h({ ...usage, conv }, price), expected1h);
});

test('break-even formula: 0.75 / (2 - rm)', () => {
  assert.ok(Math.abs(breakEvenSharePct(0.1) - (0.75 / 1.9) * 100) < 1e-9);
  assert.ok(Math.abs(breakEvenSharePct(0.05) - (0.75 / 1.95) * 100) < 1e-9, 'Opus 5.5 read multiplier');
  assert.ok(Math.abs(breakEvenSharePct(0.025) - (0.75 / 1.975) * 100) < 1e-9, 'Fable 5.1 read multiplier');
});

test('pricing table: specific patterns win over their generic prefix (opus-5-5 vs opus-5, fable-5-1 vs fable-5)', () => {
  const cfg = pricingTable();
  assert.equal(classifyPricing('claude-opus-5-5-20260912', cfg).alias, 'opus-5-5');
  assert.equal(classifyPricing('claude-opus-5-20260601', cfg).alias, 'opus-5');
  assert.equal(classifyPricing('claude-fable-5-1-20260801', cfg).alias, 'fable-5-1');
  assert.equal(classifyPricing('claude-fable-5-20260101', cfg).alias, 'fable-5');
  assert.equal(classifyPricing('claude-fable-5-1-20260801', cfg).readMultiplier, 0.025);
  assert.equal(classifyPricing('claude-opus-5-5-20260912', cfg).readMultiplier, 0.05);
});

test('unknown model excluded from every total, and reported', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const proj = join(dir, 'projects', 'proj-a');
    const sessDir = join(proj, 'sess-1', 'subagents');
    mkdirSync(sessDir, { recursive: true });

    // A subagent transcript on an unpriced model.
    writeLines(join(sessDir, 'agent-x.jsonl'), [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), { requestId: 'ux1', model: 'claude-unobtainium-9000', input: 100, write5m: 50, output: 10 }),
    ]);
    writeFileSync(join(sessDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'worker', model: 'claude-unobtainium-9000' }));

    // A subagent transcript on a known, priced model.
    writeLines(join(sessDir, 'agent-y.jsonl'), [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), { requestId: 'uy1', model: 'claude-sonnet-5-20260101', input: 100, write5m: 50, output: 10 }),
    ]);
    writeFileSync(join(sessDir, 'agent-y.meta.json'), JSON.stringify({ agentType: 'worker', model: 'claude-sonnet-5-20260101' }));

    const result = await computeCacheTtl({ days: 30, now: new Date(T0 + 86400000), transcriptsRoot: join(dir, 'projects') });
    assert.equal(result.totals.requests, 1, 'the unpriced model must not be counted in totals');
    assert.equal(result.unknownModels.length, 1);
    assert.equal(result.unknownModels[0].model, 'claude-unobtainium-9000');
    assert.equal(result.unknownModels[0].count, 1);
  } finally {
    cleanup();
  }
});

test('<synthetic> model lines are skipped entirely', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const file = join(dir, 'synth.jsonl');
    writeLines(file, [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), { requestId: 's1', model: '<synthetic>', input: 999, write5m: 999 }),
      assistantLine(plusMs(1000), { requestId: 's2', model: 'claude-sonnet-5-20260101', input: 10, write5m: 10 }),
    ]);
    const requests = await parseFile(file, { kind: 'subagent', agentType: 'worker' });
    assert.equal(requests.length, 1, 'a <synthetic> line must never start or contribute to a counted request');
    assert.equal(requests[0].model, 'claude-sonnet-5-20260101');
  } finally {
    cleanup();
  }
});

test('computeCacheTtl end-to-end: main split, subagent aggregation, verdict present', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const proj = join(root, 'proj-a');

    // Main session: writes 1h cache (as a subscription-plan main conversation does).
    writeLines(join(proj, 'main-sess.jsonl'), [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), {
        requestId: 'm1', model: 'claude-sonnet-5-20260101', input: 100, write1h: 400, output: 20,
      }),
    ]);

    // One subagent transcript, two requests: first request cold-start, second
    // in the 5-60 band via a long tool call, so conv should be > 0.
    const subDir = join(proj, 'main-sess', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeLines(join(subDir, 'agent-1.jsonl'), [
      userLine(plusMs(0)),
      assistantLine(plusMs(0), {
        requestId: 'sa1', model: 'claude-sonnet-5-20260101', input: 1000, write5m: 500, read: 0,
        blocks: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }],
      }),
      userLine(plusMs(6 * 60000), { toolResult: true }),
      assistantLine(plusMs(6 * 60000), {
        requestId: 'sa2', model: 'claude-sonnet-5-20260101', input: 10, write5m: 200, read: 100, output: 5,
      }),
    ]);
    writeFileSync(join(subDir, 'agent-1.meta.json'), JSON.stringify({ agentType: 'general-purpose', model: 'sonnet' }));

    const result = await computeCacheTtl({ days: 30, now: new Date(T0 + 86400000), transcriptsRoot: root });

    assert.equal(result.mainRequestsScanned, 1);
    assert.equal(result.mainSession.write1hSharePct, 100, 'the only main write in the fixture is 1h');

    assert.equal(result.subagentRequestsScanned, 2);
    assert.equal(result.totals.band560Requests, 1);
    assert.ok(result.totals.convMTok > 0, 'the long-tool-call gap must convert some write to read');
    assert.equal(result.perAgentModel.length, 1);
    assert.match(result.perAgentModel[0].label, /general-purpose/);
    assert.equal(typeof result.verdict, 'string');
    assert.ok(result.verdict.length > 0);

    assert.equal(result.policy.allFiveMin, result.totals.costToday);
    assert.equal(result.policy.allOneHour, result.totals.cost1h);
  } finally {
    cleanup();
  }
});

test('window filtering: requests before the cutoff are excluded, file mtime does not leak them in', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const proj = join(root, 'proj-old');
    const subDir = join(proj, 'sess', 'subagents');
    mkdirSync(subDir, { recursive: true });
    // A request 40 days before "now" -- outside a 30-day window.
    const oldTs = new Date(T0 - 40 * 86400000).toISOString();
    writeLines(join(subDir, 'agent-old.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: oldTs, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({
        type: 'assistant', timestamp: oldTs, requestId: 'old1',
        message: {
          id: 'old1', model: 'claude-sonnet-5-20260101',
          usage: { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
    ]);
    writeFileSync(join(subDir, 'agent-old.meta.json'), JSON.stringify({ agentType: 'worker', model: 'sonnet' }));

    const result = await computeCacheTtl({ days: 30, now: new Date(T0), transcriptsRoot: root });
    assert.equal(result.subagentRequestsScanned, 0, 'a request older than the window must not be counted, even though the file exists');
  } finally {
    cleanup();
  }
});
