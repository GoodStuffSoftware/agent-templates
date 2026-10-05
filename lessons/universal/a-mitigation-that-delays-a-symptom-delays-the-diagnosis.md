---
id: a-mitigation-that-delays-a-symptom-delays-the-diagnosis
title: A mitigation that delays a symptom also delays the diagnosis — state the diagnostic cost of every resilience mechanism
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Designing an access check that depends on a network lookup, a successful verdict was cached and honoured through a long grace window when the lookup was unavailable, so a transient outage would not lock out every legitimate user. Correct design — but if the underlying credential is later rotated and one copy is missed, nothing appears wrong until the grace expires, and the failure then surfaces days later looking like an unrelated outage.

Every mechanism that keeps a system working through a fault — caching, retries, fallbacks, graceful degradation, generous timeouts — converts a loud immediate failure into a quiet delayed one. That is usually the point. It is also a cost, almost never written down, and invisible precisely because the system is behaving as designed. **Nobody suspects a component that is working as designed**, and the eventual failure arrives decoupled in time from its cause, so the obvious suspect becomes whatever changed most recently — the wrong thing.

**How to apply:**
- **Pair every fallback with a signal.** When the system serves from a degraded path (cache-on-error, fallback transport, retry-after-failure), emit something an operator can see even though the user saw no problem. Availability and observability are separate goals; the mechanism delivering the first silently costs the second unless you ask for both.
- **Write the lag into the runbook, in time units.** Not "responses may be cached" but "a failure here will not be visible for up to N days" — the size of the gap tells the debugger how far back to look.
- **Enumerate what can silently invalidate the dependency** (credential rotation, config moves). If a secret or endpoint lives in several places, list every one and mark which copy's omission fails quietly rather than loudly.
- **Where it fits, use an asymmetric default:** cache a positive result long and honour it through a generous grace window when the dependency is down, but cache a negative result only briefly. Known-good subjects stay available, while a newly valid one is not trapped behind a stale denial. The two directions have different costs and should not share a TTL.

Related: [[fail-open-on-the-action-never-on-the-record]], [[a-silent-guard-needs-a-canary]], [[fail-open-fallback-expires-with-the-flag]].
