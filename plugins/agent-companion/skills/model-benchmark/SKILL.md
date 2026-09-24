---
name: model-benchmark
description: Reusable procedure for re-running agent-companion's model x effort benchmark (scripts/benchmark.mjs, bench/) when the lineup, aliases, or plan-usage multipliers change. Use when a new model release ships, an alias is remapped (e.g. `opus` starts resolving to a different model), the calibration scout raises `harness_version_changed` or `routing_trial_review_due`, the operator asks "is model X worth it" or "should this route to a different tier", or a re-measure date recorded in config/model-tiers.json is reached. Not for a one-off "run this one task once" — for that, use scripts/benchmark.mjs directly.
---

# Model x effort benchmark

Full mechanics, every gotcha, and consolidated lessons from the 2026-09-23
pilot/hard/real build live in `docs/BENCHMARK.md` — read it in full before a
re-run. The raw build log (more detail, less distilled) is
`bench/PROCESS-NOTES.md`. This file is the procedure; it does not restate
either.

## (1) Preconditions

- **CLI version** — check `claude --version` against
  `config/model-tiers.json`'s `aliasResolution.minClaudeCodeVersion`.
- **Authentication for a LIVE run (not --dry-run): just be logged in.**
  Default behavior does NOT redirect HOME/USERPROFILE, so your normal OAuth
  session (`claude /login`) is used as-is — no extra setup. If a run comes
  back with `status=auth_error` in the console line (or `auth_error:true`
  in `results.jsonl`), the batch has already aborted — see docs/BENCHMARK.md
  "Preconditions" before re-invoking. Only pass `--isolate-home` if you
  specifically want per-run HOME isolation, and only with `ANTHROPIC_API_KEY`
  set (refused otherwise).
- **Full model IDs, not bare aliases**, for anything an alias might float
  across (`claude-opus-5-5` vs `claude-opus-5`, not `opus`) — `bench/runner.mjs`'s
  `CELLS` table already does this; don't override it with a bare alias.
- **Prove effort via the transcript, never the run's own JSON** —
  `--output-format json` has no `effort` field. See docs/BENCHMARK.md. By
  default the transcript lands under your REAL `~/.claude/projects/**`
  (only under a throwaway one with `--isolate-home`) — each result row's
  `transcript_home`/`sandbox_cwd`/`session_id` together give the exact path.
- **Spawn `claude.exe`, never `claude.cmd`, and hide the window.**
  `bench/runner.mjs`'s `resolveClaudeBin()` + `windowsHide: true` handle
  this already — verify you're calling through `scripts/benchmark.mjs` or
  `bench/runner.mjs` directly, not re-implementing the spawn.
- **Every run gets its own sandboxed working directory** (always, not
  opt-in) — see docs/BENCHMARK.md "Sandbox isolation". Do not disable this
  for convenience.
- **One process per measured conversation.** Separate `claude -p` processes
  (including `--resume`) do NOT reliably share prompt cache even with
  byte-identical content — `bench/runner.mjs`'s own cells are fine (one
  process per task already), but a probe that needs to measure ACROSS turns
  must use a single persistent process (`--input-format stream-json
  --output-format stream-json --verbose`, one turn fed at a time), not one
  `claude -p` call per turn. See docs/BENCHMARK.md "Caching".
- **Run each cell in the FOREGROUND.** No background jobs, no monitors or
  watchers that notify on completion. Every notification wakes the lead,
  which is an expensive turn, and it says only that something finished, not
  that the output is sane. `--batch-by cell` already hands control back after
  each cell.
