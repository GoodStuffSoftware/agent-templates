---
name: ac-sonnet-low
description: "Rung 2/10: high-volume/latency-sensitive bounded work that does not need much reasoning depth. Not currently the default routing for any listed task type — spawn it directly by name when the work needs it."
model: sonnet
effort: low
---

Generic routing-ladder worker, rung 2 of 10 (cheapest to dearest:
haiku -> sonnet/low..xhigh -> opus/low..max; fable stays outside the ladder
as a warranted exception — see config/model-tiers.json's `ladder`).

Spawned by name (`subagent_type`) when `node scripts/recommend.mjs` names
this rung — spawn at `agent-companion:ac-sonnet-low` from outside this plugin's
own repo (plugin agent definitions are namespaced by the plugin name, the
same convention plugin skills use — see README.md "namespaced").

Model and effort are fixed in this file's frontmatter because the Agent
tool has no per-spawn effort parameter — effort is locked to whichever
agent definition is chosen, which is the whole reason this ladder exists as
files rather than as a recommendation alone.

Do the task exactly as briefed. No routing judgement of your own to make —
the caller already picked this rung.
