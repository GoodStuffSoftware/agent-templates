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
//   node routing-table.mjs --check-agent-descriptions # exit 1 if any agents/ac-*.md description, cacheTtl OR self-review protocol block has drifted
//   node routing-table.mjs --sync-agent-descriptions  # rewrite those descriptions/cacheTtl/self-review blocks to match the config now

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  modelTiers, effortFor, routeForWeight, resolveRoute, rungFor, ladderVariants, expectedDisallowedTools, ladderToolPolicy,
} from '../hooks/lib/context.mjs';
import {
  selfReviewConfig, selfReviewTypesForRung, selfReviewConfigProblems, selfReviewBlock,
  readSelfReviewBlock, setSelfReviewBlock,
} from '../hooks/lib/self-review.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const cfg = modelTiers();
const tiers = Object.entries(cfg.tiers || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const efforts = Object.entries(cfg.efforts || {}).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
const kinds = Object.keys(cfg.taskKinds || {});
const weights = Object.keys(cfg.routing || {}).sort();
const selfReview = selfReviewConfig(cfg);

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
// (evals/), where the novel-design canary (evals/route-novel-design) answered
// opus/xhigh instead of the trial's then opus/high. GENERATED like docs/ROUTING.md, and checked by the same
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
  if (selfReview.types.length) {
    B.push('');
    B.push(`**Self-review:** ${selfReviewSummary()}`);
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
// as well, so neither can go stale as a hand-typed copy. (The date drives
// warnings; the fall-back to the replacement needs `retired: true`.)
//
// A rung's optional `cacheTtl` config field ("1h", or omitted for the
// subagent 5m default) is covered the same way, into the SAME frontmatter
// block, as a NESTED `experimental: { cacheTtl: "1h" }` (block-style: an
// `experimental:` line followed by one indented `cacheTtl:` line — see
// readCacheTtl()/setCacheTtl() below). It is checked/synced independently of
// the description text (a rung can drift on one and not the other), by the
// same --check-agent-descriptions / --sync-agent-descriptions pair, so there
// is still exactly one generator and one drift check for this file, not two.
function ladderRungs() {
  return Array.isArray(cfg.ladder) ? cfg.ladder.filter((r) => r && r.agent) : [];
}

// Every agents/ac-*.md file the generator owns: the rungs, then the
// `ladderVariants` (a rung's model and effort with a different tool set; not a
// rung, so no number, no cache TTL and no self-review block).
function agentEntries() {
  return [...ladderRungs(), ...ladderVariants()];
}

// The `disallowedTools` frontmatter line, GENERATED from config `ladderTools`
// (hooks/lib/context.mjs expectedDisallowedTools): a comma-separated list on
// one line, placed after `effort:` (after `model:` for a rung with no effort).
function expectedToolsLine(entry) {
  const list = expectedDisallowedTools(entry.agent);
  return list ? list.join(', ') : null;
}
function readToolsLine(fmText) {
  const v = frontmatterValue(fmText, 'disallowedTools');
  return v === null ? null : v.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
}
// Pure: sets, replaces or removes the one-line `disallowedTools:` entry in a
// whole file's TEXT. null removes it.
function setToolsLine(text, line) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  let fm = m[1];
  const nl = fm.includes('\r\n') ? '\r\n' : '\n';
  const has = /^disallowedTools:.*$/m.test(fm);
  if (line === null) {
    if (!has) return text;
    fm = fm.split(/\r?\n/).filter((l) => !/^disallowedTools:/.test(l)).join(nl);
  } else if (has) {
    fm = fm.replace(/^disallowedTools:.*$/m, `disallowedTools: ${line}`);
  } else if (/^effort:.*$/m.test(fm)) {
    fm = fm.replace(/^(effort:.*)$/m, `$1${nl}disallowedTools: ${line}`);
  } else if (/^model:.*$/m.test(fm)) {
    fm = fm.replace(/^(model:.*)$/m, `$1${nl}disallowedTools: ${line}`);
  } else {
    fm = `${fm}${nl}disallowedTools: ${line}`;
  }
  return text.slice(0, m.index) + '---' + nl + fm + nl + '---' + text.slice(m.index + m[0].length);
}

// The self-review protocol (config/model-tiers.json `selfReview`,
// hooks/lib/self-review.mjs) is covered by the same generator and the same
// check: every rung that is RIGHT NOW the default route (shipped table,
// profile:false) for a selfReview type carries the generated block in its
// BODY, between its markers, and no other rung carries one. So a table move
// (a trial that takes novel-design off opus/xhigh, say) fails --check on
// both the rung that lost the type and the rung that gained it, and --sync
// moves the block with it. Checked independently of the description and the
// cacheTtl, the way the cacheTtl is checked independently of the description.
function expectedSelfReviewBlock(rung) {
  return selfReviewTypesForRung(rung, selfReview).length ? selfReviewBlock(rung, selfReview) : null;
}
function selfReviewRungNames() {
  return ladderRungs().filter((r) => selfReviewTypesForRung(r, selfReview).length).map((r) => r.agent);
}
// One sentence, shared by the recommend skill's block and docs/ROUTING.md.
function selfReviewSummary() {
  const rungs = selfReviewRungNames();
  const rounds = selfReview.fixRounds === 0 ? 'no fix round' : selfReview.fixRounds === 1 ? 'one fix round' : `at most ${selfReview.fixRounds} fix rounds`;
  return `a writer spawned as ${selfReview.types.map((x) => `\`${x}\``).join(', ')} reviews its own work before it returns ` +
    `(it commits, spawns ONE foreground parity reviewer on its own rung, runs ${rounds}, and returns the verdict line verbatim), ` +
    `unless its brief carries the line \`${selfReview.optOut.line}\`. The protocol is in the body of ${rungs.length ? rungs.map((a) => `\`agent-companion:${a}\``).join(', ') : 'no rung'}; ` +
    'on any other ladder rung (a routing profile or a local copy of the table can put a listed type there) the spawn guard appends the same text to the brief. ' +
    'A built-in or project agent does not self-review unless its own definition says so, and the lead reviews it as before.';
}

// The rung's expected cache-TTL frontmatter value: "1h" when config says so,
// else null (meaning "no experimental.cacheTtl block" — the subagent 5m
// default applies with nothing stated). Never any other string: Claude Code
// itself only recognises "5m"/"1h" (code.claude.com/docs/en/sub-agents), and
// a config value that is neither is treated as absent (5m) rather than
// guessed at, same convention as scripts/checks.mjs's cacheTtlFrontmatter().
function expectedCacheTtl(rung) {
  return rung && rung.cacheTtl === '1h' ? '1h' : null;
}

// Reads the nested `experimental.cacheTtl` value out of a frontmatter block's
// TEXT (the capture group between the `---` fences, not the whole file) —
// frontmatterValue()/readDescription() below are flat, single-line parsers
// and do not descend into a nested map, so this searches directly rather
// than hand-rolling a YAML parser for one field. Duplicated (not imported)
// in scripts/checks.mjs's cacheTtlFrontmatter() and
// hooks/lib/resume-guard.mjs's cacheTtlFromDefinition(): hooks/ must not
// import scripts/, and keeping each reader small and self-contained beats a
// shared import three call sites would need to agree on.
const CACHE_TTL_LINE = /^([ \t]*)cacheTtl:\s*["']?(5m|1h)["']?[ \t]*$/m;
function readCacheTtl(fmText) {
  const m = fmText.match(CACHE_TTL_LINE);
  return m ? m[2] : null;
}

// Sets or removes the `experimental.cacheTtl` block in a whole file's TEXT
// (frontmatter fences included), returning the updated text. `ttl` is "1h"
// to add/update that setting, or null to remove it (falling back to the
// subagent 5m default). Only the two-line shape this generator itself
// writes — a bare `experimental:` line immediately followed by one indented
// `cacheTtl:` line, nothing else nested under it — is understood; every
// shipped agents/ac-*.md file is written by this function, so that shape is
// the only one that needs round-tripping. Idempotent: calling it again with
// the same `ttl` returns byte-identical text.
function setCacheTtl(text, ttl) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text; // no frontmatter fences: nothing this function can touch
  let fm = m[1];
  const nl = fm.includes('\r\n') ? '\r\n' : '\n';
  const hasLine = CACHE_TTL_LINE.test(fm);
  if (ttl === '1h') {
    if (hasLine) {
      fm = fm.replace(CACHE_TTL_LINE, '  cacheTtl: "1h"');
    } else if (/^experimental:[ \t]*$/m.test(fm)) {
      fm = fm.replace(/^experimental:[ \t]*$/m, `experimental:${nl}  cacheTtl: "1h"`);
    } else {
      fm = `${fm}${nl}experimental:${nl}  cacheTtl: "1h"`;
    }
  } else if (hasLine) {
    const lines = fm.split(/\r?\n/);
    const idx = lines.findIndex((l) => CACHE_TTL_LINE.test(l));
    const expIdx = idx > 0 && /^experimental:[ \t]*$/.test(lines[idx - 1]) ? idx - 1 : -1;
    const nextIsNested = idx + 1 < lines.length && /^[ \t]+\S/.test(lines[idx + 1]);
    lines.splice(idx, 1);
    if (expIdx >= 0 && !nextIsNested) lines.splice(expIdx, 1); // last child removed: drop the now-empty header too
    fm = lines.join(nl);
  }
  return text.slice(0, m.index) + '---' + nl + fm + nl + '---' + text.slice(m.index + m[0].length);
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
    tail: `Routing falls back to ${fallback ? fallback.agent : 'no staged replacement'} once tiers.${rung.model}.retired is true.`,
  };
}

// null when the config gives this rung no `role` (a coverage failure the
// check reports, never a silent skip).
function generatedAgentDescription(rung) {
  const role = typeof rung.role === 'string' ? rung.role.trim() : '';
  if (!role) return null;
  const total = ladderRungs().length;
  // A variant is not a rung: no routing claim to verify, only what it is.
  if (rung.variant) {
    return `${role} (${rung.model}${rung.effort ? '/' + rung.effort : ''}). Not a ladder rung: the ac-* agent with browser tools; /ac routing.`;
  }
  const types = typesForRung(rung);
  // typesForRung reads the SHIPPED table (profile: false), so these lists are
  // the base table's. The guards and recommend.mjs resolve through the
  // operator's routing profile too, and a description cannot see that (it is
  // generated at build time and committed), so each one says where it stops.
  // Short on purpose: every agent description is paid for at the start of
  // every session and every subagent.
  const suffix = types.length
    ? `Base default for: ${types.join(', ')}; profile may differ (/ac routing).`
    : 'Not a base default; profile may differ (/ac routing).';
  const tier = (cfg.tiers || {})[rung.model] || {};
  const noEffort = Array.isArray(tier.efforts) && tier.efforts.length === 0 ? ' No effort parameter.' : '';
  const ret = retirementNotice(rung, total);
  if (ret) return `${ret.prefix} — ${role}.${noEffort} ${suffix} ${ret.tail}`;
  return `Rung ${rung.rung}/${total}: ${role}. ${suffix}`;
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
  try { text = readFileSync(file, 'utf8'); } catch { return { text: null, description: null, name: null, cacheTtl: null, tools: null }; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { text, description: null, name: null, cacheTtl: null, tools: null };
  return {
    text,
    description: frontmatterValue(m[1], 'description'),
    name: frontmatterValue(m[1], 'name'),
    cacheTtl: readCacheTtl(m[1]),
    tools: readToolsLine(m[1]),
  };
}

// Pure: returns the updated file text with `description:` rewritten, never
// writes. Split from the old writeDescription() so a caller changing BOTH
// the description and the cacheTtl block writes the file once, not twice.
function applyDescription(text, newDescription) {
  const quoted = /[:#{}[\],&*!|>'"%@`]/.test(newDescription) || newDescription.includes(': ');
  const line = quoted ? `description: "${newDescription.replace(/"/g, '\\"')}"` : `description: ${newDescription}`;
  return text.replace(/^description:\s*.*$/m, line);
}

