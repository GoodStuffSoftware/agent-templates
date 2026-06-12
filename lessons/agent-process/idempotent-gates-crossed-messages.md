---
id: idempotent-gates-crossed-messages
title: Design async agent gates idempotently — approvals and reports cross in flight
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
In asynchronous agent communication, an approval you send and a report the teammate sends can be *in flight at the same time* — they cross. Design gates so that crossed messages don't cause double-work, lost work, or a deadlock.

**Why:** You send "go" just as the teammate sends "blocked on X"; or you send "ship it" just as it reports "already shipped." If a gate assumes messages arrive in a strict request→response order, a crossing breaks it: the agent acts twice, or waits forever for an ack that semantically already happened.

**How to apply:**
- Make the "go" signal **unambiguous and re-sendable** — re-sending it must be safe.
- Have agents **re-verify current state and no-op if the work is already done**, rather than blindly acting on a possibly-stale instruction.
- Prefer **one authoritative state snapshot** (the handoff/state doc, a status query) over reconstructing intent from a re-run of message history.
- Relates to [[sync-or-shutdown-stale-teammates]]: a crossed message is one way a teammate's view goes stale.
