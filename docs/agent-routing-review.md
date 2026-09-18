# Agent routing review: what a three-tier fleet actually does, and what to enforce

**Status:** review and proposals only. No doctrine, hook, settings or plugin file was changed under this work.
**Date:** 2026-09-18. **Window measured:** 2026-08-28 to 2026-09-18 (three weeks).
**Card:** `tighten-agent-routing-rules-so-leads-tea-99477052` (spike, P1).

The operator suspected that written rules alone do not keep lead sessions, their teammates, and the
sub-agents those spawn on the right model, effort and shape, and that more granular enforcement is
needed. This review measured three weeks of real sessions on the operator's machine against the
doctrine (`~/.claude/CLAUDE.md` and the `team-orchestration` skill), found where they diverge, and
proposes one fix per gap, each classified by mechanism and per-session token cost.

---

## 0. The answer in brief

**The suspicion is right, but the enforcement is guarding the wrong place.**

1. **The one rule the guards enforce is mostly followed.** Every explicit spawn model was honoured
   (879 of 879). 93% of teammate spawns and 78% of lead spawns name a model. Most spawns without one
   get it from a pinned agent definition. True inheritance of a premium lead model happened
   **8 times in three weeks** (6 of them inherited opus).
2. **The money is elsewhere, and nothing guards it.** Estimated spend in the window is **$10,407**,
   and **76.8%** of it is opus or fable. Two unguarded surfaces carry most of it:
   - **Teammate session models.** Fable, which the doctrine calls "an exception, not a tier", ran
     **56% of all teammate turns** and cost **$3,198 (31% of all spend)**. Only **1 of 13** fable
     sessions stated a warrant. The spawn guard never sees this: a teammate is a session started
     from a `spawn_task` chip, which has no model parameter.
   - **Leads and teammates doing the work themselves** on very large premium contexts. Cache reads
     are **69%** of spend. Every tool call a fable teammate makes re-reads about **543k tokens**
     (about $0.54). The same call in a sonnet sub-agent re-reads about 173k (about $0.035), roughly
     **15× cheaper**. The doctrine's "delegate after about 3 steps" is broken by **46 of 46 leads and
     31 of 33 teammates**. The median longest run without a spawn is **37 calls** for leads and
     **42** for teammates.
3. **Parts of the doctrine are wrong or unenforceable on this harness:**
   - **Effort-by-weight cannot work for built-in agent types.** They run at the parent session's
     effort: **285 of 285** non-haiku built-in sub-agents did. So "weight 3 → sonnet/medium" is not
     achievable without an agent definition.
   - **The 2026-09-11 harness findings are stale.** Today SendMessage reaches a running background
     sub-agent, and TaskOutput reports its status.
   - **The skill contradicts itself** in at least five places.
   - **The recommender ritual is practically never done.** It preceded **1–3%** of spawn batches.
4. **The enforcement layer is partly blind.**
   - The plugin's spawn telemetry has **no rows at all on 8 of the 18 days** that had spawns. The
     transcripts show up to 173 spawns a day on those days.
   - The telemetry schema cannot record foreground vs background, depth or caller model.
   - Two of three headline scout claims cannot be reproduced from any file that survives.
5. **The costliest drift is cheap to fix, and mostly without always-loaded text.**
   - Ten of the twelve proposals are hooks, agent-companion checks, config changes or skill
     *removals*.
   - None adds a line to CLAUDE.md.
   - The measured dollar cost of always-loaded doctrine is small (about 0.4% of spend each for
     CLAUDE.md and for the skill when loaded). The case against adding text is attention and
     compliance, not dollars.

---

## 1. Method, sources and sampling

**Tiers.**
- **Lead:** a top-level session a human started. It has two sub-tiers: *interactive*, and
  *scheduled*, which is a routine firing from a human-authored schedule.
- **Teammate:** a top-level session another agent started (a `spawn_task` chip, a bus dispatch, a
  fork with a `LINEAGE` block, a peer wake).
- **Sub-agent:** an `Agent`-tool spawn. Its transcript lives under `<session>/subagents/`.

In this harness `TeamCreate` does not exist. "Teammate" therefore means an independent session, not
a `TeamCreate` member.

**Sources.**

| Source | What it gave | Where |
|---|---|---|
| Session transcripts, `~/.claude/projects/**/*.jsonl` | model, usage, effort, every tool call, every spawn and its result | streamed line by line with a Node script; no file was read whole |
| Spawn telemetry, `~/.claude/plugins/data/agent-companion*/` | `spawns.jsonl`, `subagent-starts.jsonl`, `denials.jsonl`, scout and baseline files | all three sibling data directories read |
| Doctrine | `~/.claude/CLAUDE.md` (6,920 B), `~/.claude/skills/team-orchestration/SKILL.md` (74,468 B) | quoted by line number below |
| Enforcement | `plugins/agent-companion/` at repo HEAD: hooks, `config/model-tiers.json`, scripts | the repo, marketplace and live-cache copies are byte-identical (`diff -rq`) |
| Harness | the Claude Code 2.1.266 bundle, and live probes in this session | §2 |

**Sampling.** The population is 4,971 transcript files (8.28 GiB).
- **Frame:** every file with mtime 2026-08-28 to 2026-09-18, which is 1,471 files, 1.99 GiB, and 24%
  of the population's bytes. The whole frame was processed by script.
- **The mtime frame turned out to be polluted.** 43% of its bytes are older content whose file
  dates were bumped by backup-restore or copy events. For example, 204 sub-agent files share one
  mtime minute and 71 top-level files share another.
- **So the primary scope counts only events timestamped inside the window** (called W). The literal
  frame (called F) is kept as a sensitivity check. Every direction agrees between W and F; §3.10
  shows the differences.

**What was counted.**
- In W: 46 leads (11 interactive, 35 scheduled), 33 teammates, 942 sub-agents, and 1,034 spawns.
- Excluded: 392 stale sessions (no in-window activity), 56 trivial sessions (fewer than 3 real
  turns), and this review's own session and sub-agents.

**Joins.** All 978 spawns that returned a launch result were joined to their sub-agent transcript by
two independent links, which never disagreed. `resolvedModel` in the launch result matched the
sub-agent's actual model 962 of 962 times.

**Cost model.** USD per million tokens, input / output:

