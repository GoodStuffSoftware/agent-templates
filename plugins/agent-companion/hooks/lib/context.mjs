// Shared helpers for agent-companion hooks.
//
// Design rule that outranks every feature here: A HOOK MUST NEVER BREAK A SESSION.
// Every guard fails OPEN. If we cannot parse the payload, cannot read state, or
// cannot positively confirm we are on the main thread, we allow the call. The
// cost of under-enforcing is a missed nudge; the cost of over-enforcing is a
// wedged agent. The daily calibration routine is what catches under-enforcement.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
  openSync, fstatSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Agent types observed in the shipped binary (2.1.220). The binary tests the
// main thread with `agentType === "main"`, but mainThreadAgentType is settable
// at runtime, so we treat this as an allowlist rather than a guarantee.
export const MAIN_THREAD_TYPES = new Set(['main', 'main-session']);
export const KNOWN_AGENT_TYPES = new Set([
  'main', 'main-session', 'subagent', 'teammate', 'worker',
  'workflow-subagent', 'general-purpose', 'claude', 'statusline-setup',
  'Explore', 'Plan', 'claude-code-guide',
]);

// Premium tiers. Fable is deliberately NOT banned — it is capped and audited.
// Model tiers are DATA, loaded from config/model-tiers.json and overridable at
// $CLAUDE_PLUGIN_DATA/model-tiers.json. A tier table baked into code goes stale
// the moment a lineup changes, and it goes stale SILENTLY - the guards keep
// running and simply stop classifying correctly. This work began by fixing a
// routing table that had been wrong for a whole model generation; hardcoding
// the same knowledge here would rebuild that trap one layer down.
let _tiers = null;
// Semver comparison shared by every alias-resolution-floor check: the daily
// scout's harness-version signal (scripts/detect.mjs), the spawn-time warning
// (hooks/spawn-guard.mjs), and the audit's resolved-model mismatch check
// (scripts/lib/model-mismatch.mjs). Kept in ONE place rather than three
// copies that could drift on what counts as "below".
export function parseSemver(s) {
  const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function semverBelow(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

export function modelTiers() {
  if (_tiers) return _tiers;
  const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'model-tiers.json');
  let cfg = { tiers: {}, unknownIsPremium: true };
  try { cfg = JSON.parse(readFileSync(shipped, 'utf8')); } catch { /* use defaults */ }
  // The override merges BY ALIAS, so adding one model does not require
  // restating the table - a table you must retype is one you will not update.
  // The operator override lives under the durable state root (stateRoot()) so
  // it survives a plugin uninstall same as everything else there; the legacy
  // location under dataDir() is still honoured as a fallback so an override
  // written before this version keeps working until it is migrated.
  let over = null;
  try { over = JSON.parse(readFileSync(join(stateRoot(), 'model-tiers.json'), 'utf8')); } catch { /* try legacy */ }
  if (!over) {
    try { over = JSON.parse(readFileSync(join(dataDir(), 'model-tiers.json'), 'utf8')); } catch { /* no override: expected */ }
  }
  if (over) cfg = { ...cfg, ...over, tiers: { ...(cfg.tiers || {}), ...(over.tiers || {}) } };
  _tiers = cfg;
  return _tiers;
}

// Returns { alias, rank, premium, known }. An unrecognised model reports
// known:false so callers can flag it instead of quietly bucketing it.
export function classifyModel(model) {
  const cfg = modelTiers();
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      return { alias, rank: spec.rank ?? 0, premium: !!spec.premium, known: true };
    }
  }
  // Fail toward the EXPENSIVE assumption. Treating an unknown model as cheap
  // would let a newly released top tier bypass the warrant and the cap during
  // exactly the window in which nobody has updated the table yet.
  return { alias: '', rank: 0, premium: cfg.unknownIsPremium !== false, known: false };
}

// Reference entries for OLDER, non-routable pinned model ids (config's
// `referenceModels`) — kept SEPARATE from `tiers` so they never affect
// classifyModel()'s alias matching (an "opus" tier match is deliberately
// broad and already classifies a dated opus id as premium correctly). Their
// only job is precise EFFORT validation for a definition pinned to a full id:
// e.g. Opus 4.6 and Sonnet 4.6 have no `xhigh`, which the current `opus`/
// `sonnet` tier's (wider) effort list would not catch.
export function classifyReferenceModel(model) {
  const cfg = modelTiers();
  const m = String(model || '');
  if (!m) return null;
  for (const [key, spec] of Object.entries(cfg.referenceModels || {})) {
    try {
      if (new RegExp(spec.match || key, 'i').test(m)) return { key, ...spec };
    } catch { /* bad regex in an override: skip it, fail open */ }
  }
  return null;
}

// Same shape as effortSupported(), but checked against a reference entry's
// OWN effort list when the model matches one, instead of the current alias
// tier's list. Returns null (not a result) when the model matches no
// reference entry, so a caller can fall back to effortSupported() unchanged.
export function referenceEffortSupported(model, effort) {
  const ref = classifyReferenceModel(model);
  if (!ref) return null;
  const e = String(effort || '').toLowerCase();
  const list = Array.isArray(ref.efforts) ? ref.efforts : [];
  if (!e) return { ok: true, supported: list, reason: 'no effort set' };
  if (list.length === 0) return { ok: false, supported: [], reason: `${ref.displayName || ref.key} takes no effort parameter` };
  return list.includes(e)
    ? { ok: true, supported: list, reason: '' }
    : { ok: false, supported: list, reason: `${ref.displayName || ref.key} supports ${list.join(', ')} (no ${e})` };
}

// Effort is a separate axis from model and scales ALL output - thinking,
// answer, and tool calls alike. Ranking it lets the audit compare two agents'
// effort the way it compares their tiers, which is what the reviewer-parity
// rule needs: effort may exceed the writer's, and must never fall below it.
export function classifyEffort(effort) {
  const cfg = modelTiers();
  const e = String(effort || '').toLowerCase();
  const spec = (cfg.efforts || {})[e];
  return spec ? { level: e, rank: spec.rank ?? 0, known: true }
              : { level: e, rank: 0, known: false };
}

// Weight (1-5) -> the model and effort that weight routes to. Data, so the
// routing table can be corrected without shipping code.
// A tier past its retirement date does not error — the alias resolves to
// whatever replaces it, or to nothing. The table can carry that decision in
// advance: `replacement: { model, effort }` on the tier, applied BY DATE, so
// the switch happens on the day without anyone having to remember it.
// Returns null for tiers with no retirement date.
//
// `now` (optional) pins the calendar for a caller that needs a deterministic
// answer — resolveRoute()'s golden test in particular, which must not change
// verdict the day a tier retires. Omitted, it is the real clock, as before.
export function retirement(alias, now) {
  const spec = (modelTiers().tiers || {})[alias];
  if (!spec || !spec.retiresAfter) return null;
  const at = Date.parse(spec.retiresAfter);
  if (Number.isNaN(at)) return null;
  // Calendar days: retired from the day AFTER the date, whatever the hour.
  const n = clockDate(now);
  const todayUtc = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  const daysLeft = Math.round((at - todayUtc) / 86400000);
  const replacement = spec.replacement && spec.replacement.model ? spec.replacement : null;
  return { alias, retiresAfter: spec.retiresAfter, daysLeft, retired: daysLeft < 0, replacement };
}

