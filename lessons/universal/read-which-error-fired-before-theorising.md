---
id: read-which-error-fired-before-theorising
title: Read WHICH error fired before theorising — and a theory that predicts a different observable is already refuted
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
A call that can fail BOTH by throwing AND by receiving a negative response normally reports the two cases with different wording. The message already in your hand therefore tells you which half failed — for the price of one grep.

The incident: a payment-verification failure was one step from being diagnosed as a missing server-side configuration flag. The function emits two near-identical user-facing strings from two different paths: one from the `catch` (the request threw — network or parse, no usable response) and one from the response check (the server answered and declined, with the status interpolated). The configuration-flag theory predicted the SECOND string, the one carrying a status code. The string the user actually saw was the FIRST. The flag was never involved and turned out to be correctly set all along. One grep for the literal string separated the two paths and killed a configuration hunt before it started.

**Why:** Diagnosis usually starts by generating candidate causes, which makes the evidence already in hand feel like background rather than a discriminator. It is not background — it is a free measurement of the failure's branch, and it costs nothing to read.

**How to apply:**
- Grep the **exact literal** the user or the log produced, and find which branch emits it. That single fact eliminates a whole class of causes for free.
- Then run the check in reverse: state what your candidate theory **predicts the observable would be**. If the prediction does not match the observable in hand, the theory is already refuted — pick another rather than starting an investigation that cannot confirm it.
- Example shape: `{{SYMPTOM_A}}` ("could not reach {{SERVICE}}") is emitted only from the `catch`; `{{SYMPTOM_B}}` ("could not confirm yet ({{STATUS}})") is emitted only when a response came back and was rejected. A misconfiguration that returns `{{STATUS}}` can therefore only ever produce `{{SYMPTOM_B}}` — observing `{{SYMPTOM_A}}` rules it out without touching the configuration.
- If the two paths currently share a message, that is the fix worth landing: make them distinguishable, so the next reader gets the same free measurement.
- Distinct from [[green-means-not-broken]] and from "reproduce, don't theorize": those are about GENERATING new evidence. This is about mining evidence you were already handed. Related: [[lockstep-failure-means-shared-singleton]] (the same discipline applied to a failure's distribution rather than its wording) and [[scope-a-broken-finding-to-the-measured-path]].
