#!/usr/bin/env node
// An agent's own plan spend so far, as a percent of the weekly plan limit and of its `BUDGET: N%` allowance.
//
//   node allowance.mjs <agent_id>        (the command in the allowance note at the agent's start)
//
// Counts the agent's OWN transcript (input, cache write, cache read and output, weighted by model, config/plan-weights.json)
// plus the transcripts of the agents it spawned. Other agents running in parallel are never read. Prints figures only:
// no paths, no keys. An advisory estimate; nothing here warns, stops or blocks anyone. Logic: hooks/lib/plan-allowance.mjs.

import { claudeDir } from '../hooks/lib/context.mjs';
import { agentSpend, unitsPerPercent, planWeights, modelWeight } from '../hooks/lib/plan-allowance.mjs';

const agentId = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!agentId) {
  console.log('Usage: node allowance.mjs <agent_id> (the command in your allowance note has it).');
  process.exit(2);
}
if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
  console.log('Not an agent id.');
  process.exit(2);
}

const r = agentSpend(agentId, claudeDir());
if (!r.ok) {
  console.log(`Allowance check unavailable: ${r.reason}.`);
  process.exit(1);
}

const f = (n) => (n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
const per = unitsPerPercent();
const head = r.allowancePct
  ? `Spent ${f(r.totalPct)}% of the weekly limit (${f(r.totalUnits)} units) = ${f(r.usedOfAllowance * 100)}% of your ${r.allowancePct}% allowance.`
  : `Spent ${f(r.totalPct)}% of the weekly limit (${f(r.totalUnits)} units). No % allowance in your brief.`;
const own = `Own: ${r.ownCalls} calls, ${f(r.ownPct)}%.`;
const sub = r.subAgents ? ` Subagents (${r.subAgents}): ${r.subCalls} calls, ${f(r.subPct)}%.` : '';
const basis = r.models.map((a) => {
  const m = modelWeight(a);
  return `${a} ${m.weight} (${m.status})`;
}).join(', ');
console.log(head);
console.log(`${own}${sub}`);
console.log(`Basis: ${per} units = 1%, weights ${basis}; cache reads at API price. An estimate (${planWeights().updated || 'undated'} fit).`);
if (r.unknownCalls) console.log(`${r.unknownCalls} calls on an unrecognised model were counted at the Sonnet weight.`);