// A Date for `now` (Date, ISO string or epoch ms); the real clock when absent
// or unparseable, so a bad value degrades to today's behaviour, never a throw.
function clockDate(now) {
  if (now === undefined || now === null) return new Date();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function routeForWeight(weight, now) {
  const cfg = modelTiers();
  const route = (cfg.routing || {})[String(weight)] || null;
  if (!route) return null;
  const r = retirement(route.model, now);
  if (r && r.retired && r.replacement) {
    // The row still names the retired alias; resolve it to the staged
    // replacement and say so, so a rationale never claims a model that is gone.
    const { effortNote, ...rest } = route;
    return { ...rest, model: r.replacement.model, effort: r.replacement.effort ?? '', retiredFrom: route.model };
  }
  return route;
}

// An entry may be classified but not reachable on this account — flagged
// `available: false`, or past its retirement date. Pinning an agent to one
// fails at spawn time with nothing having warned beforehand.
export function isModelAvailable(model, now) {
  const cfg = modelTiers();
  const m = String(model || '');
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      if (spec.available === false) return false;
      const r = retirement(alias, now);
      return !(r && r.retired);
    }
  }
  return true; // unknown models are flagged elsewhere, not blocked here
}
// Effort availability is PER MODEL, not global. xhigh only exists from the
// 4.7 generation onward, and haiku takes no effort parameter at all - so a
// haiku agent carrying `effort: low` is not asking for less thinking, it is
// setting a parameter the model does not accept. Returns:
//   { ok, supported[], reason }
export function effortSupported(model, effort) {
  const cfg = modelTiers();
  const m = String(model || '');
  const e = String(effort || '').toLowerCase();
  if (!e) return { ok: true, supported: [], reason: 'no effort set' };
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (m && new RegExp(spec.match || alias, 'i').test(m)) {
      const list = Array.isArray(spec.efforts) ? spec.efforts : null;
      if (!list) return { ok: true, supported: [], reason: 'tier declares no effort set' };
      if (list.length === 0) {
        return { ok: false, supported: [], reason: `${alias} takes no effort parameter` };
      }
      return list.includes(e)
        ? { ok: true, supported: list, reason: '' }
        : { ok: false, supported: list, reason: `${alias} supports ${list.join(', ')}` };
    }
  }
  return { ok: true, supported: [], reason: 'unknown model' };
}
// Decide the effort, rather than leaving it to taste.
//
// Weight picks the MODEL - how much capability the task needs. Kind adjusts
// the EFFORT - how much the answer benefits from search. They are genuinely
// orthogonal: a routing table and a message bus can touch the same number of
// files and deserve completely different amounts of thinking, because one has
// a single right shape and the other has an answer space to explore.
//
// Returns { model, effort, rationale } and clamps to what the model accepts,
// so a haiku route comes back with no effort at all rather than a parameter
// that model does not take. Pass `floors: []` to have each consequence floor
// that raised the answer pushed onto it ({ floor, raised, within: 'grid' }) —
// resolveRoute() reports them, so explain never says "none fired" about an
// answer a floor lifted inside the grid.
function tierRank(alias) {
  const cfg = modelTiers();
  return (cfg.tiers || {})[alias]?.rank ?? 0;
}

export function effortFor(weight, kind = 'bounded', consequence = 'routine', { now, floors = null } = {}) {
  const cfg = modelTiers();
  // routeForWeight, not the raw row: it applies a staged retirement replacement
  // by date, so a weight that routes to a retired alias resolves to its
  // successor here without anyone editing the routing rows on the day.
  const route = routeForWeight(weight, now);
  if (!route) return { model: '', effort: '', rationale: `no routing row for weight ${weight}` };

  // Resolve the consequence MODEL floor before anything else. It used to be
  // applied last, after the effort computation — and a tier with no effort
  // parameter (haiku) returned early from that computation, skipping the floor
  // entirely. So a one-line production migration at weight 2 came back as
  // haiku. That is the exact case the consequence axis exists for.
  const cons = (cfg.consequence || {})[consequence] || {};
  const modelFloored = !!(cons.modelFloor && tierRank(cons.modelFloor) > tierRank(route.model));
  const model = modelFloored ? cons.modelFloor : route.model;
  const lifted = modelFloored ? `; ${consequence} consequence raises the model to ${model}` : '';
  const floorLabel = FLOOR_FOR_CONSEQUENCE[consequence] || `consequence:${consequence}`;
  if (modelFloored && floors) floors.push({ floor: floorLabel, raised: `model ${route.model} -> ${model}`, within: 'grid' });
  const routeLabel = `${route.model}${route.effort ? '/' + route.effort : ''}` +
    (route.retiredFrom ? ` (standing in for retired ${route.retiredFrom})` : '');

  const tier = (cfg.tiers || {})[model] || {};
  const supported = Array.isArray(tier.efforts) ? tier.efforts : [];
  if (supported.length === 0) {
    return {
      model,
      effort: '',
      rationale: `weight ${weight} routes to ${routeLabel}${lifted}; ${model} takes no effort parameter`,
    };
  }

  const delta = (cfg.taskKinds || {})[kind]?.effortDelta ?? 0;
  const ranked = Object.entries(cfg.efforts || {})
    .sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0))
    .map(([name]) => name)
    .filter((name) => supported.includes(name));

  // A floored model has no base effort from the route — the route's effort was
  // for a different tier — so start from the bottom and let the floors lift it.
  const baseIdx = modelFloored ? 0 : Math.max(0, ranked.indexOf(route.effort));
  // Clamp rather than error: a kind that pushes past the top means 'as much as
  // this model has', which is a real answer, not a failed lookup.
  const idx = Math.min(ranked.length - 1, Math.max(0, baseIdx + delta));

  // Consequence EFFORT floor, applied after the kind delta so it cannot be
  // undercut. Difficulty and consequence are close to orthogonal: without this
  // the -1 for mechanical work would reduce thinking on exactly the change
  // least able to absorb a mistake.
  let finalIdx = idx;
  if (cons.effortFloor) {
    const floorIdx = ranked.indexOf(cons.effortFloor);
    if (floorIdx > finalIdx) finalIdx = floorIdx;
  }
  const effortFinal = ranked[finalIdx];
  if (finalIdx > idx && floors) floors.push({ floor: floorLabel, raised: `effort ${ranked[idx]} -> ${effortFinal}`, within: 'grid' });

  const moved = idx - baseIdx;
  const why = moved === 0
    ? `${kind} work needs no adjustment`
    : `${kind} work shifts effort ${moved > 0 ? 'up' : 'down'} ${Math.abs(moved)}`;
  const floored = finalIdx > idx ? `; ${consequence} consequence raises the floor to ${effortFinal}` : '';
  return {
    model,
    effort: effortFinal,
    rationale: `weight ${weight} routes to ${routeLabel}${lifted}; ${why}${floored} -> ${model}/${effortFinal}`,
  };
}
// ---------------------------------------------------------------------------
// resolveRoute() — THE routing resolver (docs/adr/0003-per-user-routing-
// profiles.md §1-§2). Every reader of "what does this task route to" goes
// through it: scripts/recommend.mjs, scripts/evaluate.mjs,
// hooks/spawn-guard.mjs, scripts/routing-table.mjs and scripts/detect.mjs.
// NOTHING ELSE reads `taskTypes.<type>.override` (tests/route-readers.test.mjs
// greps the plugin source and fails on any other reader), so a trial is
// honoured, floored and explained identically wherever the table is consulted.
//
// Layer stack, highest first, for a TYPE resolved as-is:
//   1. profile — a per-user routing-profile row. A SEAM ONLY in this release:
//      profileLayer() yields nothing and profileRevision is always null. The
//      profile file, its validation and the routing_profile kill switch
//      arrive in a later slice without any caller changing.
//   2. trial   — the shipped ROUTING TRIAL (`taskTypes.<type>.override`).
//   3. grid    — effortFor(weight, kind, consequence), or reviewer parity for
//      a parity-sized type when a writer is supplied.
// An explicit weight/kind/consequence that DEPARTS from the named type's
// preset answers a different question, so it skips layers 1-2 and goes
// straight to the grid (taskTypesNote). One that EQUALS the preset is not a
// departure: it restates the type and keeps layers 1-2 (listed in
// matchesPreset).
//
// Floors, applied AFTER whichever layer won (ADR §1 table). Before this, a
// trial override returned before effortFor() ran, so no consequence floor
// ever applied to it:
//   F1  critical consequence: model >= the consequence's modelFloor (opus),
//       effort >= its effortFloor (xhigh). Inviolable.
//   F2  fable — and any premium tier ranked at or above fable — is never a
//       destination: a layer-1/2 candidate naming one is skipped. Inviolable.
//   F3  reviewer parity: the model matches the writer; effort may exceed the
//       writer's but not drop below it. Inviolable.
//   F4  availability: a layer-1/2 candidate's alias must be available (not
//       retired) and must accept the named effort, or it is skipped. The
//       build half of F4 (aliasResolution.minClaudeCodeVersion) needs the
//       CALLING session's build, which only the spawn guard can read, so it
//       stays there (SPAWNING RULE 2).
//   F5  elevated consequence effort floor (high). Soft in the ADR: only a
//       future operator-observed profile row may waive it, so there is no
//       waiver path here yet.
// Every raise is recorded in floorsApplied — including the ones effortFor()
// makes inside the grid when the grid wins (marked `within: 'grid'`); every
// candidate that could not run as written is recorded in skipped.
//
// KNOWN GAP, deliberately preserved (slice 1 changes no behaviour): the
// parity path (code-review with a writer) applies F3 only. It never applied
// the consequence floors — a critical code-review has always been sized to
// its writer — and applying F1 there would change routing. Flagged for a
// later slice rather than changed silently.
//
// `now` pins the calendar (Date, ISO string or epoch ms) for the tier
// retirement date; omitted, it is the real clock.
//
// Returns (ADR §2 shape, plus what the callers need):
//   { model, effort, cacheTtl, layer, profileRevision, source, state,
//     provenance, floorsApplied, skipped, stale, rationale,
//     type, typeKnown, weight, kind, consequence, departures, matchesPreset,
//     stack, trial }
// `model` is '' (and layer null) when no route could be resolved: weight
// missing, non-numeric, outside 1-5 or naming no routing row (2.5), or a
// parity type with no writer.
// `trial` is the old resolveExpected() trial metadata — non-null exactly when
// the trial layer won.

