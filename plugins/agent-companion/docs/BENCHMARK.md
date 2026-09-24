# Model x effort benchmark — consolidated lessons

The full, blow-by-blow build log lives in `bench/PROCESS-NOTES.md` — this
page distills what a future re-run actually needs, in the order it needs it.
Read this first; go to PROCESS-NOTES.md for the "why" behind any one of
these, or for the real measured numbers from the 2026-09-23 pilot/hard/real
phases (kept out of this repo — see "Where results live" below).

## Preconditions: authentication for a LIVE run

**Live runs use your normal, already-authenticated Claude Code session by
default.** `scripts/benchmark.mjs`/`bench/runner.mjs` do NOT redirect
`HOME`/`USERPROFILE` unless you pass `--isolate-home` — matching the proven
pre-port harness (`bench/effort-grid`, 300+ live runs). If you're logged in
via `claude /login` (OAuth, the common case), a plain live run just works;
no extra setup needed.

**Found the hard way, 2026-09-23:** an earlier version of this runner
redirected `HOME`/`USERPROFILE` to a throwaway dir on EVERY run
unconditionally. OAuth sessions store their credential under `HOME`
(`~/.claude/.credentials.json`), so every "live" run under that redirect
silently failed authentication instead of making a model call —
`is_error:true`, `terminal_reason:"api_error"`, `cost_usd:0`, answer text
`"Not logged in · Please run /login"` — and looked like a 0%-pass benchmark
run rather than an auth failure. `scripts/benchmark.mjs` now classifies this
shape as a distinct `auth_error` status (`bench/runner.mjs`'s
`isAuthError()`), aborts the batch immediately on the first one instead of
burning the rest of the plan, and excludes any such row from pass-rate math
(`rebuildSummary()`). The per-run console line also shows `status=ok` /
`status=auth_error` / `status=error(<reason>)` instead of a bare
`pass=false`, so an auth failure can never be misread as the model failing
every task.

**`--isolate-home`** is still available, opt-in, for when you genuinely want
per-run HOME isolation (e.g. running a large unattended batch and you'd
rather the spawned process never touch `~/.claude` at all for any reason).
It **only works with `ANTHROPIC_API_KEY`-based auth** — an env var survives
the redirect (`{...process.env}` carries it through), an OAuth credentials
file does not. `scripts/benchmark.mjs` refuses to start with `--isolate-home`
when `ANTHROPIC_API_KEY` isn't set, rather than silently producing a batch
of `auth_error` rows.

## Ceiling effects are the default outcome, not an edge case

Every hand-authored synthetic task built for this benchmark (lookup, verify,
procedure, diagnosis, instruction-logic — even after a full "hard" redesign:
8-file multi-hop verify, 13-step outcome-dependent procedure, 3-file/3-hop
diagnosis with a red herring, 17-rule/19-record instruction-logic with a
3-deep precedence chain) hit 100% pass for every Sonnet and Opus cell at
every effort level, across 3 reps. Only Haiku ever failed, and only on the
file-operation procedure task.

**A model x effort benchmark meant to separate paid tiers needs tasks
calibrated against the tier you actually expect to fail sometimes** —
calibrate against opus-high/xhigh, not against what feels hard to a human.
Tokens/turns/cost still separate cells cleanly even when pass/fail is
saturated (2-4x spread was typical) — that data stays useful as an
effort-compliance proxy, but stop treating it as a capability signal once
nothing fails. This is why the `real-*` tasks exist: real capability
separation needed tasks mined from actual bug-fix commits, not synthetic
fixtures both the model and its training data are well-practiced at.

## Statistics: pass@1, pass@k, and 95% intervals

**Single-run results cannot separate close settings.** On the 2026-09-23 real
tasks, Opus 5.5 at high passed 5/7 while Opus 5.5 at low passed 7/7. That read
like "low beats high". It was variance: the 95% intervals are [36-92%] and
[65-100%], and they overlap. Use **at least 3 reps** before comparing two
adjacent effort levels (or two adjacent models), and compare intervals, not
point estimates.

`rebuildSummary()` (`bench/runner.mjs`, maths in `bench/stats.mjs`) reports
this directly:

- **pass@1** is the mean single-trial pass rate across reps (the number older
  summaries called `pass_rate`; `summary.json` keeps `pass_rate` as an alias).
  This is the SWE-bench-family label, so our numbers can be read next to
  public ones.
- **pass@k**, with k = the reps actually run, is the unbiased estimator
  `1 - C(n-c, k) / C(n, k)`. At k = n it reads "passed at least once in k
  tries". A large gap between pass@1 and pass@k means the cell is capable
  but inconsistent.
- **95% CI** is the Wilson score interval. It stays inside [0, 1] and behaves
  at 0/n and n/n, which is where saturated cells sit.
- A **cell x task-family** rollup (`summary-by-family.json`, plus the "By
  task family" table in `summary.md`) pools each cell's runs per family
  (easy / hard / real / pack). Per-task n is usually 1-3, too small for an
  interval to mean anything. A family group with **fewer than 5 runs** is
  marked **"n too small to separate"**. pass@1 there is the mean of per-task
  rates, the interval is over the pooled runs, and pass@k uses k = the
  smallest rep count among the family's tasks.

## The fairness rule: re-score vs re-run

A held-out hidden test may only assert behavior the report/prompt states or
implies — never something you know from the diff or commit message that the
prompt never mentioned. Before re-running a cell over a suspected scorer/
test bug, **audit first**: check whether every OTHER cell solved the same
task with the same prompt. If stronger cells also fail, or fail
inconsistently, suspect the scorer/prompt, not the model.

Then choose by WHICH kind of bug it is:

- **Test-wording bug** (the model did the right thing, phrased differently
  than a literal regex expected — e.g. `/INHERIT/` case-sensitive rejecting
  a correct "it will inherit...") → **re-score, never re-run**:
  `node bench/rescore.mjs <resultsDir>` replays `score()` against every
  saved `answers/<runId>.json` (full answer text + final sandbox tree), no
  model calls, no cost. Relax the assertion to check the CONCEPT, not the
  exact phrase, then re-score.
- **Genuine prompt under-specification** (the fixture has a shape the prompt
  never told the model how to handle — e.g. a bare repo with no `origin`
  remote configured on itself, and the prompt never said what to do then) →
  **fix the prompt and re-run** the affected cells. The model didn't have
  the information before, so a saved answer is not a fair replay target;
  delete its row/answer rather than re-scoring it.

Real example of each, from the 2026-09-23 rep: `real-effort-note` was a
wording bug (case-sensitive regex) — re-scored, 3 cells flipped to pass, no
re-run. `real-publication-sweep` was a genuine gap (the prompt never said
what to do about a bare `origin.git` repo with no remote of its own) — the
prompt was fixed and the 3 affected cells were re-run.

## Effort is proven via the transcript, never the run's own JSON

`--effort <level>` is a real per-run CLI flag; `--output-format json`'s
result object has **no `effort` field at all**. Proof lives in the
session's own transcript, at
`<transcript-home>/.claude/projects/<encoded-cwd>/<session_id>.jsonl`'s
session-init line: `"effort":"low"|"medium"|"high"|"xhigh"`.

**By default (no `--isolate-home`) `<transcript-home>` is your REAL home** —
the runner does not redirect `HOME`/`USERPROFILE` (see "Preconditions"
above), so the transcript lands under your actual `~/.claude/projects/**`,
same as any other Claude Code session you've ever run. `<encoded-cwd>` is
still unique per run (each run gets its own throwaway sandbox directory —
see "Sandbox isolation" below), so there's no collision risk even though
it's not a fake home. Every saved `results.jsonl` row carries
`transcript_home`, `sandbox_cwd`, and `session_id` together, so the exact
transcript path is always directly derivable from the row, no guessing
required. Only with `--isolate-home` does `<transcript-home>` become the
run's throwaway fake home instead (cleaned up after the run finishes —
copy the transcript out first if you need it).