// A role is a capability shape. The only routing claim it may make is the
// checkable "default for <type>[, <type>...]", which is verified against
// resolveRoute() like the generated suffix; any other routing vocabulary
// (how often, which weight, what to prefer) cannot be checked, so it fails.
// "own default effort" is a fact about the model, not a routing claim.
const ROLE_CLAIM = /\bdefault(?: routing)? for:?\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/gi;
const ROLE_ROUTING_WORDS = /\b(defaults?|rare|rarely|prefer|preferred|usually|often|typically|mostly|commonly|reserve|reserved|weight[- ]?\d)\b/i;
function roleClaimProblems(rung) {
  const role = typeof rung.role === 'string' ? rung.role : '';
  const out = [];
  let rest = role.replace(/\bown default effort\b/gi, '');
  for (const m of role.matchAll(ROLE_CLAIM)) {
    rest = rest.replace(m[0], '');
    for (const type of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      let r = null;
      try { r = (cfg.taskTypes || {})[type] ? resolveRoute({ type, profile: false }) : null; } catch { r = null; }
      if (!r || r.model !== rung.model || (r.effort || null) !== (rung.effort || null)) {
        out.push({
          problem: 'false-claim',
          expected: r ? `"${type}" currently routes to ${r.model}${r.effort ? '/' + r.effort : ''}, not this rung` : `"${type}" is not a task type`,
          actual: role,
        });
      }
    }
  }
  const word = rest.match(ROLE_ROUTING_WORDS);
  if (word) {
    out.push({
      problem: 'unverifiable-claim',
      expected: `a role with no routing claim other than "default for <type>" (found "${word[0]}")`,
      actual: role,
    });
  }
  return out;
}

