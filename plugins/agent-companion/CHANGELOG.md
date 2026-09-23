# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

## 0.25.0 — 2026-09-23

Moves the model x effort benchmark (previously `bench/effort-grid` on a
separate branch, never in the plugin) into `plugins/agent-companion/` so the
routing trial's evidence can be regenerated in place instead of living on a
branch nobody re-runs (minor bump — new files/command/skill, no existing
behavior changed).

### Added

- **`bench/`**: the benchmark runner, scorers, rescore tool, and the
  synthetic task set (6 easy + 4 hard variants + 7 real-history tasks mined
  from this repo's own fix commits), ported from `bench/effort-grid` with
  three real fixes made along the way, not just a copy:
  - **Sandbox isolation.** Every run now gets a throwaway HOME/USERPROFILE
    (`bench/runner.mjs`'s `makeFakeHome()`), not just a throwaway working
    directory — the benchmarked process can never write a session
    transcript, or read anything `--setting-sources ""` doesn't already
    skip, under the operator's real `~/.claude`.
  - **`windowsHide: true` on every spawn** (`claude`, `git`, `node --test`) —
    the original harness's own skill draft had flagged this as something to
    verify before a large batch, not something already done.
  - **`runNodeTest()` no longer leaks `NODE_TEST_*` env vars into the
    nested `node --test` it spawns** (`bench/tasks/common.mjs`) — found
    while writing `tests/bench-scorers.test.mjs`: several `real-*` tasks
    silently scored every answer as `pass:true` with empty test output
    when `runNodeTest()`'s own caller was itself running under `node
    --test`, because the child process inherited `NODE_TEST_CONTEXT=
    child-v8` and treated itself as a test-runner worker instead of doing a
    normal standalone run. Invisible in a real benchmark run (never itself
    under `node --test`), but would have made every scorer test in this
    release lie.
  - `CLAUDE_BIN` resolution is now **lazy** (only on the first actual model
    call), so `bench/runner.mjs` stays importable — for `CELLS`/`TASKS`/
    `--dry-run`/tests — with no `claude` binary on PATH at all.
- **`scripts/benchmark.mjs`**: the operator-facing entry point. Task-family
  expansion (`--tasks easy|hard|real|all`, or literal ids), a global
  `--max-budget-usd` ceiling (tighter of it and each task's own), `--dry-run`
  (prints the full plan — cell x task x rep counts and exact args — with
  ZERO model calls), and `--batch-by cell`/`--resume` so a driving agent can
  check plan usage between batches instead of one process running an
  unattended multi-hour grid.
- **`bench/task-packs/`**: a FORMAT plus a builder
  (`build-pack.mjs`/`verify-pack.mjs`) for adding more real-history tasks
  WITHOUT ever committing extracted source. A pack extracts a fix commit's
  parent state at RUN TIME (`git show <ref>:<path>`, never `git clone`),
  verifies fail-at-parent/pass-at-fix before it's usable, and stores only a
  hand-written symptom-only report, a hidden test, and two BASE64-ENCODED
  git refs (a plaintext SHA is exactly the shape this repo's own
  `scripts/leak-check.mjs` bans). One tiny example pack included
  (`examples/leak-check-gitignore-fix`, built from this repo's own history),
  verified and committed with no extracted source.
- **`config/model-tiers.json`: `planUsageMultipliers`** — Opus 5.5 = 1.5x
  Sonnet 5, source "in-app tooltip, 2026-09-23, undocumented, may be
  introductory" (per the operator's own measurement). `bench/runner.mjs`'s
  `rebuildSummary()` now reports a `plan_usage_index` per cell/task
  alongside the existing token-cost `relative_cost_index`, and marks
  `claim_honest_rate` `claim_honest_experimental: true` — it is a word-bag
  heuristic, not a verified signal (see `docs/BENCHMARK.md`).
- **`docs/BENCHMARK.md`**: consolidated lessons from the original harness's
  `PROCESS-NOTES.md` (kept in full at `bench/PROCESS-NOTES.md`) — ceiling
  effects, the re-score-vs-re-run fairness rule, known CLI flag gaps, the
  Windows spawn fix, sandbox isolation, and `claim_honest`'s experimental
  status.
- **`skills/model-benchmark/SKILL.md`**: rewritten to point at the in-plugin
  command and docs instead of a separate branch; procedure-first, under 150
  lines. Registered in the README skill table and `/ac benchmark`
  (`shims/ac/SKILL.md`).
- **`scripts/detect.mjs`**: the daily scout now SUGGESTS (never runs) the
  model-benchmark skill — a new `model_benchmark_suggested` signal fires
  alongside a genuinely new model alias in the routing table's lineup (new
  `new_model_in_lineup` check), an alias-resolution-floor or harness-version
  drift signal, or a routing trial past its `reviewBy`.
- Tests (all new, no real model call in any of them): `--dry-run` plan
  correctness and results-path-outside-the-repo
  (`tests/bench-dry-run.test.mjs`), scorer golden/adversarial coverage for
  every task (`tests/bench-scorers.test.mjs`), sandbox isolation and the
  task-pack `.git`-absence guard (`tests/bench-sandbox-isolation.test.mjs`),
  the task-pack leak guard and CLI wiring
  (`tests/bench-task-pack.test.mjs`), the scout's benchmark-suggestion
  signals (`tests/model-benchmark-suggestion.test.mjs`), and a static
  `windowsHide: true` check over every spawn in `bench/`
  (`tests/no-visible-windows.test.mjs`). 302/0 (was 227/0 after 0.24.3).

## 0.24.3 — 2026-09-23

Enforcement gap fix: the 0.24.2 routing trial (`taskTypes.*.override`) was
only ever consulted by `scripts/recommend.mjs`. `scripts/evaluate.mjs` and
`hooks/spawn-guard.mjs`'s fit check both computed their own "expected"
(model, effort) straight from the plain grid, so a spawn that correctly
FOLLOWED a trial — e.g. `debug-root-cause` on `opus/low` — was judged
over/under-provisioned against a grid answer the trial had already
superseded (patch bump — closes an enforcement gap, no config schema
change).

### Changed

- **New shared resolver: `resolveExpected()` in `hooks/lib/context.mjs`.**
  The one place that turns (task type | weight/kind/consequence) into an
  effective (model, effort), override included. `scripts/recommend.mjs`,
  `scripts/evaluate.mjs`, and `hooks/spawn-guard.mjs`'s fit check now all go
  through it instead of three independent computations.
- **`hooks/spawn-guard.mjs` now understands `TYPE: <task-type>` in a spawn
  brief**, alongside the existing `WEIGHT:`/`KIND:`/`CONSEQUENCE:` lines — a
  brief that names only a type gets that type's own weight/kind/consequence
  preset (and its trial override, if any) filled in, the same way
  `recommend.mjs --type` already worked. An explicit `WEIGHT:`/`KIND:`/
  `CONSEQUENCE:` alongside `TYPE:` is a deliberate deviation from the named
  preset and bypasses the override, per `taskTypesNote` in
  `config/model-tiers.json`.
- **`telemetry/spawns.jsonl` schema (additive): `declared_type`,
  `fit_trial`.** `declared_type` is the brief's `TYPE:` line, if any;
  `fit_trial` is true when the fit verdict was judged against a trial
  override rather than the plain grid.
- Tests: `tests/trial-fit-resolver.test.mjs` — every overridden task type is
  judged `fit` through both `evaluate.mjs` and `spawn-guard.mjs` when the
  spawn follows the trial, `debug-root-cause`'s plain-grid answer
  (`sonnet/xhigh`) is now correctly judged `under` against the trial's
  `opus/low`, and every unmeasured type resolves identically to a raw
  `--weight`/`--kind`/`--consequence` call through both scripts.

## 0.24.2 — 2026-09-23

Operator-approved one-week routing trial (2026-09-23 -> review by
2026-09-30): applies benchmark evidence per task TYPE, not per weight (patch
bump — advisory data change to named task types only; the weight->model
grid and `--weight`-only callers are unchanged).

### Changed

- **`config/model-tiers.json`: `taskTypes.*.override` on 6 measured types.**
  Benchmark summary: Opus 5.5 low/medium/xhigh all scored 7/7 on real bug
  fixes, but medium used ~2x low's tokens (~1.56x plan usage) and xhigh
  ~3.1x, for no quality gain over low. Sonnet 5 passed every synthetic task
  at every effort. Haiku 4.5 cost ~2x Sonnet per task and was the only model
  to fail (procedures and one real fix). Where medium cost more than low
  with no quality gain, don't use medium.
  - `explore`, `subagent-worker` → `sonnet/low` (was `haiku`). Haiku remains
    available only as an explicit choice.
  - `verify` → `sonnet/low` (was `haiku`, weight unchanged at 1). Haiku
    remains available only as an explicit choice.
  - `mechanical-edit` → `sonnet/low` (was `haiku`). Haiku remains available
    only as an explicit choice.
  - `operate` → `sonnet/low` (was `sonnet/medium`, weight unchanged at 3).
  - `bounded-feature` → `opus/low` (was `sonnet/medium`).
  - `debug-root-cause` → `opus/low` (was `sonnet/xhigh`). This EXPLICITLY
    overrides the `diagnostic` kind's normal +1 effort delta (which would
    otherwise land on medium) — recorded as `overridesKindDelta: true`, not
    a silent kind change, per the operator's explicit no-medium directive.
  - Unmeasured types (`integration`, `large-refactor`, `novel-design`,
    `critical-change`, `long-autonomous-run`, `code-review`) carry no
    override and keep their pre-trial grid routing unchanged — the
    `critical` consequence floor (opus/xhigh) still applies regardless.
  - Each override records `reason`, `evidence` (benchmark source + date),
    `trialSince: 2026-09-23` and `reviewBy: 2026-09-30`.
- **`scripts/recommend.mjs`: applies a type's `override` when the type is
  resolved as-is** (no explicit `--weight`/`--kind`/`--consequence`
  overriding the preset — those deliberately deviate from the type and fall
  back to the plain grid). Output gains a `trial` block (trialSince,
  reviewBy, evidence, overridesKindDelta, the plain grid's `gridResolution`
  for comparison) and a `ROUTING TRIAL` rationale prefix; the human-readable
  output prints the trial window and grid comparison. `--type` is now
  documented as the preferred input over raw `--weight`/`--kind`, because
  only a named type carries the measured evidence.
- **`scripts/routing-table.mjs` / `docs/ROUTING.md`**: the task-types table
  marks an overridden type's resolution `(trial override)`; a new "Routing
  trial" subsection lists each override against what the plain grid would
  say, with evidence, `trialSince` and `reviewBy`.
- **`scripts/detect.mjs`**: new `routing_trial_review_due` signal — once a
  type's `override.reviewBy` has passed (inclusive), the scout raises
  "`<type>` routing trial due for review: compare spawn telemetry outcomes
  and escalation rates since `<trialSince>`" every run, same daily-until-
  resolved treatment as `model_retirement_approaching`. Reads a new
  `AGENT_COMPANION_FAKE_NOW` env var (falls back to the real clock) so this
  and the existing retirement-window check are date-injectable in tests
  instead of waiting on the calendar.

### Unchanged

- The weight→model/effort grid (`routing`, `taskKinds`, `consequence`) and
  the effort ladder are untouched — a caller passing only `--weight` (or an
  explicit `--weight`/`--kind`/`--consequence` alongside `--type`) gets
  exactly the pre-trial routing.

## 0.24.1 — 2026-09-23

Folds a measured 30-day cache-TTL finding into the routing model (patch
bump — advisory-only detection surface, no breaking change).

### Added

- **`config/model-tiers.json`: `cacheTtl` block.** Per-definition
  prompt-cache-TTL recommendation — default `5m`; `1h` recommended only for
  opus-tier, long-lived roles (architect/reviewer/lead), with the generic
  `ac-*` ladder workers explicitly excluded (one-shot, so `1h`'s 2x write
  multiplier has nothing to earn back). Records the evidence (30-day
  measurement, 1,407 subagent transcripts, `~/.claude/reports/2026-09-23-subagent-cache-ttl.md`)
  and a re-measure date of 2026-10-07. Frontmatter shape/precedence/pricing
  verified live 2026-09-23 against code.claude.com/docs/en/sub-agents,
  code.claude.com/docs/en/prompt-caching, and
  platform.claude.com/docs/en/build-with-claude/prompt-caching — the
  `experimental.cacheTtl` field (nested, `5m`/`1h` only, requires Claude
  Code v2.1.248+) matches what the earlier finding described.
- **`scripts/checks.mjs` (`agent-defs`): cache-TTL advisory.** An opus-tier
  definition whose name or description marks it long-lived
  (architect/reviewer/lead) with no `cacheTtl` set gets a suggestion to add
  `experimental: { cacheTtl: "1h" }`. A haiku or `ac-*` ladder definition
  already set to `1h` gets a note that it likely costs more, not less.
  Both are advisory findings (`warn`, never `fail`) — new
  `tests/cache-ttl-advisory.test.mjs`.
- **`tests/model-mismatch.test.mjs`: replaced the toothless
  "near-simultaneous spawns" test.** Its own comment admitted a naive
  per-row-in-order matcher passed it too, so it never exercised the swap
  bug the shipped delta-sorted matcher exists to prevent. The new fixture
  is built so a naive matcher provably mis-pairs (verified by hand: it
  produces 2 false `alias_mismatch` findings), while the shipped matcher
  produces zero.

### Fixed

- **`docs/proposed/global-doctrine-reweight.patch`: line-ending bug.** The
  header wrongly claimed both target files (CLAUDE.md and
  `skills/team-orchestration/SKILL.md`) use CRLF; CLAUDE.md is pure LF.
  Corrected the header and the apply instructions: the patch is stored as
  plain LF throughout (this repo's own `.gitattributes` forces
  `*.patch text eol=lf`, which silently strips any literal `\r` a tracked
  `.patch` file's content might otherwise carry — verified by staging a
  byte-preserved draft and reading the blob back), and applying it now
  documents the two invocations (with per-file `core.autocrlf` handling)
  verified byte-exact against both real targets. Also amends the SKILL.md
  "resume by name" guidance (resume only within 5 minutes of a worker
  stopping, or when its definition runs on a 1h cache) and corrects the
  "caching is already solved" line (the hit ratio is high; the misses are
  the 5–60 minute rewrites).
- **`docs/proposed/global-doctrine-reweight.patch`: removed from this
  public repo.** The file quoted lines from the operator's private
  `~/.claude/CLAUDE.md` and `team-orchestration` SKILL.md, including the
  operator's name -- content that does not belong in a public repo. Copied
  byte-identical to the operator's own `~/.claude/proposed/` directory and
  `git rm`'d here; the doctrine patch is kept outside this repo from now
  on. References to its in-repo path elsewhere in this plugin's docs and
  config were updated to point at "the operator's global-doctrine patch,
  kept outside this repo" instead of the removed path. (The file is still
  recoverable from this branch's git history if needed.)

## 0.24.0 — 2026-09-23

Implements the operator-approved SPAWNING RULE (three checks; minor bump —
new detection surface, no breaking change to any existing check's shape).

### Added

- **`hooks/spawn-guard.mjs`: missing-model warning.** A spawn naming no
  model anywhere (neither the spawn parameter nor its definition) is now
  flagged even when the brief declares no `WEIGHT:` — previously silent,
  since `fit_autofill` only fills a model in off a declared weight. The
  existing "no effort stated" warning's wording is unified around, and
  cites, the same rule.
- **`hooks/spawn-guard.mjs`: build-version-floor warning.** An opus/fable
  spawn from a session whose own Claude Code build is below
  `config/model-tiers.json`'s `aliasResolution.minClaudeCodeVersion` is
  flagged, reading the build from the CALLING session's own transcript
  (`sessionBuildVersion()`, new in `hooks/lib/context.mjs`) rather than
  shelling out to `claude --version` — a session's build can differ from
  what's on PATH (the desktop app bundles its own), and a session keeps
  the build it started with. Falls back to silence when unreadable, never
  a guess.
- **`scripts/lib/model-mismatch.mjs` + the `model-resolution-mismatch`
  audit check.** Verifies the model a spawn actually ran on (its subagent
  transcript's own resolved model) against what its definition's alias
  should resolve to. Correlates `spawns.jsonl` telemetry to subagent
  transcripts by nearest timestamp within a session (no field links the
  two directly), matched by closest-pair-first rather than
  per-row-in-order — the latter produced a measured false positive on real
  data under near-simultaneous spawns. Bounded to a fixed 48h window
  regardless of `--days` (an unbounded transcript walk over every project
  measured over two minutes).
- `parseSemver`/`semverBelow` moved from `scripts/detect.mjs` into
  `hooks/lib/context.mjs`, now shared by the scout's harness-version
  signal, the new spawn-guard warning, and the new audit check, so "below
  the floor" cannot drift into separate definitions.
- `docs/proposed/global-doctrine-reweight.patch`: extended with a new
  "The SPAWNING RULE" subsection in the `team-orchestration` SKILL.md hunk
  and a second pointer sentence in the CLAUDE.md hunk (still a pointer,
  not a restatement — CLAUDE.md stays slim). Verified applying cleanly
  against fresh copies of both real target files.
- README: new "Spawning rule" section; Features table row.
- 17 new tests (`tests/spawning-rule.test.mjs`,
  `tests/model-mismatch.test.mjs`); full suite 173/0 (was 156/0).

## 0.23.0 — 2026-09-23

Re-weighted `config/model-tiers.json` against the current Anthropic lineup
(live-fetched 2026-09-23; sources cited inline in the config).

### Changed

- **Re-based the routing table** on the current lineup: `opus` -> Opus 5.5
  ($4/$20, cache hit $0.20, medium default effort), `sonnet` -> Sonnet 5
  ($2/$10), `haiku` -> Haiku 4.5 ($1/$5, no effort parameter, retires no
  sooner than 2026-10-15), `fable` -> Fable 5.1 ($10/$50, cache hit $0.25).
  Every tier now carries a `resolvesTo` block (model id, display name,
  pricing incl. cache hit, context, effort support/default, thinking mode)
  plus a top-level `aliasResolution` naming the source, fetch date, and the
  minimum Claude Code version (2.1.280) the mapping holds for.
- **Added `referenceModels`**: non-routable entries for OLDER pinned
  full/dated ids (Opus 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6), so an
  agent definition pinned to one of these has its effort validated against
  what THAT version actually supports (Opus 4.6 / Sonnet 4.6 have no
  `xhigh`) instead of the current alias tier's wider list.
- **Added an ordered effort ladder** (`config.ladder`): the same routing
  grid's (model, effort) pairs as a cheapest-to-dearest sequence — haiku,
  then sonnet low..xhigh, then opus low..max — each mapped to a new generic
  worker agent definition under `agents/` (`ac-haiku` .. `ac-opus-max`),
  because the Agent tool has no per-spawn effort parameter. `recommend.mjs`
  now prints the exact namespaced spawnable name for its recommendation.
  Weight -> rung defaults are unchanged (1-2 haiku, 3 sonnet/medium, 4
  sonnet/high, 5 opus/xhigh) pending a separate research decision.
- **Added `verify` and `operate` task types**, encoding "haiku validates,
  it does not OPERATE": read/confirm/screenshot work with nothing changing
  routes to weight 1 (haiku); an ordered procedure or a live-system change
  floors at weight 3 (sonnet+) even when every individual step looks
  trivial.
- Fable's warrant now cites Anthropic's own escalation criterion ("Opus
  5.5 at higher effort still falls short") and notes Fable is now 2.5x
  Opus on price (was 2x, when Opus priced at $5/$25).
- The calibration scout (`scripts/detect.mjs`) now warns on every run once
  a tier is within 30 days of `retiresAfter` (previously only on fixed
  milestones, which stayed silent for haiku's 2026-10-15 date until this
  fix).
- `spawns.jsonl` gains `effective_effort`: the agent definition's own
  effort when stated, else `"inherited(<parent session's effort, or
  'unknown'>)"` — a subagent with no `effort` frontmatter inherits the
  orchestrating session's effort (per Claude Code's sub-agents docs), not
  any model default. `spawn-audit` gains a rung-drift finding for spawns
  that matched the recommended model but ran at a lower effort than the
  table recommended.
- `spawn-guard.mjs` and the `agent-defs` audit check now warn when a
  definition or spawn has a model but states no effort anywhere, on every
  effort-taking model (previously implied only for opus, and initially
  mis-described as falling back to a model default rather than to session
  inheritance — corrected same day).

### Documentation

- `docs/ROUTING.md` regenerated from the config (now includes the effort
  ladder and reference-models sections).
- `docs/TELEMETRY.md`: documents `effective_effort`, and adds a "Spawn
  nesting depth" section explaining why `depth` is NOT logged (the
  PreToolUse payload carries at most a 1-bit `caller_is_subagent` signal,
  not a true recursion depth) and what the harness would need to add.
- `docs/proposed/global-doctrine-reweight.patch`: unpublished unified diffs
  against `~/.claude/skills/team-orchestration/SKILL.md` and
  `~/.claude/CLAUDE.md`, for the operator to review and apply by hand.