// Layer 1: the per-user routing profile. Seam only — see the banner above.
function profileLayer(/* { type, now } */) {
  return { row: null, revision: null, note: 'no routing profile in this release' };
}

function routeLabelOf(model, effort) {
  return `${model}${effort ? '/' + effort : ''}`;
}

// F2's set: fable, plus any premium tier ranked at or above it.
function neverDestination(model) {
  const cfg = modelTiers();
  const c = classifyModel(model);
  if (!c.known) return false;
  if (c.alias === 'fable') return true;
  const fableRank = (cfg.tiers || {}).fable?.rank;
  return typeof fableRank === 'number' && c.premium && c.rank >= fableRank;
}

// F2 + F4 for a layer-1/2 candidate: the reason it cannot run as written,
// or '' when it can.
function candidateRefusal(model, effort, now) {
  if (!model) return 'names no model';
  if (neverDestination(model)) return `F2: ${model} is never a routing destination (it needs a warrant)`;
  if (!isModelAvailable(model, now)) return `F4: ${model} is unavailable or retired`;
  const sup = effortSupported(model, effort);
  if (!sup.ok) return `F4: effort '${effort}' unsupported by ${model} (${sup.reason})`;
  return '';
}

function rankedEffortsFor(model) {
  const cfg = modelTiers();
  const alias = classifyModel(model).alias || model;
  const supported = Array.isArray((cfg.tiers || {})[alias]?.efforts) ? cfg.tiers[alias].efforts : [];
  return Object.entries(cfg.efforts || {})
    .sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0))
    .map(([name]) => name)
    .filter((name) => supported.includes(name));
}

// Raise `effort` to at least `floor`, within what `model` accepts. A model
// that takes no effort parameter (haiku) is left at '' — asking it for more
// thinking sets a parameter it does not take (the same clamp effortFor()
// applies), so no floor can be expressed there.
function raiseEffort(model, effort, floor) {
  const ranked = rankedEffortsFor(model);
  if (!ranked.length || !floor) return effort;
  const floorIdx = ranked.indexOf(floor);
  if (floorIdx < 0) return effort;
  const cur = effort ? ranked.indexOf(effort) : -1;
  return cur >= floorIdx ? effort : ranked[floorIdx];
}

const FLOOR_FOR_CONSEQUENCE = { critical: 'F1', elevated: 'F5' };

function applyFloors(r, { consequence, parity, writer }) {
  const cfg = modelTiers();
  const floorsApplied = [];
  let { model, effort } = r;

  if (parity) {
    // F3 only (see KNOWN GAP in the banner).
    const wm = writer.model;
    const we = writer.effort || '';
    if (model !== wm) {
      floorsApplied.push({ floor: 'F3', raised: `model ${model} -> ${wm} (must match the writer)` });
      model = wm;
    }
    if (we && classifyEffort(we).known) {
      const cur = classifyEffort(effort);
      if (!effort || (cur.known && cur.rank < classifyEffort(we).rank)) {
        floorsApplied.push({ floor: 'F3', raised: `effort ${effort || '(none)'} -> ${we} (may not drop below the writer)` });
        effort = we;
      }
    }
    return { model, effort, floorsApplied };
  }

  // F2 on the final answer. Layers 1-2 were already filtered; this only fires
  // if a grid row itself named a never-destination tier, which the shipped
  // table never does ("nothing routes to fable"). Cap to the highest-ranked
  // available tier that is not one.
  if (neverDestination(model)) {
    const best = Object.entries(cfg.tiers || {})
      .filter(([alias, spec]) => spec.available !== false && !neverDestination(alias))
      .sort((a, b) => (b[1].rank ?? 0) - (a[1].rank ?? 0))[0];
    if (best) {
      floorsApplied.push({ floor: 'F2', capped: `model ${model} -> ${best[0]} (never a routing destination)` });
      model = best[0];
      const ranked = rankedEffortsFor(model);
      if (!ranked.length) effort = '';
      else if (!ranked.includes(effort)) effort = ranked[0];
    }
  }

  // F1 / F5: the resolved consequence's model and effort floors.
  const cons = (cfg.consequence || {})[consequence] || {};
  const label = FLOOR_FOR_CONSEQUENCE[consequence] || `consequence:${consequence}`;
  if (cons.modelFloor && tierRank(cons.modelFloor) > tierRank(classifyModel(model).alias || model)) {
    floorsApplied.push({ floor: label, raised: `model ${model} -> ${cons.modelFloor}` });
    model = cons.modelFloor;
    const ranked = rankedEffortsFor(model);
    if (!ranked.length) effort = '';
    else if (!ranked.includes(effort)) effort = ranked[0];
  }
  if (cons.effortFloor) {
    const raised = raiseEffort(model, effort, cons.effortFloor);
    if (raised !== effort) {
      floorsApplied.push({ floor: label, raised: `effort ${effort || '(none)'} -> ${raised}` });
      effort = raised;
    }
  }
  return { model, effort, floorsApplied };
}