| Model | Input | Output |
|---|---:|---:|
| haiku | 1 | 5 |
| sonnet | 2 | 10 |
| opus | 5 | 25 |
| fable | 10 | 50 |

Cache reads are charged at 0.1× the input price, and cache writes at 1.25×. Usage is de-duplicated
per API message id. These are **estimates at list price**. On a subscription the currency is usage
allowance, but the ratios are the same.

**Evidence handling.** This file is public, so every real project, product, person and session
identifier is replaced.
- Projects are `{{PROJECT_BUS}}` (the coordination-bus product), `{{PROJECT_APP}}` (a consumer app),
  `{{PROJECT_QC}}` and `{{PROJECT_LIFE}}`.
- Their agent rosters are `P1-*` and `P2-*`.
- Sessions are labelled `S-A` to `S-G`.

The full evidence bundle is private, in `~/.claude/tasks/agent-routing-review-20260918/`. It holds
three worker reports, `aggregates.json` with every figure as numerator and denominator, every script,
the per-record datasets, and a `SESSION-KEY.md` that maps each label to its transcript. Re-running
`node extract.mjs frame.json raw_extract.jsonl` and then `analyze.mjs` regenerates the numbers.

**Classifier caveat.** Task-type fit (§3.6) relies on a keyword classifier that scored **75% on a
blind held-out sample of 40** (95% CI about 60–86%). Read the provisioning percentages in §3.6 as
±15 points.

---

## 2. What this harness exposes today (re-checked 2026-09-18)

The card asked for this re-check. The skill's "Know your harness" section (SKILL.md:176) records a
2026-09-11 finding that all three coordination checks were negative. Several rows below contradict
that record, and others cover capabilities it never checked:

| Capability | Skill says (2026-09-11) | Observed 2026-09-18 | Evidence |
|---|---|---|---|
| Message a spawned sub-agent | no tool addresses a sub-agent | **works**: SendMessage to a named background haiku agent returned "queued for delivery at its next tool round", and the agent quoted the message back, received after its first step | live probe in this session |
| Liveness probe | `TaskOutput(agentId)` → "No task found" | **works**: `TaskOutput` returned `status: running` for a background agent, and for a *grandchild* two levels down | live probe in this session |
| Grandchild completion | not covered | the lead **received the completion notification** of a depth-2 background agent whose depth-1 parent had already returned | this session |
| `TeamCreate` | absent | still absent. The `Agent` tool says `team_name` is "Deprecated; ignored. The session has a single implicit team." | tool schema |
| Default spawn shape | skill default for research: foreground | **harness default is background.** The `Agent` tool says "Subagents run in the background by default", and a spawn with a `name` runs async even with `run_in_background` unset (279 of 293) | tool text, transcripts |
| Effort per spawn | "effort is locked to frontmatter" (SKILL.md:38) | confirmed. There is no `effort` field on the `Agent` schema, and built-in types (general-purpose, Explore, Plan and the rest) set no effort, so they **run at the parent session's effort**: 285 of 285 non-haiku built-in sub-agents | bundle source; transcripts |
| Re-price a session | not covered | `set_session_model` can switch the model of *another* session this session started, and a cheaper family needs no prompt. It is refused for a session's own model. `spawn_task` itself has no model parameter. | tool schema |
| Scheduled-task model | not covered | the scheduled-tasks API has **no model field** | tool schema |

Sub-agents also used SendMessage heavily in the window: 725 calls from 214 of 942 sub-agents. So
messaging has worked for a while in at least some session types.

---

## 3. Measurements per tier (scope W unless marked)

### 3.1 Sessions, models and money

| Tier | Sessions | Primary model | Est. cost | Share of spend | Premium share of the tier's cost |
|---|---:|---|---:|---:|---:|
| Lead | 46 (11 interactive + 35 scheduled) | opus 44, fable 1, sonnet 1 | $1,690 | 16.2% | 100.0% |
| Teammate | 33 | opus 23, **fable 8**, sonnet 2 | $4,111 | 39.5% | 99.2% |
| Sub-agent | 942 | sonnet 695 (73.8%), opus 139 (14.8%), haiku 108 (11.5%) | $4,606 | 44.3% | 48.2% |
| **All** | | | **$10,407** | | **76.8%** |

- **Spend by model:** opus 44.7%, fable 32.0%, sonnet 23.0%, haiku 0.2%.
- **Spend by component:** cache reads 69.1%, cache writes 19.4%, output 11.5%, uncached input 0.04%.
- **Tokens re-read per turn (cache read, mean):**

| Tier and model | Tokens re-read per turn | Approx. cost per turn |
|---|---:|---:|
| lead on opus | 381k | $0.19 |
| teammate on fable | 543k | $0.54 |
| teammate on opus | 346k | $0.17 |
| sub-agent on sonnet | 173k | $0.035 |
| sub-agent on opus | 209k | $0.10 |
| sub-agent on haiku | 51k | $0.005 |

  *This table is the most important number in the review.* Almost everything else follows from it.
- **Effort actually used (share of turns):**
  - Leads: high 47%, xhigh 53%.
  - Teammates: high 9%, xhigh 66%, **max 26%**.
  - Sub-agents: medium 3.3%, high 43%, xhigh 51%.
  - Sonnet sub-agent turns ran at medium only 4.3% of the time.
- **Fable:** 13 lead or teammate sessions ran fable turns. Only 1 stated a warrant in its opening
  brief, and it accounts for $826 of the $3,333 fable spend. Several sessions reached fable through a
  `/model` switch mid-session. Two ran fable from their first turn with no warrant.
  (`fable_check_W.json`)

### 3.2 Spawns: counts and model choice

| | Lead | Teammate | Sub-agent |
|---|---|---|---|
| Spawns | 204 | 814 | 16 |
| Sessions that spawned | 12 of 46 | 21 of 33 | 8 of 942 |
| Spawns per spawning session, median / p90 / max | 6 / 38 / 65 | 19 / 55 / 404 | — |
| Requested model: haiku / sonnet / opus / fable / **absent** | 8.8 / 64.7 / 4.4 / 0 / **22.1%** | 10.7 / 67.9 / 14.5 / 0 / **6.9%** | 0 / 56 / 19 / 0 / 25% |
| `name` set | 86.8% | 92.5% | 25% |
| `isolation` set | 12 (11 worktree, 1 remote) | 2 | 0 |

