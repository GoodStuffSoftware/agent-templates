// Reviewer parity with the consequence floors (operator-decided 2026-09-24;
// a deliberate behaviour change over slice 1, which applied F3 only):
//   model  = max(writer model, F1's model floor when the consequence is critical)
//   effort = max(writer effort, F1's effort floor when critical)
//   then F2 caps it: fable is never a destination — a fable writer's reviewer
//   is opus, which still demands a warrant, never a silent fable route;
//   F4: an unknown writer model is not passed through (no route), a retired
//   one is replaced by its staged successor, an unavailable one with none is
//   no route. F5 (elevated) is not applied to parity: the rule names F1 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, runScript } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const BEFORE = '2026-09-24T12:00:00Z';
const AFTER = '2026-10-20T12:00:00Z'; // haiku's retiresAfter has passed
const label = (r) => `${r.model}${r.effort ? '/' + r.effort : ''}`;
const writerOf = (s) => { const [model, effort] = s.split('/'); return { model, effort: effort || '' }; };
const review = (writer, consequence, now = BEFORE) => ctx.resolveRoute({
  type: 'code-review', writer: writerOf(writer), now,
  ...(consequence ? { consequence, consequenceExplicit: true } : {}),
});

// [writer, consequence, expected reviewer]
const MATRIX = [
  // F3 alone, unchanged from slice 1: the reviewer is the writer.
  ['sonnet/low', null, 'sonnet/low'],
  ['sonnet/low', 'routine', 'sonnet/low'],
  ['haiku', null, 'haiku'],
  ['opus', null, 'opus'],
  ['opus/xhigh', null, 'opus/xhigh'],
  ['opus/max', 'critical', 'opus/max'], // effort may exceed the floor
  ['claude-sonnet-5/medium', null, 'claude-sonnet-5/medium'],
  // F5 is not part of the parity rule.
  ['sonnet/low', 'elevated', 'sonnet/low'],
  ['haiku', 'elevated', 'haiku'],
  // F1 on a critical change: never below opus/xhigh.
  ['sonnet/low', 'critical', 'opus/xhigh'],
  ['haiku', 'critical', 'opus/xhigh'],
  ['opus', 'critical', 'opus/xhigh'],
  ['opus/low', 'critical', 'opus/xhigh'],
  ['claude-sonnet-5/medium', 'critical', 'opus/xhigh'],
  // F2 caps a fable writer's reviewer to opus.
  ['fable/high', null, 'opus/high'],
  ['fable/high', 'elevated', 'opus/high'],
  ['fable', null, 'opus'],
  ['fable/high', 'critical', 'opus/xhigh'],
  ['fable/max', null, 'opus/max'],
];
for (const [w, c, want] of MATRIX) {
  test(`parity: writer ${w}${c ? `, ${c}` : ''} -> reviewer ${want}`, () => {
    const r = review(w, c);
    assert.equal(r.layer, 'grid');
    assert.equal(r.source, 'reviewer-parity');
    assert.equal(label(r), want);
  });
}

test('F1 raises on a critical review are recorded, and the rationale says so', () => {
  const r = review('sonnet/low', 'critical');
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F1', raised: 'model sonnet -> opus' },
    { floor: 'F1', raised: 'effort low -> xhigh' },
  ]);
  assert.equal(r.rationale, 'reviewer parity: model matches the writer (sonnet); effort at least low; floors: F1 model sonnet -> opus, F1 effort low -> xhigh -> opus/xhigh');
  const h = review('haiku', 'critical');
  assert.deepEqual(h.floorsApplied.map((f) => f.raised), ['model haiku -> opus', 'effort (none) -> xhigh']);
  const lines = ctx.explainRoute(r).join('\n');
  assert.match(lines, /winner:\s+grid -> opus\/xhigh \(a parity-sized type is sized to its writer\)/);
  assert.match(lines, /floors:\s+F1 model sonnet -> opus; F1 effort low -> xhigh/);
});

test('F3 alone fires no floor: an unchanged review records nothing', () => {
  const r = review('opus/xhigh', null);
  assert.deepEqual(r.floorsApplied, []);
  assert.equal(r.rationale, 'reviewer parity: model matches the writer (opus); effort at least xhigh');
});

test('F2: a fable writer is capped to opus, recorded as a cap that needs its own warrant', () => {
  const r = review('fable/high', null);
  assert.deepEqual(r.floorsApplied, [
    { floor: 'F2', capped: 'model fable -> opus (fable is never a routing destination; reviewing on it needs its own WARRANT)' },
  ]);
  assert.notEqual(r.model, 'fable');
});

test('F4: an unknown writer model is not passed straight through — no route, with the reason', () => {
  for (const w of ['gpt-x/high', 'frobnicator', 'claude-unknown-9']) {
    const r = review(w, null);
    assert.equal(r.layer, null, w);
    assert.equal(r.model, '', w);
    assert.match(r.rationale, /^F4: writer model "[^"]+" is not in the tier table/, w);
    assert.match(r.skipped.at(-1).reason, /^F4:/);
    assert.equal(r.stack.find((s) => s.layer === 'grid').status, 'unresolved');
  }
});

test('F4: an unavailable writer tier with no staged replacement is no route (mythos)', () => {
  const r = review('mythos/high', null);
  assert.equal(r.layer, null);
  assert.match(r.rationale, /^F4: writer model mythos is unavailable/);
});

