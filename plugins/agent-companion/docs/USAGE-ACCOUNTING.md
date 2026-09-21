# Usage accounting — what agent work actually costs, and how to measure it locally

A reference on how subscription allowance is spent and what actually drives that spend,
for anyone deciding model/effort tier, judging whether a session ran hot, or sizing a
routing table change. Companion to
[`ROUTING.md`](ROUTING.md) (which tiers get used for what) and
[`TELEMETRY.md`](TELEMETRY.md) (this plugin's own spawn/denial record format) — neither
of those files covers cost accounting, and this one does not repeat their content.

Every claim below is labeled by how it is known: **official** (published by Anthropic),
**community-measured** (a third party measured it, not published by Anthropic),
**inferred proxy** (reasoned from official numbers, not itself official), or **measured
locally** (this operator's own data, on this operator's own machine — a real number, but
not necessarily this account's typical number, and never assume it transfers to another
account's usage pattern).

## How subscription allowance is accounted

**Official, published:**

- Allowance is weighted by **model and effort level**, not by raw token count. Two
  requests of identical token size do not draw down the allowance equally if they ran at
  different effort or on different models.
- Usage is tracked against a **rolling 5-hour window** plus **weekly limits**. Web,
  desktop, mobile, and the CLI all draw from **one shared pool** — there is no
  CLI-specific allowance separate from using Claude anywhere else on the same account.
- The published ordering of relative weight, lightest to heaviest, is **Haiku < Sonnet <
  Opus < Fable**. No official numeric multiplier between tiers has been published.

**Community-measured, not official:**

- Independent measurement puts Opus at roughly **2.5x** Sonnet's allowance cost per
  token. That figure is not published by Anthropic, but it happens to match the ratio of
  Opus's to Sonnet's published **API** list prices almost exactly — which is the
  justification for using relative API price as a stand-in for allowance weight
  elsewhere in this document.

**Inferred proxy — not an official figure, do not cite as one:**

Relative API price per token, normalized so Haiku = 1:

| Model | Weight (proxy) |
|---|---|
| Haiku | 1 |
| Sonnet | 2 |
| Opus | 5 |
| Fable | 10 |

This ratio is **an inference from published API pricing**, offered because it is the
best available stand-in for a number Anthropic has not published, not because it has
been confirmed as the actual subscription-allowance weighting. Treat it as directional —
"Opus costs meaningfully more allowance than Sonnet per token, and Fable meaningfully
more than Opus" — rather than as an exact conversion factor.

**Per-model sub-caps — real, but their interaction with the shared pool is contested:**

An account's own usage readout shows a shared **"all models" weekly line** and a
**separate per-model weekly line** at the same time. Whether the per-model lines are
*independent* limits or *sub-caps drawn from* the shared weekly pool is not clearly
resolved by official documentation — see the open discussion at
[anthropics/claude-code#12487](https://github.com/anthropics/claude-code/issues/12487),
which exists precisely because Anthropic's own announcement text and its support
documentation read as describing two different structures. Do not assume either model
until this is resolved; check the account's own readout (see "How to measure locally"
below) rather than reasoning from a general rule.

**Caveats:**

- No official hours-per-model or requests-per-window figure has been published. Any
  source quoting an exact number of hours "you get" on a given tier should be treated as
  potentially stale — these figures are not fixed contractual constants and have
  reportedly changed over time.
- Effective limits have reportedly run **above** the publicly documented standard since
  around mid-2026, in practice. Treat any specific number more than a few months old,
  official or third-party, as needing a fresh check rather than being taken at face
  value.

## What actually drives cost — measured, not inferred

These are measurements, not projections — drawn from this operator's own local usage
history and session data. They describe where tokens and allowance actually went, not a
theoretical model of where they should go.

**Cache-read dominates total volume, overwhelmingly.** Across one account's full local
history: **~57.5 billion cumulative tokens**, of which **96.6% is cache-read**. A single
heavy session measured in isolation showed **93.8%** cache-read. In both cases the
dominant cost driver is not new content being generated or sent — it is **context being
re-sent and re-read on every turn**, which prompt caching makes cheap per-turn but which
still scales with how much context exists and how many turns re-read it.

**Output tokens are a small share of volume, a somewhat larger share of price.** Output
is roughly **0.5% of total token volume**. Weighted by list price (output tokens cost
more per token than input/cache-read tokens), that share rises to roughly **10-15% of
weighted cost** — real, but a second-order lever. Its bigger effect is indirect:
**a shorter agent report sits in the calling session's context and gets re-sent on every
later turn of that session**, so trimming a report's length compounds across the rest of
the conversation in a way that trimming its own one-time generation cost does not.

**Turn count is the dominant lever, and it is superlinear.** Measured directly: two
agents run on the *same model*, one taking 27 turns and costing 2.0M tokens, the other
taking 100 turns and costing 14.8M tokens. That is 3.7x the turns for 7.3x the tokens —
worse than linear, because **every turn re-reads everything that came before it** in that
session's context. The practical consequence: **a cheaper-tier model that needs more
turns to finish a task can consume more weighted allowance than a pricier model that
finishes it in fewer turns.** Downgrading a model tier to save allowance is only a
real saving if the brief is tight enough that the cheaper tier does not pay back the
saving in extra turns — scope and bound the brief before downgrading the tier, not after.

**Transcript files are mostly scaffolding, not message content.** Measured: transcript
JSONL is roughly **89% JSON structure/scaffolding** by bytes. Only **10.7%** of bytes are
actual message text, and only **8.0%** of bytes are *unique* message text once re-sent
content (the same context appearing again on a later turn) is removed. Consequence:
**estimating token counts as raw-bytes ÷ 4 overstates a transcript corpus by roughly
12x** — the same class of error this plugin's own `memory_budget` feature already
acknowledges at small scale (its own ~4-chars/token estimate is documented as "fine for a
budget alarm, not for billing"; at full transcript-corpus scale the JSON-scaffolding
overhead makes that gap far larger than a rounding error). Any cost estimate built on
raw file size instead of extracted, deduplicated message text should be treated as
roughly an order of magnitude too high.

## How to measure locally

**The session/plan usage readout is the authority for current allowance state.** It is
the only source here that reflects the actual account-level 5-hour window, weekly caps,
per-model sub-caps, and the current session's own context fill, live. Everything else in
this section is a way to look at *local file data* for deeper or historical analysis; it
does not replace checking the readout for "how much allowance is left right now."

**[`ccusage`](https://github.com/ryoppippi/ccusage)** reads `~/.claude/projects/**/*.jsonl`
entirely locally and needs no account login — it parses the same transcript files this
plugin's own telemetry lives beside. Confirmed directly: it supports an explicit
`--offline` mode that uses pre-cached pricing data with no network connectivity; **its
default mode is not fully offline** — it fetches current model pricing data over the
network to compute costs unless `--offline` is passed. Gives per-model splits and 5-hour
rolling-window reports. Two things to keep in mind when reading its output:

- It reports **API-equivalent dollar costs**, computed from list price × tokens. For a
  subscription account this is a **weighted proxy for relative cost**, not an actual
  bill — nothing is actually billed per-token on a subscription plan. Useful for
  comparing sessions or models against each other; not useful as a literal dollar figure.
- It reads whatever coding-agent CLI transcripts it finds in the standard locations,
  which can include tools other than this one if the same machine runs them — check
  which source each report line came from before treating a total as Claude-Code-only.
  It also warns explicitly when a model has no pricing entry, which is worth reading
  rather than ignoring, since that model's tokens are then excluded from the cost figure
  silently otherwise.

**For a bespoke, from-scratch measurement:** stream each transcript JSONL file **line by
line** — never load a full transcript into memory at once; individual session files
reach tens of megabytes, and this plugin's own harvesting script
(`scripts/transcript-harvest.mjs`) already establishes that discipline for the same
corpus. For each `type: "assistant"` record, sum the `usage` object's four fields:
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and
`output_tokens`. That gives real per-model, per-session token counts without needing any
external tool — apply the "what actually drives cost" findings above (cache-read
dominance, the transcript-scaffolding overstatement) when interpreting the totals rather
than treating raw byte size as a shortcut.

## Levers, in order

1. **Tighten the brief to cut turns.** The superlinear turn-count finding above makes
   this the highest-leverage lever available: a scoped, unambiguous brief that finishes
   in fewer turns beats almost any model/effort change.
2. **Lower effort on bounded work.** Effort level is weighted independently of model
   (see "How subscription allowance is accounted" above) — dropping effort on a task that
   does not need deep reasoning saves allowance without changing capability tier.
3. **Lower tier for mechanical work only** — and only after the brief is already tight
   enough that a cheaper tier will not pay the saving back in extra turns (see the
   27-vs-100-turn finding above). A tier downgrade on a poorly-scoped task is not a
   saving, it is a trade of allowance-per-turn for more turns.
4. **Never downgrade the decision-maker.** The lever that lowers cost fastest is also the
   one that produces the worst failure mode if misapplied: a cheaper model making the
   judgment calls a task actually needs a stronger model for does not save allowance, it
   spends it on rework. Reserve tier and effort downgrades for mechanical, bounded, or
   low-consequence work — never for the step that decides what "done" means.
