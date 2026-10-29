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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passthrough } from './lib/context.mjs';

import { readSpawnBrief } from './lib/sg-brief.mjs';
import { resolveSpawnRoute } from './lib/sg-route.mjs';
import { autofillAndModelNotes } from './lib/sg-autofill.mjs';
import { memoryAndShapeGates } from './lib/sg-gates.mjs';
import { fitAndParity } from './lib/sg-fit.mjs';
import { projectRouteAndSelfReview } from './lib/sg-review-plan.mjs';
import { writeSpawnRow } from './lib/sg-telemetry.mjs';
import { hardDenials } from './lib/sg-deny.mjs';
import { finishSpawn } from './lib/sg-finish.mjs';

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
  const fitAndParityOut = fitAndParity({
    declaredWeight, typeIsParity, weightLineExplicit, fitOn, model, autofilled, route, def, declaredKind,
    declaredConsequence, parityRoute, parityFloor, decls, typeReqIsRung, pinned, rewriteState, sid, p,
    loadedAtMs, input, updatedInput, ladderRewrite, spawnAlias, routeMatchesModel, isPremiumForSpawn,
    silentFixes, fromDef, declared, parityYardstick, writer, routeLabel, modelTakesEffort, callerEffort,
    writerProblem, writerRaw, writerInferred, writerInferProblem, declaredType, callerDeclaredType,
    subagentCaller, callerObserved,
  });
  const {
    premiumDeclared, routed, capCounts, parityRungName, writerNote, writerInferredNote, writerInferNote,
    parityNoWriter, parityNoWriterNote, recursionDeny, reviewBySubagent, selfReviewSpawn,
  } = fitAndParityOut;
  let {
    fit, fitBeforeFix, parityNote, parityInheritedEffort, writerEffortNote, srCfg, writerBelowCallerNote,
  } = fitAndParityOut;
  ({ updatedInput, ladderRewrite, def, model, spawnAlias, isPremiumForSpawn } = fitAndParityOut);
  const projectRouteAndSelfReviewOut = projectRouteAndSelfReview({
    pin, fromDef, spawnAlias, route, parityYardstick, declaredType, decls, model, updatedInput, input,
    typeIsParity, srCfg, brief, ladderRewrite, def, pinned, consequenceWasDeclared, declaredConsequence,
    callerEffort, selfReviewSuffix, p, silentFixes,
  });
  let {
    projectRoutePlan, selfReviewExpected, selfReviewNote, selfReviewInjected,
  } = projectRouteAndSelfReviewOut;
  ({ model, updatedInput, selfReviewSuffix, def } = projectRouteAndSelfReviewOut);
  writeSpawnRow({
    isCanary, input, model, def, callerEffort, sid, leadLive, p, loadedAtMs, ladderRewrite, declared, fromDef,
    autofilled, trulyInherited, namegateName, subagentCaller, callerModel, declaredWeight, declaredKind,
    declaredConsequence, declaredTypeRaw, declaredType, declaredRole, route, fit, routeLabel,
    parityFloorLabel, routed, writer, writerInferred, selfReviewSpawn, reviewBySubagent, selfReviewExpected,
    selfReviewInjected, pinned, pin, pinModelOverridden, callerRow, callerDeclaredType, consequenceFromCaller,
    memoryFacts, silentFixes, fitBeforeFix, gate1Mode, gate1Applicable, gate1Exempt, gate1Action, gate2Fired,
    gate3Fired, gate4Applicable, gate4Action,
  });
  hardDenials({
    gate1Action, p, input, typeRequiredMissing, typeRequiredMode, subagentCaller, inheritBlock, callerAlias,
    declaredType, leadLabel, recursionDeny, callerDeclaredType, RECOMMEND_CMD,
  });
  await finishSpawn({
    selfReviewSuffix, input, isCanary, sid, ladderRewrite, declaredType, declaredRole, declaredTypeRaw, decls,
    brief, memoryAddition, namegateSuffix, roleInserted, parityRoute, writer, writerInferred, declaredWeight,
    autofilled, model, routeLabel, routeLayerNote, route, autofillAdvisory, fit, def, parityFloorLabel,
    parityNote, typeReqIsRung, isPremiumForSpawn, pinned, spawnAlias, browserVariants, isLadderSpawn,
    neededTools, browserVariantFor, missingModelNote, parityNoWriter, writerInferNote, parityNoWriterNote,
    writerNote, writerInferredNote, writerEffortNote, selfReviewNote, writerBelowCallerNote, gateMessage,
    parityInheritedEffort, noEffortStatedNote, buildFloorNote, pinReplacedNote, projectRoutePlan, p,
    subagentCaller, pin, updatedInput, roleNudge, premiumDeclared, declaredKind, declaredConsequence,
    warrantDeclared, routingKnown, typeWeight, capCounts, parityRungName, rewriteState, rewriteModule,
    RECOMMEND_CMD,
  });
} catch {
  passthrough(); // never break a session
}