export function resolveRoute({
  type = null, weight, kind, consequence,
  weightExplicit = false, kindExplicit = false, consequenceExplicit = false,
  writer = null, now,
} = {}) {
  const cfg = modelTiers();
  const t = type ? (cfg.taskTypes || {})[type] : null;
  const typeKnown = !!(t && typeof t === 'object');
  const w = weightExplicit ? weight : (t ? t.weight : weight);
  const k = kindExplicit ? (kind || 'bounded') : (kind || t?.kind || 'bounded');
  let c = consequenceExplicit ? (consequence || 'routine') : (consequence || t?.consequence || 'routine');
  if (c === 'inherit') c = 'routine';

  // A DEPARTURE is an explicit value that differs from the named type's own
  // preset (ADR 0003 §1). An explicit value EQUAL to the preset restates the
  // type rather than asking a different question, so it keeps layers 1-2 —
  // "TYPE: integration" + "WEIGHT: 4" is still the integration type. With no
  // known type there is no preset to depart from and no layer 1-2 to keep.
  const normCons = (v) => (v === 'inherit' ? 'routine' : v);
  const departures = [];
  const matchesPreset = [];
  const note = (field, explicit, equal) => { if (explicit) (equal ? matchesPreset : departures).push(field); };
  note('weight', weightExplicit, typeKnown && weight === t.weight);
  note('kind', kindExplicit, typeKnown && (kind || 'bounded') === (t.kind || 'bounded'));
  note('consequence', consequenceExplicit, typeKnown && normCons(consequence || 'routine') === normCons(t.consequence || 'routine'));
  const asIs = departures.length === 0;
  const departNote = `explicit ${departures.join('/')} departs from the ${type} preset`;

  const prof = profileLayer({ type, now });
  const ov = t?.override || null;
  const parity = w === 'parity';

  // The grid's own answer — computed whenever there is a numeric weight, so
  // explain can show what the grid would have said even when a higher layer
  // won.
  const validWeight = typeof w === 'number' && w >= 1 && w <= 5;
  const gridFloors = [];
  const grid = validWeight ? effortFor(w, k, c, { now, floors: gridFloors }) : null;
  const gridLabel = grid ? routeLabelOf(grid.model, grid.effort) : '';

  const skipped = [];
  const stack = [
    { layer: 'profile', present: !!prof.row, candidate: null, status: 'absent', note: prof.note },
    {
      layer: 'trial',
      present: !!ov,
      candidate: ov ? { model: ov.model, effort: ov.effort || '' } : null,
      meta: ov ? {
        trialSince: ov.trialSince ?? null,
        reviewBy: ov.reviewBy ?? null,
        trialVersion: ov.trialVersion ?? null,
        overridesKindDelta: !!ov.overridesKindDelta,
        evidence: ov.evidence || null,
        reason: ov.reason || '',
      } : null,
      status: ov ? 'not-reached' : 'absent',
    },
    {
      layer: 'grid',
      present: !!grid || (parity && !!writer),
      candidate: grid ? { model: grid.model, effort: grid.effort } : (parity && writer ? { model: writer.model, effort: writer.effort || '' } : null),
      status: 'not-reached',
    },
  ];
  const [, trialEntry, gridEntry] = stack;

  const base = {
    cacheTtl: null,
    profileRevision: prof.revision,
    stale: [],
    type: type || null,
    typeKnown,
    weight: w,
    kind: k,
    consequence: c,
    departures,
    matchesPreset,
    stack,
  };

  // --- Parity-sized types (code-review): sized to the writer ---------------
  if (parity) {
    if (ov && !asIs) {
      trialEntry.status = 'skipped';
      skipped.push({ layer: 'trial', reason: departNote });
    } else if (ov) {
      // A parity type's layer-1/2 row may only set a minimum effort (F3); no
      // shipped trial does. Kept visible rather than silently ignored.
      trialEntry.status = 'skipped';
      skipped.push({ layer: 'trial', reason: 'F3: a parity-sized type is sized to its writer; a trial cannot name its model' });
    }
    if (!writer) {
      gridEntry.status = 'unresolved';
      return {
        ...base, model: '', effort: '', layer: null, source: null, state: null, provenance: null,
        floorsApplied: [], skipped,
        rationale: `no routing row for weight ${JSON.stringify(w)}`,
        trial: null,
      };
    }
    const floored = applyFloors({ model: writer.model, effort: writer.effort || '' }, { consequence: c, parity: true, writer });
    gridEntry.status = 'won';
    return {
      ...base,
      model: floored.model, effort: floored.effort,
      layer: 'grid', source: 'reviewer-parity', state: null,
      provenance: { rule: 'reviewerParity', writer: routeLabelOf(writer.model, writer.effort || '') },
      floorsApplied: floored.floorsApplied, skipped,
      rationale: `reviewer parity: model matches the writer (${writer.model})` + (writer.effort ? `; effort at least ${writer.effort}` : ''),
      trial: null,
    };
  }

  if (!validWeight) {
    if (ov) { trialEntry.status = 'unresolved'; }
    gridEntry.status = 'unresolved';
    return {
      ...base, model: '', effort: '', layer: null, source: null, state: null, provenance: null,
      floorsApplied: [], skipped,
      rationale: `no routing row for weight ${JSON.stringify(w ?? null)}`,
      trial: null,
    };
  }

  // --- Pick the winning layer ---------------------------------------------
  let won = null;
  if (ov) {
    if (!asIs) {
      trialEntry.status = 'skipped';
      skipped.push({ layer: 'trial', reason: departNote });
    } else {
      const refusal = candidateRefusal(ov.model, ov.effort || '', now);
      if (refusal) {
        trialEntry.status = 'skipped';
        skipped.push({ layer: 'trial', reason: refusal });
      } else {
        trialEntry.status = 'won';
        won = {
          layer: 'trial',
          model: ov.model,
          effort: ov.effort || '',
          source: 'shipped-trial',
          state: 'trial',
          provenance: trialEntry.meta,
          rationale: `ROUTING TRIAL (since ${ov.trialSince}, review by ${ov.reviewBy}): ${ov.reason} Grid would otherwise resolve to ${gridLabel}.`,
          trial: {
            trialSince: ov.trialSince,
            reviewBy: ov.reviewBy,
            evidence: ov.evidence || null,
            overridesKindDelta: !!ov.overridesKindDelta,
            gridResolution: gridLabel,
          },
        };
      }
    }
  }
  if (!won && !grid.model) {
    // A weight inside 1-5 that names no routing row (a fractional weight, or
    // a row missing from an edited table): the grid has no answer, so there
    // is no route — layer null, never a grid "winner" with an empty model.
    gridEntry.status = 'unresolved';
    gridEntry.candidate = null;
    return {
      ...base, model: '', effort: '', layer: null, source: null, state: null, provenance: null,
      floorsApplied: [], skipped,
      rationale: grid.rationale,
      trial: null,
    };
  }
  if (!won) {
    gridEntry.status = 'won';
    won = {
      layer: 'grid',
      model: grid.model,
      effort: grid.effort,
      source: 'shipped-grid',
      state: null,
      provenance: { rule: 'effortFor', weight: w, kind: k, consequence: c, tableVersion: cfg.version ?? null, tableUpdated: cfg.updated ?? null },
      rationale: grid.rationale,
      trial: null,
    };
  } else {
    gridEntry.status = 'shadowed';
  }

  // --- Floors, after whichever layer won -----------------------------------
  const floored = won.model
    ? applyFloors({ model: won.model, effort: won.effort }, { consequence: c, parity: false })
    : { model: won.model, effort: won.effort, floorsApplied: [] };
  const floorNote = floored.floorsApplied.length
    ? `; floors: ${floored.floorsApplied.map((f) => `${f.floor} ${f.raised || f.capped}`).join(', ')} -> ${routeLabelOf(floored.model, floored.effort)}`
    : '';

  return {
    ...base,
    model: floored.model,
    effort: floored.effort,
    layer: won.layer,
    source: won.source,
    state: won.state,
    provenance: won.provenance,
    // The grid's own raises come first: they are part of the grid's answer
    // (and already in its rationale), then any lift of the winning layer.
    floorsApplied: [...(won.layer === 'grid' ? gridFloors : []), ...floored.floorsApplied],
    skipped,
    rationale: won.rationale + floorNote,
    trial: won.trial,
  };
}

// The pre-ADR-0003 shape, kept EXACTLY — { model, effort, rationale, weight,
// kind, consequence, trial } — for any caller (or external script) still on
// resolveExpected(). A thin wrapper: all resolution happens in resolveRoute().
export function expectedFromRoute(r) {
  return {
    model: r.model,
    effort: r.effort,
    rationale: r.rationale,
    weight: r.weight,
    kind: r.kind,
    consequence: r.consequence,
    trial: r.trial,
  };
}

