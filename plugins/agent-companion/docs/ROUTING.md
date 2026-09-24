# Model routing table

_Generated from `config/model-tiers.json` v7 (updated 2026-09-23) by `scripts/routing-table.mjs`. Do not edit by hand — change the config and regenerate._

## Tiers

| Alias | Rank | Premium | Available | Accepts effort | Role |
|---|---|---|---|---|---|
| `haiku` | 1 | no | yes | **none** | reads, searches, single commands |
| `sonnet` | 2 | no | yes | low, medium, high, xhigh, max | bounded edits, short scripts, multi-file work |
| `opus` | 3 | yes | yes | low, medium, high, xhigh, max | architecture, novel debugging |
| `fable` | 4 | yes | yes | low, medium, high, xhigh, max | not a routing tier — an exception requiring a stated warrant |
| `mythos` | 4 | yes | **no** | low, medium, high, xhigh, max | same tier and treatment as fable, but not available on this account — kept so it classifies correctly if access ever changes |

An unrecognised model is treated as **premium** and flagged — it fails toward the expensive assumption until the table has an entry.

## Effort levels

| Level | Rank | Meaning |
|---|---|---|
| `low` | 1 | skip thinking; reads and single commands |
| `medium` | 2 | light reasoning; bounded edits |
| `high` | 3 | the general sweet spot |
| `xhigh` | 4 | recommended start for agentic work on current top tiers |
| `max` | 5 | reserve for genuinely frontier problems; large cost for small gain |

## Effort ladder (cheapest to dearest)

The same routing grid's (model, effort) pairs, ordered, each mapped to a spawnable generic worker definition under `agents/` — namespaced `agent-companion:<agent>` when spawned from outside this repo. Fable stays outside the ladder as a warranted exception, never a routine destination.

| Rung | Model | Effort | Spawn as |
|---|---|---|---|
| 1 | `haiku` | _none_ | `agent-companion:ac-haiku` |
| 2 | `sonnet` | `low` | `agent-companion:ac-sonnet-low` |
| 3 | `sonnet` | `medium` | `agent-companion:ac-sonnet-medium` |
| 4 | `sonnet` | `high` | `agent-companion:ac-sonnet-high` |
| 5 | `sonnet` | `xhigh` | `agent-companion:ac-sonnet-xhigh` |
| 6 | `opus` | `low` | `agent-companion:ac-opus-low` |
| 7 | `opus` | `medium` | `agent-companion:ac-opus-medium` |
| 8 | `opus` | `high` | `agent-companion:ac-opus-high` |
| 9 | `opus` | `xhigh` | `agent-companion:ac-opus-xhigh` |
| 10 | `opus` | `max` | `agent-companion:ac-opus-max` |

## Reference models (older pinned ids — not routable)

Non-routable entries for OLDER full/dated model ids, kept only so an agent definition pinned to one of these has its effort validated against what THAT version actually supports, not the current alias tier's (possibly wider) list.

| Key | Display name | Accepts effort | Note |
|---|---|---|---|
| `opus-5` | Opus 5 | low, medium, high, xhigh, max | Superseded by Opus 5.5. The `opus` alias resolved here on Claude Code < v2.1.280 — kept as a reference entry so an agent definition pinned to the dated id (not the alias) still classifies correctly and its effort is validated against what THIS model actually supports, not the current `opus` tier's list. |
| `fable-5` | Fable 5 | low, medium, high, xhigh, max | Superseded by Fable 5.1. Cache-hit pricing is the 0.1x rate, NOT Fable 5.1's 0.025x rate — do not reuse 5.1's cache economics for a definition pinned to this id. |
| `opus-4-8` | Opus 4.8 | low, medium, high, xhigh, max | Not validated by this table's effort checks for the thinking-omission hazard (agent definition frontmatter here carries no `thinking` field to check) - flagged as a known gap in the operator's global-doctrine patch, which is kept outside this repo, not silently assumed safe. |
| `opus-4-7` | Opus 4.7 | low, medium, high, xhigh, max | Same thinking-omission caveat as opus-4-8. |
| `opus-4-6` | Opus 4.6 | low, medium, high, max | NO xhigh — this generation stops at max/high/medium/low. An agent definition pinned to this id with effort: xhigh is invalid on this model, not just 'more than needed'; validated via referenceModels, not the current opus tier's effort list. |
| `sonnet-4-6` | Sonnet 4.6 | low, medium, high, max | NO xhigh, same as opus-4-6 — validated against this list, not the current sonnet tier's (which does have xhigh). |

