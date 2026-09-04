#!/usr/bin/env node
// Render the routing table FROM the config, never by hand.
//
// A table that someone types is a table that goes stale the moment the config
// changes — which is the exact failure the config-as-data design exists to
// prevent. This reads config/model-tiers.json (plus any per-machine override)
// through the same loader the guards use, so what it prints is what enforces.
//
// Usage:
//   node routing-table.mjs               # markdown to stdout
//   node routing-table.mjs --json        # machine-readable
//   node routing-table.mjs --out FILE    # write markdown to FILE (e.g. docs/ROUTING.md)

import { writeFileSync } from 'node:fs';
import { modelTiers, effortFor } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();
const tiers = Object.entries(cfg.tiers || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const efforts = Object.entries(cfg.efforts || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const kinds = Object.keys(cfg.taskKinds || {});
const weights = Object.keys(cfg.routing || {}).sort();

const cell = (w, k) => {
  const r = effortFor(Number(w), k);
  return r.model + (r.effort ? `/${r.effort}` : '');
};

if (has('--json')) {
  const grid = {};
  for (const w of weights) { grid[w] = {}; for (const k of kinds) grid[w][k] = effortFor(Number(w), k); }
  console.log(JSON.stringify({ version: cfg.version, updated: cfg.updated, tiers: cfg.tiers, efforts: cfg.efforts, routing: cfg.routing, taskKinds: cfg.taskKinds, consequence: cfg.consequence, reviewerParity: cfg.reviewerParity, grid }, null, 2));
  process.exit(0);
}

const L = [];
L.push(`# Model routing table`);
L.push(``);
L.push(`_Generated from \`config/model-tiers.json\` v${cfg.version} (updated ${cfg.updated}) by \`scripts/routing-table.mjs\`. Do not edit by hand — change the config and regenerate._`);
L.push(``);

L.push(`## Tiers`);
L.push(``);
L.push(`| Alias | Rank | Premium | Available | Accepts effort | Role |`);
L.push(`|---|---|---|---|---|---|`);
for (const [alias, t] of tiers) {
  const eff = Array.isArray(t.efforts) ? (t.efforts.length ? t.efforts.join(', ') : '**none**') : '?';
  L.push(`| \`${alias}\` | ${t.rank} | ${t.premium ? 'yes' : 'no'} | ${t.available === false ? '**no**' : 'yes'} | ${eff} | ${t.note || ''} |`);
}
L.push(``);
if (cfg.unknownIsPremium !== false) L.push(`An unrecognised model is treated as **premium** and flagged — it fails toward the expensive assumption until the table has an entry.`);
L.push(``);

L.push(`## Effort levels`);
L.push(``);
L.push(`| Level | Rank | Meaning |`);
L.push(`|---|---|---|`);
for (const [e, s] of efforts) L.push(`| \`${e}\` | ${s.rank} | ${s.note || ''} |`);
L.push(``);

L.push(`## Weight → model (base routing)`);
L.push(``);
L.push(`| Weight | Model | Effort | Task shape |`);
L.push(`|---|---|---|---|`);
for (const w of weights) {
  const r = cfg.routing[w];
  L.push(`| ${w} | \`${r.model}\` | ${r.effort ? `\`${r.effort}\`` : '_none_'} | ${r.label || ''} |`);
}
L.push(``);

L.push(`## Weight × kind → effort (the decision grid)`);
L.push(``);
L.push(`Weight picks the **model** (capability needed). Kind adjusts the **effort** (how much the answer benefits from search). They are orthogonal.`);
L.push(``);
L.push(`| Weight | ${kinds.join(' | ')} |`);
L.push(`|---|${kinds.map(() => '---').join('|')}|`);
for (const w of weights) L.push(`| ${w} | ${kinds.map((k) => `\`${cell(w, k)}\``).join(' | ')} |`);
L.push(``);
L.push(`| Kind | Δ effort | Examples |`);
L.push(`|---|---|---|`);
for (const [k, s] of Object.entries(cfg.taskKinds || {})) {
  const d = s.effortDelta > 0 ? `+${s.effortDelta}` : String(s.effortDelta);
  L.push(`| \`${k}\` | ${d} | ${(s.examples || []).join(', ')} |`);
}
L.push(``);

