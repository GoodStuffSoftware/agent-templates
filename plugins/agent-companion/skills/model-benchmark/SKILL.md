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

## (2) Plan first, always

```bash
node scripts/benchmark.mjs --dry-run --cells all --tasks all --reps 1
```

Zero model calls. Confirms the cell x task x rep count and the exact args
each run would use before anything spends a token. Always run this before a
real batch, and re-run it after changing `--cells`/`--tasks`/`--reps`.

## (3) Budget

The plan's **weekly all-models usage window** is the currency being
managed, not dollars. Default soft ceiling for a re-run: **+10 points**
over the baseline read at the start of the session, unless the operator
gives a different number.

- Read `mcp__ccd_session_mgmt__get_usage` (`session_id: "self"`) **before
  and after every batch** — this cannot run inside `scripts/benchmark.mjs`
  itself (it's an MCP tool available to the orchestrating agent, not to a
  plain Node script).
- Use `--batch-by cell`: it runs ONE cell to completion, writes a
  `.batch-state.json` marker under `--out-dir`, and **exits**. Check
  `get_usage` and the just-written `summary.md`, then `--resume` to
  continue or stop.
- `--max-budget-usd <amount>` is a global per-run ceiling on top of each
  task's own calibrated budget (never looser than the task's own number).
- Readings are integer-rounded and the account may be shared with
  concurrent sessions — treat plan-usage as a coarse "are we near the
  ceiling" check, and the token-derived `cost_usd`/`plan_usage_index` in
  `summary.md` as the primary signal for relative comparisons.

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

Order: **quality first**, then cost per CORRECT result, a **cost index
relative to sonnet/medium** on the same task set, and a **plan-usage index**
(`config/model-tiers.json`'s `planUsageMultipliers`, cited by source and
date — `scripts/benchmark.mjs`'s generated `summary.md`/`summary.json` do
this already; don't strip the citation when hand-editing).

`claim_honest` is EXPERIMENTAL — a word-bag heuristic, unreliable on long,
hedged answers (29-57% on real-history tasks even when fully correct). Read
the actual claim text before treating a low rate as a quality problem.

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