## Weight → model (base routing)

| Weight | Model | Effort | Task shape |
|---|---|---|---|
| 1 | `haiku` | _none_ | trivial — single lookup, read, echo |
| 2 | `haiku` | _none_ | simple — one-step transform or search |
| 3 | `sonnet` | `medium` | moderate — bounded multi-step, parse structured output |
| 4 | `sonnet` | `high` | complex — multi-file, cross-referencing, integration |
| 5 | `opus` | `xhigh` | deep — architecture, novel reasoning, migrations |

## Weight × kind → effort (the decision grid)

Weight picks the **model** (capability needed). Kind adjusts the **effort** (how much the answer benefits from search). They are orthogonal.

| Weight | mechanical | bounded | diagnostic | novel-design |
|---|---|---|---|---|
| 1 | `haiku` | `haiku` | `haiku` | `haiku` |
| 2 | `haiku` | `haiku` | `haiku` | `haiku` |
| 3 | `sonnet/low` | `sonnet/medium` | `sonnet/high` | `sonnet/xhigh` |
| 4 | `sonnet/medium` | `sonnet/high` | `sonnet/xhigh` | `sonnet/max` |
| 5 | `opus/high` | `opus/xhigh` | `opus/max` | `opus/max` |

| Kind | Δ effort | Examples |
|---|---|---|
| `mechanical` | -1 | a routing table, a rename, a config edit, reformatting, applying a known migration |
| `bounded` | 0 | a feature against a clear spec, a test for known behaviour, a scoped refactor |
| `diagnostic` | +1 | root-causing a failure, a flaky test, an unexplained regression, an adversarial review |
| `novel-design` | +2 | a message bus, a protocol, concurrency or sync/merge logic, a data migration, a security boundary |

## Consequence floors (applied after kind; cannot be undercut)

| Level | Effort floor | Model floor | Triggers |
|---|---|---|---|
| `routine` | — | — | — |
| `elevated` | `high` | — | shared config, build or release pipeline, anything other agents depend on, public API shape |
| `critical` | `xhigh` | `opus` | production data writes, migrations, destructive operations, security or permission boundaries, auth, billing or money, secrets and credentials |

Example: a one-line production migration is `mechanical` by kind (effort down) but `critical` by consequence (floor up) — the floor wins.

## Reviewer parity

- Model must match the writer it gates: **yes**
- Effort may exceed the writer's: **yes**
- Effort may fall below the writer's: **no**

That parity match is then floored, same as any other route (operator-decided 2026-09-24, see resolveRoute() in hooks/lib/context.mjs): a **critical** review is never sized below `opus`/`xhigh` (F1), never routed to fable — capped to the best available tier that is not one, which still demands its own WARRANT (F2) — and refused outright for a writer model outside the tier table, or unavailable with no staged replacement (F4). A per-user routing profile row for a parity type may only raise the resulting minimum effort further; it can never name a model.

## Task types → routing (the task model list)

Each named task type is a preset over (weight, kind, consequence) and resolves through the same grid. `parity` weight = match the writer being reviewed; `inherit` consequence = take the change's consequence. **`--type` is the preferred input over raw `--weight`/`--kind`** — a named type is the only place a measured routing-trial override (below) attaches; resolving by weight/kind alone always uses the plain grid.

