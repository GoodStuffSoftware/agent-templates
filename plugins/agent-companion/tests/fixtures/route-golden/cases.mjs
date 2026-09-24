// The case matrix for the resolveRoute() golden test (ADR 0003 slice 1).
//
// Shared by generate.mjs, which evaluates it against a PINNED older copy of
// the resolver, and tests/route-golden.test.mjs, which evaluates it against
// the current one. Kept free of any import from hooks/lib/context.mjs so the
// generator can run it against a different copy of that file.
//
// What is covered, for every shipped task type plus "no type" and an unknown
// type name:
//   - weight: not given; explicit 1-5 (both the preset value and every
//     departure); an explicit out-of-range 0
//   - kind: not given; explicit for each shipped kind; an unknown kind
//   - consequence: not given; explicit routine/elevated/critical/inherit; an
//     unknown value
//   crossed in full, plus
//   - a weight given WITHOUT the explicit flag (the spawn guard's
//     "WARRANT: weight N" shape), and a kind or consequence given without
//     the explicit flag, each on its own.
// Each case is evaluated at every clock in CLOCKS: one before and one after
// the haiku tier's retirement date, so the staged-replacement path is pinned
// too and the table does not go stale on the day the tier retires.

export const CLOCKS = ['2026-09-24T12:00:00.000Z', '2026-10-20T12:00:00.000Z'];

const NONE = '-';

// `extraWeights` adds explicit weights to the cross (the live gate adds a
// fractional one); the frozen record in expected.json was built without it.
export function buildCases({ typeNames, kinds, consequences, extraWeights = [] }) {
  const types = [null, ...typeNames, 'no-such-type'];
  const weightOpts = [
    { id: NONE },
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `E${n}`, weight: n, weightExplicit: true })),
    { id: 'E0', weight: 0, weightExplicit: true },
    ...extraWeights.map((n) => ({ id: `E${n}`, weight: n, weightExplicit: true })),
  ];
  const kindOpts = [
    { id: NONE },
    ...[...kinds, 'no-such-kind'].map((k) => ({ id: `E:${k}`, kind: k, kindExplicit: true })),
  ];
  const consOpts = [
    { id: NONE },
    ...[...consequences, 'inherit', 'no-such-consequence'].map((c) => ({ id: `E:${c}`, consequence: c, consequenceExplicit: true })),
  ];

  const cases = [];
  const push = (type, w, k, c) => {
    const key = `${type ?? '(none)'}|w=${w.id}|k=${k.id}|c=${c.id}`;
    const { id: _w, ...wa } = w;
    const { id: _k, ...ka } = k;
    const { id: _c, ...ca } = c;
    cases.push({ key, args: { type, ...wa, ...ka, ...ca } });
  };
  for (const type of types) {
    for (const w of weightOpts) for (const k of kindOpts) for (const c of consOpts) push(type, w, k, c);
    // Given, but NOT flagged explicit — each on its own.
    for (const n of [1, 2, 3, 4, 5]) push(type, { id: `I${n}`, weight: n }, kindOpts[0], consOpts[0]);
    for (const kk of kinds) push(type, weightOpts[0], { id: `I:${kk}`, kind: kk }, consOpts[0]);
    for (const cc of [...consequences, 'inherit']) push(type, weightOpts[0], kindOpts[0], { id: `I:${cc}`, consequence: cc });
  }
  return cases;
}
