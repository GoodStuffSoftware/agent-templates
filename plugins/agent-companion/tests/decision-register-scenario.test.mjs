// 0.31.18 batch 8: the `scenario` trigger kind of the decision register. It reads the usage
// analysis runner's results (state/usage-analysis/<day>.json) through the register's days contract
// and recomputes nothing. Synthetic results and register, fixture state root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, PLUGIN_ROOT } from './helpers.mjs';
import {
  TRIGGER_KINDS, EVALUATORS, validateRegister, emptyState, evaluateTriggers, evalScenario, scanSignals, runRegister, readState, writeState, openFlags,
} from '../scripts/lib/decision-register.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const RESULT_SCHEMA = 'agent-companion/usage-analysis-result';

function scenarioTrigger(extra = {}) {
  return { id: 'lead-cost', premise: 'p1', kind: 'scenario', scenario: 'lead.unitsPerPrompt', comparison: 'trailing-7', on: 'regression', minDays: 2, ...extra };
}

function register(triggers = [scenarioTrigger()], extra = {}) {
  return {
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'dec-one', title: 'Decision one', status: 'active', decided: '2026-10-01', decision: 'What is standing.', reverse: 'Undo it.',
      premises: [{ id: 'p1', text: 'The claim.', label: 'M' }],
      triggers, ...extra,
    }],
  };
}

const valid = (reg, opts = {}) => validateRegister(reg, { rollout: {}, scenarioIds: ['lead.unitsPerPrompt', 'spawn.unitsPerSpawn'], ...opts });

// A comparison the way compare.mjs writes it.
const cmp = (status, compare = 'trailing-7', value = 7) => ({ compare, status, current: { value, sample: 40 }, baseline: { value: 5, sample: 200 } });

function writeResult(fx, day, scenarioEntry) {
  const dir = join(fx.stateDir, 'state', 'usage-analysis');
  mkdirSync(dir, { recursive: true });
  const scenarios = scenarioEntry ? [scenarioEntry] : [];
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({ schema: RESULT_SCHEMA, day, revision: 1, scenarios }));
}
const entry = (status, compare = 'trailing-7', extra = {}) => ({ id: 'lead.unitsPerPrompt', severity: 'alert', status, comparisons: [cmp(status, compare)], ...extra });

function writeStatus(fx, days) {
  writeFileSync(join(fx.stateDir, 'state', 'usage-analysis-status.json'), JSON.stringify({ days }));
}

const hist = (...days) => days.map((day) => ({ day }));
const evalOn = (reg, state, days, extra = {}) => evaluateTriggers({ register: reg, history: hist(...days), nowT: NOW, state, ...extra });

function withFixture(fn) {
  const fx = makeFixture();
  try { return fn(fx); } finally { fx.cleanup(); }
}

// ---- validation -------------------------------------------------------------------------

test('scenario is a known trigger kind and the evaluator is registered', () => {
  assert.ok(TRIGGER_KINDS.includes('scenario'));
  assert.equal(typeof EVALUATORS.scenario, 'function');
  for (const k of ['changelog', 'metric', 'exercise', 'signal', 'date']) assert.ok(TRIGGER_KINDS.includes(k), k);
});

test('a scenario trigger validates against the config scenario ids', () => {
  assert.equal(valid(register()).ok, true);
  assert.equal(valid(register([scenarioTrigger({ on: undefined, comparison: undefined, minDays: undefined })])).ok, true, 'defaults need no fields');
  for (const bad of [
    scenarioTrigger({ scenario: undefined }),
    scenarioTrigger({ scenario: 'no.such.scenario' }),
    scenarioTrigger({ on: 'worse' }),
    scenarioTrigger({ comparison: 'trailing-30' }),
    scenarioTrigger({ comparison: 5 }),
    scenarioTrigger({ minDays: 0 }),
    scenarioTrigger({ premise: 'p9' }),
  ]) {
    assert.equal(valid(register([bad])).ok, false, JSON.stringify(bad));
  }
  const errs = valid(register([scenarioTrigger({ scenario: 'no.such.scenario' })])).errors.join('\n');
  assert.match(errs, /not in the usage-analysis config/);
});

