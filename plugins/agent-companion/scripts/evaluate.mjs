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

import { modelTiers, evaluateFit } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();
const types = cfg.taskTypes || {};

const model = val('--model');
if (!model) {
  console.error('need --model <alias-or-id>: the model actually running, or named on the spawn');
  process.exit(3);
}
const effort = (val('--effort') || '').toLowerCase();

const typeName = val('--type');
const t = typeName ? types[typeName] : null;
if (typeName && !t) {
  console.error(`unknown task type "${typeName}" — see recommend.mjs --list`);
  process.exit(3);
}
const weight = val('--weight') !== undefined ? Number(val('--weight')) : t?.weight;
const kind = val('--kind') || t?.kind || 'bounded';
let consequence = val('--consequence') || t?.consequence || 'routine';
if (consequence === 'inherit') consequence = 'routine';

let fit;
if (weight === 'parity') {
  const w = val('--writer');
  if (!w) {
    console.error(`"${typeName}" is sized by parity — pass --writer <model>/<effort> for the change being reviewed`);
    process.exit(3);
  }
  const [wm, we] = String(w).split('/');
  const expected = {
    model: wm,
    effort: we || '',
    rationale: `reviewer parity: match the writer (${wm}${we ? '/' + we : ''}); effort may exceed, must not drop`,
  };
  fit = evaluateFit({ model, effort, weight, kind, consequence, expected, parity: true });
} else {
  if (typeof weight !== 'number' || !(weight >= 1 && weight <= 5)) {
    console.error('need --type <task-type> or --weight 1-5 (see recommend.mjs --list)');
    process.exit(3);
  }
  fit = evaluateFit({ model, effort, weight, kind, consequence });
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
