# Changelog

All notable changes to the `agent-companion` plugin. Dates are UTC.

## 0.28.0 — 2026-09-24

Folds proven evaluation practice into the model x effort benchmark. It
compares against skill-creator's eval mode, `claude plugin eval`,
Anthropic's develop-tests guidance, and SWE-bench practice.

### Added

- **Confidence intervals and pass@k** (`bench/stats.mjs`,
  `rebuildSummary()`). Each cell x task row and a new cell x task-family
  rollup (`summary-by-family.json`, plus a table in `summary.md`) carry
  **pass@1** (the mean single-trial rate, formerly labelled `pass_rate`,
  which `summary.json` keeps as an alias), a **95% Wilson interval**, and
  **pass@k** with k = reps (the unbiased estimator). Family groups under 5
  runs are flagged **"n too small to separate"**.
- **Reproducibility metadata on every `results.jsonl` row**, including the
  row written when `runOne()` throws: `claude_cli_version`, requested and
  resolved model, requested effort, `task_family`, and sha256 hashes of the
  prompt, the starting fixture tree, the task pack (manifest, brief,
  held-out test, rubric), the rubric, and all of them combined
  (`task_content_sha256`).
- **Optional rubric judge** (`bench/judge.mjs`, `--judge-model`) for design
  quality a hidden test cannot see. The rubric lives in the task (a pack's
  `rubric.md`). The judge must be different from, and at least as strong
  as, the model under test; it is checked per cell before the batch and
  against the resolved model after each run. Three independent no-tool
  `claude -p` calls, pass on 2 of 3, reasoning before the verdict. Blind:
  no producer channel exists, and self-identification is scrubbed. Effort
  and per-vote budget are capped, and temperature is never sent (current
  models reject it). Results go to separate `judge_*` columns and their own
  summary table, never merged into pass/fail.
- **Judge calibration gate** (`--calibrate-judge`). A judge is trusted on a
  task only after it passes the pack's real fix commit and fails both the
  unchanged parent and every planted broken variant
  (`manifest.judgeCalibration.plantedBad`). The trust record is keyed on
  task content, rubric, judge model, effort and prompt template.
  `scripts/benchmark.mjs` and `runOne()` refuse an uncalibrated or
  ineligible judge before any model call (exit 2, or `JUDGE_REFUSED`, which
  aborts without writing a row). The example pack ships a rubric and two
  planted variants.
- **Routing canaries as a `claude plugin eval` suite** (`evals/`, five
  cases): debug to opus/low, architecture to opus/high, never fable for a
  trivial read, a WARRANT for a fable request, and no routing skill on an
  unrelated question (`arm: both`). Free graders only. Documented with an
  opt-in CI invocation; the calibration scout suggests it after a
  routing-relevant signal and never runs it. `tests/evals-suite.test.mjs`
  checks the suite statically, including that each canary still matches
  `config/model-tiers.json`.

### Fixed

- **The recommend skill had no routing data in a session without a shell.**
  The first eval run found that in a sandbox with no shell and no reads
  outside the working directory, neither `recommend.mjs` nor
  `docs/ROUTING.md` was reachable, and the architecture canary answered
  opus/xhigh. The skill now carries a generated task-type table
  (`routing-table.mjs --task-type-block` / `--sync-skill`). The
  `routing-doc` audit check flags it when stale and re-syncs it on `--fix`.

### Docs

- `docs/BENCHMARK.md`: statistics, reproducibility fields, the rubric judge
  and calibration, the routing eval suite, and the operating rules for
  benchmark agents. Those rules: run cells in the foreground with no
  background jobs or monitors; never `git stash`; budget caps scale with
  model price; use at least 3 reps before comparing adjacent efforts (Opus
  5.5 high 5/7 vs low 7/7 was variance). The same rules are folded into the
  `model-benchmark` skill.
- `bench/task-packs/FORMAT.md`: private, extract-at-runtime packs are a
  deliberate contamination control. Re-verify packs when a new model
  generation ships. Documents `rubric.md` and `judgeCalibration`.

## 0.27.2 — 2026-09-23

Fixes a live spawn-guard bug surfaced by routing trial v2 (0.27.1): most task
types now route to opus, and the premium-warrant machinery had not caught up.

### Fixed

