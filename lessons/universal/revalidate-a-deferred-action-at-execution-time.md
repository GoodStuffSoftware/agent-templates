---
id: revalidate-a-deferred-action-at-execution-time
title: A deferred action revalidates its precondition at execution time — earning it is not the same as still deserving it
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A prompt was earned when a player met a condition, queued, and shown at the next natural moment. Players who had satisfied the condition in the meantime — by doing the exact thing the prompt was about to ask for — still saw it. The state that justified the action was true when it was queued and false when it fired.

**Any action separated in time from the condition that authorized it must re-check that condition at the moment it acts.** The queue records that the action *became* appropriate; it cannot record that it still is.

**Where the gap opens:**
- A notification earned on one event and displayed on the next session start.
- A follow-up job enqueued from a request whose subject may since have been deleted, upgraded, or unsubscribed.
- A grant approved by a check whose inputs keep moving.

**How to apply:**
- Store the *reason* alongside the queued action — the predicate, not just a boolean — so it can be re-evaluated rather than re-derived by guesswork.
- Re-evaluate at render or execution time and drop silently when the reason no longer holds. Dropping is cheap; a wrong prompt costs trust.
- Where the deferred action fires from durable state rather than from the invocation that created it, the same rule applies at the read ([[trigger-follow-up-work-off-durable-state]]).
- Prefer deriving the condition at read time over storing an "eligible" flag that nothing recomputes ([[derive-at-read-time-over-storing]]).

Related: [[a-suppress-verdict-expires]], [[latch-once-only-guards-after-success]].
