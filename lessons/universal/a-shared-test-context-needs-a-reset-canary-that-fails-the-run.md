---
id: a-shared-test-context-needs-a-reset-canary-that-fails-the-run
title: Reusing one expensive test context needs a reset canary — and a canary trip must fail the run, not retry into a pass
scope: [universal]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
Reusing one expensive resource across tests (a browser context with a warm cache, a database) saves minutes, but only with two guards.

**How to apply:**
- Reset after each test, then run a canary that proves the resource empty (storage, cookies, workers, frames).
- A canary trip fails the RUN. A failed test retried in a private resource passed as "flaky", so the run exited 0 and hid the leak.
- Order the reset for late async work: an in-flight request from a cross-process frame set a cookie after the clear (47 of 768 runs under load). Stopping loads in every frame and aborting new requests before closing pages took it to 0 of 768. Measure the leak rate with a probe under load; do not reason about it.
- Tests that cannot share (fake clock, offline mode, video) get a private resource automatically.

Related: [[a-silent-guard-needs-a-canary]], [[assert-the-guard-saw-something]].
