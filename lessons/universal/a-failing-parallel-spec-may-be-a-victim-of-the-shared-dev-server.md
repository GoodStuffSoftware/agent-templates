---
id: a-failing-parallel-spec-may-be-a-victim-of-the-shared-dev-server
title: A spec that fails "randomly" in a parallel suite may be a victim of the shared dev server's dependency re-optimization
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Parallel end-to-end suites commonly run every worker against ONE dev server. That server's dependency optimizer discovers a not-yet-bundled dependency the first time any spec lazily imports it, re-optimizes, and broadcasts a FULL-DOCUMENT RELOAD over its hot-reload socket to every connected client, including specs in other workers that imported nothing. A spec that never touches the triggering import fails anyway, and only when scheduled alongside the spec that does. That is indistinguishable from flake by every signal the spec itself can offer.

**Incident:** three plausible in-application theories were pursued across two sessions for one failing spec (a long-press timer race, an onboarding redirect, and two framework-resident `location.reload()` call sites), and a margin-widening fix shipped against the timer theory failed. The real trigger was outside the application: a lazily imported charting library discovered mid-run. Diagnosis came from traces showing several dependency-bundle hashes inside a single test, and two specs starting on the same hash.

**Why it misleads:** every in-application theory was a defect the application could plausibly have had, so each survived on its own merits and generated no contradiction. The shared-infrastructure explanation is the only one that requires looking outside the spec AND outside the application, which nobody does while a credible in-app suspect is standing.

**How to apply:**
- When a parallel-suite spec fails on timing, or on an element that should already be present, settle two questions BEFORE proposing a fix: did the document reload mid-test, and was the trigger a DIFFERENT worker? Read the dev server's dependency-discovery output and compare dependency-bundle identifiers across the run.
- The durable fix is to pre-warm or pre-declare lazily imported dependencies so discovery completes before the suite starts.
- Never widen a timeout or a pixel margin until the reload question is settled: a margin fix cannot survive a document reload, and when it fails it gets misread as "the race is tighter than we thought", buying another round of the same wrong theory ([[widening-a-timing-margin-does-not-remove-a-race]]).
- **Exoneration can be structural rather than empirical.** The suspected reload call sites were cleared by showing they could not run at all in that environment (the dev server serves single-page mode, the service-worker bundle is not built, and the run made zero service-worker requests). "It cannot have fired" is a far stronger clearance than "we did not see it fire", and is often available cheaply from configuration alone. Look for it before instrumenting.

Related: [[read-which-error-fired-before-theorising]], [[a-mitigation-that-delays-a-symptom-delays-the-diagnosis]].
