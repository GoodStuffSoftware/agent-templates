// The decision register's `signal` trigger kind (scripts/lib/decision-register.mjs): the
// validator, the scan of the scout's own signals, flag-once behaviour, the detail file and the
// example register. Synthetic fixtures with fixed 2026 timestamps.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import {
  TRIGGER_KINDS, validateRegister, scanSignals, scanSignalsToState, emptyState, readState, openFlags, detailMarkdown, pendingFlags,
} from '../scripts/lib/decision-register.mjs';

const NOW = Date.parse('2026-10-12T10:00:00Z');

function signalTrigger(over = {}) {
  return { id: 'sig', premise: 'p1', kind: 'signal', signalKinds: ['pinned_model_id', 'model_tier_data_changed'], ...over };
}
function register(triggers = [signalTrigger()], over = {}) {
  return {
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'dec-one', title: 'Decision one', status: 'active', decided: '2026-10-10', decision: 'What is standing.',
      reverse: 'How to undo it.', premises: [{ id: 'p1', text: 'The claim.', label: 'E' }], evidence: ['notes/evidence.md'],
      triggers, ...over,
    }],
  };
}
const valid = (reg) => validateRegister(reg, { rollout: {} });
const sg = (kind, detail) => ({ kind, detail, dispatch: 'none' });

test('signal is a trigger kind and a well-formed signal trigger validates', () => {
  assert.ok(TRIGGER_KINDS.includes('signal'));
  const v = valid(register());
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('the validator rejects a signal trigger with no kinds, odd kinds or a bad pattern', () => {
  for (const bad of [
    signalTrigger({ signalKinds: undefined }),
    signalTrigger({ signalKinds: [] }),
    signalTrigger({ signalKinds: ['Not Valid'] }),
    signalTrigger({ signalKinds: [3] }),
    signalTrigger({ pattern: '(' }),
    signalTrigger({ pattern: 'ok', flags: 5 }),
  ]) {
    const v = valid(register([bad]));
    assert.equal(v.ok, false, JSON.stringify(bad));
  }
  assert.equal(valid(register([signalTrigger({ pattern: 'haiku', flags: 'i' })])).ok, true);
});

test('a listened-to signal flags once; the same text again does not; new text flags again', () => {
  const state = emptyState();
  const reg = register();
  const text = 'tier data moved: haiku claude-haiku-4-5 -> claude-haiku-5-5';
  const fresh = scanSignals([sg('model_tier_data_changed', text)], reg, state, { nowT: NOW });
  assert.equal(fresh.length, 1);
  const flag = state.flags[fresh[0]];
  assert.equal(flag.kind, 'signal');
  assert.equal(flag.severity, 'signal');
  assert.equal(flag.decision, 'dec-one');
  assert.match(flag.summary, /scout model_tier_data_changed: "tier data moved: haiku claude-haiku-4-5/);
  assert.equal(scanSignals([sg('model_tier_data_changed', text)], reg, state, { nowT: NOW + 1000 }).length, 0);
  assert.equal(scanSignals([sg('model_tier_data_changed', `${text}; sonnet claude-sonnet-5 -> claude-sonnet-5-5`)], reg, state, { nowT: NOW + 2000 }).length, 1);
  assert.equal(Object.keys(state.flags).length, 2);
});

test('a signal kind the trigger does not list, or text the pattern does not match, flags nothing', () => {
  const reg = register([signalTrigger({ signalKinds: ['pinned_model_id'], pattern: 'haiku', flags: 'i' })]);
  const state = emptyState();
  assert.equal(scanSignals([sg('spawn_activity', 'haiku everywhere')], reg, state, { nowT: NOW }).length, 0);
  assert.equal(scanSignals([sg('pinned_model_id', '1 pinned model id(s): scheduled task a pins claude-sonnet-5')], reg, state, { nowT: NOW }).length, 0);
  assert.equal(scanSignals([sg('pinned_model_id', '1 pinned model id(s): scheduled task a pins claude-haiku-4-5')], reg, state, { nowT: NOW }).length, 1);
});

test('retired decisions, changelog triggers and junk input are ignored without throwing', () => {
  const state = emptyState();
  assert.deepEqual(scanSignals([sg('pinned_model_id', 'x')], register([signalTrigger()], { status: 'retired' }), state, { nowT: NOW }), []);
  const cl = { id: 'cl', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.296', pattern: 'x' };
  assert.deepEqual(scanSignals([sg('pinned_model_id', 'x')], register([cl]), state, { nowT: NOW }), []);
  for (const junk of [null, undefined, 'x', [null, 3, {}, { kind: 5 }]]) {
    assert.deepEqual(scanSignals(junk, register(), state, { nowT: NOW }), []);
  }
});

test('the flag shows in the open flags, the pending line list and the detail file', () => {
  const state = emptyState();
  const reg = register();
  scanSignals([sg('pinned_model_id', '1 pinned model id(s): scheduled task nightly pins claude-sonnet-5')], reg, state, { nowT: NOW });
  assert.equal(openFlags(state, reg, NOW + 1000).length, 1);
  assert.equal(pendingFlags({ state, register: reg, nowT: NOW + 1000 }).length, 1);
  const md = detailMarkdown(state, reg, NOW + 1000);
  assert.match(md, /scout signal pinned_model_id or model_tier_data_changed/);
  assert.match(md, /Scout signal pinned_model_id: 1 pinned model id\(s\): scheduled task nightly pins claude-sonnet-5/);
});

test('scanSignalsToState writes the state and the detail file only when a flag is new', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const registerFile = join(dir, 'register.json');
    const stateFile = join(dir, 'state.json');
    const detailFile = join(dir, 'details.md');
    writeFileSync(registerFile, JSON.stringify(register()));
    const sigs = [sg('pinned_model_id', '1 pinned model id(s): user settings model pins claude-opus-5')];
    const first = scanSignalsToState(sigs, { nowT: NOW, registerFile, stateFile, detailFile });
    assert.equal(first.ok, true);
    assert.equal(first.newFlags.length, 1);
    assert.ok(existsSync(detailFile));
    assert.equal(Object.keys(readState(stateFile).flags).length, 1);
    const again = scanSignalsToState(sigs, { nowT: NOW + 5000, registerFile, stateFile, detailFile });
    assert.deepEqual(again, { ok: true, newFlags: [] });
    assert.deepEqual(scanSignalsToState(sigs, { nowT: NOW, registerFile: join(dir, 'absent.json'), stateFile, detailFile }), { ok: false, newFlags: [] });
    writeFileSync(registerFile, '{ not json');
    assert.equal(scanSignalsToState(sigs, { nowT: NOW, registerFile, stateFile, detailFile }).ok, false);
  } finally { cleanup(); }
});

test('editing the trigger re-judges it: the old flag goes and the same text flags again', () => {
  const state = emptyState();
  const text = '1 pinned model id(s): scheduled task nightly pins claude-sonnet-5';
  scanSignals([sg('pinned_model_id', text)], register([signalTrigger()]), state, { nowT: NOW });
  assert.equal(Object.keys(state.flags).length, 1);
  const edited = register([signalTrigger({ signalKinds: ['pinned_model_id'] })]);
  assert.equal(scanSignals([sg('pinned_model_id', text)], edited, state, { nowT: NOW + 1000 }).length, 1);
});

test('the shipped example register validates and carries a signal trigger', () => {
  const reg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'decision-register.example.json'), 'utf8'));
  const v = validateRegister(reg, { rollout: {} });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const kinds = reg.decisions.flatMap((d) => d.triggers.map((t) => t.kind));
  assert.ok(kinds.includes('signal'));
});

