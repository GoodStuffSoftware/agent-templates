---
id: fail-open-on-the-action-never-on-the-record
title: Fail open on the ACTION, never on the RECORD — a guard that swallows its own exception becomes a silent no-op
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1]
corroborated: 2
---
Fail-open and fail-silent are separable, and conflating them is what makes fail-open dangerous. The safety property you want — *never block real work* — does not require the diagnostic property you get by accident — *never report why*.

The incident: a set of enforcement hooks was deliberately written to fail open, so a guard bug could never break a working session. Correct. Then a genuine parse bug (a byte-order mark on piped input made the payload parse throw — see [[powershell-pipe-bom-breaks-json]]) was swallowed by that same catch, and every hook silently became a no-op. Empty output, exit code zero. *"Guard ran and found nothing wrong"* is byte-identical to *"guard never ran"*. It was caught only by running the guard against an input KNOWN to trip it and getting silence.

The same split shows up at design time, one level out. A guard that must restrict one class of caller and never interfere with another keys off an identifier whose value set grows as the platform adds new caller kinds. Blocking on "not a recognized caller" breaks every future kind; allowing silently lets the guard quietly go inert as the vocabulary drifts. Neither horn is necessary:

- **Enforcement path:** require positive confirmation, default to ALLOW. Enforce on allowlists, never denylists. An unrecognized case never breaks work.
- **Detection path:** record every unrecognized case, every swallowed exception, every allow-by-default. Drift surfaces instead of accumulating.

**Why:** Under-enforcement is the safe failure. *Silent* under-enforcement is not — it converts a guard into a decoration while leaving the reassurance intact, and the reassurance is what stops anyone from looking.

**How to apply:**
- Every swallowed exception in a guard increments a counter or writes a line that monitoring actually reads. A `catch` with an empty body inside a guard is a defect, regardless of how correct the fail-open is.
- Verify a guard with an input **designed to trip it**. A clean run over clean input proves nothing, because a completely dead guard produces the identical result.
- Distinguish the three outcomes in the guard's own reporting: allowed, denied, *could not evaluate*. Folding the third into the first is [[did-not-run-is-a-third-outcome]].
- Related: [[guard-hooks-deny-teach-ack]] (fail open on hook error is right — this is the missing half of it), [[a-silent-guard-needs-a-canary]] (the ongoing-monitoring version of the same ambiguity), and [[assert-the-guard-saw-something]] (the same hazard in the guard's input rather than its error path).

**Two gates in one release pipeline were deliberately given OPPOSITE policies, and that was correct.** The test gate fails CLOSED — a test failure or a broken test runner blocks the release, full stop. The observability gate fails OPEN — a credentials failure or a read error against the monitoring dependency reports an explicit `NOT_RUN` and lets the release proceed, because a monitoring outage that has nothing to do with the code should never wedge every release behind it.

- **Choose fail-open versus fail-closed on the blast-radius axis — what a false BLOCK costs against what a false PASS costs — never on "consistency with the sibling gate."** Two gates protecting different failure classes (code correctness versus an external monitoring dependency) have no reason to share a policy, and forcing them to match trades away the property each one exists for.
- The fail-open gate must still emit a third outcome rather than silently folding into a pass — [[did-not-run-is-a-third-outcome]] — otherwise "the observability check didn't run" and "the observability check ran and found nothing wrong" become indistinguishable, which is the exact silent-no-op failure this lesson opens with.
