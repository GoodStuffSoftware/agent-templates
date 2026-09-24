// Pins TODAY's spawn-guard behaviour for the brief shapes behind a live
// denial on 2026-09-24. That denial ("declares weight 4, which the routing
// table sends to sonnet/high") came from a STALE installed hook (0.22.0,
// which has no TYPE: parsing and takes a WARRANT's weight as the declared
// weight). On the current code the recommender's own template shape is
// allowed; that is case 1.
//
// Cases 2-5 are latent hazards in the CURRENT parser, pinned as-is because
// slice 1 changes no behaviour. Each one makes the guard fall to the grid and
// deny an opus spawn that the type's trial prescribes:
//   2. an explicit WEIGHT: line EQUAL to the preset still counted as a
//      departure (ADR §1 says only a value that DEPARTS should skip layers
//      1-2) — FIXED in slice 1b (a);
//   3. a prose "kind: <x>" anywhere in the body is parsed as an explicit
//      KIND (the regexes are unanchored and case-insensitive) — since 1b (a)
//      only a departing value (3b) still denies;
//   4. a markdown-bold "**TYPE:** integration" is not parsed, so the type is
//      lost and the warrant's weight is used;
//   5. an earlier stray "type: x" token wins over the real TYPE: line.
// A later slice that fixes these must flip the matching assertions here
// deliberately — that edit IS the behaviour change, and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

function spawnOpus(prompt, sid) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model: 'opus', run_in_background: true, name: 'w', isolation: 'worktree', prompt },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0] || null;
    return { decision: res.json?.hookSpecificOutput?.permissionDecision, reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '', msg: res.json?.systemMessage || '', row };
  } finally { cleanup(); }
}

test('1. "TYPE: integration / EFFORT: high / WARRANT: weight 4 — ..." on opus is ALLOWED through the shipped trial (opus/high)', () => {
  const r = spawnOpus('TYPE: integration\nEFFORT: high\nWARRANT: weight 4 — shared surfaces other agents depend on\ndo the multi-file change', 'sess-pin-1');
  assert.equal(r.decision, 'allow', r.reason);
  assert.doesNotMatch(r.msg, /Best fit|Premium warrant|over-provisioned/);
  assert.equal(r.row.declared_type, 'integration');
  assert.equal(r.row.declared_weight, 4);
  assert.equal(r.row.declared_kind, 'bounded');
  assert.equal(r.row.declared_consequence, 'elevated');
  assert.equal(r.row.fit, 'fit');
  assert.equal(r.row.fit_expected, 'opus/high');
  assert.equal(r.row.fit_trial, true);
  assert.equal(r.row.route_layer, 'trial');
});

// FLIPPED in slice 1b fix (a): a WEIGHT: line equal to the preset restates
// the type, so the trial applies (ADR §1).
test('2. TYPE: integration + "WEIGHT: 4" (equal to the preset) restates the type -> shipped trial opus/high -> ALLOWED', () => {
  const r = spawnOpus('TYPE: integration\nWEIGHT: 4\nWARRANT: weight 4 — x\ndo it', 'sess-pin-2');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.fit_expected, 'opus/high');
  assert.equal(r.row.route_layer, 'trial');
});

// 3a FLIPPED in slice 1b fix (a): the stray prose "kind: bounded" is still
// parsed as a KIND line, but it equals the preset, so it no longer departs.
test('3a. a prose "kind: bounded" line equal to the preset no longer departs -> trial -> ALLOWED', () => {
  const r = spawnOpus('TYPE: integration\nWARRANT: weight 4 — x\nThe kind: bounded work is in three files', 'sess-pin-3a');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.route_layer, 'trial');
});

test('3b. TODAY: a prose "kind: mechanical" in the body is parsed as an explicit KIND that departs -> grid -> DENIED', () => {
  const r = spawnOpus('TYPE: integration\nWARRANT: weight 4 — x\nThe kind: mechanical parts are renames', 'sess-pin-3b');
  assert.equal(r.decision, 'deny');
  assert.equal(r.row.declared_type, 'integration');
  assert.equal(r.row.declared_kind, 'mechanical');
  assert.equal(r.row.route_layer, 'grid');
});

test('4. TODAY: "**TYPE:** integration" (markdown bold) is not parsed -> the warrant weight is used -> DENIED', () => {
  const r = spawnOpus('**TYPE:** integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-4');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /declares weight 4 \(bounded\), routine consequence, which the routing table sends to sonnet\/high/);
  assert.equal(r.row.declared_type, null);
});

test('5. TODAY: an earlier stray "type: x" token wins over the real TYPE: line -> DENIED', () => {
  const r = spawnOpus('Brief for type: cleanup\nTYPE: integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5');
  assert.equal(r.decision, 'deny');
  assert.equal(r.row.declared_type, 'cleanup');
});