test('F4: a retired writer tier is reviewed on its staged replacement, then F1 applies on top', () => {
  assert.equal(label(review('haiku', null, BEFORE)), 'haiku');
  const r = review('haiku', null, AFTER);
  assert.equal(label(r), 'sonnet/low');
  assert.equal(r.floorsApplied[0].floor, 'F4');
  assert.match(r.floorsApplied[0].raised, /^model haiku -> sonnet \(haiku retired after 2026-10-15; its staged replacement stands in\)$/);
  assert.equal(label(review('haiku', 'critical', AFTER)), 'opus/xhigh');
});

// --- CLI ---------------------------------------------------------------------

test('recommend: a critical review is opus/xhigh, with the floors in the rationale', () => {
  const j = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'sonnet/low', '--consequence', 'critical', '--json']).json;
  assert.equal(`${j.model}/${j.effort}`, 'opus/xhigh');
  assert.equal(j.warrantRequired, true);
  assert.match(j.rationale, /; floors: F1 model sonnet -> opus, F1 effort low -> xhigh -> opus\/xhigh$/);
  // Unchanged when no floor fires.
  const u = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'sonnet/low', '--json']).json;
  assert.equal(`${u.model}/${u.effort}`, 'sonnet/low');
  assert.equal(u.rationale, 'reviewer parity: model matches the writer (sonnet); effort at least low, may exceed');
});

test('recommend: a fable writer gets opus with a warrant demanded, not a fable route', () => {
  const j = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'fable/high', '--json']).json;
  assert.equal(`${j.model}/${j.effort}`, 'opus/high');
  assert.equal(j.warrantRequired, true);
  assert.ok(j.warrantTemplate);
  assert.match(j.rationale, /F2 model fable -> opus/);
});

test('recommend and evaluate refuse an unknown writer model instead of echoing it back', () => {
  const r = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'gpt-x/high']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot size a reviewer for writer "gpt-x\/high": F4: writer model "gpt-x" is not in the tier table/);
  assert.equal(r.stdout, '');
  const e = runScript('scripts/evaluate.mjs', ['--model', 'opus', '--effort', 'high', '--type', 'code-review', '--writer', 'gpt-x/high']);
  assert.equal(e.status, 3);
  assert.match(e.stderr, /cannot size a reviewer for writer "gpt-x\/high"/);
});

test('evaluate: a reviewer sized to a sonnet writer is under-provisioned on a critical change', () => {
  const under = runScript('scripts/evaluate.mjs', ['--model', 'sonnet', '--effort', 'low', '--type', 'code-review', '--writer', 'sonnet/low', '--consequence', 'critical', '--json']);
  assert.equal(under.status, 2);
  assert.equal(under.json.verdict, 'under');
  assert.equal(`${under.json.expected.model}/${under.json.expected.effort}`, 'opus/xhigh');
  assert.match(under.json.expected.rationale, /; floors: F1 /);
  const fit = runScript('scripts/evaluate.mjs', ['--model', 'opus', '--effort', 'xhigh', '--type', 'code-review', '--writer', 'sonnet/low', '--consequence', 'critical', '--json']);
  assert.equal(fit.status, 0);
  assert.equal(fit.json.verdict, 'fit');
  // A fable reviewer of a fable writer is over the capped route: it needs a warrant.
  const over = runScript('scripts/evaluate.mjs', ['--model', 'fable', '--effort', 'high', '--type', 'code-review', '--writer', 'fable/high', '--json']);
  assert.equal(over.json.verdict, 'over');
  assert.match(over.json.action, /WARRANT/);
});

// --- F4 on the writer's effort (0.29.0 RC review R5) -------------------------
// Parity passed an unusable effort straight through: haiku/low -> haiku/low
// (haiku takes no effort parameter) and opus/bogus -> opus/bogus. The effort
// is now normalised for the reviewer's model, and one that is no effort level
// at all is refused like an unknown writer model.

test('F4 effort: a writer effort on a model that takes none is dropped, and recorded', () => {
  const r = review('haiku/low', null);
  assert.equal(label(r), 'haiku');
  assert.deepEqual(r.floorsApplied, [{ floor: 'F4', capped: 'effort low -> (none) (haiku takes no effort parameter)' }]);
  assert.equal(label(review('haiku/low', 'critical')), 'opus/xhigh');
  assert.equal(label(review('haiku/low', null, AFTER)), 'sonnet/low', 'a retired haiku writer is reviewed on its replacement at the writer effort');
});

test('F4 effort: a writer effort that is no effort level is refused, never echoed back', () => {
  for (const w of ['opus/bogus', 'sonnet/minimal', 'haiku/turbo']) {
    const r = review(w, null);
    assert.equal(r.model, '', w);
    assert.equal(r.layer, null, w);
    assert.match(r.rationale, /^F4: writer effort "[^"]+" is not an effort level/, w);
  }
  assert.equal(review('gpt-x/bogus', null).rationale.startsWith('F4: writer model "gpt-x"'), true, 'an unknown model is still reported first');
});

test('F4 effort: an effort level is matched case-insensitively', () => {
  assert.equal(label(review('opus/HIGH', null)), 'opus/high');
});

test('recommend and evaluate: haiku/low reviews on haiku with no effort; opus/bogus is refused', () => {
  const j = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'haiku/low', '--json']).json;
  assert.equal(j.model, 'haiku');
  assert.equal(j.effort, '');
  const r = runScript('scripts/recommend.mjs', ['--type', 'code-review', '--writer', 'opus/bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot size a reviewer for writer "opus\/bogus": F4: writer effort "bogus" is not an effort level/);
  const e = runScript('scripts/evaluate.mjs', ['--model', 'opus', '--effort', 'high', '--type', 'code-review', '--writer', 'opus/bogus']);
  assert.equal(e.status, 3);
});
