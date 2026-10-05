---
id: an-absence-is-evidence-only-if-the-window-could-have-produced-one
title: An absence of evidence is only evidence when the window could have produced some — compute the earliest possible occurrence first
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A detector that fires only after N days of silence cannot produce an occurrence until N days after a deploy. Measured: an agent closed four issues on "zero post-deploy occurrences in both environments" two days after a fix shipped, for a detector with a three-day threshold. The result was guaranteed by the calendar regardless of whether anything was fixed, and it read exactly like a measurement. It was self-caught and the four closes were reopened.

**How to apply:**
- **Before citing an absence, compute the earliest moment the thing you looked for could have appeared.** If that moment is in the future, you have measured nothing.
- **State the window alongside the count, always.** "Zero in a window too short to contain one" is a different claim from "zero".
- Applies to any lagging signal: a rate over a period shorter than the cadence, a staleness alert not yet armed, a retention window not yet elapsed, a scheduled job not yet due.

Related: [[absence-observed-is-not-absence-explained]] (an observed absence does not explain its cause), [[a-scheduled-job-needs-a-registered-but-unobserved-state]], [[a-suppress-verdict-expires]].
