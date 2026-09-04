# Model routing table

_Generated from `config/model-tiers.json` v2 (updated 2026-08-29) by `scripts/routing-table.mjs`. Do not edit by hand — change the config and regenerate._

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

