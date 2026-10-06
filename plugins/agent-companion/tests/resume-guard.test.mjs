// Guard (a) — hooks/resume-guard.mjs and hooks/lib/resume-guard.mjs.
// Synthetic fixtures only: a throwaway "session" directory with its own
// subagents/agent-<id>.jsonl + .meta.json sidecar, shaped exactly like a real
// one (confirmed against a live probe transcript 2026-09-25 — see
// guard-a-report.md). No real transcript is ever read or written here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeFixture, runHook, decisionOf } from './helpers.mjs';
import {
  resolveTarget, lastActivityOf, ttlFor, normalizeTo, TTL_MS, cacheTtlFromDefinition,
  declaredTypeOf, modelTierOf, modelRank,
} from '../hooks/lib/resume-guard.mjs';
import { buildTranscriptReport } from '../scripts/lib/transcript-report.mjs';
import { priceUsage } from '../scripts/lib/pricing.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

// --- Reuse by default (0.31.1): the hook never discourages a cold resume ----
// Idle time and the cache TTL play no part. A note appears only for a very
// large worker (resume_guard_min_tokens, default 200000) or a worker whose
// tier is above the TYPE the message declares.

const idle = (min, extra) => assistantLine({ ts: Date.now() - min * 60 * 1000, ...extra });

function callWith(fixture, { message = 'hi', env = {}, to = 'worker-x' } = {}) {
  return runHook('hooks/resume-guard.mjs', {
    session_id: 'sid-1', transcript_path: fixture.mainTranscriptPath, tool_name: 'SendMessage',
    tool_input: { to, recipient: to, message, type: 'message' },
  }, { env });
}