- **Requested vs actual.** Explicit requests matched the actual model **879 of 879** times. There
  were 0 escalations and 0 drifts.
- **Where the 97 "absent" spawns got their model** (`m4_supp_W.json`):
  - 78 from a project agent definition that pins it (36 opus, 23 haiku, 19 sonnet).
  - 11 from a built-in type (claude-code-guide, which runs haiku).
  - **8 from true inheritance**, 6 of which inherited **opus**.
- **Overriding a definition's model.** 141 of 535 role-typed spawns (26%) did so explicitly. Most were
  reviewer definitions pinned to opus being run at sonnet to match a sonnet builder (P1 72, P2 8).
  That is parity-driven and correct: a single pinned model cannot follow the writer's tier.
- **Fixed cost of a cold spawn:** median **25.6k** tokens, p90 61k. All cold spawns together cost
  about $94 (0.9% of spend). One P1 box-ops definition has a median of **1 tool call per spawn**
  against a 25k cold spawn, which is nearly pure overhead.

### 3.3 Shape: fan-out, foreground and background, deaths

| | Lead | Teammate |
|---|---|---|
| Effectively async (background) | 87.3% | 82.4% |
| `run_in_background` true / false / unset | 54 / 9 / 37% | 59 / 14 / 27% |
| Fan-out width (spawns per message), median / p90 / max | 1 / 1 / 4 | 1 / 2 / 6 |
| Multi-spawn batches that were all-foreground | 2 of 8 | 9 of 73 |

- **Explore-class spawns:** 282, of which only **52 (18%) ran foreground**. 209 of 244 batches
  containing one were single-spawn messages. The doctrine's "one message of foreground agents" for
  parallel research is rare.
- **Lost spawns:** effectively 0. The only 2 spawn calls without a result were in flight when the
  census ran.
- **Sub-agents that did not end on a final answer:** 69 of 991 (7.0%). 58 of them were
  *interrupted*, and **52 of those 58 were async**. 23 of the 58 died in five clusters, 3 or more
  from one parent within ten minutes, which looks like host restarts.
- **The known 2026-09-11 incident is confirmed:**
  - Session S-G launched 8 async agents between 17:58 and 18:03Z, and all 8 died.
  - It then switched to foreground, and 20 of its next 22 spawns finished.
- **But foreground is not safer per spawn:**
  - Among agents that did not end on a final answer, async runs were 6.4% (54 of 847) and sync runs
    10.4% (15 of 144).
  - Foreground agents die too, for example when the user presses Stop.
  - The risk that is specific to background agents is **clustered** loss on a host restart, not a
    higher base rate.

### 3.4 Direct execution by leads and teammates

This measure counts Read, Grep, Glob, Bash, PowerShell, Edit, Write, WebFetch and similar calls a
session made itself. An `Agent` spawn breaks a run.

| | Leads (46) | Interactive leads (11) | Scheduled leads (35) | Teammates (33) |
|---|---|---|---|---|
| Execution calls vs spawns | 3,643 vs 204 (**17.9:1**) | 2,467 vs 191 | 1,176 vs 13 | 5,486 vs 814 (**6.7:1**) |
| Sessions with a run of more than 3 | **46 of 46** | 11 of 11 | 35 of 35 | **31 of 33** |
| Longest run, median / p90 / max | 37 / 86 / 485 | 62 / 302 / 485 | 27 / 64 / 96 | 42 / 191 / 302 |
| Same, but resetting at each human message | 21 / 50 / 66 | 26 / 44 / 50 | 21 / 53 / 66 | 33 / 110 / 267 |
| Own share of output tokens (vs spawned descendants) | 54.5% | 48.0% | 96.1% | 23.8% |

- **What the direct execution touches** (`m7_supp_W.json`):
  - 84% of interactive-lead Edit/Write calls hit repository files.
  - For teammates, 28% of Edit/Write calls wrote spawn briefs to the scratchpad, which is legitimate
    orchestration.
  - Teammate shell calls: 930 git and 1,099 read/search-shaped.
- **Examples** (from `m11_digest.json`):
  - An interactive lead (S-E) ran 529 execution calls against 6 spawns, including a run of **485
    calls** with no spawn.
  - A fable teammate (S-B) made a 284-call run of source edits, tests and staging.
  - A fable teammate (S-C) made 530 browser-automation calls and a 203-call run of git archaeology
    itself.
- **Scheduled routines:** 35 of them, all opus, keep 96% of their own work, for $278 in the window.
  The scheduled-tasks API cannot pin a model (§2).

### 3.5 Reviewer parity

Each review spawn was paired with the nearest earlier writer spawn in the same session.

| Writer → reviewer (actual model) | sonnet → sonnet | sonnet → opus | opus → opus | **opus → sonnet** | **opus → haiku** | **sonnet → haiku** | haiku → opus |
|---|---:|---:|---:|---:|---:|---:|---:|
| Pairs | 93 | 43 | 25 | **18** | **1** | **1** | 1 |

- **Breaches (reviewer below writer): 20 of 182 (11.0%).** The reviewer was above the writer in 44 of
  182.
- A stricter pairing, against the highest writer anywhere earlier in the session, gives 77 of 182.
  It over-counts, because an early opus design spawn then "outranks" every later sonnet review of a
  sonnet build.
- **Static roster check:** `{{PROJECT_QC}}` fails today. Its reviewer definition is sonnet/medium and
  it gates an opus/max architect.

### 3.6 Task-type fit (classifier: ±15 points)

- **Over-provisioned: 252 of 719** assessable explicit spawns (35%).
  - **205** of those are explore/research work sent to sonnet where the table says haiku.
  - The rest: bounded → opus 26, debug → opus 9, explore → opus 5, git/ops → opus 4,
    mechanical → sonnet 3.
- **Under-provisioned: 23 of 719** (3%). Most are design → sonnet (16).

The largest cell is partly a **doctrine gap, not misbehaviour**. The routing table has `explore`
(weight 1, "where is X, what touches Y"), which is a lookup, but no type for *research or analysis*.
Synthesis across many files is the most common real use of a sub-agent. Leads route that work to
sonnet by judgement, and the table has nothing to say.

