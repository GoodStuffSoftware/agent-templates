// Guard (a) — hooks/resume-guard.mjs and hooks/lib/resume-guard.mjs.
// Synthetic fixtures only: a throwaway "session" directory with its own
// subagents/agent-<id>.jsonl + .meta.json sidecar, shaped exactly like a real
// one (confirmed against a live probe transcript 2026-09-25 — see
// guard-a-report.md). No real transcript is ever read or written here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runHook } from './helpers.mjs';
import { resolveTarget, lastActivityOf, ttlFor, normalizeTo, TTL_MS } from '../hooks/lib/resume-guard.mjs';
import { buildTranscriptReport } from '../scripts/lib/transcript-report.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';

function assistantLine({ ts, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0, input = 10 }) {
  const cacheWrite = cacheWrite5m + cacheWrite1h;
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: {
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        cache_creation: { ephemeral_5m_input_tokens: cacheWrite5m, ephemeral_1h_input_tokens: cacheWrite1h },
      },
    },
  });
}

// Builds <dir>/session/subagents/agent-<id>.jsonl + .meta.json and returns
// { mainTranscriptPath, transcriptPath }. `lines` are pre-built JSONL strings
// (assistantLine() above); the last one is what lastActivityOf() should read.
function makeAgentFixture(root, { id = 'a1', name = 'worker-x', agentType = 'general-purpose', model = 'claude-haiku-4-5-20251001', lines = [] } = {}) {
  const sessionDir = join(root, 'session');
  const subDir = join(sessionDir, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const base = `agent-${id}`;
  writeFileSync(join(subDir, `${base}.jsonl`), `${lines.join('\n')}\n`);
  writeFileSync(join(subDir, `${base}.meta.json`), JSON.stringify({ agentType, name, model }));
  return {
    mainTranscriptPath: join(sessionDir, 'main.jsonl'),
    transcriptPath: join(subDir, `${base}.jsonl`),
  };
}

test('lib: normalizeTo strips a disambiguating [ref] suffix', () => {
  assert.equal(normalizeTo('worker [3fa9c1]'), 'worker');
  assert.equal(normalizeTo('worker'), 'worker');
  assert.equal(normalizeTo('  worker  '), 'worker');
  assert.equal(normalizeTo(''), '');
  assert.equal(normalizeTo(null), '');
});

test('lib: resolveTarget matches by name, falls back to raw agent id, and misses cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const { mainTranscriptPath } = makeAgentFixture(root, { id: 'abc123', name: 'worker-x' });

    const byName = resolveTarget('worker-x', mainTranscriptPath);
    assert.ok(byName);
    assert.equal(byName.agentId, 'abc123');
    assert.equal(byName.name, 'worker-x');

    const byId = resolveTarget('abc123', mainTranscriptPath);
    assert.ok(byId);
    assert.equal(byId.agentId, 'abc123');

    assert.equal(resolveTarget('nobody-here', mainTranscriptPath), null);
    assert.equal(resolveTarget('worker-x', join(root, 'no-such-session', 'main.jsonl')), null);
    assert.equal(resolveTarget('', mainTranscriptPath), null);
    assert.equal(resolveTarget('worker-x', null), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lib: resolveTarget prefers an exact name match over an id-shaped collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    // A worker literally named "def456" would otherwise collide with the
    // OTHER agent's raw id "def456" — the name match must win regardless of
    // scan order, since a name is what a caller almost always means.
    const sessionDir = join(root, 'session');
    const subDir = join(sessionDir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-def456.jsonl'), '\n');
    writeFileSync(join(subDir, 'agent-def456.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'the-real-def456-id-owner' }));
    writeFileSync(join(subDir, 'agent-zzz999.jsonl'), '\n');
    writeFileSync(join(subDir, 'agent-zzz999.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'def456' }));

    const hit = resolveTarget('def456', join(sessionDir, 'main.jsonl'));
    assert.ok(hit);
    assert.equal(hit.agentId, 'zzz999', 'the NAME match ("def456") must win over the raw-id collision');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lib: lastActivityOf reads the LAST assistant record\'s ts and cache usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { transcriptPath } = makeAgentFixture(root, {
      lines: [
        assistantLine({ ts: now - 60000, cacheRead: 1000, cacheWrite5m: 500 }),
        assistantLine({ ts: now, cacheRead: 5000, cacheWrite5m: 200, input: 10 }),
      ],
    });
    const last = lastActivityOf(transcriptPath);
    assert.ok(last);
    assert.equal(last.ts, now);
    assert.equal(last.cacheRead, 5000);
    assert.equal(last.cacheWrite, 200);
    assert.equal(last.contextTokens, 10 + 5000 + 200);
    assert.equal(lastActivityOf(join(root, 'nope.jsonl')), null);
    assert.equal(lastActivityOf(null), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lib: ttlFor reads the larger of the 1h/5m split, defaults to 5m on a pure read', () => {
  assert.equal(ttlFor({ cacheWrite1h: 0, cacheWrite5m: 0 }), '5m');
  assert.equal(ttlFor({ cacheWrite1h: 0, cacheWrite5m: 100 }), '5m');
  assert.equal(ttlFor({ cacheWrite1h: 100, cacheWrite5m: 0 }), '1h');
  assert.equal(ttlFor({ cacheWrite1h: 100, cacheWrite5m: 100 }), '1h'); // tie: 1h per writeTtlOf's own rule
  assert.equal(ttlFor(null), '5m');
});

// --- The hook itself, end to end -------------------------------------------

function callHook(root, { to = 'worker-x', mainTranscriptPath, env = {} } = {}) {
  return runHook('hooks/resume-guard.mjs', {
    session_id: 'sid-1',
    transcript_path: mainTranscriptPath,
    tool_name: 'SendMessage',
    tool_input: { to, recipient: to, message: 'hi', type: 'message' },
  }, { env });
}

test('hook: resume_guard off -> passthrough, no matter how stale the target', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 20 * 60 * 1000, cacheRead: 100000, cacheWrite5m: 100000 })],
    });
    const res = callHook(root, { mainTranscriptPath, env: { CLAUDE_PLUGIN_OPTION_RESUME_GUARD: 'false' } });
    assert.equal(res.status, 0);
    assert.equal(res.json, null, 'no hookSpecificOutput at all when the guard is off');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: unknown target -> passthrough (out of this session\'s scope)', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const { mainTranscriptPath } = makeAgentFixture(root, { name: 'someone-else' });
    const res = callHook(root, { to: 'worker-x', mainTranscriptPath });
    assert.equal(res.status, 0);
    assert.equal(res.json, null);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: still within TTL -> passthrough even with a huge context', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 60 * 1000, cacheRead: 200000, cacheWrite5m: 200000 })], // 1m ago, well under 5m TTL
    });
    const res = callHook(root, { mainTranscriptPath });
    assert.equal(res.json, null);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: past TTL but context below the size floor -> passthrough', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 10 * 60 * 1000, cacheRead: 500, cacheWrite5m: 500 })], // 10m ago, past 5m TTL, tiny context
    });
    const res = callHook(root, { mainTranscriptPath });
    assert.equal(res.json, null);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: past 5m TTL with a large context -> fires, names the doctrine and an estimate', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 12 * 60 * 1000, cacheRead: 150000, cacheWrite5m: 5000, input: 20 })],
    });
    const res = callHook(root, { mainTranscriptPath });
    assert.ok(res.json, 'expected a hookSpecificOutput');
    assert.equal(res.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(res.json.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(res.json.systemMessage.includes('5m cache TTL'), res.json.systemMessage);
    assert.ok(res.json.systemMessage.includes('fresh ladder worker'));
    assert.ok(res.json.systemMessage.includes('~155K tokens'), res.json.systemMessage);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: matches by raw agent id when no name matches', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      id: 'rawid789', name: 'named-thing',
      lines: [assistantLine({ ts: now - 12 * 60 * 1000, cacheRead: 150000, cacheWrite5m: 5000 })],
    });
    const res = callHook(root, { to: 'rawid789', mainTranscriptPath });
    assert.ok(res.json, 'expected a hookSpecificOutput when addressed by raw id');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: a 1h-TTL worker is not flagged at 20m idle, but is past 65m', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();

    const under = makeAgentFixture(root, {
      id: 'h1',
      lines: [assistantLine({ ts: now - 20 * 60 * 1000, cacheRead: 150000, cacheWrite1h: 5000 })],
    });
    const resUnder = callHook(root, { mainTranscriptPath: under.mainTranscriptPath });
    assert.equal(resUnder.json, null, '20m idle is still within the 1h TTL');

    // Different session dir so the two fixtures don't collide.
    const root2 = mkdtempSync(join(tmpdir(), 'ac-rg-'));
    try {
      const over = makeAgentFixture(root2, {
        id: 'h2',
        lines: [assistantLine({ ts: now - 65 * 60 * 1000, cacheRead: 150000, cacheWrite1h: 5000 })],
      });
      const resOver = callHook(root2, { mainTranscriptPath: over.mainTranscriptPath });
      assert.ok(resOver.json, 'expected a hint past the 1h TTL');
      assert.ok(resOver.json.systemMessage.includes('1h cache TTL'), resOver.json.systemMessage);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// FIX ROUND (guard-a-fix-brief.md item 1): the two cases the review's fix
// itself was asked for. Both continue a real split write with one or more
// PURE-READ turns (no new split write at all), which is exactly the shape
// REVIEW FINDING 1 caught guard-a's original single-last-record logic
// getting wrong (see guard-a-review.md, resume-guard-review.test.mjs).

test('hook: last write 1h, then pure-read turns, idle 30 min -> no hint (still within the real 1h TTL)', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      id: 'h30', name: 'worker-1h-30',
      lines: [
        // A real 1h-bucket write 50 minutes ago...
        assistantLine({ ts: now - 50 * 60 * 1000, cacheRead: 1000, cacheWrite1h: 150000 }),
        // ...then two pure-read turns that write nothing split at all, the
        // most recent one 30 minutes ago. Still comfortably inside the real
        // 1h TTL measured from THIS record's own timestamp, not the write's.
        assistantLine({ ts: now - 40 * 60 * 1000, cacheRead: 151000 }),
        assistantLine({ ts: now - 30 * 60 * 1000, cacheRead: 151000 }),
      ],
    });
    const res = callHook(root, { to: 'worker-1h-30', mainTranscriptPath });
    assert.equal(res.json, null,
      `expected passthrough (idle only 30m, well inside a real 1h TTL) but got: ${res.json && res.json.systemMessage}`);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: last write 5m, pure-read turn, idle 8 min -> hint (past the real 5m TTL)', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      id: 'm8', name: 'worker-5m-8',
      lines: [
        // A real 5m-bucket write 20 minutes ago...
        assistantLine({ ts: now - 20 * 60 * 1000, cacheRead: 1000, cacheWrite5m: 150000 }),
        // ...then one pure-read turn 8 minutes ago -- past the real 5m TTL
        // measured from this record's own timestamp. The pure-read tail must
        // not accidentally clear the TTL bucket either (0/0 would wrongly
        // fall through to the agent-definition/default path); it must still
        // read as 5m and still fire.
        assistantLine({ ts: now - 8 * 60 * 1000, cacheRead: 151000 }),
      ],
    });
    const res = callHook(root, { to: 'worker-5m-8', mainTranscriptPath });
    assert.ok(res.json, 'expected a hint (idle 8m is past the real 5m TTL)');
    assert.ok(res.json.systemMessage.includes('5m cache TTL'), res.json.systemMessage);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: no split write anywhere in the tail falls back to the agent definition\'s own experimental.cacheTtl', () => {
  const { dir, cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    // Bare (non-namespaced) agentType so agentDefinition() resolves it under
    // <claudeDir()>/agents/<type>.md -- claudeDir() follows
    // AGENT_COMPANION_HOME_OVERRIDE, which makeFixture() already points at
    // `dir`, so this never touches the real ~/.claude.
    const agentsDir = join(dir, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'my-1h-worker.md'),
      '---\nname: my-1h-worker\ndescription: a long-lived architect\nmodel: opus\neffort: high\nexperimental:\n  cacheTtl: 1h\n---\nbody\n',
    );
    const { mainTranscriptPath } = makeAgentFixture(root, {
      id: 'defttl', name: 'worker-def', agentType: 'my-1h-worker',
      // Every turn is a pure read -- no split write anywhere in the tail --
      // so lastActivityOf()'s backward walk finds nothing at all (0/0).
      lines: [
        assistantLine({ ts: now - 25 * 60 * 1000, cacheRead: 150000 }),
        assistantLine({ ts: now - 20 * 60 * 1000, cacheRead: 150000 }),
      ],
    });
    const res = callHook(root, { to: 'worker-def', mainTranscriptPath });
    // Without the definition fallback, ttlFor() would default to 5m and
    // wrongly fire at 20m idle. With it, the real 1h TTL applies and 20m is
    // still well within it.
    assert.equal(res.json, null,
      `expected passthrough (definition declares 1h, idle only 20m) but got: ${res.json && res.json.systemMessage}`);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// FIX ROUND item 2: land a test for the transcript-report.mjs additions
// (idleExpiryRewriteTokens/Usd/UnpricedTokens) in this suite -- guard-a
// shipped these with zero tests (REVIEW FINDING 2); modeled directly on the
// reviewer's own independent check (resume-guard-review.test.mjs), which is
// kept as-is there too so the review's own evidence stays intact.
test('report: idleExpiryRewriteTokens/Usd/UnpricedTokens on transcript-report.mjs is arithmetically correct', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const T0 = Date.parse('2026-09-01T00:00:00.000Z');
    const MIN = 60 * 1000;
    const at = (ms) => new Date(T0 + ms).toISOString();
    let n = 0;
    const uuid = () => `fx-guard-a-fix-${++n}`;
    const user = (ms, opts = {}) => ({
      type: 'user', uuid: uuid(), timestamp: at(ms), sessionId: 's1',
      message: { role: 'user', content: opts.toolResult ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] : [{ type: 'text', text: 'hi' }] },
      ...(opts.isMeta ? { isMeta: true } : {}),
      ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
    });
    const asst = (ms, { requestId, read = 0, write5m = 0, write1h = 0, model = 'claude-sonnet-5' }) => ({
      type: 'assistant', uuid: uuid(), timestamp: at(ms), sessionId: 's1', requestId,
      message: {
        id: `msg-${requestId}`, model, content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } },
      },
    });
    const root = join(dir, 'projects');
    const path = join(root, 'p', 'sess', 'subagents', 'agent-guardfix.jsonl');
    mkdirSync(join(path, '..'), { recursive: true });
    const recs = [
      user(0), asst(1000, { requestId: 'r1', write1h: 60000 }), // spawn baseline write, not a gap
      user(2 * MIN, { toolResult: true }), asst(2 * MIN + 1, { requestId: 'r2', read: 60000 }), // hit, no resume
      // idle-expiry rewrite: gap 90min > 1h ttl (r1 wrote 1h), via 'message' (SendMessage)
      user(90 * MIN, { isMeta: true, origin: 'coordinator' }), asst(90 * MIN + 1, { requestId: 'r3', write1h: 88000 }),
    ];
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const r = await buildTranscriptReport({ root, days: 1, now: new Date(T0 + 120 * MIN) });
    assert.equal(r.resumeAfterIdle.causes['idle-expiry'], 1, 'sanity: exactly one idle-expiry rewrite in this fixture');

    // The ONE idle-expiry rewrite (r3) wrote 88000 tokens to the 1h bucket
    // (ttlSource is 'write' from r1's own 1h write, so g.ttl === '1h').
    const expectedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 88000, cacheWrite1h: 88000 };
    const expected = priceUsage(expectedUsage, 'claude-sonnet-5');
    assert.equal(r.resumeAfterIdle.idleExpiryRewriteTokens, 88000);
    assert.ok(Math.abs(r.resumeAfterIdle.idleExpiryRewriteUsd - expected.usd) < 1e-9,
      `expected usd ${expected.usd}, got ${r.resumeAfterIdle.idleExpiryRewriteUsd}`);
    assert.equal(r.resumeAfterIdle.idleExpiryUnpricedTokens, 0);
  } finally { cleanup(); }
});

