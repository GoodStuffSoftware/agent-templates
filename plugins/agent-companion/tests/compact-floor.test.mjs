// Main-session compaction floor (hooks/compact-floor.mjs): the pure decision,
// the option parser, the bounded log, and register() driven against a fake `$`.
// The module is a hooks MODULE, loaded by the engine through hooks/hooks.json
// "modules"; here it is imported directly so no engine is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import {
  parseFloor, decideCompact, appendBounded, register,
  MIN_FLOOR, MAX_FLOOR, LOG_MAX_LINES, SKIP_REASON, SKIP_REASON_PREFIX,
} from '../hooks/compact-floor.mjs';

const FLOOR = 367000;
const decide = (over) => decideCompact({ parsed: parseFloor(FLOOR), trigger: 'auto', agentId: undefined, tokens: 100000, ...over });

test('main session below the floor is skipped', () => {
  assert.equal(decide({ tokens: 366999 }).action, 'skip');
  assert.equal(decide({ tokens: 59000 }).action, 'skip');
});

test('main session at or above the floor passes', () => {
  assert.equal(decide({ tokens: FLOOR }).action, 'pass');
  assert.equal(decide({ tokens: FLOOR }).why, 'at-floor');
  assert.equal(decide({ tokens: 900000 }).action, 'pass');
});

test('a subagent always passes, whatever its tokens', () => {
  assert.equal(decide({ agentId: 'agent-one', tokens: 1000 }).action, 'pass');
  assert.equal(decide({ agentId: 'agent-one', tokens: 1000 }).why, 'subagent');
});

test('non-auto triggers pass', () => {
  for (const trigger of ['manual', 'precompute', 'reactive', undefined]) {
    assert.equal(decide({ trigger, tokens: 1000 }).action, 'pass', String(trigger));
  }
});

test('floor off (unset, 0, empty, false) passes', () => {
  for (const raw of [undefined, null, 0, '0', '', false]) {
    assert.deepEqual(parseFloor(raw), { off: true }, String(raw));
    assert.equal(decideCompact({ parsed: parseFloor(raw), trigger: 'auto', tokens: 1000 }).action, 'pass');
  }
  assert.equal(decideCompact({ parsed: undefined, trigger: 'auto', tokens: 1000 }).action, 'pass');
});

test('a bad option value fails open', () => {
  const bad = [-1, 99999, 1000001, 'abc', NaN, Infinity, true, ['367000'], '10e9'];
  for (const raw of bad) {
    const parsed = parseFloor(raw);
    assert.ok(parsed.bad !== undefined, `parsed bad: ${String(raw)}`);
    assert.equal(decideCompact({ parsed, trigger: 'auto', tokens: 1000 }).action, 'pass', String(raw));
  }
});

test('range edges and numeric strings are accepted', () => {
  assert.deepEqual(parseFloor(MIN_FLOOR), { floor: MIN_FLOOR });
  assert.deepEqual(parseFloor(MAX_FLOOR), { floor: MAX_FLOOR });
  assert.deepEqual(parseFloor('367000'), { floor: 367000 });
  assert.deepEqual(parseFloor(367000.9), { floor: 367000 });
});

test('unknown token count fails open', () => {
  for (const tokens of [undefined, null, NaN, '300000']) {
    assert.equal(decide({ tokens }).action, 'pass', String(tokens));
  }
});

test('the skip reason carries the prefix the engine uses to suppress the toast', () => {
  assert.ok(SKIP_REASON.startsWith(SKIP_REASON_PREFIX));
  assert.equal(SKIP_REASON_PREFIX, 'Compaction blocked by PreCompact hook');
});

test('appendBounded keeps the last LOG_MAX_LINES lines', () => {
  let text = '';
  for (let i = 0; i < LOG_MAX_LINES + 50; i++) text = appendBounded(text, `l${i}`);
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, LOG_MAX_LINES);
  assert.equal(lines[0], 'l50');
  assert.equal(lines.at(-1), `l${LOG_MAX_LINES + 49}`);
});

// ---- register() against a fake engine ------------------------------------

function fakeEngine({ options, tokens = 100000, env = { CLAUDE_PLUGIN_DATA: '/data/ac' }, usageThrows = false, writeThrows = false } = {}) {
  const files = new Map();
  let usageCalls = 0;
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const $ = {
    env: { get: async (n) => env[n] },
    clock: { now: async () => (clock += 1000) },
    session: { usage: async () => { usageCalls += 1; if (usageThrows) throw new Error('boom'); return { context: { tokens: typeof tokens === 'function' ? tokens() : tokens } }; } },
    fs: {
      exists: async (p) => files.has(p),
      read: async (p) => files.get(p),
      write: async (p, t) => { if (writeThrows) throw new Error('disk'); files.set(p, t); },
    },
  };
  const hooks = {};
  register((event, hook) => { hooks[event] = hook; }, options);
  const nexted = [];
  const next = async (e) => { nexted.push(e); return { messages: ['compacted'] }; };
  const fire = (e) => hooks['session.compact']($, e, next);
  const logLines = () => (files.get('/data/ac/compact-floor.log') || '').split('\n').filter(Boolean);
  return { fire, nexted, logLines, files, usageCalls: () => usageCalls };
}