test('hook: a cache-cold worker is never discouraged, however long it has been idle (2m, 12m, 70m, 3 days)', () => {
  const { cleanup } = makeFixture();
  try {
    for (const min of [2, 12, 70, 60 * 72]) {
      const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
      try {
        const fx = makeAgentFixture(root, { lines: [idle(min, { cacheRead: 100000, cacheWrite5m: 5000 })] }); // 105K context
        const res = callWith(fx);
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.json, null, `idle ${min}m, 105K context: nothing to say, got ${res.stdout}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  } finally { cleanup(); }
});

test('hook: the note never tells the lead to spawn fresh or from a file handoff, and never mentions the cache TTL', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const fx = makeAgentFixture(root, { lines: [idle(30, { cacheRead: 230000, cacheWrite5m: 5000 })] });
    const res = callWith(fx);
    assert.ok(res.json, 'a 235K worker gets a note');
    const text = res.json.systemMessage;
    assert.match(text, /~235K tokens of context/);
    assert.match(text, /Reuse is still the default/);
    assert.doesNotMatch(text, /TTL|cache is warm|file handoff|rewrite/i, text);
    assert.equal(decisionOf(res.json), 'proceed');
    assert.equal('permissionDecision' in res.json.hookSpecificOutput, false, 'a note carries no permissionDecision');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: the size floor is resume_guard_min_tokens (default 200000) and is configurable', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  const root2 = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const fx = makeAgentFixture(root, { lines: [idle(1, { cacheRead: 150000, cacheWrite5m: 5000 })] }); // 155K
    assert.equal(callWith(fx).json, null, 'under the 200K default, warm or cold');
    const lowered = callWith(fx, { env: { CLAUDE_PLUGIN_OPTION_RESUME_GUARD_MIN_TOKENS: '100000' } });
    assert.ok(lowered.json, 'fires once the floor is lowered under the context');
    const at = makeAgentFixture(root2, { lines: [idle(1, { cacheRead: 195000, cacheWrite5m: 5000, input: 0 })] }); // exactly 200K
    assert.ok(callWith(at).json, 'a context at the floor counts as large');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('hook: resume_guard off -> nothing, even for a huge context', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const fx = makeAgentFixture(root, { lines: [idle(20, { cacheRead: 400000, cacheWrite5m: 1000 })] });
    const res = callWith(fx, { env: { CLAUDE_PLUGIN_OPTION_RESUME_GUARD: 'false' } });
    assert.equal(res.json, null);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: matches by raw agent id when no name matches', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const fx = makeAgentFixture(root, { id: 'rawid789', name: 'named-thing', lines: [idle(12, { cacheRead: 250000, cacheWrite5m: 5000 })] });
    assert.ok(callWith(fx, { to: 'rawid789' }).json, 'expected a note when addressed by raw id');
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook: a worker whose tier is above the message\'s TYPE gets a tier note; an equal or lower tier does not', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  const root2 = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const opusWorker = makeAgentFixture(root, {
      agentType: 'agent-companion:ac-opus-medium', model: 'claude-opus-5-5',
      lines: [idle(90, { cacheRead: 40000, cacheWrite5m: 1000 })], // small and cold: only the tier can speak
    });
    // mechanical-edit routes to sonnet
    const down = callWith(opusWorker, { message: 'TYPE: mechanical-edit\nrename the flag in three files' });
    assert.ok(down.json, 'an opus worker given sonnet-weight work gets a note');
    assert.match(down.json.systemMessage, /runs opus, and TYPE: mechanical-edit routes to sonnet/);
    assert.doesNotMatch(down.json.systemMessage, /TTL|cache is warm|file handoff/i);
    // the same worker, a type that routes to opus, or no TYPE at all, or an unknown one: silent
    assert.equal(callWith(opusWorker, { message: 'TYPE: novel-design\nredo the design' }).json, null);
    assert.equal(callWith(opusWorker, { message: 'one more round please' }).json, null);
    assert.equal(callWith(opusWorker, { message: 'TYPE: not-a-real-type' }).json, null);
    // a sonnet worker given the same sonnet-weight work: silent
    const sonnetWorker = makeAgentFixture(root2, {
      agentType: 'agent-companion:ac-sonnet-high', model: 'sonnet', lines: [idle(90, { cacheRead: 40000, cacheWrite5m: 1000 })],
    });
    assert.equal(callWith(sonnetWorker, { message: 'TYPE: mechanical-edit\nx' }).json, null);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('hook: size and tier notes combine in one message', () => {
  const { cleanup } = makeFixture();
  const root = mkdtempSync(join(tmpdir(), 'ac-rg-'));
  try {
    const fx = makeAgentFixture(root, {
      agentType: 'agent-companion:ac-opus-high', model: 'opus', lines: [idle(5, { cacheRead: 260000, cacheWrite5m: 1000 })],
    });
    const res = callWith(fx, { message: { text: 'TYPE: mechanical-edit\nrename it' } });
    assert.ok(res.json);
    assert.match(res.json.systemMessage, /~261K tokens/);
    assert.match(res.json.systemMessage, /routes to sonnet/);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('lib: declaredTypeOf / modelTierOf / modelRank', () => {
  assert.equal(declaredTypeOf('hi\nTYPE: Bounded-Feature\nmore'), 'bounded-feature');
  assert.equal(declaredTypeOf('no type here, type: x in prose'), null);
  assert.equal(declaredTypeOf({ text: 'TYPE: explore' }), 'explore');
  assert.equal(declaredTypeOf(null), null);
  assert.equal(modelTierOf({ model: 'claude-opus-5-5', agentType: null }), 'opus');
  assert.equal(modelTierOf({ model: null, agentType: 'agent-companion:ac-sonnet-low' }), 'sonnet');
  assert.equal(modelTierOf({ model: null, agentType: 'general-purpose' }), null);
  assert.ok(modelRank('opus') > modelRank('sonnet') && modelRank('sonnet') > modelRank('haiku') && modelRank(null) === 0);
});

test('the standing rule and the hook describe reuse, not fresh spawns (no stale doctrine text)', () => {
  const rules = readFileSync(join(PLUGIN_ROOT, 'hooks', 'lib', 'rules.mjs'), 'utf8');
  const rule = /id: 'resume-doctrine'[\s\S]*?then: '((?:[^'\\]|\\.)*)'/.exec(rules);
  assert.ok(rule, 'rule present');
  assert.match(rule[1], /Reuse workers/);
  assert.match(rule[1], /Never spawn fresh just because a cache expired/);
  assert.doesNotMatch(rule[1], /Resume only while|spawn fresh from a file handoff/);
  const hookText = readFileSync(join(PLUGIN_ROOT, 'hooks', 'resume-guard.mjs'), 'utf8');
  assert.doesNotMatch(hookText.replace(/^\/\/.*$/gm, ''), /spawn a fresh|fresh ladder worker|file handoff/);
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

// Since 2026-10-03 (0.29.30) no shipped ladder rung carries
// experimental.cacheTtl: ac-opus-medium/high/xhigh/max had "1h" from 0.29.17
// and it was removed again. No fixture needed: both the bare and the
// `agent-companion:`-namespaced form resolve through agentDefinition()'s own
// ladder/self-plugin shortcuts straight to the real, committed files, so this
// reads exactly what a live resume-guard hook would resolve.
test('lib: cacheTtlFromDefinition resolves every shipped ladder rung to null (the 5m default)', () => {
  // null, not "5m": this function's OWN contract (see its header comment) is
  // "no override in the definition" -- the caller (hooks/resume-guard.mjs)
  // then keeps ttlFor()'s bare 5m default, which is the effective result.
  for (const rung of ['ac-haiku', 'ac-sonnet-medium', 'ac-opus-low', 'ac-opus-medium', 'ac-opus-high', 'ac-opus-xhigh', 'ac-opus-max']) {
    assert.equal(cacheTtlFromDefinition(`agent-companion:${rung}`), null, rung);
    assert.equal(cacheTtlFromDefinition(rung), null, `bare ${rung}`);
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

test('plugin.json: resume_guard options describe reuse notes, default floor 200000, no cache-expiry doctrine', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.resume_guard_min_tokens.default, 200000);
  assert.equal(cfg.resume_guard.default, true);
  const text = `${cfg.resume_guard.description} ${cfg.resume_guard_min_tokens.description}`;
  assert.match(text, /NEVER discourages a cold resume/);
  assert.doesNotMatch(text, /resume only while the cache is warm|spawn fresh from a file handoff/i);
});
