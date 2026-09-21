---
id: a-queue-gated-on-identity-cannot-record-identity-failures
title: A telemetry path whose flush precondition is the state that is failing records nothing — the population you most need is structurally invisible
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A telemetry queue that only flushes once an identifier is present cannot, by construction, record the failures that happen before that identifier is acquired.

The incident: a client-side error queue only flushed once a user identifier was present, so failures occurring **before** identity is acquired — the whole sign-in-failure class — could never reach the store. The backlog read as zero auth errors, which is exactly the shape of "healthy," and an agent nearly reported it that way.

**Why:** this is a precondition mismatch, not a bug in the usual sense. The general recording path was built assuming the subject it describes already exists, and the failure class that matters most is precisely the one where that assumption is false. The same shape recurs anywhere a recorder needs the thing it is trying to observe: a crash reporter that needs the process alive to ship its report, a network-status beacon that ships its finding over the network, an audit log written by the component being audited.

**How to apply:**
- For every failure class, trace the recording path and ask which of its own preconditions the failure itself destroys. If the answer is "the one this class breaks," the general path is structurally blind to it.
- Give the blind population its own ingestion path — an unauthenticated or guest channel, an explicit fatal-flush flag at the call sites that can fire pre-identity — rather than assuming the general path eventually covers it.
- Treat such a flag as load-bearing once added, and document the revert trap beside it ([[record-intentional-absence]]): removing it looks like harmless noise reduction to a later reviewer, and silently returns the population to zero while every existing test still passes, because no test exercised the pre-identity path either.
- Capture **all** codes in the failure class under one stable name and rely on per-fingerprint dedup to bound volume, rather than suppressing "benign" codes at the source — a code suppressed before it is ever recorded cannot later be counted, audited, or trended.

Related: [[alarm-on-the-runway-not-the-failure]], [[match-instrument-to-failure-class]].
