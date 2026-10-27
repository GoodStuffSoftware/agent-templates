// spawn-guard phase 9: the notes, the prompt additions (withAdditions), the warrant and the premium cap, and the final allow.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import { buildContract, noteContractAppended } from './brevity.mjs';
import {
  appendLog, deny, opt, pluginName, readJson, recordDenial, routeLayerTag, rungFor, stateFile,
  unknownTypeHint, writeJsonAtomic,
} from './context.mjs';
import { matchRules, renderRules } from './rules.mjs';
import { buildScopeClause } from './scope-rule.mjs';
import { allowWith, combineNotes, commonTypeRoutes } from './sg-helpers.mjs';

export async function finishSpawn({
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
}) {
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
    } = await import('./premium-window.mjs');
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
}
