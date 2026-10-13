// 0.31.17 granularity split: lookup, survey and bounded-feature-small are shipped
// task types that resolve through the grid (no override); explore stays a real type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';
import { modelTiers, canonicalTaskType } from '../hooks/lib/context.mjs';

const rec = (...args) => runScript('scripts/recommend.mjs', args);

const ROUTES = {
  lookup: 'haiku/medium',
  survey: 'sonnet/medium',
  'bounded-feature-small': 'sonnet/medium',
};

for (const [t, route] of Object.entries(ROUTES)) {
  test(`${t} is a shipped type routed ${route}, no override, no alias`, () => {
    const cfg = modelTiers();
    assert.ok(cfg.taskTypes[t]);
    assert.equal(cfg.taskTypes[t].override, undefined);
    assert.equal(cfg.taskTypeAliases[t], undefined);
    assert.deepEqual(canonicalTaskType(t), { name: t, via: 'shipped' });
    const r = rec('--type', t, '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.taskType, t);
    assert.equal(r.json.aliasOf, undefined);
    assert.equal(`${r.json.model}/${r.json.effort}`, route);
  });
}

test('explore stays a real type on the Haiku trial row; analysis still aliases it', () => {
  const cfg = modelTiers();
  assert.ok(cfg.taskTypes.explore.override);
  assert.equal(cfg.taskTypeAliases.analysis, 'explore');
  const e = rec('--type', 'explore', '--json');
  assert.equal(`${e.json.model}/${e.json.effort}`, 'haiku/medium');
});

function spawn(prompt, sid, model) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model, prompt, run_in_background: true, name: 'w' },
    });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const hso = res.json?.hookSpecificOutput || {};
    return { row: rows[rows.length - 1], ctx: `${hso.additionalContext || ''} ${res.json?.systemMessage || ''}`, decision: hso.permissionDecision };
  } finally {
    cleanup();
  }
}

test('guard: TYPE survey on sonnet is on-route, no Haiku leak note', () => {
  const s = spawn('TYPE: survey\nROLE: lookup\nread the docs and summarise', 'sess-survey-ok', 'sonnet');
  assert.equal(s.row.fit_expected, 'sonnet/medium');
  assert.doesNotMatch(s.ctx, /trial leak/);
});

test('guard: TYPE lookup on sonnet gets the Haiku leak note; on haiku it does not', () => {
  const s = spawn('TYPE: lookup\nROLE: lookup\nfind the file', 'sess-lookup-leak', 'sonnet');
  assert.equal(s.row.fit_expected, 'haiku/medium');
  assert.notEqual(s.decision, 'deny');
  assert.match(s.ctx, /trial leak/);
  const h = spawn('TYPE: lookup\nROLE: lookup\nfind the file', 'sess-lookup-haiku', 'haiku');
  assert.doesNotMatch(h.ctx, /trial leak/);
});
