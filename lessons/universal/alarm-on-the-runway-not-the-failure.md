---
id: alarm-on-the-runway-not-the-failure
title: A supply that depends on someone remembering to refill it is a dated outage — alarm on remaining runway
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A supply produced by a manual step runs out on a knowable date. If nothing alarms on the shrinking runway, the failure has no error, no deploy, and no failing test attached to it — it just arrives.

The incident: a daily-content feature had forward-dated material generated only when an administrator manually invoked a generator; no scheduled producer existed. Production content therefore runs out on a specific known date, and nothing alerts as the runway shrinks — interface copy and onboarding kept promising the feature to new arrivals right up to that date. A monitoring script that checks remaining coverage already existed in the repository and was wired into no trigger at all, which is worse than no script: it creates the impression the risk is covered while providing zero protection ([[relocate-a-gate-that-cannot-run-here]]).

**Why:** a manually-produced supply degrades silently because nothing about its depletion looks like a failure while it happens — the last successful generation looked identical to every one before it. The alarm has to be built on the resource's remaining lifetime, not on an error the resource never produces.

**How to apply:**
- Alarm on **remaining coverage measured in days** (or units), not on the failure the depletion eventually causes — a countdown crossing a threshold is the event, not the empty queue.
- Give the coverage check its own schedule and a destination someone actually watches. A check that exists in the repository but is wired to nothing is not a mitigation.
- Enumerate every promise — marketing copy, onboarding flows, store listings — whose truth depends on an unmonitored runway, and treat each as something that silently goes false on the same date.
- For any feature whose state is produced by a human-invoked step, either schedule the producer or explicitly document the manual step as an operational dependency with a named owner and a cadence.

Related: [[a-silent-guard-needs-a-canary]], [[did-not-run-is-a-third-outcome]], [[trigger-follow-up-work-off-durable-state]].
