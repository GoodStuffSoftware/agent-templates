// Features 2 + 3 — Premium fan-out cap and warrant, on the Agent tool — and
// best fit: the routing table applied at the spawn, in both directions.
//
// Fable is deliberately NOT banned. The lesson from the four-Fable incident is
// that nobody CHOSE Fable four times — subagents inherit the lead's model when
// nothing specifies one, so the default did the choosing. This guard therefore
// targets what was actually missing: a stated justification, a ceiling on how
// many run at once, and — when the brief declares a weight — the table's own
// answer, filled in where the spawn left the model blank and enforced where
// the spawn named a premium tier its own declared weight does not support.
//
// SPAWNING RULE (operator-approved 2026-09-23) — this hook implements rules 1
// and 2; rule 3 (resolved-model verification) lives in the audit, since it
// needs the SPAWNED agent's own transcript, which does not exist yet at
// PreToolUse time:
//   1. Every spawn names a definition that states BOTH model and effort (a
//      ladder ac-* def or a project def). A spawn with no model, or a
//      definition with no effort, inherits the lead's model and effort and
//      counts as a violation.
//   2. Build check before opus-tier work: if the SESSION's Claude Code build
//      is below aliasResolution.minClaudeCodeVersion, restart the session
//      before spawning; don't pin around it.
// This hook WARNS, never blocks, on either rule — a false block stops
// legitimate work; these are detection, not enforcement. The one opt-in
// exception is `inherit_guard: block`, which denies the rule-1 shape at its
// worst: model AND effort both inherited from a premium-tier lead, with no
// TYPE the table knows and no WEIGHT line (default "warn": the note only).
//
// SELF-REVIEW (operator request 2026-09-28; config `selfReview`, protocol text
// generated into the rung by scripts/routing-table.mjs, lib/self-review.mjs):
//   - a parity-sized review spawned by a SUBAGENT with no WRITER line is sized
//     to the caller's own definition (agent_type -> its model/effort), in a
//     note; a built-in or missing caller type, or a caller seen running a
//     different model than its definition, infers nothing;
//   - reviewers never spawn reviewers: such a review is DENIED when the
//     caller's own spawn row (agent_id -> sidecar toolUseId -> row tool_use_id)
//     is itself a parity review. Positive match only: anything unknown allows
//     (`review_recursion_guard`, default on);
//   - a self-reviewing writer's review: a WRITER line below the writer's own
//     pair gets a note, and a critical writer TYPE floors it by F1;
//   - a self-reviewing TYPE on a ladder rung without the protocol gets it
//     appended to the brief; on a built-in type, a note.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  opt, stateFile, readJson, writeJsonAtomic, appendLog, deny, passthrough, recordDenial, agentDefinition,
  evaluateFit, resolveRoute, effortSupported, classifyModel, classifyEffort, modelTiers, taskTypeDef,
  canonicalTaskType, unknownTypeHint, rungFor, runningCopyStamp, routedRung, routeLayerTag, pluginName,
  resolvedProjectRoot, claudeProjectDir, pathKey,
} from './lib/context.mjs';

import {
  selfReviewConfig, optedOut, isParityType, writerFromCaller, definitionCarriesProtocol, injectionRung,
  pinnedInjectionRung, selfReviewBriefText, reviewerRungFor,
} from './lib/self-review.mjs';
import { buildContract, noteContractAppended } from './lib/brevity.mjs';
import { buildScopeClause } from './lib/scope-rule.mjs';
import { matchRules, renderRules } from './lib/rules.mjs';
import {
  allowWith, combineNotes, commonTypeRoutes, definitionPinExempt, ladderRewriteTarget,
} from './lib/sg-helpers.mjs';
import { readSpawnBrief } from './lib/sg-brief.mjs';
import { resolveSpawnRoute } from './lib/sg-route.mjs';
import { autofillAndModelNotes } from './lib/sg-autofill.mjs';
import { memoryAndShapeGates } from './lib/sg-gates.mjs';

// The recommender and the setup SKILL.md as paths a worker can use from any directory: the guard's
// messages reach subagents (a worker spawning its reviewer), whose cwd is the
// project, so a bare `scripts/recommend.mjs` would not resolve.
const SETUP_SKILL_FILE = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'setup', 'SKILL.md').replace(/\\/g, '/'); } catch { return 'skills/setup/SKILL.md'; }
})();
const RECOMMEND_CMD = (() => {
  try { return 'node "' + join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'recommend.mjs').replace(/\\/g, '/') + '"'; } catch { return 'node scripts/recommend.mjs'; }
})();

