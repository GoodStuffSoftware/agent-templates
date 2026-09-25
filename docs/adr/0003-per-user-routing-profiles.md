# ADR 0003: per-user routing profiles, derived from benchmarking the user's own work

**Status:** Accepted (2026-09-23)
**Date:** 2026-09-23
**Owner:** agent-companion plugin (`plugins/agent-companion/`)

> Numbering follows the convention ADR 0001 set: one file per decision under
> `docs/adr/`, numbered sequentially. ADR 0002 already exists on an unmerged
> branch, so this one is 0003.

## Context

**The operator's direction (2026-09-23).** Public and synthetic benchmarks
saturate because models get better at them. What matters is how a model does
on the user's actual bugs and use cases. The benchmark should run against the
user's own machine and help the user redefine their own routing. Routing
should become a configuration table in agent-companion that each user owns.

**What exists today**, and what this ADR builds on:

- `config/model-tiers.json` (v7) is already "the routing table as data". A
  task routes through a weight x kind grid, floored by consequence
  (`routing`, `taskKinds`, `consequence`). `taskTypes` are named presets over
  (weight, kind, consequence). Ten of the thirteen types now carry an
  `override` block for routing trial v2 (`model`, `effort`, `reason`,
  `evidence`, `trialSince`, `reviewBy`, `trialVersion`, `overridesKindDelta`),
  which is provenance kept by hand.
- `hooks/lib/context.mjs` `resolveExpected()` is the one shared resolver used
  by `scripts/recommend.mjs`, `scripts/evaluate.mjs` and
  `hooks/spawn-guard.mjs`. It returns either the override's (model, effort),
  or the grid resolution through `effortFor()`. An override **returns before
  `effortFor()` runs, so consequence floors are never applied to it.** No
  current override lowers a floor, but nothing enforces that.
- The spawn guard's premium-warrant exemption depends on the route
  (`isPremiumForSpawn`). A model the resolved route names needs no warrant.
  Fable is never exempt, because nothing routes to it.
- `modelTiers()` already merges an operator override file from the state root
  (`<stateRoot>/model-tiers.json`). The merge is shallow: `tiers` merges by
  alias, and every other top-level key is replaced whole. A user who overrides
  one task type this way therefore replaces all of `taskTypes`. The README
  gives the path as `state/model-tiers.json`, but the code reads the state
  root itself.
- There are two storage roots. `dataDir()` (the plugin data directory) is
  deleted when the plugin is uninstalled and holds only disposable caches,
  benchmark results among them. `stateRoot()` (`~/.claude/agent-companion/`)
  survives an uninstall. Its `config/` subdirectory is the documented home for
  choices the user made rather than state the plugin derived.
- The bench: `bench/runner.mjs`, and task packs (`bench/task-packs/FORMAT.md`)
  that pull buggy source out of a local repo with `git show` at run time,
  check fail-at-parent and pass-at-fix, and store refs base64-encoded, with a
  `leakPhrases` tripwire. Caps are price-scaled. In-flight 0.28.0 work adds
  Wilson 95% CIs and `MIN_N_TO_SEPARATE = 5` (`bench/stats.mjs`), per-row
  reproducibility hashes (`reproMetadata()`), a blind, calibrated 2-of-3
  rubric judge (`bench/judge.mjs`), and `claude plugin eval` routing canaries
  (`evals/*-routes-*`) that assert the shipped routing.
- The daily scout (`scripts/detect.mjs`) raises deterministic signals such as
  `routing_trial_review_due`, `new_model_in_lineup`,
  `model_retirement_approaching`, `alias_resolution_below_version_floor` and
  `model_benchmark_suggested`. It suggests; it never runs a benchmark.
- `spawns.jsonl` (`docs/TELEMETRY.md`) records declared weight, kind and
  consequence, fit, and the expected route. It does **not** record the
  declared TYPE, and it stores descriptions only as hashes.

**Evidence gathered 2026-09-23** (from the operator's scratch analyses, not
reproduced here):

- *Synthetic tasks saturate.* Every Sonnet and Opus cell passed every
  hand-built synthetic task, the "hard" redesign included (BENCHMARK.md
  "Ceiling effects"). Only tasks mined from real fix commits separated cells.
- *The taxonomy misses the work.* Of 1,578 spawns over 30 days, 37% fit none
  of the 13 types. The three largest misses are git-plumbing (17%), research
  (9%) and writing-docs (5%). `long-autonomous-run` saw 0 spawns and
  `subagent-worker` saw 2. Classifying the spawns needed the transcripts,
  because the telemetry has no text.
- *A finished-card tracker can be mined, with care.* About 52–57% of finished
  cards could be tied to a commit range. The leak risk is high and concrete:
  acceptance criteria quote the names of held-out tests word for word, cards
  cite decision records, and some briefs open with "read the design memory
  first". Architecture-sized tasks are 5–40x the size of a bug fix, estimated
  at 0.15–0.35 weekly plan points per run.
- *Cache TTL is a weak lever.* Re-simulated under trial v2 routing, a global
  1h TTL comes out at +0.68% and the frontmatter 1h lever at −0.003%. The
  frontmatter lever does not reach teammates at all.