test('without a provided id list, ids come from the live usage-analysis config (shipped defaults)', () => withFixture(() => {
  assert.equal(validateRegister(register(), { rollout: {} }).ok, true);
  const v = validateRegister(register([scenarioTrigger({ scenario: 'nope.nothing' })]), { rollout: {} });
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /nope\.nothing/);
  // a scenario that does not compare the named way could never fire
  const w = validateRegister(register([scenarioTrigger({ scenario: 'week.pace', comparison: 'trailing-7' })]), { rollout: {} });
  assert.equal(w.ok, false);
  assert.match(w.errors.join('\n'), /could never fire/);
  const x = validateRegister(register([scenarioTrigger({ comparison: 'window:ghost' })]), { rollout: {} });
  assert.equal(x.ok, false);
}));

test('the shipped example register still validates and carries a scenario trigger', () => withFixture(() => {
  const reg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'decision-register.example.json'), 'utf8'));
  const v = validateRegister(reg, { rollout: {} });
  assert.deepEqual(v.errors, []);
  const kinds = new Set(reg.decisions.flatMap((d) => d.triggers.map((t) => t.kind)));
  assert.ok(kinds.has('scenario'));
  for (const k of ['changelog', 'signal', 'metric']) assert.ok(kinds.has(k), k);
}));

// ---- streaks and minDays -----------------------------------------------------------------

