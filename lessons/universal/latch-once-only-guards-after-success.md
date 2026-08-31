---
id: latch-once-only-guards-after-success
title: Latch a once-only guard AFTER success, and clear a cached promise on rejection
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 2
---
A boot-time initializer used two standard idempotency devices and set both too early:

- **A one-shot boolean latched before the call that can fail.** A throwing registration marked the work done, so the listener it should have registered was never registered — for the life of the process. The exact failure the initializer existed to prevent (an unfinished transaction auto-refunded days later) came back, silently.
- **A cached promise stored before it resolved.** One rejected initialization was cached for the process lifetime, so a single launch with no network broke the feature until the application was killed and restarted.

Both are one-line ordering bugs and neither shows up in a test that only exercises the happy path.

**Why:** "do this once" and "do this once *successfully*" look identical in code and differ completely in behaviour. Latching first is the natural way to write a guard because it also prevents re-entrancy, and re-entrancy is the failure the author has in mind. The failure they do not have in mind is the first attempt throwing — after which the guard is indistinguishable from success forever.

**How to apply:**
- **Set the completion flag after the operation returns**, not before it starts. If you need re-entrancy protection during the call, use a separate *in-flight* marker that clears in a `finally` — two states, not one.
- **A cached promise must be cleared on rejection.** Store the promise so concurrent callers share it, and attach a handler that nulls the cache when it rejects, so the next caller retries instead of inheriting a permanent failure.
- **Test the throwing path explicitly:** make the first call fail, then assert the second call actually attempts the work again. A once-only guard with no failure test is untested in the only case where it matters.
- **Hoist an irreversible finalizer OUT of the retry loop.** Same bug, one shape over: a purchase-verification routine was wrapped in a retry, and the call that consumes/acknowledges the transaction sat inside the loop body. The first transient failure consumed the thing the retry existed to re-attempt, so every later iteration ran against nothing. Retry the *fallible* step; run the *one-way* step once, after the loop, gated on the loop having succeeded. If you cannot tell which is which, the tell is whether a second call to it is meaningful.
- **Prefer a self-healing shape where the state itself is the guard.** Deriving "already done" from durable state rather than from an in-process flag survives crashes, restarts, and cold instances — see [[trigger-follow-up-work-off-durable-state]].
- Related: [[fail-open-fallback-expires-with-the-flag]] — the same class of bug, where a state set at the wrong moment persists past the condition that justified it.