| Task type | Weight | Kind | Consequence | Resolves to | What it is |
|---|---|---|---|---|---|
| `explore` | 1 | `mechanical` | `routine` | `opus/low` _(trial override)_ | read-only search: where is X, what touches Y, does Z exist |
| `mechanical-edit` | 2 | `mechanical` | `routine` | `opus/low` _(trial override)_ | rename, config edit, reformat, apply a known migration recipe |
| `bounded-feature` | 3 | `bounded` | `routine` | `opus/low` _(trial override)_ | a feature against a clear spec, 1-3 files, known shape |
| `integration` | 4 | `bounded` | `elevated` | `opus/high` _(trial override)_ | multi-file, cross-referencing, touches shared config or things other agents depend on |
| `debug-root-cause` | 4 | `diagnostic` | `routine` | `opus/low` _(trial override)_ | a specific failure, unexplained regression, flaky test - the answer exists and must be found |
| `large-refactor` | 5 | `bounded` | `elevated` | `opus/high` _(trial override)_ | large-scale refactor across a module or subsystem; the target shape is known, the surface is wide |
| `novel-design` | 5 | `novel-design` | `elevated` | `opus/high` _(trial override)_ | a protocol, concurrency or sync/merge logic, a message bus, a new abstraction with no known-good shape |
| `critical-change` | 4 | `bounded` | `critical` | `opus/xhigh` | production data, migrations, destructive ops, auth, billing, secrets - regardless of size |
| `code-review` | parity | `diagnostic` | `inherit` | _writer's model, floored to opus/xhigh if critical and never fable; effort ≥ writer_ | adversarial review of a diff; sized to the writer it gates |
| `long-autonomous-run` | 5 | `bounded` | `elevated` | `opus/xhigh` | an agent session expected to run for hours with minimal supervision |
| `subagent-worker` | 2 | `mechanical` | `routine` | `opus/low` _(trial override)_ | a delegated worker doing a bounded, well-specified piece of a larger task |
| `verify` | 1 | `mechanical` | `routine` | `opus/low` _(trial override)_ | confirm a claim against reality: read a file, check a value, take a screenshot, does X exist/match Y — reports back, changes nothing |
| `operate` | 3 | `bounded` | `routine` | `opus/low` _(trial override)_ | execute an ordered procedure or change a live system — even when every individual step looks trivial in isolation |

<details><summary>Provenance per task type</summary>