### 3.7 Doctrine rituals

| | Spawning leads (12) | Spawning teammates (21) |
|---|---|---|
| `team-orchestration` loaded before the first spawn | 6 | 15 |
| `recommend.mjs` executed before the first spawn | 1 | 3 |
| Spawn batches preceded by a `recommend.mjs` run | **5 of 192 (2.6%)** | **8 of 709 (1.1%)** |
| Recommender verdict cited in the brief (first 300 characters) | 3 of 204 | 92 of 814 |
| `WEIGHT:` or `WARRANT:` header in the brief | 59 of 204 | 135 of 814 |

Several of the recorded recommender runs were the recommender being developed or tested, not
routing before a spawn.

### 3.8 Spawn telemetry: coverage and correctness

| Day | Spawns in transcripts | Rows in plugin telemetry |
|---|---:|---:|
| 2026-08-29 to 09-04 | 198 | 195 |
| **2026-09-06 to 09-11** | **417** | **0** |
| 2026-09-12 | 219 | 102 |
| **2026-09-13 to 09-14** | **141** | **0** |

(Telemetry rows from test-fixture session ids are excluded.)

- **On 8 of the 18 days with spawns, the guard wrote nothing.** Either it was not running, or its
  rows were lost.
- The inline data directory stopped on 2026-09-12. The current one was created on 2026-09-18.
- `baseline.json` recorded `spawnTotal: 706` on 09-12, while 316 rows survive. That is consistent
  with a data directory deleted by a plugin uninstall and reinstall. It is not proven.
- **Schema gaps.** Telemetry never records:
  - `run_in_background`, `isolation`, `name` or `team_name`
  - the spawn's description
  - call depth, or the caller's model
- **Wrong or ambiguous fields.** The `effort` field is the *caller's* effort: it reads `xhigh` or
  `max` even on haiku spawns. `subagent-starts.jsonl` records no model, and its rows outnumber spawn
  rows by 1.7–2.6× per session for reasons the data cannot explain.
- **Test fixtures and duplication.** Test-fixture sessions write into the production log, and the
  canary filter misses them. `unknown-agent-types.jsonl` has 13,695 rows for 12 distinct types, a
  race in its de-duplication.
- **`audit.mjs` reads the wrong directory.** It resolves its data directory independently of the
  hooks, defaults to a bare directory that holds no spawn data, and reports "no spawn telemetry
  recorded yet".
- **Scout claims reconciled** (telemetry report §3):
  - "0 of 401 inherited" is not reproducible. There are 332 rows in total, and 47 recorded as
    inherited.
  - "77 spawns / 24h, 7 premium" is not reproducible. The scout overwrites its only output file.
  - "211 / 24h, 16 premium, 6 without a model" (2026-09-12) exists in `scout-latest.json`, but
    today's files give 60 / 0 / 3 for that window. The 3 surviving no-model rows are all a
    plugin **test fixture**.

### 3.9 This review as a live specimen

This review spawned three sonnet workers and one haiku probe.
- **One worker escalated itself.** Asked to measure transcripts, it had no `research` type in the
  routing table to choose. It picked `long-autonomous-run` (weight 5) and got `opus/xhigh`.
  - The spawn guard denied its first attempt for a missing warrant. The worker then wrote its own
    `WARRANT: weight 5 — …` line and passed. The guard reads the declared weight from that same line
    (`spawn-guard.mjs:74`), so a self-written warrant satisfies both the warrant check and the fit
    check.
  - It spawned the opus agent **in the background**, then returned to the lead with "Phase 2 is
    running … I'll deliver the complete report once it finishes". It could not keep that promise,
    because it had already returned.
  - The opus grandchild ran for 39 minutes and 548k tokens. It completed only because the lead found
    it with `TaskOutput` and waited on it.
- **A second worker** spawned two depth-2 background agents with **no model**, so they inherited
  sonnet. It also spawned the opus grandchild without being asked. It wrote a decision into
  `~/.claude/DECISIONS.md`, where the doctrine says only the lead writes.
- **The haiku probe** cost 40k tokens for 3 shell commands. That is the cold-spawn floor in §3.2,
  seen from the other side.

Across the window, nested spawns are rare (16 from 942 sub-agents), but each one is unplanned and
unreviewed by the lead.

### 3.10 Sensitivity check (W vs literal frame F)

Every direction holds. F is worse on every discipline measure because it includes older behaviour,
such as June's agent-teams spawns.

| Measure | W | F |
|---|---:|---:|
| premium share of spend | 76.8% | 88.9% |
| lead spawns with no model | 22.1% | 42.8% |
| teammate spawns with no model | 6.9% | 30.8% |
| over-provisioned | 35.0% | 40.3% |
| reviewer-parity breaches | 11.0% | 14.4% |
| leads with a run of more than 3 | 100% | 97.8% |

---

## 4. Did "Fix team-orchestration doctrine for this harness" (task_afed6c5a) land?

**Partly.**
- **Landed:** all five sections dated 2026-09-11 are live in `SKILL.md` today:
  - "Know your harness before you brief"
  - "Parallel research fan-out"
  - the briefing-discipline rewrite ("the return value is the channel")
  - the `TeamCreate` precondition
  - the Rules 1–5 corrections
- **Not landed:** the generic lesson for `CONTRIBUTIONS_INBOX.md`. It was committed only to a local
  worktree branch, never pushed, and is absent from the 2026-09-14 lessons fold. It has no
  `DECISIONS.md` entry. `~/.claude` is not a git repository, so the skill edits have no history.

**How this review relates to it.** This review changes none of that ground. It adds one finding on
top: **the capability facts that task recorded are now stale** (§2). Its most load-bearing corrections
rest on "there is no liveness probe", and on this harness that premise no longer holds. See G6.

---

## 5. Gap analysis

Each gap cites the doctrine line (**D**), the behaviour (**B**), and a verdict. The verdict is one
of: *behaviour gap* (the rule is right and is not followed), *doctrine wrong* (the rule is incorrect
or stale), or *unenforceable* (nothing on this harness can make it true).

