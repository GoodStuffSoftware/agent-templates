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
//   node routing-table.mjs --task-type-block          # the compact block skills/recommend/SKILL.md carries
//   node routing-table.mjs --sync-skill FILE          # rewrite that block in FILE, between its markers

import { readFileSync, writeFileSync } from 'node:fs';
import { modelTiers, effortFor, routeForWeight, resolveRoute } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();
const tiers = Object.entries(cfg.tiers || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const efforts = Object.entries(cfg.efforts || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const kinds = Object.keys(cfg.taskKinds || {});
const weights = Object.keys(cfg.routing || {}).sort();

// Which layers the table renders. The DEFAULT is the shipped table only —
// profile:false — because this output is committed (docs/ROUTING.md, the
// recommend skill's block) and checked by the routing-doc audit check; one
// machine's routing profile must never leak into it. `--profile` renders the
// table as THIS machine resolves it, with any winning routing-profile row
// marked (the /ac routing display).
// Combined with an output that is committed or machine-read (--out,
// --json, --task-type-block, --sync-skill) it is refused, never silently
// ignored (S2 review P10): those always render the shipped table.
const withProfile = has('--profile');
if (withProfile) {
  const clash = ['--out', '--json', '--task-type-block', '--sync-skill'].filter(has);
  if (clash.length) {
    console.error(`--profile renders this machine's view for reading only; it cannot be combined with ${clash.join(', ')}, which always render the shipped table. Drop --profile, or drop ${clash.join(', ')}.`);
    process.exit(2);
  }
}

// A named type's route and its shipped-trial entry, both from resolveRoute()
// — the only reader of taskTypes.<type>.override (tests/route-readers.test.mjs).
// Every row renders the resolver's WINNING answer (after floors), whichever
// layer produced it; `layer` says which. `won` is true only when the trial
// actually won; `trial` is the trial entry whether or not it won.
function typeRoute(name) {
  const r = resolveRoute({ type: name, profile: withProfile });
  const entry = r.stack.find((s) => s.layer === 'trial');
  const trial = entry && entry.present ? { ...entry.candidate, ...entry.meta } : null;
  const gridEntry = r.stack.find((s) => s.layer === 'grid');
  const grid = gridEntry && gridEntry.candidate ? `${gridEntry.candidate.model}${gridEntry.candidate.effort ? '/' + gridEntry.candidate.effort : ''}` : '';
  return {
    won: r.layer === 'trial',
    layer: r.layer,
    profileRevision: r.profileRevision,
    model: r.model,
    label: `${r.model}${r.effort ? '/' + r.effort : ''}`,
    trial,
    grid,
  };
}
const profileMark = (tr) => (tr.layer === 'profile' ? ` _(your routing profile, rev ${tr.profileRevision})_` : '');

const cell = (w, k) => {
  const r = effortFor(Number(w), k);
  return r.model + (r.effort ? `/${r.effort}` : '');
};

// A compact task-type -> route block, spliced into skills/recommend/SKILL.md
// between the markers below. Why the skill carries a copy at all: a session
// with no shell and no read access outside its working directory (an eval
// sandbox, a read-only session) cannot run recommend.mjs or open
// docs/ROUTING.md, so without this block the skill has no routing data and
// the model falls back to its own taste -- found by the routing eval suite
// (evals/), where the architecture canary answered opus/xhigh instead of the
// trial's opus/high. GENERATED like docs/ROUTING.md, and checked by the same
// routing-doc audit check, so it cannot drift from the config.
const SKILL_BLOCK_BEGIN = '<!-- routing-table:task-types BEGIN (generated from config/model-tiers.json by scripts/routing-table.mjs --sync-skill; do not edit by hand) -->';
const SKILL_BLOCK_END = '<!-- routing-table:task-types END -->';

function taskTypeBlock() {
  const B = [SKILL_BLOCK_BEGIN];
  B.push(`Config v${cfg.version} (updated ${cfg.updated}). **Premium** = the spawn brief needs a \`WARRANT:\` line. Fable never appears here: it is a warranted exception, not a route.`);
  B.push('');
  B.push('| Task type | Route | Premium | What it is |');
  B.push('|---|---|---|---|');
  const premiumOf = (alias) => !!(cfg.tiers?.[alias]?.premium);
  for (const [name, t] of Object.entries(cfg.taskTypes || {})) {
    let route = '—';
    let premium = '—';
    if (typeof t.weight === 'number') {
      const tr = typeRoute(name);
      route = tr.won
        ? `\`${tr.label}\` (routing trial${tr.trial.reviewBy ? ', review by ' + tr.trial.reviewBy : ''})`
        : `\`${tr.label}\`${profileMark(tr)}`;
      premium = premiumOf(tr.model) ? 'yes' : 'no';
    } else if (t.weight === 'parity') {
      route = "writer's model, floored to opus/xhigh if critical and never fable; effort ≥ writer's";
      premium = 'as writer (opus if critical or fable)';
    }
    B.push(`| \`${name}\` | ${route} | ${premium} | ${t.summary || ''} |`);
  }
  B.push(SKILL_BLOCK_END);
  return B.join('\n');
}

// Replaces the marked block in `text` with a fresh one. Returns null when the
// markers are missing (the caller reports it rather than guessing a spot).
function spliceSkillBlock(text, block = taskTypeBlock()) {
  const s = text.indexOf(SKILL_BLOCK_BEGIN);
  const e = text.indexOf(SKILL_BLOCK_END);
  if (s < 0 || e < 0 || e < s) return null;
  return text.slice(0, s) + block + text.slice(e + SKILL_BLOCK_END.length);
}

// CLI only (this file renders at top level and is never imported): the
// routing-doc audit check and the tests exec it with these flags.
if (has('--task-type-block')) {
  process.stdout.write(taskTypeBlock() + '\n');
  process.exit(0);
}

if (has('--sync-skill')) {
  const file = val('--sync-skill');
  const before = readFileSync(file, 'utf8');
  const after = spliceSkillBlock(before.replace(/\r\n/g, '\n'));
  if (after == null) { console.error(`${file}: routing-table markers not found`); process.exit(1); }
  writeFileSync(file, after);
  console.log(`synced task-type block in ${file}`);
  process.exit(0);
}

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

if (Array.isArray(cfg.ladder) && cfg.ladder.length) {
  L.push(`## Effort ladder (cheapest to dearest)`);
  L.push(``);
  L.push(`The same routing grid's (model, effort) pairs, ordered, each mapped to a spawnable generic worker definition under \`agents/\` — namespaced \`agent-companion:<agent>\` when spawned from outside this repo. Fable stays outside the ladder as a warranted exception, never a routine destination.`);
  L.push(``);
  L.push(`| Rung | Model | Effort | Spawn as |`);
  L.push(`|---|---|---|---|`);
  for (const r of cfg.ladder) {
    L.push(`| ${r.rung} | \`${r.model}\` | ${r.effort ? `\`${r.effort}\`` : '_none_'} | \`agent-companion:${r.agent}\` |`);
  }
  L.push(``);
}

if (cfg.referenceModels && Object.keys(cfg.referenceModels).length) {
  L.push(`## Reference models (older pinned ids — not routable)`);
  L.push(``);
  L.push(`Non-routable entries for OLDER full/dated model ids, kept only so an agent definition pinned to one of these has its effort validated against what THAT version actually supports, not the current alias tier's (possibly wider) list.`);
  L.push(``);
  L.push(`| Key | Display name | Accepts effort | Note |`);
  L.push(`|---|---|---|---|`);
  for (const [key, r] of Object.entries(cfg.referenceModels)) {
    const eff = Array.isArray(r.efforts) ? (r.efforts.length ? r.efforts.join(', ') : '**none**') : '?';
    L.push(`| \`${key}\` | ${r.displayName || key} | ${eff} | ${r.note || ''} |`);
  }
  L.push(``);
}

L.push(`## Weight → model (base routing)`);
L.push(``);
L.push(`| Weight | Model | Effort | Task shape |`);
L.push(`|---|---|---|---|`);
for (const w of weights) {
  const r = routeForWeight(Number(w));
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
  L.push(`- Reviewer starts at the model of the writer it gates (then the floors below apply): **${p.modelMustMatch ? 'yes' : 'no'}**`);
  L.push(`- Effort may exceed the writer's: **${p.effortMayExceed ? 'yes' : 'no'}**`);
  L.push(`- Effort may fall below the writer's: **${p.effortMayNotDrop ? 'no' : 'yes'}**`);
  L.push(``);
  const critFloor = cfg.consequence?.critical || {};
  L.push(`That parity match is then floored, same as any other route (operator-decided 2026-09-24, see resolveRoute() in hooks/lib/context.mjs): a **critical** review is never sized below \`${critFloor.modelFloor}\`/\`${critFloor.effortFloor}\` (F1), never routed to fable — capped to the best available tier that is not one, which still demands its own WARRANT (F2) — and refused outright for a writer model outside the tier table, or unavailable with no staged replacement (F4). A per-user routing profile row for a parity type may only raise the resulting minimum effort further; it can never name a model.`);
  L.push(``);
}

if (cfg.taskTypes) {
  L.push(`## Task types → routing (the task model list)`);
  L.push(``);
  L.push(`Each named task type is a preset over (weight, kind, consequence) and resolves through the same grid. \`parity\` weight = sized to the writer being reviewed (see Reviewer parity); \`inherit\` consequence = take the change's consequence. **\`--type\` is the preferred input over raw \`--weight\`/\`--kind\`** — a named type is the only place a measured routing-trial override (below) attaches; resolving by weight/kind alone always uses the plain grid.`);
  L.push(``);
  L.push(`| Task type | Weight | Kind | Consequence | Resolves to | What it is |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const [name, t] of Object.entries(cfg.taskTypes)) {
    let resolved = '—';
    if (typeof t.weight === 'number') {
      const tr = typeRoute(name);
      if (tr.won) {
        resolved = `\`${tr.label}\` _(trial override)_`;
      } else {
        resolved = `\`${tr.label}\`${profileMark(tr)}`;
      }
    } else if (t.weight === 'parity') {
      resolved = '_writer\'s model, floored to opus/xhigh if critical and never fable; effort ≥ writer_';
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

  const overridden = Object.entries(cfg.taskTypes)
    .map(([name, t]) => [name, t, typeRoute(name).trial])
    .filter(([, , ov]) => ov);
  if (overridden.length) {
    L.push(`### Routing trial (benchmark overrides, not the plain grid)`);
    L.push(``);
    L.push(`These task types resolve to a benchmark-backed (model, effort) pair that supersedes their own weight/kind/consequence grid resolution for the trial window below. The override applies only when the type is used as-is — passing an explicit \`--weight\`/\`--kind\`/\`--consequence\` that departs from the type's preset falls back to the plain grid (one equal to the preset restates the type and keeps the trial). Every OTHER task type in the list above is **UNBENCHMARKED** by this trial and keeps its grid-resolved routing unchanged.`);
    L.push(``);
    L.push(`| Task type | Trial | Grid would say | Since | Review by | Evidence |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const [name, , ov] of overridden) {
      const gridLabel = typeRoute(name).grid;
      const trialLabel = `${ov.model}${ov.effort ? '/' + ov.effort : ''}` + (ov.overridesKindDelta ? ' _(overrides kind delta)_' : '');
      const evid = ov.evidence ? `${ov.evidence.source || ''}${ov.evidence.date ? ' (' + ov.evidence.date + ')' : ''}` : '—';
      L.push(`| \`${name}\` | \`${trialLabel}\` | \`${gridLabel}\` | ${ov.trialSince || '—'} | ${ov.reviewBy || '—'} | ${evid} |`);
    }
    L.push(``);
    for (const [name, , ov] of overridden) L.push(`- **\`${name}\`** — ${ov.reason}`);
    L.push(``);
  }
}

