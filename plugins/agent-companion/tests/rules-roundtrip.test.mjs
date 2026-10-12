// The rules CLI edits the operator's standing-rules.json as authored: add, disable, enable
// and remove change only the rule they name. activeFrom, after, then, and any unknown key,
// on every rule and at top level, come back unchanged. (0.31.13 rebuilt the file from compiled
// rules: it lost top-level keys and unknown entry keys, and on the operator's real file the
// activeFrom and top-level then of the lead-effort-check built-in override.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { rulesPath } from '../hooks/lib/rules.mjs';

const staged = {
  id: 'staged-note', enabled: true, scope: 'session-start', when: null, then: 'Current wording.',
  gate: null, note: 'staged rollout', activeFrom: 'leads-high', after: { then: 'New wording.', enabled: true },
  futureKey: { nested: [1, 2, 3] },
};
const other = { id: 'plain-rule', enabled: true, scope: 'user-prompt', when: 'foo', then: 'Plain.', gate: null, note: null };
const operator = () => ({ version: 1, ownerNote: 'keep me', rules: [structuredClone(staged), structuredClone(other)] });

const cli = (...args) => {
  const r = runScript('scripts/rules.mjs', args);
  assert.equal(r.status, 0, `rules ${args.join(' ')} failed: ${r.stderr}`);
};
const readBack = () => JSON.parse(readFileSync(rulesPath(), 'utf8'));
const seed = (text) => {
  mkdirSync(dirname(rulesPath()), { recursive: true });
  writeFileSync(rulesPath(), text);
};

test('add, disable, enable, remove of another rule leave every field they do not own untouched', () => {
  const fx = makeFixture();
  try {
    seed(JSON.stringify(operator(), null, 2));

    cli('add', '--id', 'brand-new', '--scope', 'session-start', '--then', 'Added text.');
    const expected = operator();
    const added = readBack().rules[2].added; // stamped at add time; pinned in its own test below
    expected.rules.push({ id: 'brand-new', enabled: true, scope: 'session-start', when: null, then: 'Added text.', gate: null, note: null, added });
    assert.deepEqual(readBack(), expected, 'add changed only the new entry');

    cli('disable', 'plain-rule');
    expected.rules[1].enabled = false;
    assert.deepEqual(readBack(), expected, 'disable changed only enabled on plain-rule');

    cli('enable', 'plain-rule');
    expected.rules[1].enabled = true;
    assert.deepEqual(readBack(), expected, 'enable changed only enabled on plain-rule');

    cli('remove', 'brand-new');
    assert.deepEqual(readBack(), operator(), 'remove restored the original file');

    // disabling the staged rule itself keeps its schedule, overlay, wording and unknown key
    cli('disable', 'staged-note');
    const doc = readBack();
    assert.equal(doc.rules[0].enabled, false);
    assert.equal(doc.rules[0].activeFrom, 'leads-high');
    assert.deepEqual(doc.rules[0].after, staged.after);
    assert.equal(doc.rules[0].then, 'Current wording.');
    assert.deepEqual(doc.rules[0].futureKey, staged.futureKey);
    assert.equal(doc.ownerNote, 'keep me');

    assert.deepEqual(readdirSync(dirname(rulesPath())).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  } finally { fx.cleanup(); }
});

test('a built-in override with activeFrom, after and its own then survives disable and enable (the real-file case)', () => {
  const fx = makeFixture();
  try {
    const doc = {
      version: 1,
      rules: [{
        id: 'lead-effort-check', enabled: true, then: 'Operator wording.', activeFrom: 'leads-high',
        after: { then: 'Wording after the switch.' }, note: 'staged', futureKey: 7,
      }],
    };
    seed(`${JSON.stringify(doc, null, 2)}\n`);
    const before = readFileSync(rulesPath(), 'utf8');
    const env = { CLAUDE_PLUGIN_OPTION_LEAD_EFFORT_ROLLOUT_ID: 'leads-high' };
    for (const args of [['disable', 'lead-effort-check'], ['enable', 'lead-effort-check']]) {
      const r = runScript('scripts/rules.mjs', args, { env });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(readFileSync(rulesPath(), 'utf8'), before, 'disable then enable came back byte-identical');
  } finally { fx.cleanup(); }
});

test('an unparseable rules file is not overwritten by a write, and the error says why', () => {
  const fx = makeFixture();
  try {
    for (const bad of ['{ "rules": [ oops', '{ "version": 1, "rule": [] }', 'null']) {
      seed(bad);
      const r = runScript('scripts/rules.mjs', ['add', '--id', 'x-rule', '--scope', 'session-start', '--then', 'T']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /not changed.*valid JSON with a top-level "rules" array.*left untouched/s);
      assert.equal(readFileSync(rulesPath(), 'utf8'), bad);
    }
  } finally { fx.cleanup(); }
});

test('an empty rules file is treated as no rules: a write starts it afresh', () => {
  const fx = makeFixture();
  try {
    seed('');
    cli('add', '--id', 'x-rule', '--scope', 'session-start', '--then', 'T');
    assert.equal(readBack().rules.length, 1);
  } finally { fx.cleanup(); }
});

test('add refuses an id that the file already holds as a malformed entry', () => {
  const fx = makeFixture();
  try {
    const text = JSON.stringify({ version: 1, rules: [{ id: 'foo', scope: 'spwan', when: 'x', then: 'typo scope' }] });
    seed(text);
    const r = runScript('scripts/rules.mjs', ['add', '--id', 'foo', '--scope', 'session-start', '--then', 'T']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already holds an entry with id "foo"/);
    assert.equal(readFileSync(rulesPath(), 'utf8'), text);
  } finally { fx.cleanup(); }
});

test('add stamps added: <ISO now> on the new entry only; existing entries are untouched', () => {
  const fx = makeFixture();
  try {
    seed(JSON.stringify(operator(), null, 2));
    const before = Date.now();
    cli('add', '--id', 'stamped', '--scope', 'session-start', '--then', 'T');
    const after = Date.now();
    const doc = readBack();
    const entry = doc.rules.find((r) => r.id === 'stamped');
    assert.match(entry.added, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(entry.added) >= before - 1000 && Date.parse(entry.added) <= after + 1000);
    assert.deepEqual(doc.rules.slice(0, 2), operator().rules, 'existing entries carry no added key');
    assert.equal(doc.ownerNote, 'keep me');
  } finally { fx.cleanup(); }
});