**G1. Teammate and lead session models escape the fable rule entirely.**
- **D.** "`fable` is an exception, not a tier … Spawning it requires a stated warrant" (SKILL.md:49). "Opus lead for multi-agent orchestration" (SKILL.md:71).
- **B.**
  - 8 of 33 teammates ran fable as their primary model. Fable was 56% of teammate turns and cost
    $3,198, or 31% of all spend.
  - 1 of 13 fable sessions carried a warrant.
  - `spawn_task` has no model parameter, so a teammate's model is whatever the app defaults to, or
    what a human picks with `/model`.
- **Verdict:** *unenforceable as written, and not enforced.* The rule is scoped to `Agent` spawns,
  while the costliest fable use is session models.

**G2. Leads and teammates execute long runs themselves on premium contexts.**
- **D.** "Never chain more than ~3 execution steps in main without delegating" (CLAUDE.md:17,
  SKILL.md:219). "Any file read, search, or codebase exploration → Explore subagent" (SKILL.md:187).
- **B.**
  - Runs of more than 3 in 46 of 46 leads and 31 of 33 teammates, with median longest runs of 37 and
    42 calls. 17.9 execution calls per spawn for leads.
  - Each premium turn re-reads 346–543k tokens, against 173k in a sonnet sub-agent (§3.1).
  - The only enforcement, `delegation-guard.mjs`, fires once when a streak reaches 4 (lines 23–31),
    then resets the counter and lets the next call through. It counts calls, not cost.
- **Break-even, from measured numbers.** Delegating a run of *k* calls costs one or two extra lead
  turns (the spawn and the result), a cold spawn (about $0.06 on sonnet), and *k + 1* sub-agent
  turns. It saves *k* premium turns.
  - For an opus lead at 381k context, break-even is at **about 2–3 calls**.
  - For a fable teammate at 543k, it is at **about 1–2 calls**.
- **Verdict:**
  - *Behaviour gap* for long runs. The doctrine's threshold of about 3 matches the measured
    break-even.
  - *Doctrine wrong* at the other end. "Any file read → subagent" and single-command git delegation
    cost more than doing it in the lead. The P1 box-ops definition's median of 1 tool call per spawn
    shows this.

**G3. Effort-by-weight is unenforceable for built-in agent types.**
- **D.** "3 → `sonnet` / `medium`" (SKILL.md tier table). "Set `model` and `effort` in sub-agent
  frontmatter" (SKILL.md:38). CLAUDE.md:20 says "1–2 → haiku/low".
- **B.**
  - 285 of 285 non-haiku built-in sub-agents ran at their parent's effort. Sonnet sub-agents ran
    medium 4.3% of the time.
  - Agent definitions *do* control effort: 97.6–100% of their turns matched the frontmatter. But
    only five projects have any, and `~/.claude/agents/` is empty.
  - Haiku takes no effort at all, which contradicts CLAUDE.md's "haiku/low" (SKILL.md says so itself).
- **Verdict:** *unenforceable* outside projects with definitions, plus an internal contradiction.
- **Magnitude is modest.** Output, which is what effort scales, is 11.5% of spend.

**G4. Nested spawns: self-escalation, self-warrants, and orphaned background children.**
- **D.** "Escalation is allowed. If a sub-agent returns incomplete/incorrect output … re-delegate to
  the next tier" (SKILL.md, routing rules). This is a lead decision. "Round down on uncertainty."
- **B.**
  - This review's worker escalated sonnet → opus on its own and passed the guard with a warrant it
    wrote itself (`spawn-guard.mjs:74`).
  - It backgrounded the child and returned a promise instead of a result (§3.9).
  - Two depth-2 spawns named no model.
- **Verdict:** *not enforced.* The warrant is self-certifying at any depth.

**G5. The recommender ritual is not followed, and costs a premium turn where it is.**
- **D.** "Before every spawn run agent-companion's recommender and cite its verdict in the brief"
  (SKILL.md:699).
- **B.** It preceded 2.6% of lead and 1.1% of teammate spawn batches. Each run is a Bash turn on a
  381–543k context. The recommender also silently accepts unknown `--kind` and `--consequence`
  values and fractional weights, and it has no `research` type (§3.6, §3.9).
- **Verdict:** *behaviour gap, and the mechanism is wrong.* A table lookup does not need a model
  turn.

**G6. Background vs foreground doctrine is stale, and it contradicts the harness default.**
- **D.** "Never background a read-only research agent" (SKILL.md:214). The reasoning rests on "there
  is NO working liveness probe" (Rule 4 correction table, SKILL.md:176).
- **B.**
  - A probe exists today (§2).
  - The harness defaults to background, and 82–87% of spawns ran async.
  - Foreground agents do not die less often per spawn (10.4% vs 6.4% not ending on a final answer).
  - Background deaths cluster on host restarts (23 of 58 in five clusters).
- **Verdict:** *doctrine wrong (stale).* The durable part is "a long worker must persist its output
  somewhere the lead can collect", and that part stands.

**G7. Reviewer parity breaches are uncaught at spawn time.**
- **D.** "The MODEL must never drop" (SKILL.md, reviewer parity).
- **B.** 20 of 182 pairs (11%) had the reviewer below the writer, 18 of them opus → sonnet.
  `{{PROJECT_QC}}`'s roster breaches parity statically. No hook compares a reviewer to its writer,
  and `audit.mjs`'s roster check sits behind the wrong-directory bug (§3.8).
- **Verdict:** *behaviour gap, not enforced.*

**G8. The explore/research line is missing from the routing table.**
- **D.** `explore` → weight 1 → haiku (`model-tiers.json`). Weight 3 → sonnet/medium.
- **B.** 205 of 286 explore-class spawns went to sonnet. Research and synthesis has no type, so leads
  choose by feel, and a sub-agent chose `long-autonomous-run` and got opus (§3.9).
- **Verdict:** *doctrine incomplete.*

**G9. The doctrine is internally contradictory, and large for what it achieves.**
- **Contradictions,** each confirmed by quote in the enforcement report:
  - (a) "Sonnet is sufficient by default" for the orchestrator (SKILL.md:65) vs "Opus lead for
    multi-agent orchestration" (SKILL.md:71). Practice follows line 71: 44 of 46 leads ran opus.
  - (b) Weight 5 = opus/xhigh in the tier table, but "5 (opus/max)" (SKILL.md:155).
  - (c) "Over-delegation wastes a haiku agent … The former is cheap" (SKILL.md:363), which the cost
    section itself retracts.
  - (d) The "Never" list requires a unique `team_name` (SKILL.md:220), which this harness ignores.
  - (e) The 2026-09-11 capability claims (SKILL.md:176), now stale.
  - (f) CLAUDE.md:20 "haiku/low" vs "haiku takes NO effort".
