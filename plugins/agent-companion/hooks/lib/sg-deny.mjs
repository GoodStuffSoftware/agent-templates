// spawn-guard phase 8: the denials (foreground block, TYPE line required, inherit block, review recursion).
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import { deny, recordDenial, routedRung, unknownTypeHint } from './context.mjs';
import { commonTypeRoutes } from './sg-helpers.mjs';

export function hardDenials({
  gate1Action, p, input, typeRequiredMissing, typeRequiredMode, subagentCaller, inheritBlock, callerAlias,
  declaredType, leadLabel, recursionDeny, callerDeclaredType, RECOMMEND_CMD,
}) {

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
}
