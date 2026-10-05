---
id: a-health-check-asserts-the-invariant-not-the-age
title: A health check asserts the invariant, not the age — and triggers on the block that changed, not the file it lives in
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A post-release verifier treated an entire security-rules file as "infrastructure for feature X", so any edit to an unrelated block made every release count as touching X. It then asserted a derived summary was less than 24 hours old and went red on a well-formed summary 375 hours old. The summary is rewritten only when an event displaces a top entry, so its age reflects traffic, not health.

**How to apply:**
- **Trigger a conditional check on a block-level, comment- and whitespace-insensitive diff** of exactly the regions that matter, not on the file.
- **Assert the invariant (present, well-formed); report age for information only.** An age bound on something rewritten lazily measures activity.
- **Fail safe:** an unreadable or unparseable diff counts as touching.
- **Import the real library functions in tests** rather than mirroring their logic, and add a guard test that parses the real file.
- **Validate any classifier by replaying it over past releases.** One that would have gone red on N historic releases is miscalibrated; a check that is always red trains everyone to ignore it ([[calibrate-a-bound-against-the-real-distribution]]).

Related: [[green-means-not-broken]], [[post-deploy-checks-need-their-own-harness]].
