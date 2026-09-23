// STEP 0 gap fix (2026-09-23): the routing trial (model-tiers.json v6,
// taskTypes.*.override — see routing-trial.test.mjs for recommend.mjs's own
// coverage) was applied ONLY inside scripts/recommend.mjs. scripts/evaluate.mjs
// and hooks/spawn-guard.mjs's fit check both called effortFor() directly
// against the plain grid, so a spawn that correctly FOLLOWED a trial (e.g.
// debug-root-cause on opus/low) was judged over/under-provisioned against a
// grid answer the operator had already superseded.
//
// The fix extracts ONE shared resolver — resolveExpected() in
// hooks/lib/context.mjs — used by all three call sites. This file proves the
// other two now see the override: every overridden task type is judged FIT
// when the spawn follows the trial, and every UNMEASURED type still resolves
// exactly the plain grid, through both scripts/evaluate.mjs and
// hooks/spawn-guard.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLUGIN_ROOT, makeFixture, runScript, runHook, readJsonl,
} from './helpers.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'model-tiers.json'), 'utf8'));
const OVERRIDDEN = Object.entries(cfg.taskTypes).filter(([, t]) => t.override);
const UNMEASURED = Object.entries(cfg.taskTypes).filter(([, t]) => !t.override && t.weight !== 'parity');

assert.ok(OVERRIDDEN.length >= 6, `expected at least 6 overridden task types in the trial, found ${OVERRIDDEN.length}`);

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

// --- scripts/evaluate.mjs ---------------------------------------------------

for (const [type, t] of OVERRIDDEN) {
  const { model, effort } = t.override;
  test(`evaluate --type ${type} --model ${model} --effort ${effort} (trial-conforming) is judged FIT`, () => {
    const res = runScript('scripts/evaluate.mjs', ['--model', model, '--effort', effort, '--type', type, '--json']);
    assert.equal(res.status, 0, `expected exit 0 (fit); got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.verdict, 'fit', JSON.stringify(res.json));
    assert.ok(res.json.expected.trial, `${type}'s expected block must carry trial metadata, not the plain grid`);
    assert.equal(res.json.expected.model, model);
    assert.equal(res.json.expected.effort, effort);
  });
}

test('evaluate --type debug-root-cause --model sonnet --effort xhigh (the PLAIN GRID answer, pre-trial) is judged UNDER against the trial — proves the override is actually consulted here, not just in recommend.mjs', () => {
  // Grid resolution recorded in the trial's own metadata: weight 4 diagnostic
  // -> sonnet/xhigh (see tests/routing-trial.test.mjs). Before this file's
  // fix, evaluate.mjs computed its own "expected" from the plain grid,
  // which for this exact model/effort pair IS sonnet/xhigh — so the actual
  // and (bug-computed) expected matched and the call wrongly returned "fit".
  // With the shared resolver, expected is the trial's opus/low, and sonnet
  // outranks nothing above it, so this is UNDER-provisioned, not fit.
  const res = runScript('scripts/evaluate.mjs', ['--model', 'sonnet', '--effort', 'xhigh', '--type', 'debug-root-cause', '--json']);
  assert.equal(res.json.verdict, 'under', JSON.stringify(res.json));
  assert.equal(res.json.expected.model, 'opus');
  assert.equal(res.json.expected.effort, 'low');
});

for (const [type, t] of UNMEASURED) {
  test(`evaluate --type ${type} (unmeasured) resolves the SAME expected (model, effort) as a raw --weight/--kind/--consequence call`, () => {
    const typed = runScript('scripts/evaluate.mjs', ['--model', 'opus', '--effort', 'max', '--type', type, '--json']);
    const raw = runScript('scripts/evaluate.mjs', [
      '--model', 'opus', '--effort', 'max',
      '--weight', String(t.weight), '--kind', t.kind, '--consequence', t.consequence,
      '--json',
    ]);
    assert.equal(typed.status, raw.status, type);
    assert.equal(typed.json.expected.model, raw.json.expected.model, type);
    assert.equal(typed.json.expected.effort, raw.json.expected.effort, type);
    assert.ok(!typed.json.expected.trial, `${type} must not carry trial metadata — it is unbenchmarked`);
  });
}

// --- hooks/spawn-guard.mjs ---------------------------------------------------

for (const [type, t] of OVERRIDDEN) {
  test(`spawn-guard: TYPE: ${type} with a spawn naming the trial's model (${t.override.model}) is fit — no over/under note, no denial`, () => {
    const { dir, stateDir, cleanup } = makeFixture();
    try {
      const payload = {
        session_id: `sess-trial-${type}`,
        agent_type: 'main',
        cwd: dir,
        tool_input: {
          subagent_type: 'general-purpose',
          model: t.override.model,
          // No WEIGHT/KIND/CONSEQUENCE: line — only TYPE, so the resolver
          // must fill weight/kind/consequence from the type's own preset
          // AND apply its override, same as `recommend.mjs --type` does.
          // "WARRANT:" carries no digit, so it satisfies the warrant-required
          // check without also being captured as an explicit WEIGHT (which
          // would deliberately bypass the trial per taskTypesNote).
          prompt: `TYPE: ${type}\nWARRANT: follows the operator-approved routing trial\ndo the task`,
        },
      };
      const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(res.json));
      assert.doesNotMatch(res.json?.systemMessage || '', /over-provisioned|under-provisioned/i);

      const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
      assert.equal(denials.length, 0, `expected no denials: ${JSON.stringify(denials)}`);

      const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
      assert.equal(row.fit, 'fit', JSON.stringify(row));
      assert.equal(row.declared_type, type);
      assert.equal(row.fit_trial, true);
      assert.equal(row.fit_expected, `${t.override.model}${t.override.effort ? '/' + t.override.effort : ''}`);
    } finally {
      cleanup();
    }
  });
}

test('spawn-guard: TYPE: debug-root-cause with the PLAIN GRID model (sonnet) is judged UNDER against the trial\'s opus/low', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-trial-under',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'sonnet',
        prompt: 'TYPE: debug-root-cause\ndo the task',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.json?.systemMessage || '', /under-provisioned/i, JSON.stringify(res.json));
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.fit, 'under');
    assert.equal(row.fit_expected, 'opus/low');
    assert.equal(row.fit_trial, true);
  } finally {
    cleanup();
  }
});

for (const [type, t] of UNMEASURED) {
  test(`spawn-guard: TYPE: ${type} (unmeasured) resolves the plain grid, unaffected by the trial`, () => {
    const { dir, stateDir, cleanup } = makeFixture();
    try {
      const payload = {
        session_id: `sess-unmeasured-${type}`,
        agent_type: 'main',
        cwd: dir,
        // fable is deliberately far above whatever the plain grid resolves
        // to for every unmeasured type, so the fit machinery is guaranteed
        // to have engaged (fit_trial observably false) regardless of which
        // type this iteration is.
        tool_input: {
          subagent_type: 'general-purpose',
          model: 'fable',
          prompt: `TYPE: ${type}\nWARRANT: coverage for the unmeasured type\ndo the task`,
        },
      };
      const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
      assert.equal(res.status, 0, res.stderr);
      const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
      assert.equal(row.declared_type, type);
      assert.equal(row.fit_trial, false, `${type} must not use a trial override`);
    } finally {
      cleanup();
    }
  });
}