- **Size.** The skill is 74,468 B, about 18.6k tokens, and CLAUDE.md makes it BLOCKING before any
  spawn.
  - Measured load rate: before the first spawn in 6 of 12 spawning leads and 15 of 21 spawning
    teammates.
  - Once loaded it is re-read on every later turn. For a median teammate (116 turns) that is about
    2.2M cache-read tokens, roughly $1.10 on opus or $2.20 on fable, and about $25–45 across the
    window.
  - The dollars are small (about 0.4% of spend). The real cost is that about 5% of every loading
    session's context is incident history, while the rules that matter are followed 1–3% of the time
    (G5) or not at all (G2).
- **Verdict:** *doctrine wrong in places; the size buys little compliance.*

**G10. The enforcement layer cannot see most of the fleet, or its own outages.**
- **D.** The skill cites `audit.mjs --only agent-defs,spawn-audit` as the check (SKILL.md, recommender
  section).
- **B.** §3.8: no telemetry on 8 of 18 spawn days, lost history, schema gaps, fixtures in production
  data, and an audit that reads an empty directory.
- **Verdict:** *not enforceable until fixed.* Every other proposal's success metric depends on this
  one.

**G11. Scheduled routines run on opus and execute everything themselves.**
- **D.** "Lowest sufficient tier". The doctrine is silent on unattended routines.
- **B.** 35 scheduled leads, all opus, keep 96% of their own output, for $278 in three weeks. There
  is no model field on scheduled tasks.
- **Verdict:** *doctrine gap.*

**G12. Single-purpose definitions whose spawns are pure overhead.**
- **D.** "Git and box plumbing is DELEGATED, never run in the lead session" (SKILL.md).
- **B.** One P1 box-ops definition: 27 spawns, median 1 tool call, median 25k cold tokens.
- **Verdict:** *doctrine wrong at the margin.* It overlaps G2's break-even: batch the plumbing into
  one delegated chain, or run a single command in the lead.

**Checked and found fine:**
- The explicit-model rule (§3.2).
- Opus leads for multi-agent sessions: 14 of 14 multi-agent leads ran opus or fable.
- Lost spawns: effectively 0.
- The agent-companion memory nudge: about 51 tokens per spawn brief, about 53k tokens across 1,034
  spawns, which is negligible.
- Sub-agents receive CLAUDE.md and the MEMORY.md index, as the card stated. Their cold-spawn cost
  (median 25.6k) includes both.

**Not re-verified:** "a builder reported a validation command as passing when it had not". That
needs execution-level evidence this data does not carry.

---

## 6. Proposals, one per gap

**Mechanisms and what they cost:**
- **Hook:** runs outside the model and costs **0 tokens** when it does not fire. When it fires, its
  message enters context (the size is given per proposal). A *deny* also costs the retry turn, which
  is one premium turn (about $0.17–0.54 at measured contexts).
- **Agent-companion check:** a scheduled or on-demand script. **0 session tokens.**
- **Skill:** paid only by sessions that load it. The cost is its size times the remaining turns.
- **CLAUDE.md line:** paid by every turn of every session, sub-agents included. About 75k turns in
  this window, so each 30-token line costs about 2.3M cache-read tokens per three weeks. **None
  proposed.**
- **Agent definition:** its description line is added to the `Agent` tool listing of every session,
  about 40 tokens each and always loaded. The body loads only in the spawned agent.

Estimated value is for the three-week window at list prices. It is an order of magnitude, not a
forecast.