- **Parallel runs across the WHOLE grid are fine — `--concurrency N`.** This
  replaces any earlier "one at a time" (or "one cell at a time") assumption
  for THIS benchmark; the FOREGROUND rule above is unchanged (concurrency
  means several `claude` child processes inside one foreground invocation,
  never a background job). WITHOUT `--batch-by cell`, `--concurrency` bounds
  ONE scheduler pool spanning every requested cell — two different cells'
  runs can be active at once. WITH `--batch-by cell`, cells still run one
  after another (that flag trades cross-cell overlap for a real checkpoint
  between cells) and `--concurrency` bounds each cell separately. The
  scheduler (`bench/scheduler.mjs`) never co-schedules runs whose declared
  `resources` conflict — whichever cell they belong to — and gives every run
  its own `TMP`/`BENCH_PORT_BASE`. **Wall-time comparisons must note the
  concurrency level** (a `duration_ms` under `--concurrency 4` is not
  comparable to one under `--concurrency 1`) — cite `cost_usd`/
  `relative_cost_index` as the primary cost signal, since per-cell usage
  deltas do not isolate cleanly under concurrency.
- **Collision handling has TWO mechanisms — which one applies depends on
  WHEN the collision happened.** Full rule and worked examples in
  docs/BENCHMARK.md "Collision handling". Both exclude a CONFIRMED collision
  from `pass_rate`/every other stat, and both keep every row in
  `results.jsonl` — nothing is ever silently dropped.
  - **Legacy path — before the model's work completed** (`setup()` threw a
    structural `.code`, e.g. `EADDRINUSE`, a lock held): the scheduler
    auto-retries alone once, with a fresh sandbox and a fresh model call. The
    exclusion from pass-rate only holds once that retry CONFIRMS the
    collision (does not reproduce it solo) — a failure that reproduces even
    running alone is counted as real. `summary.md`: `COLLISION` /
    `SUSPECTED COLLISION, NOT CONFIRMED`.
  - **Re-score path — after the model's work completed** (a real task
    pack's `score()` never throws; it just looks like an ordinary failure):
    ANY run that fails while genuinely co-scheduled gets `needs_rescore:
    true`, its sandbox is kept alive, and the scheduler queues a solo
    `<run_id>::rescore` retry that re-runs ONLY `task.score()` against the
    SAME retained sandbox — never the model again. Re-score passes → the
    original is superseded and excluded, the `::rescore` row counts in its
    place. Re-score fails too → the original failure counts normally (never
    lost) and the redundant `::rescore` row is excluded. No `::rescore` row
    at all (the batch stopped first, e.g. an `auth_error`/judge refusal
    while it was still queued but never admitted) → fails OPEN: the original
    failure counts normally, its retained sandbox is abandoned (harmless).
    `summary.md`: `RESCORED` / `RE-SCORE CONFIRMED A REAL FAILURE`.
- **`bench/runner.mjs`'s own direct CLI has no `--concurrency`.** It refuses
  the flag with a message pointing at `scripts/benchmark.mjs` — always drive
  a parallel run through `scripts/benchmark.mjs`, never the bare runner.
- **`--resume` reruns a whole cell that was interrupted before it was marked
  complete** (an `auth_error`/judge refusal while a `needs_rescore` retry
  was queued but never admitted), regenerating a fresh row under the exact
  SAME deterministic `run_id` as the earlier, abandoned attempt.
  `rebuildSummary()` dedupes by ATTEMPT FAMILY before computing anything: a
  base original row and every `::retry`/`::rescore` child that follows it
  (in file order, not by run_id string — two attempts can each produce a
  literally identical child id) travel together. The latest family wins
  unless it's abandoned (a `needs_rescore` original with no rescore ever
  admitted), in which case it loses to any later family; when every family
  for a slot was abandoned, the last one still counts (fail open — a
  recorded failure is never silently dropped). `summary.md` prints a
  `RESUME DUPLICATE: N row(s)` banner naming every superseded row. See
  docs/BENCHMARK.md "Resuming a batch".
