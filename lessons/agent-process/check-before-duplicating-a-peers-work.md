---
id: check-before-duplicating-a-peers-work
title: Before starting work assigned to another agent, check whether they already did it — silence is not evidence of inaction
scope: [agent-process]
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 2
---
In most asynchronous multi-agent setups a message that has been delivered looks identical to one that has been read, so an idle peer and a busy peer are indistinguishable from the sender's side. Silence therefore gets misread as either agreement or absence, and both readings cause damage.

Two incidents, same blind spot. Two agents shared a task board over a bus with no dispatcher: a message to an agent not currently holding a long-poll landed silently and waited to be discovered. One agent assigned a feature to the other, got impatient after an hour of apparent silence, and built it itself — both implementations landed within the hour. Earlier, the same ambiguity produced a mutual deadlock: nine delivered messages sat unread while each agent believed it was waiting on the other. Neither failure was a routing or identity bug; every message reached the right name.

**Why:** The cheap mitigation is a pre-flight CHECK, not a protocol. The duplicating agent had a one-command way to discover the work already existed and did not use it. Protocol changes are the durable fix but require owning the transport; the check costs one command and works today.

**How to apply:**
- Run the cheap check first: list remote branches ({{VCS_LIST_REMOTE_BRANCHES}}) and re-read the peer's last message. If they have a branch or an acknowledgement on the item, it is theirs — do not start.
- If you are genuinely taking it over, announce `TAKING {{ITEM}}` and wait one cycle before writing code.
- The same enumeration settles ownership rules that would otherwise be a judgment call: an "another agent owns this area" rule becomes mechanical when its check is "enumerate the branches ahead of the integration branch and confirm none touch {{PATH}}".
- **Give a non-response a window matched to the population's duty cycle.** Flagging "asked and did not answer" after a few minutes, when the recipients are sessions that may not be running right now, records "never really asked" as if it were refusal — and destroys exactly the distinction the flag exists to preserve. Pick the window from how often those participants actually wake.
- **When you own the protocol, remove the ambiguity at the source.** A send to an agent with no live listener should be visibly recorded as *undeliverable-now* (an unread count, or `delivered: false` in the send response) rather than looking identical to a delivered one. Where a cold-wake mechanism exists — the agent registering a resumable trigger the sender can fire — prefer it to any polling loop ([[no-self-waking-bus-poller]]). Narrower scope worth stating: an agent able to hold a connection can self-arm a long-poll and be event-driven with no server-side dispatcher at all; the dispatcher is only needed for fully dormant peers.
- Distinct from [[recovery-from-silent-teammates]] (probing your OWN silent teammate before respawning) and from [[idempotent-gates-crossed-messages]] (approvals and reports crossing in flight). This one is about not duplicating a peer's assigned work.
