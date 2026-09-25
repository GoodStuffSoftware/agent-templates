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
//   node routing-table.mjs --check-agent-descriptions # exit 1 if any agents/ac-*.md description has drifted
//   node routing-table.mjs --sync-agent-descriptions  # rewrite those descriptions to match the config now

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { modelTiers, effortFor, routeForWeight, resolveRoute, rungFor } from '../hooks/lib/context.mjs';

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
    console.error(`--profile renders this machine's view for reading only; it cannot be combined with ${clash.join(', ')}, which always ${clash.length === 1 ? 'renders' : 'render'} the shipped table. Drop --profile, or drop ${clash.join(', ')}.`);
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

// --- Ladder agent descriptions (ladder track, ADR-0292) -------------------
// Each agents/ac-*.md file's `description:` frontmatter is what a spawner
// reads to pick a rung, so it must never ASSERT something the current
// routing config falsifies — the bug this exists to catch: ac-opus-low's
// hand-written description called opus/low "rare; prefer sonnet unless...",
// which routing trial v2 flatly contradicts. Coverage is driven entirely by
// config/model-tiers.json: EVERY `ladder` rung is generated and checked,
// including one added or renamed later, and the check also fails for a rung
// with no `role`, a rung with no file, a file whose `name:` is not its rung,
// and an agents/ac-*.md file that is no longer a rung (a rename leaves one).
//
// Each description is the rung's config `role` (a static capability shape
// that never says how OFTEN the rung is used) plus a GENERATED suffix naming
// which task types currently default here, computed fresh from
// resolveRoute(). A rung whose model carries a `retiresAfter` gets its
// retirement notice generated from that date and the tier's `replacement`
// as well, so neither can go stale as a hand-typed copy.
function ladderRungs() {
  return Array.isArray(cfg.ladder) ? cfg.ladder.filter((r) => r && r.agent) : [];
}

// Task types (numeric-weight only — parity types are sized to a writer, not
// a fixed rung) that resolve, RIGHT NOW, to exactly this rung's (model,
// effort). Deliberately re-resolves through resolveRoute() rather than
// reading taskTypes[].override directly, so a profile or a future layer
// change is picked up the same way a live spawn would see it.
function typesForRung(rung) {
  const names = [];
  for (const [name, t] of Object.entries(cfg.taskTypes || {})) {
    if (typeof t.weight !== 'number') continue;
    let r;
    try { r = resolveRoute({ type: name, profile: false }); } catch { continue; }
    if (r.model === rung.model && (r.effort || null) === (rung.effort || null)) names.push(name);
  }
  return names;
}

function retirementNotice(rung, total) {
  const tier = (cfg.tiers || {})[rung.model] || {};
  if (!tier.retiresAfter) return null;
  const rep = tier.replacement || {};
  const fallback = rep.model ? rungFor(rep.model, rep.effort || null) : null;
  const to = fallback
    ? `rung ${fallback.rung}, ${fallback.agent} (${fallback.model}${fallback.effort ? '/' + fallback.effort : ''})`
    : 'no staged replacement';
  return {
    prefix: `RETIRING (no sooner than ${tier.retiresAfter}): rung ${rung.rung}/${total}`,
    tail: `After that date the routing table stops naming this rung on its own (config/model-tiers.json tiers.${rung.model}.retiresAfter/replacement) and falls back to ${to}.`,
  };
}

// null when the config gives this rung no `role` (a coverage failure the
// check reports, never a silent skip).
function generatedAgentDescription(rung) {
  const role = typeof rung.role === 'string' ? rung.role.trim() : '';
  if (!role) return null;
  const total = ladderRungs().length;
  const types = typesForRung(rung);
  const suffix = types.length
    ? `Currently the default routing for: ${types.join(', ')}.`
    : 'Not currently the default routing for any listed task type — spawn it directly by name when the work needs it.';
  const tier = (cfg.tiers || {})[rung.model] || {};
  const noEffort = Array.isArray(tier.efforts) && tier.efforts.length === 0
    ? ` ${tier.resolvesTo?.displayName || rung.model} takes no effort parameter.`
    : '';
  const ret = retirementNotice(rung, total);
  if (ret) return `${ret.prefix} — ${role}.${noEffort} ${suffix} ${ret.tail}`;
  return `Rung ${rung.rung}/${total}: ${role}.${noEffort} ${suffix}`;
}

