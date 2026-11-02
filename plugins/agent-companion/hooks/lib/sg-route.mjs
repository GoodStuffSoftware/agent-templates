// spawn-guard phase 2: the caller (subagent or lead, its model and effort), the writer of a review, and the routing table's answer for this spawn (route, parity floor, premium alias).
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import {
  callerIsSubagent, callerTranscriptPath, canonicalTaskType, classifyModel, isPremium, lastAssistantMeta,
  modelTiers, opt, resolveRoute, taskTypeDef,
} from './context.mjs';
import { leadEffortLive } from './lead-effort-live.mjs';
import { redoAlertCheck } from './redo-alert.mjs';
import { callerSpawnRow, isParityType, writerFromCaller } from './self-review.mjs';

export function resolveSpawnRoute({
  p, sid, isCanary, brief, decls, typeIsParity, writer, consequenceWasDeclared, declaredConsequence,
  weightWasDeclared, typeWeight, declaredType, declaredWeight, declaredKind, weightLineExplicit,
  kindWasDeclared, writerProblem, model,
}) {
  // The shared main-thread-or-subagent test (lib/context.mjs); =
  // spawns.jsonl caller_is_subagent. Read here, ahead of every gate that
  // uses it, because WRITER inference and the recursion guard below need it.
  const subagentCaller = callerIsSubagent(p);
  // --- WRITER inferred from the caller (self-review, 2026-09-28) -----------
  // A parity-sized review spawned by a SUBAGENT with no WRITER line at all is
  // taken to gate that subagent's own work — the self-review shape, where an
  // writer spawns its own reviewer (lib/self-review.mjs). Its
  // writer is the caller's own agent_type from the subagent hook payload,
  // resolved through agentDefinition() to the model and effort its
  // definition pins (the same place the harness reads them). Never a guess:
  // a caller with no agent_type, a built-in type (no definition file) or a
  // definition with no model infers nothing, and the review is treated as
  // writer-less, exactly as before, with a note saying why. A WRITER line,
  // usable or not, always wins: inference runs only when there is none. The
  // main thread never infers (the lead names the writer it is gating).
  //
  // The CALLER's own transcript, read once here so WRITER inference, the
  // non-ladder advisory and the spawn-telemetry row below share one answer.
  // `p.effort?.level` wins when the harness supplies it directly; the
  // transcript tail-read is the fallback for payload shapes that don't. The
  // model is the caller's PREVIOUS turn's (null on its first turn).
  const callerTranscript = callerTranscriptPath(p);
  const callerMeta = callerTranscript ? lastAssistantMeta(callerTranscript) : null;
  const callerModel = (callerMeta && callerMeta.model) || null;
  const callerEffort = p.effort?.level || (callerMeta && callerMeta.effort) || null;
  const leadLive = leadEffortLive({ sid, subagentCaller, callerEffort, isCanary }); // telemetry fields; text goes out via allowWith
  redoAlertCheck({ p, brief, isCanary, enabled: opt('redo_alert', true) }); // held until an allow is emitted (allowWith)
  let writerInferred = null;     // the caller-derived writer, while it is the one in use
  let writerInferProblem = null; // why inference was tried and yielded no writer
  // What the calling subagent was seen running, for inference: its model only
  // from its OWN transcript (callerTranscriptPath falls back to the lead's
  // transcript when the subagent's cannot be found, and the lead's model says
  // nothing about the subagent's), its effort from the payload or that record.
  const callerOwnTranscript = subagentCaller && !!callerTranscript && callerTranscript !== p.transcript_path;
  const callerObserved = {
    model: callerOwnTranscript ? callerModel : null,
    effort: p.effort?.level || (callerOwnTranscript && callerMeta && callerMeta.effort) || null,
  };
  if (!decls.WRITER && typeIsParity && subagentCaller) {
    const inf = writerFromCaller(p, callerObserved);
    if (inf.ok) { writer = inf; writerInferred = inf; } else writerInferProblem = inf.reason;
  }
  // The caller's OWN spawn row, for a parity review spawned by a subagent
  // (see "Reviewers never spawn reviewers" below, which denies on it). Looked
  // up here, before the parity route is resolved, because a self-reviewing
  // writer's own TYPE can carry a critical consequence the review inherits.
  let callerRow = null; // callerSpawnRow() result, when the lookup ran
  if (typeIsParity && subagentCaller) {
    try { callerRow = callerSpawnRow(p); } catch { callerRow = { state: 'unknown', why: 'the lookup failed' }; }
  }
  const callerDeclaredType = callerRow && callerRow.state === 'found'
    ? (typeof callerRow.row.declared_type === 'string' ? (canonicalTaskType(callerRow.row.declared_type)?.name || callerRow.row.declared_type) : null)
    : null;
  // A review of a critical change is a critical review (F1), whoever spawns
  // it: when the brief states no CONSEQUENCE and the caller's own row
  // declares a type whose preset is critical (critical-change), the review
  // takes that consequence. Only from a positively found row, never a guess.
  let consequenceFromCaller = false;
  if (!consequenceWasDeclared && callerDeclaredType && !isParityType(callerDeclaredType)) {
    try {
      if (taskTypeDef(callerDeclaredType)?.def?.consequence === 'critical') {
        declaredConsequence = 'critical';
        consequenceFromCaller = true;
      }
    } catch { /* table unreadable: no inherited consequence */ }
  }
  const fitOn = opt('fit_guard', true) && (weightWasDeclared || typeof typeWeight === 'number' || (typeIsParity && !!writer));
  let route = null;
  // The floored parity route (the writer's pair after F4/F2/F1), whether or
  // not fit_guard is on: `routed` and the cap's reviewer exemption compare
  // the reviewer with it, never with the raw writer, and that is a fact about
  // the spawn even when the fit judgement is switched off.
  let parityYardstick = null;
  if (fitOn || (typeIsParity && writer)) {
    try {
      const resolved = resolveRoute({
        type: declaredType,
        weight: declaredWeight, kind: declaredKind, consequence: declaredConsequence,
        // weightExplicit is weightLineExplicit, NOT weightWasDeclared: only a
        // real WEIGHT: line is a deliberate deviation from a named TYPE's own
        // preset; a WARRANT's incidental weight must not silently discard it.
        weightExplicit: weightLineExplicit, kindExplicit: kindWasDeclared, consequenceExplicit: consequenceWasDeclared,
        writer: typeIsParity && writer ? { model: writer.model, effort: writer.effort } : null,
        // The writer's declared TYPE, when the caller's own spawn row gave it:
        // a reviewerEffortCap exception can name writer types (novel-design)
        // whose reviews keep full effort parity.
        writerType: typeIsParity ? callerDeclaredType : null,
      });
      if (resolved.model && resolved.weight === 'parity') parityYardstick = resolved;
      if (!fitOn) {
        // fit_guard off: the parity route above is all this was for.
      } else if (resolved.model) {
        route = resolved;
        // A brief that named only TYPE gets its weight/kind/consequence
        // filled in from the type's own preset, same coalescing
        // `recommend.mjs --type` already does — every message and telemetry
        // field below that reads declaredWeight/Kind/Consequence picks this
        // up unchanged rather than needing its own type-aware branch. A
        // parity route's weight is the string 'parity', never a 1-5 weight,
        // so declared_weight stays null for it.
        if (!weightWasDeclared && typeof resolved.weight === 'number') declaredWeight = resolved.weight;
        if (!kindWasDeclared) declaredKind = resolved.kind;
        if (!consequenceWasDeclared) declaredConsequence = resolved.consequence;
      } else if (typeIsParity && writer && resolved.weight === 'parity') {
        // F4: the resolver refused to size a reviewer to this writer (a
        // model it cannot run on, or one retired with no stand-in).
        const why = resolved.rationale || 'no reviewer can be sized to it';
        if (writerInferred) {
          writerInferProblem = `the caller "${writerInferred.agent}" pins ${writerInferred.label}, and ${why}`;
          writerInferred = null;
        } else {
          writerProblem = why;
        }
        writer = null;
      }
      // resolved.model === '' means no routing row (e.g. a parity-sized type
      // with no writer, or an unrecognised TYPE with no WEIGHT to fall back
      // on) — leave route null, same as the old "no weight declared" no-op path.
    } catch { /* table unreadable */ }
  }
  // True when the route is reviewer parity (sized to the WRITER line), not a
  // weight's row. Parity is judged in notes only in this release: it never
  // feeds the fit deny or the warrant deny below (see "Reviewer parity").
  const parityRoute = !!route && route.weight === 'parity';
  // A WRITER line read only in part — a word where the effort goes that is
  // not an effort level, often prose ("Writer: haiku did the mechanical
  // part") — still judges the reviewer, in notes, on the writer's model
  // alone, but never moves the spawn: no model is filled in from it.
  const writerPartial = parityRoute && writer?.effortIssue === 'not-understood';
  // --- F1 on a critical parity-sized spawn (RC review R6) -----------------
  // A parity-sized type (code-review) has no route without a writer, so the
  // fit check above never ran for it, and "TYPE: code-review" +
  // "CONSEQUENCE: critical" on sonnet or haiku passed in silence. The brief
  // names no writer, so parity itself (F3) cannot be checked here, but F1
  // holds whatever the writer was: a critical review is at least the
  // critical consequence's model and effort floor (opus/xhigh). Below that
  // is "under", said out loud like any other under-provisioned fit. Only
  // the under direction is judged: with no writer, a tier above the floor
  // (a fable writer's reviewer) cannot be called over-provisioned. With a
  // usable WRITER line the parity route above already carries F1, so this
  // floor-only check is for the writer-less case alone.
  let parityFloor = null;
  if (opt('fit_guard', true) && typeWeight === 'parity' && !route) {
    try {
      const pr = resolveRoute({
        type: declaredType,
        weight: declaredWeight, kind: declaredKind, consequence: declaredConsequence,
        weightExplicit: weightLineExplicit, kindExplicit: kindWasDeclared, consequenceExplicit: consequenceWasDeclared,
      });
      if (!pr.model && pr.weight === 'parity' && pr.consequence === 'critical') {
        const crit = modelTiers().consequence?.critical || {};
        if (crit.modelFloor) parityFloor = { model: crit.modelFloor, effort: crit.effortFloor || '' };
      }
    } catch { /* table unreadable */ }
  }
  const parityFloorLabel = parityFloor ? `${parityFloor.model}${parityFloor.effort ? '/' + parityFloor.effort : ''}` : '';
  const routeLabel = route?.model ? `${route.model}${route.effort ? '/' + route.effort : ''}` : '';
  // Which layer answered — named in every fit note below, so a spawner can
  // tell a shipped trial's answer from the plain grid's without --explain.
  const routeLayerNote = route?.layer
    ? ` [route layer: ${route.layer === 'trial' ? 'shipped trial' : route.layer === 'profile' ? `routing profile rev ${route.profileRevision}` : route.layer}]`
    : '';

  // --- Premium-tier determination, ROUTING-AWARE (bugfix 2026-09-23) -----
  // The premium set used to be hard-coded to isPremium()'s tier-table
  // classification alone, so under routing trial v2 (most task types now
  // resolve to opus/low or opus/high) EVERY spawn requesting opus demanded
  // a warrant, even one that named exactly the TYPE the trial itself routes
  // there — the routing table telling a spawner "use opus" and then this
  // guard telling it "justify using opus" is not the over-provisioning this
  // guard exists to stop. The fix: a model is premium FOR THIS SPAWN unless
  // the SAME resolved routing that answers "what should this run on" also
  // names it — that is not a spawner reaching for the expensive tier, it is
  // the table's own prescribed answer. A route exists whenever fitOn is
  // true (a TYPE, or an explicit/warrant weight, was declared) and
  // resolveRoute() found a row. Fable is excluded from this exception on
  // purpose: routingNote is explicit that "nothing routes to fable — it is
  // an exception, not a row", so no route can ever justify it, and it stays
  // a warranted exception on every spawn regardless of TYPE/WEIGHT.
  let spawnAlias = model ? classifyModel(model).alias : '';
  const routingKnown = fitOn && !!route?.model;
  let routeMatchesModel = routingKnown && !!spawnAlias && classifyModel(route.model).alias === spawnAlias;
  let isPremiumForSpawn = spawnAlias === 'fable' ? true : (routeMatchesModel ? false : isPremium(model));
  return {
    subagentCaller, callerModel, callerEffort, leadLive, writerInferred, writerInferProblem, callerObserved,
    callerRow, callerDeclaredType, consequenceFromCaller, fitOn, route, parityYardstick, parityRoute,
    writerPartial, parityFloor, parityFloorLabel, routeLabel, routeLayerNote, spawnAlias, routingKnown,
    routeMatchesModel, isPremiumForSpawn, writer, declaredConsequence, declaredWeight, declaredKind,
    writerProblem,
  };
}
