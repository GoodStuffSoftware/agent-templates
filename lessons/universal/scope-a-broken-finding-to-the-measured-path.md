---
id: scope-a-broken-finding-to-the-measured-path
title: Scope an "it's broken everywhere" finding to the transport you actually measured
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Before generalizing a capability failure, enumerate the delivery paths that capability actually has. An instrument observes only the path it was built for, and a second path that works shows up as SILENCE in the first path's log — which is often the healthy steady state for a pull-based transport.

The incident: a coordinator found zero successful deliveries in a wake/notify dispatch log and concluded the capability was dead fleet-wide, then shipped a fix that derived "reachable" from that log. There were two delivery paths — a push path (measured, genuinely broken) and a pull path where a per-host proxy holds a long-poll from inside the network and starts a local worker on a delta. The pull path cannot appear in a push log by construction, so zero rows was its healthy state, and the fix was about to mark every working host unreachable.

**Why:** An availability error that UNDER-reports is more dangerous than one that over-reports: it stops people using the endpoints that answer. And the mistake is invisible from where you are standing — the log is complete, the query is correct, the number is real. Only the enumeration of transports exposes it.

**How to apply:**
- State the finding as "broken via {{PATH}}", never "broken". If you cannot name the path your instrument covers, you are not ready to publish a number an operator will act on.
- Check whether a working path exists before shipping a fix that encodes the negative result as data (a `reachable: false` field, a health score, a filter).
- Absence of evidence in a push-side log is not evidence of absence for a pull-side transport. Confirm the negative from the consumer side — did anything downstream actually happen? — as in [[verify-at-destination-prove-the-target]].
- Related: [[proxy-mediated-liveness-measures-the-proxy]] covers the specific case where the working path's participants never appear in the server's registry at all.
