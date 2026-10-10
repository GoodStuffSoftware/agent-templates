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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStdin, noteAgentType, isPremium, opt, stateFile, readJson,
  writeJsonAtomic,
  appendLog, deny, passthrough, recordDenial, agentDefinition, evaluateFit, resolveRoute,
  effortSupported, dataDir, callerTranscriptPath, lastAssistantMeta,
  classifyModel, classifyEffort, modelTiers, sessionBuildVersion, parseSemver, semverBelow,
  taskTypeDef, canonicalTaskType, unknownTypeHint, isLadderAgentName, rungFor, runningCopyStamp, tailRecords, telemetryDir,
  claudeDir, sessionLoadedAt, writerFromDeclaration, ownAgentsDir, callerIsSubagent, routedRung, routeLayerTag,
  briefNeedsDroppedTools, ladderVariants, pluginName, projectAgentRoots,
} from './lib/context.mjs';

import { buildMemoryBrief, buildMemoryNudge } from './lib/memory-brief.mjs';
import { briefDeclarations, declarationValue, BRIEF_ROLES } from './lib/brief-directives.mjs';
import {
  selfReviewConfig, optedOut, isParityType, writerFromCaller, callerSpawnRow, definitionCarriesProtocol,
  injectionRung, pinnedInjectionRung, selfReviewBriefText,
} from './lib/self-review.mjs';
import { parseRepoGlobs, DEFAULT_REPO_GLOBS } from './lib/memory-index.mjs';
import { buildContract, noteContractAppended } from './lib/brevity.mjs';
import { matchRules, renderRules } from './lib/rules.mjs';
import { leadEffortLive, mergeLeadEffort } from './lib/lead-effort-live.mjs';
import {
  buildCandidateName, sessionSpawnNames, reserveUniqueName, buildNamegateBrief,
} from './lib/namegate.mjs';

// The recommender and the setup SKILL.md as paths a worker can use from any directory: the guard's
// messages reach subagents (a worker spawning its reviewer), whose cwd is the
// project, so a bare `scripts/recommend.mjs` would not resolve.
const SETUP_SKILL_FILE = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'setup', 'SKILL.md').replace(/\\/g, '/'); } catch { return 'skills/setup/SKILL.md'; }
})();
const RECOMMEND_CMD = (() => {
  try { return 'node "' + join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'recommend.mjs').replace(/\\/g, '/') + '"'; } catch { return 'node scripts/recommend.mjs'; }
})();

// Let the spawn through — optionally saying something to the user, and/or
// rewriting the tool input (`updatedInput` is how a PreToolUse hook fills in a
// model the spawn left blank). The guard never blocks the cheap direction, but
// neither direction passes in silence once the brief has declared a weight.
//
// NO permissionDecision. "allow" would skip the permission prompt for the
// spawn (the Agent tool asks in some permission modes), which is not this
// guard's call to make. Claude Code applies updatedInput with no decision
// (verified in the 2.1.280 and 2.1.281 binaries: a hook result carrying
// updatedInput and no permissionBehavior yields hookUpdatedInput), so the
// model fill-in does not need one.
function allowWith(systemMessage, updatedInput, additionalContext) {
  ({ systemMessage, additionalContext } = mergeLeadEffort(systemMessage, additionalContext)); // lead-effort live check (text only)
  // Text that is empty or only whitespace is no text. When there is nothing at
  // all to say or change, emit nothing: a bare {hookSpecificOutput:
  // {hookEventName}} object shows the lead an empty "PreToolUse:Agent says:".
  const msg = typeof systemMessage === 'string' && systemMessage.trim() ? systemMessage : null;
  const ctx = typeof additionalContext === 'string' && additionalContext.trim() ? additionalContext : null;
  if (!msg && !updatedInput && !ctx) process.exit(0);
  process.stdout.write(JSON.stringify({
    ...(msg ? { systemMessage: msg } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(updatedInput ? { updatedInput } : {}),
      ...(ctx ? { additionalContext: ctx } : {}),
    },
  }));
  process.exit(0);
}

// Several independent features each have their own opinion about the ONE
// systemMessage this hook may emit (the best-fit note below, and the three
// spawn-shape gates). Combined in one place so a second note added later
// does not silently clobber the first the way a second updatedInput would.
function combineNotes(...parts) {
  const joined = parts.filter(Boolean).join('\n\n');
  return joined || null;
}

