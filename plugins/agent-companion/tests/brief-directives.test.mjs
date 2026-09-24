// Brief directive parsing in the spawn guard (0.29.0 RC review R1, lead
// decision): lines inside fenced code, indented code and > blockquotes are
// never declarations, and the FIRST line-anchored occurrence of each label
// wins whether or not its value is valid. Before this, a body line could
// replace a misspelt or unknown header TYPE (first KNOWN type won) and
// down-route the spawn past the warrant and the cap, and a pasted
// "WEIGHT: 1" / "KIND: mechanical" / "WARRANT: ..." inside a code block or a
// quote counted as the brief's own declaration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { briefDeclarations, declarationLines, declarationValue } from '../hooks/lib/brief-directives.mjs';

const TYPE_SRC = /([a-z][a-z0-9-]*)\b/.source;
const typeOf = (text) => declarationValue(briefDeclarations(text), 'TYPE', TYPE_SRC)?.[1] ?? null;

test('unit: fenced, indented and quoted lines are never declarations', () => {
  assert.equal(typeOf('```\nTYPE: a\n```\nTYPE: b'), 'b');
  assert.equal(typeOf('~~~yaml\nTYPE: a\n~~~\nTYPE: b'), 'b');
  assert.equal(typeOf('    TYPE: a\nTYPE: b'), 'b');
  assert.equal(typeOf('\tTYPE: a\nTYPE: b'), 'b');
  assert.equal(typeOf('  \tTYPE: a\nTYPE: b'), 'b', 'a tab reaching column 4 is indented code');
  assert.equal(typeOf('> TYPE: a\nTYPE: b'), 'b');
  assert.equal(typeOf('>TYPE: a\nTYPE: b'), 'b');
  assert.equal(typeOf('   > TYPE: a\nTYPE: b'), 'b');
  // Still declarations: up to 3 columns of indent, list markers, bold, CRLF.
  assert.equal(typeOf('   TYPE: a'), 'a');
  assert.equal(typeOf('- TYPE: a'), 'a');
  assert.equal(typeOf('* **TYPE:** a'), 'a');
  assert.equal(typeOf('intro\r\nTYPE: a\r\n'), 'a');
});

test('unit: a fence closes only on the same character, at least as long, with nothing after it', () => {
  assert.equal(typeOf('~~~\n```\nTYPE: a\n~~~\nTYPE: b'), 'b', 'a ``` line does not close a ~~~ fence');
  assert.equal(typeOf('````\n```\nTYPE: a\n````\nTYPE: b'), 'b', 'a shorter fence does not close a longer one');
  assert.equal(typeOf('```\nTYPE: a\n``` not a close\nTYPE: b\n```\nTYPE: c'), 'c');
  assert.equal(typeOf('```\nTYPE: a\nTYPE: b'), null, 'an unclosed fence runs to the end');
  // Inline code opening a line is not a fence: the lines after it are live.
  assert.equal(typeOf('```inline ` code```\nTYPE: b'), 'b');
});

test('unit: the first occurrence of each label wins, valid or not', () => {
  const d = briefDeclarations('TYPE: frobnicat\nWEIGHT: 9\nKIND: bogus\ntype: explore\nWEIGHT: 2\nKIND: mechanical');
  assert.equal(declarationValue(d, 'TYPE', TYPE_SRC)[1], 'frobnicat');
  assert.equal(declarationValue(d, 'WEIGHT', /([1-5])\b/.source), null);
  assert.equal(declarationValue(d, 'KIND', /(mechanical|bounded)\b/.source), null);
  assert.equal(declarationValue(briefDeclarations('TYPE: 42x\nTYPE: explore'), 'TYPE', TYPE_SRC), null);
  assert.deepEqual(declarationLines('a\n```\nb\n```\n> c\n    d\ne'), ['a', 'e']);
});

// --- Through the hook ------------------------------------------------------
function spawn(prompt, sid, model = 'opus') {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: 'general-purpose', model, run_in_background: true, name: 'w', isolation: 'worktree', prompt },
    }, { env: { CLAUDE_PLUGIN_DATA: join(dir, '.claude', 'plugins', 'data', 'agent-companion-x') } });
    assert.equal(res.status, 0, res.stderr);
    const row = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'))[0] || null;
    const wf = join(stateDir, 'state', 'premium-window.json');
    const window = existsSync(wf) ? JSON.parse(readFileSync(wf, 'utf8')) : [];
    return { decision: res.json?.hookSpecificOutput?.permissionDecision, reason: res.json?.hookSpecificOutput?.permissionDecisionReason || '', msg: res.json?.systemMessage || '', row, window };
  } finally { cleanup(); }
}

test('a misspelt header TYPE is not replaced by a body "type: explore": no route, so the warrant and the cap still apply', () => {
  const r = spawn('TYPE: intergration\nPasted config:\ntype: explore\ndo the change', 'sess-dir-1');
  assert.equal(r.row.declared_type, 'intergration');
  assert.equal(r.row.route_layer, null);
  assert.equal(r.decision, 'allow', r.reason);
  assert.match(r.msg, /premium tier, with no WARRANT line/);
  assert.equal(r.window.length, 1, 'the premium spawn must count toward the cap');
});

test('a fenced "WEIGHT: 1" does not depart from the TYPE preset', () => {
  const r = spawn('TYPE: integration\nWARRANT: weight 4 — x\nExample brief:\n```\nWEIGHT: 1\n```\ndo it', 'sess-dir-2');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_weight, 4);
  assert.equal(r.row.route_layer, 'trial');
});

test('a blockquoted "KIND: mechanical" does not depart from the TYPE preset', () => {
  const r = spawn('TYPE: integration\nWARRANT: weight 4 — x\n> KIND: mechanical\ndo it', 'sess-dir-3');
  assert.equal(r.decision, 'allow', r.reason);
  assert.equal(r.row.declared_kind, 'bounded');
  assert.equal(r.row.route_layer, 'trial');
});

test('a fenced "CONSEQUENCE: routine" ahead of the header does not win over it', () => {
  const r = spawn('```\nCONSEQUENCE: routine\n```\nTYPE: integration\nCONSEQUENCE: critical\ndo it', 'sess-dir-4', 'sonnet');
  assert.equal(r.row.declared_consequence, 'critical');
  assert.equal(r.row.fit_expected, 'opus/xhigh');
  assert.equal(r.row.fit, 'under');
});

test('an invalid first WEIGHT declares no weight; a later valid one does not replace it', () => {
  const r = spawn('WEIGHT: 9\nWEIGHT: 2\ndo it', 'sess-dir-5', 'sonnet');
  assert.equal(r.row.declared_weight, null);
  assert.equal(r.row.fit, null);
});

test('an invalid first TYPE value is not replaced by a later known one', () => {
  const r = spawn('TYPE: 42-things\nTYPE: explore\ndo it', 'sess-dir-6');
  assert.equal(r.row.declared_type, null);
  assert.equal(r.row.route_layer, null);
});

test('a WARRANT inside a fenced block is not the brief\'s warrant: fable is still denied', () => {
  const r = spawn('Earlier brief, for reference:\n```\nWARRANT: weight 5 — x\n```\ndo it', 'sess-dir-7', 'fable');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Premium warrant/);
});

test('a WARRANT line of its own still satisfies the warrant', () => {
  const r = spawn('Context first.\n- WARRANT: frontier reasoning\ndo it', 'sess-dir-8', 'fable');
  assert.equal(r.decision, 'allow', r.reason);
});
