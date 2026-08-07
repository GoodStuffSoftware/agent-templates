---
id: match-instrument-to-failure-class
title: A gate only refutes the failure class it can observe — green from a blind gate is no evidence
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
Before reporting something verified, name the failure class you are ruling out and confirm your check can actually observe it. A gate is blind outside its class, and green from a blind gate is not weak evidence — it is none.

| Failure class | Cannot be refuted by | Needs |
|---|---|---|
| Runtime resolution (undefined name, bad dynamic path) | syntax check, linter, type checker | actually executing the path |
| Wiring between components | unit tests | an integration / end-to-end run |
| Wrong value of the right type | type checker | an assertion on the value |
| Artifact does not run | a successful build | launching it |
| Renders but paints nothing | HTTP 200, no console error | asserting on observable output |

The incident that bought this: a UI was completely dead for hours while a syntax check, a linter, and a custom static checker all reported green — run honestly by several independent agents who each concluded their work was verified. Root cause was an undefined identifier referenced inside a function body: legal syntax, so no parser objects, and it throws only when that function runs. It arrived via a refactor whose commit message said "no behavior change" — accurate for everything a parser can see, since references that formerly shared one scope silently became cross-module and unresolved. Thirty seconds of actually running it named the bug exactly; three green gates had not narrowed it at all.

**Why:** Green accumulates and *feels* like confidence. Three passing gates blind to the same class read as far stronger than one and add exactly nothing. The trap is structural, not a discipline failure — each gate is honest and correctly aimed (that is [[verify-at-destination-prove-the-target]]'s territory); it simply cannot see this kind of defect.

**How to apply:**
- Count distinct failure classes covered, not gates passed. Two checks in the same class are one check.
- **A regression test must be shown FAILING against the pre-fix code.** A test written after the fix that only ever passes proves the fix compiles, not that it fixes anything — and it cannot catch the bug's return. If you cannot make it fail on the old code, it is testing the wrong thing.
- **Verify a conditional path by constructing its precondition.** A feature that fires zero times against real data is not thereby broken; the honest verification is a synthetic case that satisfies the trigger, plus a diagnostic showing why the real data does not. Reporting "fires 0 times, therefore broken" and reporting "fires 0 times, therefore fine" are the same unverified guess.
- When a defect escapes every gate, the durable fix is a NEW gate that can see that class, and its acceptance criterion is that it fails on the original defect. Add it to the blocking set, never the advisory set — an advisory warning is exactly what everyone was already ignoring.
