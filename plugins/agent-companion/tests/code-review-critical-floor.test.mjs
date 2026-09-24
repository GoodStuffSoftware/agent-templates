// F1 on a critical code-review spawn (0.29.0 RC review R6, lead decision).
// A parity-sized type has no route without a writer, so the spawn guard's
// fit check never ran for it: "TYPE: code-review" + "CONSEQUENCE: critical"
// on sonnet or haiku was allowed in silence. F1 holds whatever the writer
// was, so such a spawn is now expected to be at least opus/xhigh; below
// that it is "under", handled like any other under-provisioned fit (allowed,
// said out loud, fit: under in telemetry). With no writer declared, parity
// (F3) still cannot be checked, and a tier above the floor is not judged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

const DEFS = { 'opus-high': 'model: opus\neffort: high', 'opus-xhigh': 'model: opus\neffort: xhigh' };

function spawn(prompt, { model, subagent = 'general-purpose' } = {}) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    for (const [n, fm] of Object.entries(DEFS)) writeFileSync(join(dir, '.claude', 'agents', `${n}.md`), `---\nname: ${n}\n${fm}\n---\nbody\n`);
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: 'sess-cr-floor', agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: subagent, ...(model ? { model } : {}), run_in_background: true, name: 'w', isolation: 'worktree', prompt },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0] || null;
    return { decision: res.json?.hookSpecificOutput?.permissionDecision, reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '', msg: res.json?.systemMessage || '', row };
  } finally { cleanup(); }
}

const CRITICAL = 'TYPE: code-review\nCONSEQUENCE: critical\nreview the migration';

for (const model of ['sonnet', 'haiku']) {
  test(`a critical code review on ${model} is under-provisioned (F1: opus/xhigh)`, () => {
    const r = spawn(CRITICAL, { model });
    assert.equal(r.decision, 'allow', r.reason);
    assert.match(r.msg, /under-provisioned/);
    assert.match(r.msg, /F1: a critical review is never sized below opus\/xhigh/);
    assert.equal(r.row.fit, 'under');
    assert.equal(r.row.fit_expected, 'opus/xhigh');
  });
}

test('a critical code review on opus/high (from its definition) is under on effort', () => {
  const r = spawn(`${CRITICAL}\nWARRANT: critical review`, { subagent: 'opus-high' });
  assert.equal(r.decision, 'allow', r.reason);
  assert.match(r.msg, /under-provisioned — right tier; effort high is below xhigh/);
  assert.equal(r.row.fit, 'under');
});

test('a critical code review on opus/xhigh meets the floor: no note, no fit verdict', () => {
  const r = spawn(`${CRITICAL}\nWARRANT: critical review`, { subagent: 'opus-xhigh' });
  assert.equal(r.decision, 'allow', r.reason);
  assert.doesNotMatch(r.msg, /under-provisioned|F1:/);
  assert.equal(r.row.fit, null);
});

test('a routine code review on sonnet is unchanged: no floor, no verdict', () => {
  const r = spawn('TYPE: code-review\nreview the diff', { model: 'sonnet' });
  assert.equal(r.decision, 'allow', r.reason);
  assert.doesNotMatch(r.msg, /under-provisioned|F1:/);
  assert.equal(r.row.fit, null);
});

test('a critical code review on fable is not judged over-provisioned (no writer to size against)', () => {
  const r = spawn(`${CRITICAL}\nWARRANT: reviewing a fable writer`, { model: 'fable' });
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.fit, null);
});

test('a critical code review naming no model is not autofilled (parity needs a writer)', () => {
  const r = spawn(CRITICAL);
  assert.equal(r.row.model_autofilled, false);
  assert.equal(r.row.fit, null);
});
