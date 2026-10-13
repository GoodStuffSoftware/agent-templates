// 0.31.17: a tier's minEffort (haiku: medium) also floors a parity-sized review, so a
// haiku/low writer gets a haiku/medium reviewer. Raises only; sonnet and opus unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const review = (writer, extra = {}) => {
  const [model, effort] = writer.split('/');
  return ctx.resolveRoute({ type: 'code-review', writer: { model, effort: effort || '' }, ...extra });
};

test('haiku/low writer gets a haiku/medium reviewer, with the floor note', () => {
  const r = review('haiku/low');
  assert.equal(label(r), 'haiku/medium');
  assert.match(JSON.stringify(r), /haiku-min-effort/);
  assert.match(JSON.stringify(r), /haiku never runs below medium/);
});

test('haiku/high and haiku/medium writers are unchanged; sonnet and opus parity rows are unchanged', () => {
  for (const w of ['haiku/medium', 'haiku/high', 'sonnet/low', 'sonnet/high', 'opus/low', 'opus/xhigh']) assert.equal(label(review(w)), w, w);
});

test('recommend.mjs prints haiku/medium for a haiku/low writer', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'haiku/low']);
  assert.match(res.stdout, /recommendation:\s+haiku\/medium/);
});

test('spawn guard: a reviewer brief with WRITER: haiku/low expects haiku/medium', () => {
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: 'sess-tier-min', agent_type: 'main', cwd: fx.dir,
    tool_input: { run_in_background: true, name: 'r1', isolation: 'worktree', subagent_type: 'agent-companion:ac-haiku', prompt: 'TYPE: code-review\nWRITER: haiku/low\nreview' },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
  assert.equal(res.status, 0, res.stderr);
  const rows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl'));
  assert.equal(rows[rows.length - 1].fit_expected, 'haiku/medium');
});