// Evidence that THIS session's harness registered the ladder: SubagentStarts
// (hooks/spawn-log.mjs -> subagent-starts.jsonl) of ladder rungs in this same
// session, since it last loaded its plugins (loadedAtMs, when known: a
// /reload-plugins can break registration, which is the 2026-09-24 incident
// flow, so a start from before it proves nothing now). Registration cannot be
// queried from a hook, and a rewrite to an unregistered type fails the spawn
// with "Agent type not found", so the rewrite target must be one the harness
// has shown it registered:
//   - the plugin-namespaced rung ("<plugin>:<rung>") once ANY namespaced
//     ladder agent has started: plugin agents register together, from one
//     agents/ folder; this is the preferred form;
//   - the bare rung only when that EXACT bare name has started here AND its
//     file exists at project or user scope (<cwd>/.claude/agents or
//     ~/.claude/agents). Outside this plugin's own repo a bare name
//     registers only from those, and a partial user-level install is common;
//   - otherwise nothing, and the guard gives its advisory.
// Returns { target, why }; `why` explains a null target. Bounded tail read;
// never throws.
function ladderRewriteTarget(sid, rungAgent, cwd, loadedAtMs) {
  let namespacedPrefix = null;
  let bareExact = false;
  let anyBare = false;
  try {
    const rows = tailRecords(join(telemetryDir(), 'subagent-starts.jsonl'), {
      bytes: 65536,
      filter: (line) => line.includes(String(sid)),
    });
    for (const r of rows) {
      if (!r || r.session_id !== sid || !isLadderAgentName(r.agent_type)) continue;
      if (typeof loadedAtMs === 'number') {
        const at = Date.parse(r.at || '');
        if (!(at >= loadedAtMs)) continue;
      }
      const t = String(r.agent_type);
      if (t.includes(':')) namespacedPrefix = `${t.slice(0, t.indexOf(':'))}:`;
      else { anyBare = true; if (t === rungAgent) bareExact = true; }
    }
  } catch { /* no evidence */ }
  if (namespacedPrefix !== null) {
    const target = `${namespacedPrefix}${rungAgent}`;
    const d = agentDefinition(target, cwd);
    if (d && d.model) return { target, def: d, why: null };
  }
  if (bareExact) {
    for (const root of [cwd && join(cwd, '.claude', 'agents'), join(claudeDir(), 'agents')].filter(Boolean)) {
      if (existsSync(join(root, `${rungAgent}.md`))) {
        const d = agentDefinition(rungAgent, cwd);
        if (d && d.model) return { target: rungAgent, def: d, why: null };
      }
    }
  }
  const since = typeof loadedAtMs === 'number' ? ' since it last loaded its plugins' : '';
  const why = anyBare
    ? `only bare ladder names have started in this session${since}, and "${rungAgent}" itself has not started here ` +
      'from a user- or project-level file, so a bare rewrite could name an unregistered type'
    : `no ladder agent has started in this session${since}, so the harness has not shown it registered the ladder here`;
  return { target: null, def: null, why };
}

// "explore -> haiku (agent-companion:ac-haiku); ..." — the current
// routes of a few common task types, read through the same resolver the
// guard uses (routing profile included), for the deny texts that tell a
// spawner how to route instead. Read at deny time only, so the advice
// follows the table. '' when the table cannot be read.
function commonTypeRoutes(names = ['explore', 'bounded-feature', 'debug-root-cause', 'novel-design']) {
  const out = [];
  for (const n of names) {
    try {
      const r = resolveRoute({ type: n });
      if (!r.model) continue;
      // haiku has no effort: its rung is the one with none (rungFor wants null)
      const rung = rungFor(r.model, r.effort || null);
      out.push(`${n} -> ${r.model}${r.effort ? '/' + r.effort : ''}${rung ? ` (agent-companion:${rung.agent})` : ''}${routeLayerTag(r.layer)}`);
    } catch { /* skip this type */ }
  }
  return out.join('; ');
}