// 0.31.17: a `\b` typed as a literal backspace compiles, so --check used to say OK.
test('the validator rejects a control character in a changelog or signal pattern or flags, naming decision, trigger and code point', () => {
  const changelog = (over) => ({ id: 'cl', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.296', pattern: 'cache ttl', ...over });
  for (const [trig, field, cp] of [
    [changelog({ pattern: '\u0008cache ttl\u0008' }), 'pattern', 'U+0008'],
    [changelog({ flags: 'i\u007f' }), 'flags', 'U+007F'],
    [signalTrigger({ pattern: 'haiku\u0000' }), 'pattern', 'U+0000'],
    [signalTrigger({ pattern: 'a\tb' }), 'pattern', 'U+0009'],
  ]) {
    const v = valid(register([trig]));
    assert.equal(v.ok, false, JSON.stringify(trig));
    const msg = v.errors.find((e) => e.includes(`${field} contains the control character ${cp}`));
    assert.ok(msg, v.errors.join(' | '));
    assert.match(msg, /dec-one/);
    assert.ok(msg.includes(`"${trig.id}"`), msg);
  }
  // an escaped \b (backslash, letter) still validates, in both kinds
  assert.equal(valid(register([changelog({ pattern: '\\bcache ttl\\b', flags: 'i' })])).ok, true);
  assert.equal(valid(register([signalTrigger({ pattern: '\\bhaiku\\b', flags: 'i' })])).ok, true);
});

test('the README documents the signal trigger and the pinned_model_check option', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /`signal`: `signalKinds`/);
  assert.match(readme, /\| `pinned_model_check` \|/);
});
