// Review findings for scripts/lib/cache-advisor.mjs (branch wip/ac-cache-window-review).
// Each test states what Claude Code actually does and FAILS on the reviewed
// commit. Sources: the settings schema and compaction code of the installed
// Claude Code 2.1.280 (read as strings from the binary, no model call) and the
// live docs (code.claude.com/docs/en/env-vars, settings-reference; 2026-09-26).
// Every fixture is SYNTHETIC.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';

const FILE_FIXTURE = makeFixture();
after(() => FILE_FIXTURE.cleanup());
import {
  configuredWindow, windowSpecFor, thresholdFor, collectAdvisorInputs,
} from '../scripts/lib/cache-advisor.mjs';

// R1. The settings schema is autoCompactWindow: number().int().min(100000)
// .max(1000000).optional().catch(undefined). A string such as "400k" (or a
// bare 400) fails it and is silently dropped, so the model's default window is
// in effect. Reporting "configured 400K" misstates what the operator runs.
test('R1 configuredWindow: a settings value Claude Code drops is not a configured window', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: '400k' }));
    assert.equal(configuredWindow({ env: {}, settingsPath }).tokens, null, 'the string "400k" fails the integer schema and is ignored');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: 400 }));
    assert.equal(configuredWindow({ env: {}, settingsPath }).tokens, null, 'a bare 400 is below the 100000 minimum and is ignored');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: 400000 }));
    assert.equal(configuredWindow({ env: {}, settingsPath }).tokens, 400000);
  } finally { cleanup(); }
});

// R2. Docs (env-vars): "a value like 500k reads as 500 and clamps to the 100K
// minimum" — the variable is still in effect, at 100K, and it beats settings.
test('R2 configuredWindow: CLAUDE_CODE_AUTO_COMPACT_WINDOW=500k is in effect at 100K', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoCompactWindow: 400000 }));
    assert.equal(configuredWindow({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }, settingsPath }).tokens, 100000);
  } finally { cleanup(); }
});

// R3. A set window W gives an effective window W - min(maxOutput, 20000) and
// compaction at effective - 13000, i.e. W - 33K for current models. That is
// also why the unset 1M default is 967K and 200K models compact at ~167K
// (measured on this operator's sonnet-4-6 sessions: 167K-174K).
test('R3 thresholdFor: a set window compacts 33K below the value, like the defaults do', () => {
  const s = windowSpecFor('claude-sonnet-5');
  assert.equal(thresholdFor(1000000, s), 967000);
  assert.equal(thresholdFor(250000, s), 217000, '/autocompact 250k compacts at about 217K');
  assert.equal(thresholdFor(400000, s), 367000);
});

test('R4 windowSpecFor: 200K models compact at about 167K by default, not at 200K', () => {
  assert.equal(windowSpecFor('claude-haiku-4-5-20251001').defaultCompactAt, 167000);
  assert.equal(windowSpecFor('claude-sonnet-4-6').defaultCompactAt, 167000);
});

// R5. Benchmark runs (bench/runner.mjs with isolate_home false) write their
// headless sessions under <root>/<...-Temp-bench-...>/. They are synthetic
// tasks, not the operator's traffic, and a headless run has one prompt and no
// counted turn, which inflates requests per turn (sonnet-5: 8.5 pooled vs 4.5
// real-only on the review corpus).
test('R5 collectAdvisorInputs: bench sandbox sessions are not pooled with real traffic', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'projects');
    const T0 = Date.parse('2026-09-01T00:00:00.000Z');
    const at = (ms) => new Date(T0 + ms).toISOString();
    let n = 0;
    const uid = () => `u${++n}`;
    const recs = (tag) => [
      { type: 'user', uuid: uid(), timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      ...[1, 2, 3].flatMap((i) => [
        { type: 'assistant', uuid: uid(), timestamp: at(i * 2000), requestId: `${tag}${i}`, message: { id: `m-${tag}${i}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: i * 1000, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } } },
        { type: 'user', uuid: uid(), timestamp: at(i * 2000 + 1000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      ]),
    ];
    const write = (p, rs) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, rs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
    write(join(root, 'C--Users-you-dev-proj', 'real1.jsonl'), recs('a'));
    write(join(root, 'C--Users-you-AppData-Local-Temp-bench-sonnet-medium-task-AbC123', 'bench1.jsonl'), recs('b'));
    const inputs = await collectAdvisorInputs({ root, days: 30, now: new Date(T0 + 86400000) });
    assert.equal(inputs.models.get('claude-sonnet-5').requests, 3, 'only the real session counts');
  } finally { cleanup(); }
});