test('hook: resume_guard_min_tokens is configurable', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 10 * 60 * 1000, cacheRead: 2000, cacheWrite5m: 2000 })], // 4K context: under the 50K default
    });
    const resDefault = callHook(root, { mainTranscriptPath });
    assert.equal(resDefault.json, null, 'under the default floor');

    const resLowered = callHook(root, { mainTranscriptPath, env: { CLAUDE_PLUGIN_OPTION_RESUME_GUARD_MIN_TOKENS: '1000' } });
    assert.ok(resLowered.json, 'fires once the floor is lowered below this context');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: malformed / missing payload fields fail open', () => {
  const { cleanup } = makeFixture();
  try {
    const res1 = runHook('hooks/resume-guard.mjs', { tool_name: 'SendMessage', tool_input: {} });
    assert.equal(res1.status, 0);
    assert.equal(res1.json, null);

    const res2 = runHook('hooks/resume-guard.mjs', undefined);
    assert.equal(res2.status, 0);
    assert.equal(res2.json, null);
  } finally {
    cleanup();
  }
});

test('hook latency: well under its 10s hook timeout on a realistic fixture', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const now = Date.now();
    const { mainTranscriptPath } = makeAgentFixture(root, {
      lines: [assistantLine({ ts: now - 12 * 60 * 1000, cacheRead: 150000, cacheWrite5m: 5000 })],
    });
    const t0 = Date.now();
    const res = callHook(root, { mainTranscriptPath });
    const elapsed = Date.now() - t0;
    assert.ok(res.json, 'sanity: the hook actually fired for this fixture');
    assert.ok(elapsed < 3000, `resume-guard.mjs took ${elapsed}ms — expected well under the 10s hook timeout`);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
