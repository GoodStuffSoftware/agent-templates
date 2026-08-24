---
id: trigger-follow-up-work-off-durable-state
title: Trigger follow-up work off durable state, not off the outcome of the invocation that created it
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A grant needed to send one notification when it was awarded. The design called for the sending to hang off the granting call's outcome: *if we just granted, send*. That version exists only in the memory of one function call. A failed send, or an instance that died after the grant committed, was never retried — because every later invocation fast-bails on the grant marker before reaching the send.

Keying instead off DOCUMENT STATE — *holds the grant marker, lacks the sent marker* — makes it self-healing. The grant's own marker write re-fires the change trigger, and that invocation does the send. A failure leaves the field absent, so the next event retries it. And it reaches the cohort granted by an earlier batch, months before any of this existed, who hold the first marker and would otherwise never be notified.

**Why:** outcome-based follow-up couples a durable effect to an ephemeral context. The grant is committed to storage; the knowledge that it *just happened* lives in one process for one turn. Any interruption between the two leaves a record that is permanently, invisibly incomplete — and the fast-bail guard that makes the common path cheap is exactly what prevents recovery.

**How to apply:**
- **Express the follow-up as a predicate over durable fields:** `has A and not B`. It is retryable, idempotent, and it back-fills records created before the feature existed — three properties you cannot get from an in-invocation branch.
- **Write the completion marker as the last step**, so a failure leaves the predicate true and the next event retries. Pair with [[latch-once-only-guards-after-success]] — same ordering rule, durable instead of in-process.
- **Read both fields off the event image, not with fresh queries**, so the far more common no-op path costs nothing. State-based triggering is only affordable if the negative case is free.
- **Log and swallow failures in a courtesy follow-up whose prerequisite already committed.** Throwing retries the whole invocation — including the effect that already succeeded — for something that is not the product promise.
- **Give the new marker field the same treatment as every other field of its class**: access rules, the admin-field list, the verification script, the rules test. A field added by one feature and known to only that feature is the next drift.
- **Extract the shared pieces the second sender will need** (branding, credential declarations) at the moment there IS a second sender, so the two cannot drift into one deploying without a credential the other has.
- Related: [[derive-at-read-time-over-storing]] and [[seed-a-new-counter-from-measured-state]] — both about preferring what the data can prove over what a call remembered.
