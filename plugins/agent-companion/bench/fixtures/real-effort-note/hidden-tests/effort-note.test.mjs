import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNoEffortNote, computeEffectiveEffort } from '../src/effort-note.mjs';
import { checkAgentDefNoEffortFinding } from '../src/checks-effort.mjs';

// Semantic helpers -- check BEHAVIOR (does the message convey the right
// mechanism/target), not exact wording. An earlier version of this file
// used literal-phrase regexes (e.g. /INHERIT/ requiring that exact
// uppercase word, /inherits the orchestrating session/ requiring that
// exact verb tense) that false-negatived multiple real, semantically
// correct answers during rep 1 (2026-09-23) -- e.g. "it will inherit the
// orchestrating session's current effort" failed /INHERIT/ purely on
// case, and "it will inherit the orchestrating session's..." failed
// /inherits the orchestrating session/ purely on verb tense (inherit vs
// inherits). Neither the task prompt nor the real commit's behavior
// requires any particular capitalization or tense -- only that the
// message names session inheritance as the mechanism. Fixed by checking
// concepts (word presence, case-insensitive) instead of literal phrases.
function mentionsSessionInheritance(text) {
  return /inherit/i.test(text) && /session/i.test(text);
}
function mentionsNoEffortStated(text) {
  return /no effort/i.test(text) || /effort.{0,20}(not stated|unstated|missing|unset)/i.test(text);
}
function mentionsModel(text, alias) {
  return text.toLowerCase().includes(String(alias).toLowerCase());
}

// --- pre-existing suite: opus behavior must still work ---

test('spawn resolving to opus with no effort anywhere gets a warning naming inheritance, not a model default', () => {
  const note = computeNoEffortNote({ model: 'claude-opus-5-5', def: null, declaredEffort: null });
  assert.ok(mentionsModel(note, 'opus'), 'expected the message to name opus, got: ' + note);
  assert.ok(mentionsNoEffortStated(note), 'expected the message to say no effort is stated, got: ' + note);
  assert.ok(mentionsSessionInheritance(note), 'expected the message to describe session inheritance, got: ' + note);
});

test('an EFFORT: line in the brief silences the warning', () => {
  const note = computeNoEffortNote({ model: 'claude-opus-5-5', def: null, declaredEffort: 'high' });
  assert.equal(note, null);
});

test('an agent definition with effort: set in frontmatter silences the warning', () => {
  const note = computeNoEffortNote({ model: 'claude-opus-5-5', def: { effort: 'high' }, declaredEffort: null });
  assert.equal(note, null);
});

// --- new tests from the fix: the hazard is not opus-only ---

test('a sonnet spawn with no effort anywhere ALSO gets the warning -- the hazard is not opus-only', () => {
  const note = computeNoEffortNote({ model: 'claude-sonnet-5', def: null, declaredEffort: null });
  assert.ok(mentionsModel(note, 'sonnet'), 'expected the message to name sonnet, got: ' + note);
  assert.ok(mentionsNoEffortStated(note), 'expected the message to say no effort is stated, got: ' + note);
});

test('a haiku spawn never gets the no-effort-stated warning -- it takes no effort parameter', () => {
  const note = computeNoEffortNote({ model: 'claude-haiku-4-5', def: null, declaredEffort: null });
  assert.equal(note, null);
});

// --- new tests from the fix: effective_effort telemetry ---

test('effective_effort records inherited(<caller effort>) when nothing else states one', () => {
  const eff = computeEffectiveEffort({ def: null, model: 'claude-opus-5-5', callerEffort: 'high' });
  assert.equal(eff, 'inherited(high)');
});

test('effective_effort records inherited(unknown) when the caller effort is not exposed', () => {
  const eff = computeEffectiveEffort({ def: null, model: 'claude-opus-5-5', callerEffort: null });
  assert.equal(eff, 'inherited(unknown)');
});

test('effective_effort still reports the definition value when one is set, ignoring caller effort', () => {
  const eff = computeEffectiveEffort({ def: { effort: 'low' }, model: 'claude-opus-5-5', callerEffort: 'max' });
  assert.equal(eff, 'low');
});

test('effective_effort is null for a no-effort model (haiku) regardless of caller effort', () => {
  const eff = computeEffectiveEffort({ def: null, model: 'claude-haiku-4-5', callerEffort: 'max' });
  assert.equal(eff, null);
});

test('a sonnet spawn with no stated effort also gets inherited(<caller effort>), not a model-default string', () => {
  const eff = computeEffectiveEffort({ def: null, model: 'claude-sonnet-5', callerEffort: 'medium' });
  assert.equal(eff, 'inherited(medium)');
});

// --- checks.mjs: agent-def static-audit finding ---

test('checkAgentDefNoEffortFinding: an opus definition with no effort gets a finding about session inheritance, not a model default', () => {
  const finding = checkAgentDefNoEffortFinding({ model: 'opus', effort: null });
  assert.ok(mentionsSessionInheritance(finding), 'expected the finding to describe session inheritance, got: ' + finding);
  assert.doesNotMatch(finding, /medium/i, 'must not repeat the old wrong "Opus 5.5 defaults to MEDIUM" premise');
});

test('checkAgentDefNoEffortFinding: a sonnet definition with no effort ALSO gets a finding -- not opus-only', () => {
  const finding = checkAgentDefNoEffortFinding({ model: 'sonnet', effort: null });
  assert.ok(mentionsNoEffortStated(finding), 'expected the finding to say no effort is stated, got: ' + finding);
});

test('checkAgentDefNoEffortFinding: a definition with effort stated gets no finding', () => {
  const finding = checkAgentDefNoEffortFinding({ model: 'opus', effort: 'high' });
  assert.equal(finding, null);
});

test('checkAgentDefNoEffortFinding: a haiku definition with no effort gets no finding -- it takes no effort parameter', () => {
  const finding = checkAgentDefNoEffortFinding({ model: 'haiku', effort: null });
  assert.equal(finding, null);
});