if (cfg.costDrivers) {
  const cd = cfg.costDrivers;
  L.push(`## Cost drivers`);
  L.push(``);
  if (cd.note) L.push(cd.note);
  L.push(``);
  if (cd.readPricePerMTokByTier) {
    L.push(`| Tier | Cache-read price ($/MTok) |`);
    L.push(`|---|---|`);
    for (const [alias, price] of Object.entries(cd.readPricePerMTokByTier)) {
      if (alias === 'note') continue;
      L.push(`| \`${alias}\` | $${price} |`);
    }
    L.push(``);
    if (cd.readPricePerMTokByTier.note) L.push(cd.readPricePerMTokByTier.note);
    L.push(``);
  }
  if (cd.planUsageWeighting) {
    const w = cd.planUsageWeighting;
    L.push(`**Plan-usage weighting of cache reads: ${w.status || 'UNKNOWN'}.** ${w.note || ''}${w.experiment ? ` (experiment: \`${w.experiment}\`)` : ''}`);
    L.push(``);
  }
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
    if (t.replacement && t.replacement.model) {
      L.push('> Staged replacement: **' + t.replacement.model + (t.replacement.effort ? '/' + t.replacement.effort : '') + '** — routing rows on `' + alias + '` switch to it automatically from ' + t.retiresAfter + '. ' + (t.replacement.note || ''));
    }
    L.push(``);
  }
}

const md = L.join('\n') + '\n';
const out = val('--out');
if (out) { writeFileSync(out, md); console.log(`wrote ${out}`); } else { process.stdout.write(md); }
