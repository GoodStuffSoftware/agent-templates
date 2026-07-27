---
id: no-self-waking-bus-poller
title: Never arm a self-waking timer to poll a coordination bus — drain a durable inbox and let a token-free daemon hold the watch
scope: [agent-process]
status: active
since: 2026-07-27
provenance: [contrib-2]
corroborated: 1
---
A model-backed agent that coordinates with other agents over a message bus must never schedule its own wakeups to check for messages — no timer, no deadline, no cron entry, no "check back in {{N}} minutes" loop. Each scheduled wake starts a full model turn, and the common case is that nothing arrived: the agent reasons about an empty inbox, concludes there is nothing to do, and re-arms. That empty turn costs the same output tokens as real work, and at any useful polling frequency the empty turns dominate spend.

The correct shape has two halves, and neither of them is a model paying to wait:

1. **A durable, server-side inbox** the agent drains at natural turn boundaries — on start/resume, and whenever it is already awake for another reason. Durability is what makes it safe not to be listening: a message sent to a sleeping agent is still there when it next wakes.
2. **An event-driven long-poll held by an infrastructure daemon with no model attached** — a plain process that blocks on the delivery endpoint on behalf of standing agents and cold-wakes one only when a real message lands. Holding a blocked connection is free; waking a model is the thing that costs. Put the cost behind the event, not behind the clock.

**Why:** Polling trades tokens for latency at a terrible rate, and the trade is invisible — nothing fails, usage just climbs. The instinct to "check periodically so I don't miss anything" is answered better by durability (you cannot miss anything) than by frequency. Once delivery is event-driven, a lower-frequency check buys nothing and a higher-frequency one only buys empty turns.

**How to apply:**
- Treat any self-scheduled wake whose purpose is "see if there is a message" as a defect. Wakeups are for external state a daemon genuinely cannot watch for you — and even then, size the interval to how fast that state actually changes, not to how eager you are.
- Make the inbox durable and idempotent server-side, and drain it at turn boundaries rather than on a schedule ([[idempotent-gates-crossed-messages]] — messages and gates cross in flight, so a drain must tolerate re-delivery).
- Run exactly one token-free watcher process for the whole environment, supervised by a `{{PROCESS_MANAGER}}`, and keep it model-free by construction — it routes and wakes, it never decides.
- If a long fallback heartbeat is genuinely needed to survive a hung watcher, make it long (tens of minutes), and say so — a rare safety net is not a poll.
- Applies to any agent-coordination substrate with durable delivery: message buses, work queues, review inboxes.