if (cfg.consequence) {
  L.push(`## Consequence floors (applied after kind; cannot be undercut)`);
  L.push(``);
  L.push(`| Level | Effort floor | Model floor | Triggers |`);
  L.push(`|---|---|---|---|`);
  for (const [c, s] of Object.entries(cfg.consequence)) {
    L.push(`| \`${c}\` | ${s.effortFloor ? `\`${s.effortFloor}\`` : '—'} | ${s.modelFloor ? `\`${s.modelFloor}\`` : '—'} | ${(s.triggers || []).join(', ') || '—'} |`);
  }
  L.push(``);
  L.push(`Example: a one-line production migration is \`mechanical\` by kind (effort down) but \`critical\` by consequence (floor up) — the floor wins.`);
  L.push(``);
}

if (cfg.reviewerParity) {
  const p = cfg.reviewerParity;
  L.push(`## Reviewer parity`);
  L.push(``);
  L.push(`- Model must match the writer it gates: **${p.modelMustMatch ? 'yes' : 'no'}**`);
  L.push(`- Effort may exceed the writer's: **${p.effortMayExceed ? 'yes' : 'no'}**`);
  L.push(`- Effort may fall below the writer's: **${p.effortMayNotDrop ? 'no' : 'yes'}**`);
  L.push(``);
}

if (cfg.taskTypes) {
  L.push(`## Task types → routing (the task model list)`);
  L.push(``);
  L.push(`Each named task type is a preset over (weight, kind, consequence) and resolves through the same grid. \`parity\` weight = match the writer being reviewed; \`inherit\` consequence = take the change's consequence.`);
  L.push(``);
  L.push(`| Task type | Weight | Kind | Consequence | Resolves to | What it is |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    let resolved = '—';
    if (typeof t.weight === 'number') {
      const r = effortFor(t.weight, t.kind, t.consequence === 'inherit' ? 'routine' : t.consequence);
      resolved = `\`${r.model}${r.effort ? '/' + r.effort : ''}\``;
    } else if (t.weight === 'parity') {
      resolved = '_writer\'s model; effort ≥ writer_';
    }
    L.push(`| \`${name}\` | ${t.weight} | \`${t.kind}\` | \`${t.consequence}\` | ${resolved} | ${t.summary || ''} |`);
  }
  L.push(``);
  L.push(`<details><summary>Provenance per task type</summary>`);
  L.push(``);
  for (const [name, t] of Object.entries(cfg.taskTypes)) L.push(`- **\`${name}\`** — ${t.provenance || 'none recorded'}`);
  L.push(``);
  L.push(`</details>`);
  L.push(``);
}

const fableNotes = cfg.tiers?.fable?.behaviorNotes;
if (Array.isArray(fableNotes) && fableNotes.length) {
  L.push(`## What is actually known about \`fable\``);
  L.push(``);
  for (const n of fableNotes) L.push(`- ${n}`);
  L.push(``);
}

if (cfg.calibration) {
  L.push(`## Open calibration questions`);
  L.push(``);
  L.push(`Real findings not settled enough to encode as rules. Each names the measurement that would settle it — telemetry answers these, not opinion.`);
  L.push(``);
  for (const [id, q] of Object.entries(cfg.calibration)) {
    L.push(`### \`${id}\` — ${q.status || 'open'}`);
    L.push(``);
    L.push(`**Question:** ${q.question}`);
    L.push(``);
    L.push(`**Tension:** ${q.tension}`);
    L.push(``);
    L.push(`**Measure:** ${q.measure}`);
    L.push(``);
  }
}

for (const [alias, t] of tiers) {
  if (t.retiresAfter) {
    L.push(`> ⚠ \`${alias}\` retires no sooner than **${t.retiresAfter}**. ${t.retirementNote || ''}`);
    L.push(``);
  }
}

const md = L.join('\n') + '\n';
const out = val('--out');
if (out) { writeFileSync(out, md); console.log(`wrote ${out}`); } else { process.stdout.write(md); }