- **`explore`** — OFFICIAL choosing-a-model: Haiku for subagent tasks. COMMUNITY consensus: haiku, cost-driven.
- **`mechanical-edit`** — COMMUNITY (Wavect): avoid Fable for tiny fixes, CRUD, renaming, formatting, boilerplate.
- **`bounded-feature`** — OFFICIAL choosing-a-model: Sonnet for everyday code generation and agentic tool use. COMMUNITY: Sonnet 5 delivers near-Opus coding at Sonnet price; escalate to Opus when the spec is incomplete or moves mid-run.
- **`integration`** — Our weight scale. Consequence elevated because shared surfaces are where a mistake costs other people time. UNBENCHMARKED by the 2026-09-23 effort-grid trial itself, but see operatorNote and the ROUTING TRIAL v2 override below.
- **`debug-root-cause`** — COMMUNITY: Sonnet 5 praised first-hand for tracing brownfield failures to root causes rather than patching symptoms. Escalate to Opus when evidence conflicts or constraints are hidden.
- **`large-refactor`** — OFFICIAL choosing-a-model: Opus for large-scale refactoring and complex systems engineering. UNBENCHMARKED by the 2026-09-23 effort-grid trial itself, but see operatorNote and the ROUTING TRIAL v2 override below.
- **`novel-design`** — Our kind axis. OFFICIAL: Opus for complex systems engineering. Fable only with a warrant - and per the procedural-discipline finding, first try a brief that carries the verification checklist on Opus. UNBENCHMARKED by the 2026-09-23 effort-grid trial itself, but see operatorNote and the ROUTING TRIAL v2 override below.
- **`critical-change`** — Consequence axis (arXiv 2606.04402: consequence is orthogonal to difficulty). The floor raises even a one-line change to opus/xhigh. UNBENCHMARKED — not covered by the 2026-09-23 effort-grid trial; the critical floor (opus/xhigh) stays regardless.
- **`code-review`** — Our reviewer-parity rule. BENCHMARK (CodeRabbit, semi-vendor): review precision tops out ~37% across every model tested and no model wins both precision and recall - so tier choice does not make review sufficient; adversarial framing and a human gate on critical changes still matter. CAVEAT under calibration: one first-hand report (Wavect) found HIGH effort slower AND lower-recall than LOW on review. See calibration. UNBENCHMARKED by the 2026-09-23 effort-grid trial (parity-sized, not a fixed model/effort) — routing unchanged.
- **`long-autonomous-run`** — OFFICIAL choosing-a-model: Fable for agent sessions that run for hours. COMMUNITY, first-hand (TheNeuronDaily): management overhead from unrequested inferences grows with autonomy. Warrant required for Fable; Opus/xhigh is the default. UNBENCHMARKED — not covered by the 2026-09-23 effort-grid trial; routing unchanged.
- **`subagent-worker`** — OFFICIAL choosing-a-model: Haiku for subagent tasks. Raise the weight if the piece is not actually bounded.
- **`verify`** — Calibration finding 'haiku validates, it does not OPERATE' (team-orchestration skill; a dated CONTRIBUTIONS_INBOX entry). The defining trait is that nothing changes: the task ends when the answer is read back, not when a step is performed.
- **`operate`** — Calibration finding 'haiku validates, it does not OPERATE' (team-orchestration skill; a dated CONTRIBUTIONS_INBOX entry). A sequence of trivial-looking steps against a live system is not a verify task: ordering mistakes, partial failures, and side effects compound in a way a single read-only check cannot, so this floors at sonnet even though no one step looks hard. Raise weight/consequence further when a step is itself destructive, production-facing, or irreversible (critical-change already covers that).

</details>

### Routing trial (benchmark overrides, not the plain grid)

These task types resolve to a benchmark-backed (model, effort) pair that supersedes their own weight/kind/consequence grid resolution for the trial window below. The override applies only when the type is used as-is — passing an explicit `--weight`/`--kind`/`--consequence` that departs from the type's preset falls back to the plain grid (one equal to the preset restates the type and keeps the trial). Every OTHER task type in the list above is **UNBENCHMARKED** by this trial and keeps its grid-resolved routing unchanged.

| Task type | Trial | Grid would say | Since | Review by | Evidence |
|---|---|---|---|---|---|
| `explore` | `opus/low` | `haiku` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo); cache-read-weight-2026-09-23 for the read-cost figure (2026-09-23) |
| `mechanical-edit` | `opus/low` | `haiku` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo); cache-read-weight-2026-09-23 for the read-cost figure (2026-09-23) |
| `bounded-feature` | `opus/low` | `sonnet/medium` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo) (2026-09-23) |
| `integration` | `opus/high` | `sonnet/high` | 2026-09-23 | 2026-09-30 | operator first-hand observation on integration/multi-file technical work (kept outside this repo) (2026-09-23) |
| `debug-root-cause` | `opus/low _(overrides kind delta)_` | `sonnet/xhigh` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo) (2026-09-23) |
| `large-refactor` | `opus/high` | `opus/xhigh` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (xhigh-vs-low token scaling); operator first-hand observation on Opus vs Sonnet for architecture work (kept outside this repo) (2026-09-23) |
| `novel-design` | `opus/high _(overrides kind delta)_` | `opus/max` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (xhigh-vs-low token scaling); operator first-hand observation on Opus vs Sonnet for architecture work (kept outside this repo) (2026-09-23) |
| `subagent-worker` | `opus/low` | `haiku` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo); cache-read-weight-2026-09-23 for the read-cost figure (2026-09-23) |
| `verify` | `opus/low` | `haiku` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo); cache-read-weight-2026-09-23 for the read-cost figure (2026-09-23) |
| `operate` | `opus/low` | `sonnet/medium` | 2026-09-23 | 2026-09-30 | operator benchmark, bench/effort-grid results dirs (kept outside this repo); cache-read-weight-2026-09-23 for the read-cost figure (2026-09-23) |

