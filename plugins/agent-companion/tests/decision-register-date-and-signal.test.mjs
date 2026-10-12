// 0.31.16 merge check: one register carrying both a `date` and a `signal` trigger passes
// --check and evaluates both kinds. Synthetic register, fixture state root.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import {
  TRIGGER_KINDS, registerPath, validateRegister, emptyState, evaluateTriggers, scanSignals, openFlags,
} from '../scripts/lib/decision-register.mjs';

const T = (s) => Date.parse(s);

function register() {
  return {
    schema: 'agent-companion/decision-register', version: 1,
    decisions: [{
      id: 'both', title: 'Both kinds', status: 'active', decided: '2026-10-12', decision: 'What is standing.', reverse: 'Undo it.',
      premises: [{ id: 'p1', text: 'The claim.', label: 'E' }],
      triggers: [
        { id: 'review-date', premise: 'p1', kind: 'date', due: '2026-10-19' },
        { id: 'model-move', premise: 'p1', kind: 'signal', signalKinds: ['pinned_model_id'] },
      ],
    }],
  };
}

test('both new trigger kinds are known', () => {
  assert.ok(TRIGGER_KINDS.includes('date'));
  assert.ok(TRIGGER_KINDS.includes('signal'));
});

test('a register with a date and a signal trigger validates and evaluates both', () => {
  const reg = register();
  assert.equal(validateRegister(reg, { rollout: {} }).ok, true);
  const state = emptyState();
  const sig = scanSignals([{ kind: 'pinned_model_id', detail: 'pinned claude-sonnet-5 in settings.json', dispatch: 'manual-check' }], reg, state, { nowT: T('2026-10-15T10:00:00Z') });
  assert.equal(sig.length, 1);
  assert.equal(state.flags[sig[0]].kind, 'signal');
  assert.deepEqual(evaluateTriggers({ register: reg, nowT: T('2026-10-18T23:00:00Z'), state }).newFlags, []);
  const due = evaluateTriggers({ register: reg, nowT: T('2026-10-19T01:00:00Z'), state });
  assert.deepEqual(due.newFlags, ['both/review-date@2026-10-19']);
  const kinds = openFlags(state, reg, T('2026-10-19T02:00:00Z')).map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['date', 'signal']);
});

test('decision-register.mjs --check passes on a register with both kinds', () => {
  const fx = makeFixture();
  try {
    mkdirSync(dirname(registerPath()), { recursive: true });
    writeFileSync(registerPath(), JSON.stringify(register()));
    const r = runScript('scripts/decision-register.mjs', ['--check'], { cwd: fx.dir });
    assert.match(r.stdout, /^OK:/);
  } finally { fx.cleanup(); }
});
