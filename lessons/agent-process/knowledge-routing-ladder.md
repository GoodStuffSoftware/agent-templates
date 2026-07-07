---
id: knowledge-routing-ladder
title: Route "remember this" by kind — skill, memory, slim core, or library inbox — and enforce the ladder with a guard hook
scope: [agent-process]
status: active
since: 2026-07-07
provenance: [contrib-2]
corroborated: 1
---
When the user says "remember X" / "from now on X", or a rule is learned mid-session, route the knowledge by KIND down a blocking decision ladder — never default everything into one bucket:

1. **Workflow or process rule** (how/when to do something) → append to the **matching on-demand skill**; create a new skill only for a new self-contained workflow.
2. **Fact, preference, gotcha, or decision rationale** (what is true / what the user wants) → a **memory file**.
3. **≤2-line constant needed at every session start** (safety rule, path, format) → the **slim always-loaded instructions file** ([[slim-always-loaded-instructions]]).
4. **Generic reusable technique** (a pattern any project could use) → in ADDITION to 1–3, append a sanitized entry to the template **library's contributions inbox** — the capture step of [[continuous-contribution-loop]].

Enforce the ladder structurally: a pre-tool-use guard hook DENIES new memory-file writes that lack a routing marker (evidence the ladder was walked), and the deny message contains the ladder itself — the rejection teaches the rule at exactly the moment it is being broken.

**Why:** Unrouted knowledge defaults to whichever store is easiest to write — usually a memory file or the always-loaded rules file. Both are wrong homes for workflow detail: the always-loaded file bloats every API call, and memory files never load at the moment the workflow actually runs. Each kind has a store with the right loading semantics — skills load on trigger, memory loads on recall, the core loads always, the inbox fans out to other projects. And advisory routing rules decay under context pressure; a hook that rejects the misroute self-corrects it in one round ([[guard-hooks-deny-teach-ack]]).

**How to apply:**
- Write the ladder into the slim core as a BLOCKING decision list ("route by KIND — do not default to a memory file").
- Add a guard hook on memory-write tool calls: deny unless the write carries a routing marker (e.g. a `routed:` line naming the ladder step taken); make the deny message the ladder text itself.
- Keep step 4 additive: a technique lives in its project-local home AND flows to the library.