test('a hit on minDays qualifying days in a row flags once; one hit day does not', () => withFixture((fx) => {
  const reg = register();
  const state = emptyState();
  writeResult(fx, '2026-10-10', entry('regression'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-10']).newFlags, []);
  assert.equal(state.triggers['dec-one/lead-cost'].streak, 1);
  writeResult(fx, '2026-10-11', entry('regression'));
  const r = evalOn(reg, state, ['2026-10-10', '2026-10-11']);
  assert.deepEqual(r.newFlags, ['dec-one/lead-cost@2026-10-10']);
  const flag = state.flags[r.newFlags[0]];
  assert.equal(flag.kind, 'scenario');
  assert.equal(flag.severity, 'metric');
  assert.match(flag.summary, /scenario lead\.unitsPerPrompt regression vs trailing-7 over 2 days/);
  assert.equal(flag.detail.days, 2);
  assert.equal(openFlags(state, reg, NOW).length, 1);
}));

test('minDays 3 waits for the third day; a qualifying non-hit day resets the streak and closes the flag', () => withFixture((fx) => {
  const reg = register([scenarioTrigger({ minDays: 3 })]);
  const state = emptyState();
  writeResult(fx, '2026-10-08', entry('regression'));
  writeResult(fx, '2026-10-09', entry('regression'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-08', '2026-10-09']).newFlags, []);
  writeResult(fx, '2026-10-10', entry('regression'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-08', '2026-10-09', '2026-10-10']).newFlags, ['dec-one/lead-cost@2026-10-08']);
  writeResult(fx, '2026-10-11', entry('ok'));
  evalOn(reg, state, ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(state.triggers['dec-one/lead-cost'].streak, 0);
  assert.equal(state.flags['dec-one/lead-cost@2026-10-08'].closed, '2026-10-13');
  assert.equal(openFlags(state, reg, NOW).length, 0);
}));

test('a gap day (no result) neither adds to nor resets a streak', () => withFixture((fx) => {
  const reg = register();
  const state = emptyState();
  writeResult(fx, '2026-10-08', entry('regression'));
  // 2026-10-09 has no result
  writeResult(fx, '2026-10-10', entry('regression'));
  const r = evalOn(reg, state, ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.equal(state.triggers['dec-one/lead-cost'].streak, 2);
  assert.deepEqual(r.newFlags, ['dec-one/lead-cost@2026-10-08']);
}));

test('on: improvement and any, and unconfirmed is a qualifying non-hit', () => withFixture((fx) => {
  writeResult(fx, '2026-10-10', entry('improvement'));
  writeResult(fx, '2026-10-11', entry('regression'));
  const days = ['2026-10-10', '2026-10-11'];
  const imp = emptyState();
  evalOn(register([scenarioTrigger({ on: 'improvement' })]), imp, days);
  assert.equal(imp.triggers['dec-one/lead-cost'].streak, 0, 'a regression is not an improvement hit');
  const any = emptyState();
  assert.deepEqual(evalOn(register([scenarioTrigger({ on: 'any' })]), any, days).newFlags, ['dec-one/lead-cost@2026-10-10']);
  writeResult(fx, '2026-10-12', entry('unconfirmed'));
  const reg = register();
  const s = emptyState();
  evalOn(reg, s, ['2026-10-11', '2026-10-12']);
  assert.equal(s.triggers['dec-one/lead-cost'].streak, 0);
}));

test('a window comparison matches by window id, and group comparisons count', () => withFixture((fx) => {
  const reg = register([scenarioTrigger({ comparison: 'window:leads-high', minDays: 1 })]);
  const grouped = { id: 'lead.unitsPerPrompt', status: 'regression', comparisons: [], groups: [{ key: 'a', comparisons: [cmp('regression', 'leads-high vs pre-window')] }] };
  writeResult(fx, '2026-10-11', { ...grouped });
  const state = emptyState();
  assert.deepEqual(evalOn(reg, state, ['2026-10-11']).newFlags, ['dec-one/lead-cost@2026-10-11']);
  // the same result under a trailing-7 trigger is not a usable comparison
  const other = emptyState();
  evalOn(register([scenarioTrigger({ minDays: 1 })]), other, ['2026-10-11']);
  assert.equal(other.triggers['dec-one/lead-cost'].streak, 0);
  assert.match(other.triggers['dec-one/lead-cost'].scenarioStatus, /^insufficient/);
}));

// ---- insufficient, not a fire --------------------------------------------------------------

test('no results at all: insufficient, no flag, no streak', () => withFixture(() => {
  const state = emptyState();
  const r = evalOn(register(), state, ['2026-10-10', '2026-10-11']);
  assert.deepEqual(r.newFlags, []);
  const rec = state.triggers['dec-one/lead-cost'];
  assert.equal(rec.streak, 0);
  assert.match(rec.scenarioStatus, /^insufficient: no result for the day/);
  const v = evalScenario({ trigger: scenarioTrigger(), key: 'dec-one/lead-cost', history: hist('2026-10-10'), nowT: NOW, state, decision: register().decisions[0] });
  assert.equal(v.ready, false);
  assert.deepEqual(v.days, [{ day: '2026-10-10', qualifies: false, hit: false }]);
}));

test('a day the runner deferred is a gap even when an older result file sits there', () => withFixture((fx) => {
  const state = emptyState();
  writeResult(fx, '2026-10-10', entry('regression'));
  writeResult(fx, '2026-10-11', entry('regression'));
  writeStatus(fx, { '2026-10-10': { state: 'deferred', kind: 'open-spawns', reason: 'still open' }, '2026-10-11': { state: 'deferred', kind: 'settling', reason: 'closed under 5 minutes ago' } });
  const r = evalOn(register(), state, ['2026-10-10', '2026-10-11']);
  assert.deepEqual(r.newFlags, []);
  assert.match(state.triggers['dec-one/lead-cost'].scenarioStatus, /deferred/);
}));

test('a skipped scenario, a missing scenario and an unusable comparison are insufficient', () => withFixture((fx) => {
  const reg = register([scenarioTrigger({ minDays: 1 })]);
  for (const [label, e] of [
    ['skipped', { id: 'lead.unitsPerPrompt', skipped: 'gap', why: 'metric is not implemented' }],
    ['missing', { id: 'spawn.unitsPerSpawn', status: 'regression', comparisons: [cmp('regression')] }],
    ['insufficient', entry('insufficient')],
    ['low-sample', entry('low-sample')],
    ['gap', entry('gap')],
  ]) {
    writeResult(fx, '2026-10-11', e);
    const state = emptyState();
    assert.deepEqual(evalOn(reg, state, ['2026-10-11']).newFlags, [], label);
    assert.match(state.triggers['dec-one/lead-cost'].scenarioStatus, /^insufficient/, label);
    assert.equal(state.triggers['dec-one/lead-cost'].streak, 0, label);
  }
}));

test('days before the decision date are not evidence', () => withFixture((fx) => {
  writeResult(fx, '2026-09-20', entry('regression'));
  writeResult(fx, '2026-09-21', entry('regression'));
  const state = emptyState();
  assert.deepEqual(evalOn(register(), state, ['2026-09-20', '2026-09-21']).newFlags, []);
}));

// ---- seen-key stability ----------------------------------------------------------------------

test('the seen key stays stable: re-evaluation, a longer streak and a state round trip never re-flag', () => withFixture((fx) => {
  const reg = register();
  const stateFile = join(fx.stateDir, 'state', 'decision-register-state.json');
  let state = emptyState();
  writeResult(fx, '2026-10-09', entry('regression'));
  writeResult(fx, '2026-10-10', entry('regression'));
  const first = evalOn(reg, state, ['2026-10-09', '2026-10-10']);
  assert.deepEqual(first.newFlags, ['dec-one/lead-cost@2026-10-09']);
  assert.deepEqual(evalOn(reg, state, ['2026-10-09', '2026-10-10']).newFlags, [], 'same inputs');
  assert.ok(writeState(state, stateFile));
  state = readState(stateFile);
  writeResult(fx, '2026-10-11', entry('regression'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-09', '2026-10-10', '2026-10-11']).newFlags, [], 'streak grows to 3, same episode');
  assert.equal(state.triggers['dec-one/lead-cost'].streak, 3);
  assert.deepEqual(state.seen.filter((k) => k.startsWith('dec-one/lead-cost@')), ['dec-one/lead-cost@2026-10-09']);
  // a recomputed (revised) result for an old day changes nothing
  writeResult(fx, '2026-10-10', entry('ok'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-09', '2026-10-10', '2026-10-11']).newFlags, []);
  assert.equal(state.triggers['dec-one/lead-cost'].streak, 3);
  // a new episode after a reset gets a new key
  writeResult(fx, '2026-10-12', entry('ok'));
  writeResult(fx, '2026-10-13', entry('regression'));
  evalOn(reg, state, ['2026-10-11', '2026-10-12', '2026-10-13']);
  writeResult(fx, '2026-10-14', entry('regression'));
  assert.deepEqual(evalOn(reg, state, ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']).newFlags, ['dec-one/lead-cost@2026-10-13']);
}));

test('runRegister evaluates a scenario trigger end to end, skips when nothing is new, and wakes on a new result', () => withFixture((fx) => {
  const registerFile = join(fx.stateDir, 'config', 'decision-register.json');
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  writeFileSync(registerFile, JSON.stringify(register()));
  const stateFile = join(fx.stateDir, 'state', 'decision-register-state.json');
  const detailFile = join(fx.stateDir, 'state', 'decision-register-details.md');
  const historyFile = join(fx.stateDir, 'state', 'history.jsonl');
  mkdirSync(join(fx.stateDir, 'state'), { recursive: true });
  writeFileSync(historyFile, `${hist('2026-10-10', '2026-10-11').map((h) => JSON.stringify({ ...h, sessions: [] })).join('\n')}\n`);
  const spawnsFile = join(fx.stateDir, 'state', 'no-spawns.jsonl');
  const args = { nowT: NOW, historyFile, spawnsFile, registerFile, stateFile, detailFile };
  writeResult(fx, '2026-10-10', entry('regression'));
  const a = runRegister(args);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(a.newFlags, []);
  assert.deepEqual(runRegister(args), { ok: true, skipped: 'nothing new' });
  writeResult(fx, '2026-10-11', entry('regression'));
  const b = runRegister(args);
  assert.deepEqual(b.newFlags, ['dec-one/lead-cost@2026-10-10']);
  assert.ok(b.detail);
  assert.match(readFileSync(detailFile, 'utf8'), /Scenario lead\.unitsPerPrompt: regression against trailing-7/);
  assert.deepEqual(runRegister(args), { ok: true, skipped: 'nothing new' });
}));

// ---- the other kinds are untouched -----------------------------------------------------------

test('the phase-1 signal path for a regressed scenario still matches', () => {
  const sigTrigger = { id: 'usage-reg', premise: 'p1', kind: 'signal', signalKinds: ['usage_regression'], pattern: 'lead\\.unitsPerPrompt' };
  const reg = register([sigTrigger]);
  assert.equal(valid(reg).ok, true);
  const state = emptyState();
  const fresh = scanSignals([
    { kind: 'usage_regression', detail: 'lead.unitsPerPrompt up 31% against trailing-7' },
    { kind: 'usage_regression', detail: 'spawn.unitsPerSpawn up 40% against trailing-7' },
  ], reg, state, { nowT: NOW });
  assert.equal(fresh.length, 1);
  assert.equal(state.flags[fresh[0]].kind, 'signal');
  // a register holding both phases validates and evaluates both without interference
  const both = register([sigTrigger, scenarioTrigger()]);
  assert.equal(valid(both).ok, true);
  const s2 = emptyState();
  assert.equal(scanSignals([{ kind: 'usage_regression', detail: 'lead.unitsPerPrompt up 31%' }], both, s2, { nowT: NOW }).length, 1);
});

test('other trigger kinds fold exactly as before alongside a scenario trigger', () => withFixture(() => {
  const date = { id: 'review-date', premise: 'p1', kind: 'date', due: '2026-10-12' };
  const reg = register([date, scenarioTrigger()]);
  const state = emptyState();
  const r = evaluateTriggers({ register: reg, nowT: NOW, state });
  assert.deepEqual(r.newFlags, ['dec-one/review-date@2026-10-12']);
}));
