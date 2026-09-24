#!/usr/bin/env node
// Evaluate whether an agent — the one running, or one about to be spawned —
// is provisioned correctly for its task.
//
// recommend answers "what should this task run on?" BEFORE the spawn.
// evaluate answers "is what is running (or being spawned) right for it?"
// The same routing table, read in the other direction. The comparison itself
// lives in hooks/lib/context.mjs (evaluateFit) so the spawn guard applies the
// identical rule to every brief that declares a weight.
//
// Usage:
//   node evaluate.mjs --model sonnet --effort high --type debug-root-cause
//   node evaluate.mjs --model fable --weight 2 --kind mechanical
//   node evaluate.mjs --model opus --effort medium --type code-review --writer opus/xhigh
//   add --json for machine-readable output
// Exit code: 0 fit, 1 over-provisioned, 2 under-provisioned, 3 usage error

import { evaluateFit, resolveRoute, expectedFromRoute, taskTypeDef } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const model = val('--model');
if (!model) {
  console.error('need --model <alias-or-id>: the model actually running, or named on the spawn');
  process.exit(3);
}
const effort = (val('--effort') || '').toLowerCase();

const typeName = val('--type');
// Shipped types first, then the routing profile's user-local types.
const t = typeName ? (taskTypeDef(typeName)?.def || null) : null;
if (typeName && !t) {
  console.error(`unknown task type "${typeName}" — see recommend.mjs --list`);
  process.exit(3);
}
const weightExplicit = val('--weight') !== undefined;
const kindExplicit = val('--kind') !== undefined;
const consequenceExplicit = val('--consequence') !== undefined;
const explicitWeight = weightExplicit ? Number(val('--weight')) : undefined;
const explicitKind = kindExplicit ? val('--kind') : undefined;
const explicitConsequence = consequenceExplicit ? val('--consequence') : undefined;

const weight = weightExplicit ? explicitWeight : t?.weight;
const kind = kindExplicit ? explicitKind : (t?.kind || 'bounded');
let consequence = consequenceExplicit ? explicitConsequence : (t?.consequence || 'routine');
if (consequence === 'inherit') consequence = 'routine';

let fit;
if (weight === 'parity') {
  const w = val('--writer');
  if (!w) {
    console.error(`"${typeName}" is sized by parity — pass --writer <model>/<effort> for the change being reviewed`);
    process.exit(3);
  }
  const [wm, we] = String(w).split('/');
  // Same resolver as every other route: reviewer parity is F3, raised to F1
  // on a critical change and capped by F2 (see resolveRoute()).
  const route = resolveRoute({
    type: typeName, weight: explicitWeight, kind: explicitKind, consequence: explicitConsequence,
    weightExplicit, kindExplicit, consequenceExplicit, writer: { model: wm, effort: we || '' },
  });
  if (!route.model) {
    // F4: an unknown (or unavailable, unreplaced) writer model is never
    // passed straight through as the reviewer's.
    console.error(`cannot size a reviewer for writer "${w}": ${route.rationale}`);
    process.exit(3);
  }
  // The resolver's own rationale: the writer, then every floor that moved it.
  const expected = {
    model: route.model,
    effort: route.effort,
    rationale: route.rationale,
  };
  fit = evaluateFit({ model, effort, weight, kind, consequence, expected, parity: true });
} else {
  if (typeof weight !== 'number' || !(weight >= 1 && weight <= 5)) {
    console.error('need --type <task-type> or --weight 1-5 (see recommend.mjs --list)');
    process.exit(3);
  }
  // resolveRoute() is the SHARED resolver (hooks/lib/context.mjs) — the
  // SAME function scripts/recommend.mjs and hooks/spawn-guard.mjs's fit
  // check go through, so the layer stack (profile > shipped ROUTING TRIAL >
  // grid, floors after the winner) is applied here too instead of silently
  // falling back to the plain grid the way a direct effortFor() call would.
  // Passed as `expected` (in its compatibility shape, so --json output is
  // unchanged) so evaluateFit() uses it as-is rather than recomputing its own
  // default internally.
  const expected = expectedFromRoute(resolveRoute({
    type: typeName, weight: explicitWeight, kind: explicitKind, consequence: explicitConsequence,
    weightExplicit, kindExplicit, consequenceExplicit,
  }));
  fit = evaluateFit({ model, effort, weight, kind, consequence, expected });
}

const out = { ...fit, inputs: { taskType: typeName || null, weight, kind, consequence } };

if (has('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const exp = fit.expected;
  console.log(`verdict:   ${fit.verdict.toUpperCase()} — ${fit.reason}`);
  console.log(`actual:    ${model}${effort ? '/' + effort : ''}`);
  console.log(`expected:  ${exp.model}${exp.effort ? '/' + exp.effort : ''}  (${exp.rationale})`);
  if (fit.effortNote) console.log(`effort:    ${fit.effortNote}`);
  console.log(`action:    ${fit.action}`);
}
process.exit({ fit: 0, over: 1, under: 2, unknown: 1 }[fit.verdict]);
