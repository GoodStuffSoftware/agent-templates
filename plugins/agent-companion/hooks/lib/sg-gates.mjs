// spawn-guard phase 4: the memory brief and the spawn-shape gates (1 foreground, 2 isolation demotion, 3 shared tree, 4 namegate).
// Moved verbatim from hooks/spawn-guard.mjs, which calls it in order; the
// parameters are the guard's own locals this phase reads, the return value
// the locals it declares or reassigns that later phases read.

import { classifyModel, dataDir, modelTiers, opt } from './context.mjs';
import { buildMemoryBrief, buildMemoryNudge } from './memory-brief.mjs';
import { DEFAULT_REPO_GLOBS, parseRepoGlobs } from './memory-index.mjs';
import { buildCandidateName, buildNamegateBrief, reserveUniqueName, sessionSpawnNames } from './namegate.mjs';

export function memoryAndShapeGates({
  brief, p, input, subagentCaller, model, silentFixes, updatedInput, declaredType, sid,
}) {

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
  const bgDeclared = input.run_in_background === true;
  const gate1Applicable = !subagentCaller && !bgDeclared;

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

  // 0.31.36: "fix" (default; "warn" is its old name and means the same) sets run_in_background: true
  // through updatedInput on a spawn that left the flag out, with no message.
  const gate1ModeRaw = String(opt('foreground_guard', 'fix')).toLowerCase();
  // Unrecognised value: fail toward the default, same direction
  // memory_brief_mode takes for a typo'd config rather than going silent.
  const gate1Mode = ['off', 'warn', 'fix', 'block'].includes(gate1ModeRaw) ? (gate1ModeRaw === 'warn' ? 'fix' : gate1ModeRaw) : 'fix';
  const gate1Live = gate1Applicable && !gate1Exempt && gate1Mode !== 'off';
  const gate1Justified = /FOREGROUND\s*:/i.test(brief);
  let gate1Action = 'none'; // none | fix | block — what THIS spawn actually gets
  if (gate1Live) {
    if (gate1Mode === 'block') gate1Action = gate1Justified ? 'none' : 'block';
    // Only a spawn that LEFT OUT the flag is fixed: an explicit run_in_background: false is the
    // lead's own choice (logged, not changed), a FOREGROUND: line is the opt-out, and a teammate
    // spawn is not an ordinary subagent.
    else if (!gate1Justified && input.run_in_background === undefined && !input.team_name) gate1Action = 'fix';
    else if (!gate1Justified) silentFixes.push('foreground_logged');
  }
  if (gate1Action === 'fix') {
    updatedInput = { ...(updatedInput || input), run_in_background: true };
    silentFixes.push('background_set');
  }
  // What the rest of the guard (namegate below) treats as backgrounded: declared, or just set above.
  const runsInBackground = bgDeclared || gate1Action === 'fix';

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


  const gate3Msg = gate3Fired
    ? 'agent-companion: this spawn has no name and no isolation - it runs in the LEAD\'S OWN working tree (it can ' +
      'commit and move HEAD there) and has no address to re-brief it later. Consider isolation: "worktree" and/or a name.'
    : '';
  // 0.31.36: an autofilled name is a silent fix (the worker's brief carries it; name_autofilled is in the row).
  const gate4Msg = gate4Action === 'hint'
      ? 'agent-companion (namegate): this spawn runs in the background with no name - it will not be addressable ' +
        'by SendMessage afterward, and other workers this session won\'t see it in a peer list. Add a name (e.g. ' +
        '"<project>-<type>-<slug>"), or turn on namegate_autofill so the guard assigns one.'
      : '';
  const gateMessage = [gate3Msg, gate4Msg].filter(Boolean).join('\n\n');
  return {
    memoryAddition, memoryFacts, namegateSuffix, selfReviewSuffix, gate1Applicable, gate1Exempt, gate1Mode,
    gate1Action, gate2Fired, gate4Applicable, gate4Action, namegateName, gate3Fired, gateMessage,
    updatedInput,
  };
}
