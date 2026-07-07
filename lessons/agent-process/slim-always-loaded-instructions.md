---
id: slim-always-loaded-instructions
title: Carve always-loaded agent instructions into a slim constants core plus on-demand skills
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
Split the always-loaded instruction stack (the global + project rules files injected into every session) into two layers: (a) a **slim core**, injected every session, holding only constants, safety rules, and a skill-trigger table; and (b) **on-demand skill files** holding the workflow detail, loaded only when a trigger matches. Auto-invocation needs BOTH layers to be reliable: each skill's description opens with a BLOCKING trigger list ("invoke BEFORE doing X/Y/Z"), and the slim core carries a compact trigger table mapping task types → skills — either layer alone gets missed.

Measured effect in one project: the always-loaded stack dropped ~76% (28.2K → ~6.9K tokens). That stack rode EVERY API call of every session and every sub-agent; with prompt-cache reads at ~87% of a heavy week's spend, the carve alone removed ~9% of total spend.

**Why:** Always-loaded instructions are the most expensive real estate in an agent system: they are re-read on every API call, so their cost scales with call volume — sub-agents included — not with how often the content is actually used. Most accumulated instruction text is workflow detail relevant to a minority of sessions. And the bloat is self-reinforcing: the always-loaded file is the easiest place to write a new rule, so without a structural counter-rule the carve regrows.

**How to apply:**
- Audit the always-loaded stack and classify every block: ≤2-line constant needed at every session start (keep in core) vs workflow/process detail (carve into a skill).
- Give each carved skill (1) a description that opens with its trigger list, marked BLOCKING — load before acting; and (2) a header stating "new rules of this class belong HERE", so future growth lands in the on-demand layer by default.
- Put the trigger table in the slim core, one row per skill: "when the task involves X → invoke skill Y first".
- **Never re-inline a skill body into the core** — the core gets a pointer, nothing more. Preserve the pre-carve text as a dated backup file and note the carve (with the backup's location) in the core.
- From then on, route new knowledge by kind so the core stays slim — see [[knowledge-routing-ladder]].
