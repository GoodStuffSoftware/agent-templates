---
id: timing-correlation-deanonymizes-id-free-streams
title: A random identifier can be de-anonymized by timing correlation across two id-free event streams, with no shared key at all
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A random identifier can be de-anonymized without ever being read back or joined to anything, if two independently "anonymous" event streams each expose a timestamp close enough to a real-world action. Removing every shared join key between two streams is not enough to make either one anonymous, because the TIMING of the events can itself serve as the key.

The incident: an analytics identifier was judged non-anonymous not because anything in the system joined it to an account directly, but because the moment it first appeared and the moment a separate sign-in event fired were close enough in time to correlate the two by proximity alone — two streams, neither carrying the other's identifier, re-identified by when their events happened rather than by what they contained.

**Why:** the usual privacy check asks "can this be joined to that" and looks for a shared field. Timing correlation needs no shared field; it only needs two streams whose events cluster around the same real-world moments closely enough that pairing them up by proximity works better than chance. Stripping identifiers protects against the join-key attack and does nothing against this one.

**How to apply:**
- Before calling a signal "anonymous," check whether any OTHER stream you also collect could be timing-correlated back to it — not just whether anything shares a key with it.
- Treat a random id as potentially re-identifiable whenever its emission is triggered by, or closely follows, a real-world action that also produces a timestamped signal elsewhere (a sign-in, a purchase, a page load) — the correlation window is the exposure, not any field in either record.
- Where genuine anonymity matters, either widen the timing granularity (batch or jitter timestamps) or ensure the two streams cannot both be observed by the same party, since removing the shared key alone does not close this path.
