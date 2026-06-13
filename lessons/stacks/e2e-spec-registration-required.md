---
id: e2e-spec-registration-required
title: Register every new E2E spec in the test runner's config — an unregistered spec silently never runs
scope: [stack:playwright]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
Adding a Playwright spec file is not sufficient to make it run. The spec must also be registered in the test runner configuration's `testMatch` (or equivalent entry) for the appropriate test tier. An unregistered spec exists on disk, passes static analysis, and produces no error — it simply never executes.

**Why:** The failure mode is invisible: you believe you have test coverage for a feature, the suite runs green, and the spec was never executed. The coverage gap is only discovered when the feature regresses and the supposedly-covering test fails to catch it. By then, the context of why the spec was written is gone.

**How to apply:**
- When adding a new E2E spec, immediately verify it appears in the next test run's output (by name, not just by count).
- Add registration to your "spec added" checklist: write the spec then register it in `testMatch` then run the suite then confirm the new spec's name appears in the output.
- In review, check: "is this spec registered?" before approving new E2E coverage.
