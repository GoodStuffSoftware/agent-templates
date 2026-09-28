---
id: widening-a-timing-margin-does-not-remove-a-race
title: Widening a timing margin does not remove a race condition
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A flaky test or feature built on "wait N ms and assume the scheduled callback fired" is a race, not a timing bug, whenever nothing actually compares elapsed time — it just trusts a timer to win against a competing event before that event cancels it. The common first fix, giving the wait a bigger margin, buys headroom rather than removing the race: it lowers the failure rate at the CURRENT load and the failure returns as soon as contention (parallel workers, a busy main thread) exceeds whatever margin the fix was tuned against.

The incident: a UI long-press interaction armed a timer on press-down and cleared it on press-up, with no wall-clock comparison anywhere — if press-up won the race, the timer's callback simply never ran, a clean non-event rather than a partial state. A prior fix had already widened the test's hold time once, cutting the observed slack from 100ms to 700ms. It flaked again at the wider margin, once under a contended test suite and once on a machine independently verified quiet beforehand — proving the margin was mitigation, not a fix, on both counts.

**Why:** a margin fix and a real fix look identical in the short term, because both make the failure rarer. They diverge only under load, which is exactly the condition nobody is watching when the fix first ships and gets marked done.

**How to apply:**
- Treat "increase the timeout/delay" as mitigation, never as a fix, for any race with no elapsed-time comparison at either end.
- The robust fix compares an actual timestamp captured at both ends (e.g. at arm-time and at cancel/fire-time) against each other, rather than trusting a scheduled callback to fire on schedule. That removes the race outright instead of buying headroom.
- When a "fixed" flake recurs after a margin was already widened once, don't reach for a third widening — that is the signal the original diagnosis was mitigation, and it's time to find the comparison that was never made.
- Expect the failure to return once whatever generates contention (parallel test workers, other load on the box) grows past the margin, even on hardware that was fine when the margin was chosen.
