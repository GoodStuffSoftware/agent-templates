---
id: prove-the-mutation-landed
title: A green mutation run proves nothing until you prove the mutation applied — a harness that cannot mutate is a test that cannot fail, moved up a level
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Mutation testing exists to answer one question — "if the code broke this way, would the test catch it?" — but the harness that runs the mutation is itself untested, and when it silently fails to mutate, the answer comes back green for a reason that has nothing to do with the test's quality.

The incident: a writer built a mutation-testing pass over its own guard tests, patching the code under test and confirming the tests went red. Its patch script contained an `assert old_string in source` check before applying the replacement. That assertion was itself dropped from a later revision of the script, so when the target text had already drifted, the replace silently no-op'd — the "mutated" file was byte-identical to the original. The run came back green and was read as "the test is sound." Restoring the assertion revealed the patch had not applied in months; the test underneath had been broken the whole time.

This is the same failure shape as trusting a `git push` exit code without checking that the remote ref actually moved: the tool reported success and did nothing ([[exit-code-void-when-output-stream-closes]]). Both hit the same agent within an hour of each other on one task. A wider sweep of that task turned up five tests that could not fail by construction: an assertion built from the transform it was checking ([[a-test-written-from-the-fix-agrees-with-itself]]); a case-sensitive assertion running against a step that lowercased its input first; a test that seeded state such that the broken branch was structurally unreachable; a layout assertion using a document-relative bounding box that passed even against a deliberately broken layout; and the no-op mutation harness itself. Two of the five were written by an agent that had, earlier in the same session, just finished fixing someone else's instance of this exact pattern — having been warned does not prevent it, only actually running the mutation does.

**Why:** a mutation harness is code, and code that silently no-ops looks identical to code that ran and found nothing wrong. The only way to distinguish "the test caught my mutation" from "my mutation never landed" is to inspect the mutated artifact directly, not the test's exit code.

**How to apply:**
- After any automated mutation (a patch script, a fault-injection step, a deliberately-broken build), diff the mutated file against the original and confirm the diff is non-empty and touches the intended line — before trusting whatever the test run reports.
- Treat a mutation harness's own "applied" claim with the same suspicion as the test it is grading; it needs the identical proof-of-effect discipline as [[assert-the-guard-saw-something]].
- As a reviewer, ask which tests were NOT mutated, and whether any surviving test shares the shape of a flaw already found elsewhere in the same pass — a list of what was checked is weaker evidence than a list of what was not.
- A prior warning in the same session is not a mitigation; only the mutation run itself is. Do not downgrade suspicion of a fresh test because the agent that wrote it recently caught the same bug in someone else's code.
- Related: [[green-means-not-broken]] (a passing gate means not-broken, not right — this is the harness-level version of the same gap).
