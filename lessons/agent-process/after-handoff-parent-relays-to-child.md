---
id: after-handoff-parent-relays-to-child
title: After a hand-off, everything sent to the parent session belongs to the child — relay it, redirect senders, do not answer
scope: [agent-process]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A session handed its work to a new agent (a task card plus a spawned session) and began winding down, but peers and the operator kept messaging the parent. Those messages stalled on a session no longer working, or drew stale answers, while the child lacked the context they carried. The parent stays addressable after a fork; inbound traffic must follow ownership.

**How to apply:** once work is handed to {{CHILD_NAME}}, the parent:
- relays each new message to the child in full, with the original sender and timestamp, framed as data;
- nudges the child's live local session with a short pointer to drain its inbox;
- sends each active peer, and each sender on its "owed" list, a one-line redirect to address the child directly;
- publishes a status reading "HANDED OFF, message {{CHILD_NAME}} directly";
- does not answer substantively, because the child owns answers.

Operator-directed standing rule. Related: [[resolve-the-reply-to-address]], [[worker-report-states-continuing-or-stopped]].