// Whether an opus model pinned by the running definition keeps the spawn out
// of the premium fan-out cap (operator decision 2026-09-27, narrowed after
// the 0.29.19 review). Exempt, as a deliberate choice of tier:
//   - this plugin's own ac-opus-* ladder rungs, except ac-opus-max (the top
//     rung, "large cost for small gain", stays counted);
//   - a project agent (<cwd>/.claude/agents) or a user agent
//     (~/.claude/agents): both are the operator's own files.
// Still counted: another plugin's agent (its author chose the tier, not the
// operator), a definition named like a built-in type (a project
// `general-purpose.md` pinning opus reads as the built-in to anyone reading
// the spawn), and ac-opus-max wherever it resolves. Fable is never exempt
// (the caller checks the alias is opus). Decided by the directory the
// definition was read from, the same file agentDefinition() returned.
const BUILTIN_AGENT_NAMES = new Set(['general-purpose', 'explore', 'plan', 'claude-code-guide', 'statusline-setup']);
function definitionPinExempt(type, def, cwd) {
  if (!def || !def.file || !type) return false;
  const t = String(type);
  const namespaced = t.includes(':');
  const bare = namespaced ? t.slice(t.indexOf(':') + 1) : t;
  if (BUILTIN_AGENT_NAMES.has(bare.toLowerCase()) || bare === 'ac-opus-max') return false;
  const norm = (d) => {
    const r = resolve(d);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  let from;
  try { from = norm(dirname(def.file)); } catch { return false; }
  const is = (d) => { try { return !!d && norm(d) === from; } catch { return false; } };
  if (is(ownAgentsDir())) return isLadderAgentName(bare);
  if (namespaced) return false;
  return projectAgentRoots(cwd).some(is);
}

// Whether a spawn is PROJECT-PINNED: a bare-named project or user agent (not a
// built-in type, not a ladder rung, not another plugin's `<plugin>:<agent>`)
// whose definition file sets a model the tier table knows and/or an effort
// level it knows. The operator chose that tier for that agent, so the guard
// does not judge it by task weight (see `pinned` in the main body). The scope
// is the folder the definition was read from: a project agents folder (the
// cwd's or a parent's up to the project root) or the user's.
// { pinned, scope: 'project' | 'user' | null, fields: 'model' | 'effort' | 'model+effort' | null }
function pinInfo(type, def, cwd) {
  const none = { pinned: false, scope: null, fields: null };
  try {
    if (!def || !def.file || !type) return none;
    const t = String(type);
    if (t.includes(':') || BUILTIN_AGENT_NAMES.has(t.toLowerCase()) || isLadderAgentName(t)) return none;
    const norm = (d) => {
      const r = resolve(d);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const from = norm(dirname(def.file));
    const roots = projectAgentRoots(cwd);
    // roots: the cwd's own folder first (project), its parents (project), the
    // user's last. A cwd that is the user's own folder reads as project.
    const at = roots.findIndex((r) => norm(r) === from);
    if (at < 0) return none;
    const scope = (at === roots.length - 1 && !(at === 0 && cwd)) ? 'user' : 'project';
    const model = String(def.model || '').trim();
    const hasModel = !!model && !/^inherit$/i.test(model) && classifyModel(model).known;
    const hasEffort = !!def.effort && classifyEffort(def.effort).known;
    if (!hasModel && !hasEffort) return none;
    return { pinned: true, scope, fields: hasModel && hasEffort ? 'model+effort' : hasModel ? 'model' : 'effort' };
  } catch { return none; }
}

try {
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
  const roleLineNudge = !declaredRole && opt('role_line_nudge', true)
    ? 'agent-companion: this brief has no `ROLE:` line. Add one on its own line next to `TYPE:`: ' +
      '`ROLE: <reviewer|fixer|lander|writer|docs|lookup|operate|other>`, the role of the main deliverable. ' +
      'It tags the spawn for usage measurement only and changes no routing. Not blocking.'
    : null;
  // A TYPE: line that is no type (and no alias) routes and measures nothing:
  // say so once, naming the valid ones (type_line_nudge). Never a deny.
  const typeNudge = declaredTypeRaw && !canonicalTaskType(declaredTypeRaw) && opt('type_line_nudge', true)
    ? `agent-companion: TYPE: ${declaredTypeRaw} is not a task type, so it routes and measures nothing. ${unknownTypeHint(declaredTypeRaw).replace(/^"[^"]*" is not a task type\. /, '')} Not blocking.`
    : null;
  const roleNudge = [roleLineNudge, typeNudge].filter(Boolean).join('\n') || null;
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
  const spawnAlias = model ? classifyModel(model).alias : '';
  const routingKnown = fitOn && !!route?.model;
  const routeMatchesModel = routingKnown && !!spawnAlias && classifyModel(route.model).alias === spawnAlias;
  const isPremiumForSpawn = spawnAlias === 'fable' ? true : (routeMatchesModel ? false : isPremium(model));
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
  const rewriteModule = () => import('./lib/ladder-rewrite.mjs');
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
  // one. Haiku is excluded — it takes no effort parameter, so there is
  // nothing to inherit.
  const modelTakesEffort = !!model && effortSupported(model, 'high').ok;
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
        'frontmatter — a brief-level "EFFORT:" line does NOT set it; effort is locked to the definition, not the ' +
        'spawn call.')
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

  // --- Memory brief (deliverable 2) --------------------------------------
  // Computed ONCE, here — not lazily inside each allow branch the way this
  // used to work — because the spawn-telemetry row below needs the nudge's
  // OWN facts (mode, whether anything was attached, the counts it reported)
  // to make delivery observable at all: before this, spawns.jsonl carried
  // zero keys naming the memory feature, so confirming a nudge actually
  // reached a subagent's prompt required a live echo probe rather than a
  // telemetry query. Computing this ahead of the deny checks below does mean
  // a spawn later denied for an unrelated reason (fit/warrant/cap) still
  // pays for this — accepted, because loadOrBuildIndex with
  // rebuildIfStale:false is a single cached JSON read in the steady state,
  // not the full corpus rebuild the original lazy-computation comment was
  // guarding against; the one truly expensive build (no cache yet) happens
  // once ever, not per spawn.
  //
  // memory_search is the master switch for the whole feature; memory_brief
  // is the narrower "say something about memory at spawn time" behaviour.
  // Both must be turned on — each defaults to false, so this is inert until
  // both are. memory_brief_mode then picks WHICH behaviour runs:
  //   "nudge"    (default) — threshold-free, relevance-blind capability
  //               mention. See lib/memory-brief.mjs for why this is the
  //               default: BM25 score does not separate relevance from
  //               brief length on this corpus, and there is no threshold
  //               that fixes it.
  //   "pointers" — the original BM25-ranked, minScore-gated block.
  //   "off"      — memory_brief is on but neither behaviour runs.
  let memoryAddition = ''; // exact string appended to the prompt; '' = nothing to add
  let memoryFacts = null;  // telemetry-shaped facts; null = the feature never ran for this spawn
  // Namegate (Gate 4, below): set once a name is autofilled. Declared here,
  // alongside memoryAddition, so withAdditions() below can close over it
  // regardless of where in the file it is assigned — the same reason
  // memoryAddition is declared ahead of the gates that follow it.
  let namegateSuffix = '';
  if (opt('memory_search', false) && opt('memory_brief', false)) {
    const mode = String(opt('memory_brief_mode', 'nudge')).toLowerCase();
    if (mode !== 'off') {
      // Repo scope config — shared by both modes below. memory_search_repo
      // (default true) is a separate switch from the memory_search/memory_brief
      // gates already checked above — those two turn the WHOLE spawn-time
      // feature on or off; this one only decides whether the repo half
      // contributes once the feature is already running (the CLI's --scope
      // flag reads the same opt() independently of memory_search entirely,
      // since it is not gated by the spawn-time feature at all).
      const repoOpts = {
        repoEnabled: opt('memory_search_repo', true),
        repoGlobs: parseRepoGlobs(opt('memory_search_repo_globs', DEFAULT_REPO_GLOBS.join(','))),
        repoMaxFileBytes: Math.max(1, opt('memory_search_max_file_kb', 256)) * 1024,
        repoMaxTotalBytes: Math.max(1, opt('memory_search_max_repo_mb', 8)) * 1024 * 1024,
      };

      try {
        if (mode === 'pointers') {
          const mb = buildMemoryBrief({
            prompt: brief,
            cwd: p.cwd,
            maxHits: opt('memory_brief_max_hits', 3),
            minScore: opt('memory_brief_min_score', 25),
            dataDirPath: dataDir(),
            ...repoOpts,
          });
          memoryAddition = mb.block || '';
          memoryFacts = { mode: 'pointers', ...mb.facts };
        } else {
          // "nudge", and any unrecognised value — fail toward the safe
          // default rather than silently doing nothing for a typo'd config.
          const nudge = buildMemoryNudge({ cwd: p.cwd, dataDirPath: dataDir(), ...repoOpts });
          memoryAddition = nudge.text || '';
          memoryFacts = { mode: mode === 'nudge' ? 'nudge' : `nudge(unrecognised:${mode})`, ...nudge.facts };
        }
      } catch { /* fail open: nothing appended, spawn proceeds untouched */ }
    }
  }

  // Everything appended to the spawn brief is merged into the SAME updatedInput
  // fit_autofill may already be building above — see the module banner in
  // lib/memory-brief.mjs for why this must stay a plain merge rather than a
  // second hook on this matcher: exactly one updatedInput per spawn.
  //
  // THREE features append now, which adds a hazard two did not have: each one
  // rebuilding the prompt from `input.prompt` independently would make the LAST
  // one win and silently drop the others, with no error anywhere. So they
  // accumulate into one suffix and the prompt is rebuilt exactly once, below.
  let selfReviewSuffix = ''; // set by the self-review block further down, before any call
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

    if (!suffix) return baseInput;
    return { ...(baseInput || input), prompt: `${input.prompt || ''}${suffix}` };
  }

  // --- Spawn-shape gating (Gates 1-3) -------------------------------------
  // Three checks on HOW a spawn is shaped, orthogonal to WHAT MODEL runs it
  // (the fit/warrant/cap checks below this one). Measured from
  // ~/.claude/agent-companion/telemetry/spawns.jsonl (the 194+ rows that
  // carry run_in_background): most main-session spawns run FOREGROUND,
  // which blocks the lead's entire turn until the agent returns — three
  // such spawns on 2026-09-20/21 locked the operator out for 18, 26.7 and
  // 25.8 minutes apiece, unable to act on four messages sent mid-turn.
  // Every spawn that passed `isolation` was also named, and per
  // agent-teams.md that silently demotes it from teammate to ordinary
  // subagent regardless of the name. And a chunk of spawns were both
  // unnamed AND unisolated: sharing the lead's own working tree (can commit
  // there, moving HEAD) with no address to re-brief them afterward.
  //
  // Anthropic publishes no foreground-vs-background guidance. Gate 1 is
  // this plugin's own operating decision, and its message says so.
  // subagentCaller: computed with the WRITER line above (callerIsSubagent).
  const runsInBackground = input.run_in_background === true;
  const gate1Applicable = !subagentCaller && !runsInBackground;

  // Exemption: the resolved model (post-autofill — what will ACTUALLY run)
  // is the plugin's own cheapest KNOWN tier per config/model-tiers.json
  // ("reads, searches, single commands" — haiku today, whichever alias
  // ranks lowest if the table changes). Cheapest is also the fastest to
  // return, so blocking the lead's turn for one is genuinely low-cost. This
  // reuses the plugin's own existing tier classification instead of a new
  // prompt-length/content heuristic nobody could inspect, and — like
  // classifyModel() itself — an unknown or still-unresolved model is NEVER
  // exempt: fail toward the gate firing, not toward silence. Measured
  // against the real corpus: 19 of 148 raw-applicable foreground spawns
  // were haiku-tier — a real minority carve-out, not a loophole that
  // swallows the gate.
  let gate1CheapExempt = false;
  try {
    const modelClass = classifyModel(model);
    const ranks = Object.values(modelTiers().tiers || {})
      .map((t) => t.rank)
      .filter((r) => typeof r === 'number');
    const cheapestRank = ranks.length ? Math.min(...ranks) : null;
    gate1CheapExempt = !!(modelClass.known && cheapestRank !== null && modelClass.rank === cheapestRank);
  } catch { /* fail open: not exempt */ }
  const gate1Exempt = gate1Applicable && gate1CheapExempt;

  const gate1ModeRaw = String(opt('foreground_guard', 'warn')).toLowerCase();
  // Unrecognised value: fail toward the default, same direction
  // memory_brief_mode takes for a typo'd config rather than going silent.
  const gate1Mode = ['off', 'warn', 'block'].includes(gate1ModeRaw) ? gate1ModeRaw : 'warn';
  const gate1Live = gate1Applicable && !gate1Exempt && gate1Mode !== 'off';
  const gate1Justified = /FOREGROUND\s*:/i.test(brief);
  let gate1Action = 'none'; // none | warn | block — what THIS spawn actually gets
  if (gate1Live) {
    gate1Action = gate1Mode === 'block' ? (gate1Justified ? 'none' : 'block') : 'warn';
  }

  // Gate 2: telemetry only (0.31.7). It used to tell the caller that a spawn
  // passing both a name and isolation is an ordinary subagent, not an
  // addressable teammate. That is wrong on desktop, where every named spawn is
  // a subagent that background peers can still message by name, and this hook
  // cannot tell a real TeamCreate team session apart. The message is gone;
  // the fact stays in the spawn row.
  const gate2Fired = opt('isolation_demotion_notice', true) && !!input.name && !!input.isolation;

  // --- Gate 4: namegate (track "namegate", operator decision 2026-09-25:
  // "every background worker gets a name") --------------------------------
  // Computed BEFORE Gate 3 below, not after: if this gate autofills a name,
  // Gate 3's own "no address to re-brief it later" claim would otherwise be
  // stated falsely for the same spawn (it now HAS an address). See
  // namegateEffectiveName.
  //
  // Scope: MAIN-session spawns only (a subagent-originated spawn is out of
  // scope for both the hint and autofill — same callerIsSubagent exclusion
  // Gate 1 already uses), and only an EXPLICIT run_in_background: true
  // (reusing runsInBackground exactly as Gate 1 defines it above). The hook
  // input carries no field revealing whether THIS session defaults an
  // omitted run_in_background to background or foreground — no
  // entrypoint/session-type marker appears anywhere in the PreToolUse
  // payload this hook reads (session_id, agent_type, cwd, tool_input; see
  // the fixtures in tests/spawn-shape-gates.test.mjs) — and that default is
  // known to vary by session type (interactive fork mode vs SDK/headless).
  // Rather than guess "absent means background" and risk a false hint on a
  // spawn that is really running foreground, this stays scoped to the one
  // case the hook can actually verify.
  //
  // Autofill mechanics: `<project>-<type>-<slug>` (lib/namegate.mjs),
  // written into updatedInput exactly as the fit_autofill block above
  // writes `model`/`subagent_type` — proven honoured by the harness via a
  // live probe (2026-09-25, outside this repo, never committed): see
  // lib/namegate.mjs's own header comment for the full method, since there
  // is no passive SubagentStart signal for `name` the way 0.29.6 had for
  // `subagent_type`. Uniqueness is against this session's own already-named
  // spawns (sessionSpawnNames, read from the same spawns.jsonl/fixtures.jsonl
  // telemetry every other consumer of session history reads here), which
  // doubles as the peer list the autofilled worker's own brief addition
  // names — PLUS an atomic reservation (reserveUniqueName, wx-marker per
  // (session, name), mirroring spawn-log.mjs's noteAgentType()) so two
  // truly-concurrent spawns in one message cannot both read the same
  // pre-existing peer set and autofill the identical name (fix round,
  // review finding 1). Also excludes the harness's reserved addressing
  // names ("main", "team-lead" — review finding 2). Never denies; fails
  // open to "no name, no note" on any error.
  const gate4Applicable = !subagentCaller && runsInBackground && !input.name && opt('namegate', true);
  let gate4Action = 'none'; // none | hint | autofill
  let namegateName = null;
  if (gate4Applicable) {
    if (opt('namegate_autofill', true)) {
      try {
        const candidate = buildCandidateName({
          cwd: p.cwd, declaredType, subagentType: input.subagent_type, description: input.description,
        });
        const peers = sessionSpawnNames(sid);
        namegateName = reserveUniqueName(sid, candidate, peers);
        updatedInput = { ...(updatedInput || input), name: namegateName };
        namegateSuffix = buildNamegateBrief({ name: namegateName, peers });
        gate4Action = 'autofill';
      } catch { gate4Action = 'none'; namegateName = null; } // fail open
    } else {
      gate4Action = 'hint';
    }
  }
  // What Gate 3 (below) should treat as "this spawn has an address":
  // its own original name, or the one Gate 4 just assigned.
  const namegateEffectiveName = input.name || namegateName;

  // Gate 3: scoped narrowly to the exact worst-of-both-worlds shape measured
  // above — unnamed AND unisolated. Considered and rejected a subagent_type
  // "plausibly read-only" refinement: even Explore, the built-in read-only
  // search agent, keeps Bash — only Edit/Write/NotebookEdit are withheld —
  // so it can still write a file via shell redirection. subagent_type is
  // not a reliable write/no-write signal even for a built-in type, let
  // alone a project-defined one whose tool grants this hook cannot see.
  // Narrow-and-honest beats broad-and-guessed, so this stays exactly the
  // unnamed-and-unisolated case rather than trying to also exclude
  // "probably read-only" types on weak evidence.
  const gate3Fired = opt('shared_tree_notice', true) && !namegateEffectiveName && !input.isolation;

  const gate1WarnMsg = gate1Action === 'warn'
    ? 'agent-companion: this spawn runs in the FOREGROUND and will block the lead\'s entire turn until it returns ' +
      '(not Anthropic guidance - this plugin\'s own operating decision: most main-session spawns measured this way ' +
      'ran foreground, and single foreground spawns have locked the operator out for 18-27 minutes). If the result ' +
      'is not needed before the lead can continue, add run_in_background: true.'
    : '';
  const gate3Msg = gate3Fired
    ? 'agent-companion: this spawn has no name and no isolation - it runs in the LEAD\'S OWN working tree (it can ' +
      'commit and move HEAD there) and has no address to re-brief it later. Consider isolation: "worktree" and/or a name.'
    : '';
  const gate4Msg = gate4Action === 'autofill'
    ? `agent-companion (namegate): this spawn ran in the background with no name; set name="${namegateName}" - an ` +
      'unnamed background worker cannot be addressed with SendMessage afterward. Set namegate_autofill: false to ' +
      'only advise instead of naming.'
    : gate4Action === 'hint'
      ? 'agent-companion (namegate): this spawn runs in the background with no name - it will not be addressable ' +
        'by SendMessage afterward, and other workers this session won\'t see it in a peer list. Add a name (e.g. ' +
        '"<project>-<type>-<slug>"), or turn on namegate_autofill so the guard assigns one.'
      : '';
  const gateMessage = [gate1WarnMsg, gate3Msg, gate4Msg].filter(Boolean).join('\n\n');

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
        if (selfReviewExpected === false || pinnedNoBlock) {
          const rung = pinnedNoBlock
            ? pinnedInjectionRung(def, model, callerEffort)
            : injectionRung(runningType, def, model);
          if (rung) {
            // A brief that states no CONSEQUENCE still carries its type's
            // preset: a critical type's self-review names the critical
            // review rung. Text only; no guard decision reads this value.
            let reviewConsequence = consequenceWasDeclared ? declaredConsequence : null;
            if (!consequenceWasDeclared) {
              try { if (taskTypeDef(declaredType)?.def?.consequence === 'critical') reviewConsequence = 'critical'; } catch { /* table unreadable */ }
            }
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
    // frontmatter wins when it declares one. A model with an empty `efforts`
    // list in the tier table (haiku) takes no effort parameter at all, so
    // there is nothing to inherit. Otherwise built-in types run at whatever
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
      gate1_mode: gate1Mode,             // off | warn | block — the configured mode
      gate1_applicable: gate1Applicable, // main-session caller, not already backgrounded
      gate1_exempt: gate1Exempt,         // applicable, but excused: resolved model is the cheapest known tier
      gate1_action: gate1Action,         // none | warn | block — what THIS spawn actually got
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
  } else if (fit?.verdict === 'under') {
    // The cheap direction is never blocked, but a weight-4 task on haiku is
    // the failure that ships wrong code, so it is said out loud.
    note =`agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is under-provisioned — ${fit.reason}${routeLayerNote}. ${fit.action}.`;
  } else if (fit?.verdict === 'over' && !isPremiumForSpawn) {
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is over-provisioned — ${fit.reason}; the table says ${routeLabel}${routeLayerNote}. Re-spawn there unless the weight is understated.`;
  }
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
    toolNote,
    pinReplacedNote,
  );

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
  if (fit?.verdict === 'over' && !parityRoute && !pinned) {
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
    if (!warrantDeclared) {
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
