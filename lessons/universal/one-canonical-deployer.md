---
id: one-canonical-deployer
title: Exactly one mechanism may deploy production
scope: [universal, stack:ci]
requires: {}
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 2
---
Production must have exactly one deploy mechanism. A second, redundant deployer (a leftover CI workflow, a manual script someone still runs, a platform's built-in auto-build running *alongside* your own pipeline) is not a harmless backup — it is a liability.

**Why:** A redundant deployer fails silently or races the real one. It generates noise (duplicate builds, conflicting statuses) and — worse — misleads diagnosis: you debug the deploy you *think* shipped while a different mechanism actually shipped the bytes. Time is lost chasing the wrong pipeline.

**How to apply:**
- Before touching any deploy config, verify which mechanism ACTUALLY ships production right now — don't assume it's the one in the file you're editing.
- If two mechanisms can deploy, disable or delete one so exactly one remains canonical.
- Document the single canonical deployer in the deploy doc so the next person doesn't re-add a "backup."

**A mandate can be about auditability, not just about avoiding races.** One operator mandated that ALL deploys route through a single tracked orchestration layer rather than ad hoc command-line invocations, specifically so every deploy gets a run identifier and a log — "what shipped, when, from what" becomes reconstructable later instead of living only in one session's transcript. This is the same rule serving a second purpose: even when two mechanisms couldn't literally race each other, an unaudited direct path still destroys the record a canonical one would have kept.

**Refinement: "only" tends to soften into "first," and that is usually correct.** The same mandate was later relaxed from "only route through the orchestrator" to "route through the orchestrator FIRST, with a documented, reason-logging fallback" for cases the orchestrator genuinely cannot handle. An absolute ban on the direct path, with no sanctioned escape valve, produces undocumented workarounds the moment someone is under pressure and the orchestrator can't do what they need — which is exactly the loss of auditability the rule exists to prevent. Prefer a mandate with a logged fallback over one with none ([[safeguard-the-operation-not-the-entry-point]]).
