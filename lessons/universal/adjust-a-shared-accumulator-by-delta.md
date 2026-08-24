---
id: adjust-a-shared-accumulator-by-delta
title: A field several independent sources stack into is adjusted by delta, never overwritten — and a cumulative total is not a per-event amount
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
One expiry field on a user record was fed by three independent sources: two payment platforms and an administrative grant. The revocation path wrote an absolute past date. So refunding one small monthly purchase also destroyed time bought on the *other* platform and any promotional grant the user held — and a PARTIAL refund did exactly the same thing as a full one.

The same field had a second, opposite bug at the other end of the same fix. The payment provider's `amount_refunded` is a running TOTAL, and its refund event fires once per refund with a distinct event id, so an idempotency sentinel keyed on event id does not collapse them. Refunding a small amount and then the remainder of one annual charge revoked `24 + 365 = 389` days against a 365-day purchase — and the surplus again came out of the other sources' contributions.

**Why:** a stacking field looks like state ("when does access end") but is really an accumulator ("the sum of what everyone granted"). Every writer that treats it as state overwrites information it does not own. And provider APIs freely mix cumulative fields with per-event ones under similar names, so the correct arithmetic depends on a distinction the field name does not make.

**How to apply:**
- **Revoke by subtracting the contribution you granted, scaled by the fraction being reversed** — never by writing an absolute value. If you cannot compute your own contribution, you cannot safely revoke.
- **Record the join you will need at revocation time, at grant time.** Resolving "how much did THIS purchase grant" usually needs a tier or product identifier the reversal event does not carry, so write a join record when the money is taken. For records that predate the join, fall back to the old conservative behaviour explicitly rather than silently granting a free pass.
- **Check every provider amount for cumulative-versus-per-event semantics before arithmetic.** Read the current API documentation for the specific field; do not infer from the name or from an in-code comment ([[assert-the-resolved-value-not-the-declaration]]).
- **When forced to choose a fallback direction, pick the one whose error is recoverable.** Revoking slightly too much is a support ticket; revoking too little is unbounded free product. Say which direction you chose and why, in the code.
- **Fence it with a test that sums to the exact purchased period** across two successive partial reversals. The single-reversal case passes under both the correct and the double-counting implementation.
- **Extract the arithmetic into pure, clock-injected helpers.** Money arithmetic buried in an event handler cannot be tested without the handler's whole import graph, so it does not get tested.
- Related: [[shared-sequential-id-needs-one-allocator]] (a shared value with no single owner) and [[derive-at-read-time-over-storing]] (whether to store the accumulator at all).