- **`hooks/spawn-guard.mjs`: the premium-tier set is now derived from the
  spawn's OWN resolved routing, not hard-coded to the tier table's
  classification alone.** Under routing trial v2 (`config/model-tiers.json`
  v7), a spawn declaring `TYPE: integration` (or any other type the trial
  routes to opus) still demanded a `WARRANT: weight N — ...` line and was
  BLOCKED without one — even though the routing table itself prescribed
  opus for that exact spawn. Fix: a model is premium FOR THIS SPAWN unless
  the same resolved routing that answers "what should this run on" (a
  declared `TYPE` with its trial override, or the plain grid for an
  explicit `WEIGHT`) also names it. Fable is excluded from this exception on
  purpose — nothing routes to fable, so no route can ever justify it; it
  stays a warranted exception on every spawn regardless of `TYPE`/`WEIGHT`.
- **A `WARRANT:` line's own stated weight no longer overrides a declared
  `TYPE`'s preset or its routing-trial override.** `WARRANT: weight 4 —
  <reason>` and `WEIGHT: 4` were parsed by the same regex, so a warrant
  justifying an opus spawn under `TYPE: novel-design` (type weight 5, trial
  override `opus/high`) had its own "4" silently treated as an EXPLICIT
  weight declaration — bypassing the type's own preset and override,
  falling back to the plain grid's weight-4 answer, and denying the exact
  spawn the trial prescribes for a manufactured "over-provisioned"
  mismatch. Fix: only a genuine `WEIGHT:` line counts as an explicit
  deviation from a named `TYPE`'s preset now; a warrant's own weight is
  still captured for `declaredWeight`/telemetry (unchanged, per
  `docs/TELEMETRY.md`), but never bypasses a declared `TYPE`. Precedence:
  explicit `TYPE` (with its trial override) > a real `WEIGHT:` line > a
  warrant's own stated weight.
- **A premium spawn with neither `TYPE` nor `WEIGHT` declared now WARNS
  instead of BLOCKING when its `WARRANT:` line is missing.** The guard has
  no routing information to confirm the tier either way in that shape, so a
  missing warrant is now a `systemMessage`, not a denial — the base
  tier-table classification (the same default the guard already used for
  every undeclared spawn) still applies, but a false block here would stop
  legitimate work the guard cannot actually judge. Fable, and any spawn
  where routing IS known and disagrees, still block on a missing warrant
  exactly as before.
- New `tests/premium-warrant-routing.test.mjs` (6 tests) reproduces both
  bugs directly against a live routing-trial config: an opus + `TYPE:
  integration` spawn with no warrant is now allowed; an opus + `TYPE:
  novel-design` spawn with a weight-bearing warrant is now allowed and
  judged `fit` against the type's own override, not the plain grid; a
  fable spawn (with or without a `TYPE`) with no warrant is still blocked;
  an opus spawn with neither `TYPE` nor `WEIGHT` and no warrant is now
  warned rather than blocked; and a genuine `WEIGHT:` line still explicitly
  overrides a declared `TYPE` (proving the fix changed only `WARRANT`
  parsing, not `WEIGHT` precedence). Full suite: 523/523 (was 517/0
  baseline + 6 new).

### Added

- **`bench/runner.mjs`: `CELLS` gains `fable51-{low,medium,high,xhigh}`**
  (`claude-fable-5-1`, the current Fable tier) **and `fable5-high`**
  (`claude-fable-5`, the superseded dated id, for a direct 5-vs-5.1
  comparison at the same effort).
- **Per-run budget caps now scale with the cell's model price relative to
  Sonnet 5.** `--max-budget-usd` (both each task's own calibrated default
  and `scripts/benchmark.mjs`'s global ceiling) is the only working per-run
  runaway guard this CLI honours, and it kills a run once its ACTUAL API
  dollar cost crosses the cap — not once a token count does. Every cap was
  calibrated in Sonnet dollars, so a pricier model doing the identical
  amount of real work hit the SAME dollar cap sooner: Fable failed 7
  real-task runs purely this way (2026-09-23), cut off while still working
  because its cap was sized for a model at a fifth of its price. Fix: new
  `bench/runner.mjs` exports `modelPriceRatioToSonnet()` (reads
  `config/model-tiers.json`'s own `tiers.*.resolvesTo.pricing`, checking
  `classifyReferenceModel()` first so a dated id like `claude-opus-5` uses
  its own historical price rather than the current alias tier's) and
  `scaledMaxBudgetUsd()` (scales a base cap by that ratio, floored at 1x so
  a cheaper model's cap is never tightened). `runOne()` applies it to both
  the task default and the global ceiling before taking the tighter of the
  two, logs the actual scaled cap used as `max_budget_usd` on every results
  row, and `scripts/benchmark.mjs --dry-run`'s preview shows the same
  scaled number. Documented in `docs/BENCHMARK.md`. New
  `tests/bench-budget-scaling.test.mjs` (13 tests) plus two new
  `tests/bench-dry-run.test.mjs` cases.

## 0.27.1 — 2026-09-23

Folds in the `cache-read-weight-2026-09-23` experiment's findings and an
operator-endorsed routing trial v2. No schema/behavior changes beyond the
benchmark summary and the routing table's data.

### Added

- **Benchmark: per-cell cache HIT RATE column.** `bench/runner.mjs`'s
  `cacheHitRate()` computes `cache_read_tokens / (cache_read_tokens +
  cache_creation_tokens + input_tokens)`, medianed per (cell, task) into a new
  `cache_hit_rate` field in `summary.json` and a `hit_rate` column in
  `summary.md`, sitting next to `med_cache_read_tok` and `med_turns`. Any cell
  whose median hit rate falls under 0.85 is marked `cache_anomaly: true`, gets
  a `⚠` marker in the table, and is called out in a `CACHE ANOMALY: check
  harness` block above the table — a low hit rate usually means the harness
  broke prompt-cache sharing for that run, not that the model or task
  genuinely re-read more context. New `tests/bench-cache-hit-rate.test.mjs`.
- **`docs/BENCHMARK.md`: new "Caching" section.** Documents the cross-process
  caching gotcha found while running `cache-read-weight-2026-09-23` (separate
  `claude -p` processes, including `--resume`, do not reliably share prompt
  cache even with byte-identical content), the fix (a single persistent
  process via `--input-format stream-json --output-format stream-json
  --verbose`, one turn fed at a time, for any probe that measures across
  turns), and the plan-usage read/write weight finding below.
- **`skills/model-benchmark/SKILL.md`: two new preconditions.** "One process
  per measured conversation" (link to the Caching section) and "check the
  cache hit rate before trusting a batch's cost numbers" (the new
  `cache_hit_rate`/`CACHE ANOMALY` output).
- **`config/model-tiers.json`'s `costDrivers.planUsageWeighting` moves from
  `UNDOCUMENTED` to `MEASURED-PARTIAL`.** Plan metering of cache reads is
  roughly API-price-proportional (low-to-moderate confidence): 40.1M Sonnet 5
  cache reads moved the 5-hour usage meter ~2 points (~0.05 pts/1M reads,
  range 0.025-0.075); ~3.95M cache writes moved it ~4 points, so per token
  writes cost roughly 20x reads — the same direction and a similar order of
  magnitude as the API list-price ratio (~12.5x). Conclusion recorded:
  **cache MISSES (re-writes) are the expensive event, not reads.** The Opus
  5.5-vs-Sonnet-5 per-read ratio stays UNMEASURED — the Opus arm of the
  experiment hit the cross-process caching anomaly above before a clean
  reading could be taken. `planUsageMultipliers` keeps Opus 5.5 = 1.5x Sonnet
  5 (in-app tooltip, undocumented, unchanged) with a new note that this is an
  aggregate token-mix index, not a read-specific weight.
- **ROUTING TRIAL v2 (operator-endorsed, same window: since 2026-09-23,
  review by 2026-09-30).** Opus 5.5 at low effort measured cheaper than every
  Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low
  0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly
  half the turns, and equally correct; cache reads cost about the API ratio.
  This plan carries no separate Opus weekly usage window, so there is no
  separate-bucket reason to keep routing these types to Sonnet:
  - `explore`, `mechanical-edit`, `subagent-worker`, `verify`, `operate` move
    from v1's `sonnet/low` to `opus/low`.
  - `bounded-feature` and `debug-root-cause` were already `opus/low` (v1) and
    are unchanged.
  - `integration` (previously unmeasured, grid-resolved `sonnet/high`) gets
    its own override to `opus/high` — model only, not effort, since the
    elevated-consequence floor already puts effort at `high`. Reason:
    operator first-hand evidence that Sonnet struggles on some of the
    operator's multi-file technical work, not a benchmark finding.
  - `large-refactor` (grid `opus/xhigh`) and `novel-design` (grid `opus/max`
    via its kind's +2 delta) both move down to `opus/high`, the trial's
    middle ground: real-task data showed `xhigh` costing roughly 3.1x `low`'s
    tokens for no quality gain over `low`, and effort scaling specifically on
    architecture/novel-design work is itself unmeasured, so `max`/`xhigh`
    isn't paid for on an unverified assumption.
  - `critical-change` (consequence floor: `opus/xhigh`) and
    `long-autonomous-run` (already grid-resolves to `opus/xhigh`) are
    deliberately left alone.
  - A new **operator routing note** — "architecture and deep technical work
    stay on Opus; Sonnet gets confused on some of the operator's
    technical/architecture work (operator-observed 2026-09-23); do not route
    architecture off Opus on benchmark evidence alone" — is attached to
    `novel-design`, `large-refactor`, and `integration`.
  - `docs/ROUTING.md` regenerated from the updated config.
  - `tests/routing-trial.test.mjs` and `tests/verify-vs-operate.test.mjs`
    updated for the new resolved (model, effort) pairs; `tests/
    trial-fit-resolver.test.mjs`, `scripts/evaluate.mjs`, and
    `hooks/spawn-guard.mjs`'s fit check pick up every override automatically
    through the shared `resolveExpected()` resolver (no code changes needed
    there).

## 0.27.0 — 2026-09-23

Consolidated release folding in the routing lineup re-base, the ordered
effort ladder, the operator-approved routing trial (`review by
2026-09-30`), the SPAWNING RULE, cache-TTL guidance (measure gap bands
before flipping the subagent prompt-cache TTL), the model x effort
benchmark's move into the plugin, the Windows flashing-console-window fix,
and cache reads surfaced as the headline benchmark/routing cost-driver
metric. Windows fix is hardening only — no behavior change on any platform
where a hidden console was never visible.

### Added

- **Cache-read tokens, turns, and derived cost-driver stats are now HEADLINE
  columns in the benchmark summary**, not buried in the token breakdown.
  `bench/runner.mjs`'s `rebuildSummary()` computes, per (cell, task):
  `median_context_rereads` (`cache_read_tokens / num_turns`, an estimate of
  the average context size re-sent every turn) and `read_share_of_cost`
  (`cache-read $ / total $`, using the model's tier cache-hit price from
  `config/model-tiers.json`) — both `null`/`n/a` when the tier's cache-hit
  price is unmeasured, never a guessed number. `summary.md`'s columns are
  reordered so `med_cache_read_tok`, `med_turns`, `ctx_rereads`, and
  `read_share_cost` sit next to `pass_rate` and `cost_per_correct`.
  `summary.json` gains the same two new fields on every row. Reasoning:
  across this machine's real sessions, cache reads are the largest cost
  bucket — reads = context size x number of requests, so turn count and
  context size drive cost more than output tokens do.
- **`config/model-tiers.json`: new `costDrivers` block.** States the reads-
  dominate finding, the two actual cost levers (turn count, context size),
  that cache TTL only decides re-read vs re-write pricing after an idle gap
  (not a substitute for cutting turns/context), the per-tier cache-read
  price table, and that plan-usage weighting of cache reads is
  **UNDOCUMENTED**, pending experiment `cache-read-weight-2026-09-23`.
  Rendered into `docs/ROUTING.md`'s new "Cost drivers" section by
  `scripts/routing-table.mjs` (generated, not hand-edited).
- **`docs/BENCHMARK.md`: new "Reporting guidance: cache reads are the
  headline cost, not output tokens" section**, telling a human writing or
  reading a benchmark report to lead with cache-read tokens, turns, context
  re-reads, and read share of cost, ahead of output-token commentary.
- **New `tests/bench-summary-cost-drivers.test.mjs`.** Unit-level coverage of
  the two new `rebuildSummary()` fields: correct math for a measured tier
  (sonnet), `null`/`n/a` for a tier with no measured cache-hit price
  (mythos), and `null`/`n/a` when a row is missing turns/cache-read tokens.

### Fixed

- **`scripts/checks.mjs`, `scripts/detect.mjs`, `scripts/memory-vault.mjs`:
  every `execSync`/`execFileSync` call now carries `windowsHide: true`.**
  These are CLI/audit-tool call sites (`claude --version`, `claude plugin
  validate`, `git`, self-probing a hook script via `node`), not on the
  SessionStart/PreToolUse-Agent hook path itself -- that path
  (`hooks/lib/memory-index.mjs`'s `runGit()`, reached from `spawn-guard.mjs`
  on every subagent spawn) already carried the flag. Added for the same
  reason regardless: on Windows, whichever process actually allocates a
  console does not honor a flag set on an ancestor process, and these
  scripts run via `/audit`, the calibration scout, and memory-vault sync --
  all of which can run unattended.
- **New `scripts/lib/proc.mjs`.** Thin `execSyncHidden`/`execFileSyncHidden`/
  `spawnSyncHidden` wrappers, one place that hardcodes the flag, used by all
  three files above.
- **New `tests/no-visible-windows.test.mjs`.** Statically asserts every
  `spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync` call under
  `hooks/`, `scripts/`, and `bench/` carries `windowsHide` in its own
  argument list, so a future call site cannot silently reopen this. Verified
  against a real regression (removing the existing flag from
  `memory-index.mjs`'s `runGit()` made the test fail with the exact call
  site and line). Scope extended to `bench/` when this landed alongside the
  0.25.x benchmark port, which spawns dozens of `claude` processes per batch.

## 0.25.1 — 2026-09-23

Fixes a HIGH finding from adversarial review of 0.25.0's benchmark port: the
live path (`node scripts/benchmark.mjs` without `--dry-run`) could not make
a real model call for an operator authenticated the normal way (OAuth via
`claude /login`), and nothing told you why — every run silently reported a
0%-pass, $0-cost "completed" batch instead of an auth error. Patch bump —
bugfix, no new capability beyond the opt-in flag below.

### Fixed

- **`bench/runner.mjs` no longer redirects `HOME`/`USERPROFILE` by
  default.** The previous unconditional redirect (added in 0.25.0 for
  transcript-isolation reasons) stripped OAuth credentials, which live
  under `HOME` (`~/.claude/.credentials.json`) — every live run failed
  authentication before reaching the model. The default now matches the
  proven pre-port harness (`bench/effort-grid`, 300+ live runs): a
  sandboxed working directory per run, `--setting-sources ""`, and the
  operator's real, inherited env. Session transcripts (needed for effort
  proof) now land under the operator's REAL `~/.claude/projects/**` by
  default — each `results.jsonl` row carries `transcript_home`,
  `sandbox_cwd`, and `session_id` so the exact transcript path is always
  derivable, never guessed.
- **`--isolate-home`** (new, opt-in): redirects `HOME`/`USERPROFILE` to a
  fresh throwaway dir per run, same mechanism as the old default. Only
  works with `ANTHROPIC_API_KEY`-based auth (an env var survives the
  redirect; an OAuth credentials file does not) — `scripts/benchmark.mjs`
  refuses to start with `--isolate-home` when `ANTHROPIC_API_KEY` isn't
  set, rather than silently producing a batch of auth failures.
- **Auth/login failures are now a distinct `auth_error` status, not a
  silent task failure.** `bench/runner.mjs`'s new `isAuthError()` detects
  the failure shape (`"Not logged in"`/`"Please run /login"`/`401` text, or
  an `api_error` terminal_reason/subtype at `$0`/null cost) from either the
  run's own JSON or raw stdout. `scripts/benchmark.mjs` (and
  `bench/runner.mjs`'s own `main()`) abort the batch immediately on the
  first `auth_error` row with a clear message
  (`authErrorAbortMessage()`), instead of burning the rest of the plan.
  `rebuildSummary()` excludes `auth_error` rows from pass-rate and every
  other stat, and flags the excluded count at the top of `summary.md`. The
  per-run console line now shows `status=ok` / `status=auth_error` /
  `status=error(<terminal_reason>)` (`formatRunLine()`) instead of a bare
  `pass=false cost=$0`, so an auth failure can never be misread as the
  model failing every task at a glance.
- **`--dry-run --resume` now honors the resume marker.** Previously the
  `--dry-run` branch exited before `--resume`'s cell-filtering logic ran at
  all, so it always showed the full original grid, including cells already
  marked complete — misleading as a "what's left" preview mid-batch.
  Resume filtering now happens before the dry-run branch, and a dry run
  with `--resume` prints the same `Resuming: N/M cell(s) remaining (...)`
  line the real run does, then plans only the remaining cells.
- `docs/BENCHMARK.md` and `skills/model-benchmark/SKILL.md` updated to
  match: a new "Preconditions: authentication for a LIVE run" section,
  corrected "Effort is proven via the transcript" (real home by default)
  and "Sandbox isolation" (HOME redirection is opt-in) sections.
- Tests: `tests/bench-auth-error.test.mjs` (new — `isAuthError()`
  classification including the exact reproduced shape, `checkIsolateHomePreflight()`
  refusal/acceptance including at the CLI layer, `formatRunLine()`/
  `authErrorAbortMessage()` distinct-status output, `rebuildSummary()`'s
  pass-rate exclusion math); `tests/bench-dry-run.test.mjs` (new cases for
  `--dry-run --resume`, `--dry-run --resume` with nothing left, and
  `--dry-run` without `--resume` being unaffected by a stale marker).
  Suite: 323/0 (was 302/0).

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
