// Measures, in a FRESH process (as every hook invocation is), what routing
// profiles add to the spawn guard's hot path: loading hooks/lib/routing-
// profile.mjs, then the three resolver calls spawn-guard.mjs makes per Agent
// spawn (taskTypeNames, taskTypeDef, resolveRoute) with the profile read cold.
// Prints one JSON line. Used by tests/routing-profile-timing.test.mjs.
//
// The module's load cost is its MARGINAL cost: a second, separately-keyed
// instance of the same file (a query string makes the ESM loader load and
// compile it again) timed after the loader and the hooks/lib package-scope
// lookup are warm — both of which every hook pays with or without profiles.
import { performance } from 'node:perf_hooks';

const type = process.argv[2] || 'bounded-feature';
const ctx = await import('../../../hooks/lib/context.mjs');
const t0 = performance.now();
await import('../../../hooks/lib/routing-profile.mjs?marginal-load');
const t1 = performance.now();
ctx.modelTiers(); // the shipped table loads with or without a profile
ctx.opt('fit_guard', true); // so does the settings read
const t2 = performance.now();
const names = ctx.taskTypeNames();
const def = ctx.taskTypeDef(type);
const r = ctx.resolveRoute({ type });
const t3 = performance.now();
process.stdout.write(JSON.stringify({
  importMs: t1 - t0, resolveMs: t3 - t2, layer: r.layer, names: names.length, known: !!def,
}) + '\n');
