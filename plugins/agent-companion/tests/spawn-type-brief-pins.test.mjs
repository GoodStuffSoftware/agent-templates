// Pins TODAY's spawn-guard behaviour for the brief shapes behind a live
// denial on 2026-09-24. That denial ("declares weight 4, which the routing
// table sends to sonnet/high") came from a STALE installed hook (0.22.0,
// which has no TYPE: parsing and takes a WARRANT's weight as the declared
// weight). On the current code the recommender's own template shape is
// allowed; that is case 1.
//
// Cases 2-5 were latent hazards in the slice-1 parser, pinned as-is there
// because slice 1 changed no behaviour; slice 1b fixed them. Each one makes the guard fall to the grid and
// deny an opus spawn that the type's trial prescribes:
//   2. an explicit WEIGHT: line EQUAL to the preset still counted as a
//      departure (ADR §1 says only a value that DEPARTS should skip layers
//      1-2) — FIXED in slice 1b (a);
//   3. a prose "kind: <x>" anywhere in the body is parsed as an explicit
//      KIND (the regexes are unanchored and case-insensitive) — since 1b (a)
//      only a departing value (3b) still denied — FIXED in slice 1b (b);
//   4. a markdown-bold "**TYPE:** integration" was not parsed, so the type
//      was lost and the warrant's weight used — FIXED in slice 1b (b);
//   5. an earlier stray "type: x" token won over the real TYPE: line —
//      FIXED in slice 1b (b).
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

test('1. "TYPE: integration / EFFORT: high / WARRANT: weight 4 — ..." on opus is ALLOWED through the shipped trial (opus/medium)', () => {
  const r = spawnOpus('TYPE: integration\nEFFORT: high\nWARRANT: weight 4 — shared surfaces other agents depend on\ndo the multi-file change', 'sess-pin-1');
  assert.equal(r.decision, 'allow', r.reason);
  assert.doesNotMatch(r.msg, /Best fit|Premium warrant|over-provisioned/);
  assert.equal(r.row.declared_type, 'integration');
  assert.equal(r.row.declared_weight, 4);
  assert.equal(r.row.declared_kind, 'bounded');
  assert.equal(r.row.declared_consequence, 'elevated');
  assert.equal(r.row.fit, 'fit');
  assert.equal(r.row.fit_expected, 'opus/medium');
  assert.equal(r.row.fit_trial, true);
  assert.equal(r.row.route_layer, 'trial');
});

// FLIPPED in slice 1b fix (a): a WEIGHT: line equal to the preset restates
// the type, so the trial applies (ADR §1).
test('2. TYPE: integration + "WEIGHT: 4" (equal to the preset) restates the type -> shipped trial opus/medium -> ALLOWED', () => {
  const r = spawnOpus('TYPE: integration\nWEIGHT: 4\nWARRANT: weight 4 — x\ndo it', 'sess-pin-2');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.fit_expected, 'opus/medium');
  assert.equal(r.row.route_layer, 'trial');
});

// 3a FLIPPED in slice 1b fix (a): the stray prose "kind: bounded" is still
// parsed as a KIND line, but it equals the preset, so it no longer departs.
test('3a. a prose "kind: bounded" line equal to the preset no longer departs -> trial -> ALLOWED', () => {
  const r = spawnOpus('TYPE: integration\nWARRANT: weight 4 — x\nThe kind: bounded work is in three files', 'sess-pin-3a');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.route_layer, 'trial');
});

// 3b, 4 and 5 FLIPPED in slice 1b fix (b): declarations are read only from
// a line of their own (optionally list-marked and/or markdown-bold), and the
// first TYPE line naming a known task type wins.
test('3b. a prose "kind: mechanical" mid-sentence is no longer a KIND declaration -> trial -> ALLOWED', () => {
  const r = spawnOpus('TYPE: integration\nWARRANT: weight 4 — x\nThe kind: mechanical parts are renames', 'sess-pin-3b');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_type, 'integration');
  assert.equal(r.row.declared_kind, 'bounded'); // filled from the preset, not the prose
  assert.equal(r.row.route_layer, 'trial');
});

test('3c. a prose "weight: 4 files" mid-sentence is no longer a WEIGHT declaration', () => {
  const r = spawnOpus('TYPE: integration\nWARRANT: weight 4 — x\nTouches weight: 2 files only', 'sess-pin-3c');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_weight, 4);
  assert.equal(r.row.route_layer, 'trial');
});

test('3d. a KIND: line of its own that departs still departs -> grid -> DENIED', () => {
  const r = spawnOpus('TYPE: integration\nKIND: mechanical\nWARRANT: weight 4 — x\ndo it', 'sess-pin-3d');
  assert.equal(r.decision, 'deny');
  assert.equal(r.row.declared_kind, 'mechanical');
  assert.equal(r.row.route_layer, 'grid');
});

for (const [n, line] of [['4', '**TYPE:** integration'], ['4b', '**TYPE**: integration'], ['4c', '**TYPE: integration**'], ['4d', '- TYPE: integration'], ['4e', '  Type: integration']]) {
  test(`${n}. "${line}" is parsed as TYPE -> trial opus/medium -> ALLOWED`, () => {
    const r = spawnOpus(`${line}\nWARRANT: weight 4 — x\ndo it`, `sess-pin-${n}`);
    assert.equal(r.decision, 'allow', r.reason);
    assert.equal(r.row.declared_type, 'integration');
    assert.equal(r.row.fit_expected, 'opus/medium');
    assert.equal(r.row.route_layer, 'trial');
  });
}

test('5. an earlier stray "type: x" mid-sentence is ignored; the TYPE: line wins -> ALLOWED', () => {
  const r = spawnOpus('Brief for type: cleanup\nTYPE: integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_type, 'integration');
});

// 5b FLIPPED in the 0.29.0 RC review (R1, lead decision): the FIRST
// line-anchored TYPE wins whether or not it names a known type, so a body
// line can never replace a header. An unfenced, shallow-indented YAML
// "type: object" ahead of the TYPE line is now that first TYPE: unknown, no
// type route, the warrant's weight 4 goes to the grid (sonnet/high) -> DENIED.
// Fence the snippet (5d) or indent it as code (5e) and the TYPE line wins.
test('5b. an earlier line-start "type: object" (a YAML snippet) is the first TYPE and stays unknown -> grid -> DENIED', () => {
  const r = spawnOpus('schema:\n  type: object\nTYPE: integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5b');
  assert.equal(r.decision, 'deny');
  assert.equal(r.row.declared_type, 'object');
  assert.equal(r.row.route_layer, 'grid');
});

test('5d. the same YAML inside a fenced code block is not a declaration; the TYPE line wins -> ALLOWED', () => {
  const r = spawnOpus('```yaml\nschema:\n  type: object\n```\nTYPE: integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5d');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_type, 'integration');
  assert.equal(r.row.route_layer, 'trial');
});

test('5e. the same YAML as indented code (4 spaces) is not a declaration; the TYPE line wins -> ALLOWED', () => {
  const r = spawnOpus('schema:\n\n    type: object\n\nTYPE: integration\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5e');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_type, 'integration');
});

test('5c. with no known type anywhere, the first TYPE line is still recorded as declared', () => {
  const r = spawnOpus('TYPE: cleanup\nWARRANT: weight 4 — x\ndo it', 'sess-pin-5c');
  assert.equal(r.row.declared_type, 'cleanup');
});