test('register: option off passes everything and touches nothing', async () => {
  for (const options of [undefined, {}, { main_compact_floor_tokens: 0 }]) {
    const t = fakeEngine({ options, tokens: 1000 });
    const r = await t.fire({ trigger: 'auto', messages: [] });
    assert.deepEqual(r, { messages: ['compacted'] });
    assert.equal(t.usageCalls(), 0);
    assert.equal(t.files.size, 0);
  }
});

test('register: main below floor is skipped, at floor passes to core', async () => {
  let tokens = 120000;
  const t = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: () => tokens });
  const veto = await t.fire({ trigger: 'auto', messages: [] });
  assert.equal(veto.skip, SKIP_REASON);
  assert.equal(t.nexted.length, 0);
  tokens = 368000;
  const pass = await t.fire({ trigger: 'auto', messages: [] });
  assert.deepEqual(pass, { messages: ['compacted'] });
  assert.equal(t.nexted.length, 1);
});

test('register: subagent and non-auto pass without reading usage or logging', async () => {
  const t = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: 1000 });
  await t.fire({ trigger: 'auto', agentId: 'abc', messages: [] });
  await t.fire({ trigger: 'manual', messages: [] });
  await t.fire({ trigger: 'precompute', messages: [] });
  assert.equal(t.nexted.length, 3);
  assert.equal(t.usageCalls(), 0);
  assert.equal(t.files.size, 0);
});

test('register: bad option fails open and logs once', async () => {
  const t = fakeEngine({ options: { main_compact_floor_tokens: 5000 }, tokens: 1000 });
  for (let i = 0; i < 5; i++) await t.fire({ trigger: 'auto', messages: [] });
  assert.equal(t.nexted.length, 5);
  assert.equal(t.logLines().length, 1);
  assert.match(t.logLines()[0], /fail-open: main_compact_floor_tokens="5000"/);
});

test('register: logging is bounded (one line at first veto, one per pass, never one per veto)', async () => {
  let tokens = 100000;
  const t = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: () => tokens });
  for (let i = 0; i < 40; i++) await t.fire({ trigger: 'auto', messages: [] });
  assert.equal(t.logLines().length, 1);
  assert.match(t.logLines()[0], /veto: main auto-compaction held/);
  tokens = 370000;
  await t.fire({ trigger: 'auto', messages: [] });
  assert.equal(t.logLines().length, 2);
  assert.match(t.logLines()[1], /pass: .*vetoes_since_last_line=39/);
  tokens = 90000;
  for (let i = 0; i < 40; i++) await t.fire({ trigger: 'auto', messages: [] });
  assert.equal(t.logLines().length, 2, 'later vetoes in the same session stay silent');
});

test('register: exceptions fail open (usage throws, log write throws)', async () => {
  const a = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, usageThrows: true });
  assert.deepEqual(await a.fire({ trigger: 'auto', messages: [] }), { messages: ['compacted'] });
  assert.equal(a.nexted.length, 1);
  const b = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: 1000, writeThrows: true });
  const r = await b.fire({ trigger: 'auto', messages: [] });
  assert.equal(r.skip, SKIP_REASON, 'a failed log write does not change the decision');
});

test('register: log falls back to the config dir when the data dir is not exposed', async () => {
  const t = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: 1000, env: { CLAUDE_CONFIG_DIR: '/cfg' } });
  await t.fire({ trigger: 'auto', messages: [] });
  assert.ok(t.files.has('/cfg/agent-companion/compact-floor.log'));
});

test('register: AGENT_COMPANION_STATE_DIR wins, then the data dir', async () => {
  const a = fakeEngine({ options: { main_compact_floor_tokens: 367000 }, tokens: 1000, env: { AGENT_COMPANION_STATE_DIR: '/state', CLAUDE_PLUGIN_DATA: '/data/ac' } });
  await a.fire({ trigger: 'auto', messages: [] });
  assert.ok(a.files.has('/state/compact-floor.log'));
});

// ---- manifest ------------------------------------------------------------

test('hooks.json names the module and still carries the classic hooks', () => {
  const j = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(j.modules, ['./compact-floor.mjs']);
  assert.ok(j.hooks && Object.keys(j.hooks).length >= 5, 'classic hooks survive the merge');
  assert.ok(Array.isArray(j.hooks.PreCompact), 'the existing PreCompact command hook is intact');
});

test('plugin.json option: number, default 0 (off)', () => {
  const j = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const o = j.userConfig.main_compact_floor_tokens;
  assert.equal(o.type, 'number');
  assert.equal(o.default, 0);
});
