---
id: did-not-run-is-a-third-outcome
title: A check that did not run is a third outcome — never fold it into pass, and never let it sit there for months
scope: [universal]
requires: {}
status: active
since: 2026-08-17
provenance: [contrib-2]
corroborated: 1
---
A verification suite has three outcomes per check, not two: **pass**, **fail**, and **did-not-run**. Compute the aggregate verdict from the absence of *both* failures and did-not-runs. "No failures" is not "verified" — it is also what a suite that executed nothing reports.

A week of hardening one release-verification harness produced the same fix five times over: a live suite that skipped every test still reported green; a channel that could not find its credential counted toward "verified"; a wrapper collapsed a red into a green because it dropped the reason; a checkout with no configuration for the live tier reported *failure* when the honest answer was did-not-run. Each is the same missing distinction, and the direction of the error alternates — sometimes silence reads as success, sometimes a runner misconfiguration reads as a release fault.

**And a did-not-run that persists is unexercised code.** When those channels finally executed for the first time, the first real run exposed two defects in them immediately — a credential resolver that ignored the ambient credential the deploy itself was authenticated as, and a report line printing a field name that does not exist on the object it read. Separately, a signing defect had been dormant for months purely because no deploy of that flavour had run in the window since the change landed. Nothing caught it because nothing exercised it; the gate that eventually refused the upload worked exactly as designed, on the first day it was asked to.

**Why:** did-not-run is the state that hides. A fail is loud and a pass is informative, but a skip is silence, and silence aggregates into green. A channel parked in that state also stops being maintained: the code is never executed, so it rots at the rate of everything around it while its row in the report looks the same as a working one.

**How to apply:**
- Model the third state explicitly and make the aggregate verdict require every check to have actually reported pass. A `required: false`-style escape hatch on an individual check is the wrong shape — see [[assert-the-resolved-value-not-the-declaration]] for what happens when nothing reads it anyway.
- Distinguish **"cannot run here"** (missing optional tool, no credential on this host, leg not shipped this release) from **"ran and failed"**. The first is did-not-run, never a failure; the second is never a skip.
- Carry the REASON into the verdict. A summariser that reports a boolean loses the one field that lets a reader tell a real red from an unconfigured runner — and a wrapper that drops it can mask a red entirely.
- Track how long each check has been did-not-run, and treat a long-dormant one as unverified code, not as a passing check. Exercise it deliberately rather than discovering its defects on the day it finally matters.
- When two checks inspect the same thing and disagree — one reports did-not-run, the other passes by reasoning that the artifact "must exist" — the disagreement is the tell. The one that inferred is the one that is wrong.
- Related: [[assert-the-guard-saw-something]] (the single-guard version of the same bug), [[match-instrument-to-failure-class]], [[green-means-not-broken]].