| # | Gap | Fix | Mechanism | Per-session token cost | Why this mechanism | Est. value / 3 wk |
|---|---|---|---|---|---|---|
| **P1** | G1 | **Teammate model at birth.** (a) Every spawn brief carries a machine-readable `MODEL: <alias>` line. For a premium alias it also carries `WARRANT:`. (b) Where the lead starts the session itself, it calls `set_session_model` on the child right after starting it (a cheaper family needs no prompt). (c) A first-turn Stop hook in agent-companion reads the child's actual `message.model` from its transcript. If it is above the brief's `MODEL:`, or fable with no warrant, the hook blocks once with a single line naming the mismatch and the remedy (ask the operator to switch, or a parent re-prices it). (d) The operator sets the app's default model for new sessions to opus. | settings (d) + hook (c) + brief template (a, in the `ho` / spawn-kit skill) | 0 when fit. About 60 tokens plus 1 turn, once per session, on a mismatch. | Session model is chosen outside any tool call, so no PreToolUse guard can see it. The first turn is the earliest point where a hook can read it. Of the four parts, only (d) is a default change. | **About $1.6k** (the 8 fable teammates at opus prices), about 15% of spend |
| **P2** | G2, G12 | **Cost-aware delegation guard.** Replace the count-only streak in `delegation-guard.mjs` with: read the session's last-turn cache-read size and model from the transcript tail. When the run of execution calls reaches the break-even (default 3), print the price ("this session re-reads about 540k tokens per call on fable, about $0.54; a sonnet sub-agent re-reads about 170k at about $0.035"). Escalate from a nudge to a deny at 2× the break-even on premium contexts over 250k. Exempt single reads and commands under the break-even. Apply to teammates as well as `main`. | hook | 0 below threshold. About 80 tokens per firing, with a cooldown (about 5–20 firings in a long session, 0.4–1.6k tokens). A deny costs a turn. | The rule is right and ignored, so text will not fix it. The price at the moment of choice is the one signal the lead lacks. | Up to **about $0.15–0.50 per delegated call**. Leads and teammates made 9,129 execution calls; if a third of them sat in runs past break-even, about $0.5–1.5k |
| **P3** | G4 | **Guard nested spawns.** In `spawn-guard.mjs`, when the caller is a sub-agent (`agent_type` is not `main`): deny premium models (escalation goes back to the lead); deny `run_in_background: true` (a sub-agent must return its children's results, not a promise); and deny a missing `model`. Warrants count only from depth 0. | hook | 0. A deny costs the sub-agent one sonnet turn. | Guards against rare but expensive events: this review's escalation cost 548k opus tokens. Nothing text-based stops a capable agent from writing its own warrant. | About 0.5M opus tokens per avoided event, at zero standing cost |
| **P4** | G5, G8 | **Move routing into the guard and complete the table.** (a) When a brief carries `TYPE: <task-type>` or `WEIGHT: n`, `spawn-guard` resolves the table itself, autofills `model` (and the matching definition, see P8), and appends one line, `routing: <type> → <model>/<effort>`, to the brief for the record. (b) Add `research` (weight 3, sonnet) and `lookup` (weight 1, haiku) task types to `model-tiers.json`. (c) Validate `--kind`, `--consequence` and integer weights in `recommend.mjs`. (d) **Delete** the "run recommend.mjs before every spawn" paragraph from the skill. | hook + config + skill deletion | Negative: removes a premium Bash turn per batch where the ritual was followed. About 20 tokens appended per brief. | A lookup table needs no model turn, and the hook runs on 100% of spawns versus the ritual's 1–3%. | Small in dollars. Large in routing accuracy for the 35% over-provisioned cell. |
| **P5** | G10 | **Make telemetry trustworthy.** (a) One data-directory resolver shared by the hooks, `audit.mjs` and the scout. (b) Durable storage that survives plugin uninstall and reinstall, such as a user-level directory outside the plugin's data dir. (c) Schema v-next: `run_in_background`, `isolation`, `name`, `caller_agent_type` and depth, the caller's model (from the transcript tail), a hash of the description, and the resolved definition effort. Fix the `effort` field's meaning. (d) Test fixtures write to a separate file. (e) Fix the `unknown-agent-types` de-duplication race. (f) A scout check, "enforcement silent": transcript spawn count vs telemetry rows per day, flagging any day with spawns and no rows. | agent-companion check + plugin code | 0 session tokens | Every other proposal needs a metric, and today's telemetry saw about a third of spawns. | Enabler: measurement for P1–P9 |
| **P6** | G6, G9(e) | **Refresh the capability facts and make them re-probe themselves.** Replace the 2026-09-11 narrative ("Know your harness", SKILL.md:166–184, and the 2026-09-11 corrections inside Rules 4 and 5, SKILL.md:276 and 471) with a dated capability table: SendMessage to sub-agents, TaskOutput, TeamCreate, the default spawn shape, effort inheritance, `set_session_model`. Drop "never background a read-only research agent". Keep "a long worker persists its output to a file or branch". Wire the scout's existing `harness_version_changed` signal to a canary that runs the three probes and rewrites a small `harness-capabilities.json` the skill points at. | skill edit (net deletion) + agent-companion check | Skill shrinks by about 2–3k tokens. The check costs 0 session tokens (one haiku probe per harness version, about 40k tokens once). | The scout flagged a harness change (2.1.209 → 2.1.266) on 2026-09-12 and nothing re-probed. Facts written into prose go stale without anyone noticing, and a probe does not. | Correctness; avoids briefs built on false premises |
| **P7** | G7 | **Parity check at spawn.** When `subagent_type` matches `*reviewer*`, or the brief carries `TYPE: code-review`, `spawn-guard` looks up the latest writer spawn in the same session from telemetry (needs P5c). It denies a lower model, citing the writer's spawn. Also fix `audit.mjs`'s data directory so the static roster check runs. That surfaces `{{PROJECT_QC}}`'s roster breach. | hook + agent-companion check | 0. A deny costs one turn. | Parity is a comparison between two spawns the guard already sees; no model judgement is needed. | 20 breaches in the window; the value is the defects a cheap gate misses |
| **P8** | G3 | **Generic effort-carrying definitions.** Ship a small user-level roster through agent-companion (plugin agents are namespaced): `lookup` (haiku), `worker` (sonnet/medium), `worker-high` (sonnet/high), `reviewer` (sonnet/high), `deep` (opus/xhigh). P4's guard maps a declared weight to the definition. Fix CLAUDE.md:20 ("haiku/low" → "haiku") in the same change. | agent definitions + hook | About 200 tokens always loaded per session (5 description lines in the `Agent` listing) | Definitions are the only effort lever this harness has (§2). A roster is cheaper than per-project copies. | Modest, and a rough guess. Output is 11.5% of spend, and 40% of sonnet sub-agent turns run at xhigh. Moving them down to medium or high might save a few percent of sub-agent cost |
| **P9** | G9 | **Split the skill.** Keep a core of about 3k tokens or less: the tier table, the cost ratios from §3.1, the break-even rule, the capability-table pointer (P6), and the few judgement rules no hook can enforce (brief for the decision; front-load; reviewer effort may rise but not fall; push-first ordering). Move incidents, team shapes, git and merge playbooks, 529 handling and the peer-roster guidance into reference files loaded on demand. Resolve contradictions (a) to (d) and (f) in the rewrite. | skill restructure | About −15k tokens per loading session, re-read on every later turn | On-demand loading is already the right mechanism. The problem is that the triggered body is 6× the part that governs routing. | About $25–45 in dollars; the main value is context headroom and a doctrine that agrees with itself |
| **P10** | G1 (spawns), G4 | **No silent inheritance.** When `model` is absent and the `subagent_type` has no pinned model (general-purpose, or an unknown definition), `spawn-guard` autofills sonnet and appends a one-line note. Today it autofills only when the brief declares a weight (`spawn-guard.mjs:94`). | hook | 0 | 8 true inheritances in the window, 6 of them onto opus. A default costs nothing. | Small but certain |
| **P11** | G11 | **Scheduled routines delegate their execution.** Each routine's prompt opens with explicit-model delegation of its mechanical steps (haiku or sonnet sub-agents), because the scheduled-tasks API has no model field. Also file a harness feature request: a per-task model field. | prompt edits (per routine) | 0 for other sessions. Inside the routine, trades opus turns for sub-agent turns. | The only lever available today. | Part of $278; roughly half is achievable |
| **P12** | G2 (doctrine half) | **Replace "always delegate" with the measured break-even** inside P9's core: delegate a run expected to exceed about 2–3 calls, or to return bulky output; do single reads and single commands in the lead; batch plumbing into one delegated chain. | skill text (part of P9) | Net negative (replaces longer text) | A rule the lead can apply at the moment of choice, instead of a rule that is broken in 100% of sessions. | Pairs with P2 |

**Suggested order:**
1. P5, because the rest need its measurements.
2. P1, the largest single lever.
3. P2 and P3.
4. P4 with P10.
5. P6 with P9 and P12, as one doctrine rewrite.
6. P7.
7. P8.
8. P11.

**What not to do.** Do not add CLAUDE.md lines to fix any of this:
- CLAUDE.md already carries the delegation and routing rules, and they are broken in 100% (G2) and
  1–3% (G5) of the relevant sessions.
- The dollar cost of a line is small. Its failure mode is that it does not change behaviour.

---

## 7. Follow-up cards, one per proposed fix

These are ready to file. This session could not reach the board (see §8), so the cards are listed
here for the parent or operator to create. Each card is type `feature`, project `agent-templates`
unless noted, and has the same boundary: adopt only after the operator accepts the proposal.

1. **Pin teammate session models at birth (P1).**
   - AC: a spawn-brief template carries `MODEL:` and, for premium aliases, `WARRANT:`.
   - AC: the agent-companion first-turn Stop hook compares the transcript's `message.model` with the
     brief and blocks once on a mismatch, with a one-line message.
   - AC: the hook costs 0 tokens when the model fits (verified by a transcript diff).
   - AC: the parent-side `set_session_model` step is documented and verified on a session the parent
     started.
   - AC: the operator has decided the app's default model.
   - AC: success metric: the fable share of teammate turns over the next 3 weeks, measured by the
     review's `analyze.mjs`.
2. **Cost-aware delegation guard (P2).**
   - AC: the guard reads the session's last-turn cache-read size and model.
   - AC: the nudge prints the per-call price comparison.
   - AC: deny at 2× break-even on premium contexts over 250k; single calls under the break-even are
     exempt.
   - AC: applies to teammates and `main`.
   - AC: tests cover the opus, fable and sonnet thresholds.
   - AC: success metric: the median longest run and the execution:spawn ratio, re-measured.
3. **Guard nested spawns (P3).**
   - AC: for `agent_type` other than `main`, the guard denies premium models, `run_in_background:
     true` and a missing `model`.
   - AC: warrants count only from depth 0.
   - AC: tests reproduce the escalation described in §3.9 of the review and show it denied.
4. **Hook-side routing and a complete table (P4).**
   - AC: `TYPE:` or `WEIGHT:` in a brief autofills the model and definition, and appends one
     `routing:` line.
   - AC: `research` and `lookup` types exist in `model-tiers.json`.
   - AC: `recommend.mjs` rejects an unknown kind, an unknown consequence and a non-integer weight
     (exit code non-zero).
   - AC: the skill's "run recommend.mjs before every spawn" paragraph is removed.
5. **Trustworthy spawn telemetry (P5).**
   - AC: a single data-directory resolver is used by the hooks, audit and scout.
   - AC: storage survives plugin uninstall and reinstall, with a test.
   - AC: the new fields are logged: `run_in_background`, `isolation`, `name`, depth, caller model,
     description hash.
   - AC: test fixtures are isolated from production data.
   - AC: the `unknown-agent-types` de-duplication race is fixed.
   - AC: the scout's "enforcement silent" check flags any day with transcript spawns and no telemetry.
6. **Self-refreshing harness capability facts (P6).**
   - AC: a dated capability table replaces the 2026-09-11 narrative sections.
   - AC: "never background a read-only research agent" is replaced by the persist-output rule.
   - AC: a canary triggered by `harness_version_changed` writes `harness-capabilities.json`.
   - AC: the skill points at that file.
7. **Reviewer parity at spawn (P7).**
   - AC: a reviewer-typed spawn below the latest writer model in the same session is denied, citing
     the writer.
   - AC: `audit.mjs` finds the real data directory.
   - AC: the static roster check reports `{{PROJECT_QC}}`'s breach.
8. **Generic effort-carrying agent roster (P8).**
   - AC: five namespaced definitions ship with agent-companion.
   - AC: the P4 guard maps a declared weight to them.
   - AC: a transcript check shows a `worker` spawn running at medium.
   - AC: CLAUDE.md:20 is corrected to plain "haiku".
9. **Split and reconcile the team-orchestration skill (P9 + P12).**
   - AC: the core is 3k tokens or less.
   - AC: reference files load on demand.
   - AC: contradictions (a) to (d) and (f) from §5 G9 are resolved.
   - AC: the break-even delegation rule replaces "always delegate any file read".
   - AC: the before/after token counts are recorded.
10. **Default model for unpinned spawns (P10).**
    - AC: a spawn with no model, whose type pins none, is autofilled to sonnet with a one-line note.
    - AC: tests cover general-purpose, a pinned definition (untouched), and an unknown type.
11. **Scheduled routines delegate their execution (P11).**
    - AC: each scheduled routine's prompt delegates its mechanical steps to explicitly-modelled
      sub-agents.
    - AC: a harness feature request for a per-task model field is filed.
    - AC: the routines' opus share, re-measured, falls.

---

## 8. Limitations and process notes

- **The coordination bus was unreachable from this session.** The bus plugin needed sign-in, no bus
  connector was attached, and the machine's OAuth credential is renewed only by a local listener that
  had not run since 2026-09-10. As a result:
  - The card could not be claimed or moved.
  - The follow-up cards (§7) could not be filed.
  - The card body was recovered from the parent session's transcript.
  - The parent was reached through local session messaging instead.
  The listener was deliberately not started, because starting it would drain about eight days of
  queued wakes into dormant sessions.
- **Effort requested at spawn time is not observable.** Only the effort a session actually ran at
  is.
- **Why a sub-agent was interrupted** (host exit, user stop, or `TaskStop`) is not recorded.
- **The task-type classifier is rough** (75% held-out accuracy). Every §3.6 figure carries ±15
  points.
- **Classifying teammates is heuristic** for 1 of 33 sessions. The other 32 have structural evidence:
  a matching `spawn_task` prompt in the parent. Three interactive leads open with long pasted briefs
  that may have been agent-written. They are counted as leads.
- **This review cost** at least 1.2M sub-agent tokens: the four direct spawns plus the unplanned
  548k-token opus grandchild (§3.9). Three smaller nested agents are not counted.