// Every problem, one entry each: { agent, file, problem, expected, actual }.
// `problem` is one of: no-role (config gives the rung no role text),
// false-claim / unverifiable-claim (the role's own routing claim, see
// roleClaimProblems), missing-file, name-mismatch, drift (description
// differs from the generated one), cache-ttl-drift (the frontmatter's
// experimental.cacheTtl does not match the rung's config `cacheTtl` field),
// tools-drift (the frontmatter's disallowedTools line differs from the one
// config `ladderTools` generates), variant-base (a ladderVariants entry whose
// base is no rung), not-a-rung (an agents/ac-*.md file no rung or variant names), self-review-drift (the
// body's self-review protocol block is missing, stale, or on a rung that is
// no longer the default for any selfReview type), self-review-malformed
// (unbalanced or repeated markers: fixed by hand), self-review-config (the
// selfReview section names an unknown type, a parity type, or a type whose
// route is no ladder rung).
function checkAgentDescriptions() {
  const out = [];
  const rungs = agentEntries();
  for (const problem of selfReviewConfigProblems(selfReview)) {
    out.push({
      agent: 'selfReview', file: 'config/model-tiers.json', problem: 'self-review-config',
      expected: 'selfReview.types lists numeric-weight task types, each routing to a ladder rung',
      actual: problem,
    });
  }
  for (const rung of rungs) {
    const file = agentFile(rung);
    for (const c of roleClaimProblems(rung)) out.push({ agent: rung.agent, file, ...c });
    const expected = generatedAgentDescription(rung);
    const { text, description, name, cacheTtl, tools } = readDescription(file);
    if (rung.variant && !rung.model) {
      out.push({ agent: rung.agent, file, problem: 'variant-base', expected: 'a ladderVariants entry whose base names a ladder rung', actual: String(rung.base) });
      continue;
    }
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
    const expectedTtl = expectedCacheTtl(rung);
    if (cacheTtl !== expectedTtl) {
      out.push({
        agent: rung.agent, file, problem: 'cache-ttl-drift',
        expected: expectedTtl ? 'experimental.cacheTtl: "1h"' : 'no experimental.cacheTtl block (subagent 5m default)',
        actual: cacheTtl ? `experimental.cacheTtl: "${cacheTtl}"` : '(absent)',
      });
    }
    const expectedTools = expectedToolsLine(rung);
    if (tools !== expectedTools) {
      out.push({
        agent: rung.agent, file, problem: 'tools-drift',
        expected: expectedTools === null ? 'no disallowedTools line' : 'disallowedTools: ' + expectedTools,
        actual: tools === null ? '(absent)' : 'disallowedTools: ' + tools,
      });
    }
    const srTypes = rung.variant ? [] : selfReviewTypesForRung(rung, selfReview);
    const expectedBlock = rung.variant ? null : expectedSelfReviewBlock(rung);
    const actualBlock = readSelfReviewBlock(text);
    if (actualBlock.malformed) {
      out.push({ agent: rung.agent, file, problem: 'self-review-malformed', expected: 'one BEGIN/END pair of self-review protocol markers, or none', actual: actualBlock.malformed });
    } else if ((actualBlock.block || null) !== expectedBlock) {
      out.push({
        agent: rung.agent, file, problem: 'self-review-drift',
        expected: expectedBlock
          ? `the generated self-review protocol block (this rung is the default route for selfReview type(s): ${srTypes.join(', ')})`
          : 'no self-review protocol block (this rung is the default route for no selfReview type)',
        actual: actualBlock.block ? 'a self-review protocol block that differs from the generated one' : '(absent)',
      });
    }
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
  for (const rung of agentEntries()) {
    const expected = generatedAgentDescription(rung);
    if (expected === null) continue; // no role: only the check can report it
    if (rung.variant && !rung.model) continue; // base is no rung: only the check can report it
    const file = agentFile(rung);
    const { text, description, cacheTtl, tools } = readDescription(file);
    if (text === null) continue;
    const expectedTtl = expectedCacheTtl(rung);
    let updated = text;
    let changed = false;
    if (description !== expected) { updated = applyDescription(updated, expected); changed = true; }
    if (cacheTtl !== expectedTtl) { updated = setCacheTtl(updated, expectedTtl); changed = true; }
    const expectedTools = expectedToolsLine(rung);
    if (tools !== expectedTools) { updated = setToolsLine(updated, expectedTools); changed = true; }
    // null: malformed markers, left for the check to report (sync never
    // guesses where a block ends).
    const withBlock = setSelfReviewBlock(updated, rung.variant ? null : expectedSelfReviewBlock(rung));
    if (withBlock !== null && withBlock !== updated) { updated = withBlock; changed = true; }
    if (!changed) continue;
    writeFileSync(file, updated);
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
  console.error(`${drift.length} ladder agent definition problem(s) against config/model-tiers.json's ladder:`);
  for (const d of drift) {
    console.error(`\n${d.agent} [${d.problem}] (${d.file}):`);
    console.error(`  expected: ${d.expected}`);
    console.error(`  actual:   ${d.actual === null ? '(missing/unparseable)' : d.actual}`);
  }
  console.error('\nDrifted: run `node scripts/routing-table.mjs --sync-agent-descriptions`. A missing role, file or rung, a name mismatch, a file that is no longer a rung, malformed self-review markers, or a self-review-config problem needs a config or file edit.');
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
L.push(`For WHY the table is shaped this way — lowest-sufficient tier, effort as a separate lever, reviewer parity, self-review, the consequence floors, trials and per-user profiles, cost basis, and haiku-as-validator — see [\`docs/ROUTING-RATIONALE.md\`](./ROUTING-RATIONALE.md), a hand-written companion doc (this file is generated and cannot carry hand-written prose).`);
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
  L.push(`| Rung | Model | Effort | Cache TTL | Spawn as |`);
  L.push(`|---|---|---|---|---|`);
  for (const r of cfg.ladder) {
    const ttl = r.cacheTtl === '1h' ? '`1h`' : '5m (default)';
    L.push(`| ${r.rung} | \`${r.model}\` | ${r.effort ? `\`${r.effort}\`` : '_none_'} | ${ttl} | \`agent-companion:${r.agent}\` |`);
  }
  L.push(``);
  const pol = ladderToolPolicy();
  L.push(`Every ladder agent's frontmatter carries \`disallowedTools\`, generated from \`ladderTools\` in the config (\`--sync-agent-descriptions\`): ${pol.everywhere.map((t) => `\`${t}\``).join(', ')} everywhere; ${pol.browserOnly.map((t) => `\`${t}\``).join(', ')} on every agent except the browser variants below${Object.keys(pol.keepOn).length ? `; ${Object.entries(pol.keepOn).map(([sv, ag]) => `\`${sv}\` everywhere except ${ag.map((a) => `\`${a}\``).join(', ')}`).join('; ')}` : ''}. They cost tokens at the start of every spawn and were used in few runs. \`general-purpose\` and the lead keep every tool.`);
  L.push(``);
  const variants = ladderVariants();
  if (variants.length) {
    L.push(`**UI and browser work.** The rungs above have no browser. These variants are not rungs (no number, never an escalation target, never picked by routing); each is one rung's model and effort plus the browser servers. \`recommend.mjs --browser\` names the one for the routed model.`);
    L.push(``);
    L.push(`| Variant | Model | Effort | Same as rung | Spawn as |`);
    L.push(`|---|---|---|---|---|`);
    for (const v of variants) {
      const base = cfg.ladder.find((r) => r.agent === v.base);
      L.push(`| \`${v.agent}\` | \`${v.model}\` | ${v.effort ? `\`${v.effort}\`` : '_none_'} | ${base ? base.rung : '?'} | \`agent-companion:${v.agent}\` |`);
    }
    L.push(``);
  }
  const oneHourRungs = cfg.ladder.filter((r) => r.cacheTtl === '1h');
  if (oneHourRungs.length) {
    L.push(`Rungs ${oneHourRungs.map((r) => `\`${r.agent}\``).join(', ')} carry \`experimental: { cacheTtl: "1h" }\` in their \`agents/ac-*.md\` frontmatter — generated from each rung's \`cacheTtl\` field above by this script (\`--sync-agent-descriptions\`), never hand-edited. The saving there does not come from being resumed: 30 days of real traffic showed close to zero message-level resumes on any ladder rung. It comes from slow tool waits (long \`Bash\` calls, test suites, builds) idling the cache past 5 minutes inside a single task — the all-cause measurement captures that, the resume-only measurement does not. \`ac-opus-low\` and every non-opus rung stay on the 5m default: resume doctrine is unchanged (resume a stopped worker only while its cache is warm — now up to an hour on these four rungs — otherwise spawn a fresh ladder worker from a file handoff; see \`hooks/resume-guard.mjs\`).`);
    L.push(``);
  }
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
  L.push(`**At spawn time** a review brief names its writer on a line of its own, next to \`TYPE:\` — \`WRITER: <model>/<effort>\` (\`opus xhigh\` and \`opus at xhigh\` read the same) or \`WRITER: <agent-name>\` (a ladder rung or project agent, read from its definition). Example: \`TYPE: code-review\` + \`WRITER: opus/xhigh\` is sized to \`opus/xhigh\`, so spawn \`ac-opus-xhigh\`. The spawn guard then judges the reviewer against that parity route (the writer's pair after the floors above) in notes only: below it, above it, or on an inherited effort it cannot verify. A reviewer on the parity route's model needs no WARRANT and is not counted by the premium cap. With no WRITER line the guard cannot size a review at all, and says so; a WRITER line with no effort, or an effort it cannot read, is checked on the model alone, and the note says so.`);
  L.push(``);
  if (p.liveEvidence) {
    L.push(`**Live evidence:** ${p.liveEvidence}`);
    L.push(``);
  }
}

