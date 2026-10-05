---
id: a-shared-mock-across-a-boundary-production-does-not-share
title: A shared mock across a boundary that production does not share will validate any claim — build both sides separately
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A test asserted that a settlement never re-sends an already-reported item. It passed because the claim-recording and the settlement shared one storage mock. In production those two scopes differ: one is device-local, the other syncs across devices. The test validated the invariant the author intended rather than the one the code had, and the defect it existed to prevent shipped past it.

A related shape with the same root: a harness hook that re-runs on every navigation (browser-test init-script APIs commonly do) re-seeded the state a durability assertion was checking, so the test asserted its own seed and passed across a reload that never preserved anything.

**How to apply:**
- **When a test crosses a boundary, construct both sides separately** so the test is capable of failing, then confirm it fails against the unfixed code before trusting the pass.
- **A test that can pass without the behaviour working is worse than no test**, because it converts an open question into a settled one.
- **Comment any seed-once or isolation guard with what it prevents**, or it gets simplified away and the test resumes passing for the wrong reason.

Related: [[a-mock-hides-a-cross-runtime-api-incompatibility]], [[a-test-written-from-the-fix-agrees-with-itself]], [[a-probe-that-proves-accept-does-not-prove-persist]].
