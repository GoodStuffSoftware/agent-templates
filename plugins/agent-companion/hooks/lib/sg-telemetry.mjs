// spawn-guard phase 7: the spawns.jsonl row, built after every rewrite above.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import { createHash } from 'node:crypto';
import {
  appendLog, claudeProjectDir, effortSupported, opt, pathKey, resolvedProjectRoot, runningCopyStamp,
} from './context.mjs';

export function writeSpawnRow({
  isCanary, input, model, def, callerEffort, sid, leadLive, p, loadedAtMs, ladderRewrite, declared, fromDef,
  autofilled, trulyInherited, namegateName, subagentCaller, callerModel, declaredWeight, declaredKind,
  declaredConsequence, declaredTypeRaw, declaredType, declaredRole, route, fit, routeLabel, parityFloorLabel,
  routed, writer, writerInferred, selfReviewSpawn, reviewBySubagent, selfReviewExpected, selfReviewInjected,
  pinned, pin, pinModelOverridden, callerRow, callerDeclaredType, consequenceFromCaller, memoryFacts,
  silentFixes, fitBeforeFix, gate1Mode, gate1Applicable, gate1Exempt, gate1Action, gate2Fired, gate3Fired,
  gate4Applicable, gate4Action,
}) {

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
}
