// Regression coverage for a live bug (2026-09-23, agent-companion 0.27.1)
// in hooks/spawn-guard.mjs's premium-warrant machinery under routing trial
// v2 (config/model-tiers.json v7), where most task types now route to opus:
//
//   (1) The premium-tier set was hard-coded to the tier table's classifyModel()
//       classification alone (isPremium(model) === classifyModel(model).premium).
//       Under the trial, a TYPE that correctly routes to opus (e.g.
//       "TYPE: integration" -> opus/high) still demanded a "WARRANT: weight N
//       — ..." line and was BLOCKED without one, even though the routing
//       table itself prescribed that exact tier for that exact spawn.
//
//   (2) When a warrant WAS added ("WARRANT: weight 4 — ..."), its digit was
//       parsed by the SAME regex used for an explicit "WEIGHT:" line, so the
//       warrant's own weight silently overrode the declared TYPE's preset
//       and its routing-trial override. The spawn was then judged against
//       the PLAIN GRID's answer for that (wrong) weight instead of the
//       type's own override, produced a manufactured "over-provisioned"
//       mismatch, and was BLOCKED — contradicting the trial's own routing
//       for that exact type.
//
// The fix (see hooks/spawn-guard.mjs, "Premium-tier determination" and the
// weight-parsing block above it):
//   - A model is premium FOR THIS SPAWN unless the SAME resolved routing
//     that answers "what should this run on" (a declared TYPE with its
//     trial override, or the plain grid for an explicit WEIGHT) also names
//     it. Fable is excluded from this exception — nothing routes to fable,
//     so no route can ever justify it; it stays a warranted exception
//     unconditionally.
//   - A WARRANT's own stated weight ("WARRANT: weight N — ...") is never
//     treated as an EXPLICIT weight declaration for the purpose of bypassing
//     a named TYPE's own preset/override. Only a genuine "WEIGHT:" line is.
//     Precedence: explicit TYPE (with its trial override) > a real WEIGHT:
//     line > a WARRANT's own stated weight.
//   - A spawn with NEITHER a TYPE NOR a WEIGHT that requests a premium tier
//     still falls back to the base tier-table classification (the "default
//     the guard already uses for undeclared spawns"), but a missing warrant
//     in that specific shape WARNS rather than BLOCKS, because the guard has
//     no routing information to confirm the tier either way. Fable, and any
//     case where routing IS known, still block on a missing warrant exactly
//     as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function baseEnv(dir) {
  return { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') };
}

// --- (a) opus + TYPE: integration, no warrant -> allowed --------------------

test('(a) opus + TYPE: integration with NO warrant is ALLOWED — the trial routes this TYPE to opus, so opus is not premium for this spawn', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-bug-a-integration',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        run_in_background: true,
        name: 'integration-worker',
        prompt: 'TYPE: integration\ndo the multi-file change',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(res.json));
    assert.doesNotMatch(res.json?.systemMessage || '', /Premium warrant|Best fit/i);

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 0, `expected no denials: ${JSON.stringify(denials)}`);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.declared_type, 'integration');
    assert.equal(row.fit_trial, true);
    assert.equal(row.fit_expected, 'opus/high');
  } finally {
    cleanup();
  }
});

// --- (b) opus + TYPE: novel-design + WARRANT: weight 4 -> allowed, fit -----

test('(b) opus + TYPE: novel-design + "WARRANT: weight 4 — ..." is ALLOWED and FIT — the warrant\'s weight (4) must not override the type\'s own preset (5) or its routing-trial override', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-bug-b-novel-design',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        run_in_background: true,
        name: 'novel-design-worker',
        prompt: 'TYPE: novel-design\nWARRANT: weight 4 — architecture-level, needs deep reasoning\ndesign the protocol',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(res.json));
    assert.doesNotMatch(res.json?.systemMessage || '', /Premium warrant|Best fit|over-provisioned/i);

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 0, `expected no denials: ${JSON.stringify(denials)}`);

    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0];
    assert.equal(row.declared_type, 'novel-design');
    assert.equal(row.fit, 'fit', JSON.stringify(row));
    assert.equal(row.fit_trial, true);
    // novel-design's own override is opus/high — NOT the plain grid's answer
    // for weight 4 (the warrant's own digit), which would have been sonnet.
    assert.equal(row.fit_expected, 'opus/high');
  } finally {
    cleanup();
  }
});

