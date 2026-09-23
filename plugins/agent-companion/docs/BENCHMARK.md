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

## Never park a batch on a background notification

Run cells in the foreground, or poll the results file directly. A
notification tells you a batch finished, not that its output is sane —
always check `results.jsonl`/`summary.md` yourself before treating a batch
as good. `scripts/benchmark.mjs --batch-by cell` writes a
`.batch-state.json` marker and **exits after each cell** for exactly this
reason: it hands control back to the driving agent, which should read
`get_usage` and the just-written `summary.md` before deciding whether to
`--resume`.

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
