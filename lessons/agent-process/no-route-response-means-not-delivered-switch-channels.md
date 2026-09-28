---
id: no-route-response-means-not-delivered-switch-channels
title: "Queued durably" is not delivery — treat the first no-route send as a signal to switch channels
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A message-bus send to a dormant or unreachable recipient can return success-shaped language — "queued durably, delivered on the recipient's next natural turn" — while never actually reaching anyone, if nothing holds a wake path for that recipient. A durable queue only helps if something drains it; a recipient that never does is permanently unreachable by that channel no matter how many messages pile up behind it.

The incident: two independent agents sent status reports and announcements to a coordinator over a message bus for several hours. Every send came back with an explicit no-route/undeliverable-now outcome, one agent's thirteen times in a row. Both agents read the "queued durably" phrasing as communication achieved. The coordinator never drained its own inbox, saw only silence, and reported both agents as stalled for most of a working day — when both had in fact finished real, reviewed work. A same-host session channel that reached the coordinator directly was available and working the entire time; one of the two agents was already using it successfully with a different peer.

**Why:** the response text is written from the transport's point of view ("the message is safely stored"), not the recipient's ("someone will read this"). Those are different claims, and only the second one is what the sender actually needs. Silence from a peer is not evidence of a stall on its own — it may mean every message sent to them failed exactly this way, invisibly, because nothing errored.

**How to apply:**
- Treat the FIRST such no-route/undeliverable response as a failed send, not a slow one. Do not retry the same route hoping it resolves itself — check the response's own outcome field, not just whether the call itself succeeded.
- Switch immediately to a channel that reaches the recipient directly (e.g. a same-host session channel, a different transport entirely) rather than accumulating more messages behind a route with no reader.
- On the receiving side, drain every durable inbox at session start and at natural turn boundaries — a coordinator that never drains its inbox is unreachable to every sender following the documented path, no matter how well-behaved they are.
- Before reporting a peer as idle or stalled, check whether the channel it was told to use can actually reach you; a peer showing as not-mid-turn in a session listing is not the same as a peer that has done nothing.

Related: [[verify-the-inbound-direction]] (the same silent-queue hazard from the receiving side — outbound health proves nothing about inbound reachability), [[recovery-from-silent-teammates]] (probe state before respawning rather than assuming silence means no progress).