- **A leaked sandbox/temp dir is cosmetic, never a verdict signal.**
  Windows can throw `EPERM`/`EBUSY`/`ENOTEMPTY` when removing a just-
  finished run's sandbox or temp dir (a lingering child-process handle, an
  antivirus scanner, or delayed directory-entry accounting) — every removal
  in the concurrent run path (`runOne()`/`rescoreOne()`, and
  `bench/judge.mjs`'s per-vote temp cwd) retries through the same async,
  non-blocking `removeDirWithRetry()` (`bench/tasks/common.mjs`) so a
  backoff wait never stalls a sibling run. A failure that survives every
  retry NEVER changes the run's own `pass`/`collision`/`needs_rescore`
  verdict — only the bare OS error code lands on the row's `cleanup_error`
  field (never a path), and `rebuildSummary()`/`bench/estimate.mjs` both
  ignore it for every stat. `summary.md` prints a `CLEANUP: N run(s)` line
  when at least one row carries it. See docs/BENCHMARK.md "Sandbox cleanup
  retry (Windows)".
- **Never `git stash`.** The stash stack is shared by every worktree and every
  concurrent session. Use a WIP commit, or leave uncommitted work untouched.
- **Budget caps scale with model price.** Task budgets and `--max-budget-usd`
  are in Sonnet dollars, and the runner scales them per cell. Do not hand-
  shrink a cap for a pricier model.
- **Check the cache hit rate before trusting a batch's cost numbers.**
  `summary.md`/`summary.json`'s `cache_hit_rate` (and the `CACHE ANOMALY:
  check harness` block, when triggered) flags any cell under 0.85 — that
  usually means the harness broke caching for that run, not that the model
  or task genuinely cost more. Investigate before citing cost/plan-usage
  figures from a flagged cell.

## (2) Plan first, always

```bash
node scripts/benchmark.mjs --dry-run --cells all --tasks all --reps 1
```

Zero model calls. Confirms the cell x task x rep count and the exact args
each run would use before anything spends a token. Always run this before a
real batch, and re-run it after changing `--cells`/`--tasks`/`--reps`.

**`--dry-run` also prints the pre-run estimate** (`bench/estimate.mjs`):
wall time at the chosen `--concurrency`, tokens by class (input, cache-read,
cache-write, output), an API-equivalent $ figure, and a weekly usage-window
points range — from this machine's own local `results.jsonl` history when it
has any for that cell, else the shipped seed (`bench/config/estimate-seed.json`,
labelled "shipped seed"), else a rough guess (labelled "no local history,
rough guess"). The estimate's **5-hour-window points reads `unknown`** unless
a real, separately-measured `fiveHourPointAnchors` entry has been added to
the seed (none ships today — see docs/BENCHMARK.md "Pre-run estimate and
confirmation gate") — it is never the weekly figure copied over. A LIVE run
(not `--dry-run`) prints the exact same estimate before doing anything else,
and is gated behind it — see (3) below.

## (3) Budget

The plan's **weekly all-models usage window** is the currency being
managed, not dollars. Default soft ceiling for a re-run: **+10 points**
over the baseline read at the start of the session, unless the operator
gives a different number.

- Read `mcp__ccd_session_mgmt__get_usage` (`session_id: "self"`) **before
  and after every batch** — this cannot run inside `scripts/benchmark.mjs`
  itself (it's an MCP tool available to the orchestrating agent, not to a
  plain Node script). Pass the reading straight through as
  `--weekly-usage-pct <N>` on every invocation (including `--dry-run`) so
  the estimate's "current -> projected" line is real instead of "unknown",
  and as `--weekly-ceiling-pct <N>` alongside a chosen ceiling so the script
  itself can gate and stop — it never reads usage on its own.
- **Confirmation gate.** A live run (not `--dry-run`) refuses to start (exit
  2) when the estimate is above `--confirm-above-points` (default 2), any
  Fable cell is selected, or the projected weekly % would reach/cross
  `--weekly-ceiling-pct` — printing the reason(s) and, when dropping the
  most expensive cells would still leave something to run, a ready-to-paste
  cheaper `--cells` list. Read the printed estimate, then re-invoke with
  `--confirm` to proceed (or narrow `--cells`/`--tasks`/`--reps` instead).
  Never pass `--confirm` without having actually read the estimate that
  invocation just printed.
- **Live stop between batches.** With `--batch-by cell` and both
  `--weekly-usage-pct`/`--weekly-ceiling-pct` set, the script stops at the
  NEXT cell boundary once the ceiling is reached (prints `CEILING REACHED`
  and a partial-results summary path, exits 0) instead of starting another
  cell — check `get_usage` before every `--resume` and pass the fresh
  reading back in. WITHOUT `--batch-by cell` (the grid-wide pool), there is
  no mid-run cell boundary to stop at — the same check runs ONCE up front,
  before anything is scheduled, and a ceiling reached mid-run instead means
  an `auth_error`/judge refusal: no NEW run is launched, every already
  ACTIVE run finishes, and the partial summary is written from those.
- Use `--batch-by cell`: it runs ONE cell to completion, writes a
  `.batch-state.json` marker under `--out-dir`, and **exits**. Check
  `get_usage` and the just-written `summary.md`, then `--resume` to
  continue or stop.
- `--max-budget-usd <amount>` is a global per-run ceiling on top of each
  task's own calibrated budget (never looser than the task's own number).
- Readings are integer-rounded and the account may be shared with
  concurrent sessions — treat plan-usage as a coarse "are we near the
  ceiling" check, and the token-derived `cost_usd`/`plan_usage_index` in
  `summary.md` as the primary signal for relative comparisons. The
  weekly-point anchors behind the estimator's numbers are themselves upper
  bounds (measured while other sessions ran concurrently) — see
  `bench/estimate.mjs`'s own comments before treating them as exact.
- **The "Opus 5.5 = 1.5x Sonnet" plan-weight figure is unconfirmed** (an
  in-app tooltip) and is deliberately not used by the points estimator,
  which scales by each cell's own measured $ cost ratio instead — the
  estimate's per-cell breakdown says so on any Opus row.

## (4) Order

1. **Rep 1 across every cell, every task family** first (`--tasks all
   --reps 1`) — the pilot pass.
2. **Check for a ceiling effect before spending on reps 2-3.** If every
   sonnet/opus cell at every effort passed rep 1 on the `easy` family (the
   documented default outcome — docs/BENCHMARK.md), reps 2-3 there won't
   separate them either.
3. If saturated, escalate to `--tasks hard`, then `--tasks real` (mined
   from actual bug-fix commits — see `bench/task-packs/FORMAT.md` to add
   more without committing extracted source).
4. **Reps 2-3 only for cells that already showed a difference** at rep 1.
   A single run cannot separate close settings: Opus 5.5 high 5/7 vs low 7/7
   on the real tasks was variance. Use **at least 3 reps before comparing
   adjacent efforts**, and check that the 95% intervals in `summary.md` do
   not overlap before calling one better.
5. **Fable only if Opus at xhigh fails something** — it's an exception tier
   requiring a warrant, not a grid row (`config/model-tiers.json`'s `fable`
   entry).

## (5) Fairness: re-score vs re-run

Full rule and worked examples in docs/BENCHMARK.md. Short version:
audit whether every OTHER cell solved the same task with the same prompt
before suspecting the model. **Test-wording bug → re-score**
(`node bench/rescore.mjs <resultsDir>`, no model calls). **Genuine prompt
under-specification → fix the prompt and re-run** the affected cells only
(their prior rows/answers are stale, not a fair replay target).

For any real-history task or task pack: confirm the leak guard is live
(`assertNoLeakedFixLanguage` wired into `setup()`) — grep the sandbox
yourself if in doubt.

## (6) Reporting

**Real-world and synthetic evidence are never pooled** (docs/BENCHMARK.md
"Evidence families"). Every row and every summary entry carries an
`evidence_family` (`real` | `synthetic` | `unknown`) and a finer
`evidence_family_fine` (`real-bugfix` | `architecture` | `mined` |
`easy-synthetic` | `hard-synthetic`); `summary.md` prints separate
`## REAL-WORLD RESULTS` / `## SYNTHETIC RESULTS` sections rather than one
mixed table. When you hand-write a report from these results, keep that
same separation — never a combined pass rate, cost, or token figure across
the two, and never cite a synthetic-only result as evidence for a real-world
capability or cost claim (or the reverse). An `unknown`-family row belongs
in neither section; call it out on its own rather than folding it into
whichever section is more convenient.

Order: **quality first**, then cost per CORRECT result, a **cost index
relative to sonnet/medium** on the same task set, and a **plan-usage index**
(`config/model-tiers.json`'s `planUsageMultipliers`, cited by source and
date — `scripts/benchmark.mjs`'s generated `summary.md`/`summary.json` do
this already; don't strip the citation when hand-editing).

Quality is reported as **pass@1** (mean single-trial pass rate across reps)
with a **95% Wilson interval** and **pass@k** (k = reps). Read the "By task
family" table: a family group under 5 runs says "n too small to separate",
and so should your report. Cite `claude_cli_version` and
`task_content_sha256` from the rows when comparing against an earlier batch.
If either differs, the harness or the task changed, not only the model.
See docs/BENCHMARK.md "Statistics" and "Reproducibility metadata".

`claim_honest` is EXPERIMENTAL — a word-bag heuristic, unreliable on long,
hedged answers (29-57% on real-history tasks even when fully correct). Read
the actual claim text before treating a low rate as a quality problem.

**Optional rubric judge** (docs/BENCHMARK.md "Rubric judge"): a DESIGN-QUALITY
SIGNAL ONLY, never a correctness check — on real (non-fixture) work the judge
does NOT track the hidden tests, it has passed changes the hidden tests then
failed. Correctness comes from the hidden tests alone; never gate pass/fail
or a merge decision on `judge_pass`. Calibrate first
(`--calibrate-judge --judge-model <id>`, real judge calls), then pass the
same `--judge-model` to the run. The judge must differ from, and be at least
as strong as, every cell's model AND effort (a fable/xhigh or opus/xhigh
answer is bumped up to a judge effort of at least its own, capped at xhigh),
and an uncalibrated judge is refused before any model call. Report
`judge_pass_rate` as its own column. Never fold it into pass@1. Cost is real:
measured at roughly $0.81/vote at fable/high (2026-09-24), about 3x a rough
earlier estimate — check `judge_cost_usd` on a small run before committing
to a full grid.

## (7) Outputs

- **Never in this repo.** Default: the plugin data dir's
  `benchmarks/<phase>-<date>/` (`results.jsonl`, `summary.json`,
  `summary.md`, `answers/`) — `scripts/benchmark.mjs --out-dir` to
  override.
- After a re-run that changes the picture: regenerate `docs/ROUTING.md`
  from `config/model-tiers.json` (never hand-edit — see the `routing-table`
  skill) and update `config/model-tiers.json`'s `taskTypes.*.override` /
  `calibration.*` / `retiresAfter`/`replacement` entries to reflect what
  the new data showed, with `evidence.source` pointing at the results dir.

## Adding a new benchmark task without committing extracted source

Use a task pack (`bench/task-packs/FORMAT.md`) rather than hand-baking a
fixture module: `build-pack.mjs --repo <path> --parent <ref> --fix <ref>
--files ... --report ... --hidden-test ...` extracts and VERIFIES
fail-at-parent/pass-at-fix before the pack is usable, and the pack itself
never carries the extracted source — only a report, a hidden test, and two
base64-encoded git refs (`lib.mjs`'s `loadPack()`/`encodeRef()` — a
plaintext SHA is exactly what this repo's own `leak-check.mjs` bans).
