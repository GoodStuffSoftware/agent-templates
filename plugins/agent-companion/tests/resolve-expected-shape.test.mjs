// resolveExpected() keeps its pre-ADR-0003 shape EXACTLY: the same seven
// keys on every answer (S2 review P11). A harness diff between the
// pre-slice-2 baseline and slice 2 showed `"weight": null` appearing; it is
// not a new key. The pre-slice-2 baseline
// looked a type up with a plain property read, so a name inherited from
// Object.prototype ("constructor", "__proto__", "toString", ...) counted as
// a known type with no preset: its weight came back undefined (dropped by
// JSON.stringify) and the declared weight was ignored. Since slice 2 such a
// name is an unknown type, like any other, so the declared weight is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const ctx = await import('../hooks/lib/context.mjs');
const cfg = ctx.modelTiers();

const KEYS = ['model', 'effort', 'rationale', 'weight', 'kind', 'consequence', 'trial'];
const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
const types = [undefined, null, '', ...Object.keys(cfg.taskTypes), 'frobnicate', ...PROTO_NAMES];
const weights = [undefined, null, 0, 1, 3, 5, 6, 2.5, '3', 'parity'];
const kinds = [undefined, 'diagnostic', 'bogus'];
const conss = [undefined, 'routine', 'elevated', 'critical', 'inherit'];
function* cases() {
  for (const type of types) for (const weight of weights) for (const kind of kinds) for (const consequence of conss)
    for (let f = 0; f < 8; f++) yield { type, weight, kind, consequence, weightExplicit: !!(f & 1), kindExplicit: !!(f & 2), consequenceExplicit: !!(f & 4) };
}

test('every resolveExpected() answer has exactly the seven pre-slice keys, in order', () => {
  const bad = [];
  for (const args of cases()) {
    const keys = Object.keys(ctx.resolveExpected(args));
    if (JSON.stringify(keys) !== JSON.stringify(KEYS)) bad.push(`${JSON.stringify(args)} -> ${keys.join(',')}`);
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test('a type named after an Object.prototype member resolves exactly like an unknown type', () => {
  const bad = [];
  for (const args of cases()) {
    if (!PROTO_NAMES.includes(args.type)) continue;
    const got = JSON.stringify(ctx.resolveExpected(args));
    const want = JSON.stringify(ctx.resolveExpected({ ...args, type: 'frobnicate' }));
    if (got !== want) bad.push(`${args.type}: ${got} vs ${want}`);
  }
  assert.deepEqual(bad.slice(0, 3), []);
  // Concretely: the declared weight is used, not dropped.
  const r = ctx.resolveExpected({ type: 'constructor', weight: 3 });
  assert.equal(r.weight, 3);
  assert.equal(r.model, ctx.resolveExpected({ weight: 3, weightExplicit: true }).model);
});