if (selfReview.types.length) {
  L.push(`## Self-review (architect-class writers)`);
  L.push(``);
  L.push(`${selfReviewSummary().replace(/^a writer/, 'A writer')}`);
  L.push(``);
  L.push(`| Setting | Value |`);
  L.push(`|---|---|`);
  L.push(`| Types | ${selfReview.types.map((x) => `\`${x}\``).join(', ')} |`);
  L.push(`| Fix rounds | ${selfReview.fixRounds} (never a second review) |`);
  L.push(`| Opt-out brief line | \`${selfReview.optOut.line}\` |`);
  L.push(`| Rungs carrying the protocol | ${selfReviewRungNames().map((a) => `\`${a}\``).join(', ') || '_none_'} |`);
  if (selfReview.updated) L.push(`| Updated | ${selfReview.updated} |`);
  L.push(``);
  L.push(`The protocol text is generated into those rungs' \`agents/ac-*.md\` bodies from \`config/model-tiers.json\` \`selfReview\` by this script (\`--sync-agent-descriptions\`), and \`--check-agent-descriptions\` fails when a rung that routes a listed type lacks it, or a rung that no longer does still carries it. A listed type spawned on another ladder rung gets the same text, sized to that rung, appended to its brief by the spawn guard. The protocol tells the writer to open the reviewer's brief with \`TYPE: code-review\` and \`WRITER: <the writer's model>/<effort>\`, and to include the lead's brief verbatim (or its path), the branch, sha and diff range, the adversarial instruction, the review file path and a checkout of its own. At spawn time a code-review a subagent spawns with no \`WRITER:\` line is sized to the caller's own definition (checked against the model it was seen running), a self-reviewing writer that names a \`WRITER:\` below itself gets a note, a critical-change writer's review is floored by F1, and the spawn guard denies a code-review spawned by an agent that was itself spawned as a code-review: reviewers never spawn reviewers.`);
  L.push(``);
  L.push(`The lead still lands and merges the work, settles the disputed findings the writer returns, and spot-checks the review file against the diff. The guard cannot see what the writer puts in its reviewer's brief or how it relays the verdict; the lead can: the reviewer's actual brief is the first user record of its transcript (\`<session>/subagents/agent-<reviewer id>.jsonl\`), its \`spawns.jsonl\` row joins to the writer's by \`caller_tool_use_id\` = the writer row's \`tool_use_id\`, and the relayed verdict line should match the first line of the review file.`);
  L.push(``);
  if (selfReview.rationale) {
    L.push(`**Why:** ${selfReview.rationale}`);
    L.push(``);
  }
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
      L.push('> Staged replacement: **' + t.replacement.model + (t.replacement.effort ? '/' + t.replacement.effort : '') + '** — routing rows on `' + alias + '` switch to it only once the operator sets `tiers.' + alias + '.retired` to `true` (after confirming the alias no longer resolves); the date drives warnings only. ' + (t.replacement.note || ''));
    }
    L.push(``);
  }
}

const md = L.join('\n') + '\n';
const out = val('--out');
if (out) { writeFileSync(out, md); console.log(`wrote ${out}`); } else { process.stdout.write(md); }
