// spawn-guard phase 5: the fit verdict and its silent fix, the premium cap's inputs, the parity and writer notes, and the review-recursion check.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import {
  classifyEffort, classifyModel, effortSupported, evaluateFit, modelTiers, opt, rungFor,
} from './context.mjs';
import { isParityType, selfReviewConfig, writerFromCaller } from './self-review.mjs';
import { definitionPinExempt, ladderRewriteTarget } from './sg-helpers.mjs';

export function fitAndParity({
  declaredWeight, typeIsParity, weightLineExplicit, fitOn, model, autofilled, route, def, declaredKind,
  declaredConsequence, parityRoute, parityFloor, decls, typeReqIsRung, pinned, rewriteState, sid, p,
  loadedAtMs, input, updatedInput, ladderRewrite, spawnAlias, routeMatchesModel, isPremiumForSpawn,
  silentFixes, fromDef, declared, parityYardstick, writer, routeLabel, modelTakesEffort, callerEffort,
  writerProblem, writerRaw, writerInferred, writerInferProblem, declaredType, callerDeclaredType,
  subagentCaller, callerObserved,
}) {

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
  // shown registered, a namespaced rung on the call itself included), with no message; the spawn
  // row records it (silent_fixes, fit_before_fix).
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
      const pick = rung ? ladderRewriteTarget(sid, rung.agent, p.cwd, loadedAtMs, input.subagent_type) : null;
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
  return {
    fit, premiumDeclared, fitBeforeFix, routed, capCounts, parityRungName, parityNote, parityInheritedEffort,
    writerNote, writerInferredNote, writerInferNote, writerEffortNote, parityNoWriter, parityNoWriterNote,
    recursionDeny, srCfg, reviewBySubagent, selfReviewSpawn, writerBelowCallerNote, updatedInput,
    ladderRewrite, def, model, spawnAlias, isPremiumForSpawn,
  };
}
