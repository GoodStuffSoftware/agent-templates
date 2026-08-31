---
id: assert-the-guard-saw-something
title: A guard that passes on an empty input set is worse than no guard — assert it saw something
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 2
---
A validation with an empty input set passes forever and protects nothing. This is worse than omitting it: the green check absorbs the attention that would otherwise have produced a real guard, and the gap now looks covered to everyone who follows.

The incident: an agent added a boot-time assertion meant to prove every known host key maps to a valid environment, so a mis-set value could never silently degrade a credential check. It wired the assertion to `getApp(id).HOSTS`, mirroring an existing line that reads `getApp(id).config`. But `getApp()` returns the module's DEFAULT export and `HOSTS` was a separate NAMED export, so the assertion collected an empty list and passed while checking nothing. Reading the diff could not catch it: the code is well-formed, the assertion is real, the test is green. It was found only by executing the boot expression and noticing the collected list came back with one entry instead of three.

**Why:** Every other failure in a validation is loud. This one is silent by construction, and it is self-concealing — the artifact that would report the problem is the artifact that is broken.

**How to apply:**
- Make the guard REFUSE an empty input outright, with an error naming the likely wiring mistake. A vacuous pass should be impossible, not merely unlikely.
- Derive the checked set from the SAME source that feeds production, not from a hand-written list. Two lists drift, and the drift is invisible precisely when a new item is added — the case the guard exists for.
- Write the test against the real wiring: assert the collected set is non-empty AND contains a known member. A test using a hand-built fixture passes while the live guard checks nothing.
- Run the guard's own expression and LOOK at what it collected. A count lower than you expected is the whole signal; `{{N_EXPECTED}}` vs 1 is the tell.
- Common cause worth knowing: reading a NAMED export as though it were a property of the DEFAULT export (`getThing(id).THING_LIST` where `THING_LIST` is exported separately) yields `undefined`, which most collection code turns into an empty list rather than an error.
- The aggregate form of the same bug — a suite of checks where the ones that could not run are counted as passes — is [[did-not-run-is-a-third-outcome]]. Related: [[match-instrument-to-failure-class]] (the guard runs, but is blind to the class) and [[green-means-not-broken]].
- Three sibling failures worth checking in the same pass: the guard runs but never on the shipping artifact ([[a-gate-that-exists-vs-a-gate-that-covers]]); the guard throws and swallows it ([[fail-open-on-the-action-never-on-the-record]]); the guard's matcher quietly stops matching ([[a-silent-guard-needs-a-canary]]).