- **`explore`** — ROUTING TRIAL v2 (operator-endorsed, supersedes v1's sonnet/low): Opus 5.5 low measured cheaper than every Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low 0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly half the turns, and equally correct; cache reads cost about the API ratio. This plan has no separate Opus weekly window (get_usage shows only 5-hour, weekly all-models, and weekly Fable), so there is no separate-bucket reason to prefer Sonnet here. v1 finding (Sonnet 5 passed every synthetic task at every effort, Haiku cost roughly 2x Sonnet per task and was the only model to fail) still explains why this is not haiku.
- **`mechanical-edit`** — ROUTING TRIAL v2 (operator-endorsed, supersedes v1's sonnet/low): Opus 5.5 low measured cheaper than every Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low 0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly half the turns, and equally correct; cache reads cost about the API ratio. This plan has no separate Opus weekly window, so there is no separate-bucket reason to prefer Sonnet here. v1 finding (Sonnet 5 passed every synthetic task at every effort, Haiku cost roughly 2x Sonnet per task and was the only model to fail) still explains why this is not haiku.
- **`bounded-feature`** — Benchmark evidence: Opus 5.5 at low/medium/xhigh effort all scored 7/7 on real bug fixes, but medium used roughly 2x low's tokens (~1.56x plan usage) and xhigh ~3.1x, for no quality gain over low. Where medium cost more than low with no quality gain, don't use medium.
- **`integration`** — ROUTING TRIAL v2 (operator-endorsed): unmeasured by benchmark, but operator first-hand evidence says Sonnet struggles on some of the operator's technical, multi-file work (operator-observed 2026-09-23) -- do not route this off Opus on benchmark evidence alone. opus/high matches the existing weight-4 elevated consequence floor (effortFloor: high), so this changes the MODEL (sonnet -> opus), not the effort.
- **`debug-root-cause`** — EXPLICIT override of the diagnostic kind's normal +1 effort bump (which would otherwise push this to medium), not a silent kind change: the operator benchmark showed Opus 5.5 low/medium/xhigh all 7/7 on real bug fixes, with medium costing ~1.56x plan usage and xhigh ~3.1x for no quality gain over low. The operator directive was explicit: no medium.
- **`large-refactor`** — ROUTING TRIAL v2 (operator-endorsed): the plain grid resolves this to opus/xhigh (weight 5, bounded kind, no delta). Real-task benchmark data (bounded-feature/debug-root-cause) showed xhigh costing roughly 3.1x low's tokens for no quality gain over low, and effort scaling on large-refactor work specifically is itself unmeasured -- opus/high is the trial's middle ground rather than paying for xhigh on an unverified assumption. Model stays opus: architecture and deep technical work stay on Opus (operator-observed 2026-09-23) -- do not route architecture off Opus on benchmark evidence alone.
- **`novel-design`** — ROUTING TRIAL v2 (operator-endorsed): the plain grid would otherwise resolve this to opus/max (weight 5's xhigh, pushed up two ranks by the novel-design kind's +2 delta, clamped at max) -- not a silent kind change, an explicit decision not to pay for that escalation. Real-task benchmark data (bounded-feature/debug-root-cause) showed xhigh costing roughly 3.1x low's tokens for no quality gain over low, and effort scaling specifically on novel-design/architecture work is itself unmeasured, so opus/high is the trial's middle ground. Model stays opus: architecture and deep technical work stay on Opus (operator-observed 2026-09-23) -- do not route architecture off Opus on benchmark evidence alone.
- **`subagent-worker`** — ROUTING TRIAL v2 (operator-endorsed, supersedes v1's sonnet/low): Opus 5.5 low measured cheaper than every Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low 0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly half the turns, and equally correct; cache reads cost about the API ratio. This plan has no separate Opus weekly window, so there is no separate-bucket reason to prefer Sonnet here. v1 finding (Sonnet 5 passed every synthetic task at every effort, Haiku cost roughly 2x Sonnet per task and was the only model to fail) still explains why this is not haiku.
- **`verify`** — ROUTING TRIAL v2 (operator-endorsed, supersedes v1's sonnet/low): Opus 5.5 low measured cheaper than every Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low 0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly half the turns, and equally correct; cache reads cost about the API ratio. This plan has no separate Opus weekly window, so there is no separate-bucket reason to prefer Sonnet here. v1 finding (Sonnet 5 passed every synthetic task at every effort, Haiku cost roughly 2x Sonnet per task and was the only model to fail) still explains why this is not haiku.
- **`operate`** — Was weight 3 sonnet/medium, then v1 sonnet/low. ROUTING TRIAL v2 (operator-endorsed): Opus 5.5 low measured cheaper than every Sonnet setting on easy and hard tasks (API 0.90x/0.75x vs Sonnet low 0.99x/0.89x), about even on plan usage for real fixes, faster, with roughly half the turns, and equally correct; cache reads cost about the API ratio. This plan has no separate Opus weekly window, so there is no separate-bucket reason to prefer Sonnet here. v1's own finding still applies: at low effort, quality did not improve over the more expensive sonnet/medium, so no reason to pay for medium.

## Cost drivers

Across this machine's real sessions, CACHE READS are the largest cost bucket -- not output tokens. Reads = context size x number of requests, so TURN COUNT and CONTEXT SIZE drive cost more than output tokens do. The two levers: fewer turns per task (less back-and-forth, more done per tool-call batch), and a smaller stable context (less to re-read on every turn). Cache TTL (`cacheTtl` above) only decides re-read vs re-write pricing AFTER an idle gap -- it does not change how many reads happen or how large each one is, so raising TTL is not a substitute for cutting turns or context.

| Tier | Cache-read price ($/MTok) |
|---|---|
| `haiku` | $0.1 |
| `sonnet` | $0.2 |
| `opus` | $0.2 |
| `fable` | $0.25 |

Cache-hit ($/MTok) rate per tier, read from tiers.*.resolvesTo.pricing.cacheHitPerMTok above -- kept here too as a flat lookup for a reader who wants the number without walking the tier objects. Opus 5.5 and Sonnet 5 read at the SAME $0.20/MTok, which is why Opus 5.5 came close to Sonnet on read-heavy real tasks while using roughly 35% fewer turns (fewer re-reads at the same per-read price).

**Plan-usage weighting of cache reads: MEASURED-PARTIAL.** How cache reads weigh against the Max plan's usage window is not published anywhere Anthropic states it, unlike the API dollar rate above. Plan metering of cache READS is roughly API-price-proportional: 40.1M Sonnet 5 cache reads moved the 5-hour usage meter ~2 points (~0.05 pts per 1M reads, range 0.025-0.075). ~3.95M cache WRITES moved it ~4 points, so per token, writes cost roughly 20x what reads do -- the same direction and order of magnitude as the API list-price ratio (~12.5x). Conclusion: cache MISSES (re-writes) are the expensive event on this plan, not reads. The Opus 5.5 vs Sonnet 5 per-read plan-usage ratio is UNMEASURED -- the Opus arm of this experiment hit a harness caching anomaly (separate claude -p processes do not reliably share prompt cache even with byte-identical content, including --resume; see docs/BENCHMARK.md "Caching") before a clean reading could be taken. Do not extrapolate an Opus read weight from the Sonnet figure. (experiment: `cache-read-weight-2026-09-23`)

## What is actually known about `fable`

- OFFICIAL (whats-new-fable-5-1): prefers whole-file rewrites, fewer progress updates, less parallel tool batching. Whole-file rewrites make it a poor fit for scoped or mechanical edits even when a warrant exists.
- OFFICIAL (whats-new-fable-5-1): same $10/$50 as Fable 5; cache reads at a quarter of the cost ($0.25/MTok, re-verified live 2026-09-23). A long session with a stable prefix is cheaper than sticker price implies - verify the number before relying on it.
- COMMUNITY, first-hand (Every.to, TheNeuronDaily): "sticks to what you tell it" is CONTESTED. Reports of overshooting explicit limits (1,000 words -> 1,288; 8-12 quotes -> 43, 5 fabricated) and unprompted style decisions. The friction is over-inference, not literalism. Do not route on an adherence claim.
- COMMUNITY, first-hand (dev.to): the gap over Opus/Sonnet is procedural discipline, not intelligence - stating a hypothesis before editing, labelling claims VERIFIED/REASONED/ASSUMED. A brief that carries that checklist closes most of the gap on a cheaper tier, which is exactly what the warrant is meant to make you ask.

## Open calibration questions

Real findings not settled enough to encode as rules. Each names the measurement that would settle it — telemetry answers these, not opinion.

### `reviewer-effort-direction` — open

**Question:** Does a reviewer at HIGHER effort than the writer catch more, or less?

**Tension:** Our rule says effort may exceed and must not drop. One first-hand report (Wavect) found high-effort review slower and lower-recall than low. Willison observed that past high, Fable drafts the deliverable in thinking and rewrites it - double cost, no gain.

**Measure:** From telemetry: for reviews, compare findings-per-review and post-merge defect rate by reviewer effort relative to writer effort. Needs reviewers to report findings structurally.

### `fable-cache-economics` — open

**Question:** Does Fable 5.1 cache-read pricing make long stable-prefix sessions competitive with Opus?

**Tension:** Official: cache reads at a quarter of the cost ($0.25/MTok). Our measured cache hit ratio is ~96%. Fable is now 2.5x Opus on sticker price (was 2x, before Opus 5.5 dropped to $4/$20) - the cache discount has a wider gap to close than it did. At max effort output tokens run ~1.7x Fable 5 - the discount may be eaten by verbosity.

**Measure:** From telemetry: per-session cost by model with cache-read share. Compare fable vs opus on sessions of similar turn count.

### `sonnet-vs-opus-at-weight-5` — open

**Question:** Is Sonnet 5 sufficient for some weight-5 work?

**Tension:** Vendor benchmarks put Sonnet 5 above Opus 5 on Terminal-Bench 2.1 and some agentic evals at ~40% less cost. Vendor-run, and an outlier.

**Measure:** From telemetry: escalation rate (a Sonnet spawn re-run at Opus) by task type. If weight-5 bounded work rarely escalates from Sonnet, lower the base.

### `procedural-checklist-vs-tier` — open

**Question:** Does a verification checklist in the brief substitute for a higher tier?

**Tension:** First-hand: teaching Opus/Sonnet the Fable-style checklist (hypothesis before edit, VERIFIED/REASONED/ASSUMED labels) closes most of the gap. If true, many Fable warrants should be declined in favour of a better brief.

**Measure:** From telemetry: warrant acceptance rate, and outcome of warranted Fable spawns vs Opus spawns with a checklist brief on the same task type.

> ⚠ `haiku` retires no sooner than **2026-10-15**. Anthropic: Haiku 4.5 retires no sooner than 2026-10-15. The entire weight 1-2 tier rides on this alias. No successor Haiku has been announced (checked live 2026-09-23). Decide the replacement BEFORE the alias resolves to nothing — the scout raises model_retirement_approaching inside the warning window (now 30 days, not just fixed milestones — see scripts/detect.mjs).
> Staged replacement: **sonnet/low** — routing rows on `haiku` switch to it automatically from 2026-10-15. Pre-staged 2026-09-04, re-verified 2026-09-23: still no successor Haiku announced. Sonnet 5 at low effort is the cheapest available tier that takes weight 1-2 work, at roughly 2x Haiku per token (Sonnet 5 $2/$10 vs Haiku 4.5 $1/$5). When a new Haiku ships, add its tier and point this at it - the switch is data, not code. This IS the weight 1-2 fallback if haiku disappears before a successor ships.

