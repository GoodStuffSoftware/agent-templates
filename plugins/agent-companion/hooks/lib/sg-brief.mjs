// spawn-guard phase 1: the payload, the brief's declaration lines (WEIGHT, KIND, CONSEQUENCE, TYPE, ROLE, WRITER), the TYPE-line rules and the definition pin.
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import { BRIEF_ROLES, briefDeclarations, declarationValue, inferRole } from './brief-directives.mjs';
import {
  agentDefinition, canonicalTaskType, classifyModel, isLadderAgentName, ladderVariants, noteAgentType, opt,
  pluginName, readStdin, taskTypeDef, unknownTypeHint, writerFromDeclaration,
} from './context.mjs';
import { pinInfo } from './sg-helpers.mjs';

export function readSpawnBrief({  }) {
  const p = readStdin();
  noteAgentType(p);

  const input = p.tool_input || {};
  const sid = p.session_id || 'unknown';

  // Model resolution order is: env override -> spawn parameter -> the agent's
  // own frontmatter -> the lead's model. Reading only the spawn parameter
  // conflates the last two, so a correctly-configured named agent looked
  // identical to an unexamined inheritance — and, worse, a definition pinned to
  // a premium tier slipped past the warrant and the cap entirely, because the
  // spawn itself named no model.
  const declared = input.model || '';
  // agentDefinition() resolves `<plugin>:<agent>` to that plugin's own
  // agents/ folder, so a ladder spawn's model AND effort come from its rung
  // file here, the same way the harness reads them.
  const isLadderSpawn = isLadderAgentName(input.subagent_type);
  let def = agentDefinition(input.subagent_type, p.cwd);
  const fromDef = def?.model || '';
  let model = declared || fromDef;              // what will actually run, when knowable
  const trulyInherited = !declared && !fromDef; // nobody chose: the real hazard
  // Project-pinned (project_pins, default on): a project or user agent whose own
  // definition pins model and/or effort. The operator chose that tier, so the
  // guard neither judges it by task weight (best fit, weight notes, warrant)
  // nor rewrites it (autofill); every role rule and the cap still apply.
  const pin = pinInfo(input.subagent_type, def, p.cwd);
  const pinned = pin.pinned && opt('project_pins', true);
  // The one note a pin does get: the call's `model` parameter names a different
  // model than the definition pins. The parameter wins in the harness, so the
  // spawn runs on the parameter's model; the guard says so and rewrites nothing.
  const pinModelOverridden = pinned && pin.fields !== 'effort' && !!declared && !!fromDef
    && classifyModel(declared).alias !== classifyModel(fromDef).alias;
  const pinReplacedNote = pinModelOverridden
    ? `agent-companion: ${input.subagent_type} is pinned by its ${pin.scope} definition to ${fromDef}/${def?.effort || 'inherited'}, ` +
      `and this spawn passes model \`${declared}\`, which replaces the pinned model. The pin is deliberate: ` +
      'drop the model parameter to respect it. Not blocking.'
    : null;

  // No delegation-streak write here: the streak ends only when a main-thread
  // Agent spawn actually RUNS (delegation-guard.mjs --event reset, PostToolUse).
  // A PreToolUse reset here fired on spawns this guard then denied, and on a
  // subagent's own spawns, which carry the lead's session_id.

  // The canary deliberately provokes this guard, so it must not be recorded as
  // real activity — otherwise the probe pollutes the very telemetry the audit
  // then reads back, and every canary run inflates the premium spawn count.
  const isCanary = String(sid).startsWith('canary');

  // The routing table is downstream of a number nobody used to record: the
  // doctrine says to score task weight 1-5 *silently*, so the judgement that
  // chose the tier left no trace and could never be compared against what the
  // task turned out to need. Capture it whenever it IS stated.
  const brief = String(input.prompt || '');
  // WEIGHT: line vs a WARRANT's OWN weight are two different things, and
  // conflating them was a live bug (2026-09-23): "TYPE: novel-design" +
  // "WARRANT: weight 4 - <reason>" got the WARRANT's "4" parsed as an
  // EXPLICIT weight declaration, which bypassed the type's own preset (5)
  // and its routing-trial override entirely, fell back to the plain grid,
  // and then denied the exact opus spawn the trial prescribes for a
  // manufactured "over-provisioned" mismatch. A WARRANT justifies a tier;
  // it does not redeclare the task's weight, and must never outrank a
  // declared TYPE. Precedence (see the resolveRoute() call below):
  // explicit TYPE (with its trial override) > a real WEIGHT: line >
  // a WARRANT's own stated weight. weightLineExplicit therefore reflects
  // ONLY a genuine WEIGHT: line; a WARRANT-only weight still counts as A
  // declared weight for declaredWeight/telemetry/fitOn (TELEMETRY.md
  // documents declared_weight coming from either), but never as the
  // EXPLICIT deviation that discards a named TYPE's own preset.
  //
  // Every declaration is read from a LINE OF ITS OWN, not from anywhere in
  // the text: an unanchored match used to pick up prose ("the kind:
  // mechanical parts", "weight: 4 files", "a brief for type: x") as an
  // explicit declaration, which discarded the named TYPE's preset and denied
  // the spawn its trial prescribes. A line may be list-marked (-, *) and the
  // label or value markdown-bold ("**TYPE:** integration"). Lines inside
  // fenced code, indented code, > blockquotes and HTML comments are never
  // declarations (a nested list item is not indented code), and
  // the FIRST declaration of each label wins whether or not its value is
  // valid (lib/brief-directives.mjs, RC review R1): a pasted "type: explore"
  // or "WEIGHT: 1" in the body can no longer replace or outrank the header.
  const decls = briefDeclarations(brief);
  const weightLineMatch = declarationValue(decls, 'WEIGHT', /(?:weight[ \t]*)?([1-5])\b/.source);
  const warrantWeightMatch = declarationValue(decls, 'WARRANT', /(?:weight[ \t]*)?([1-5])\b/.source);
  const warrantDeclared = !!decls.WARRANT;
  const weightLineExplicit = !!weightLineMatch;
  let declaredWeight = weightLineMatch ? Number(weightLineMatch[1])
    : (warrantWeightMatch ? Number(warrantWeightMatch[1]) : null);
  const weightWasDeclared = declaredWeight !== null;
  const km = declarationValue(decls, 'KIND', /(mechanical|bounded|diagnostic|novel-design)\b/.source);
  let declaredKind = km ? km[1].toLowerCase() : null;
  const kindWasDeclared = declaredKind !== null;
  const cm = declarationValue(decls, 'CONSEQUENCE', /(routine|elevated|critical)\b/.source);
  let declaredConsequence = cm ? cm[1].toLowerCase() : null;
  const consequenceWasDeclared = declaredConsequence !== null;
  // TYPE: names a config/model-tiers.json taskTypes preset (taskTypesNote) —
  // the only place a benchmark-backed ROUTING TRIAL override attaches.
  // Declaring it alone (no WEIGHT/KIND/CONSEQUENCE) lets a brief pick up the
  // type's own weight/kind/consequence preset AND its override, same as
  // `recommend.mjs --type`; declaring WEIGHT/KIND/CONSEQUENCE alongside it is
  // a deliberate deviation and bypasses the override when its value DEPARTS
  // from the preset (one equal to the preset restates the type), same rule
  // as there. Only the first TYPE line counts: an unknown one stays unknown
  // (no route from it), and declared_type records exactly that header value.
  const tm = declarationValue(decls, 'TYPE', /([a-z][a-z0-9-]*)\b/.source);
  // An alias (config taskTypeAliases) is another spelling of a type: routing,
  // self-review and the rules text all see the canonical name; telemetry keeps
  // the raw header value as declared_type. Same resolver as recommend.mjs.
  const declaredTypeRaw = tm ? tm[1].toLowerCase() : null;
  const declaredType = declaredTypeRaw ? (canonicalTaskType(declaredTypeRaw)?.name || declaredTypeRaw) : null;
  // ROLE: what the spawn's main deliverable is (reviewer, fixer, lander, writer,
  // docs, lookup, operate, other). Measurement only (0.31.3): it routes nothing
  // and gates nothing. Recorded as declared_role; a spawn without a usable
  // line gets a short non-blocking nudge (role_line_nudge), NEVER a deny.
  const rm = declarationValue(decls, 'ROLE', `(${BRIEF_ROLES.join('|')})\\b`);
  const declaredRole = rm ? rm[1].toLowerCase() : null;
  // 0.31.36: no message. A brief with no usable ROLE: line gets one inserted through updatedInput
  // (first line of the brief), inferred from its TYPE (inferRole). Measurement only: it routes nothing.
  const roleInserted = !declaredRole && opt('role_line_nudge', true) && brief.trim()
    ? inferRole(declaredType)
    : null;
  const silentFixes = []; // what this guard fixed without a message, for the spawn row (silent_fixes)
  if (roleInserted) silentFixes.push(`role_inserted:${roleInserted}`);
  // A TYPE: line that is no type (and no alias) routes and measures nothing:
  // say so once, naming the valid ones (type_line_nudge). Never a deny.
  const typeNudge = declaredTypeRaw && !canonicalTaskType(declaredTypeRaw) && opt('type_line_nudge', true)
    ? `agent-companion: TYPE: ${declaredTypeRaw} is not a task type, so it routes and measures nothing. ${unknownTypeHint(declaredTypeRaw).replace(/^"[^"]*" is not a task type\. /, '')} Not blocking.`
    : null;
  // type_line_required (0.31.17; deny | warn | off, default deny): a ladder-rung spawn
  // needs a TYPE: line or a line that stands in for it (WEIGHT:, KIND:, or a WARRANT:
  // carrying a weight; CONSEQUENCE: alone routes nothing). Enforced in Gate 5 below.
  const typeReqRaw = String(opt('type_line_required', 'deny')).toLowerCase();
  const typeRequiredMode = ['deny', 'warn', 'off'].includes(typeReqRaw) ? typeReqRaw : 'deny';
  const hasTypeStandIn = !!(decls.TYPE || decls.WEIGHT || decls.KIND || warrantWeightMatch);
  // Rungs proper only: ladderVariants (ac-browser, ac-browser-opus) are "not a rung".
  const typeReqBare = String(input.subagent_type || '').replace(`${pluginName()}:`, '');
  const typeReqIsRung = isLadderSpawn && !ladderVariants().some((v) => v.agent === typeReqBare);
  const typeRequiredMissing = typeReqIsRung && !hasTypeStandIn && typeRequiredMode !== 'off';
  const typeRequiredWarn = typeRequiredMissing && typeRequiredMode === 'warn'
    ? 'agent-companion: this ladder-rung brief has no `TYPE:` line (and no WEIGHT: or KIND: line that stands in for it). Add `TYPE: <task type>` on its own line; with type_line_required on its default (deny) this spawn would be refused.'
    : null;
  const roleNudge = [typeNudge, typeRequiredWarn].filter(Boolean).join('\n') || null;
  // NOTE: deliberately no WEIGHT/WARRANT-style "EFFORT:" line here. Unlike
  // model, weight, kind and consequence — all of which the ORCHESTRATOR
  // controls by what it writes into the brief text — effort is locked to the
  // spawned agent's OWN definition frontmatter; no documented Claude Code
  // mechanism turns free text in a prompt into a per-spawn effort parameter.
  // An earlier version of this hook let an "EFFORT: <level>" line in the
  // brief silence the no-effort warning below, which was actively
  // misleading: it told the caller they had fixed the effort-inheritance
  // hazard when the subagent still ran at whatever effort the orchestrating
  // session happened to be at (review finding M1, 2026-09-23).

  // --- Best fit ----------------------------------------------------------
  // The table's answer for the declared weight (or named type), used two
  // ways: filled in where the spawn left the model blank (the inheritance
  // hazard, closed at its source), and as the yardstick for a model the
  // spawn did name. resolveRoute() is the SHARED resolver
  // (hooks/lib/context.mjs) — scripts/recommend.mjs and scripts/evaluate.mjs
  // go through the identical function, so its layer stack (profile > shipped
  // ROUTING TRIAL > grid, floors after the winner) is applied here too: a
  // spawn that correctly follows a trial (e.g. TYPE: debug-root-cause on
  // opus/low) is judged against the trial's own (model, effort), not the
  // plain grid's.
  let typeWeight = null;
  if (declaredType) {
    try { typeWeight = taskTypeDef(declaredType)?.def?.weight ?? null; } catch { /* table unreadable */ }
  }
  // A parity-sized type (code-review) routes only once its writer is known:
  // with a usable WRITER line the resolver sizes the reviewer to it (F3, then
  // F4/F2/F1), so the parity route exists here exactly as it does for
  // `recommend.mjs --type code-review --writer <m>/<e>`.
  const typeIsParity = typeWeight === 'parity';
  // WRITER: the writer a review gates — the one input a parity-sized type
  // (code-review) needs before the table can size it (reviewer parity,
  // config/model-tiers.json reviewerParity; resolveRoute()'s F3). First line
  // wins, like every label. `<model>/<effort>` (also `opus xhigh`,
  // `opus at xhigh`, `Opus 5.5 xhigh`) or `<agent-name>` (a ladder rung, a
  // plugin agent or a project agent, read through its own definition, where
  // its model and effort are locked): writerFromDeclaration(). Read ONLY on a
  // parity-sized type: on any other brief a "Writer:" line is prose (or
  // names nothing this guard sizes), so it is ignored in silence — no note,
  // no route, no autofill. A WRITER line whose value names neither form is
  // ignored, and the note says so.
  let writer = null;        // writerFromDeclaration() result, when usable
  let writerProblem = null; // why a declared WRITER line was not used
  // The line's value as written (bounded), for the notes.
  const writerRaw = decls.WRITER ? String(decls.WRITER.rest).replace(/[*_`]/g, '').trim().slice(0, 80) : '';
  if (decls.WRITER && typeIsParity) {
    const parsed = writerFromDeclaration(decls.WRITER.rest, p.cwd);
    if (parsed.ok) writer = parsed;
    else writerProblem = parsed.reason;
  }
  return {
  p, input, sid, declared, isLadderSpawn, def, fromDef, model, trulyInherited, pin, pinned,
  pinModelOverridden, pinReplacedNote, isCanary, brief, decls, warrantDeclared, weightLineExplicit,
  declaredWeight, weightWasDeclared, declaredKind, kindWasDeclared, declaredConsequence,
  consequenceWasDeclared, declaredTypeRaw, declaredType, declaredRole, roleInserted, silentFixes,
  typeRequiredMode, typeReqIsRung, typeRequiredMissing, roleNudge, typeWeight, typeIsParity, writer,
  writerProblem, writerRaw,
};
}
