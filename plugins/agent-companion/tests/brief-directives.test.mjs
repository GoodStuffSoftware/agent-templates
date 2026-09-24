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

// 0.29.0 final review F4: more lines a markdown reader does not see as the
// brief's own text, and whitespace that hid a real header.
test('F4 unit: HTML comments; BOM, NBSP and nested list items; a line after a quote still counts', () => {
  // HTML comments, one line or many, and one opened mid-line.
  assert.equal(typeOf('<!--\nTYPE: a\n-->\nTYPE: b'), 'b');
  assert.equal(typeOf('<!-- TYPE: a -->\nTYPE: b'), 'b');
  assert.equal(typeOf('  <!-- note\nTYPE: a --> tail\nTYPE: b'), 'b', 'the closing line is inside the comment block');
  assert.equal(typeOf('see <!--\nTYPE: a\n-->\nTYPE: b'), 'b');
  assert.equal(typeOf('<!--\nTYPE: a\nTYPE: b'), null, 'an unclosed comment runs to the end');
  assert.equal(typeOf('<!---->\nTYPE: b'), 'b');
  assert.equal(typeOf('<!-->\nTYPE: b'), 'b', '"<!-->" is a whole (empty) comment');
  assert.equal(typeOf('use `<!--` to open one\nTYPE: b'), 'b', 'inline code is not a comment');
  assert.equal(typeOf('TYPE: b <!-- a note\nTYPE: a\n-->'), 'b', 'text before a mid-line opener is read');
  // A line right after a quote is NOT read as the quote's lazy continuation
  // (lead decision on F4): excluding it would drop a real header and its
  // floor, and the same text unquoted in the body already counts.
  assert.equal(typeOf('> quoted\nTYPE: b'), 'b');
  assert.equal(typeOf('> quoted\n**TYPE:** b'), 'b');
  assert.equal(typeOf('> quoted\n> TYPE: a\nTYPE: b'), 'b');
  // Whitespace that hid a header.
  assert.equal(typeOf('\uFEFFTYPE: b'), 'b');
  assert.equal(typeOf('\u00A0TYPE: b'), 'b');
  assert.equal(typeOf('\u200BTYPE: b'), 'b');
  assert.equal(typeOf('TYPE:\u00A0b'), 'b');
  assert.equal(typeOf('\u00A0\u00A0\u00A0\u00A0TYPE: a\nTYPE: b'), 'b', 'four no-break spaces are indented code');
  // Indentation: a nested list item counts, indented code does not.
  assert.equal(typeOf('- details\n    - TYPE: b'), 'b');
  assert.equal(typeOf('- details\n\t- TYPE: b'), 'b');
  assert.equal(typeOf('1. step\n   - TYPE: b'), 'b');
  assert.equal(typeOf('- details\n      TYPE: a\nTYPE: b'), 'b', '4 columns beyond the item\'s content is indented code');
  assert.equal(typeOf('\tTYPE: a\nTYPE: b'), 'b', 'a tab-indented line outside a list is indented code');
  assert.equal(typeOf('- item\n\nTYPE: b'), 'b');
  // Fences inside list items close relative to the item, and end with it.
  assert.equal(typeOf('- pasted:\n    ```\n    TYPE: a\n    ```\nTYPE: b'), 'b');
  assert.equal(typeOf('- pasted:\n  ```\n  TYPE: a\nTYPE: b'), 'b', 'the item ends, and its fence with it');
  assert.equal(typeOf('```\nTYPE: a\nTYPE: b'), null, 'a top-level unclosed fence still runs to the end');
});

// The F4 parser's own edges: comments and fences nested in each other and in
// list items, Unicode spaces, deep lists. Each was also run through the
// real guard before release; kept here as a unit record.
test('F4 unit: comments, fences, quotes and lists nested in one another', () => {
  const conseq = (text) => declarationValue(briefDeclarations(text), 'CONSEQUENCE', /(routine|elevated|critical)\b/.source)?.[1] ?? null;
  const warranted = (text) => !!briefDeclarations(text).WARRANT;
  assert.equal(typeOf('```\n<!--\n```\nTYPE: b'), 'b', 'a comment opener inside a fence opens nothing');
  assert.equal(typeOf('<!--\n```\n-->\nTYPE: b'), 'b', 'a fence inside a comment opens nothing');
  assert.equal(typeOf('    <!--\nTYPE: b'), 'b', 'an indented comment opener is code');
  assert.equal(warranted('<!-- x --> WARRANT: frontier\ngo'), false, 'text after a same-line comment on its opening line is part of it');
  assert.equal(conseq('TYPE: x\n<!-- a\n--> CONSEQUENCE: routine\ngo'), null, 'the closing line is inside the comment');
  assert.equal(conseq('TYPE: x\n- note\n  <!--\n  CONSEQUENCE: routine\n  -->\ngo'), null, 'a comment inside a list item');
  assert.equal(conseq('TYPE: x\n- q:\n  > CONSEQUENCE: routine\ngo'), null, 'a quote inside a list item');
  assert.equal(conseq('TYPE: x\n- pasted:\n    ```\n    consequence: routine\n    ```\ngo'), null, 'a fence indented 4 under a list item');
  assert.equal(warranted('- a\n  - b\n    ```\n    WARRANT: frontier\n    ```\ngo'), false, 'a fence in a nested list item');
  assert.equal(conseq('TYPE: x\n* * *\n    CONSEQUENCE: routine\ngo'), null, 'a thematic break opens no list: the next line is indented code');
  assert.equal(conseq('TYPE: x\n- a\n        weight: 1\n        CONSEQUENCE: routine\ngo'), null, 'indented code inside a list item');
  assert.equal(conseq('TYPE: x\n- a\n  - b\n    - c\n      - CONSEQUENCE: critical\ngo'), 'critical', 'a deeply nested list item');
  assert.equal(conseq('TYPE: x\n-\tCONSEQUENCE: critical\ngo'), 'critical', 'a tab after the list marker');
  assert.equal(conseq('\u2003CONSEQUENCE: critical\ngo'), 'critical', 'an em space before a header');
});

test('F4: through the guard, an HTML comment neither warrants nor down-routes; a nested or BOM-led header counts', () => {
  const inComment = spawn('<!--\nWARRANT: frontier reasoning\n-->\ndo it', 'sess-f4-1', 'fable');
  assert.equal(inComment.decision, 'deny', 'a WARRANT inside an HTML comment satisfied the warrant');
  assert.match(inComment.reason, /Premium warrant/);
  const hidden = spawn('TYPE: critical-change\n<!--\nCONSEQUENCE: routine\n-->\ndo it', 'sess-f4-2');
  const plain = spawn('TYPE: critical-change\ndo it', 'sess-f4-2b');
  assert.equal(hidden.row.declared_consequence, 'critical');
  assert.deepEqual({ ...hidden.row, at: 0, session_id: 0 }, { ...plain.row, at: 0, session_id: 0 }, 'a CONSEQUENCE inside an HTML comment changed the spawn');
  assert.equal(hidden.decision, plain.decision);
  const nested = spawn('TYPE: integration\n- details\n    - CONSEQUENCE: critical\ndo it', 'sess-f4-3');
  assert.equal(nested.row.declared_consequence, 'critical', 'a nested list item\'s CONSEQUENCE was dropped');
  const bom = spawn('\uFEFFCONSEQUENCE: critical\ndo it', 'sess-f4-4');
  assert.equal(bom.row.declared_consequence, 'critical', 'a header behind a BOM was dropped');
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
