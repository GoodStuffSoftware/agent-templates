---
id: a-silent-guard-needs-a-canary
title: A guard whose success signal is the absence of events needs a canary — sustained zero is ambiguous, not good news
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1, contrib-2]
corroborated: 2
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

**The mirror image: a telemetry pipeline's silence usually has a benign cause you built yourself.** Before concluding a collection path is broken, **enumerate its deliberate suppressors** and check each one — they are documented nowhere together, and every one of them returns a healthy status code while writing nothing:

- an **excluded-source list** (your own office or development IP), which makes self-testing from the obvious vantage a guaranteed false negative;
- an **environment gate** (only production builds emit at all), so a staging verification can never observe the thing it is verifying;
- a **consent or opt-out** state, which suppresses everything for that visitor;
- an **identity requirement** — the sharpest of the four, because it is structural rather than accidental. A client-side error or event flush that needs a signed-in identity is blind to exactly the anonymous population whose problems you most need to see. That is not a suppressor to switch off; it is a design gap to record and card, since the obvious fix (anonymous identities) usually has consequences elsewhere in the system.

Write the list next to the verification procedure, and choose a probe that evades every entry on it — otherwise the first honest test reads as a broken pipeline and someone "fixes" a working system.
- Related: [[assert-the-guard-saw-something]] and [[did-not-run-is-a-third-outcome]].
