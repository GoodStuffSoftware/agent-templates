---
id: a-slow-suite-is-mostly-idle-time
title: A slow test suite is mostly idle time — measure efficiency first, then remove sleeps, serial leftovers and serialized boots
scope: [universal]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
A full end-to-end run fell from 623 s to about 170 s in nine measured slices with every test title unchanged.

**How to apply:**
- Measure first: test-seconds against wall time times workers. 52% efficiency meant the biggest files each pinned one worker while the rest idled. Then take per-spec durations and boot milestones.
- Schedule per test, not per file, once each worker owns its own backend; drop serial mode left over from a single shared one.
- Replace each fixed sleep with the event it stood in for (a poll on the condition, or a test seam): 2875 to 2212 test-seconds.
- Overlap independent boots, such as emulators while the dev server starts.
- Cap each worker's memory and refit the worker planner to the measured maximum.

Related: [[budget-fan-out-against-host-memory]], [[widening-a-timing-margin-does-not-remove-a-race]].
