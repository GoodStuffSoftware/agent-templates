#!/usr/bin/env node
// Recommend a model and effort for a task, from the routing table.
//
// The routing table exists so this decision is made once, as data, rather than
// re-derived by taste at every spawn. This is the front door to it: name the
// task type, or give weight/kind/consequence directly, and get back the model,
// the effort, whether a premium warrant is required, and the reviewer that
// should gate it.
//
// Usage:
//   node recommend.mjs --list
//   node recommend.mjs --type debug-root-cause
//   node recommend.mjs --type bounded-feature --consequence critical
//   node recommend.mjs --weight 4 --kind diagnostic
//   node recommend.mjs --type code-review --writer opus/xhigh
//   add --json for machine-readable output

import { modelTiers, effortFor, classifyModel, classifyEffort, rungFor } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();
const types = cfg.taskTypes || {};

if (has('--list')) {
  console.log('Task types (from config/model-tiers.json):\n');
  for (const [name, t] of Object.entries(types)) {
    console.log(`  ${name.padEnd(22)} w=${String(t.weight).padEnd(7)} ${t.kind.padEnd(13)} ${t.consequence.padEnd(9)} ${t.summary || ''}`);
  }
  console.log('\nKinds: ' + Object.keys(cfg.taskKinds || {}).join(', '));
  console.log('Consequence: ' + Object.keys(cfg.consequence || {}).join(', '));
  process.exit(0);
}

const typeName = val('--type');
const t = typeName ? types[typeName] : null;
if (typeName && !t) {
  console.error(`unknown task type "${typeName}" — see --list`);
  process.exit(2);
}

// Explicit flags override the preset; the preset fills what is not given.
const weightExplicit = val('--weight') !== undefined;
const kindExplicit = val('--kind') !== undefined;
const consequenceExplicit = val('--consequence') !== undefined;
let weight = weightExplicit ? Number(val('--weight')) : t?.weight;
let kind = val('--kind') || t?.kind || 'bounded';
let consequence = val('--consequence') || t?.consequence || 'routine';
if (consequence === 'inherit') consequence = 'routine';

const out = { taskType: typeName || null, weight, kind, consequence };

// Reviewer parity: a review is sized to the writer it gates.
if (weight === 'parity') {
  const w = val('--writer');
  if (!w) {
    console.error(`"${typeName}" is sized by parity — pass --writer <model>/<effort> for the change being reviewed`);
    process.exit(2);
  }
  const [wm, we] = String(w).split('/');
  const p = cfg.reviewerParity || {};
  out.model = wm;
  out.effort = we || '';
  out.rationale = `reviewer parity: model matches the writer (${wm})` + (we ? `; effort at least ${we}` : '') + (p.effortMayExceed ? ', may exceed' : '');
} else {
  if (typeof weight !== 'number' || !(weight >= 1 && weight <= 5)) {
    console.error('need --type <task-type> or --weight 1-5 (see --list)');
    process.exit(2);
  }
  // A ROUTING TRIAL override on the named type: a benchmark-backed (model,
  // effort) pair that supersedes this type's own weight/kind/consequence grid
  // resolution — see taskTypesNote in config/model-tiers.json. It applies only
  // when the type is resolved as-is; an explicit --weight/--kind/--consequence
  // is a deliberate deviation from the preset and falls back to the plain grid.
  const asIs = !weightExplicit && !kindExplicit && !consequenceExplicit;
  const ov = t?.override;
  if (ov && asIs) {
    const natural = effortFor(weight, kind, consequence);
    const naturalLabel = `${natural.model}${natural.effort ? '/' + natural.effort : ''}`;
    out.model = ov.model;
    out.effort = ov.effort || '';
    out.rationale = `ROUTING TRIAL (since ${ov.trialSince}, review by ${ov.reviewBy}): ${ov.reason} Grid would otherwise resolve to ${naturalLabel}.`;
    out.trial = {
      trialSince: ov.trialSince,
      reviewBy: ov.reviewBy,
      evidence: ov.evidence || null,
      overridesKindDelta: !!ov.overridesKindDelta,
      gridResolution: naturalLabel,
    };
  } else {
    const r = effortFor(weight, kind, consequence);
    out.model = r.model;
    out.effort = r.effort;
    out.rationale = r.rationale;
  }
}

// Ladder rung: the ordered cheapest-to-dearest view of the same (model,
// effort) pair, mapped to a spawnable generic worker definition — because the
// Agent tool has no per-spawn effort parameter, effort is locked to whichever
// definition's frontmatter is used. null when the result is fable (outside
// the ladder by design) or otherwise unmapped.
const rung = out.model !== 'fable' ? rungFor(out.model, out.effort) : null;
if (rung) {
  out.rung = rung.rung;
  out.spawnAgent = rung.agent;
  out.spawnAgentNamespaced = `agent-companion:${rung.agent}`;
}

const cls = classifyModel(out.model);
out.premium = cls.premium;
out.warrantRequired = cls.premium;
out.reviewer = {
  model: out.model,
  effort: out.effort ? `>= ${out.effort}` : '(none)',
  note: 'reviewer parity: same model as the writer; effort may exceed, must not drop',
};

// The single most useful nudge on a premium result: per the procedural-
// discipline finding, a brief that carries the verification checklist often
// closes the gap on the cheaper tier. Ask that before writing a warrant.
if (cls.premium && cls.alias === 'fable') {
  out.tryFirst = 'Before warranting fable: does an opus brief that states a hypothesis before editing and labels claims VERIFIED / REASONED / ASSUMED do the job? Fable prefers whole-file rewrites and over-infers — poor fit for scoped work even when warranted.';
}
if (cls.premium) {
  out.warrantTemplate = `WARRANT: weight ${typeof weight === 'number' ? weight : '<1-5>'} — <why a cheaper tier cannot do this>`;
}

if (has('--json')) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const eff = out.effort ? `/${out.effort}` : ' (no effort — this model takes none)';
console.log(`recommendation: ${out.model}${eff}`);
if (out.taskType) console.log(`task type:      ${out.taskType}`);
console.log(`inputs:         weight=${out.weight} kind=${out.kind} consequence=${out.consequence}`);
console.log(`why:            ${out.rationale}`);
if (out.spawnAgentNamespaced) {
  console.log(`spawn as:       subagent_type: "${out.spawnAgentNamespaced}"  (ladder rung ${out.rung}/10)`);
} else if (out.model !== 'fable') {
  console.log(`spawn as:       no ladder rung mapped for ${out.model}${out.effort ? '/' + out.effort : ''} — spawn with model="${out.model}"${out.effort ? ` and an agent definition carrying effort: ${out.effort}` : ''}`);
}
console.log(`reviewer:       ${out.reviewer.model} at effort ${out.reviewer.effort}`);
if (out.trial) {
  console.log(`\nROUTING TRIAL — this type's output is a benchmark override, not the plain grid:`);
  console.log(`  trial window:  ${out.trial.trialSince} -> review by ${out.trial.reviewBy}`);
  console.log(`  grid would say: ${out.trial.gridResolution}`);
  if (out.trial.overridesKindDelta) console.log(`  explicitly overrides the kind's effort delta (see rationale above)`);
  if (out.trial.evidence?.source) console.log(`  evidence:      ${out.trial.evidence.source} (${out.trial.evidence.date || 'undated'})`);
}
if (out.warrantRequired) {
  console.log(`\nPREMIUM TIER — a warrant is required on the spawn brief:`);
  console.log(`  ${out.warrantTemplate}`);
}
if (out.tryFirst) console.log(`\ntry first:      ${out.tryFirst}`);
