---
id: same-machine-peers-use-the-harness-channel
title: For peers on the same machine, the harness's own session channel beats a custom coordination bus — and its send has no wake guard
scope: [agent-process]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
When two agents share a machine, the harness usually already ships a session-management surface — list the sessions, send a message into one. Measured against a purpose-built coordination bus for that same case, the harness surface won on both halves:

- **Discovery.** The session listing returned title, working directory, last-activity time, and a running/stopped flag, and it surfaced a LIVE session the bus roster did not have at all. A bus roster records who chose to register; the harness enumerates what actually exists.
- **Delivery.** The harness send arrived as a labelled, source-linked turn the recipient can trace back to its origin. A bus message arrives as a body the recipient has to take on faith.

This does not retire the custom bus. Keep it for what the harness cannot do: peers on OTHER machines, durable queues that survive a dormant or not-yet-started recipient, and sends that need a server-stamped audit trail. Route by locality, not by habit.

**Why:** A coordination bus is built for the hard case (cross-host, dormant, durable) and is then reused for the easy one out of momentum. In the easy case it is strictly worse — a second registry that can disagree with reality, and an unattributed message where an attributed one was available for free.

**How to apply:**
- Decide by locality: same machine → harness session channel; different machine, dormant peer, or audit-stamped delivery required → the bus.
- **The harness send has no wake guard.** Delivery boots a stopped session, so a send to N sessions is N model wakes and N sessions' worth of cost. Never blast a list — address one recipient deliberately, the same discipline [[fan-out-multiplier-at-the-delivery-boundary]] forces on the bus side.
- **Show the operator session TITLES, never internal ids.** Titles read as intent and survive renames better; an id in a status line is noise the operator has to decode.
- A live session missing from the bus roster is a roster fault, not a dead peer — see [[registry-identity-and-liveness-honesty]]. Never infer absence from a registry that records intent rather than existence.
- Related: [[a-local-path-is-not-a-shared-artifact]] (the other half of getting a message to land — reachability of the channel is not reachability of the CONTENT).
