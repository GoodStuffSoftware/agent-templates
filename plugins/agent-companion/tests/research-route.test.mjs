// research is its own task type (0.31.17): sonnet/medium, not an alias of explore.
// A spawn whose resolved route is a Haiku rung but asks for another model gets an
// advisory note (a Haiku-trial leak); never a deny.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';
import { modelTiers, canonicalTaskType } from '../hooks/lib/context.mjs';

const rec = (...args) => runScript('scripts/recommend.mjs', args);

test('research is a shipped type routed sonnet/medium; explore stays haiku; no alias shadows it', () => {
  const cfg = modelTiers();
  assert.ok(cfg.taskTypes.research);
  assert.equal(cfg.taskTypeAliases.research, undefined);
  assert.deepEqual(canonicalTaskType('research'), { name: 'research', via: 'shipped' });
  assert.match(cfg.taskTypes.explore.summary, /excludes multi-hop research/);
  const r = rec('--type', 'research', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.taskType, 'research');
  assert.equal(r.json.aliasOf, undefined);
  assert.equal(`${r.json.model}/${r.json.effort}`, 'sonnet/medium');
  const e = rec('--type', 'explore', '--json');
  assert.equal(e.json.model, 'haiku');
  assert.equal(e.json.effort, 'medium');
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
    return { res, row: rows[rows.length - 1], ctx: `${hso.additionalContext || ''} ${res.json?.systemMessage || ''}`, decision: hso.permissionDecision };
  } finally {
    cleanup();
  }
}

test('guard: TYPE research on sonnet is on-route, no Haiku leak note', () => {
  const s = spawn('TYPE: research\nROLE: lookup\ncompare the docs', 'sess-res-ok', 'sonnet');
  assert.equal(s.row.fit_expected, 'sonnet/medium');
  assert.doesNotMatch(s.ctx, /trial leak/);
});

test('guard: a Haiku route asked for another model gets the leak note, never a deny', () => {
  const s = spawn('TYPE: explore\nROLE: lookup\nfind the file', 'sess-leak-note', 'sonnet');
  assert.equal(s.row.fit_expected, 'haiku/medium');
  assert.notEqual(s.decision, 'deny');
  assert.match(s.ctx, /trial leak/);
  assert.match(s.ctx, /REASON:/);
});

test('guard: the leak note is silent with a REASON or WARRANT line, and on a haiku spawn', () => {
  const r = spawn('TYPE: explore\nROLE: lookup\nREASON: needs cross-file synthesis\nfind the file', 'sess-leak-reason', 'sonnet');
  assert.doesNotMatch(r.ctx, /trial leak/);
  assert.notEqual(r.decision, 'deny');
  const w = spawn('TYPE: explore\nROLE: lookup\nWARRANT: weight 3 - synthesis\nfind the file', 'sess-leak-warrant', 'sonnet');
  assert.doesNotMatch(w.ctx, /trial leak/);
  const h = spawn('TYPE: explore\nROLE: lookup\nfind the file', 'sess-leak-haiku', 'haiku');
  assert.doesNotMatch(h.ctx, /trial leak/);
});