// --- (c) fable, no warrant -> still blocked ---------------------------------

test('(c) fable with NO warrant is still BLOCKED — fable is never a routing destination, so no TYPE/WEIGHT can excuse it', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-bug-c-fable',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'fable',
        run_in_background: true,
        name: 'fable-worker',
        prompt: 'a long autonomous run with no stated justification',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(res.json));
    assert.match(res.json?.hookSpecificOutput?.permissionDecisionReason || '', /Premium warrant/i);

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 1, JSON.stringify(denials));
    assert.equal(denials[0].guard, 'warrant');
  } finally {
    cleanup();
  }
});

// --- (c-bis) fable stays blocked even WITH a TYPE/WEIGHT declared ----------

test('(c-bis) fable with a declared TYPE and no warrant is ALSO still blocked — a route can never justify fable', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-bug-c-fable-typed',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'fable',
        run_in_background: true,
        name: 'fable-worker-typed',
        // long-autonomous-run carries NO routing-trial override — the plain
        // grid resolves weight 5/bounded/elevated to opus/xhigh, so a fable
        // request here is a genuine model-tier MISMATCH (fable outranks
        // opus), caught by the best-fit check before the warrant check is
        // even reached. Either way it is denied — fable is never excused.
        prompt: 'TYPE: long-autonomous-run\ndo the long run',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(res.json));
    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 1, JSON.stringify(denials));
    assert.equal(denials[0].guard, 'fit');
    assert.match(res.json?.hookSpecificOutput?.permissionDecisionReason || '', /Best fit/i);
  } finally {
    cleanup();
  }
});

// --- (d) opus with no TYPE or WEIGHT -> documented behaviour: warn, not block

test('(d) opus with NO TYPE, NO WEIGHT and no warrant: routing cannot be inferred, so the guard WARNS instead of blocking', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-bug-d-undeclared',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        run_in_background: true,
        name: 'undeclared-worker',
        prompt: 'do the thing, nothing declared',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    // Not blocked: the default the guard already uses for an undeclared
    // spawn (base tier-table classification) still applies, but a missing
    // warrant is a WARNING here, not a denial, because the guard has no
    // routing information to confirm the tier either way.
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'allow', JSON.stringify(res.json));
    assert.match(res.json?.systemMessage || '', /no WARRANT line/i, JSON.stringify(res.json));
    assert.match(res.json?.systemMessage || '', /no TYPE or WEIGHT is declared/i);

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 0, `expected no denials: ${JSON.stringify(denials)}`);
  } finally {
    cleanup();
  }
});

// --- A genuine WEIGHT: line still explicitly overrides a TYPE's preset -----

test('a REAL "WEIGHT:" line (not a warrant) still explicitly overrides a declared TYPE, and a resulting mismatch still blocks — proves the fix only changed WARRANT parsing, not WEIGHT precedence', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const payload = {
      session_id: 'sess-weight-line-explicit',
      agent_type: 'main',
      cwd: dir,
      tool_input: {
        subagent_type: 'general-purpose',
        model: 'opus',
        run_in_background: true,
        name: 'weight-override-worker',
        // TYPE: integration would normally route to opus/high (trial). An
        // explicit WEIGHT: 2 deliberately deviates from the type's own
        // preset (per taskTypesNote) and falls back to the plain grid,
        // where weight 2 is haiku-tier — opus is now genuinely
        // over-provisioned, and that must still be caught.
        prompt: 'TYPE: integration\nWEIGHT: 2\ndo a small piece of it',
      },
    };
    const res = runHook('hooks/spawn-guard.mjs', payload, { env: baseEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(res.json));
    assert.match(res.json?.hookSpecificOutput?.permissionDecisionReason || '', /Best fit/i);

    const denials = readJsonl(join(stateDir, 'telemetry', 'denials.jsonl'));
    assert.equal(denials.length, 1, JSON.stringify(denials));
    assert.equal(denials[0].guard, 'fit');
  } finally {
    cleanup();
  }
});

// --- Baseline: the existing suite's 517/0 must still hold -------------------
// (covered by running the full `node --test` run in CI/release verification,
// not duplicated here — this file only adds the four bug-specific cases plus
// one precedence-confirming case.)
