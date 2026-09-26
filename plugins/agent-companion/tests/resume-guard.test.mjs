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