- *Plan metering is only partly known.* Anthropic does not document it. On
  this machine it measured roughly proportional to API price for cache reads
  versus writes. The "Opus 5.5 = 1.5x Sonnet" figure comes from an in-app
  tooltip and has not been confirmed. This plan has no separate Opus weekly
  window, and other plans may differ.

The problem this ADR solves is that routing is one global table, tuned by
hand from one operator's evidence and shipped to everyone. The operator's own
first-hand evidence (for example, "Sonnet gets confused on my architecture
work") has no proper home: it sits in shipped `operatorNote` fields. The
shipped trials encode one plan's economics.

## Decision summary

1. The per-user **routing profile** is a local JSON file at
   `<stateRoot>/config/routing-profile.json`. Rows are keyed by task type and
   carry provenance. The file is never shipped, synced by the plugin, or
   uploaded.
2. One resolver, `resolveRoute()`, uses a fixed layer stack: **profile row >
   shipped trial > shipped grid**. **Floors are applied after whichever layer
   wins.** Four floors are inviolable, and every answer can be explained.
3. **Mining is opt-in, local-only, and allowlisted per repo.** A dry run
   gives an estimate in weekly plan points, and nothing spends until the
   operator approves it.
4. Results become a **proposal and are never applied automatically**. The
   decision rules are explicit and gated on n, and an operator-observed row
   is a first-class source that outranks benchmark proposals.
5. **User-local task types** live in the profile. An unfit cluster above a
   threshold is proposed as a new type, whose first row comes from the grid.
6. **Row states are trial, adopted and retired**, recorded in an append-only
   journal. Rollback is by revision, and a kill switch turns the profile off.
   The new scout signals only suggest.
7. **There is no plugin-level sync and no team layer.** The file travels with
   whatever already replicates `~/.claude`. Teams share through export and
   import, and an import arrives as a proposal.
8. **Trial v2 becomes the operator's first profile.** Shipped defaults keep
   only evidence that anyone can reproduce with the shipped bench.
9. **Delivery comes in nine slices.** The first ships no behaviour change.

## 1. The profile's data model

**Location.**

| Option | Verdict |
|---|---|
| Plugin data dir (`dataDir()`) | **Rejected.** A plugin uninstall deletes it (see `context.mjs`'s storage-root comment). A profile is a record of choices the user made, and losing it on a reinstall is exactly the silent regression this plugin exists to catch. |
| `<stateRoot>/config/routing-profile.json` | **Chosen.** It survives an uninstall, and `configDir()` is already documented as "user-authored, not derived". It is never inside a repository working tree, and it is covered by the same "never in the repo" rule as bench results. |
| Extend the existing `<stateRoot>/model-tiers.json` override | **Rejected** as the home for routing rows. Its shallow merge replaces all of `taskTypes` when one type is overridden, and it has no provenance or state model. It stays as it is, for lineup additions only (a new tier alias). |

Supporting files, all under the state root:
`config/routing-profile.journal.jsonl` (append-only history of applied
changes), `state/routing-proposals/<date>-<id>.{json,md}` (derived,
disposable), `evidence/<run-id>/summary.json` (a small copy of the aggregate
summary rows a row cites, taken when a proposal is applied, because the full
results under `dataDir()` are disposable), and `packs/` for mined task packs
(see §3).

**Schema (v1).** Field names are indicative; the slice that adds the file
fixes them.

```jsonc
{
  "schema": "agent-companion/routing-profile",
  "schemaVersion": 1,            // format version; a reader refuses a higher major
  "revision": 14,                // +1 on every applied change; the journal is keyed on it
  "basedOn": { "tableVersion": 7, "tableUpdated": "2026-09-23" },
  "objective": "api-cost",       // or "plan-usage": which index the decision rules minimise
  "planUsageMultipliers": null,  // the user's OWN measured multipliers, or null (never borrowed)
  "types": {                     // user-local task types (see §5)
    "git-plumbing": { "weight": 2, "kind": "mechanical", "consequence": "elevated",
                      "summary": "...", "origin": "cluster", "createdAt": "..." }
  },
  "rows": {
    "<taskType>": {
      "state": "trial",          // trial | adopted | retired
      "model": "opus",           // a tier ALIAS, never a dated id (the spawn uses the alias)
      "effort": "low",
      "cacheTtl": null,          // "5m" | "1h" | null = no hint; advisory only (see below)
      "source": "benchmark",     // benchmark | operator-observed | telemetry | migrated-trial | imported
      "since": "2026-09-23", "reviewBy": "2026-10-07",
      "waivesFloor": null,       // only "elevated", only when source is operator-observed (see Floors)
      "note": "...",             // local free text; never exported
      "provenance": {
        "runs": ["<run-id>"],    // resolved through evidence/<run-id>/
        "measuredAt": "2026-09-23",
        "n": 12, "packs": 4,     // runs, and DISTINCT tasks, behind the chosen cell for this type
        "pass": { "k": 12, "n": 12, "ci95": [0.76, 1.0] },
        "judge": { "n": 12, "passRate": 0.92, "calibrated": true },   // or null
        "costIndex": 0.90,       // relative_cost_index versus the incumbent cell
        "planUsageIndex": null,  // null unless the user measured their own multipliers
        "benchmarkTier": "user-mined",   // user-mined | shipped-real | synthetic-hard | synthetic-easy
        "resolvedModelIds": { "opus": "claude-opus-5-5" },  // what the alias meant WHEN measured
        "cliVersion": "2.1.xxx", "aliasFloor": "2.1.280",
        "typeDefSha": "<hash of the type's weight/kind/consequence at measurement>"
      }
    }
  }
}
```

**Versioning.** `schemaVersion` versions the format, and a reader that meets
a higher major version ignores the whole profile and raises a signal.
`revision` versions the content. Every apply, set, unset or rollback appends
a journal line of `{revision, at, action, type, before, after, by}`, so any
revision can be rebuilt without git. `basedOn` records which shipped table
the profile was last reconciled against.

**`cacheTtl`** is a hint only. `recommend` prints it when it writes an agent
definition. No guard enforces it, because the lever only reaches subagents
and the measured gain is near zero. It is null unless the user's own
transcript gap data supports a value (see §3).

**`objective`** is new, and it follows from "everyone has their own". An API
user minimises dollars, and a plan user minimises window points. Plan
multipliers are undocumented, and the only one measured is an unconfirmed
tooltip reading. So the default is `api-cost`: the relative cost index is
reproducible, and the measured read/write metering tracked API prices. When
the plan-usage index is known it is shown alongside, but it only decides
anything if the user sets `plan-usage` and has multipliers they measured
themselves.

### Precedence and floors

Resolution order for a TYPE resolved as-is, highest first:

1. **Profile row.** Applies when state is trial or adopted, the row is not
   hard-stale, and `routing_profile` is on.
2. **Shipped trial.** The existing `taskTypes.<t>.override`.
3. **Shipped grid.** `effortFor(weight, kind, consequence)`.

An explicit WEIGHT, KIND or CONSEQUENCE that departs from the type's preset
keeps its current meaning: it answers a different question, skips layers 1
and 2, and goes to the grid. This is unchanged from `taskTypesNote`.

**The floors are then applied to whatever won**, the shipped trial layer
included. That closes today's gap, where an override returns before any
floor runs.

| Floor | May a profile lower it? |
|---|---|
| **F1 Critical consequence.** Model at least opus and effort at least xhigh when the resolved consequence is critical, whether it came from the type preset or a declared `CONSEQUENCE: critical`. | **No, inviolable.** |
| **F2 Fable (and any `premium` tier with rank ≥ fable) is never a destination.** A row may not name it, and a Fable spawn always needs its warrant. | **No, inviolable.** The warrant criterion is "Opus at higher effort was tried and fell short", which a routing row cannot state ahead of time. |
| **F3 Reviewer parity.** The model matches the writer, and effort may exceed the writer's but may not drop below it. | **No, inviolable.** A `code-review` row may only set a minimum effort. It cannot name a model. |
| **F4 Availability and build.** The row's alias must be `available`, not retired, and able to take the named effort. The session build must meet `aliasResolution.minClaudeCodeVersion`. | **No, inviolable.** A row that fails this is hard-stale and skipped (see §2). The spawn guard's build check still runs. |
| **F5 Elevated consequence effort floor (high).** | **Soft.** A proposal can never lower it. The operator can waive it on one row with `waivesFloor: "elevated"`, and only on a row whose source is operator-observed. `explain` always prints the waiver. |

A row that breaks F1–F4 is refused at write time, and it is also ignored at
resolve time in case the file was edited by hand.

**Consequence for the spawn guard.** A profile row that names opus makes
opus exempt from the warrant for that type. That is the intended effect, and
it is the same mechanism trial v2 already uses. Trial v2 already means that
routed opus spawns skip `premium_cap` as well, because `isPremiumForSpawn` is
false for them. See open question 8.

## 2. The resolver change

**One path.** `context.mjs` gains
`resolveRoute({type, weight, kind, consequence, *Explicit, now})`.
`resolveExpected()` becomes a thin wrapper that keeps its current return
shape, including the `trial` field, so no caller breaks.
`recommend`, `evaluate`, `spawn-guard`, `routing-table.mjs`, `detect.mjs` and
the proposal engine all call `resolveRoute()`. Nothing else reads
`taskTypes.*.override` or the profile directly, and a test greps for any
other reader.

`resolveRoute()` returns:

```jsonc
{ "model": "opus", "effort": "low", "cacheTtl": null,
  "layer": "profile",                      // profile | trial | grid
  "profileRevision": 14,
  "source": "benchmark", "state": "trial",
  "provenance": { /* the row's, as stored */ },
  "floorsApplied": [ { "floor": "F1", "raised": "effort low -> xhigh" } ],
  "skipped": [ { "layer": "profile", "reason": "hard-stale: effort 'low' unsupported by haiku" } ],
  "stale": [ { "reason": "measured on claude-opus-5-5; alias now resolves to <new id>" } ],
  "rationale": "..." }
```

**Explainability.** `/ac recommend --type X --explain` and
`/ac routing why X` print the full stack: what each layer would have given,
which layer won and why, which floors fired, and the winning row's
provenance in one line (for example: "profile rev 14, benchmark, 12/12 pass,
CI 76–100%, 4 packs, cost 0.90x, measured 2026-09-23 on Opus 5.5, trial until
2026-10-07"). The spawn guard's notes name the layer too.
`spawns.jsonl` gains three additive fields: `declared_type`, `route_layer`
and `route_profile_rev`. The profile row's content is never logged.

**Staleness.** There are two classes, and the difference matters.

- **Hard-stale: the row is skipped and resolution falls through to the next
  layer.** The alias is unavailable or retired. The effort is no longer
  supported by the model. The task type no longer exists in either the
  shipped table or the profile's `types`. The row breaks an inviolable floor.
  In each case the row cannot be executed as written, so there is no row to
  keep.
- **Soft-stale: the row still applies, and it is flagged in `explain` and by
  the scout.** The row is older than `maxAgeDays` (default 90 for adopted
  rows). Its `reviewBy` has passed. The alias now resolves to a different
  model id than `resolvedModelIds` recorded (a new generation). The
  `aliasResolution.minClaudeCodeVersion` differs from the recorded
  `aliasFloor`. The type's weight, kind or consequence changed since
  measurement (`typeDefSha`). Or `basedOn.tableVersion` is older than the
  shipped table.

  Silently dropping every row on the day a model ships would change the
  routing of every type at once, with nobody deciding it. That is a larger
  and less visible change than keeping measured rows while flagging them.
  This mirrors how shipped trials behave today: `reviewBy` does not expire
  them.

A profile file that fails to parse or validate is ignored as a whole. The
hook fails open to the shipped table and raises the signal
`routing_profile_invalid`. A hook must never throw.

## 3. Mining the user's machine

**Sources, in order of evidence value.**

| Source | What is read | What it yields | Weight as evidence |
|---|---|---|---|
| **S1 Git fix commits with tests** | For each allowlisted repo, a read-only `git log` for commits that touch both test and non-test files and whose message or branch matches fix conventions. Also `git show` / `git archive` at the parent and fix refs. | Candidate task packs, verified fail-at-parent and pass-at-fix. | **Primary.** The only source that can move a row by itself (benchmark tier `user-mined`). |
| **S2 Finished task cards** (any tracker for which an adapter is present, such as an agent work board) | Card title, type, acceptance criteria, and the commit tie (for example a `#N` convention in commit subjects). | Candidate packs for larger integration and design work, where fix commits are rare. | Primary once the card is admitted. **Admission is manual** (see leak controls). |
| **S3 Transcripts** (`~/.claude/projects/**/*.jsonl`) | The description and subagent type of `Agent` tool_use blocks, request timestamps and gaps, and token usage per request. | The task-type mix and unfit clusters (§5), inter-turn gap distributions per type (`cacheTtl` hints), and per-type token shapes for re-pricing. | **Aggregates only.** Never a pack source. No raw text is persisted. |
| **S4 Spawn telemetry** (`spawns.jsonl`, `denials.jsonl`) | Fit, declared type, route layer, and re-spawns of the same `desc_sha` at a higher tier (escalations). | The review of trial rows (§6), and drift in the work mix. | **Observational.** It can flag a row or support promoting a trial row. It can never lower a row by itself. |

**Consent.** A new option, `routing_mining`, defaults to off. Turning it on
is not enough by itself. Each mining run shows a consent screen that lists
the sources it will read, the repos it found, and where outputs go. The
operator ticks a repo allowlist. The choice is saved to
`config/mining-consent.json` as `{sources, repos: [path hash + display
name], at}` and can be revoked with `/ac routing consent --revoke`. S3
transcripts need their own separate tick, because they span every project.
In the pack runner itself, the plugin never reads a repo that is not on the
allowlist.

**Local-only, and what "never uploaded" means.** Mining, packs, proposals,
evidence and the profile stay under the state root. The optional telemetry
export (`telemetry_endpoint`) gets a hard denylist covering `config/`,
`packs/`, `evidence/` and proposals, and it may carry `route_layer` as an
enum and nothing else from this feature. **One boundary has to be stated
plainly:** running a benchmark sends the extracted sandbox to the model
provider, as any Claude Code session does with the user's code. The consent
screen says so. Nothing goes to the plugin's maintainers.

**Repo discovery.** This reuses `scripts/lib/repo-discovery.mjs`
`readClaudeJsonProjectPaths()`, which lists the paths Claude Code has
actually worked in, resolved to git toplevels with worktrees collapsed. That
module filters to public repos for the leak sweep; here there is no
visibility filter. Visibility is recorded as a contamination label instead.
Nothing is included automatically: discovery produces the list the
allowlist is ticked from.

**Leak and contamination controls.** The existing pack discipline is
extended:

- **Tree mode for real repos.** `git archive <parent>` into a sandbox with no
  `.git`, then strip decision records, ADR directories, `CHANGELOG*`, and any
  memory or agent-instruction files under the repo that postdate the parent.
  The held-out tests come from the fix commit and are withheld until grading.
  The existing `files[]` mode stays for small packs.
- **Symptom-only reports, written blind.** A subagent drafts `report.md`
  from the failing test output at the parent. **It never sees the commit
  message, the diff, or the card.** `leakPhrases` are derived automatically
  from word n-grams in the commit subject and body and in the card text, and
  `assertNoLeakedFixLanguage()` runs on every setup.
- **Admission gates.** A pack is admitted only after `verifyPack()`
  (fail-at-parent, pass-at-fix, `.git` absent). Packs from S2 need a human to
  approve them, because card text routinely quotes test names word for word
  and points at design memory. A card whose brief says "read the design
  first" is marked unfit, not rewritten.
- **Contamination label.** A pack is tagged `contamination: high` when its
  repo is public and the fix predates the tested model's training cutoff.
  This needs an optional `trainingCutoff` data field on each tier's
  `resolvesTo`; when that field is absent the label reads `unknown`. High
  demotes the pack's evidence tier from `user-mined` to `shipped-real`
  weight. Before each run, `verifyPack()` is repeated against the current
  checkout, as a freshness check.
- **Storage.** Packs live at `<stateRoot>/packs/<repo-hash>/<id>/`. The local
  repo path is kept in a local index, and never in a manifest that could be
  copied elsewhere. The pack writer refuses any target inside a git working
  tree.

**Cost controls before any run.** `/ac routing bench --dry-run` makes no
model calls. It prints packs x cells x reps, and a **range in weekly plan
points** computed from each pack's size class and the per-run costs measured
on this machine. The seed values are about 0.1 points per run for a
bug-fix-sized pack and 0.15–0.35 for an architecture-sized one; after that,
the user's own history is used. The operator approves one number, a ceiling
in weekly points (default +10, matching the benchmark skill). The run then
proceeds as follows:

1. **Calibration cell first.** One cheap cell runs across all packs, to
   measure the real cost per run.
2. The estimate is recomputed from that measurement and **shown again for
   approval** before the full matrix runs.
3. `--batch-by cell` runs with a `get_usage` reading between batches, and
   stops when the ceiling is reached.

The existing price-scaled `maxBudgetUsd` per run stays as the hard cap on
each process.

## 4. From results to a profile

**A proposal, never an automatic apply.** `propose-profile` reads
`results.jsonl` and `summary.json` (with the 0.28.0 CIs, reproducibility
hashes and judge columns) and the telemetry. It writes
`state/routing-proposals/<id>.{json,md}`. Each type gets one line: the
current route and its layer, the proposed route, the rule that fired, the
evidence (for example "k/n, CI, packs, cost index"), a confidence label, and
any conflict. `/ac routing apply <id> [--rows a,b]` applies the chosen rows
as state `trial`, copies the cited summaries into `evidence/`, and journals
the change. Nothing else writes rows.

**Decision rules.** These compare a candidate cell C with the incumbent I.
The incumbent is the cell the current route resolves to, and it must have
been measured in the same run.

| Rule | When it fires | Proposes |
|---|---|---|
| **R0 Minimum evidence** | Always checked first. It passes only when C and I each have at least `MIN_N_TO_SEPARATE` (5) runs on this type, spread across **at least 2 distinct packs**, from tier `user-mined` or `shipped-real`. | If it fails: "insufficient", together with the n that would be needed. No change. |
| **R1 Cheaper at equal quality** | C costs at least **15%** less on the objective index, **and** has no more failures than I on the hidden tests, **and** its Wilson lower bound is ≥ 0.6, **and** the judge (when calibrated for these packs) does not score C lower, **and** the saving holds on at least 2 packs rather than being driven by one. | C, labelled *moderate*. |
| **R2 Better quality** | The CIs separate (C's low bound is above I's high bound), or I failed at least twice at n ≥ 5 while C had no failures. | C (usually a higher tier), labelled *strong* or *moderate*. Upgrades are the safe direction, so the bar is lower. |
| **R3 Tier restriction** | Evidence comes only from `synthetic-*` tiers. | May support R2 (an upgrade). **Can never support R1** (a downgrade), because synthetic tasks saturate. |
| **R4 Operator row wins** | The current row's source is `operator-observed`. | Shown as "conflicts with operator-observed row (date, note)". It applies only with an explicit `--replace-operator-row`. |
| **R5 No change** | Nothing above fired. | The row stays, and the proposal shows the numbers anyway. |

**Showing uncertainty.** Every number carries its n and its interval, for
example "5/5 pass (95% CI 57–100%), 2 packs". Pass rates are never shown
bare. Labels: *strong* means the CIs separate; *moderate* means R1 or the
failure-count form of R2; *weak* means anything shown without meeting R0.
The markdown groups rows by label, so a weak row cannot be mistaken for a
finding.

**Operator-observed evidence** is a first-class source, not a comment on a
row. For example:
`/ac routing set novel-design --model opus --effort high --because "Sonnet
fails on my architecture work"` writes a row with source
`operator-observed`, the date, the note, and `reviewBy` (default 90 days,
soft). It has no n or CI, and `explain` says so rather than inventing
numbers. A benchmark can challenge it only through R4.

## 5. Task-type taxonomy per user

- **Shipped types stay global.** User-local types live in the profile's
  `types` section, with the same preset shape: weight, kind, consequence,
  summary. `TYPE: <name>` in a brief resolves shipped types first, then local
  ones. The same `resolveRoute()` handles both.
- **From an unfit cluster to a type.** The S3 classifier runs in two stages.
  First come deterministic rules (description verbs, subagent-type suffixes),
  which is the method that classified 1,578 spawns with a residual of 1. Then
  a model pass labels only what the rules left over, and it sees
  descriptions, never full prompts. A cluster that reaches at least **3% of
  spawns, or at least 30 spawns in 30 days, in at least 2 projects** is
  proposed as a local type. Its suggested preset is part of the proposal (for
  example git-plumbing as 2 / mechanical / elevated). A cluster confined to
  one project is shown as "watch", and is not proposed.
- **The first row for a new type** is its grid resolution, marked `source:
  grid-derived` with no evidence. That keeps the floors correct from day one;
  git-plumbing, for instance, gets the elevated effort floor. The type then
  becomes a benchmarking target: packs are tagged with their inferred type,
  so the next run can measure it.
- **Name collisions.** If a later shipped table adds a type with the same
  name, the shipped definition wins. The local definition is flagged
  `shadowed`. The local row is kept as the routing row for the shipped type
  only if the type's hash (`typeDefSha`) matches; otherwise the row goes
  hard-stale and the operator decides.
- **Merge and retire candidates** (types with near-zero use, such as
  `subagent-worker` or `long-autonomous-run` on this machine) are reported,
  never removed. A local profile can hide a shipped type from `recommend`
  listings but cannot delete it.
- **Upstreaming** is out of scope. A recurring local type can inform a
  shipped taxonomy change through the normal contribution path, and only by
  its definition. No data travels with it.

## 6. Lifecycle

**States.** A row starts as *proposed*, which exists only in a proposal file.
Applying it makes it a **trial** row, with `reviewBy` defaulting to 14 days.
Review moves it to **adopted**. When a newer row supersedes it, or the
operator unsets it, it becomes **retired**, which is kept in the journal and
never resolved.

Promotion from trial to adopted is operator-confirmed. The review shows
evidence from S4: the escalation rate and denial rate for the type since
`since`, compared with the period before. A trial row whose escalations rise
is shown with a recommendation to roll it back.

**Rollback.** Three commands cover it. `/ac routing rollback --row <type>`
restores the previous journal entry for that row.
`/ac routing rollback --to <revision>` restores the whole profile to that
revision. `routing_profile: off` is the kill switch: from the next hook
invocation onward, only the shipped table is used, and the file is left
untouched.

**Scout signals.** These are new, deterministic, and suggestion-only, in the
same shape as `model_benchmark_suggested`:

- `routing_profile_stale`: one signal per row, with the soft-stale reason.
- `routing_profile_invalid`: a parse or schema failure, or an unknown major
  version.
- `routing_profile_review_due`: a trial row's `reviewBy` has passed.
- `work_mix_drift`: the distribution of `declared_type` in `spawns.jsonl`
  over the last 30 days differs from the mix recorded at the last proposal by
  a total-variation distance of 0.15 or more, or the share of undeclared or
  unfit spawns rises past the §5 threshold.

The existing `new_model_in_lineup`, `harness_version_changed`,
`alias_resolution_below_version_floor` and `model_retirement_approaching`
signals also suggest a re-run **when the profile has rows affected by them**.
Every one of these routes to `model_benchmark_suggested`. None of them runs
anything.

## 7. Multiple machines and sharing

- **No plugin-level sync.** The profile is a single small file under
  `~/.claude`. A replication tool the user already runs over `~/.claude`
  (ADR 0001 names one) carries it with last-write-wins semantics, which is
  acceptable because every change is journalled.
  `provenance.machine` (a hash of the host) records where a row was measured.
  Routing does not depend on the machine, so rows apply everywhere.
- **Teams.** `/ac routing export` writes rows and types together with their
  numeric provenance. The export strips `note`, run ids, repo references and
  the `machine` hash, then passes a leak scan. `/ac routing import <file>`
  produces a **proposal** in which every row has source `imported:<label>`.
  An imported row is weighted like `shipped-real` evidence, and it never
  outranks a local operator-observed row. There is no team layer in the
  resolver. See open question 7.

## 8. Migration, and what ships as the public default

- **The operator's first profile.** A one-time
  `/ac routing migrate-trial` copies each `taskTypes.*.override` into a
  profile row. Each row gets source `migrated-trial`, state `trial`, the
  original `trialSince` and `reviewBy`, and the override's `evidence` and
  `reason` as provenance (with no n or CI, because the original record has
  none). The `operatorNote` text on integration, large-refactor and
  novel-design ("architecture stays on Opus") becomes an
  `operator-observed` row wherever it decided the model. The acceptance test
  for migration: on the operator's machine, every type resolves to the same
  (model, effort) before and after.
- **Public default.** Each shipped override gains an `evidenceScope` field.
  Its value is `generic` when the evidence can be reproduced with the shipped
  bench (the opus/low rows rest on API cost ratios and pass rates from
  real-task packs), or `operator` when it cannot. A test asserts that the
  shipped table holds no override scoped `operator`. In practice this changes
  one public route: **integration goes back to the grid, sonnet/high**,
  because its model choice rests only on operator observation.
  large-refactor and novel-design keep opus/high: the grid already says opus,
  and the "high, not xhigh/max" effort choice rests on measured token
  scaling. The shipped trial v2 then runs to its own 2026-09-30 review as
  normal. Nothing in this ADR extends it.
- **The legacy `<stateRoot>/model-tiers.json` override** keeps working for
  tier additions. If it contains `taskTypes`, the migration offers to convert
  those into profile rows, and fixes the README path mismatch.

## 9. Delivery plan

Each slice ships on its own, is gated by its own tests, and leaves routing
unchanged unless the slice says otherwise. All tests are hermetic, using
`AGENT_COMPANION_STATE_DIR` / `AGENT_COMPANION_HOME_OVERRIDE`. None of them
calls a model.

| # | Slice | Acceptance criteria | Test strategy |
|---|---|---|---|
| 1 | **`resolveRoute()` with layer stack, explain, and floors after every layer.** No profile yet. | For every shipped type crossed with every declared consequence, `resolveRoute()` gives the same (model, effort) as today's `resolveExpected()`, except where a shipped override would break a floor (there are none today). `recommend --explain` prints the layer. `spawns.jsonl` gains `declared_type`, `route_layer` and `route_profile_rev`. | A golden table test over all types, a test that greps for any other reader of `override`, the existing spawn-guard and evaluate suites, and the routing canaries in `evals/` unchanged. |
| 2 | **Profile file, schema validation, manual rows, journal, kill switch.** `/ac routing set/unset/show/why/rollback`, and the `routing_profile` option. | Rows that break F1–F4 are refused at write and ignored at read. An invalid file fails open and raises a signal. Rollback restores any revision exactly. The hook adds under 5 ms. | Fixture profiles (valid, invalid, higher major, a hand-edited row that breaks a floor), a journal round-trip property test, and a timing test. |
| 3 | **Migration and public default.** `migrate-trial`, `evidenceScope`, integration back to the grid publicly. | On a fixture shaped like the operator's machine, resolution is identical before and after migration. On a clean machine, integration resolves to sonnet/high. The canaries run with an empty state root and assert the shipped table, and a second canary asserts that a profile row wins when present. `leak-check` passes. | A before/after snapshot test, the evals run twice (with and without a profile), and a test that no `operator`-scoped override ships. |
| 4 | **Staleness and scout signals.** | Every soft-stale and hard-stale reason is produced by a fixture. The four new signals fire under a fake clock and stay silent otherwise. | The `nowDate()` fake clock, following the existing `routing-trial` tests. |
| 5 | **Proposal engine over existing results** (no mining). `propose-profile`, `apply`. | Rules R0–R5 each have a fixture that fires and one that does not. Applying writes only the rows chosen, as trial rows, and copies evidence. A proposal never touches the profile. | Synthetic `results.jsonl` rows, reusing the `bench/stats.mjs` tests, plus a check of the proposal JSON against its schema. |
| 6 | **Git fix-commit mining (S1).** Consent, discovery plus allowlist, the candidate finder, tree-mode packs, blind symptom reports, gates, dry-run estimate, the calibration-cell-first flow. | With consent off, the command exits and explains. With consent on, a synthetic git repo created by the test yields a verified pack. No leak phrase appears in the sandbox. The dry run makes zero model calls. Nothing is written under the repo or the plugin directory. | A throwaway git repo fixture, a stubbed report drafter (it asserts it never received the commit message or diff), and a filesystem write audit. |
| 7 | **Transcript and telemetry mining (S3, S4).** Task-mix classifier, unfit clusters becoming local-type proposals, `cacheTtl` hints, escalation rate for review. | Only aggregates are written. A grep of every output finds no fixture description text. A cluster that crosses the thresholds yields a type proposal, and one confined to a single project yields "watch". | Fixture transcripts, and an output grep for the planted strings. |
| 8 | **Tracker adapters (S2).** An adapter interface, and a first adapter that is active only when its tools are present. | Cards need human admission. Cards that point at design documents are marked unfit. The criteria text goes through the leak-phrase derivation. | A stub adapter with fixture cards, including planted test-name quotes. |
| 9 | **Export and import.** | Exports contain no notes, run ids, repo references or machine hash, and pass `leak-check`. An import yields only a proposal. | A round-trip test, and a leak scan of the export. |

Slices 1–5 make the profile useful with manual rows and existing bench
results. Slices 6–8 are the direction the operator asked for, and slice 9 is
optional.

## Consequences

- **Good:** each user's routing reflects their own work, their own plan and
  their own first-hand evidence, and every answer can be explained down to
  the run ids behind it. The floors become stronger than they are today,
  because they now also apply to shipped trials. The public default stops
  carrying one operator's observations.
- **Costs:** a second configuration surface to validate and support. Mining
  spends real plan budget; this is controlled by the dry run, the approved
  ceiling and the calibration cell, but it is never free. A user with a
  profile can no longer compare routing answers with another user without
  running `explain`.
- **Risks:**
  - Small-n rows being trusted too much. This is mitigated by R0, the
    "at least 2 packs" requirement, the confidence labels, and trial
    review.
  - Leaks into mined packs, which are strongest from tracker cards. This is
    mitigated by the blind drafter, derived leak phrases and manual
    admission for S2.
  - Stale rows surviving a model release. This is soft by design and
    surfaced every day by the scout.
- **Reversible:** `routing_profile: off` restores shipped behaviour
  instantly, deleting the file restores it permanently, and the resolver
  refactor in slice 1 does not change behaviour.

## What would have to be true for this to be wrong

- **Users do not declare TYPE.** Profile rows apply only when a brief
  declares its type. If most spawns declare only a weight, or nothing, the
  profile barely routes anything. The `declared_type` telemetry from slice 1
  measures this before slices 5–8 are built.
- **Mined packs do not separate cells any better than synthetic ones did.**
  If that turns out true, the proposal engine will keep reporting R5
  ("no change") and the mining cost buys nothing. The calibration cell in
  slice 6 is the cheap early test.
- **Plan metering turns out to diverge sharply from API price.** If so, the
  `api-cost` default objective would optimise the wrong currency for plan
  users, and the objective default would need to flip.

## Open questions for the operator

1. **Where the profile lives.** The brief said the plugin data directory,
   but that directory is deleted on uninstall. *Recommendation:*
   `<stateRoot>/config/`, as decided above.
   **Decided:** config dir, not plugin data — as recommended.
2. **The elevated effort floor (F5).** Should it be soft, waivable only by an
   operator-observed row, or inviolable? *Recommendation:* soft as designed.
   The operator already routes integration to opus/high, which is at the
   floor, so nothing today depends on waiving it, but a user with cheap
   git-plumbing may want to.
   **Decided:** soft, waivable only by an operator-observed row — as
   recommended.
   *Superseded by 0.29.2: integration's trial now waives F5 on its own row; see plugins/agent-companion/docs/ROUTING-RATIONALE.md.*
3. **A model generation changes under a row.** Keep applying the row and flag
   it (as designed), or fall through to shipped defaults?
   *Recommendation:* keep and flag. A mass fall-through on release day is an
   unreviewed routing change.
   **Decided:** keep the row and flag it — as recommended.
4. **Decision thresholds.** The design uses a 15% cost delta, n ≥ 5, at
   least 2 packs, and a Wilson lower bound ≥ 0.6 for a downgrade.
   *Recommendation:* accept these for v1, keep them in a config block rather
   than in code, and revisit after the first mined run.
   **Decided:** 15% cost / n≥5 / 2 packs / lower-CI ≥ 0.6 for v1, kept in
   config — as recommended.
5. **Integration's public default.** Should it go back to the grid
   (sonnet/high) for public users? *Recommendation:* yes. Your
   "Sonnet struggles here" evidence moves into your profile, where it keeps
   applying to you.
   **Decided:** public default goes back to sonnet/high; the operator's
   observation moves to their profile — as recommended.
6. **The default objective.** `api-cost` or `plan-usage`?
   *Recommendation:* `api-cost`, with the plan-usage index shown alongside,
   until a user has measured their own multipliers. The 1.5x tooltip is
   still unconfirmed.
   **Decided:** `api-cost` by default, with plan usage shown — as
   recommended.
7. **Team profiles.** Import as a proposal only (as designed), or a real
   team layer between the user and the shipped trial? *Recommendation:*
   proposal-only for v1, and add a layer only if a team actually asks.
   **Decided:** team profiles import as a proposal only — as recommended.
8. **`premium_cap` and routed opus.** Rows that name opus already let those
   spawns skip the concurrency cap as well as the warrant.
   *Recommendation:* separate the two. Keep the warrant exemption tied to
   the route, but count the cap by the resolved tier's rank regardless of
   route, so a profile cannot remove the fan-out bound. This would be a
   small separate change, and could land alongside slice 1.
   **Decided:** `premium_cap` is counted by the resolved tier's rank
   regardless of route — as recommended.
9. **Admitting mined packs.** Should a human review every S1 (git) pack's
   symptom report, or only S2 (card) packs? *Recommendation:* only S2
   packs. S1 packs have automated gates (the blind drafter, leak phrases,
   and `verifyPack`), and their reports are shown in the proposal for
   spot checks.
   **Decided:** human review only for task-card (S2) packs — as
   recommended.
10. **Should trial rows expire automatically** at `reviewBy`?
    *Recommendation:* no. That matches shipped trials today, and the scout
    signal forces the review instead.
    **Decided:** trial rows don't auto-expire; the scout forces a review —
    as recommended.
