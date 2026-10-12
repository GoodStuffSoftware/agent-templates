---
id: load-sensitive-tests-bound-the-mechanism-not-the-process
title: A test that fails only on a busy machine needs its mechanism bounded, not its margin widened
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
Tests that pass alone and fail intermittently under load have three recurring causes: a spawn timeout sized from the unloaded run, a wall-time assertion that includes process start-up, and a poll loop that gives up after one poll. A wider margin hides them; bounding the right thing removes them.

**How to apply:**
- **A timeout is a hang guard.** Size it from the measured worst CORRECT run under pinned CPU load (worst {{WORST_SECONDS}} s gives a {{GUARD_SECONDS}} s guard, about 6x), never from the unloaded time. On a kill, print `killed by hang guard after {{N}} ms: {{PATH}}`, so it is never a silent `status null`.
- **Bound the mechanism, not the process.** Assert on a step time the product reports itself, a timestamp the child stamps, or an in-process call timed apart from the spawn. Keep the bound; add a `typeof === 'number'` check so a missing field cannot pass vacuously.
- **Look once more after the deadline.** A poll loop that breaks on an overrunning poll can declare TIMEOUT after one poll.
- **Evidence protocol.** Pin the test and busy-loop burners to the same cores with OS CPU affinity; run BEFORE and AFTER at once on disjoint masks; add a forced reproduction that delays the mechanism.
- **"Green alone" proves less than it seems.** Failures scale with load (0 of 38 at a 132 s file run, 16 of 38 at 847 s), and a file run alone still fails when other sessions load the box.
- **Windows:** antivirus scans the first read of a fresh large fixture; prime it with an untimed read.

Qualifies, does not contradict, [[widening-a-timing-margin-does-not-remove-a-race]]. Related: [[a-default-timeout-shorter-than-cold-start-manufactures-flakes]], [[measure-gates-under-normal-load]].
