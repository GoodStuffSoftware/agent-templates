---
id: identify-which-target-woke-you
title: If a dispatcher started you, resolve WHICH target you are running for before diagnosing a repeat
scope: [agent-process]
requires: { substrate: coordination-bus }
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
When you were started by a dispatcher acting on behalf of some queue, session, inbox, or user, the first diagnostic question is **"which target am I running for?"** — not "why am I seeing this again". A dispatcher serving many targets produces wakes that LOOK identical and are not.

The incident: a session woke repeatedly on what appeared to be the same message and concluded the dispatcher must not be persisting its inbox cursor. That was wrong. The cursor design was correct — an in-memory read cursor plus an on-disk durable one advanced only after a clean exit — and the durable cursor for the host's own row was already acknowledged. The repeats were never redelivery to one inbox; they were DIFFERENT inboxes, and the dispatcher's own log named the recipient each session was spawned for. One read of that log would have settled it; the guess instead produced a confident wrong record that later sessions inherited.

**Why:** The payload is the same in both worlds, so reasoning from the payload cannot distinguish them — and the mechanism explanation ("cursor bug") is more available than the identity explanation ("different queue"). The identity is cheap to read and definitive; the mechanism is expensive to infer and usually wrong.

**How to apply:**
- Read the dispatcher's log, or your own resolved identity/arguments, before forming any theory. Do not infer the mechanism from the payload.
- RECORD the answer where the next session will find it, and if you are overturning an earlier recorded diagnosis, mark it explicitly as a correction rather than appending a contradicting claim ([[correct-a-durable-record-explicitly]]).
- The dispatcher side of this: when starting a worker on behalf of a target, put the target's identity in the worker's own startup context, not only in the dispatcher's log — so the worker can answer the question without reading someone else's file.
- Related: [[diagnose-the-right-process]] (confirm which process serves the thing before diagnosing it) — same discipline, applied to identity instead of to processes.
