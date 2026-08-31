---
id: a-silent-guard-needs-a-canary
title: A guard whose success signal is the absence of events needs a canary — sustained zero is ambiguous, not good news
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1]
corroborated: 1
---
Some guards are measured by what does NOT happen: denial counts, violation counts, alert counts. For those, silence has two causes that look identical from the metric — the guard is working and nobody is violating, or the guard stopped matching and everybody is.

The incident that bought this: enforcement hooks written against a platform whose tool names can change between versions. A hook whose matcher no longer matches anything does not error. It allows everything, and its denial count is zero — which is exactly what a perfectly-behaved team also produces. Nothing in the dashboard distinguishes the two states.

**Why:** Every other guard failure announces itself. This one is measured by an absence, and an absence carries no information about its own cause. Worse, the ambiguity resolves in the reassuring direction by default: a long run of zeroes reads as a healthy system right up to the incident it was supposed to prevent.

**How to apply:**
- Ship a **canary** with any guard measured by non-events: a periodic probe that deliberately commits a known violation and asserts the guard fired. Run it on a schedule and after every platform or dependency upgrade.
- Invert the monitoring rule: a **sustained zero triggers the canary**, it does not reassure. Wire that explicitly — "no denials in {{WINDOW}}" should page the canary, not close the ticket.
- Assert the denial's CONTENT, not just its occurrence. A canary that only checks "something was blocked" can be satisfied by an unrelated rule.
- The matcher is the fragile part. Where the platform allows it, key the guard off a stable identifier and let it refuse loudly on an unrecognized one, rather than silently declining to match — see [[fail-open-on-the-action-never-on-the-record]].
- Confirm the identifier against the shipped artifact rather than the docs before building the matcher at all ([[grep-the-shipped-artifact-not-the-docs]]).
- Related: [[assert-the-guard-saw-something]] and [[did-not-run-is-a-third-outcome]].
