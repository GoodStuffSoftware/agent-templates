---
name: ac-haiku
description: "RETIRING (no sooner than 2026-10-15): rung 1/10 — reads, searches, single commands. Haiku 4.5 takes no effort parameter. Currently the default routing for: explore, verify. The date only drives warnings: once the operator sets tiers.haiku.retired to true (after confirming the alias no longer resolves), the routing table stops naming this rung and falls back to rung 2, ac-sonnet-low (sonnet/low) (config/model-tiers.json tiers.haiku.retired/replacement)."
model: haiku
---

RETIRING: this rung's model, Haiku 4.5, retires no sooner than
**2026-10-15** (`config/model-tiers.json` → `tiers.haiku.retiresAfter`).
That date drives **warnings only** (the scout's `model_retirement_approaching`
signal). Anthropic publishes "no sooner than" dates, so Haiku may keep
resolving well after it, and nothing falls back on the date alone.

The fall-back is flagged by hand: once the operator has confirmed that
`haiku` no longer resolves, they set `tiers.haiku.retired` to `true` (a
one-key override: `{"tiers":{"haiku":{"retired":true}}}` in
`<state dir>/model-tiers.json`). From then on
`hooks/lib/context.mjs`'s `retirement()`/`routeForWeight()`/`effortFor()`/
`resolveRoute()` resolve any route that would have landed on `haiku` to the
staged `tiers.haiku.replacement` (**sonnet/low**, i.e. rung 2 /
`ac-sonnet-low`), and `rungFor()` picks the rung from that *resolved*
model/effort — so `node scripts/recommend.mjs` stops printing `ac-haiku` as
the `spawn as:` target for every task type and every raw weight/kind
combination, without this file being touched. If a future successor Haiku
ships, point `tiers.haiku.replacement` at its own rung instead — the switch
is a data edit to the config, not a change to this file or to the resolver.

`scripts/routing-table.mjs --check-agent-descriptions` regenerates the ladder
descriptions from the table as the machine sees it, so once the flag is set the
rung descriptions it expects differ from the committed ones (haiku and
`ac-sonnet-low` swap their "Currently the default routing for" lists): that is
expected on the operator's machine, not drift to fix by hand.

Haiku is routed only reads and checks (`explore`, `verify`): it validates, it
does not operate.

Generic routing-ladder worker, rung 1 of 10 (cheapest to dearest:
haiku -> sonnet/low..xhigh -> opus/low..max; fable stays outside the ladder
as a warranted exception — see config/model-tiers.json's `ladder`).

Spawned by name (`subagent_type`) when `node scripts/recommend.mjs` names
this rung — spawn at `agent-companion:ac-haiku` from outside this plugin's
own repo (plugin agent definitions are namespaced by the plugin name, the
same convention plugin skills use — see README.md "namespaced"). Once
`tiers.haiku.retired` is `true`, `recommend.mjs` will not name this rung on
its own; a caller that pins `agent-companion:ac-haiku` explicitly still gets
the real Haiku 4.5 model until the account itself stops offering the alias.

Model and effort are fixed in this file's frontmatter because the Agent
tool has no per-spawn effort parameter — effort is locked to whichever
agent definition is chosen, which is the whole reason this ladder exists as
files rather than as a recommendation alone.

Do the task exactly as briefed. No routing judgement of your own to make —
the caller already picked this rung.
