// Adversarial review findings for guard-a (hooks/resume-guard.mjs,
// hooks/lib/resume-guard.mjs). Synthetic fixtures only. Written by the
// guard-a-review track, NOT part of guard-a's own commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runHook } from './helpers.mjs';
import { buildTranscriptReport } from '../scripts/lib/transcript-report.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';

function assistantLine({ ts, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, input = 10 }) {
  const cacheWrite = cacheWrite5m + cacheWrite1h;
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      model: 'claude-opus-4-5-20251101',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        cache_creation: { ephemeral_5m_input_tokens: cacheWrite5m, ephemeral_1h_input_tokens: cacheWrite1h },
      },
    },
  });
}

function makeAgentFixture(root, { id = 'a1', name = 'worker-x', agentType = 'general-purpose', model = 'claude-opus-4-5-20251101', lines = [] } = {}) {
  const sessionDir = join(root, 'session');
  const subDir = join(sessionDir, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const base = `agent-${id}`;
  writeFileSync(join(subDir, `${base}.jsonl`), `${lines.join('\n')}\n`);
  writeFileSync(join(subDir, `${base}.meta.json`), JSON.stringify({ agentType, name, model }));
  return { mainTranscriptPath: join(sessionDir, 'main.jsonl'), transcriptPath: join(subDir, `${base}.jsonl`) };
}

function callHook(root, { to = 'worker-x', mainTranscriptPath, env = {} } = {}) {
  return runHook('hooks/resume-guard.mjs', {
    session_id: 'sid-1',
    transcript_path: mainTranscriptPath,
    tool_name: 'SendMessage',
    tool_input: { to, recipient: to, message: 'hi', type: 'message' },
  }, { env });
}

// FINDING 1 (false positive, contradicts guard-a-review-brief.md item 1's
// "a target whose definition carries experimental.cacheTtl: 1h idle 10-50
// min (must not fire)"): ttlFor()/lastActivityOf() look at ONLY the single
// LAST assistant record. A 1h-TTL worker whose most recent turn happened to
// be a pure cache read (no new cache_creation split — confirmed to occur in
// ~1.9% of real multi-turn subagent transcripts sampled from this operator's
// own corpus, 75/3867) loses its 1h signal entirely and falls back to the 5m
// default, so a genuinely-warm 1h-TTL worker idle 8 minutes gets flagged as
// past its cache TTL, and the hint text itself states the wrong TTL ("5m
// cache TTL") for a worker that is actually still warm under its real 1h TTL.
test('REVIEW FINDING: a 1h-TTL worker whose LAST turn was a pure cache read (no split write) is wrongly flagged at 8m idle', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-f1-'));
  try {
    const now = Date.now();
    // Turn 1 @ -20m: writes 150K tokens into the 1h bucket (this IS a 1h-TTL worker).
    // Turn 2 @ -8m: a pure cache read continuing the SAME still-warm 1h cache — no new split write.
    const { mainTranscriptPath } = makeAgentFixture(root, {
      id: 'h1', name: 'worker-1h', agentType: 'agent-companion:ac-opus-high-1h',
      lines: [
        assistantLine({ ts: now - 20 * 60 * 1000, cacheRead: 1000, cacheWrite1h: 150000 }),
        assistantLine({ ts: now - 8 * 60 * 1000, cacheRead: 151000 }), // pure read, no write at all
      ],
    });
    const res = callHook(root, { to: 'worker-1h', mainTranscriptPath });
    // Brief's own acceptance case: idle 10-50m under a real 1h TTL "must not fire".
    // This worker is idle only 8m and its cache was written into the 1h bucket
    // 20m ago (well within a real 1h TTL) -- it must not fire either way.
    assert.equal(res.json, null,
      `expected passthrough (worker is still within its real 1h TTL) but got: ${res.json && res.json.systemMessage}`);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// FINDING 2 (latency / correctness at scale, brief item 3): resolveTarget()
// scans the WHOLE subagents/ directory and JSON.parses every .meta.json
// sidecar on every SendMessage call, with no early exit once a name match is
// impossible. Confirmed non-crashing and fast (57ms measured) at 1000
// sidecars in review probing -- recorded here as a passing latency
// regression guard, not a defect.
test('REVIEW: resolveTarget stays fast with 1000 sidecars in the subagents dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-f2-'));
  try {
    const sessionDir = join(root, 'session');
    const subDir = join(sessionDir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(subDir, `agent-id${i}.jsonl`), '\n');
      writeFileSync(join(subDir, `agent-id${i}.meta.json`), JSON.stringify({ agentType: 'general-purpose', name: `worker-${i}` }));
    }
    const mainTranscriptPath = join(sessionDir, 'main.jsonl');
    const t0 = Date.now();
    const res = callHook(root, { to: 'worker-999', mainTranscriptPath });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `resolveTarget over 1000 sidecars took ${elapsed}ms`);
    assert.equal(res.json, null, 'worker-999 has no transcript lines, so no last activity -> passthrough');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FINDING 3 (non-subagent targets, brief item 2): confirms no crash / no
// misleading hint for main, a bus-style cross-session address, an id prefix,
// and the bracketed [ref] form -- all correctly out of scope.
test('REVIEW: non-subagent targets (main, cross-session address, id prefix) never crash or fire', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-f3-'));
  try {
    const { mainTranscriptPath } = makeAgentFixture(root, { id: 'real1', name: 'worker-x' });
    for (const to of ['main', 'team-lead', 'uds:host/session-id', 'peer-name [uds:host/session]', 'real', 'agent-real1']) {
      const res = callHook(root, { to, mainTranscriptPath });
      assert.equal(res.status, 0, `to=${JSON.stringify(to)} should exit 0`);
      assert.equal(res.json, null, `to=${JSON.stringify(to)} should passthrough silently, got ${JSON.stringify(res.json)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FINDING 4 (brief item 7 -- "transcript-report additions ... correct
// against the reader's own counts"): guard-a's own test suite
// (tests/resume-guard.test.mjs) never exercises the addition to
// scripts/lib/transcript-report.mjs at all -- idleExpiryRewriteTokens,
// idleExpiryRewriteUsd and idleExpiryUnpricedTokens ship with zero test
// coverage. This is an independent correctness check for that gap, built
// the same way the reader's own existing "report: gaps split by via x ttl"
// test (tests/transcripts-fix.test.mjs) is built. Passes -- the arithmetic
// itself is correct on this fixture -- but the gap in guard-a's own suite
// stands.
test('REVIEW: idleExpiryRewriteTokens/Usd on transcript-report.mjs is arithmetically correct (guard-a shipped this with zero tests)', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const T0 = Date.parse('2026-09-01T00:00:00.000Z');
    const MIN = 60 * 1000;
    const at = (ms) => new Date(T0 + ms).toISOString();
    let n = 0;
    const uuid = () => `fx-rev-${++n}`;
    const user = (ms, opts = {}) => ({
      type: 'user', uuid: uuid(), timestamp: at(ms), sessionId: 's1',
      message: { role: 'user', content: opts.toolResult ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] : [{ type: 'text', text: 'hi' }] },
      ...(opts.isMeta ? { isMeta: true } : {}),
      ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
    });
    const asst = (ms, { requestId, read = 0, write5m = 0, write1h = 0 }) => ({
      type: 'assistant', uuid: uuid(), timestamp: at(ms), sessionId: 's1', requestId,
      message: {
        id: `msg-${requestId}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } },
      },
    });
    const root = join(dir, 'projects');
    const path = join(root, 'p', 'sess', 'subagents', 'agent-q.jsonl');
    mkdirSync(join(path, '..'), { recursive: true });
    const recs = [
      user(0), asst(1000, { requestId: 'r1', write5m: 40000 }), // spawn baseline write, not a gap
      user(2 * MIN, { toolResult: true }), asst(2 * MIN + 1, { requestId: 'r2', read: 40000 }), // hit, no resume
      // idle-expiry rewrite: gap 20min > 5m ttl, via 'message' (SendMessage)
      user(20 * MIN, { isMeta: true, origin: 'coordinator' }), asst(20 * MIN + 1, { requestId: 'r3', write5m: 77000 }),
    ];
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const r = await buildTranscriptReport({ root, days: 1, now: new Date(T0 + 60 * MIN) });
    assert.equal(r.resumeAfterIdle.causes['idle-expiry'], 1, 'sanity: exactly one idle-expiry rewrite in this fixture');

    // Expected: the ONE idle-expiry rewrite (r3) wrote 77000 tokens to the 5m
    // bucket (ttlSource is 'write' from r1's own 5m write, so g.ttl === '5m').
    const expectedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 77000, cacheWrite1h: 0 };
    const expected = priceUsage(expectedUsage, 'claude-sonnet-5');
    assert.equal(r.resumeAfterIdle.idleExpiryRewriteTokens, 77000);
    assert.ok(Math.abs(r.resumeAfterIdle.idleExpiryRewriteUsd - expected.usd) < 1e-9,
      `expected usd ${expected.usd}, got ${r.resumeAfterIdle.idleExpiryRewriteUsd}`);
    assert.equal(r.resumeAfterIdle.idleExpiryUnpricedTokens, 0);
  } finally { cleanup(); }
});
