---
id: proxy-mediated-liveness-measures-the-proxy
title: When one process subscribes on behalf of many, server-side liveness measures the proxy — and a capped watch set evicts silently
scope: [agent-process]
requires: { substrate: coordination-bus }
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Whenever a per-host listener, sidecar, or connection pool holds a subscription on behalf of several local participants, the server's registry of active waiters describes THE PROXY, not the participants. Per-member status derived from that registry is wrong in both directions, and a regression test written against the proxy's own row will pass while the derivation is broken for every member.

The incident: reading a host proxy's source showed it registered a server-side waiter under the MACHINE name only, and merely polled the individual worker inboxes underneath. The server's waiter registry therefore held exactly one name per host. A fix that derived per-worker reachability from that registry reproduced a false negative one level down — every real worker looked unreachable — and its regression test passed because it covered only the machine row. Compounding it, the proxy chose which workers to watch via a bounded, recency-ranked set (the newest {{N}} above a minimum-activity threshold), so throwaway processes had already evicted real workers from coverage, silently, with no signal anywhere.

**Why:** The proxy is an efficiency layer, and efficiency layers are invisible to consumers by design — which is exactly what makes the server's view look like a complete picture. The registry is not lying; it is answering a different question than the one being asked of it.

**How to apply:**
- Never infer per-member status from a registry the members never appear in. Have the PROXY publish its covered set explicitly, as data, on the same cadence it holds its subscription. Inference at the server can only ever reconstruct a guess.
- **Treat any capped coverage set as a silent-eviction hazard.** Newest-{{N}} or top-{{N}}-by-recency selection means low-value churn displaces the entries that matter, and nothing reports it. Filter by quality as well as recency, and EMIT a signal when a previously-covered member drops out of coverage — nothing else will notice.
- Write the regression test against a member, not against the proxy row. A test at the proxy level cannot observe this failure class ([[match-instrument-to-failure-class]]).
- Before declaring the whole capability dead because the server sees nothing, enumerate the transports: a pull-side proxy is invisible in a push-side log by construction ([[scope-a-broken-finding-to-the-measured-path]]).
- Related: [[registry-identity-and-liveness-honesty]] — the participant's own duty to declare what it can honor.
