---
id: a-stall-detector-before-the-recovery-step-flags-recovery
title: A staleness detector that runs before the recovery step flags normal recovery as failure — and one symptom string can have two producers
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A "flush stalled" alert fired for most users who were fine. Three defects: the check ran one line BEFORE the flush that would drain the queue, so a user returning after an absence tripped it and the next line fixed it; the condition was purely time-based (inactive for N days AND a non-empty queue) with no evidence any attempt had failed; and a residue record kept the queue non-empty. Occurrence data split cleanly: one user's inactivity counter climbed monotonically with permission errors attached (the genuine jam), while the other users' counters RESET between rows, proving the queue drained and nothing was broken. One symptom string, two unrelated producers; for three of four users there was nothing to fix, which is why it survived ten releases.

**How to apply:**
- **Place a health check after the recovery attempt, or make it require a recorded failure,** not just elapsed time.
- **To split mixed producers, look for per-entity monotone growth (stuck) versus resets (recovered).**
- **Compute a detector's minimum latency before citing the absence of events as evidence:** a threshold of N days makes "none since the fix" guaranteed by the calendar for N days ([[an-absence-is-evidence-only-if-the-window-could-have-produced-one]]). Four issues were closed on that basis and reopened the same day.

Related: [[a-detector-contains-what-it-detects]], [[a-health-check-asserts-the-invariant-not-the-age]].
