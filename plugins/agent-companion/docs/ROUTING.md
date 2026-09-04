# Model routing table

_Generated from `config/model-tiers.json` v3 (updated 2026-08-30) by `scripts/routing-table.mjs`. Do not edit by hand — change the config and regenerate._

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

## Task types → routing (the task model list)

Each named task type is a preset over (weight, kind, consequence) and resolves through the same grid. `parity` weight = match the writer being reviewed; `inherit` consequence = take the change's consequence.

| Task type | Weight | Kind | Consequence | Resolves to | What it is |
|---|---|---|---|---|---|
| `explore` | 1 | `mechanical` | `routine` | `haiku` | read-only search: where is X, what touches Y, does Z exist |
| `mechanical-edit` | 2 | `mechanical` | `routine` | `haiku` | rename, config edit, reformat, apply a known migration recipe |
| `bounded-feature` | 3 | `bounded` | `routine` | `sonnet/medium` | a feature against a clear spec, 1-3 files, known shape |
| `integration` | 4 | `bounded` | `elevated` | `sonnet/high` | multi-file, cross-referencing, touches shared config or things other agents depend on |
| `debug-root-cause` | 4 | `diagnostic` | `routine` | `sonnet/xhigh` | a specific failure, unexplained regression, flaky test - the answer exists and must be found |
| `large-refactor` | 5 | `bounded` | `elevated` | `opus/xhigh` | large-scale refactor across a module or subsystem; the target shape is known, the surface is wide |
| `novel-design` | 5 | `novel-design` | `elevated` | `opus/max` | a protocol, concurrency or sync/merge logic, a message bus, a new abstraction with no known-good shape |
| `critical-change` | 4 | `bounded` | `critical` | `opus/xhigh` | production data, migrations, destructive ops, auth, billing, secrets - regardless of size |
| `code-review` | parity | `diagnostic` | `inherit` | _writer's model; effort ≥ writer_ | adversarial review of a diff; sized to the writer it gates |
| `long-autonomous-run` | 5 | `bounded` | `elevated` | `opus/xhigh` | an agent session expected to run for hours with minimal supervision |
| `subagent-worker` | 2 | `mechanical` | `routine` | `haiku` | a delegated worker doing a bounded, well-specified piece of a larger task |

<details><summary>Provenance per task type</summary>

- **`explore`** — OFFICIAL choosing-a-model: Haiku for subagent tasks. COMMUNITY consensus: haiku, cost-driven.
- **`mechanical-edit`** — COMMUNITY (Wavect): avoid Fable for tiny fixes, CRUD, renaming, formatting, boilerplate.
- **`bounded-feature`** — OFFICIAL choosing-a-model: Sonnet for everyday code generation and agentic tool use. COMMUNITY: Sonnet 5 delivers near-Opus coding at Sonnet price; escalate to Opus when the spec is incomplete or moves mid-run.
- **`integration`** — Our weight scale. Consequence elevated because shared surfaces are where a mistake costs other people time.
- **`debug-root-cause`** — COMMUNITY: Sonnet 5 praised first-hand for tracing brownfield failures to root causes rather than patching symptoms. Escalate to Opus when evidence conflicts or constraints are hidden.
- **`large-refactor`** — OFFICIAL choosing-a-model: Opus for large-scale refactoring and complex systems engineering.
- **`novel-design`** — Our kind axis. OFFICIAL: Opus for complex systems engineering. Fable only with a warrant - and per the procedural-discipline finding, first try a brief that carries the verification checklist on Opus.
- **`critical-change`** — Consequence axis (arXiv 2606.04402: consequence is orthogonal to difficulty). The floor raises even a one-line change to opus/xhigh.
- **`code-review`** — Our reviewer-parity rule. BENCHMARK (CodeRabbit, semi-vendor): review precision tops out ~37% across every model tested and no model wins both precision and recall - so tier choice does not make review sufficient; adversarial framing and a human gate on critical changes still matter. CAVEAT under calibration: one first-hand report (Wavect) found HIGH effort slower AND lower-recall than LOW on review. See calibration.
- **`long-autonomous-run`** — OFFICIAL choosing-a-model: Fable for agent sessions that run for hours. COMMUNITY, first-hand (TheNeuronDaily): management overhead from unrequested inferences grows with autonomy. Warrant required for Fable; Opus/xhigh is the default.
- **`subagent-worker`** — OFFICIAL choosing-a-model: Haiku for subagent tasks. Raise the weight if the piece is not actually bounded.

</details>

## What is actually known about `fable`

- OFFICIAL (whats-new-fable-5-1): prefers whole-file rewrites, fewer progress updates, less parallel tool batching. Whole-file rewrites make it a poor fit for scoped or mechanical edits even when a warrant exists.
- OFFICIAL (whats-new-fable-5-1): same $10/$50 as Fable 5; cache reads at a quarter of the cost. A long session with a stable prefix is cheaper than sticker price implies - verify the number before relying on it.
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

**Tension:** Official: cache reads at a quarter of the cost. Our measured cache hit ratio is ~96%. But at max effort output tokens run ~1.7x Fable 5 - the discount may be eaten by verbosity.

**Measure:** From telemetry: per-session cost by model with cache-read share. Compare fable vs opus on sessions of similar turn count.

### `sonnet-vs-opus-at-weight-5` — open

**Question:** Is Sonnet 5 sufficient for some weight-5 work?

**Tension:** Vendor benchmarks put Sonnet 5 above Opus 5 on Terminal-Bench 2.1 and some agentic evals at ~40% less cost. Vendor-run, and an outlier.

**Measure:** From telemetry: escalation rate (a Sonnet spawn re-run at Opus) by task type. If weight-5 bounded work rarely escalates from Sonnet, lower the base.

### `procedural-checklist-vs-tier` — open

**Question:** Does a verification checklist in the brief substitute for a higher tier?

**Tension:** First-hand: teaching Opus/Sonnet the Fable-style checklist (hypothesis before edit, VERIFIED/REASONED/ASSUMED labels) closes most of the gap. If true, many Fable warrants should be declined in favour of a better brief.

**Measure:** From telemetry: warrant acceptance rate, and outcome of warranted Fable spawns vs Opus spawns with a checklist brief on the same task type.

> ⚠ `haiku` retires no sooner than **2026-10-15**. Anthropic: Haiku 4.5 retires no sooner than 2026-10-15. The entire weight 1-2 tier rides on this alias. Decide the replacement BEFORE the alias resolves to nothing — the scout raises model_retirement_approaching inside the warning window.