**A "surprising" identical result across efforts is not automatically a
bug** — check the transcript before assuming one. `sonnet-low/medium/high`
once produced byte-identical, fully correct 10-claim verify answers (same
token count, same turns, same cost). Before concluding effort wasn't
applied: 3 distinct session ids, 3 distinct transcript `effort` values, 3
answer texts diffed and found byte-identical. Conclusion: real convergent
behavior on a saturated task (see "Ceiling effects" above), not a broken
flag.

## Reproducibility metadata on every row

When a score moves, the cause is one of three things: the harness changed,
the task changed, or the model changed. Every `results.jsonl` row (including
the error row written when `runOne()` itself throws) records enough to tell
them apart:

| Field | Tells you |
|---|---|
| `claude_cli_version` | the harness (`claude --version`, asked once per process; `null` if it could not be read, never guessed) |
| `requested_model` / `resolved_model` | whether an alias floated to a different snapshot (`model_mismatch`) |
| `requested_effort` | the effort asked for (proof it applied is still the transcript, above) |
| `task_family` | easy / hard / real / pack, for the family rollup |
| `task_prompt_sha256` | the exact prompt text the model received |
| `task_fixture_sha256` | the starting sandbox tree, hashed after `setup()` and before the model runs |
| `task_pack_sha256` | for a task pack: its manifest, brief (`report.md`), held-out test and rubric |
| `task_rubric_sha256` | the rubric, when the task has one |
| `task_content_sha256` | all of the above combined, one value to compare across batches |

Two batches with the same `task_content_sha256` and `claude_cli_version`
differ only in the model and in sampling.

## Known flag gaps in this CLI generation

- **No `--max-turns` flag exists** (checked via `claude -p --help`) — older
  docs describe one; do not assume it still exists without checking
  `--help` first on whatever build you're running.
- **`--settings '{"maxTurns":N}'` is silently ignored** — verified
  empirically: a 4-step task hit `num_turns:12` despite `maxTurns:1`.
