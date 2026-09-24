---
name: ac-haiku
description: "RETIRING 2026-10-15: rung 1/10 (cheapest) — reads, searches, single commands, verification (weight 1-2). Haiku 4.5 takes no effort parameter. After the retirement date, the routing table stops naming this rung on its own (see config/model-tiers.json tiers.haiku.retiresAfter/replacement) and falls back to rung 2, ac-sonnet-low (sonnet/low)."
model: haiku
---

RETIRING: this rung's model, Haiku 4.5, retires no sooner than
**2026-10-15** (`config/model-tiers.json` → `tiers.haiku.retiresAfter`).
Nothing here needs to change by hand on that date — `hooks/lib/context.mjs`'s
`retirement()`/`routeForWeight()`/`effortFor()`/`resolveRoute()` already
resolve any route that would have landed on `haiku` to the staged
`tiers.haiku.replacement` (**sonnet/low**, i.e. rung 2 / `ac-sonnet-low`)
once the date passes, and `rungFor()` picks the rung from that *resolved*
model/effort — so `node scripts/recommend.mjs` stops printing `ac-haiku` as
the `spawn as:` target on its own, for every task type and every raw
weight/kind combination, without this file being touched. If a future
successor Haiku ships, point `tiers.haiku.replacement` at its own rung
instead — the switch is a data edit to the config, not a change to this file
or to the resolver.

Generic routing-ladder worker, rung 1 of 10 (cheapest to dearest:
haiku -> sonnet/low..xhigh -> opus/low..max; fable stays outside the ladder
as a warranted exception — see config/model-tiers.json's `ladder`).

Spawned by name (`subagent_type`) when `node scripts/recommend.mjs` names
this rung — spawn at `agent-companion:ac-haiku` from outside this plugin's
own repo (plugin agent definitions are namespaced by the plugin name, the
same convention plugin skills use — see README.md "namespaced"). After the
retirement date, `recommend.mjs` will not name this rung on its own; a
caller that pins `agent-companion:ac-haiku` explicitly still gets the real
Haiku 4.5 model until the account itself stops offering the alias.

Model and effort are fixed in this file's frontmatter because the Agent
tool has no per-spawn effort parameter — effort is locked to whichever
agent definition is chosen, which is the whole reason this ladder exists as
files rather than as a recommendation alone.

Do the task exactly as briefed. No routing judgement of your own to make —
the caller already picked this rung.
