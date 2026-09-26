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
//   node recommend.mjs --type debug-root-cause --explain
//   add --json for machine-readable output
//
// --explain prints the full resolution stack from resolveRoute(): what each
// layer (profile > shipped trial > shipped grid) would give, which layer won
// and why, which floors fired, and the winner's provenance in one line. With
// --json it adds a `route` block carrying the same facts.

import {
  modelTiers, resolveRoute, classifyModel, classifyEffort, rungFor, explainRoute, taskTypeDef, taskTypeNames,
} from '../hooks/lib/context.mjs';
import { loadAdvisorSummary, windowHintFor } from './lib/cache-advisor.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();

if (has('--list')) {
  console.log('Task types (from config/model-tiers.json, then your routing profile\'s local types):\n');
  for (const name of taskTypeNames()) {
    const { def: t, origin } = taskTypeDef(name);
    console.log(`  ${name.padEnd(22)} w=${String(t.weight).padEnd(7)} ${t.kind.padEnd(13)} ${t.consequence.padEnd(9)} ${origin === 'local' ? '(local) ' : ''}${t.summary || ''}`);
  }
  console.log('\nKinds: ' + Object.keys(cfg.taskKinds || {}).join(', '));
  console.log('Consequence: ' + Object.keys(cfg.consequence || {}).join(', '));
  process.exit(0);
}

// Shipped types first, then the routing profile's user-local types.
const typeName = val('--type');
const t = typeName ? (taskTypeDef(typeName)?.def || null) : null;
if (typeName && !t) {
  console.error(`unknown task type "${typeName}" — see --list`);
  process.exit(2);
}

// Explicit flags override the preset; the preset fills what is not given.
const weightExplicit = val('--weight') !== undefined;
const kindExplicit = val('--kind') !== undefined;
const consequenceExplicit = val('--consequence') !== undefined;
const explicitWeight = weightExplicit ? Number(val('--weight')) : undefined;
const explicitKind = kindExplicit ? val('--kind') : undefined;
const explicitConsequence = consequenceExplicit ? val('--consequence') : undefined;
let weight = weightExplicit ? explicitWeight : t?.weight;
let kind = kindExplicit ? explicitKind : (t?.kind || 'bounded');
let consequence = consequenceExplicit ? explicitConsequence : (t?.consequence || 'routine');
if (consequence === 'inherit') consequence = 'routine';

const out = { taskType: typeName || null, weight, kind, consequence };
let route = null;

// Reviewer parity: a review is sized to the writer it gates.
if (weight === 'parity') {
  const w = val('--writer');
  if (!w) {
    console.error(`"${typeName}" is sized by parity — pass --writer <model>/<effort> for the change being reviewed`);
    process.exit(2);
  }
  const [wm, we] = String(w).split('/');
  // Same resolver as every other route: reviewer parity is F3, raised to F1
  // on a critical change and capped by F2 (see resolveRoute()).
  route = resolveRoute({
    type: typeName, weight: explicitWeight, kind: explicitKind, consequence: explicitConsequence,
    weightExplicit, kindExplicit, consequenceExplicit, writer: { model: wm, effort: we || '' },
  });
  if (!route.model) {
    // F4: an unknown (or unavailable, unreplaced) writer model is never
    // passed straight through as the reviewer's.
    console.error(`cannot size a reviewer for writer "${w}": ${route.rationale}`);
    process.exit(2);
  }
  out.model = route.model;
  out.effort = route.effort;
  // The resolver's own rationale: the writer, then every floor that moved it.
  out.rationale = route.rationale;
} else {
  if (typeof weight !== 'number' || !(weight >= 1 && weight <= 5)) {
    console.error('need --type <task-type> or --weight 1-5 (see --list)');
    process.exit(2);
  }
  // resolveRoute() is the SHARED resolver (hooks/lib/context.mjs): the layer
  // stack profile > shipped ROUTING TRIAL (taskTypesNote) > grid, with the
  // floors applied after whichever layer won. scripts/evaluate.mjs and
  // hooks/spawn-guard.mjs's fit check go through the identical function, so
  // a trial-conforming spawn is judged consistently wherever the table is
  // consulted. An explicit --weight/--kind/--consequence is a deliberate
  // deviation from the preset and skips straight to the grid.
  route = resolveRoute({
    type: typeName, weight: explicitWeight, kind: explicitKind, consequence: explicitConsequence,
    weightExplicit, kindExplicit, consequenceExplicit,
  });
  out.model = route.model;
  out.effort = route.effort;
  out.rationale = route.rationale;
  if (route.trial) out.trial = route.trial;
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
  note: 'reviewer parity: at least the writer\'s model and effort (effort may exceed, must not drop), raised to F1 on a critical change and capped by F2 (never fable)',
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

if (route?.cacheTtl) out.cacheTtl = route.cacheTtl; // advisory hint; only a profile row carries one

// Auto-compact window: quoted from the last cache-advisor run (its saved
// summary), never computed here — a transcript replay is far too slow for this
// command. Shown only when a summary exists. Advice: nothing is changed.
const autoCompact = windowHintFor(loadAdvisorSummary(), out.model);
if (autoCompact) out.autoCompact = autoCompact;
if (route?.layer === 'profile') out.routeLayer = 'profile';

const explain = has('--explain');
if (explain && route) {
  const { layer, profileRevision, source, state, provenance, floorsApplied, skipped, stale, departures, stack } = route;
  out.route = { layer, profileRevision, source, state, provenance, floorsApplied, skipped, stale, departures, stack };
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
if (route?.layer === 'profile') console.log(`route layer:    your routing profile (rev ${route.profileRevision}) — /ac routing why ${out.taskType} explains it`);
if (route?.cacheTtl) console.log(`cache TTL hint: ${route.cacheTtl} (advisory, from your routing profile; no guard enforces it)`);
if (out.autoCompact) {
  const a = out.autoCompact;
  const K = (x) => `${Math.round(x / 1000)}K`;
  const ageDays = (Date.now() - Date.parse(a.generatedAt)) / 86400000;
  const parts = [];
  if (a.window) parts.push(`${a.model} breaks even at ${K(a.window)}${a.band5 ? ` (within 5%: ${K(a.band5[0])}-${K(a.band5[1])})` : ''}`);
  if (a.global) parts.push(`one setting for your model mix: ${K(a.global)}`);
  parts.push(a.configured ? `yours: ${K(a.configured)}` : 'yours: unset');
  console.log(`auto-compact:   ${parts.join('; ')} — advice from cache-advisor${ageDays > 14 ? `, ${Math.floor(ageDays)} days old: run scripts/cache-advisor.mjs again` : ''}`);
}
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
if (explain && route) {
  console.log('\nEXPLAIN — how this was resolved:');
  for (const line of explainRoute(route)) console.log(`  ${line}`);
}