// Resolve a task's expected (model, effort). Kept for compatibility; see
// resolveRoute() for the rules. Does NOT handle weight:"parity" (reviewer
// sizing) — pass a writer to resolveRoute() for that.
export function resolveExpected({
  type = null, weight, kind, consequence,
  weightExplicit = false, kindExplicit = false, consequenceExplicit = false,
  now,
} = {}) {
  return expectedFromRoute(resolveRoute({
    type, weight, kind, consequence, weightExplicit, kindExplicit, consequenceExplicit, now,
  }));
}

// One line naming where the winning answer came from, for explain output.
export function routeProvenanceLine(r) {
  if (!r || !r.layer) return 'no route resolved';
  const p = r.provenance || {};
  if (r.layer === 'trial') {
    const ev = p.evidence ? `; evidence: ${p.evidence.source || 'unstated'}${p.evidence.date ? ' (' + p.evidence.date + ')' : ''}` : '';
    return `shipped trial${p.trialVersion ? ' v' + p.trialVersion : ''}, since ${p.trialSince || '?'}, review by ${p.reviewBy || '?'}` +
      `${p.overridesKindDelta ? ', overrides the kind delta' : ''}${ev}`;
  }
  if (r.source === 'reviewer-parity') return `reviewer parity with writer ${p.writer}`;
  return `shipped grid: weight ${p.weight} x ${p.kind} x ${p.consequence} (config v${p.tableVersion ?? '?'}, updated ${p.tableUpdated ?? '?'})`;
}

// The full layer stack as printable lines (recommend --explain).
export function explainRoute(r) {
  const L = [];
  L.push('layer stack (highest first):');
  for (const s of r.stack || []) {
    const cand = s.candidate ? routeLabelOf(s.candidate.model, s.candidate.effort) : '-';
    const why = s.layer === 'profile'
      ? s.note
      : (r.skipped || []).filter((x) => x.layer === s.layer).map((x) => x.reason).join('; ');
    L.push(`  ${s.layer.padEnd(8)} ${s.status.padEnd(12)} ${cand}${why ? '  (' + why + ')' : ''}`);
  }
  if (r.layer) {
    const why = r.layer === 'trial'
      ? `the type was resolved as-is${(r.matchesPreset || []).length ? ` (explicit ${r.matchesPreset.join('/')} equals the preset)` : ''} and its shipped trial passed F2/F4`
      : r.source === 'reviewer-parity'
        ? 'a parity-sized type is sized to its writer'
        : ((r.departures || []).length
          ? `explicit ${r.departures.join('/')} skips layers 1-2`
          : (r.skipped || []).length ? 'every higher layer was skipped' : 'no higher layer has an entry for this task');
    L.push(`winner:   ${r.layer} -> ${routeLabelOf(r.model, r.effort)} (${why})`);
  } else {
    L.push(`winner:   none — no route (${r.rationale})`);
  }
  L.push(`floors:   ${(r.floorsApplied || []).length ? r.floorsApplied.map((f) => `${f.floor} ${f.raised || f.capped}${f.within ? ` (within the ${f.within})` : ''}`).join('; ') : 'none fired'}`);
  L.push(`profile:  revision ${r.profileRevision ?? 'none'}`);
  L.push(`provenance: ${routeProvenanceLine(r)}`);
  return L;
}

// Find the ladder rung matching a resolved (model, effort) pair — the
// ordered, cheapest-to-dearest view of the same routing grid, each mapped to
// a spawnable generic worker definition (see config/model-tiers.json's
// `ladder`/`ladderNote`). Effort '' / null both mean "this model takes none"
// and match a rung whose own effort is null (haiku). Returns null when
// nothing in the ladder matches — fable, an unknown model, or a model/effort
// combination the ladder does not carry a rung for.
export function rungFor(model, effort) {
  const cfg = modelTiers();
  const ladder = Array.isArray(cfg.ladder) ? cfg.ladder : [];
  const alias = classifyModel(model).alias || String(model || '');
  const e = effort ? String(effort).toLowerCase() : null;
  return ladder.find((r) => r.model === alias && (r.effort || null) === e) || null;
}

export function readStdin() {
  try {
    let raw = readFileSync(0, 'utf8') || '';
    // PowerShell prepends a UTF-8 BOM to piped stdin on Windows. Without this
    // strip, JSON.parse throws, the caller's fail-open catch swallows it, and
    // the hook silently does nothing — indistinguishable from "no issues
    // found". Documented in the library as powershell-pipe-bom-breaks-json.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    raw = raw.trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Durable-state resolvers. THIS is the only place in the plugin that computes
// any of these paths — every hook and script goes through these functions.
// Everything here is computed AT CALL TIME (nothing cached at module load), so
// a test can set the override env vars per-test and get an isolated tree.
//
// A plugin uninstall deletes the ENTIRE plugin data directory
// (~/.claude/plugins/data/agent-companion-<marketplace>/) — that is where
// CLAUDE_PLUGIN_DATA points, and it is not this plugin's to keep safe. Durable
// telemetry and state therefore live under a SEPARATE root
// (~/.claude/agent-companion/, "state root") that no uninstall path touches.
// dataDir()/dataDirs() below keep their old meaning — the plugin data
// directory — and are used only for disposable, regenerable caches now.
export function homeRoot() {
  return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();
}
export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homeRoot(), '.claude');
}
export function pluginDataRoot() {
  return join(claudeDir(), 'plugins', 'data');
}

const STATE_ROOT_README = [
  'agent-companion durable state.',
  '',
  'This holds the plugin\'s durable telemetry (telemetry/) and small mutable',
  'state (state/) — plus USER-AUTHORED configuration (config/) — kept',
  'OUTSIDE the plugin data directory so a plugin uninstall never deletes it.',
  '',
  'telemetry/ and state/ are derived: safe to delete to reset all history,',
  'and the plugin recreates them on next use. config/ is NOT derived — it',
  'holds choices you made (brevity toggles, standing rules), so deleting it',
  'reverts them to defaults.',
].join('\n') + '\n';

export function stateRoot() {
  const d = process.env.AGENT_COMPANION_STATE_DIR || join(claudeDir(), 'agent-companion');
  try {
    mkdirSync(d, { recursive: true });
    const readme = join(d, 'README.txt');
    if (!existsSync(readme)) {
      try { writeFileSync(readme, STATE_ROOT_README, { flag: 'wx' }); } catch { /* race or unwritable: fine */ }
    }
  } catch { /* fail open: the caller's own read/write also fails open */ }
  return d;
}

