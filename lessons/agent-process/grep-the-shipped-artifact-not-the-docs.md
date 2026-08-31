---
id: grep-the-shipped-artifact-not-the-docs
title: For an integration keyed on an exact identifier, the installed artifact is authoritative — and agent disagreement is a signal to go read it
scope: [agent-process]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1]
corroborated: 1
---
When an integration hinges on an exact external identifier — the tool name a lifecycle hook must match, an event name, an environment-variable key, a field in a payload — the **shipped artifact on disk** is the authority. Documentation lags releases, and third-party summaries hallucinate confidently and in detail.

The incident: two research agents returned contradictory answers about which tool name a hook must match to intercept agent spawns. Both cited documentation; one cited a specific page and line, which made it look like the stronger answer. Grepping the installed binary settled it in one command — and revealed the losing answer had named a DIFFERENT tool entirely (a task-list tool, not the spawn tool). The binary even shipped an error string written to distinguish the two, evidently for exactly this confusion. A guard built on the wrong name would not have errored. It would simply never have fired, which is indistinguishable from a clean run ([[a-silent-guard-needs-a-canary]]).

**Why:** Citation quality measures how confidently a source was written, not whether it matches the bytes you are integrating against. An identifier is a byte string; the artifact containing it is sitting locally and costs one command to interrogate.

**How to apply:**
- Before shipping anything keyed on an exact external identifier, confirm the identifier against the **installed artifact**: `strings`/`grep` the binary, read the shipped schema or type declarations, or dump the runtime's own registry.
- **Treat two agents disagreeing on a load-bearing fact as a trigger to consult the primary artifact** — never as a tie to be broken by citation quality, seniority, or averaging. The disagreement is information: it says the secondary sources are unreliable here.
- Prefer identifiers the artifact will reject loudly when wrong. Where the platform offers no such refusal, the canary is the substitute.
- Related: [[probe-behaviour-not-version-stamps]] (a self-reported version is a claim by the thing you are auditing), [[run-the-formats-own-validator]] (same shape for schema-bound artifacts), and [[tool-listing-is-scope-filtered]] (why an identifier's ABSENCE from a listing proves nothing).
