// spawn-guard phase 6: the project route plan (a model rewrite) and then the self-review protocol injection, in that order.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import {
  agentDefinition, canonicalTaskType, classifyModel, effortSupported, modelTiers, opt, referenceEffortSupported,
  resolveRoute, rungFor, taskTypeDef,
} from './context.mjs';
import {
  definitionCarriesProtocol, injectionRung, optedOut, pinnedInjectionRung, reviewerRungFor,
  selfReviewBriefText, selfReviewConfig,
} from './self-review.mjs';

const BUILTIN_AGENT_TYPES = new Set(['', 'general-purpose', 'explore', 'plan', 'claude-code-guide', 'statusline-setup', 'claude']);

export function projectRouteAndSelfReview({
  pin, fromDef, spawnAlias, route, parityYardstick, declaredType, decls, model, updatedInput, input,
  typeIsParity, srCfg, brief, ladderRewrite, def, pinned, consequenceWasDeclared, declaredConsequence,
  callerEffort, selfReviewSuffix, p, silentFixes,
}) {

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

  // --- Project-agent effort fill (project_effort_fill: autofix | off) ---------
  // A project or user agent whose definition sets a model but no `effort:` line inherits the LEAD's effort
  // (xhigh on a premium lead): two haiku explorers ran at xhigh on 10-27. When the spawn also sets no effort
  // of its own, the guard sets updatedInput.effort silently (the Agent tool takes an `effort` parameter, as
  // `model` does): the effort the routing table gives the spawn's TYPE when that route is on the model that
  // will run, else the model's own default effort (tier resolvesTo.defaultEffort). An effort in the spawn
  // input or in the agent file always wins; a model that takes no effort is left alone. Runs after the model
  // rewrite above (it sizes the effort to the model that will run) and before the self-review block and the
  // spawns.jsonl row, so both see the effort that will run: `def` becomes an effective copy carrying it.
  // The same holds for a built-in type (general-purpose, Explore, Plan, claude-code-guide, statusline-setup,
  // the catch-all `claude`): it has no definition file, so it inherits the lead's effort whenever its input sets none
  // (measured 10-28: a general-purpose sonnet spawn ran at the lead's xhigh). Filled the same way, once a model is known.
  // No message; the spawn row records it (silent_fixes `effort_filled:<effort>`, spawn_effort_source `guard-fill`).
  {
    const efModeRaw = String(opt('project_effort_fill', 'autofix')).toLowerCase();
    const efMode = ['autofix', 'off'].includes(efModeRaw) ? efModeRaw : 'autofix';
    try {
      const builtin = !def && BUILTIN_AGENT_TYPES.has(String(input.subagent_type || '').toLowerCase());
      if (efMode === 'autofix' && ((pin.pinned && pin.fields === 'model' && def && !def.effort) || builtin)
        && !input.effort && !(updatedInput && updatedInput.effort) && model) {
        const alias = classifyModel(model).alias;
        const takes = (e) => {
          const ref = referenceEffortSupported(model, e);
          return (ref || effortSupported(model, e)).ok;
        };
        let level = null;
        if (alias) {
          let r = route && route.model ? route : parityYardstick;
          if (!(r && r.model) && declaredType) { try { r = resolveRoute({ type: declaredType }); } catch { r = null; } }
          const fromTable = r && r.model && r.effort && classifyModel(r.model).alias === alias
            ? String(r.effort).toLowerCase() : null;
          const own = String(((modelTiers().tiers || {})[alias] || {}).resolvesTo?.defaultEffort || '').toLowerCase();
          level = [fromTable, own].find((e) => e && takes(e)) || null;
        }
        if (level) {
          updatedInput = { ...(updatedInput || input), effort: level };
          def = { ...(def || {}), effort: level, effortFilled: true };
          if (silentFixes) silentFixes.push(`effort_filled:${level}`);
        }
      }
    } catch { /* fail open: the spawn keeps the inherited effort */ }
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
  return {
    projectRoutePlan, selfReviewExpected, selfReviewNote, selfReviewInjected, model, updatedInput,
    selfReviewSuffix, def,
  };
}