export function telemetryDir() {
  const d = join(stateRoot(), 'telemetry');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

export function stateDir() {
  const d = join(stateRoot(), 'state');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// USER-AUTHORED configuration — the one directory under the state root whose
// contents a person chose rather than the plugin derived. Kept separate from
// state/ precisely so the "safe to delete to reset history" advice that
// applies to telemetry/ and state/ does not quietly also throw away the
// operator's brevity toggles and standing rules.
export function configDir() {
  const d = join(stateRoot(), 'config');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// Inside a hook the harness sets CLAUDE_PLUGIN_DATA and this is exact. The
// fallback matters for READERS — the audit, the doctor, the scout — which run
// outside a hook. It previously guessed `data/agent-companion`, but the real
// convention is `data/<plugin>-<marketplace>`, so every reader was scanning a
// directory that did not exist and reporting a clean bill of health against
// nothing at all. A silent wrong answer, which is the failure this plugin is
// supposed to catch, not commit.
//
// USED ONLY FOR DISPOSABLE CACHES NOW (memory-index*.json, refactor-prompt.md,
// transcript-harvest/, the legacy model-tiers.json override location). Durable
// telemetry and state live under stateRoot() instead — see above.
export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || preferredDataDir()
    || join(pluginDataRoot(), 'agent-companion-agent-templates');
  try { mkdirSync(d, { recursive: true }); } catch { /* fail open */ }
  return d;
}

// Outside a hook there is no CLAUDE_PLUGIN_DATA, and "first directory
// alphabetically" is the wrong guess: a stray bare `agent-companion/` sorts
// ahead of the `agent-companion-<marketplace>/` the hooks actually write to,
// and a script that lands there reports zero spawns with a straight face.
// Prefer the directory the hooks have most recently written telemetry into.
function preferredDataDir() {
  const dirs = dataDirs();
  if (dirs.length === 0) return null;
  let best = null;
  let bestAt = -1;
  for (const d of dirs) {
    try {
      const at = statSync(join(d, 'spawns.jsonl')).mtimeMs;
      if (at > bestAt) { best = d; bestAt = at; }
    } catch { /* no telemetry here */ }
  }
  if (best) return best;
  // No telemetry anywhere yet: prefer a marketplace-shaped dir over bare/inline.
  return dirs.find((d) => /agent-companion-(?!inline$)/.test(d)) || dirs[0];
}

// The same plugin can accumulate SEVERAL data directories — one per marketplace
// it was loaded from, plus `-inline` for a dev/--plugin-dir load. This is now
// also the source list the one-time/incremental import (state-sync.mjs) reads
// from to recover durable history that predates this version. Readers of
// disposable caches should still aggregate across all of them.
export function dataDirs() {
  const root = pluginDataRoot();
  try {
    return readdirSync(root)
      .filter((d) => d === 'agent-companion' || d.startsWith('agent-companion-'))
      .map((d) => join(root, d))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
}

// OPTIONS. Two sources, and the gap between them is the whole reason this is
// more than one line.
//
// Inside a HOOK, userConfig keys surface as CLAUDE_PLUGIN_OPTION_<KEY> env
// vars, and Claude Code uppercases <KEY> (e.g. `webhook_url` ->
// CLAUDE_PLUGIN_OPTION_WEBHOOK_URL). process.env property lookup is
// case-insensitive on Windows but case-sensitive on Linux/macOS, so a
// lowercase-only lookup here would work on Windows and silently fall back to
// the default everywhere else. Try the uppercased name first, then the
// verbatim key, so this is correct regardless of which case the harness used.
//
// OUTSIDE a hook the harness exports none of them. Every CLI entry point —
// the audit, the doctor, memory-search, memory-vault, the scheduled sync —
// therefore resolved EVERY option to its shipped default, including options
// the operator had explicitly switched on in settings.json. Nothing threw and
// nothing logged: a default-OFF feature simply never ran, which is exactly the
// silent wrong answer this plugin exists to catch. The memory-vault-drift
// check was blinded by its own copy of the bug — it re-read
// opt('memory_vault', false), skipped, and so could not report the drift it
// was written to find. So the environment is the FIRST source, not the only
// one, and the operator's settings.json is the fallback behind it.
//
// Resolution order, highest first:
//   1. CLAUDE_PLUGIN_OPTION_<KEY> (uppercased), then ..._<key> (verbatim)
//   2. pluginConfigs["<plugin>@<marketplace>"].options[<key>] in
//      settings.local.json, then settings.json, under claudeDir()
//   3. the caller's `fallback`
// The env var deliberately still wins: it is the authoritative hook-context
// signal, and callers set it to steer a single invocation.
//
// NOTHING BELOW MAY THROW. A missing file, an unreadable one, malformed JSON,
// a missing key and a permission error all resolve to the caller's fallback,
// because a hook that throws breaks the operator's tool call.
const SETTINGS_FILES = ['settings.local.json', 'settings.json'];

// The plugin root is derived from the copy of this file that is actually
// executing, so it is right for an installed plugin, a --plugin-dir load and
// a source checkout alike. It never changes within a process.
let _pluginRoot = null;
function pluginRootDir() {
  if (!_pluginRoot) _pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return _pluginRoot;
}

// Read the plugin's own name from the manifest beside this code rather than
// hardcoding it, so a rename cannot desynchronise the settings lookup from the
// key Claude Code writes.
let _pluginName = null;
function pluginName() {
  if (_pluginName) return _pluginName;
  let name = 'agent-companion';
  try {
    const m = JSON.parse(readFileSync(join(pluginRootDir(), '.claude-plugin', 'plugin.json'), 'utf8'));
    if (typeof m?.name === 'string' && m.name.trim()) name = m.name.trim();
  } catch { /* this file lives inside the plugin: the shipped name is right */ }
  _pluginName = name;
  return name;
}

// Which marketplace THIS copy was loaded from. A TIE-BREAKER only — it is used
// to order candidate pluginConfigs keys, never to require a match, so a wrong
// guess costs nothing when only one config exists. A source checkout carries
// the marketplace manifest somewhere above the plugin; an installed plugin
// sits at <cache>/<marketplace>/<plugin>/<version>/ with no manifest above it.
let _marketplace = null;
function currentMarketplace() {
  if (_marketplace !== null) return _marketplace;
  _marketplace = '';
  const root = pluginRootDir();
  try {
    let d = root;
    for (let i = 0; i < 6; i += 1) {
      const mf = join(d, '.claude-plugin', 'marketplace.json');
      if (existsSync(mf)) {
        const n = JSON.parse(readFileSync(mf, 'utf8'))?.name;
        if (typeof n === 'string' && n.trim()) { _marketplace = n.trim(); return _marketplace; }
      }
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  } catch { /* fall through to the path-shape guess */ }
  try { _marketplace = basename(dirname(dirname(root))) || ''; } catch { _marketplace = ''; }
  return _marketplace;
}

// Parsed settings, cached per file and invalidated by the file's own stat.
// spawn-guard.mjs calls opt() ~20 times on every Agent tool call, so reading
// and parsing settings.json once per call is not an option on that hot path.
// Keying the cache on (mtimeMs, size) rather than on "have we read this once"
// means it cannot serve a value that disagrees with what is on disk — any
// edit re-parses on the next call — and it keeps the per-test isolation the
// rest of this file relies on, where every resolver recomputes at call time.
const _settingsCache = new Map(); // path -> { mtimeMs, size, parsed }
function readSettings(file) {
  let st = null;
  try { st = statSync(file); } catch { return null; } // absent: the common case
  const hit = _settingsCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  let parsed = null;
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj;
  } catch { /* unreadable or malformed: indistinguishable from absent, on purpose */ }
  _settingsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

// pluginConfigs keys are marketplace-qualified ("<plugin>@<marketplace>") and
// the qualifier is NOT fixed — the same plugin loaded from another marketplace
// gets another key, and an unqualified "<plugin>" is possible too. So match on
// the plugin part and order the candidates deterministically: the marketplace
// this copy came from first, then the rest by name. Only a config that
// actually DEFINES the key counts, so a second, emptier config for the same
// plugin can never shadow the one the operator filled in.
function optionFromSettings(key) {
  const name = pluginName();
  const preferred = `${name}@${currentMarketplace()}`;
  for (const file of SETTINGS_FILES) {
    const configs = readSettings(join(claudeDir(), file))?.pluginConfigs;
    if (!configs || typeof configs !== 'object') continue;
    const matches = Object.keys(configs)
      .filter((k) => k === name || k.startsWith(`${name}@`))
      .sort((a, b) => {
        if (a === b) return 0;
        if (a === preferred) return -1;
        if (b === preferred) return 1;
        return a < b ? -1 : 1;
      });
    for (const k of matches) {
      const options = configs[k]?.options;
      if (options && typeof options === 'object'
        && Object.prototype.hasOwnProperty.call(options, key)) return options[key];
    }
  }
  return undefined;
}

// settings.json holds real JSON types; the environment holds strings only.
// Rendering the JSON value as its string form puts BOTH through the identical
// coercion in opt(), so a JSON `true` and the string "true" resolve the same
// way and there is no second, divergent set of rules to keep in step. A null,
// object or array value counts as not set at all.
function scalarOrUndefined(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function opt(key, fallback) {
  let raw;
  try {
    raw = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`]
      ?? process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
    if (raw === undefined) raw = scalarOrUndefined(optionFromSettings(key));
  } catch { raw = undefined; } // fail toward the default, never into the hook
  if (raw === undefined || raw === '') return fallback;
  if (typeof fallback === 'boolean') return !/^(false|0|no|off)$/i.test(raw);
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

// Positive confirmation only. Unknown or missing => NOT main => no enforcement.
export function isMainThread(p) {
  return typeof p.agent_type === 'string' && MAIN_THREAD_TYPES.has(p.agent_type);
}

// Look up a named agent's own definition. This is what distinguishes a
// PROJECT-DEFINED agent from genuine harness drift, and a configured model from
// an unexamined default — the two things the raw payload cannot tell apart.
export function agentDefinition(type, cwd) {
  if (!type) return null;
  const roots = [
    cwd && join(cwd, '.claude', 'agents'),
    join(claudeDir(), 'agents'),
  ].filter(Boolean);
  for (const root of roots) {
    const file = join(root, `${type}.md`);
    try {
      if (!existsSync(file)) continue;
      const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return { file, model: '', effort: '' };
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
      }
      return { file, model: fm.model || '', effort: fm.effort || '' };
    } catch { /* keep looking */ }
  }
  return null;
}

// Session ids that must never be treated as real activity: the guard-canary
// probe (checks.mjs, session_id starting `canary`) and this plugin's own test
// fixtures (`verify-`, `test-`, `fixture-`). Canary rows are dropped entirely,
// same as before this change — a probe must not inflate the metric it is
// checked against. The other three prefixes are NOT dropped: they are
// recorded, but routed to telemetry/fixtures.jsonl instead of the production
// stream, so a verification run can never again pollute real history the way
// `verify-opt-case-test-1` and `verify-nudge-session` once did.
function isCanarySession(sid) {
  return /^canary/i.test(String(sid || ''));
}
export function isFixtureSession(sid) {
  return /^(canary|verify-|test-|fixture-)/i.test(String(sid || ''));
}

function agentTypeMarkerName(t) {
  const safe = String(t).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${createHash('sha1').update(String(t)).digest('hex').slice(0, 8)}.seen`;
}

// Enforcement fails open on unknown types, but detection must not. Record them
// so the daily scout can dispatch a harness-surface review.
//
// Two refinements learned from real data: a type with its own definition file
// is a PROJECT-DEFINED agent, not drift — recording those buried the real signal
// under a project's own roster. And the same type was appended dozens of times
// in an afternoon; drift is a set, not a stream, so each type is recorded once.
//
// Dedup used to be read-check-append with no lock: two hook processes racing
// on the same brand-new type could both pass the check before either had
// appended, producing two rows for one type. It is now a `wx` (create,
// exclusive) marker file per type under state/agent-types/ — atomic on both
// Windows and POSIX — so only the ONE process whose create wins ever appends.
export function noteAgentType(p) {
  const t = p.agent_type;
  if (!t || KNOWN_AGENT_TYPES.has(t)) return;
  if (agentDefinition(t, p.cwd)) return; // defined somewhere: known, not drift
  const sid = p.session_id;
  try {
    if (isCanarySession(sid)) return; // probes must not create markers or rows
    const row = { at: new Date().toISOString(), agent_type: t };
    if (isFixtureSession(sid)) {
      // A fixture/verification session's sighting must never touch production
      // dedup state — a marker created here would silently suppress a REAL
      // sighting of the same type later. Record it for visibility only.
      try {
        writeFileSync(join(telemetryDir(), 'fixtures.jsonl'),
          JSON.stringify({ v: TELEMETRY_SCHEMA, ...row, session_id: String(sid), stream: 'unknown-agent-types.jsonl' }) + '\n',
          { flag: 'a' });
      } catch { /* fail open */ }
      return;
    }
    const dir = join(stateDir(), 'agent-types');
    try { mkdirSync(dir, { recursive: true }); } catch { /* fail open */ }
    try {
      writeFileSync(join(dir, agentTypeMarkerName(t)), '', { flag: 'wx' });
    } catch {
      return; // EEXIST (already seen) or any other error: fail open, no append
    }
    appendLog('unknown-agent-types.jsonl', row);
  } catch { /* fail open */ }
}

export function isPremium(model) {
  if (!model) return false; // nothing named: the inheritance path handles it
  return classifyModel(model).premium;
}

// Small mutable state (streak counters, cursors, snapshots) — under the
// durable state root, not the plugin data directory, so it survives an
// uninstall same as telemetry does.
export function stateFile(name) {
  return join(stateDir(), name);
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value)); } catch { /* fail open */ }
}

// --- Premium fan-out window (state/premium-window.json) ---------------------
// The cap counts premium spawns that actually STARTED, not every spawn the
// guard allowed. An allowed spawn the harness then rejects (an unknown
// subagent_type, say) used to hold a slot for the whole window, so each
// failed retry extended the block. Now the guard records a PENDING entry
// {t, sid, confirmed:false}; the SubagentStart hook (spawn-log.mjs) confirms
// the oldest pending entry for its session; an entry never confirmed stops
// counting after PREMIUM_PENDING_MS. Pending entries DO count while young,
// so a parallel burst (several spawns before any has started — the
// four-Fable shape) is still capped. PREMIUM_PENDING_MS is set from measured
// spawn-to-start lag (p50 ~0.1 s, p99 ~52 s, max ~101 s over 394 pairs,
// 2026-09-24) with headroom. A bare number is a pre-1b entry: confirmed.
export const PREMIUM_WINDOW_MS = 10 * 60 * 1000;
export const PREMIUM_PENDING_MS = 3 * 60 * 1000;

function windowEntryLive(e, now) {
  if (typeof e === 'number') return now - e < PREMIUM_WINDOW_MS;
  if (!e || typeof e.t !== 'number') return false;
  return now - e.t < (e.confirmed ? PREMIUM_WINDOW_MS : PREMIUM_PENDING_MS);
}

export function premiumWindowLive(entries, now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).filter((e) => windowEntryLive(e, now));
}

// SubagentStart: confirm the oldest live pending entry for this session.
// Matched by session only — the start's agent_type does not always equal the
// spawn's subagent_type (namespacing). Returns true when one was confirmed.
export function confirmPremiumStart(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const f = stateFile('premium-window.json');
  const live = premiumWindowLive(readJson(f, []), now);
  const idx = live.findIndex((e) => e && typeof e === 'object' && !e.confirmed && e.sid === sessionId);
  if (idx < 0) return false;
  live[idx] = { ...live[idx], confirmed: true, startedAt: now };
  writeJson(f, live);
  return true;
}

// Emitted telemetry is a PUBLIC CONTRACT, not an internal detail — other tools
// read these files. Every record carries the schema version that produced it, so
// a consumer can skip records from a major version it does not understand
// instead of silently misreading them. Consumers must tolerate unknown fields.
// See docs/TELEMETRY.md.
// Fit of an ACTUAL model/effort against what the table says the task needs.
// recommend answers "what should this run on?" before the spawn; this answers
// "is what is running right?" — the same table, read in the other direction.
// Model dominates: a wrong tier is the finding, effort refines it. Pass
// `expected` directly for reviewer parity, else it resolves from the task.
export function evaluateFit({ model, effort = '', weight, kind = 'bounded', consequence = 'routine', expected = null, parity = false }) {
  const exp = expected || effortFor(weight, kind, consequence);
  const a = classifyModel(model);
  const e = classifyModel(exp.model);
  const modelDelta = a.known ? a.rank - e.rank : null;
  const eff = String(effort || '').toLowerCase();
  const sup = effortSupported(model, eff);
  let effortDelta = null;
  let effortNote = '';
  if (!eff) effortNote = 'no effort given';
  else if (!sup.ok) effortNote = sup.reason;
  else if (exp.effort) effortDelta = classifyEffort(eff).rank - classifyEffort(exp.effort).rank;
  else effortNote = `${exp.model} takes no effort parameter; effort is not comparable`;

  const expLabel = `${exp.model}${exp.effort ? '/' + exp.effort : ''}`;
  let verdict;
  let reason;
  if (modelDelta === null) {
    verdict = 'unknown'; reason = `"${model}" is not in the tier table (the guards treat it as premium)`;
  } else if (modelDelta > 0) {
    verdict = 'over'; reason = `${a.alias} is ${modelDelta} tier(s) above ${expLabel}`;
  } else if (modelDelta < 0) {
    verdict = 'under'; reason = `${a.alias} is ${-modelDelta} tier(s) below ${expLabel}; the task exceeds the tier`;
  } else if (effortDelta !== null && effortDelta < 0) {
    verdict = 'under';
    reason = parity
      ? `reviewer effort ${eff} is below the writer's ${exp.effort}; a reviewer may exceed but must not drop`
      : `right tier; effort ${eff} is below ${exp.effort}`;
  } else if (effortDelta !== null && effortDelta > 1 && !parity) {
    verdict = 'over'; reason = `right tier; effort ${eff} is ${effortDelta} steps above ${exp.effort}`;
  } else {
    verdict = 'fit'; reason = `${a.alias || model}${eff ? '/' + eff : ''} matches the table (${expLabel})`;
  }

  // Over is a cost problem: hand the rest down, or warrant it if that is
  // honestly true. Under is a correctness problem: escalate, and treat what
  // was produced so far as suspect where it needed the missing capability.
  const w = typeof weight === 'number' ? weight : '<1-5>';
  const action = {
    fit: 'continue',
    over: a.premium
      ? `hand the remainder to ${expLabel}, or state "WARRANT: weight ${w} — <why the cheaper tier cannot do this>" if that is honestly true`
      : `finish the current step, then hand the remainder to ${expLabel}`,
    under: `escalate to ${expLabel}${e.premium ? ' with a WARRANT line' : ''}; re-check anything already produced that needed the missing capability`,
    unknown: 'add the model to config/model-tiers.json so it can be classified',
  }[verdict];

  return {
    verdict, reason, action, modelDelta, effortDelta, effortNote: effortNote || null,
    expected: exp,
    actual: { model, alias: a.alias, effort: eff || null, premium: a.premium },
  };
}

export const TELEMETRY_SCHEMA = 2;

// Append-only telemetry — durable, under telemetry/. A canary probe's row is
// dropped (as always). A fixture/verification session's row is redirected to
// telemetry/fixtures.jsonl (with the destination stream name stamped onto it)
// instead of ever touching the production stream — see isFixtureSession above.
export function appendLog(name, record) {
  try {
    const stamped = { v: TELEMETRY_SCHEMA, ...record };
    const sid = record?.session_id;
    if (isCanarySession(sid)) return;
    if (isFixtureSession(sid)) {
      writeFileSync(join(telemetryDir(), 'fixtures.jsonl'), JSON.stringify({ ...stamped, stream: name }) + '\n', { flag: 'a' });
      return;
    }
    writeFileSync(join(telemetryDir(), name), JSON.stringify(stamped) + '\n', { flag: 'a' });
  } catch { /* fail open */ }
}

// Record a guard firing. Without this the denial count is always zero, and a
// guard that has silently stopped matching is indistinguishable from one with
// nothing to deny — which is exactly the signal the calibration canary exists
// to raise. Call this BEFORE deny(), which exits the process.
export function recordDenial(guard, payload, detail) {
  appendLog('denials.jsonl', {
    at: new Date().toISOString(),
    session_id: String(payload?.session_id ?? ''),
    agent_type: payload?.agent_type,
    tool_name: payload?.tool_name,
    guard,
    outcome: 'deny',
    detail: String(detail ?? '').slice(0, 300),
  });
}

// Bounded, positioned tail-read of a JSONL transcript: opens the file, seeks
// to `size - bytes`, reads only that tail, and parses lines that pass a cheap
// substring pre-filter before paying for JSON.parse. Never reads the whole
// file, never throws, returns [] on any error. Records come back oldest-first
// (newest last), matching file order. Generalised from the mechanism
// self-update.mjs used for its own narrower purpose (the newest `Reloaded: `
// marker) so a second caller does not have to reimplement seek-to-tail.
export function tailRecords(path, { bytes = 131072, filter = () => true, max = Infinity } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return [];
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    // A tail read that doesn't start at byte 0 may begin mid-line; drop that
    // fragment rather than risk a false JSON.parse on a truncated record.
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{' || !filter(t)) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      out.push(rec);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// The last `type:"assistant"` record's model and effort, read via the bounded
// tail-read above. `model` comes from `message.model`; `effort` is the
// record's own TOP-LEVEL `effort` field (distinct from `message.model`, which
// lives one level down). Returns null when the transcript is missing, empty,
// or has no assistant record in the tail window.
export function lastAssistantMeta(path) {
  if (!path) return null;
  const records = tailRecords(path, { filter: (line) => line.includes('"type":"assistant"') });
  if (!records.length) return null;
  const last = records[records.length - 1];
  const model = last && last.message && typeof last.message.model === 'string' ? last.message.model : null;
  const effort = last && typeof last.effort === 'string' ? last.effort : null;
  return { model, effort };
}

// The Claude Code BUILD a transcript was written under. Every non-queue
// record the harness writes carries a top-level `version` string (verified
// directly against real transcripts, both top-level sessions and nested
// `subagents/agent-<id>.jsonl` files) — SPAWNING RULE 2 (operator-approved
// 2026-09-23) needs this to decide whether the CALLING session predates
// config/model-tiers.json's aliasResolution.minClaudeCodeVersion floor,
// because a session keeps the build it started with and the desktop app
// bundles its own build separate from the `claude` CLI on PATH: shelling out
// to `claude --version` (what scripts/detect.mjs does for the daily scout)
// answers a different question than "what build is THIS session on". Read
// via the same bounded tail as lastAssistantMeta() — the build does not
// change mid-session, so any record in the tail window carries the answer.
// Returns null when the path is missing, unreadable, or carries no version.
export function sessionBuildVersion(path) {
  if (!path) return null;
  const records = tailRecords(path, { filter: (line) => line.includes('"version":') });
  if (!records.length) return null;
  const last = records[records.length - 1];
  return typeof last.version === 'string' ? last.version : null;
}

// Which transcript belongs to the SPAWN'S CALLER (not the new subagent, which
// does not exist yet at PreToolUse time). Preference order, per the PreToolUse
// payload shape:
//   1. p.agent_transcript_path, when the payload carries one.
//   2. When the caller is itself a sub-agent (p.agent_id set), the nested
//      per-agent transcript the harness writes alongside the parent's —
//      <dirname(transcript_path)>/<basename(transcript_path,'.jsonl')>/subagents/agent-<agent_id>.jsonl
//      — but only if that file actually exists; a constructed path is a guess,
//      not a fact.
//   3. p.transcript_path (the plain top-level case: caller is the main thread).
export function callerTranscriptPath(p) {
  if (p && p.agent_transcript_path) return p.agent_transcript_path;
  if (p && p.agent_id && p.transcript_path) {
    const dir = dirname(p.transcript_path);
    const base = basename(p.transcript_path, '.jsonl');
    const candidate = join(dir, base, 'subagents', `agent-${p.agent_id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return (p && p.transcript_path) || null;
}

export function allow() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  }));
  process.exit(0);
}

export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Exit silently without a decision — the call proceeds normally.
export function passthrough() { process.exit(0); }