- **The only working per-run runaway guard is `--max-budget-usd`.** When
  hit, the run terminates early with `terminal_reason: "budget_exhausted"`,
  `is_error: true`. Sized per task in each task module's `maxBudgetUsd`;
  `scripts/benchmark.mjs --max-budget-usd` applies an additional global
  ceiling on top (the tighter of the two always wins — see
  `bench/runner.mjs`'s `runOne()`).
- **Both of those caps are calibrated in SONNET dollars, and are scaled by
  the cell's model price before use (`bench/runner.mjs`'s
  `scaledMaxBudgetUsd()`/`modelPriceRatioToSonnet()`, fixed 2026-09-23).**
  `--max-budget-usd` kills the run once the ACTUAL API dollar cost crosses
  the cap, not once a token count does — a pricier model doing the exact
  same amount of real work costs proportionally more real dollars for an
  identical token count, so a Sonnet-sized cap cut a pricier model off
  before the task was actually done. Concretely, this failed Fable on 7
  real-task runs (2026-09-23, `budget-cap-fable-cutoff` finding): the model
  was still working when the CLI killed it for "exceeding" a cap sized for
  a model at a fifth of Fable's price. The fix scales every cap — the
  task's own `maxBudgetUsd` AND `--max-budget-usd`'s global ceiling — by
  the ratio of the cell's model price to Sonnet 5's
  (`config/model-tiers.json`'s own `tiers.*.resolvesTo.pricing`, with a
  dated id like `claude-opus-5` checked against `referenceModels` first for
  its own historical price rather than the current alias tier's), floored
  at 1x so a cheaper model's cap is never tightened. `bench/runner.mjs`'s
  results rows log the ACTUAL scaled cap used as `max_budget_usd`, and
  `scripts/benchmark.mjs --dry-run`'s preview shows the scaled number, not
  the raw per-task default — both mirror the same scaling so what you see
  before a run matches what the run actually used.
- **`bench/rescore.mjs` cannot re-score a task-pack run.** Task-pack tasks
  (`bench/task-packs/`) are merged into the runnable set only at
  `scripts/benchmark.mjs`'s CLI layer (they need a `--pack-repo` path
  `bench/runner.mjs`'s own static `TASKS` map has no way to supply) — a
  saved pack-task answer must be re-scored by hand for now.

## The Windows spawn fix

`node:child_process.execFile("claude", ...)` on Windows resolves to
`claude.cmd` (the npm-style shim), and `execFile` cannot run `.cmd`/`.bat`
files without `shell: true` — which risks cmd.exe re-interpreting a long,
multi-line, quote-heavy task prompt. Fix (`bench/runner.mjs`'s
`resolveClaudeBin()`): run `where claude.cmd` once, take its directory, and
append the known relative path to the bundled `claude.exe`
(`node_modules/@anthropic-ai/claude-code/bin/claude.exe`, the same path
`claude.cmd`'s own batch script uses internally). Override with `CLAUDE_BIN`
if the install layout differs. Resolution is **lazy** (only on the first
actual `runClaude()` call, not at module import) specifically so
`--dry-run` and every offline test can import `bench/runner.mjs` — for
`CELLS`/`TASKS`/`parseArgs`/`defaultResultsRoot()` — without a `claude`
binary needing to be resolvable at all.

## Operating rules for a benchmark agent

These rules come from running the benchmark. The operator observed each
failure at least once.

- **Run every cell in the FOREGROUND.** Do not start background jobs, and do
  not arm monitors or watchers that notify on completion. Each notification
  wakes the lead session, and that wake re-reads the lead's whole context: an
  expensive turn that buys nothing a foreground run would not have given you.
  A notification also only says a batch finished, not that its output is
  sane. `scripts/benchmark.mjs --batch-by cell` writes a `.batch-state.json`
  marker and **exits after each cell** for exactly this reason: control goes
  back to the driving agent, which reads `get_usage` and the just-written
  `summary.md`, then decides whether to `--resume`.
- **Never `git stash`.** The stash stack is shared across every worktree and
  every concurrent session on the machine, so a `stash pop` can apply another
  session's work. To set changes aside, make a WIP commit, or leave
  uncommitted work where it is.
- **Budget caps scale with model price.** Every per-task `maxBudgetUsd` and
  the global `--max-budget-usd` are in Sonnet dollars. The runner scales them
  by the cell's price (see "Known flag gaps" below). Never hand-tune a cap
  down for a pricier model: that is the unit error that cut Fable off
  mid-task on 7 runs.
- **Use at least 3 reps to compare adjacent settings.** One run each cannot
  separate them. See "Statistics" above: Opus 5.5 high 5/7 vs low 7/7 was
  variance.

## `claim_honest`: useful, not reliable on long answers

`claim_honest` compares the model's own `CLAIM:` line against the actual
pass/fail verdict via a word-bag heuristic (`bench/tasks/common.mjs`). It is
a useful secondary signal, but real-history task answers ran 29-57%
`claim_honest` even when fully correct — multi-paragraph root-cause
explanations with hedged, uncertain language trip the heuristic far more
than short declarative pilot-task answers do. **Don't read a low
`claim_honest` rate as a quality problem without checking the actual claim
text.** The heuristic itself needed three rounds of adversarial fixes
against REAL model output (not just hypothetical bad answers) before it was
trustworthy at all — see `bench/PROCESS-NOTES.md` lesson 4 for the exact
false-negative classes found (a "0 fail" success statement matching the bare
word "fail"; "false-positive" matching bare "false"; methodology text like
"did not run any code" matching a negation phrase).

## Rubric judge (optional, a separate score)

A hidden test answers "does it work". It cannot say whether the change fixed
the real cause or special-cased the test, stayed in scope, or added needless
complexity. Once every cell passes (the default outcome, see "Ceiling
effects"), those are the only quality differences left.
`bench/judge.mjs` grades a run's **change** (a unified diff of the sandbox,
before -> after) against a **rubric that lives in the task definition**: a
task pack's `rubric.md`, or a built-in task's `rubric` string. It is off
unless you pass `--judge-model`, and it only runs on tasks that have a rubric.

The rules, each enforced in code and covered by `tests/bench-judge.test.mjs`
(every test stubs the judge; nothing there calls a model):

1. **Different, and at least as strong.** The judge may not be the model
   under test. Its tier rank must be at least the tested model's. A
   superseded dated id (e.g. `claude-opus-5`) never judges the current model
   of its own tier. Unknown or unavailable models are refused because their
   strength cannot be established. The check runs against every selected
   cell before the batch starts, and again against the RESOLVED model after
   each run.
2. **Three independent calls; pass on 2 of 3.** Each vote is a fresh
   `claude -p` with no tools (`--tools ""`), no settings, no MCP, no session
   persistence, and an empty working directory. This mirrors
   `claude plugin eval`'s `llm` grader. A vote with no parseable verdict is
   recorded as `null`, never guessed. With fewer than 2 readable votes the
   run's `judge_pass` is `null`, and it is excluded from the judge rate.
3. **Reason before the verdict.** The prompt asks for `REASONING:` first and a
   single `VERDICT: PASS|FAIL` line last. Only the last verdict line counts.
4. **Blind.** The prompt builder takes only the task brief, the rubric, the
   diff and the candidate's final message. It has no parameter for model,
   cell, effort, rep, cost or timing. Self-identification ("as Claude Opus
   ...", model ids, `Co-Authored-By` lines) is scrubbed from the final
   message. In the diff only attribution lines are scrubbed, because code
   may legitimately name models. Two cells that make the same change produce
   byte-identical judge input.
5. **Capped.** Effort is limited to `low|medium|high` (default `medium`). The
   per-vote budget defaults to $0.30 with a hard cap of $1.00, both in Sonnet
   dollars and scaled by the judge's price like every task budget.
   **Temperature is never sent.** Current judge-eligible models (Sonnet 5,
   Opus 5/5.5, Fable 5/5.1) reject sampling parameters with an HTTP 400, and
   `claude -p` exposes none. Setting one is refused rather than silently
   ignored. Variance is controlled by fixed effort and the 3-vote majority.
6. **Logged separately.** The judge fills its own columns: `judge_pass`,
   `judge_votes`, `judge_invalid_votes`, `judge_cost_usd`, `judge_model`,
   `judge_effort`, `judge_rubric_sha256`, `judge_prompt_sha256` and
   `judge_input_truncated`. `summary.md` gets its own "Rubric judge" table.
   Nothing ever reads or writes `pass`. pass@1 is always the hidden test's
   verdict alone.

**Calibration gate: an uncalibrated judge is never used.** A judge is trusted
on a task only after it has scored that task's **known-good** as PASS and
every **known-bad** as FAIL. For a task pack:

- The known-good is the real fix commit's change (parent -> fix).
- The known-bad cases are the unchanged parent, plus any **planted broken
  variants** from `manifest.judgeCalibration.plantedBad`. Each variant is a
  small find/replace applied to the fix. The example pack plants two: one
  scans tracked files only, the other special-cases a filename. Both would
  still pass a lenient hidden test, which is exactly the case the judge
  exists for.
- Every case carries the same neutral final message, so the judge can only
  tell good from bad by the change itself.

The trust record lives in `<data dir>/benchmarks/judge-calibrations.json`
(override with `--judge-calibrations`). It is keyed on the task's content
(pack hash), the rubric, the judge model, the judge effort and the prompt
template version. Change any of them and the judge must be re-calibrated. A
judge that passes everything, or fails everything, is written down as
**untrusted** and is never honoured.

```bash
# 1. calibrate (real judge calls: 3 votes x (1 good + N bad) per rubric task)
node scripts/benchmark.mjs --calibrate-judge --judge-model claude-opus-5-5 \
  --task-pack bench/task-packs/examples/leak-check-gitignore-fix --pack-repo <repo> \
  --tasks leak-check-gitignore-fix
# 2. plan: shows the judge, the judged tasks, and anything that would be refused
node scripts/benchmark.mjs --dry-run --cells sonnet-medium,sonnet-high \
  --judge-model claude-opus-5-5 --task-pack ... --pack-repo <repo> --tasks leak-check-gitignore-fix
# 3. run: refuses to start (exit 2) if any cell is ineligible or any rubric task is uncalibrated
node scripts/benchmark.mjs --cells sonnet-medium,sonnet-high --judge-model claude-opus-5-5 ...
```

Refusals happen before any model call. `runOne()` also refuses on its own
(error code `JUDGE_REFUSED`), and both main loops abort the batch on that code
instead of logging a `pass:false` row. A misconfigured judge can never drag a
cell's pass rate down. Note the consequence: a Fable 5.1 cell has no eligible
judge on this account (Mythos is unavailable), so judge-graded batches stop
at Opus.

## Sandbox isolation

Every run ALWAYS gets its own throwaway working-directory sandbox
(`os.tmpdir()`-based, `rm -rf`'d after) — this is unconditional, not
opt-in. `--setting-sources ""` skips reading this machine's hooks/CLAUDE.md/
plugins/skills (cuts cache-creation tokens roughly 10x on a trivial prompt,
and keeps the benchmarked model from seeing this machine's own stack).

**HOME/USERPROFILE redirection is opt-in (`--isolate-home`), not the
default** — see "Preconditions" above for why: OAuth credentials live under
`HOME`, so redirecting it strips auth for the common case. By default the
spawned `claude` process writes its session transcript under your REAL
`~/.claude/projects/**`, same as any other session (necessary anyway --
that's where "Effort is proven via the transcript" above reads from). Pass
`--isolate-home` (with `ANTHROPIC_API_KEY` set) to redirect `HOME`/
`USERPROFILE` to a fresh throwaway dir per run instead, same mechanism as
before (`bench/runner.mjs`'s `makeFakeHome()`), for when you want the
spawned process to never touch `~/.claude` at all.

`tests/bench-sandbox-isolation.test.mjs` asserts the `--isolate-home` env-
building shape (a fresh fake `HOME`/`USERPROFILE` distinct from the real
ones) and that a task-pack extraction never produces a `.git` directory.
`tests/bench-auth-error.test.mjs` covers the auth-error classification,
abort, and `--isolate-home`-without-a-key refusal from "Preconditions"
above.

## Parallel runs

**Parallel runs are fine now, ACROSS THE WHOLE GRID.** `scripts/benchmark.mjs
--concurrency N` (default 1, fully sequential — the historical, unchanged
behavior) runs up to N (cell, task, rep) runs at once through ONE
`bench/scheduler.mjs` admission-control pool (`buildGlobalRunPlan()` +
`runGlobalPool()`) that spans EVERY requested cell — not one pool per cell.
An earlier version of this script ran one scheduler pool per cell (cells
strictly one after another, however high `--concurrency` was set), which
under-used a multi-pack, multi-cell round; two DIFFERENT cells' runs can now
be active at the same time, bounded by `--concurrency` and the RAM gate,
with resource conflicts (`bench/task-packs/FORMAT.md` "Resource
declarations") respected across cells exactly the same way they always were
within one (`resourcesConflict()` has never known what a "cell" is). This
replaces any earlier "run one at a time" guidance for this benchmark
specifically; the general FOREGROUND/no-monitors rule under "Operating
rules" above still applies unchanged — parallelism here means concurrent
`claude` child processes inside ONE foreground `scripts/benchmark.mjs`
invocation, never a background job.

**`--batch-by cell` opts OUT of the cross-cell pool, on purpose.** It exists
to hand control back to the driving agent BETWEEN cells (a plan-usage
checkpoint), which needs a real cell boundary to stop at — a single global
pool spanning every cell has no such boundary mid-run. So with `--batch-by
cell`, cells still run strictly one after another exactly as before, and
`--concurrency` bounds each cell SEPARATELY, not the whole grid. Drop
`--batch-by cell` (an unattended single invocation covering the whole
`--cells` list) to get the cross-cell pool described above. Once a
`--weekly-ceiling-pct` is reached: WITHOUT `--batch-by cell`, the check runs
once up front (a single invocation's `--weekly-usage-pct` is a static
reading — see its own help text — so there is no later point in one process
where re-checking it could disagree); WITH it, the check still runs at every
cell boundary as before. Either way: once the ceiling is reached (or an
`auth_error`/judge refusal fires), no NEW run is launched, every already
ACTIVE run is still awaited to completion, and the partial `summary.md` is
written from whatever finished.

Three safeguards make this safe rather than merely fast:

1. **Per-run isolation.** Every run already gets its own throwaway sandbox
   (unconditional, see "Sandbox isolation" below). `--concurrency > 1` adds a
   per-run `TMP`/`TEMP`/`TMPDIR` (a sibling of the sandbox, never nested
   inside it) and a `BENCH_PORT_BASE` reserved per concurrency SLOT (not per
   run — a slot is only ever held by one active run), exported to the
   spawned `claude` process's environment and passed as the 4th argument to
   a task's/pack's `setup()`/`score()`. A pack that needs a port but does not
   care which one should bind inside `[BENCH_PORT_BASE, BENCH_PORT_BASE +
   200)` rather than a hardcoded number — see `bench/task-packs/FORMAT.md`
   "Resource declarations" and its two worked fixture packs.
2. **Resource declarations + the scheduler.** `manifest.resources` (or a
   built-in task's own `resources` field) declares `fixedPorts`, `lockFiles`
   and/or `exclusive`. The scheduler (`bench/scheduler.mjs`'s
   `resourcesConflict()`) never co-schedules two runs whose declared
   resources overlap. A pack that declares nothing at all is treated as
   exclusive with OTHER RUNS OF THE SAME PACK (conservative default) — a
   pack that has been reviewed and is genuinely safe to run alongside itself
   opts out with an explicit `"resources": {}`.
3. **Collision handling** — a run that fails for a reason that has nothing to
   do with the model, because it happened to be sharing the machine. See its
   own subsection right below; two DIFFERENT mechanisms exist, chosen by
   WHEN in the run the collision happened.

### Collision handling

A collision never reached a genuine model/task verdict — it failed because
of the machine it happened to share, not because of anything the model did.
Both mechanisms below exclude a CONFIRMED collision from `pass_rate` and
every other stat in `summary.md`/`summary.json` (the same treatment
`auth_error` gets), and both keep every row involved in `results.jsonl` —
nothing is ever silently dropped. (This is a different thing from
`bench/rescore.mjs`'s manual re-score for a wording bug in the test itself —
see "The fairness rule: re-score vs re-run" above. That is an operator
choice, made after auditing a suspected scorer bug; everything below is
fully automatic, made by the scheduler for every run, whether or not
anything is actually wrong with the scorer.)

**Which mechanism applies depends on WHEN the collision happened**, because
that determines whether the model's work is even salvageable:

- **Before the model's work completed** (`setup()` threw) — there is no
  valid sandbox or answer to reuse, so the only option is a **full re-run,
  alone**: `bench/runner.mjs` reads the STRUCTURAL `.code` Node itself
  attaches to the exception (`EADDRINUSE`, a lock file's `EEXIST`/`EBUSY`,
  ...) and hands only that to `bench/scheduler.mjs`'s `classifyCollision()`
  — **never** the model's answer text or the exception's message string (an
  earlier version of this function regexed both, and a model merely
  *describing* an EADDRINUSE bug it had fixed, or a hidden test's own
  assertion message quoting an expected error string, could flip a genuine
  task FAILURE into an excluded `collision: true` row — 2026-09 adversarial
  review finding). The scheduler automatically re-runs it exactly once,
  ALONE (`resources.exclusive` forced `true`), with a FRESH sandbox and a
  FRESH model call. This is also the fallback for a scoring-phase collision
  that happened at `--concurrency 1` with nothing else genuinely active —
  see below.
- **After the model's work completed** (the run reached `score()`) — the
  model's sandbox is already finished and isolated, so re-running the model
  again would be wasteful AND biased (an outcome-based re-run skews toward
  passing on a nondeterministic model, which re-scoring the identical
  artifact cannot). Round 2 finding (2026-09 delta review): a REAL task
  pack's `score()` never actually THROWS even on a genuine collision — its
  hidden test catches its own subprocess's failure and returns a plain
  `{ pass: false, detail }` (the dominant real-world "catch everything"
  style; see the committed example pack's own `hidden-test.mjs`) — so the
  structural-`.code` path above was dead code for every real pack; a genuine
  port/lock collision inside a hidden test's own subprocess just looked like
  an ordinary task failure. Instead: ANY run that FAILS while genuinely
  co-scheduled (`--concurrency > 1` AND something else was actually active
  when this run was admitted — `co_scheduled_run_ids` non-empty) gets its
  row marked `needs_rescore: true`, its sandbox is deliberately NOT torn
  down, and `bench/scheduler.mjs` automatically queues a solo retry
  (`resources.exclusive` forced `true`, same as above) that calls
  `bench/runner.mjs`'s `rescoreOne()` — which re-runs ONLY `task.score()`
  against that SAME retained sandbox, with the SAME saved answer text, and
  **never calls the model**. Both the original row and the `<run_id>::rescore`
  row are kept in `results.jsonl`:
    - **Re-score PASSES** → the original row is excluded (superseded); the
      `::rescore` row (`pass: true`, `collision_rescored: true`, and the
      ORIGINAL failure's own detail carried along under
      `detail.original_failure_detail`) counts in its place. Same `n`,
      corrected verdict, no extra tokens spent.
    - **Re-score FAILS too** → nothing was actually a collision. The
      ORIGINAL failing row counts normally (a real failure is never lost),
      and the redundant `::rescore` row is excluded so the same underlying
      attempt is never double-counted.
    - **No `::rescore` row exists at all** (the cell's own `scheduleRuns()`
      stopped admitting new runs before it got to this one — an
      `auth_error` or a judge refusal; **not** a weekly ceiling, which is
      only ever checked up front or between whole cells, never in the
      middle of one still admitting runs — see "Resuming a batch" below)
      → fails OPEN: the original failure counts normally, and its retained
      sandbox is simply abandoned under the OS temp dir (harmless, if
      untidy — accepted rather than building a whole separate
      abandoned-retry cleanup pass for a rare case).

  `summary.md` reports each outcome by name: `COLLISION` / `SUSPECTED
  COLLISION, NOT CONFIRMED` for the legacy (pre-model) path, `RESCORED` /
  `RE-SCORE CONFIRMED A REAL FAILURE` for this one.

### Sandbox cleanup retry (Windows)

A DIFFERENT kind of machine-sharing problem from collision handling above:
not two runs fighting over the same port/lock, but a single run's OWN
sandbox or per-run temp dir refusing to be *deleted* once the run is
finished. Found live (2026-09-24): 3 reps of the same pack running
concurrently on Windows, and removing a finished run's sandbox directory
threw `EPERM` — a just-exited `claude` child process, an antivirus scanner,
or Windows' own delayed directory-entry accounting can all hold a handle
into (or a stale listing of) a directory for a few hundred milliseconds
after the process that used it has already resolved.

Every removal of a sandbox or per-run temp dir in this bench harness goes
through ONE helper, `bench/tasks/common.mjs`'s `removeDirWithRetry()`:
bounded retry-with-backoff (linear, a few seconds at most, ASYNC so a
backoff wait never blocks the event loop and stalls every OTHER
concurrently scheduled run) on exactly three transient codes —
`EPERM`, `EBUSY`, `ENOTEMPTY` — and a fail-fast (no retry at all) for
anything else. `bench/runner.mjs`'s `runOne()`/`rescoreOne()` call it
through a `removeDirImpl` test seam (same style as `runOne()`'s own
`runClaudeImpl`); every other removal in `bench/` (`bench/rescore.mjs`,
`bench/task-packs/lib.mjs`, `bench/judge.mjs`'s per-vote temp cwd) goes
through this module's synchronous `rmrf()`, which delegates the SAME
retryable-code policy to `fs.rmSync`'s own `maxRetries`/`retryDelay`
(confirmed by the Node.js docs to cover `EBUSY`/`EMFILE`/`ENFILE`/
`ENOTEMPTY`/`EPERM` with a linear backoff) rather than reimplementing a
second retry loop.

**A cleanup failure that survives every retry NEVER changes the run's own
verdict.** `pass`/`collision`/`needs_rescore` are all decided BEFORE cleanup
ever runs — a leaked directory afterward is pure housekeeping, not a signal
about the model or the task. Only the failing directory's bare OS error CODE
(never a path — `results.jsonl` rows are sometimes shared) is recorded on
the row as `cleanup_error`, and the run carries on normally. `rebuildSummary()`
and `bench/estimate.mjs` both ignore this field for every stat they compute —
a `cleanup_error` row counts toward `pass_rate`/medians/local-history exactly
like any other row. When at least one row in a batch carries `cleanup_error`,
`summary.md` prints a single `CLEANUP: N run(s) left a leaked sandbox/temp
dir after cleanup failed even after retrying` line so it is visible without
digging through `results.jsonl`, distinct from `COLLISION`/`RESCORED` above.

**Coverage gap, by design: the model's OWN in-session commands.** Everything
above is about the HARNESS's re-score/re-run machinery around `setup()`/
`score()` — it says nothing about a port collision the MODEL itself hits
while doing its own work inside the sandbox (e.g. running its own test suite
as part of solving the task, before ever reaching the harness's scoring
step). That kind of collision is invisible to `classifyCollision()`/
`needs_rescore` entirely — it just shows up as whatever the model's own
transcript/answer says happened, same as any other in-session hiccup. The
only mitigation is UPSTREAM of collision detection: a pack whose own
commands need a port should bind inside `[BENCH_PORT_BASE, BENCH_PORT_BASE +
200)` (its concurrency SLOT's reserved range — see "Per-run isolation"
above) rather than a hardcoded number, and/or declare `manifest.resources`
accurately, so the SCHEDULER simply never puts two runs in a position to
collide over the same port in the first place. There is no after-the-fact
detection for a collision inside the model's own session.

**Only `scripts/benchmark.mjs` supports `--concurrency`.** `bench/runner.mjs`'s
own direct CLI (`node bench/runner.mjs ...`) is a bare-bones, fully-sequential
single-process loop with no scheduler, no RAM gate, and no pre-run cost
estimate wired up — routing `--concurrency` through it too would mean either
duplicating all three, or silently running everything sequentially anyway
while claiming to respect a concurrency flag it never actually gates. Track B
adversarial review, fix #3: it REFUSES `--concurrency` (and `--per-agent-mb`/
`--weekly-usage-pct`/`--weekly-ceiling-pct`/`--confirm-above-points`/
`--confirm`, which only mean something alongside it) with a message pointing
at `scripts/benchmark.mjs` — the same `bench/runner.mjs` `runOne()` mechanics
underneath, but with the scheduler and both gates already wired up. Always
use `scripts/benchmark.mjs` for anything beyond a single sequential cell.

**Every results.jsonl row records `concurrency` and `co_scheduled_run_ids`.**
Read these before comparing wall time across batches: a run's `duration_ms`
under `--concurrency 4` is not comparable to the same task's `duration_ms`
under `--concurrency 1` — parallel runs slow each other down (shared CPU,
memory, and often shared rate limits). **Token-derived cost (`cost_usd`,
`relative_cost_index`, `plan_usage_index`) stays the primary cost signal**
under concurrency for exactly this reason: per-cell USAGE deltas (see
"Caching" below) do not isolate cleanly when several runs share the machine
at once, but each run's own token counts are unaffected by how many other
runs happened to be active alongside it.

A free-RAM capacity gate (`bench/scheduler.mjs`'s `makeCapacityGate()`,
wrapping `scripts/capacity.mjs`'s existing per-agent-MB budget) is checked
before every launch at `--concurrency > 1` — `--per-agent-mb` overrides the
350MB default. The gate is not consulted at all at the default
`--concurrency 1`, so the historical fully-sequential path's behavior is
unchanged byte-for-byte.

### Resuming a batch

`--resume` (`scripts/benchmark.mjs`) skips only the cells `.batch-state.json`
already marks COMPLETE — a marker written after a cell's `scheduleRuns()`
call fully drains its queue (see "Run every cell in the FOREGROUND" above). A
cell that was interrupted before that point — an `auth_error` or a judge
refusal while a `needs_rescore` solo retry was still QUEUED but never
ADMITTED (the only two things wired into `shouldStop()` mid-cell; a weekly
ceiling is checked only up front or between whole cells — see "Parallel
runs" above — so it can end a BATCH of cells but never leave one single
cell's own queue partially drained) — is not marked complete, so `--resume`
re-runs that WHOLE cell from scratch at the same `--rep-start`.

`run_id` is deterministic (`` `${cellId}__${taskId}__rep${rep}` ``) and
`results.jsonl` is append-only, so that re-run's fresh row lands under the
exact SAME `run_id` as the earlier, abandoned attempt — two rows for one
(cell, task, rep) slot, in the same file. `rebuildSummary()` dedupes this
before anything else: a "complete" row (its own rescue, if any, either
wasn't needed or actually ran to a `::rescore` verdict) beats an ABANDONED
`needs_rescore` row (queued for a solo re-score that never got admitted);
among rows of the same standing, the LAST one in file order — the most
recent attempt — wins. The losing row is dropped entirely (never
fail-open-counted alongside the winner) and `summary.md` prints a `RESUME
DUPLICATE: N row(s)` banner naming the count, so a superseded duplicate is
never silently invisible in the stats. This dedup runs on every
`rebuildSummary()` call, whether or not `--resume` was ever used — a
duplicate `run_id` from any other source is caught the same way.

## Pre-run estimate and confirmation gate

`bench/estimate.mjs` is a SHARED module (ADR 0003 slice 6's own git
fix-commit-mining dry run reuses it) that turns a planned cell x task x rep
grid into: wall time at the chosen `--concurrency`, tokens by class (input,
cache-read, cache-write, output), an API-equivalent $ figure, and a
weekly/5-hour usage-window points range (low-high). `scripts/benchmark.mjs`
prints it both on `--dry-run` (plan only, zero model calls) and before ANY
live run starts.

**Where the numbers come from**, in priority order:

1. **This machine's own local history** — `loadLocalHistory()` scans every
   `results.jsonl` this machine already has under the plugin data dir
   (`dataDir()/benchmarks/*/`, the same root `defaultResultsRoot()` writes
   to), medianed per (task family, model, effort), excluding
   `budget_exhausted`/`auth_error`/`collision` rows.
2. **The shipped seed** (`bench/config/estimate-seed.json`) — medians
   computed once from this operator's own 2026-09-23 pilot/hard/real/
   architecture runs, committed as **numbers and the four generic family
   labels only** (`easy-synthetic`, `hard-synthetic`, `real-bugfix`,
   `architecture`) — no paths, pack, repo or project names, because this
   repo is public. Used only when local history has nothing for that exact
   cell yet (a fresh install).
3. **A rough guess**, clearly labelled `"no local history, rough guess"`,
   when neither has anything for that family at all.

**Weekly-point anchors** (`bench/config/estimate-seed.json`'s
`weeklyPointAnchors`) calibrate points-per-run for each family: 52 easy
runs ≈ 1 point, 52 hard runs ≈ 2 points (64 opus-tier hard runs ≈ 3 points,
used specifically for an Opus cell within `hard-synthetic`), 35 real
bug-fix runs ≈ 4 points, and architecture calibration plus a head-to-head
≈ 3 points. **These are upper bounds** — measured while other sessions were
running concurrently — so `bench/estimate.mjs`'s `low` end is 60% of the
anchor-derived `high` end, a documented round assumption, not a second
measurement. Each cell's own rate is then scaled by its MEASURED `$` cost
ratio to that family's sonnet/medium baseline — deliberately NOT the
unconfirmed "Opus 5.5 = 1.5x Sonnet" in-app-tooltip figure, which is named
(and marked unconfirmed) in the per-cell breakdown whenever an Opus cell's
estimate is shown, but never used to compute it.

**The 5-hour-window figure is `unknown` unless separately measured.** No
`bench/config/estimate-seed.json` ships a `fiveHourPointAnchors` table today
— only `weeklyPointAnchors`. An earlier version of `estimateRun()` printed
the WEEKLY points figure again as the "5-hour-window" number, presented as a
real measurement while actually being an unconfirmed guess dressed up as one
(2026-09 adversarial review finding, Track B fix #4): the weekly and 5-hour
windows meter usage over different reset periods, and nothing established
they move at the same rate. `formatEstimate()` now prints
`5-hour-window points: unknown (no measured 5-hour anchor configured)` until
a real 5-hour anchor is measured and added to the seed under
`fiveHourPointAnchors`, in the same `{ runs, points, note }` shape as
`weeklyPointAnchors` — at which point `pointsPerRun({ ..., anchorsKey:
"fiveHourPointAnchors" })` picks it up automatically.

**The confirmation gate** (`shouldConfirm()`) always requires `--confirm`
before a live run starts when: the estimate is above
`--confirm-above-points` (default 2), any Fable cell is selected, or the
projected weekly usage (`--weekly-usage-pct` + the estimate's high end)
would reach/cross `--weekly-ceiling-pct`. The printed estimate includes a
ready-to-paste cheaper `--cells` list (`suggestCheaperCellSet()`, Fable
dropped first) when narrowing would help. `--dry-run` shows the identical
estimate and gate state but never needs `--confirm` — it runs nothing
regardless.

**Live stop between batches**: with `--batch-by cell` and both
`--weekly-usage-pct`/`--weekly-ceiling-pct` given, the ceiling is checked at
every cell boundary; once reached, the script stops before starting the
next cell, prints `CEILING REACHED` plus the partial `summary.md` path, and
exits 0 (a clean stop, not an error).

**This script cannot read plan usage itself.** `--weekly-usage-pct` is
always supplied by the orchestrating skill/agent, which reads
`mcp__ccd_session_mgmt__get_usage` and passes the reading through. Omit it
and the estimate prints `unknown` for current/projected %, never a guess.

## No visible windows

Every spawn passes `windowsHide: true` (`bench/runner.mjs`'s `runClaude()`)
— a batch of dozens of runs must never pop a console window per run.
`tests/no-visible-windows.test.mjs` (existing, plugin-wide) statically
greps every `execFile`/`spawn` call for this; the bench spawn is covered by
the same check.

## Where results live

**Never in this repo.** Default output is the plugin's data dir
(`dataDir()`, the same resolver every other script here uses) under
`benchmarks/<phase>-<date>/`, holding `results.jsonl`, `summary.json`,
`summary.md`, and `answers/` (saved full answer text + final sandbox tree
per run, for `bench/rescore.mjs`). Override with `--out-dir`. The
2026-09-23 pilot/hard/real result directories referenced throughout
`bench/PROCESS-NOTES.md` were produced under the OLD (pre-plugin-migration)
location and are deliberately NOT carried into this repo — they contain
local paths. Re-running with `scripts/benchmark.mjs` produces fresh results
in the current, repo-safe location.

## Caching

**Separate `claude -p` processes do not reliably share prompt cache, even
with byte-identical content — including `--resume`.** Found during the
`cache-read-weight-2026-09-23` experiment (see below): a harness that shells
out one `claude -p` (or `claude -p --resume <id>`) per measured turn produces
mostly cache MISSES on every turn after the first, because each process is a
fresh instance regardless of whether the prior turn's session id is resumed.
This showed up as an Opus 5.5 arm whose cache reads stayed pinned near the
base-prefix size while cache-creation tokens kept climbing turn over turn —
the anomaly the hit-rate column below exists to catch automatically. The
plugin's own normal interactive sessions and `bench/runner.mjs`'s benchmark
cells are NOT affected — each is already a single process for the whole
task/conversation (91-96% hit rate observed across every 2026-09-23
benchmark cell; see the hard/real task tables in `bench/PROCESS-NOTES.md`).
The gotcha is specific to a harness that deliberately measures multiple
turns via multiple separate process invocations.

**The fix: one persistent process per measured conversation, not one process
per turn.** Run `claude` with `--input-format stream-json --output-format
stream-json --verbose`, feed one user turn at a time on stdin as the process
stays alive, and read each turn's assistant/result events from stdout as
they arrive. A single long-lived process caches the same way an ordinary
interactive session does — confirmed in the same experiment: the
2026-09-23 interactive Opus 5.5 session on this machine hit 99.7%, and
switching the multi-turn probe to this persistent-process technique
recovered normal turn-over-turn cache writes instead of the anomaly above.
Use this technique whenever a benchmark or probe needs to measure something
that only shows up ACROSS turns (e.g. plan-usage weighting, multi-turn cost
curves) — one `claude -p` per turn is fine for `bench/runner.mjs`'s own
single-shot-per-task cells, because there the whole task IS one turn's worth
of one process's lifetime.

**Cache reads vs writes on plan usage (`cache-read-weight-2026-09-23`,
low-to-moderate confidence).** Plan metering of cache READS looks roughly
API-price-proportional: 40.1M Sonnet 5 cache reads moved the 5-hour usage
meter ≈2 points (≈0.05 pts per 1M reads, range 0.025-0.075). ≈3.95M cache
WRITES moved it ≈4 points — per token, writes cost roughly 20x what reads
do, which is the same direction and a similar order of magnitude as the API
list-price ratio (cache write $0.20-0.25/MTok vs cache read $0.20-0.25/MTok
at 5m TTL being 1.25x base input while a read is 0.1x base input, ⇒ roughly
12.5x on list price). **The practical conclusion: cache MISSES (re-writes)
are the expensive event on this plan, not reads** — a harness or workflow
that keeps triggering fresh cache writes (cold starts, the multi-process
gotcha above, TTL expiry) costs far more plan usage than one that reuses a
warm cache across many reads. The Opus 5.5-vs-Sonnet-5 per-read plan-usage
ratio is still UNMEASURED — the Opus arm of this experiment hit the
cross-process caching anomaly above before a clean reading could be taken.
See `config/model-tiers.json`'s `costDrivers.planUsageWeighting` (status
`MEASURED-PARTIAL`) for the same figures kept as machine-readable config,
and the raw run data under this machine's
`benchmarks/cache-read-weight-2026-09-23/` data directory.

## Reporting guidance: cache reads are the headline cost, not output tokens

Across this machine's real sessions, **cache reads are the largest cost
bucket** — not output tokens. Reads = context size x number of requests, so
**turn count and context size drive cost more than output tokens do**. See
`config/model-tiers.json`'s `costDrivers` (rendered into `docs/ROUTING.md` by
`scripts/routing-table.mjs` — do not hand-edit that section) for the full
note, the per-tier cache-read price table, and the open
`cache-read-weight-2026-09-23` question on how a cache read weighs against
the Max plan's usage window (undocumented; being measured).

`bench/runner.mjs`'s `rebuildSummary()` reflects this: `summary.md`/
`summary.json` carry `median_cache_read_tokens`, `cache_hit_rate`,
`median_num_turns`, `median_context_rereads` (`cache_read_tokens /
num_turns`, an estimate of the average context size re-sent every turn), and
`read_share_of_cost` (`cache-read $ / total $` for that cell, using the
tier's cache-hit rate) as **headline columns next to `pass_rate` and
`cost_per_correct`** — not buried in the raw token breakdown further down the
table. `read_share_of_cost` (and, for a row with no turns,
`median_context_rereads`) is `null`/`n/a` when the model's tier has no
measured cache-hit price (e.g. `mythos`, unreachable on this account) — never
a guessed number.

`cache_hit_rate` (`cache_read_tokens / (cache_read_tokens +
cache_creation_tokens + input_tokens)`, medianed like every other per-run
stat) exists specifically to catch the cross-process caching gotcha above:
any cell whose median hit rate falls below 0.85 is marked `cache_anomaly:
true` in `summary.json`, gets a `⚠` next to its `hit_rate` cell in
`summary.md`, and is called out in a `CACHE ANOMALY: check harness` block
above the table. **Check this before trusting a cell's cost numbers** — a low
hit rate usually means the harness failed to share prompt cache across that
run's requests, not that the model or task genuinely re-read more context.

When writing or reading a benchmark report by hand, lead with these four
figures (cache-read tokens, turns, context re-reads, read share of cost)
ahead of pass rate and cost-per-correct commentary, and don't reduce a cell's
story to output-token counts — those consistently under-represent what a
cell actually costs on this machine.

## `claim_honest` experimental status

Mark `claim_honest` **experimental** in any summary you write by hand or
generate: it is a heuristic word-bag classifier, not a verified signal, and
its false-negative rate on hedged/long answers is a known, only partially
fixed limitation (see above). `scripts/benchmark.mjs`'s generated
`summary.md`/`summary.json` label it this way already — do not strip that
label when hand-editing a summary for a report.

## Routing eval suite (`claude plugin eval`)

The model x effort grid measures what a cell can do once it has been chosen.
It does not measure whether a live session actually **consults the routing
guidance and lands on the right cell** when someone asks in plain language.
That is a with-plugin vs without-plugin question, which is exactly what
`claude plugin eval` is built for. It cannot sweep the grid itself (one
pinned `--model` per invocation, no `--effort`), so the two harnesses stay
separate.

`evals/` holds five routing canaries:

| Case | Asks | Passes when |
|---|---|---|
| `debug-routes-opus-low` | model/effort for a root-cause hunt | the final `ROUTE:` line is opus/low (the debug-root-cause trial override) |
| `architecture-routes-opus-high` | model/effort for a new message-bus design | `ROUTE:` is opus/high (the novel-design trial override; the plain grid says opus/max) |
| `trivial-read-not-fable` | model for "read the README, get the license", with a nudge toward Fable | a `ROUTE:` line names haiku/sonnet/opus, and never fable |
| `fable-request-needs-warrant` | what a Fable spawn brief needs | the reply gives the `WARRANT:` line |
| `unrelated-request-no-routing` | an unrelated question (HTTP 418) | it is answered, and the recommend skill does NOT fire |

Graders are free (no judge model): `regex` over the final message, plus
`tool_used: Skill` for the recommend skill. The **two-arm fairness rule**
applies. A "the skill fired" grader can never pass without the plugin, so in
a with/without run it is a plugin-fired indicator only, excluded from the
score in both arms. The one grader that needs to count in both arms, the
negative "must NOT fire" check, carries `arm: both` (with `min: 0`,
`max: 0`), which is fair because the baseline cannot fire it either.

**Found by this suite (2026-09-24):** in an eval sandbox the session has no
shell and cannot read outside its working directory. The recommend skill's
only routes to data (`recommend.mjs` and `docs/ROUTING.md`) were therefore
unreachable, and the architecture canary answered opus/xhigh. The skill now
carries a generated task-type table (`scripts/routing-table.mjs
--sync-skill`, checked by the `routing-doc` audit check and
`tests/routing-table-docs.test.mjs`).

First real runs, `--runs 1`, Sonnet 5 under test, two arms (with/without):

- Before the fix: 4/5 cases passed, mean Δ +0.30, $1.09.
- After the fix: debug and architecture both pass with the plugin. Single
  runs of the other cases varied (a with-arm run skipped the skill once),
  which is why CI should use the default 3 runs and a threshold below 1.0.
  Total $0.77.

**Run it (suggested; never automatic):**

```bash
cd plugins/agent-companion
claude plugin eval . --trust-plugin --json results.json --threshold 0.8 \
  --model claude-sonnet-5 --no-publish --max-cost-usd 3
```

5 cases x 3 runs x 2 arms = 30 short runs, roughly $2-3 at list price. Exit
codes: 0 pass, 1 below threshold or load error, 2 partial (cost ceiling hit
or credential rejected). Pin `--model` so a model rollout is not mistaken for
a plugin regression. Use `--ablation none` to halve the cost when you do not
need Δ, and `--case <name> --runs 1` to iterate on one canary. Leave
`partial: true` results out of any trend. Results land in `evals/results/`,
which is gitignored. The calibration scout suggests this suite after a
routing-relevant signal (see `skills/calibration-scout/SKILL.md`); it never
runs it on its own. As a CI job, it needs a Claude Code install and
`ANTHROPIC_API_KEY`. Keep it opt-in (manual dispatch), not on every push:
each run is a real model call.
