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

import { createHash } from 'node:crypto';
import {
  readStdin, noteAgentType, isPremium, opt, stateFile, readJson, writeJson,
  appendLog, deny, passthrough, recordDenial, agentDefinition, evaluateFit, effortFor,
  effortSupported, dataDir, callerTranscriptPath, lastAssistantMeta,
  classifyModel, modelTiers,
} from './lib/context.mjs';
import { buildMemoryBrief, buildMemoryNudge } from './lib/memory-brief.mjs';
import { parseRepoGlobs, DEFAULT_REPO_GLOBS } from './lib/memory-index.mjs';
import { buildContract } from './lib/brevity.mjs';
import { matchRules, renderRules } from './lib/rules.mjs';

const WINDOW_MS = 10 * 60 * 1000; // rolling window used to approximate concurrency

// Allow — optionally saying something to the user, and/or rewriting the tool
// input (`updatedInput` is how a PreToolUse hook fills in a model the spawn
// left blank). The guard never blocks the cheap direction, but neither
// direction passes in silence once the brief has declared a weight.
function allowWith(systemMessage, updatedInput) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
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
  const def = agentDefinition(input.subagent_type, p.cwd);
  const fromDef = def?.model || '';
  let model = declared || fromDef;              // what will actually run, when knowable
  const trulyInherited = !declared && !fromDef; // nobody chose: the real hazard

  // A spawn means delegation happened — clear the main-thread streak.
  try {
    const df = stateFile('delegation-streak.json');
    const dst = readJson(df, {});
    if (dst[sid]) writeJson(df, { ...dst, [sid]: { ...dst[sid], streak: 0 } });
  } catch { /* fail open */ }

  // The canary deliberately provokes this guard, so it must not be recorded as
  // real activity — otherwise the probe pollutes the very telemetry the audit
  // then reads back, and every canary run inflates the premium spawn count.
  const isCanary = String(sid).startsWith('canary');

  // The routing table is downstream of a number nobody used to record: the
  // doctrine says to score task weight 1-5 *silently*, so the judgement that
  // chose the tier left no trace and could never be compared against what the
  // task turned out to need. Capture it whenever it IS stated.
  const brief = String(input.prompt || '');
  const wm = brief.match(/\b(?:WARRANT|WEIGHT)\s*:\s*(?:weight\s*)?([1-5])\b/i);
  const declaredWeight = wm ? Number(wm[1]) : null;
  const km = brief.match(/\bKIND\s*:\s*(mechanical|bounded|diagnostic|novel-design)\b/i);
  const declaredKind = km ? km[1].toLowerCase() : null;
  const cm = brief.match(/\bCONSEQUENCE\s*:\s*(routine|elevated|critical)\b/i);
  const declaredConsequence = cm ? cm[1].toLowerCase() : null;

  // --- Best fit ----------------------------------------------------------
  // The table's answer for the declared weight, used two ways: filled in where
  // the spawn left the model blank (the inheritance hazard, closed at its
  // source), and as the yardstick for a model the spawn did name.
  const fitOn = opt('fit_guard', true) && !!declaredWeight;
  let route = null;
  if (fitOn) {
    try { route = effortFor(declaredWeight, declaredKind || 'bounded', declaredConsequence || 'routine'); } catch { /* table unreadable */ }
  }
  const routeLabel = route?.model ? `${route.model}${route.effort ? '/' + route.effort : ''}` : '';

  let autofilled = false;
  let updatedInput = null;
  if (fitOn && trulyInherited && route?.model && opt('fit_autofill', true)) {
    model = route.model;
    autofilled = true;
    updatedInput = { ...input, model };
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
  function withAdditions(baseInput) {
    let suffix = '';

    // 1. The reporting contract — the operator's token spend is dominated by
    //    subagents narrating their journey when only blockers and an outcome
    //    were wanted. Global switch, per-agent override in either direction,
    //    and a peer-brevity clause that holds even when the contract is off.
    //    See lib/brevity.mjs.
    try {
      suffix += buildContract(input.subagent_type) || '';
    } catch { /* fail open: no contract, spawn proceeds untouched */ }

    // 2. Operator-authored standing rules scoped to spawns, their conditions
    //    matched against this brief's own text. See lib/rules.mjs.
    try {
      if (opt('standing_rules', true)) {
        const hits = matchRules({ scope: 'spawn', text: brief, sessionId: sid });
        suffix += renderRules(hits, { maxChars: opt('standing_rules_max_chars', 2000) }) || '';
      }
    } catch { /* fail open */ }

    // 3. The memory addition, already computed above so its facts can reach
    //    the telemetry row whether or not this spawn is ultimately allowed.
    suffix += memoryAddition || '';

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
  const callerIsSubagent = !!p.agent_id; // identical to spawns.jsonl's own caller_is_subagent
  const runsInBackground = input.run_in_background === true;
  const gate1Applicable = !callerIsSubagent && !runsInBackground;

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

  // Gate 2: pure information, always cheap to compute, never blocks. Cites
  // agent-teams.md directly so the claim is checkable, not just asserted.
  const gate2Fired = opt('isolation_demotion_notice', true) && !!input.name && !!input.isolation;

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
  const gate3Fired = opt('shared_tree_notice', true) && !input.name && !input.isolation;

  const gate1WarnMsg = gate1Action === 'warn'
    ? 'agent-companion: this spawn runs in the FOREGROUND and will block the lead\'s entire turn until it returns ' +
      '(not Anthropic guidance - this plugin\'s own operating decision: most main-session spawns measured this way ' +
      'ran foreground, and single foreground spawns have locked the operator out for 18-27 minutes). If the result ' +
      'is not needed before the lead can continue, add run_in_background: true.'
    : '';
  const gate2Msg = gate2Fired
    ? `agent-companion: this spawn names "${input.name}" AND passes isolation - per agent-teams.md, passing ` +
      'isolation on the call makes it an ORDINARY SUBAGENT rather than a teammate even though it is named, so it ' +
      'will not be addressable by that name afterward.'
    : '';
  const gate3Msg = gate3Fired
    ? 'agent-companion: this spawn has no name and no isolation - it runs in the LEAD\'S OWN working tree (it can ' +
      'commit and move HEAD there) and has no address to re-brief it later. Consider isolation: "worktree" and/or a name.'
    : '';
  const gateMessage = [gate1WarnMsg, gate2Msg, gate3Msg].filter(Boolean).join('\n\n');

  let fit = null;
  if (fitOn && model && !autofilled) {
    try {
      fit = evaluateFit({
        model, effort: def?.effort || '', weight: declaredWeight,
        kind: declaredKind || 'bounded', consequence: declaredConsequence || 'routine',
      });
    } catch { /* table unreadable: the audit reports that separately */ }
  }

  if (opt('spawn_telemetry', true) && !isCanary) {
    // --- Schema v2 additions: who is spawning, and at what effort ----------
    // The caller's OWN transcript (not the new subagent's — it does not exist
    // yet at PreToolUse time), read via a bounded tail so this never risks the
    // hook's timeout on a large session.
    const callerTranscript = callerTranscriptPath(p);
    const callerMeta = callerTranscript ? lastAssistantMeta(callerTranscript) : null;
    const callerModel = (callerMeta && callerMeta.model) || null;
    const callerEffort = p.effort?.level || (callerMeta && callerMeta.effort) || null;

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

    appendLog('spawns.jsonl', {
      at: new Date().toISOString(),
      session_id: sid,
      spawned_by_agent_type: p.agent_type,
      model: model || '(inherited)',      // effective model, when knowable (autofilled counts)
      model_declared: declared || null,   // named at the spawn site
      model_definition: fromDef || null,  // named in the agent's frontmatter
      model_autofilled: autofilled,       // the guard set it from the table
      inherited: trulyInherited,          // true when NEITHER the spawn nor the definition named one
      subagent_type: input.subagent_type,
      run_in_background: typeof input.run_in_background === 'boolean' ? input.run_in_background : null,
      isolation: input.isolation ?? null,
      name: input.name ?? null,
      team_name: input.team_name ?? null,
      desc_sha: descSha,       // sha256(description).slice(0,16) — hashed, never stored raw
      desc_len: descLen,
      caller_is_subagent: !!p.agent_id,
      caller_agent_id: p.agent_id || null,
      caller_model: callerModel,
      caller_effort: callerEffort,        // the CALLER's effort — what v1 `effort` held
      spawn_effort: spawnEffort,          // the SPAWN's own effort
      spawn_effort_source: spawnEffortSource, // definition | inherited | none
      effort_definition: def?.effort || null,
      declared_weight: declaredWeight,   // null when the brief did not say
      declared_kind: declaredKind,
      declared_consequence: declaredConsequence,
      fit: autofilled ? 'fit' : fit ? fit.verdict : null, // over | under | fit | unknown, when a weight was declared
      fit_expected: routeLabel || null,
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
    });
  }

  // --- Gate 1, block mode --------------------------------------------------
  // Checked before the isPremium() early-return just below: spawn SHAPE is
  // orthogonal to model TIER, so this must apply the same way to a premium
  // spawn and a cheap one, not only to whichever one isPremium() lets fall
  // through to the fit/warrant/cap checks.
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

  const who = input.subagent_type || 'an agent';
  let note = null;
  if (autofilled) {
    note = `agent-companion: spawn of ${who} named no model; set model=${model} from the routing table for declared weight ${declaredWeight} (${routeLabel}).`;
  } else if (fit?.verdict === 'under') {
    // The cheap direction is never blocked, but a weight-4 task on haiku is
    // the failure that ships wrong code, so it is said out loud.
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is under-provisioned — ${fit.reason}. ${fit.action}.`;
  } else if (fit?.verdict === 'over' && !isPremium(model)) {
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is over-provisioned — ${fit.reason}; the table says ${routeLabel}. Re-spawn there unless the weight is understated.`;
  }

  if (!isPremium(model)) allowWith(combineNotes(note, gateMessage), withAdditions(updatedInput));

  // --- Best fit, premium: deny ------------------------------------------
  // A premium tier for a declared weight the table sends elsewhere is the
  // over-provisioning this plugin exists to stop, stated by the spawner
  // itself. Deny with the exact correction rather than a nudge.
  if (fit?.verdict === 'over') {
    recordDenial('fit', p, `${model} requested for declared weight ${declaredWeight}; table says ${routeLabel}`);
    deny(
      `Best fit: this spawn requests "${model}" but declares weight ${declaredWeight}` +
      (declaredKind ? ` (${declaredKind})` : '') +
      (declaredConsequence ? `, ${declaredConsequence} consequence` : '') +
      `, which the routing table sends to ${routeLabel}. ${fit.reason}.\n\n` +
      `Either re-spawn at ${routeLabel}, or restate the brief honestly: a higher WEIGHT if the task ` +
      `is heavier than declared, or CONSEQUENCE: critical if a mistake would be expensive or ` +
      `irreversible (that raises the model floor). A warrant that contradicts its own weight is ` +
      `exactly the over-provisioning this guard exists to stop.`
    );
  }

  // --- Warrant -----------------------------------------------------------
  if (opt('warrant_required', true)) {
    if (!/WARRANT\s*:/i.test(brief)) {
      recordDenial('warrant', p, `premium tier ${model} requested with no warrant`);
      deny(
        (autofilled
          ? `Premium warrant: the routing table sends declared weight ${declaredWeight} to "${model}", a premium tier, and the brief states no justification.\n\n`
          : `Premium warrant: this spawn requests "${model}", a premium tier, with no stated justification.\n\n`) +
        `Add a line to the agent's brief in the form:\n` +
        `  WARRANT: weight <1-5> — <why a cheaper tier cannot do this>\n\n` +
        `If you cannot write that line honestly, the task does not warrant the tier — ` +
        `re-spawn at sonnet (or haiku for reads and searches). These warrants are logged ` +
        `and audited, so a weak one is worse than a downgrade.`
      );
    }
  }

  // --- Concurrency cap ---------------------------------------------------
  if (opt('premium_cap', true)) {
    const cap = Math.max(1, opt('premium_max_concurrent', 2));
    const f = stateFile('premium-window.json');
    const now = Date.now();
    const all = readJson(f, []);
    const recent = all.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= cap) {
      writeJson(f, recent);
      recordDenial('premium-cap', p, `${recent.length} premium agents in window, cap ${cap}`);
      deny(
        `Premium fan-out cap: ${recent.length} premium-tier agents already started in the last ` +
        `${WINDOW_MS / 60000} minutes and the cap is ${cap}.\n\n` +
        `This is the exact shape of the four-Fable incident: each spawn looked reasonable ` +
        `alone, and nothing was counting them together. Run this one at sonnet, or wait for ` +
        `the in-flight premium agents to finish.\n\n` +
        `(Concurrency is approximated by a rolling window, so a batch of genuinely-warranted ` +
        `premium work may need the cap raised in settings rather than worked around.)`
      );
    }
    if (!isCanary) writeJson(f, [...recent, now]); // a probe must not consume the cap
  }

  allowWith(combineNotes(note, gateMessage), withAdditions(updatedInput));
} catch {
  passthrough(); // never break a session
}
