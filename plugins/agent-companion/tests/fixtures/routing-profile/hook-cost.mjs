// Measures, in a FRESH process (as every hook invocation is), the spawn
// guard's routing hot path for ONE plugin tree: importing its
// hooks/lib/context.mjs (with whatever that imports), then the calls the
// guard makes per Agent spawn — the shipped table, the settings read, the
// TYPE lookup and resolveRoute(). Prints one JSON line. Used by
// tests/routing-profile-timing.test.mjs, which runs it against a staged copy
// of the CURRENT tree and a staged copy of the vendored pre-slice-2 baseline
// (fixtures/routing-profile/baseline/context.mjs), so the whole added cost is
// what gets measured, module loading included (S2 review P9).
// Then, separately timed (guardMs, 0.29.0 final review F5), the guard's
// other routing-path modules where the tree has them: the brief-directive
// parser it reads TYPE with, and the premium window with the lock helper it
// loads. The pre-slice-2 baseline has none, so guardMs is their whole cost.
// argv: <pluginRoot> <type>
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const [root, type = 'bounded-feature'] = process.argv.slice(2);
const lib = (m) => join(root, 'hooks', 'lib', m);
const t0 = performance.now();
const ctx = await import(pathToFileURL(lib('context.mjs')).href);
const t1 = performance.now();
ctx.modelTiers();
ctx.opt('fit_guard', true);
const known = typeof ctx.taskTypeDef === 'function' ? !!ctx.taskTypeDef(type) : !!ctx.modelTiers().taskTypes[type];
const r = ctx.resolveRoute({ type });
const t2 = performance.now();
const hasGuardModules = existsSync(lib('brief-directives.mjs')) && existsSync(lib('premium-window.mjs'));
const t3 = performance.now();
if (hasGuardModules) {
  const bd = await import(pathToFileURL(lib('brief-directives.mjs')).href);
  const pw = await import(pathToFileURL(lib('premium-window.mjs')).href);
  bd.declarationValue(bd.briefDeclarations(`TYPE: ${type}\ngo`), 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
  pw.premiumWindowLive([]);
}
const t4 = performance.now();
process.stdout.write(JSON.stringify({
  importMs: t1 - t0, resolveMs: t2 - t1, totalMs: t2 - t0, layer: r.layer ?? null, known,
  guardModules: hasGuardModules, guardMs: t4 - t3,
}) + '\n');