// Overridable only for tests — same pattern as AGENT_COMPANION_HOME_OVERRIDE
// elsewhere in this plugin: a fixture directory standing in for the real
// agents/ tree, so the check/sync CLI can be exercised against mutated
// copies without ever touching this repo's own committed files.
function agentsDir() {
  return process.env.AGENT_COMPANION_AGENTS_DIR_OVERRIDE
    || join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
}
function agentFile(rung) {
  return join(agentsDir(), `${rung.agent}.md`);
}

function frontmatterValue(fmText, key) {
  const m = fmText.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!m) return null;
  let val = m[1].trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
  return val;
}
function readDescription(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { text: null, description: null, name: null }; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { text, description: null, name: null };
  return { text, description: frontmatterValue(m[1], 'description'), name: frontmatterValue(m[1], 'name') };
}

function writeDescription(file, text, newDescription) {
  const quoted = /[:#{}[\],&*!|>'"%@`]/.test(newDescription) || newDescription.includes(': ');
  const line = quoted ? `description: "${newDescription.replace(/"/g, '\\"')}"` : `description: ${newDescription}`;
  const updated = text.replace(/^description:\s*.*$/m, line);
  writeFileSync(file, updated);
}

// Every problem, one entry each: { agent, file, problem, expected, actual }.
// `problem` is one of: no-role (config gives the rung no role text),
// missing-file, name-mismatch, drift (description differs from the
// generated one), not-a-rung (an agents/ac-*.md file no rung names).
function checkAgentDescriptions() {
  const out = [];
  const rungs = ladderRungs();
  for (const rung of rungs) {
    const file = agentFile(rung);
    const expected = generatedAgentDescription(rung);
    const { text, description, name } = readDescription(file);
    if (expected === null) {
      out.push({ agent: rung.agent, file, problem: 'no-role', expected: `a "role" for rung ${rung.rung} in config/model-tiers.json ladder`, actual: null });
      continue;
    }
    if (text === null) {
      out.push({ agent: rung.agent, file, problem: 'missing-file', expected, actual: null });
      continue;
    }
    if (name !== rung.agent) out.push({ agent: rung.agent, file, problem: 'name-mismatch', expected: `name: ${rung.agent}`, actual: name === null ? null : `name: ${name}` });
    if (description !== expected) out.push({ agent: rung.agent, file, problem: 'drift', expected, actual: description });
  }
  const known = new Set(rungs.map((r) => `${r.agent}.md`));
  let files = [];
  try { files = readdirSync(agentsDir()); } catch { /* no agents dir: every rung already reported missing */ }
  for (const f of files.filter((x) => /^ac-.*\.md$/.test(x) && !known.has(x)).sort()) {
    out.push({ agent: f.replace(/\.md$/, ''), file: join(agentsDir(), f), problem: 'not-a-rung', expected: 'a config/model-tiers.json ladder rung naming this file', actual: f });
  }
  return out;
}

function syncAgentDescriptions() {
  const written = [];
  for (const rung of ladderRungs()) {
    const expected = generatedAgentDescription(rung);
    if (expected === null) continue; // no role: only the check can report it
    const file = agentFile(rung);
    const { text, description } = readDescription(file);
    if (text === null || description === expected) continue;
    writeDescription(file, text, expected);
    written.push(file);
  }
  return written;
}
if (has('--check-agent-descriptions')) {
  const drift = checkAgentDescriptions();
  if (drift.length === 0) {
    console.log('agent descriptions match config/model-tiers.json — no drift');
    process.exit(0);
  }
  console.error(`${drift.length} ladder agent description problem(s) against config/model-tiers.json's ladder:`);
  for (const d of drift) {
    console.error(`\n${d.agent} [${d.problem}] (${d.file}):`);
    console.error(`  expected: ${d.expected}`);
    console.error(`  actual:   ${d.actual === null ? '(missing/unparseable)' : d.actual}`);
  }
  console.error('\nDrifted descriptions: run `node scripts/routing-table.mjs --sync-agent-descriptions`. A missing role, file or rung, a name mismatch or a file that is no longer a rung needs a config or file edit.');
  process.exit(1);
}

if (has('--sync-agent-descriptions')) {
  const written = syncAgentDescriptions();
  console.log(written.length ? `updated: ${written.join(', ')}` : 'no agent descriptions needed updating');
  process.exit(0);
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
L.push(`For WHY the table is shaped this way — lowest-sufficient tier, effort as a separate lever, reviewer parity, the consequence floors, trials and per-user profiles, cost basis, and haiku-as-validator — see [\`docs/ROUTING-RATIONALE.md\`](./ROUTING-RATIONALE.md), a hand-written companion doc (this file is generated and cannot carry hand-written prose).`);
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