try {
  const readSpawnBriefOut = readSpawnBrief();
  const {
    p, input, sid, declared, isLadderSpawn, fromDef, trulyInherited, pin, pinned, pinModelOverridden,
    pinReplacedNote, isCanary, brief, decls, warrantDeclared, weightLineExplicit, weightWasDeclared,
    kindWasDeclared, consequenceWasDeclared, declaredTypeRaw, declaredType, declaredRole, roleInserted,
    silentFixes, typeRequiredMode, typeReqIsRung, typeRequiredMissing, roleNudge, typeIsParity, writerRaw,
  } = readSpawnBriefOut;
  let {
    def, model, declaredWeight, declaredKind, declaredConsequence, typeWeight, writer, writerProblem,
  } = readSpawnBriefOut;
  const resolveSpawnRouteOut = resolveSpawnRoute({
    p, sid, isCanary, brief, decls, typeIsParity, writer, consequenceWasDeclared, declaredConsequence,
    weightWasDeclared, typeWeight, declaredType, declaredWeight, declaredKind, weightLineExplicit,
    kindWasDeclared, writerProblem, model,
  });
  const {
    subagentCaller, callerModel, callerEffort, leadLive, callerObserved, callerDeclaredType, fitOn,
    parityRoute, writerPartial, parityFloorLabel, routeLabel, routeLayerNote, routingKnown,
  } = resolveSpawnRouteOut;
  let {
    writerInferred, writerInferProblem, callerRow, consequenceFromCaller, route, parityYardstick, parityFloor,
    spawnAlias, routeMatchesModel, isPremiumForSpawn,
  } = resolveSpawnRouteOut;
  ({ writer, declaredConsequence, declaredWeight, declaredKind, writerProblem } = resolveSpawnRouteOut);
  const autofillAndModelNotesOut = await autofillAndModelNotes({
    sid, brief, fitOn, trulyInherited, route, isLadderSpawn, writerPartial, pinned, model, input, p, def,
    callerModel, declared, callerEffort, declaredType, routeLabel, writerRaw, typeIsParity, writerProblem,
    typeWeight, weightWasDeclared, RECOMMEND_CMD, SETUP_SKILL_FILE,
  });
  const {
    loadedAtMs, neededTools, browserVariants, browserVariantFor, rewriteModule, modelTakesEffort, callerAlias,
    noEffortStatedNote, leadLabel, missingModelNote, inheritBlock,
  } = autofillAndModelNotesOut;
  let {
    autofilled, updatedInput, ladderRewrite, autofillAdvisory, rewriteState, buildFloorNote,
  } = autofillAndModelNotesOut;
  ({ model, def } = autofillAndModelNotesOut);
  const memoryAndShapeGatesOut = memoryAndShapeGates({
    brief, p, input, subagentCaller, model, silentFixes, updatedInput, declaredType, sid,
  });
  const {
    gate1Applicable, gate1Exempt, gate1Mode, gate2Fired, gate4Applicable, gate3Fired, gateMessage,
  } = memoryAndShapeGatesOut;
  let {
    memoryAddition, memoryFacts, namegateSuffix, selfReviewSuffix, gate1Action, gate4Action, namegateName,
  } = memoryAndShapeGatesOut;
  ({ updatedInput } = memoryAndShapeGatesOut);
  function withAdditions(baseInput) {
    let suffix = '';

    // 0. The self-review protocol, for a self-reviewing TYPE on a ladder rung
    //    whose definition does not carry it (set below, see "Is this writer
    //    expected to review itself?"). Task instructions first, then the
    //    reporting contract.
    suffix += selfReviewSuffix || '';

    // 1. The reporting contract — the operator's token spend is dominated by
    //    subagents narrating their journey when only blockers and an outcome
    //    were wanted. Global switch, per-agent override in either direction,
    //    and a peer-brevity clause that holds even when the contract is off.
    //    See lib/brevity.mjs.
    try {
      const contract = buildContract(input.subagent_type) || '';
      suffix += contract;
      // Tell the SubagentStart hook it is already delivered (it cannot see
      // the prompt). Canary runs never start a subagent: no entry to leak.
      // Nothing consumes the record when the SubagentStart reinforcement is
      // off, so none is written then. The record carries the type this spawn
      // will start as (and its pre-rewrite type, if the harness ignores the
      // rewrite) so only a start of that type consumes it.
      if (contract && !isCanary && opt('brevity_reinforce', true)) {
        noteContractAppended(sid, Date.now(), [
          ladderRewrite ? ladderRewrite.to : input.subagent_type,
          ...(ladderRewrite ? [ladderRewrite.from] : []),
        ]);
      }
    } catch { /* fail open: no contract, spawn proceeds untouched */ }

    // 1b. The scope rule: one short clause by task type or role (lib/scope-rule.mjs).
    try { suffix += buildScopeClause(declaredType, declaredRole, input.prompt); } catch { /* fail open */ }

    // 2. Operator-authored standing rules scoped to spawns, their conditions
    //    matched against this brief's own text. See lib/rules.mjs.
    try {
      if (opt('standing_rules', true)) {
        // Rules list canonical type names: match a copy whose TYPE value is the canonical one.
        const ruleText = declaredTypeRaw && declaredType !== declaredTypeRaw && decls.TYPE
          ? brief.replace(new RegExp(`(\\bTYPE\\b[^\\n]{0,12}?)\\b${declaredTypeRaw}\\b`, 'i'), (_m, pre) => pre + declaredType)
          : brief;
        const hits = matchRules({ scope: 'spawn', text: ruleText, sessionId: sid });
        suffix += renderRules(hits, { maxChars: opt('standing_rules_max_chars', 3000) }) || '';
      }
    } catch { /* fail open */ }

    // 3. The memory addition, already computed above so its facts can reach
    //    the telemetry row whether or not this spawn is ultimately allowed.
    suffix += memoryAddition || '';

    // 4. Namegate's own brief boilerplate for a worker this guard just named
    //    (see Gate 4 below): who it is, its lead, its known peers.
    suffix += namegateSuffix || '';

    if (!suffix && !roleInserted) return baseInput;
    return { ...(baseInput || input), prompt: `${roleInserted ? `ROLE: ${roleInserted}\n` : ''}${input.prompt || ''}${suffix}` };
  }

  // With no route, the plain grid is the yardstick only for a weight the
  // brief itself declared. Never for a parity-sized TYPE whose only weight is
  // a WARRANT's: a warrant never outranks a declared TYPE (see the weight
  // parsing above), and a writer-less review judged against the grid row of
  // its warrant's weight was DENIED with an empty route in the message
  // ("TYPE: code-review" + "WARRANT: weight 4 — ..." on opus, 0.29.18).
  const gridYardstick = declaredWeight !== null && !(typeIsParity && !weightLineExplicit);
  let fit = null;
  if (fitOn && model && !autofilled && (route || gridYardstick)) {
    try {
      fit = evaluateFit({
        model, effort: def?.effort || '', weight: declaredWeight,
        kind: declaredKind || 'bounded', consequence: declaredConsequence || 'routine',
        // `route` was already resolved via resolveRoute() above (layer stack
        // included) — pass it through as `expected` so evaluateFit() judges
        // against it directly instead of recomputing an override-blind
        // default from the plain grid.
        expected: route,
        // Reviewer parity: effort above the writer's is allowed (never
        // "over"), below it is "under" with the parity reason.
        parity: parityRoute,
      });
    } catch { /* table unreadable: the audit reports that separately */ }
  }

  // F1 on a critical parity-sized spawn (see parityFloor above): under only. Judged
  // here, before the parity notes, so the writer-less note can defer to it.
  if (!fit && parityFloor && model && !autofilled) {
    try {
      const f = evaluateFit({
        model, effort: def?.effort || '', weight: null,
        kind: declaredKind || 'bounded', consequence: 'critical', expected: parityFloor,
      });
      if (f.verdict === 'under') fit = { ...f, parityFloor: true };
    } catch { /* table unreadable */ }
  }

  // --- Over-provisioned ladder spawn: silent rewrite to the routed rung (0.31.36) ----------
  // An ac-* rung that the fit check finds over-provisioned for its TYPE is rewritten, through
  // updatedInput, to the rung the table names (ladderRewriteTarget: only a type the session has
  // shown registered), with no message; the spawn row records it (silent_fixes, fit_before_fix).
  // The model parameter, when the call set one, moves to the routed model too: it would
  // otherwise replace the rung's own. A "PREMIUM: <reason>" line opts out (and also the
  // premium over-provisioned deny below: the lead has stated why). Under-provisioned spawns
  // are logged, never changed. No target (an unregistered rung, an ignored rewrite, a project
  // pin, a reviewer on its parity route): nothing changes, as before.
  const premiumDeclared = !!(decls.PREMIUM && String(decls.PREMIUM.rest || '').replace(/[\s*_`]/g, ''));
  let fitBeforeFix = null;
  if (fit?.verdict === 'over' && typeReqIsRung && !parityRoute && !pinned && !autofilled && !premiumDeclared
    && !(rewriteState && rewriteState.ignored) && route?.model && opt('fit_over_autofix', true) && opt('fit_autofill_ladder', true)) {
    try {
      const rung = rungFor(route.model, route.effort || null);
      const pick = rung ? ladderRewriteTarget(sid, rung.agent, p.cwd, loadedAtMs) : null;
      if (pick && pick.target && pick.target !== input.subagent_type) {
        updatedInput = { ...(updatedInput || input), subagent_type: pick.target, ...(input.model ? { model: route.model } : {}) };
        ladderRewrite = { from: input.subagent_type || null, to: pick.target };
        def = pick.def;
        model = route.model;
        spawnAlias = classifyModel(model).alias;
        routeMatchesModel = true;
        isPremiumForSpawn = false;
        fitBeforeFix = fit.verdict;
        fit = { ...fit, verdict: 'fit' };
        silentFixes.push(`fit_over_rewrite:${ladderRewrite.from}->${pick.target}`);
      }
    } catch { /* fail open: nothing rewritten */ }
  }
  if (fit?.verdict === 'under' && typeReqIsRung && !parityRoute && !pinned) silentFixes.push('fit_under_logged');

  // --- Was this spawn's model a routing choice? ----------------------------
  // `routed` (spawns.jsonl) records where the model came from. It came from
  // a routing choice when it is:
  //   - the model a resolved route names (routeMatchesModel), or one the
  //     guard filled in from it (autofilled; a ladder rewrite is one too);
  //   - pinned by the definition that runs — a ladder rung (a rung IS a
  //     routing choice, TYPE line or not), or a project, user or plugin
  //     agent — and not overridden by a different model on the spawn call;
  //   - a reviewer on its FLOORED parity route (parityYardstick: the
  //     writer's model after F4/F2/F1), never merely on the raw writer's: a
  //     sonnet reviewer of a sonnet writer under F1 is below its opus/xhigh
  //     route, not routed.
  // Anything else — a model inherited from the lead, or one set per-spawn on
  // a built-in type with no route naming it — was nobody's routing choice.
  // Fable is never routed, whatever pinned it: nothing routes to fable (the
  // table's own rule; F2 sizes even a fable writer's reviewer to opus), so a
  // fable spawn is always a warranted exception and always counted.
  const finalAlias = model ? classifyModel(model).alias : '';
  const defAlias = fromDef ? classifyModel(fromDef).alias : '';
  const modelFromDefinition = !!defAlias && (!declared || classifyModel(declared).alias === defAlias);
  const reviewerOnParityRoute = typeIsParity && !!parityYardstick && !!finalAlias
    && classifyModel(parityYardstick.model).alias === finalAlias;
  const routed = !!finalAlias && finalAlias !== 'fable'
    && (autofilled || routeMatchesModel || modelFromDefinition || reviewerOnParityRoute);

  // --- Does the premium cap count this spawn? -------------------------------
  // Narrower than `routed`. Only a spawn premium FOR THIS SPAWN reaches the
  // cap (fable, or a premium tier its route does not name; see the early
  // allow below), and of those an opus spawn is exempt when its model is:
  //   - pinned by a definition definitionPinExempt() accepts: an ac-opus-*
  //     rung other than ac-opus-max, or a project or user agent not named
  //     like a built-in type (another plugin's agent, a built-in-named file
  //     and ac-opus-max stay counted);
  //   - a reviewer's on its floored parity route.
  // Fable is never exempt. capCounts is THE answer: the parity note's cap
  // clause reads it and the cap below acts on it, so a note can no longer
  // claim a count the cap never makes (0.29.19 review).
  const capExempt = spawnAlias === 'opus'
    && ((modelFromDefinition && definitionPinExempt(input.subagent_type, def, p.cwd)) || reviewerOnParityRoute);
  const capCounts = isPremiumForSpawn && !capExempt && opt('premium_cap', true);

  // --- Reviewer parity (TYPE: code-review + WRITER:) ----------------------
  // Judged against the parity route (the writer's model and effort, after
  // F4/F2/F1 and any routing-profile minimum), NOTES ONLY in this release —
  // a mis-read WRITER line must never block a review. The words name what
  // the reviewer was actually compared with: "its writer" only when the
  // route IS the writer's own pair; "the F1 floor for critical reviews" when
  // F1 alone moved it to the floor; otherwise "its parity route", with the
  // floors that moved it. The reviewer's effort is the one its definition
  // states (effort is locked to frontmatter); a reviewer with none
  // (general-purpose, Explore, Plan) runs at the session's effort, so parity
  // cannot be verified and the note names the ladder rung that pins the
  // parity pair instead.
  const parityRung = parityRoute && route.effort ? rungFor(route.model, route.effort) : null;
  const parityRungName = parityRung ? `agent-companion:${parityRung.agent}` : null;
  const routeIsWriter = parityRoute && !!writer
    && route.model === writer.model && (route.effort || '') === (writer.effort || '');
  const critFloor = modelTiers().consequence?.critical || {};
  const critLabel = critFloor.modelFloor ? `${critFloor.modelFloor}${critFloor.effortFloor ? '/' + critFloor.effortFloor : ''}` : '';
  const parityMovers = parityRoute && !routeIsWriter
    ? [
      ...[...new Set((route.floorsApplied || []).filter((x) => x.floor !== 'F3' || /reviewerEffort/.test(x.raised || x.capped || '')).map((x) => x.floor))].map((f) => {
        if (f === 'F1') return `floor F1: a critical review is at least ${critLabel}`;
        if (f === 'F2') return `floor F2: ${writer.model} is never a routing destination`;
        const e = route.floorsApplied.find((x) => x.floor === f && (f !== 'F3' || /reviewerEffort/.test(x.raised || x.capped || '')));
        return `floor ${f}${e && (e.raised || e.capped) ? `: ${e.raised || e.capped}` : ''}`;
      }),
      ...(route.layer === 'profile' ? [`routing profile rev ${route.profileRevision}'s minimum effort`] : []),
    ]
    : [];
  const f1Only = parityMovers.length === 1 && parityMovers[0].startsWith('floor F1') && routeLabel === critLabel;
  const parityAgainst = routeIsWriter ? `its writer, ${routeLabel}`
    : f1Only ? `the F1 floor for critical reviews, ${routeLabel}`
      : `its parity route, ${routeLabel}`;
  const parityFloorsText = parityMovers.length ? ` (the writer's ${writer.label}, after ${parityMovers.join('; ')})` : '';
  const reviewerEffort = def?.effort || '';
  const reviewerAlias = model ? (classifyModel(model).alias || model) : '';
  const reviewerLabel = model ? `${reviewerAlias}${reviewerEffort ? '/' + reviewerEffort : ''}` : '';
  const instead = parityRungName ? `spawn ${parityRungName} (${routeLabel}) instead` : `re-spawn at ${routeLabel}`;
  let parityNote = null;
  let parityInheritedEffort = false;
  if (parityRoute && fit && !autofilled && !pinned) {
    const head = `agent-companion (reviewer parity): ${input.subagent_type || 'this reviewer'} reviews at ${reviewerLabel}` +
      ` for a writer at ${writer.label}${writer.agent ? ` ("${writer.agent}")` : ''}; the parity route is ${routeLabel}${parityFloorsText}.`;
    if (fit.verdict === 'under') {
      const detail = typeof fit.modelDelta === 'number' && fit.modelDelta < 0
        ? `${reviewerAlias} is ${-fit.modelDelta} tier(s) below ${route.model}`
        : `effort ${reviewerEffort} is below ${route.effort}`;
      const why = routeIsWriter ? 'A reviewer below its writer waves through the errors the writer would make'
        : f1Only ? `A critical review is never sized below ${critLabel}, whatever its writer`
          : 'A reviewer may exceed its parity route but must not drop below it';
      parityNote = `${head} It is BELOW ${parityAgainst} — ${detail}. ${why}; ${instead}. Not blocking.`;
    } else if (fit.verdict === 'over') {
      parityNote = `${head} Its model is ABOVE ${parityAgainst} — parity says match ` +
        `${routeIsWriter ? "the writer's model" : "the route's model"} (effort may exceed it); ${instead}. ` +
        `Not blocking${capCounts ? ', but a premium tier the route does not name counts toward the premium cap' : ''}.`;
    } else if (fit.verdict === 'fit' && !reviewerEffort && modelTakesEffort) {
      parityInheritedEffort = true;
      parityNote = `${head} Its model matches, but it states no effort, so it runs at the session's effort ` +
        `(${callerEffort || 'unreadable here'}) and parity with the route's effort cannot be verified; ` +
        `${parityRungName ? `spawn ${parityRungName} to pin ${routeLabel}` : `use a definition that pins ${routeLabel}`}.`;
    }
  }
  // WRITER notes: parity-sized types only (the line is not read on any other
  // brief), and only while fit_guard is on (they are fit notes).
  const writerNotesOn = typeIsParity && opt('fit_guard', true) && !pinned;
  // A declared WRITER line that could not be used at all.
  const writerNote = writerNotesOn && writerProblem
    ? `agent-companion: the WRITER line${writerRaw ? ` ("${writerRaw}")` : ''} was ignored — ${writerProblem}. Write it as \`WRITER: <model>/<effort>\` ` +
      '(e.g. `WRITER: opus/xhigh`) or `WRITER: <agent-name>` (e.g. `WRITER: ac-opus-xhigh`).'
    : null;
  // WRITER inferred from the caller (see "WRITER inferred from the caller"
  // above): said every time, since nobody wrote the pair the review is sized
  // to, and said when inference was tried and found nothing to use.
  const writerInferredNote = writerNotesOn && writerInferred
    ? `agent-companion: this review names no WRITER line, so its writer was inferred from the subagent spawning it: ` +
      `"${writerInferred.agent}" runs at ${writerInferred.label}, and the review is sized to that (a ` +
      'subagent that spawns a code-review is taken to be the writer it gates).' +
      (writerInferred.effortSource === 'observed'
        ? ` Its definition states no effort; ${writerInferred.effort} is the effort it was seen running at (inherited).`
        : writerInferred.effortIssue === 'agent-none'
          ? ' That definition states no effort, so parity is checked on the model alone.'
          : '') +
      ' Add `WRITER: <model>/<effort>` if it gates other work.'
    : null;
  const writerInferNote = writerNotesOn && !writer && writerInferProblem
    ? `agent-companion: this review names no WRITER line, and its writer could not be inferred from the subagent ` +
      `spawning it: ${writerInferProblem}. Add \`WRITER: <model>/<effort>\` (e.g. \`WRITER: opus/xhigh\`) naming the ` +
      'writer this review gates.'
    : null;
  // A usable WRITER line whose effort is missing or was not understood: said,
  // never silently dropped, since only the model half of parity is checked.
  let writerEffortNote = null;
  if (writerNotesOn && writer && writer.effortIssue && !writerInferred) {
    const wm = writer.model;
    const example = effortSupported(wm, 'high').ok
      ? `\`WRITER: ${wm}/<effort>\` (e.g. \`WRITER: ${wm}/xhigh\`)`
      : `\`WRITER: ${wm}\` (${wm} takes no effort)`;
    const levels = Object.keys(modelTiers().efforts || {}).join(', ');
    writerEffortNote = writer.effortIssue === 'not-understood'
      ? `agent-companion: WRITER effort not understood — in "${writerRaw}", "${writer.effortToken}" is not an effort ` +
        `level (${levels}), so only the writer's model (${wm}) is used and parity is checked on the model alone. ` +
        `Write it as ${example}.`
      : writer.effortIssue === 'agent-none'
        ? `agent-companion: WRITER agent "${writer.agent}" states no effort in its definition (it ran at its session's ` +
          'effort), so only the model half of reviewer parity is checked. Name the effort it ran at: ' +
          `\`WRITER: ${writer.agent}/<effort>\`.`
        : `agent-companion: the WRITER line ("${writerRaw}") names no effort, so only the model half of reviewer ` +
          `parity is checked. Write it as ${example} to check effort too.`;
  }
  // TYPE: code-review (or any parity-sized type) with no usable writer: the
  // table sizes a reviewer from its writer, so without one it cannot size
  // this spawn at all. Said once here; the warrant soft note below reuses
  // it instead of claiming no TYPE was declared.
  const parityNoWriter = typeIsParity && !route && opt('fit_guard', true);
  const parityNoWriterNote = parityNoWriter && !fit?.parityFloor && !pinned
    ? `agent-companion: TYPE: ${declaredType} is sized from its writer, and this brief names no usable writer, so ` +
      'the routing table cannot size this reviewer. Add a line `WRITER: <model>/<effort>` (e.g. `WRITER: opus/xhigh`) ' +
      'or `WRITER: <agent-name>` (e.g. `WRITER: ac-opus-xhigh`) naming the writer this review gates.'
    : null;

  // --- Reviewers never spawn reviewers (self-review, 2026-09-28) -----------
  // A parity-sized review (TYPE: code-review) spawned by a subagent is looked
  // up against the CALLER's own spawn row: the caller's agent_id names its
  // sidecar (<session>/subagents/agent-<agent_id>.meta.json), the sidecar's
  // toolUseId is the Agent call that spawned it, and every spawns.jsonl row
  // now records its own call's tool_use_id (lib/self-review.mjs
  // callerSpawnRow). DENIED only on that positive, exact match: the caller's
  // own row declares a parity type, so the caller IS a reviewer. Anything
  // short of it — no sidecar, no toolUseId, no row with that id (a row from
  // before this field, spawn_telemetry off at the time, beyond the bounded
  // read), rows that disagree — is unknown, and unknown allows. A writer's
  // review of its own work (its row declares a writer type, or none) is
  // allowed: that is the self-review flow. `review_recursion_guard: false`
  // turns the deny off; the lookup still runs for telemetry. (callerRow and
  // callerDeclaredType are read above, before the parity route.)
  const reviewByReviewer = !!callerDeclaredType && isParityType(callerDeclaredType);
  const recursionDeny = reviewByReviewer && opt('review_recursion_guard', true);
  let srCfg = null;
  try { srCfg = selfReviewConfig(); } catch { srCfg = null; }
  // A parity review spawned by a subagent whose caller is not positively a
  // reviewer (the broad count), and the narrow one the self-review flow is
  // measured on: the caller's own row was FOUND and declares a type listed in
  // selfReview.types, so this is a writer reviewing itself.
  const reviewBySubagent = typeIsParity && subagentCaller && !reviewByReviewer;
  const selfReviewSpawn = reviewBySubagent && !!callerDeclaredType && !!srCfg && srCfg.types.includes(callerDeclaredType);

  // --- A self-reviewing writer sizing its own reviewer below itself --------
  // The WRITER line always wins over inference, so a writer can name a pair
  // below its own and the parity route follows it. When the caller is
  // positively a self-reviewing writer (selfReviewSpawn) and names a WRITER,
  // compare it with the caller's own pair (its definition, checked against
  // the model it was seen running) and say so when it is lower. Notes only.
  let writerBelowCallerNote = null;
  if (selfReviewSpawn && decls.WRITER && writer && !writerInferred && opt('fit_guard', true)) {
    try {
      const own = writerFromCaller(p, callerObserved);
      if (own.ok) {
        const tiers = modelTiers().tiers || {};
        const rank = (a) => (tiers[a] && typeof tiers[a].rank === 'number' ? tiers[a].rank : null);
        const rw = rank(writer.model), ro = rank(own.model);
        const effortLower = writer.model === own.model && own.effort && writer.effort
          && classifyEffort(writer.effort).rank < classifyEffort(own.effort).rank;
        if ((rw !== null && ro !== null && rw < ro) || effortLower) {
          writerBelowCallerNote = `agent-companion (self-review): the WRITER line names ${writer.label}, but the agent ` +
            `spawning this review ("${own.agent}", spawned as TYPE: ${callerDeclaredType}) runs at ${own.label}. A writer ` +
            `reviewing its own work names its own pair: \`WRITER: ${own.label}\`, on the rung that matches it.`;
        }
      }
    } catch { writerBelowCallerNote = null; }
  }

  // --- Project-agent routing, first half (project_route_guard: autofix | warn | off) ---
  // The routing table governs ladder (ac-*) spawns; a project or user agent pinned to opus used to bypass
  // it (measured 10-02 to 10-23: project agents pinned to opus took 20.1% of all usage, spawned for
  // bounded-feature and integration briefs the table sends to sonnet). A spawn that would run an opus
  // definition from <project>/.claude/agents or ~/.claude/agents is therefore judged by the brief's TYPE
  // against the live table (the route resolved above, the same resolver the ladder uses):
  //   - the table puts the TYPE on a non-opus model: the spawn is rewritten silently (updatedInput.model,
  //     which the harness lets replace the agent file's model); the agent keeps its own instructions and
  //     effort. One telemetry row, guard `routing-autofix`. A `PREMIUM: <reason>` line skips the rewrite;
  //   - the table keeps the TYPE on opus (debug-root-cause, novel-design, ...): untouched;
  //   - no usable TYPE (the plugin has no brief classifier to infer one): untouched, one row logs it;
  //   - warn mode: untouched, with a visible note, and the same row.
  // Nothing here denies. A model parameter that already replaces the opus pin is not an opus spawn.
  // Decided HERE, before the self-review block and the spawns.jsonl row, so both see the model that
  // will actually run (a rewritten sonnet writer is not told to use an opus reviewer, and the spawn
  // row does not claim opus). The row, the allow and the warn note come later (second half).
  let projectRoutePlan = null;
  {
    const prModeRaw = String(opt('project_route_guard', 'autofix')).toLowerCase();
    const prMode = ['autofix', 'warn', 'off'].includes(prModeRaw) ? prModeRaw : 'autofix';
    if (prMode !== 'off' && pin.pinned && pin.fields !== 'effort' && fromDef
      && classifyModel(fromDef).alias === 'opus' && spawnAlias === 'opus') {
      let pr = route && route.model ? route : parityYardstick;
      if (!pr && declaredType) { try { const r = resolveRoute({ type: declaredType }); if (r.model) pr = r; } catch { /* table unreadable */ } }
      const premiumReason = !!decls.PREMIUM && String(decls.PREMIUM.rest || '').replace(/[\s*_`]/g, '').length > 0;
      const basis = declaredType ? `TYPE ${declaredType}` : 'no usable TYPE';
      if (pr && pr.model) {
        const prAlias = classifyModel(pr.model).alias;
        if (prAlias && prAlias !== 'opus' && prAlias !== 'fable' && !premiumReason) {
          projectRoutePlan = { pr, fromDef, basis, action: prMode === 'autofix' ? 'autofix' : 'warn' };
          if (prMode === 'autofix') {
            model = pr.model;
            updatedInput = { ...(updatedInput || input), model };
          }
        }
      } else if (!typeIsParity && !(declaredType && canonicalTaskType(declaredType))) {
        projectRoutePlan = { pr: null, fromDef, basis, action: 'untyped' };
      }
    }
  }

  // --- Is this writer expected to review itself? ---------------------------
  // For a TYPE listed in config/model-tiers.json selfReview.types: false when
  // the brief opts out (`REVIEW: lead`), else whether the definition that
  // will run carries the generated protocol (lib/self-review.mjs
  // definitionCarriesProtocol: true, false for a ladder rung without it or a
  // built-in type, null for another agent file that may word it its own
  // way). null for every other TYPE.
  //
  // A LADDER RUNG without the block (a routing profile, a local copy of the table or
  // a deliberate choice put the type on a rung the shipped table does not
  // route it to) gets the same generated text appended to its brief instead
  // (review round, 2026-09-28): the rung that matches what will run, so its
  // WRITER line and reviewer rung are its own. A built-in type (no
  // definition, so its effort is not pinned) and a pair that is no rung get
  // nothing appended and a note: the lead reviews that writer, as before.
  let selfReviewExpected = null;
  let selfReviewNote = null;
  let selfReviewInjected = false;
  try {
    const sr = srCfg || selfReviewConfig();
    if (declaredType && sr.types.includes(declaredType)) {
      if (optedOut(brief, sr)) {
        selfReviewExpected = false;
      } else {
        const runningType = ladderRewrite ? ladderRewrite.to : input.subagent_type;
        selfReviewExpected = definitionCarriesProtocol(runningType, def);
        // A project-pinned writer whose file holds no protocol block (null: it
        // may word one itself, but carries none of ours) gets the same text as
        // a ladder rung without it, sized to the pair its pin runs; the lead
        // opts out per spawn with the same `REVIEW: lead` line.
        const pinnedNoBlock = pinned && selfReviewExpected === null;
        // A brief that states no CONSEQUENCE still carries its type's
        // preset: a critical type's self-review names the critical
        // review rung. Text only; no guard decision reads this value.
        let reviewConsequence = consequenceWasDeclared ? declaredConsequence : null;
        if (!consequenceWasDeclared) {
          try { if (taskTypeDef(declaredType)?.def?.consequence === 'critical') reviewConsequence = 'critical'; } catch { /* table unreadable */ }
        }
        if (selfReviewExpected === true) {
          // The definition carries the generated block, which names the
          // writer's OWN rung as its reviewer (generated with no operator
          // config in it). The operator's reviewerEffortFloor and
          // reviewerEffortCap and a critical consequence still apply, so when
          // the recommender names another rung, say so in two lines. Never a
          // second copy of the protocol, and not counted as an injection.
          const brung = pinned
            ? pinnedInjectionRung(def, model, callerEffort)
            : injectionRung(runningType, def, model);
          const rv = brung ? reviewerRungFor(brung, { writerType: declaredType, consequence: reviewConsequence }) : null;
          if (rv) {
            const own = `${brung.model}${brung.effort ? '/' + brung.effort : ''}`;
            const rvPair = `${rv.model}${rv.effort ? '/' + rv.effort : ''}`;
            selfReviewSuffix = '\n\n---\n(agent-companion: reviewer rung for this brief.)\n' +
              `Spawn your reviewer on subagent_type "agent-companion:${rv.agent}" (${rvPair}); this replaces the rung ` +
              `your self-review section names. Keep \`WRITER: ${own}\` in the reviewer's brief.\n`;
          }
        }
        if (selfReviewExpected === false || pinnedNoBlock) {
          const rung = pinnedNoBlock
            ? pinnedInjectionRung(def, model, callerEffort)
            : injectionRung(runningType, def, model);
          if (rung) {
            selfReviewSuffix = selfReviewBriefText(rung, sr, undefined, {
              writerType: declaredType, consequence: reviewConsequence,
            });
            selfReviewInjected = true;
            selfReviewExpected = true;
          } else if (opt('fit_guard', true)) {
            // Name a rung only when its INSTALLED file carries the block: a
            // local copy of the table moves the route but not the installed files.
            let home = null;
            // A pinned agent is never pointed at another rung: its pin is the choice.
            if (pinnedNoBlock) selfReviewExpected = false;
            else try {
              const r = resolveRoute({ type: declaredType });
              const hr = r.model && r.effort ? rungFor(r.model, r.effort) : null;
              const hdef = hr ? agentDefinition(`agent-companion:${hr.agent}`, p.cwd) : null;
              home = hr && definitionCarriesProtocol(hr.agent, hdef) === true ? `agent-companion:${hr.agent}` : null;
            } catch { home = null; }
            selfReviewNote = `agent-companion (self-review): TYPE: ${declaredType} is a self-reviewing type, but ` +
              `"${runningType || 'general-purpose'}" carries no self-review protocol and is no ladder rung it can be added ` +
              `to, so this writer will not spawn its own reviewer, and the lead reviews it` +
              `${home ? `. Spawn ${home} (its routed rung) for a self-reviewed result` : ''}; ` +
              `add \`${sr.optOut.line}\` to say the lead reviews it on purpose.`;
          }
        }
      }
    }
  } catch { selfReviewExpected = null; selfReviewNote = null; selfReviewInjected = false; selfReviewSuffix = ''; }

  if (opt('spawn_telemetry', true) && !isCanary) {
    // --- Schema v2 additions: who is spawning, and at what effort ----------
    // callerTranscript/callerMeta/callerModel/callerEffort are computed once,
    // above (shared with the non-ladder-escalation advisory), from the
    // CALLER's OWN transcript (not the new subagent's — it does not exist yet
    // at PreToolUse time), via a bounded tail so this never risks the hook's
    // timeout on a large session.
    const description = typeof input.description === 'string' ? input.description : null;
    const descSha = description ? createHash('sha256').update(description).digest('hex').slice(0, 16) : null;
    const descLen = description ? description.length : null;

    // spawn_effort: the SPAWN's own effort, not the caller's. The agent's own
    // frontmatter wins when it declares one. A model whose tier lists no
    // `efforts` takes no effort parameter at all, so there is nothing to
    // inherit (no current tier has an empty list). Otherwise built-in types run at whatever
    // effort the caller itself is running (measured 285 of 285 in practice).
    const noEffortModel = !!model && (() => {
      const sup = effortSupported(model, 'high');
      return !sup.ok && sup.supported.length === 0;
    })();
    let spawnEffort = null;
    let spawnEffortSource = 'none';
    if (def?.effort) {
      spawnEffort = def.effort;
      spawnEffortSource = 'definition';
    } else if (!noEffortModel && callerEffort) {
      spawnEffort = callerEffort;
      spawnEffortSource = 'inherited';
    }

    // effective_effort: what will ACTUALLY run, for joining against a
    // transcript's own output_tokens later to get tokens-per-effort per
    // model — session transcripts do not record effort themselves, so this
    // is the only place that fact is captured.
    //
    // CORRECTED premise (was: "falls back to the model's own API default").
    // Per Claude Code's sub-agents docs (code.claude.com/docs/en/sub-agents,
    // quoted directly): a subagent definition with no `effort` frontmatter
    // "inherits from session" — it runs at whatever effort the ORCHESTRATING
    // SESSION currently has, not the model's bare API default. The model
    // default is reached only when NOTHING else sets a level (a bare API call
    // outside any Claude Code session), which does not describe a spawn made
    // through this hook. So an unstated effort is recorded as
    // "inherited(<parent session's effort, or 'unknown' if the hook payload
    // does not expose it>)" — the same shape as `caller_effort` above, which
    // is exactly the fact being inherited here.
    let effectiveEffort = null;
    if (def?.effort) {
      effectiveEffort = def.effort;
    } else if (!noEffortModel && model) {
      effectiveEffort = `inherited(${callerEffort || 'unknown'})`;
    }

    appendLog('spawns.jsonl', {
      at: new Date().toISOString(),
      session_id: sid,
      ...leadLive,
      // Which copy of the guard wrote this row (plugin version, cache,
      // checkout or bundle, install scope key) and when this session last
      // loaded its plugins. The daily scout reads these across sessions to
      // catch a stale copy still guarding spawns after an update
      // (scripts/detect.mjs, stale_copy_loaded) — the one channel that
      // sees a session whose own hooks are all stale.
      ...runningCopyStamp(p.cwd, sid, loadedAtMs),
      subagent_type_rewritten_to: ladderRewrite ? ladderRewrite.to : null, // the ladder rung autofill swapped a general-purpose spawn to
      spawned_by_agent_type: p.agent_type,
      model: model || '(inherited)',      // effective model, when knowable (autofilled counts)
      model_declared: declared || null,   // named at the spawn site
      model_definition: (ladderRewrite ? def?.model : fromDef) || null, // named in the frontmatter of the agent that runs (the rung, after a rewrite)
      model_autofilled: autofilled,       // the guard set it from the table
      inherited: trulyInherited,          // true when NEITHER the spawn nor the definition named one
      subagent_type: input.subagent_type,
      run_in_background: typeof input.run_in_background === 'boolean' ? input.run_in_background : null,
      isolation: input.isolation ?? null,
      name: input.name ?? null,          // as declared at the spawn site (null when namegate later assigned one)
      name_effective: (input.name || namegateName) ?? null, // what the spawn actually ran under, namegate included
      team_name: input.team_name ?? null,
      desc_sha: descSha,       // sha256(description).slice(0,16) — hashed, never stored raw
      desc_len: descLen,
      caller_is_subagent: subagentCaller,
      caller_agent_id: p.agent_id || null,
      caller_model: callerModel,
      caller_effort: callerEffort,        // the CALLER's effort — what v1 `effort` held
      spawn_effort: spawnEffort,          // the SPAWN's own effort
      spawn_effort_source: spawnEffortSource, // definition | inherited | none
      effective_effort: effectiveEffort,      // definition value, "inherited(<parent effort|unknown>)", or null (no-effort model)
      effort_definition: def?.effort || null,
      declared_weight: declaredWeight,   // null when the brief did not say (may be filled from declared_type's own preset)
      declared_kind: declaredKind,
      declared_consequence: declaredConsequence,
      declared_type: declaredTypeRaw,    // the brief's TYPE: value as written (null when none); an alias stays as written
      declared_type_resolved: declaredTypeRaw && declaredType !== declaredTypeRaw ? declaredType : null, // the canonical type an alias resolved to
      declared_role: declaredRole,       // the brief's ROLE: value (reviewer|fixer|lander|writer|docs|lookup|operate|other); null when absent or not one of those
      fit_trial: route?.trial ? true : false, // true when the fit judgement used a ROUTING TRIAL override, not the plain grid
      route_layer: route?.layer || null,  // profile | trial | grid: which resolveRoute() layer answered; null when no route
      route_profile_rev: route?.layer === 'profile' ? (route.profileRevision ?? null) : null, // routing-profile revision behind a profile answer; null for every other layer. The row's content is never logged.
      fit: autofilled ? 'fit' : fit ? fit.verdict : null, // over | under | fit | unknown, when a weight was declared
      fit_expected: routeLabel || (fit?.parityFloor ? parityFloorLabel : null),
      // true when the model came from a routing choice (a matching route or
      // autofill, a ladder rung or other definition pin, or a reviewer on
      // its floored parity route); false when it was inherited or set
      // per-spawn with no route naming it, and always for fable. Meant for
      // the scout's premium count (the audit-signals track: premium rows
      // with `routed === false`). Broader than the cap's exemption, which
      // still counts ac-opus-max and other plugins' agents. Older rows carry
      // no field at all.
      routed,
      declared_writer: writer && !writerInferred ? writer.label : null, // the WRITER line, resolved to model/effort; null when absent or unusable
      // --- Self-review (2026-09-28) ----------------------------------------
      // The Agent call's own id (PreToolUse tool_use_id). The harness writes
      // the same id as `toolUseId` in the spawned agent's sidecar
      // (subagents/agent-<agent_id>.meta.json), which is how a later spawn BY
      // that agent finds this row (lib/self-review.mjs callerSpawnRow).
      tool_use_id: typeof p.tool_use_id === 'string' ? p.tool_use_id : null,
      parent_agent_id: p.agent_id || null, // the agent that made this spawn (same value as caller_agent_id); null = the main thread
      inferred_writer: writerInferred ? writerInferred.label : null, // a review's writer read from its caller's definition (no WRITER line)
      self_review: selfReviewSpawn,      // a parity review by a subagent whose own row was FOUND and declares a selfReview type
      review_by_subagent: reviewBySubagent, // the broad count: a parity review by a subagent whose row is not positively a review
      self_review_expected: selfReviewExpected, // for a selfReview TYPE: will this writer review itself? null for other types
      self_review_injected: selfReviewInjected, // the protocol was appended to this writer's brief (a ladder rung without it)
      // --- Project pins (0.31.13) --------------------------------------------
      project_pinned: pinned,            // a project or user agent whose own definition pins model and/or effort (and project_pins is on): not judged by weight, never rewritten
      pin_scope: pinned ? pin.scope : null,   // project | user
      pin_fields: pinned ? pin.fields : null, // model | effort | model+effort
      pin_model_overridden: pinModelOverridden, // pinned, and the call's `model` names a different alias than the definition's
      // --- Where the definition was looked up (0.31.22) -------------------------
      // Folders are recorded as path keys ("path:" + 12 hex of a hash), never as paths: rows are path-free and the opt-in upload sends them as written.
      cwd: pathKey(p.cwd),                                // the spawner's working directory when the hook ran
      project_root: pathKey(resolvedProjectRoot(p.cwd)),  // nearest .git folder at or above it (8 levels), else the session's project folder, else null
      project_dir_env: pathKey(claudeProjectDir()),       // CLAUDE_PROJECT_DIR as the harness gave it to the hook, else null
      caller_row_found: callerRow ? callerRow.state === 'found' : null, // the caller's own spawn row was found by tool_use_id; null when not looked up
      caller_declared_type: callerDeclaredType, // that row's declared_type; null when not found or none declared
      // The caller's own Agent call id, from its sidecar: joins this review's
      // row to its writer's row (that row's tool_use_id) from spawns.jsonl alone.
      caller_tool_use_id: callerRow && typeof callerRow.toolUseId === 'string' ? callerRow.toolUseId : null,
      consequence_from_caller: consequenceFromCaller, // declared_consequence "critical" came from the caller's own TYPE (F1)
      // --- Memory nudge/brief observability -------------------------------
      // null across the board when the feature never ran for this spawn
      // (memory_search/memory_brief off, or mode "off") — distinct from
      // `attached: false`, which means it ran and had nothing to say.
      memory_addition_mode: memoryFacts ? memoryFacts.mode : null,
      memory_addition_attached: memoryFacts ? !!memoryFacts.attached : null,
      // nudge-mode facts (null when the row came from pointers mode instead)
      memory_addition_here_count: (memoryFacts && typeof memoryFacts.hereCount === 'number') ? memoryFacts.hereCount : null,
      memory_addition_other_count: (memoryFacts && typeof memoryFacts.otherCount === 'number') ? memoryFacts.otherCount : null,
      memory_addition_repo_count: (memoryFacts && typeof memoryFacts.repoFileCount === 'number') ? memoryFacts.repoFileCount : null,
      // pointers-mode facts (null when the row came from nudge mode instead)
      memory_addition_hit_count: (memoryFacts && typeof memoryFacts.hitCount === 'number') ? memoryFacts.hitCount : null,
      memory_addition_top_score: (memoryFacts && typeof memoryFacts.topScore === 'number') ? memoryFacts.topScore : null,
      // shared: which candidate resolveMemoryScopeDir() actually used — see
      // its precedence in hooks/lib/memory-index.mjs. This is the field that
      // makes the worktree-scope bug fix itself observable going forward:
      // "worktree-main" firing on a worktree spawn is the fix working.
      memory_addition_here_source: memoryFacts ? (memoryFacts.hereSource || null) : null,
      // --- Spawn-shape gate outcomes (additive v2 fields) -----------------
      silent_fixes: silentFixes.length ? silentFixes : null, // what the guard fixed or logged without a message (background_set, role_inserted:<role>, fit_over_rewrite:<from>-><to>, fit_under_logged, foreground_logged)
      fit_before_fix: fitBeforeFix,      // 'over' when the spawn was rewritten to the routed rung (fit then reads 'fit')
      gate1_mode: gate1Mode,             // off | fix | block — the configured mode ("warn" reads as fix)
      gate1_applicable: gate1Applicable, // main-session caller, not already backgrounded
      gate1_exempt: gate1Exempt,         // applicable, but excused: resolved model is the cheapest known tier
      gate1_action: gate1Action,         // none | fix | block — what THIS spawn actually got (fix = run_in_background set silently)
      gate2_fired: gate2Fired,           // name+isolation both set: teammate silently demoted to subagent
      gate3_fired: gate3Fired,           // unnamed AND unisolated: shares the lead's tree, unaddressable
      gate4_applicable: gate4Applicable, // main-session, explicitly background, no name, namegate on
      gate4_action: gate4Action,         // none | hint | autofill — what THIS spawn actually got
      name_autofilled: gate4Action === 'autofill', // namegate set `name` via updatedInput
    });
  }

  // --- Gate 1, block mode --------------------------------------------------
  // Checked before the isPremiumForSpawn early-return just below: spawn SHAPE
  // is orthogonal to model TIER, so this must apply the same way to a
  // premium spawn and a cheap one, not only to whichever one
  // isPremiumForSpawn lets fall through to the fit/warrant/cap checks.
  if (gate1Action === 'block') {
    recordDenial('foreground', p, `main-session foreground spawn (${input.subagent_type || 'an agent'}), no FOREGROUND justification`);
    deny(
      'Foreground guard: this is a MAIN-SESSION spawn with no run_in_background, so it will block the lead\'s ' +
      'entire turn until it returns.\n\n' +
      'Not Anthropic guidance - this plugin\'s own operating decision, from a measured baseline where most ' +
      'main-session spawns ran foreground and individual foreground spawns cost the operator 18-27 minutes of ' +
      'lockout apiece, unable to act on messages sent mid-turn.\n\n' +
      'Either add run_in_background: true, or add a line to the brief:\n' +
      '  FOREGROUND: <why this result is needed before the lead can continue>\n\n' +
      'If you cannot write that line honestly, background it.'
    );
  }

  // --- Gate 5: ladder rung needs a TYPE (type_line_required: deny) ---------
  // A rung spawn with no TYPE: (nor WEIGHT:, KIND:, a weighted WARRANT:) records
  // nothing about what the work was and checks no fit. Non-rung agents are never
  // gated. A worker spawning its own sub-worker gets the same rule.
  if (typeRequiredMissing && typeRequiredMode === 'deny') {
    recordDenial('type-required', p, `${input.subagent_type} brief has no TYPE:, WEIGHT: or KIND: line${subagentCaller ? ' (spawned by a subagent)' : ''}`);
    const trExamples = commonTypeRoutes();
    deny(
      `Type guard: this spawn ${subagentCaller ? '(made by a worker, for its own sub-worker) ' : ''}names ladder rung "${input.subagent_type}" ` +
      'but the brief has no TYPE: line (and no WEIGHT: or KIND: line that stands in for it), so nothing records what the work was ' +
      'or checks that the rung fits.\n' + '\n' +
      'Add a line of its own to the brief:\n' +
      '  TYPE: <task type>\n' +
      (trExamples ? `Current routes: ${trExamples}. ` : '') +
      'Nearest types: lookup (find or read something and report), survey (sweep many files for a conclusion), ' +
      'bounded-feature, mechanical-edit, code-review. Full list: `' + RECOMMEND_CMD + ' --list`.\n' +
      'Add ROLE: <reviewer|fixer|lander|writer|docs|lookup|operate|other> beside it. ' +
      'WEIGHT: or KIND: lines are still accepted when no type fits.' +
      (subagentCaller ? '\n\nYou are a worker spawning a worker: put the TYPE: line in the sub-worker brief yourself; the lead TYPE does not carry over.' : '') +
      '\n\nSet type_line_required to "warn" to downgrade this to a note.'
    );
  }

  // --- Inherit guard, block mode (inherit_guard: "block") -----------------
  // Before the early allow below, like Gate 1: an inherited spawn names no
  // model, so it is never premium for this spawn and would otherwise pass.
  if (inheritBlock) {
    recordDenial('inherit', p, `${input.subagent_type || 'an agent'} would inherit model and effort from a ${callerAlias} lead; ` +
      (declaredType ? `TYPE ${declaredType} is unknown and no WEIGHT` : 'no TYPE or WEIGHT'));
    const rewritable = !input.subagent_type || input.subagent_type === 'general-purpose';
    const examples = commonTypeRoutes();
    const exampleRung = routedRung('subagent-worker')?.type || 'agent-companion:ac-sonnet-low';
    deny(
      `Inherit guard: this spawn names no model, and its definition${input.subagent_type ? ` ("${input.subagent_type}")` : ''} ` +
      `states neither model nor effort, so it would run on the lead's own ${leadLabel || callerAlias} — model AND effort ` +
      'inherited, chosen by nobody' +
      (declaredType ? ` (TYPE: ${declaredType} is not a task type the table knows, so it routes nothing. ${unknownTypeHint(declaredType).replace(/^"[^"]*" is not a task type\. /, '')})` : '') +
      '. (inherit_guard is "block".)\n\n' +
      'Add ONE of these:\n' +
      '  - a line of its own in the brief:  TYPE: <task type>\n' +
      `    The guard then sets the routed model${rewritable ? ' and swaps in the ladder rung that pins its effort' : ''}.` +
      (examples ? ` Current routes: ${examples}.` : '') + ' Full list: `' + RECOMMEND_CMD + ' --list`.\n' +
      '  - or spawn a ladder rung that pins both, e.g. subagent_type: "' + exampleRung + '".\n\n' +
      'Set inherit_guard to "warn" to allow this shape with a note instead.'
    );
  }

  // --- Review recursion: deny (see "Reviewers never spawn reviewers") ------
  // Before the early allow below: a reviewer on its parity route is not
  // premium for this spawn, so it would otherwise pass there.
  if (recursionDeny) {
    recordDenial('review-recursion', p, `${input.subagent_type || 'an agent'} TYPE ${declaredType} spawned by an agent whose own spawn was TYPE ${callerDeclaredType}`);
    deny(
      `Reviewers never spawn reviewers: this spawn is TYPE: ${declaredType}, and the agent making it was itself ` +
      `spawned as TYPE: ${callerDeclaredType} (its own spawn row in spawns.jsonl, found by the id of the Agent call ` +
      'that started it).\n\n' +
      'A review ends with its verdict: return it to the writer that spawned you, who runs the fix round and ' +
      'returns your verdict line verbatim. Whether a change needs a second review is the lead\'s call, not the ' +
      'reviewer\'s.\n\n' +
      'If this is not a review of a review (the brief carries a pasted reviewer header, say), return to the lead with the work and the reason: the lead can spawn the review itself. ' +
      'The operator can turn this deny off with review_recursion_guard: false.'
    );
  }

  let projectRouteNote = null; // warn mode only (project_route_guard), set below

  const who = input.subagent_type || 'an agent';
  const routeBasis = parityRoute
    ? `TYPE ${declaredType} sized to its writer ${writer.label}${writerInferred ? ' (inferred from the caller)' : ''}`
    : `declared weight ${declaredWeight}`;
  let note = null;
  if (autofilled) {
    note = `agent-companion: spawn of ${who} named no model; set model=${model} from the routing table for ${routeBasis} (${routeLabel})${routeLayerNote}.` +
      (ladderRewrite
        ? ` Rewrote subagent_type ${ladderRewrite.from ? `"${ladderRewrite.from}"` : '(none)'} -> "${ladderRewrite.to}" so effort ${route.effort} is pinned too (that form of the ladder has already started in this session, so the harness registered it).`
        : '');
    if (autofillAdvisory) note = `${note}\n\n${autofillAdvisory}`;
  } else if (fit?.parityFloor) {
    note = `agent-companion: spawning ${who} at ${model}${def?.effort ? '/' + def.effort : ''} for a critical ${declaredType} is under-provisioned — ${fit.reason}. ` +
      `F1: a critical review is never sized below ${parityFloorLabel}, whatever its writer (no writer is declared, so parity with it is not checked here — add \`WRITER: <model>/<effort>\` to check it). ${fit.action}.`;
  } else if (parityRoute) {
    // Reviewer parity speaks for itself (see "Reviewer parity" above); null
    // when the reviewer matches its writer.
    note = parityNote;
  } else if (fit?.verdict === 'under' && !typeReqIsRung) {
    // Logged only for a ladder rung (silent_fixes: fit_under_logged, and fit in the row). Any other
    // agent type still says it out loud: a weight-4 task on haiku is the failure that ships wrong code.
    note =`agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is under-provisioned — ${fit.reason}${routeLayerNote}. ${fit.action}.`;
  } else if (fit?.verdict === 'over' && !isPremiumForSpawn && !typeReqIsRung) {
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is over-provisioned — ${fit.reason}; the table says ${routeLabel}${routeLayerNote}. Re-spawn there unless the weight is understated.`;
  }
  // Haiku-trial leak, advisory only (0.31.17, operator 2026-10-13): the resolved route
  // (the same route/fit the fit judgement above used, recorded as fit_expected) is a
  // Haiku rung but the spawn asks for another model. Counted by the haiku_fit_leak scout
  // signal. Never denies; silent with a REASON: or WARRANT: line, on a pinned spawn, or
  // when the route is not haiku.
  const haikuLeakNote = (fit && !autofilled && !pinned && !(decls.REASON && String(decls.REASON.rest || '').replace(/[\s*_`]/g, '')) && !decls.WARRANT
    && /^haiku\b/i.test(routeLabel) && model && spawnAlias !== 'haiku')
    ? `agent-companion: TYPE ${declaredType || 'this spawn'} routes to ${routeLabel} (Haiku trial, review 2026-10-19) but this spawn asks for ${model}. ` +
      'That counts as a trial leak (the haiku_fit_leak scout signal reports these). Add a one-line `REASON: <why Haiku cannot do this>` to the brief, or spawn the Haiku rung.'
    : null;
  // A pinned spawn is the operator's own tier choice: no weight or parity note.
  // (The fit value is still computed and recorded, so table-vs-pin stays measurable.)
  if (pinned) note = null;
  // Set only in the warrant section below (routing-can't-be-inferred case);
  // declared here so it is defined for the early-exit combineNotes() call
  // too, even though that branch can never actually populate it (it only
  // runs once we are already past the point where isPremiumForSpawn is
  // known true — see the warrant section).
  let warrantSoftNote = null;
  // A ladder spawn whose brief names a tool the ladder workers drop: say where
  // to go instead. A browser variant keeps the browser, so it is never told this.
  const ranAs = ladderRewrite ? ladderRewrite.to : input.subagent_type;
  const ranBare = ranAs && String(ranAs).startsWith(`${pluginName()}:`) ? String(ranAs).slice(pluginName().length + 1) : ranAs;
  const ranIsBrowserVariant = browserVariants.some((v) => v.agent === ranBare);
  let toolNote = null;
  if (isLadderSpawn && !ranIsBrowserVariant) {
    if (neededTools.browser) {
      const v = browserVariantFor(model);
      toolNote = 'agent-companion: this brief names the browser, which the ladder workers drop (their definitions disallow it). ' +
        (v ? `Spawn "${pluginName()}:${v.agent}" (${v.model}/${v.effort}) for UI and browser work.` : 'Drive the browser from the lead or a general-purpose spawn.');
    } else if (neededTools.other) {
      toolNote = 'agent-companion: this brief names Artifact or a desktop-only tool (visualize, terminal, ccd_session), which the ladder workers drop. ' +
        'Do that step from the lead, or spawn general-purpose with an explicit model.';
    } else if (neededTools.skill) {
      toolNote = 'agent-companion: this brief asks the worker to load a skill, and the ladder workers have no Skill tool. ' +
        'Name the skill\'s SKILL.md path in the brief for the worker to Read, or do that step from the lead.';
    }
  }
  // Every note this spawn carries, in order. The parity notes stand in for
  // the generic ones they would repeat: the inherited-effort parity note for
  // the rule-1 no-effort note, and the missing-model note or the writer-less
  // warrant note (each already asks for the WRITER line) for the writer-less
  // parity note.
  const notes = () => combineNotes(
    note,
    (missingModelNote || (parityNoWriter && warrantSoftNote) || writerInferNote) ? null : parityNoWriterNote,
    writerNote,
    writerInferredNote,
    writerInferNote,
    writerEffortNote,
    selfReviewNote,
    // (0.31.7) No lead-facing message when the protocol is appended to a brief:
    // it fired on every writer spawn and the lead can do nothing with it. The
    // append itself (selfReviewInjected, withAdditions) is unchanged.
    writerBelowCallerNote,
    gateMessage,
    missingModelNote,
    parityInheritedEffort ? null : noEffortStatedNote,
    buildFloorNote,
    warrantSoftNote,
    haikuLeakNote,
    toolNote,
    pinReplacedNote,
    projectRouteNote,
  );

  // --- Project-agent routing, second half (decided earlier: see projectRoutePlan) ---
  if (projectRoutePlan) {
    const { pr, fromDef: prFrom } = projectRoutePlan;
    const prRow = (outcome, toModel) => {
      if (isCanary) return;
      appendLog('denials.jsonl', {
        at: new Date().toISOString(),
        session_id: String(sid),
        agent_type: p.agent_type,
        ...(subagentCaller ? { agent_id: String(p.agent_id) } : {}),
        tool_name: p.tool_name,
        guard: 'routing-autofix',
        outcome,
        subagent_type: input.subagent_type || null,
        declared_type: declaredType || null,
        from_model: prFrom,
        to_model: toModel || null,
        detail: `${input.subagent_type} (${pin.scope} agent) pins ${prFrom}; ${projectRoutePlan.basis}${toModel ? ` routes to ${toModel}` : ''}`.slice(0, 300),
      });
    };
    if (projectRoutePlan.action === 'autofix') {
      prRow('autofix', pr.model);
      await notePending();
      // Silent: no systemMessage (the notes written for the pinned opus spawn no longer apply).
      // Not premium any more: the warrant and the cap do not apply to the rewritten spawn.
      allowWith(null, withAdditions({ ...(updatedInput || input), model: pr.model }), roleNudge);
    } else if (projectRoutePlan.action === 'warn') {
      prRow('warn', pr.model);
      const prRung = rungFor(pr.model, pr.effort || null);
      projectRouteNote = `agent-companion: ${input.subagent_type} (${pin.scope} agent pinned to ${prFrom}): the routing table sends ${declaredType ? `TYPE: ${declaredType}` : 'this brief'} ` +
        `to ${pr.model}${pr.effort ? '/' + pr.effort : ''}${routeLayerTag(pr.layer)}${prRung ? ` (agent-companion:${prRung.agent})` : ''}, not Opus. ` +
        `Spawn that rung or a project agent pinned to ${pr.model}, or add a \`PREMIUM: <reason>\` line to keep Opus. Not rewriting (project_route_guard is warn).`;
    } else if (projectRoutePlan.action === 'untyped') {
      prRow('untyped', null); // logged only
    }
  }

  if (!isPremiumForSpawn) {
    // HELD DECISION (ADR 0003 open question 8, 2026-09-24): counting a
    // route-exempt premium spawn toward the cap is implemented on
    // feat/ac-routing-profile-s1b (`if (isPremium(model))
    // await enforcePremiumCap(true);` here) but held from release. Under trial v2
    // most task types route to opus and the cap is machine-wide (2 per
    // rolling 10 min), so it would throttle nearly every spawn; that effect
    // needs the operator's explicit call. Until then a spawn whose route
    // names its model skips the cap, as before slice 1b.
    // Trial v3 (2026-09-27) makes it UNSAFE, not just costly: every listed
    // task type now routes to opus, so counting routed opus would cap nearly
    // all correctly routed work at 2 per 10 minutes, machine-wide. Keep held.
    await notePending();
    allowWith(notes(), withAdditions(updatedInput), roleNudge);
  }

  // --- Best fit, premium: deny ------------------------------------------
  // A premium tier for a declared weight the table sends elsewhere is the
  // over-provisioning this plugin exists to stop, stated by the spawner
  // itself. Deny with the exact correction rather than a nudge. Never on a
  // parity route: reviewer parity is a note in this release (a mis-read
  // WRITER line must not block a review), so a reviewer above its writer is
  // said out loud by the parity note instead.
  if (fit?.verdict === 'over' && !parityRoute && !pinned && !premiumDeclared) {
    recordDenial('fit', p, `${model} requested for declared weight ${declaredWeight}; table says ${routeLabel}`);
    deny(
      `Best fit: this spawn requests "${model}" but declares weight ${declaredWeight}` +
      (declaredKind ? ` (${declaredKind})` : '') +
      (declaredConsequence ? `, ${declaredConsequence} consequence` : '') +
      `, which the routing table sends to ${routeLabel}${routeLayerNote}. ${fit.reason}.\n\n` +
      `Either re-spawn at ${routeLabel}, or restate the brief honestly: a higher WEIGHT if the task ` +
      `is heavier than declared, or CONSEQUENCE: critical if a mistake would be expensive or ` +
      `irreversible (that raises the model floor). A warrant that contradicts its own weight is ` +
      `exactly the over-provisioning this guard exists to stop.`
    );
  }

  // --- Warrant -----------------------------------------------------------
  // Reaching this point means isPremiumForSpawn was true, which (fable
  // aside) only happens two ways: routing is KNOWN (a TYPE or WEIGHT
  // resolved a route) and DISAGREES with the requested model — but that
  // shape was already denied above by the best-fit check, EXCEPT when the
  // model is unrecognised by the tier table (fit verdict "unknown", not
  // "over" — the fit check only denies on "over") — or routing is UNKNOWN
  // entirely (no TYPE, no WEIGHT declared anywhere). Fable and a
  // known-but-disagreeing route are cases this guard CAN verify, so a
  // missing warrant still blocks. An unknown/unrecognised route is the
  // case the fix's own instruction calls out: warn, don't block, since
  // nothing here can confirm the premium tier either way.
  // A parity route is "known" but never denies here either (see the fit deny
  // above): a premium reviewer its route does not name gets the soft note.
  // A pinned spawn needs none: the pin is the operator's own warrant.
  if (opt('warrant_required', true) && !pinned) {
    // A `PREMIUM: <reason>` line is the lead's stated justification too (0.31.36): it keeps the spawned premium
    // rung past the fit rewrite, so it must also pass here.
    if (!warrantDeclared && !premiumDeclared) {
      if (spawnAlias === 'fable' || (routingKnown && !parityRoute)) {
        recordDenial('warrant', p, `premium tier ${model} requested with no warrant`);
        deny(
          (autofilled
            ? `Premium warrant: the routing table sends declared weight ${declaredWeight} to "${model}", a premium tier, and the brief states no justification.\n\n`
            : `Premium warrant: this spawn requests "${model}", a premium tier, with no stated justification.\n\n`) +
          `Add a line to the agent's brief in the form:\n` +
          `  WARRANT: weight <1-5> — <why a cheaper tier cannot do this>\n\n` +
          `If you cannot write that line honestly, the task does not warrant the tier — ` +
          `re-spawn at a cheaper tier (see \`${RECOMMEND_CMD}\`). These warrants are logged ` +
          `and audited, so a weak one is worse than a downgrade.`
        );
      } else {
        // Routing can't be inferred (no TYPE or WEIGHT; a TYPE that routes
        // nothing; a parity-sized TYPE with no writer), or it is reviewer
        // parity, which is judged in notes only — warn rather than block: a
        // false block here stops legitimate work the guard has no basis to
        // judge either direction. Each case says what it actually lacks.
        const warrantLine = '"WARRANT: weight <1-5> — <why a cheaper tier cannot do this>"';
        warrantSoftNote = parityRoute
          ? `agent-companion: this reviewer runs on ${model}, a premium tier its parity route (${routeLabel}) does ` +
            `not name, with no WARRANT line. Not blocking — reviewer parity is judged in notes only; add ${warrantLine} ` +
            'if the tier is deliberate.'
          : parityNoWriter
            ? `agent-companion: this spawn resolves to ${model}, a premium tier, with no WARRANT line — and ` +
              `TYPE: ${declaredType} is sized from its writer, which this brief does not name, so the routing table ` +
              'cannot size it. Not blocking. Add `WRITER: <model>/<effort>` (e.g. `WRITER: opus/xhigh`) or ' +
              '`WRITER: <agent-name>` (e.g. `WRITER: ac-opus-xhigh`): a reviewer on its writer\'s model needs no ' +
              `WARRANT. Or add ${warrantLine}.`
            : declaredType
              ? `agent-companion: this spawn resolves to ${model}, a premium tier, with no WARRANT line — and ` +
                `TYPE: ${declaredType} did not resolve a route (` +
                (!opt('fit_guard', true)
                  ? 'fit_guard is off, so the guard routes nothing'
                  : typeWeight === null
                    ? 'not a task type the table knows. ' + unknownTypeHint(declaredType).replace(/^"[^"]*" is not a task type\. /, '')
                    : 'the table has no row for it') +
                '), so the routing table has nothing to check it against. Not blocking. ' +
                `${!opt('fit_guard', true) ? 'Turn fit_guard on' : 'Name a known TYPE'} so the guard can judge fit, or add ${warrantLine}.`
              : `agent-companion: this spawn resolves to ${model}, a premium tier, with no WARRANT line — ` +
                'and no TYPE or WEIGHT is declared either, so the routing table has nothing to check it against. Not ' +
                'blocking: this guard cannot confirm the tier is unwarranted, only that it cannot confirm it IS ' +
                'warranted. Add a TYPE (or WEIGHT) line so the guard can judge fit, or add ' +
                `${warrantLine} to state it explicitly.`;
      }
    }
  }

  // --- Concurrency cap ---------------------------------------------------
  // Reached only by a spawn that is premium FOR THIS SPAWN (fable, or a
  // premium tier its route does not name). Counting route-exempt premium
  // spawns too (open question 8) is a HELD decision — see the early allow
  // above. `routeExempt` stays so that version is a one-line change.
  //
  // Not counted either (capExempt, computed with `routed` above): an opus
  // spawn pinned by an ac-opus-* rung other than ac-opus-max, or by a project
  // or user agent not named like a built-in type, and a reviewer on its
  // floored parity route. Counted: fable always; ac-opus-max; another
  // plugin's opus agent; a built-in-named definition pinning opus; and opus
  // that nobody routed — set per-spawn on a built-in type with no TYPE or
  // WEIGHT, or with a TYPE that routes nothing. (An inherited model is
  // unknown here, so it is never counted: see inherit_guard.) capCounts is
  // the same predicate the parity note's cap clause reads.
  if (capCounts) await enforcePremiumCap(false);
  async function enforcePremiumCap(routeExempt) {
    if (!opt('premium_cap', true)) return;
    // Loaded here, not at the top: only a premium spawn reaches the cap, and
    // the window module with the lock helper it loads cost ~1.6 ms cold on
    // every other spawn (0.29.0 final review F5).
    const {
      premiumWindowLive, PREMIUM_WINDOW_MS, withStateLock, premiumAgentType,
    } = await import('./lib/premium-window.mjs');
    const cap = Math.max(1, opt('premium_max_concurrent', 2));
    const f = stateFile('premium-window.json');
    const now = Date.now();
    // The whole read-count-write runs under the window lock, shared with
    // SubagentStart's confirmPremiumStart (lib/premium-window.mjs withStateLock): without
    // it a parallel burst of premium spawns each read the same count and all
    // passed the cap, and a guard and a start interleaving lost an entry.
    // deny() exits the process, so the verdict is acted on after the lock.
    const counted = withStateLock(f, () => {
      // Started spawns count for the window; a spawn not yet confirmed started
      // counts only while young (premiumWindowLive, lib/premium-window.mjs), so one the
      // harness rejects stops holding a slot instead of extending the block.
      const recent = premiumWindowLive(readJson(f, []), now);
      if (recent.length >= cap) {
        writeJsonAtomic(f, recent);
        return recent.length;
      }
      // A probe must not consume the cap. A teammate (team_name) is recorded as
      // started at once: there is no evidence SubagentStart fires for one, and
      // under-counting it would reopen the fan-out this cap exists to bound.
      // `atype` lets SubagentStart confirm this entry only on a start of the
      // same agent type (confirmPremiumStart, lib/premium-window.mjs).
      if (!isCanary) writeJsonAtomic(f, [...recent, { t: now, sid, confirmed: !!input.team_name, atype: premiumAgentType(ladderRewrite ? ladderRewrite.to : input.subagent_type) }]);
      return null;
    });

    if (counted !== null) {
      recordDenial('premium-cap', p, `${counted} premium agents in window, cap ${cap}`);
      // What would have kept this spawn out of the count, for its own shape.
      // The routes are read from the table at deny time, so the advice
      // follows the table instead of naming a tier it no longer routes to.
      const wait = 'or wait for the in-flight premium agents to finish.';
      let how;
      if (spawnAlias === 'fable') {
        how = 'Fable is never a routing destination, so no TYPE or rung can stand in for it: wait for the in-flight ' +
          'premium agents to finish, or raise premium_max_concurrent if a batch of warranted fable work genuinely needs it.';
      } else if (parityNoWriter) {
        how = `TYPE: ${declaredType} is sized from its writer, and this brief names none. Add \`WRITER: <model>/<effort>\` ` +
          '(e.g. `WRITER: opus/xhigh`) or `WRITER: <agent-name>`: a reviewer on its writer\'s model is not counted — ' + wait;
      } else if (parityRoute) {
        how = `This reviewer's ${spawnAlias || model} is not the model its WRITER sizes it to (${routeLabel}). Spawn ` +
          `${parityRungName || `the ladder rung for ${routeLabel}`}, which is not counted — ${wait}`;
      } else {
        const examples = commonTypeRoutes();
        how = 'Route it — a routed spawn is not counted:\n' +
          '  - declare the task type on a line of its own, `TYPE: <task type>`' +
          (examples ? `; current routes: ${examples}` : '') + ' (full list: `' + RECOMMEND_CMD + ' --list`);\n' +
          '  - or spawn the matching ladder rung by name (e.g. agent-companion:ac-opus-medium), which pins model and ' +
          'effort together;\n' +
          `  - ${wait}`;
      }
      deny(
        `Premium fan-out cap: ${counted} premium-tier agents already started in the last ` +
        `${PREMIUM_WINDOW_MS / 60000} minutes and the cap is ${cap}.\n\n` +
        `This is the exact shape of the four-Fable incident: each spawn looked reasonable ` +
        `alone, and nothing was counting them together.\n\n` +
        `${how}\n\n` +
        (routeExempt
          ? `(This spawn's own route names ${spawnAlias || model}, which exempts it from the WARRANT but not ` +
            `from this cap: the cap counts every premium-tier spawn by its tier, regardless of route.)\n\n`
          : '') +
        `(Concurrency is approximated by a rolling window, so a batch of genuinely-warranted ` +
        `premium work may need the cap raised in settings rather than worked around.)`
      );
    }
  }

  await notePending();
  allowWith(notes(), withAdditions(updatedInput), roleNudge);

  // An allowed spawn joins the session's pending list (lib/ladder-rewrite.mjs)
  // once the session is armed: by this spawn if it is a rewrite or a ladder
  // spawn (while rewriting can happen at all), or earlier. Recording EVERY
  // spawn from then on is what lets SubagentStart tie an unexpected start to
  // the rewritten spawn positively, rather than mistake a plain spawn of the
  // same type for it. Only allowed spawns: a denied one never starts. Not a
  // probe or a teammate (no evidence SubagentStart fires for one), and not
  // once a rewrite was found ignored (rewriting is off there).
  async function notePending() {
    try {
      if (isCanary || input.team_name) return;
      if (rewriteState && rewriteState.ignored) return;
      const arm = isLadderSpawn && opt('fit_guard', true) && opt('fit_autofill', true) && opt('fit_autofill_ladder', true);
      const armed = !!rewriteState && (typeof rewriteState.armedAt === 'number' || rewriteState.pending.length > 0);
      if (!ladderRewrite && !arm && !armed) return;
      const { notePendingSpawn } = await rewriteModule();
      notePendingSpawn(sid, {
        type: ladderRewrite ? ladderRewrite.to : (input.subagent_type || 'general-purpose'),
        from: input.subagent_type || 'general-purpose',
        rewrite: !!ladderRewrite,
        arm,
      });
    } catch { /* fail open */ }
  }
} catch {
  passthrough(); // never break a session
}
