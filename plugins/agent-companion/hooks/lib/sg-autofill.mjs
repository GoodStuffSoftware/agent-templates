// spawn-guard phase 3: the fit autofill and ladder rewrite of an inherited spawn, the effort and inherited-model notes, and the build-floor check.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import {
  briefNeedsDroppedTools, callerTranscriptPath, classifyModel, effortSupported, isPremium, ladderVariants,
  modelTiers, opt, parseSemver, readJson, referenceEffortSupported, rungFor, semverBelow, sessionBuildVersion,
  sessionLoadedAt, stateFile, unknownTypeHint,
} from './context.mjs';
import { ladderRewriteTarget } from './sg-helpers.mjs';

export async function autofillAndModelNotes({
  sid, brief, fitOn, trulyInherited, route, isLadderSpawn, writerPartial, pinned, model, input, p, def,
  callerModel, declared, callerEffort, declaredType, routeLabel, writerRaw, typeIsParity, writerProblem,
  typeWeight, weightWasDeclared, RECOMMEND_CMD, SETUP_SKILL_FILE,
}) {
  // A parity route (TYPE: code-review + WRITER:) counts like any other route
  // here: a reviewer on the model it names (its writer's, after the floors)
  // is not premium for this spawn, so it needs no WARRANT and the cap does
  // not count it. A reviewer on another model is judged by the parity note
  // below and is never denied for that in this release.

  // Autofill. Never on a ladder spawn: a rung's model and effort are locked
  // in its own file, and a route's model written over it would silently
  // change the rung (the bug that turned agent-companion:ac-haiku into an
  // opus spawn for a TYPE: novel-design brief).
  //
  // On a NON-ladder spawn, a model alone leaves effort to inherit from the
  // session. So when the route names an effort, the guard also rewrites the
  // spawn to the matching ladder rung (ac-<model>-<effort>), which pins both
  // — but only where that rewrite is safe:
  //   - the original type is general-purpose or unnamed (a ladder rung has
  //     the same full tool set; Explore, Plan or a project agent would lose
  //     its own tools or prompt), and
  //   - the target is registered in this session (ladderRewriteTarget: the
  //     namespaced rung once a namespaced ladder agent has started since the
  //     session last loaded its plugins, or the exact bare rung when it has
  //     started and its file is at user or project scope). A rewrite to an
  //     unregistered type fails the spawn with "Agent type not found", and
  //     the caller could not see why.
  //   - no earlier rewrite in this session was ignored by the harness
  //     (lib/ladder-rewrite.mjs: SubagentStart showed it ran as its
  //     original type); after one, the advisory is given instead.
  //   - `fit_autofill_ladder` is on (default).
  // Otherwise the model is still filled in and an advisory names the rung to
  // spawn instead.
  const loadedAtMs = sessionLoadedAt(sid);
  let autofilled = false;
  let updatedInput = null;
  let ladderRewrite = null;     // { from, to } when the spawn was rewritten to a rung
  let autofillAdvisory = null;  // the note when it could not be
  let rewriteState = null;      // lib/ladder-rewrite.mjs record for this session, read once
  // What the brief names that the ladder workers no longer carry: the browser
  // servers, or Artifact / a desktop-only server (config ladderTools). The
  // browser variants (config ladderVariants) are where UI work goes instead.
  const neededTools = briefNeedsDroppedTools(brief);
  const browserVariants = ladderVariants().filter((v) => v.browser && v.model);
  const browserVariantFor = (m) => browserVariants.find((v) => v.model === m) || browserVariants[0] || null;
  const rewriteModule = () => import('./ladder-rewrite.mjs');
  // Read without loading the module: the file is absent until a rewrite happens.
  try {
    const all = readJson(stateFile('ladder-rewrites.json'), null);
    if (all && all[sid]) rewriteState = (await rewriteModule()).rewriteState(sid);
  } catch { rewriteState = null; }
  if (fitOn && trulyInherited && route?.model && opt('fit_autofill', true) && !isLadderSpawn && !writerPartial && !pinned) {
    model = route.model;
    autofilled = true;
    updatedInput = { ...input, model };
    const rung = route.effort ? rungFor(route.model, route.effort) : null;
    if (rung) {
      const origType = input.subagent_type || '';
      // A ladder worker no longer carries the full tool set (its frontmatter
      // disallows Artifact, the desktop-only servers and the browser), so a
      // brief that names one of those keeps its general-purpose spawn.
      const toolsEquivalent = (!origType || origType === 'general-purpose') && !neededTools.browser && !neededTools.other && !neededTools.skill;
      const ignored = rewriteState && rewriteState.ignored;
      let pick = null;
      if (toolsEquivalent && opt('fit_autofill_ladder', true) && !ignored) {
        pick = ladderRewriteTarget(sid, rung.agent, p.cwd, loadedAtMs);
        if (pick.target) {
          updatedInput = { ...input, model, subagent_type: pick.target };
          ladderRewrite = { from: origType || null, to: pick.target };
          def = pick.def;
        }
      }
      if (!ladderRewrite) {
        const why = (neededTools.browser || neededTools.other || neededTools.skill)
          ? `the brief names ${neededTools.browser ? 'the browser' : neededTools.other ? 'Artifact or a desktop-only tool' : 'a skill to load'}, which the ladder workers drop, so the guard does not swap it for a ladder rung`
          : !toolsEquivalent
          ? `"${origType}" has its own tools and prompt, so the guard does not swap it for a ladder rung`
          : !opt('fit_autofill_ladder', true)
            ? 'the fit_autofill_ladder option is off'
            : ignored
              ? `an earlier rewrite in this session ran as "${ignored.ranAs}" instead of "${ignored.wanted}", so the ` +
                'harness did not honour it; rewriting is off for the rest of this session'
              : pick.why;
        // A browser brief points at the browser variant on the routed model,
        // not the plain rung (which has no browser).
        const target = neededTools.browser ? browserVariantFor(route.model) : rung;
        autofillAdvisory = `agent-companion: effort not pinned — the model was filled in as ${route.model}, but ` +
          `effort ${route.effort} was not: this worker inherits the session's effort. Spawn subagent_type ` +
          (target
            ? `"agent-companion:${target.agent}" to pin ${target.model}/${target.effort || route.effort} together (not rewritten here: ${why}).`
            : `"agent-companion:${rung.agent}" to pin ${route.model}/${route.effort} together (not rewritten here: ${why}).`);
      }
    }
  }

  // A subagent definition with no `effort` frontmatter does NOT fall back to
  // the model's own API default — per Claude Code's sub-agents docs, effort
  // "inherits from session" when nothing else sets it: it runs at whatever
  // effort the ORCHESTRATING SESSION currently has. (An earlier version of
  // this note claimed the model default applied here — e.g. "opus falls back
  // to 5.5's medium" — which is wrong for a spawn made through this hook; the
  // model's own default is reached only for a bare API call outside any
  // Claude Code session, which this is not.) That makes an unstated effort
  // implicit and coupled to caller state rather than pinned — the same shape
  // of hazard as an unstated MODEL inheriting the lead's tier, just on the
  // effort axis, and it applies to every effort-taking model, not only opus:
  // an orchestrator cranked to `max` silently pushes every effort-less
  // subagent (sonnet or opus) to `max` too, and vice versa. "Stated" means
  // ONLY the agent definition's own `effort:` frontmatter — brief text
  // cannot set it (see the note above declaredWeight/declaredKind/
  // declaredConsequence). Read AFTER autofill so an autofilled model (e.g.
  // weight 5, no model named) is covered too, not just an explicitly-named
  // one. A model takes an effort only if its tier lists efforts, so a model
  // with an empty list has nothing to inherit. A pinned id that matches a
  // reference entry (e.g. the legacy claude-haiku-4-5, no effort parameter) is
  // judged by that entry, checked BEFORE the alias tier (which would call it
  // the current haiku and say it takes an effort).
  const refEffort = model ? referenceEffortSupported(model, 'high') : null;
  const modelTakesEffort = !!model && (refEffort ? refEffort.ok : effortSupported(model, 'high').ok);
  const effortStatedSomewhere = !!def?.effort;

  // (callerTranscript/callerMeta/callerModel/callerEffort: read once, above
  // WRITER inference, which checks the caller's definition against them.)

  // Non-ladder + explicit differing model: the shape a ladder-registration
  // failure pushes a caller into (spawn a built-in type like general-purpose
  // with model: opus named explicitly, because agent-companion:ac-opus-low
  // itself would not spawn) — and the one shape where that workaround quietly
  // loses the effort half of the pair, since a built-in type has no `effort`
  // frontmatter to set it. Narrower than the generic rule-1 note below (which
  // fires for ANY effort-taking model with no stated effort, ladder or not):
  // this one names the actual hazard — a DIFFERENT model than the lead is
  // running was chosen on purpose, and effort came along for free, uninvited.
  // A lead model the tier table cannot classify (a `<synthetic>` record, an
  // empty transcript) is unknown, not "different".
  const callerAlias = callerModel ? classifyModel(callerModel).alias : '';
  const isNonLadderExplicitEscalation = !isLadderSpawn
    && !!declared && !!callerAlias
    && classifyModel(declared).alias !== callerAlias;
  const noEffortStatedNote = autofillAdvisory ? null : (modelTakesEffort && !effortStatedSomewhere)
    ? (isNonLadderExplicitEscalation
      ? `agent-companion: effort not set — "${input.subagent_type || 'this worker'}" is not a ladder agent ` +
        `(agent-companion:ac-*) and names "${declared}" explicitly, which differs from the lead's own model ` +
        `(${callerModel}); with no \`effort:\` in a definition, this worker inherits the session's effort ` +
        `(${callerEffort || "unknown — the lead's own effort could not be read from its transcript either"}). ` +
        'Spawn the matching ladder agent instead (see `' + RECOMMEND_CMD + '`) to pin model and effort together; ' +
        'if ladder agents will not spawn in this session, read the "If ladder agents won\'t spawn" section of ' + SETUP_SKILL_FILE + '.'
      : `agent-companion (SPAWNING RULE 1): this spawn resolves to ${classifyModel(model).alias || model} with no ` +
        'effort stated in its agent definition — it will INHERIT the orchestrating session\'s current effort ' +
        'rather than any model default, which couples this subagent\'s depth of thinking to whatever the caller ' +
        'happens to be running at. That counts as a rule-1 violation: every spawn must name a definition that ' +
        'states BOTH model and effort. State it explicitly by setting `effort:` in the agent definition ' +
        'frontmatter — a brief-level "EFFORT:" line does NOT set it; the effort comes from the definition ' +
        'or from the spawn call\'s own effort parameter, not from the brief text.')
    : null;

  // --- Missing model (SPAWNING RULE 1, other half) ------------------------
  // The autofill note below already covers the case where a WEIGHT was
  // declared and the table filled the model in; this covers the case that
  // note misses entirely — no weight declared, so autofill never ran, and
  // the spawn simply names no model anywhere. `trulyInherited` was already
  // computed above (neither the spawn parameter nor the definition named
  // one); read here, after autofill, so an autofilled spawn does not also
  // get this more generic note layered on top of its own.
  //
  // It is also the ONE inheritance note for this shape: with no model named
  // anywhere, the no-effort note above never fires (it needs a model to
  // judge), so this says both halves at once — the model and, unless a
  // definition states one, the effort — and names the lead's own pair when
  // its transcript shows it.
  //
  // inherit_guard (warn | block, default warn): "block" denies the shape this
  // note describes when it is the whole of it — model AND effort inherited
  // from a lead on a premium tier (opus, fable, mythos: isPremium()), and no
  // TYPE the table knows and no WEIGHT line to route it — with the exact line
  // to add. An unknown TYPE ("TYPE: frobnicate") routes nothing, so it does
  // not lift the block. "warn" is this note alone. A lead whose model cannot
  // be read or classified is never blocked (fail open).
  const bothInherited = trulyInherited && !autofilled && !def?.effort;
  const leadLabel = callerAlias
    ? `${callerAlias}${callerEffort && bothInherited ? '/' + callerEffort : ''}`
    : '';
  // Why no route set the model, said exactly (0.29.19 review: this used to
  // blame an unknown type or fit_autofill whatever the real cause was).
  const routeGap = (() => {
    if (!opt('fit_guard', true)) {
      return declaredType
        ? `TYPE: ${declaredType} did not route it because fit_guard is off (the guard routes nothing then); turn fit_guard on, or`
        : 'Add a `TYPE: <task type>` line and turn fit_guard on (it is off, so the guard routes nothing), or';
    }
    if (route?.model && !opt('fit_autofill', true)) {
      return `the routing table sends this to ${routeLabel}, but fit_autofill is off, so the guard did not fill it in; name that model, or`;
    }
    if (route?.model && writerPartial) {
      return `the WRITER line ("${writerRaw}") was only partly understood, so the guard did not fill the model in from it; ` +
        'write it as `WRITER: <model>/<effort>`, or';
    }
    if (route?.model) return `the routed ${routeLabel} was not filled in on this agent type; name that model, or`;
    if (!declaredType) {
      return 'Add a `TYPE: <task type>` line so the routing table sets them (on general-purpose the guard also ' +
        'swaps in the ladder rung that pins effort), or';
    }
    if (typeIsParity) {
      return writerProblem
        ? `TYPE: ${declaredType} is sized from its writer, and the WRITER line could not be used; fix it, or`
        : `Add a \`WRITER: <model>/<effort>\` line so TYPE: ${declaredType} can be sized to its writer, or`;
    }
    return typeWeight === null
      ? `TYPE: ${declaredType} is not a task type the table knows. ${unknownTypeHint(declaredType).replace(/^"[^"]*" is not a task type\. /, '')} Name a known type, or`
      : `TYPE: ${declaredType} did not resolve a route; name another type, or`;
  })();
  const missingModelNote = (trulyInherited && !autofilled)
    ? 'agent-companion (SPAWNING RULE 1): this spawn names no model, and its definition' +
      (input.subagent_type ? ` ("${input.subagent_type}")` : '') +
      ` states ${bothInherited ? 'neither model nor effort' : 'none either'} — it will inherit the lead's ` +
      `${bothInherited ? 'model AND effort' : 'current model'}` +
      (leadLabel ? ` (${leadLabel} now)` : '') +
      ' rather than stated ones. ' + routeGap +
      ' spawn a ladder rung (agent-companion:ac-<model>-<effort>) or another definition that states BOTH model and effort.'
    : null;
  const inheritModeRaw = String(opt('inherit_guard', 'warn')).toLowerCase();
  const inheritMode = ['warn', 'block'].includes(inheritModeRaw) ? inheritModeRaw : 'warn';
  const inheritBlock = inheritMode === 'block' && bothInherited
    && !!callerAlias && isPremium(callerModel)
    && typeWeight === null && !weightWasDeclared;

  // --- Build-version floor (SPAWNING RULE 2) -------------------------------
  // config/model-tiers.json's aliasResolution.minClaudeCodeVersion records the
  // Claude Code build its per-alias `resolvesTo` facts hold from: below it,
  // `opus` resolved to Opus 5 instead of Opus 5.5 (measured 2026-09-23, see
  // the config's own note). scripts/detect.mjs already raises this for the
  // daily scout by shelling out to `claude --version` — but that answers "what
  // build is the `claude` CLI on PATH", not "what build is THIS session on",
  // and the two differ: the desktop app bundles its own build, and a session
  // keeps the build it started with regardless of what gets installed later.
  // So this reads the CALLING session's own transcript instead (via
  // sessionBuildVersion(), a bounded tail-read of the `version` field every
  // harness-written record carries) and only warns when it can actually read
  // one — an unreadable transcript reports "unknown" and stays silent, per the
  // rule's own "fall back to unknown, don't warn" instruction, rather than
  // guessing. Scoped to opus/fable only: those are the tiers the config's
  // aliasResolution note actually documents a below-floor behaviour for.
  const resolvedAlias = model ? classifyModel(model).alias : '';
  let buildFloorNote = null;
  if (resolvedAlias === 'opus' || resolvedAlias === 'fable') {
    try {
      const cfg = modelTiers();
      const floor = cfg.aliasResolution?.minClaudeCodeVersion;
      const floorParsed = parseSemver(floor);
      if (floorParsed) {
        const transcriptPath = callerTranscriptPath(p);
        const sessionVersion = transcriptPath ? sessionBuildVersion(transcriptPath) : null;
        const runningParsed = parseSemver(sessionVersion);
        if (runningParsed && semverBelow(runningParsed, floorParsed)) {
          buildFloorNote = `agent-companion (SPAWNING RULE 2): this spawn resolves to ${resolvedAlias}, and the ` +
            `CALLING session (read from ${transcriptPath}) is on Claude Code ${sessionVersion}, below the ` +
            `${floor} floor config/model-tiers.json's alias facts assume — ` +
            `${cfg.aliasResolution.note || 'the alias may resolve to an older model than the routing table claims.'} ` +
            'Restart the session on a current build before spawning opus/fable-tier work; do not pin around it.';
        }
        // sessionVersion unreadable ("unknown" per the rule): stay silent
        // rather than guess — the same fail-open posture every guard here takes.
      }
    } catch { /* config or transcript unreadable: fail open, no note */ }
  }
  return {
    loadedAtMs, autofilled, updatedInput, ladderRewrite, autofillAdvisory, rewriteState, neededTools,
    browserVariants, browserVariantFor, rewriteModule, modelTakesEffort, callerAlias, noEffortStatedNote,
    leadLabel, missingModelNote, inheritBlock, buildFloorNote, model, def,
  };
}
