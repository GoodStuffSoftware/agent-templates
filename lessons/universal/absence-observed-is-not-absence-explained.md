---
id: absence-observed-is-not-absence-explained
title: Observed absence is not structural impossibility — verify the mechanism before writing "cannot" into a contract
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
Two independent agents measured the same capability absent from an environment: a plugin enabled at account level, and zero corresponding state materialized in any cloud session. One of them confirmed it "first-hand." The conclusion — *{{ENVIRONMENT}} cannot load plugins* — was then written into the public contract document that other agents read as authoritative.

The operator falsified it with one sentence of environmental knowledge: *my account is bound, and those containers clone this exact private repository all day.* The platform's own documentation described the missing mechanism outright: the capability materializes only when DECLARED in checked-in project settings, and nobody had ever declared it. The remedy was one commit. The remedy for the conclusion that had been published was an architecture.

**Why:** repeated observation of an absence, however first-hand, confirms only the observation. The mechanism behind it — *never bootstrapped* versus *structurally impossible* — is a separate claim, and it is the one that determines what you do next. Agents converge on the same inference because they run the same probe; N agents repeating one unverified inference is still one inference, and consensus makes it feel like N.

**How to apply:**
- **Write the observation and the inferred mechanism as two separate sentences.** "No state materialized in {{N}} sessions" is a measurement. "{{ENVIRONMENT}} cannot do this" is a theory. Only the first belongs in a report unless you checked the second ([[scope-a-broken-finding-to-the-measured-path]]).
- **Before "cannot" enters a durable document, look for the declaration or bootstrap path.** Read the platform's documentation for how the capability is supposed to be enabled, not for confirmation that it is missing. Absence of a bootstrap step is the single most common mechanism behind an absent capability.
- **Weight the operator's environmental knowledge above agent consensus.** They know which accounts are bound, which hosts are enrolled, and what ran there yesterday — facts no probe surfaces. When their one sentence contradicts your two agents, they are describing the environment and the agents are describing a probe.
- **A contract document is the worst place to be wrong.** Every reader downstream inherits the claim without the evidence. Contract-level "cannot" earns a mechanism; everything else says "not observed here, mechanism unverified" ([[correct-a-durable-record-explicitly]] when it turns out wrong).
- Closely related and worth checking first in tool-shaped cases: [[tool-listing-is-scope-filtered]] — a capability absent from YOUR listing may be present under another credential.
