---
id: verify-at-destination-prove-the-target
title: Verify at the destination, and prove the target you checked is the real one
scope: [universal]
requires: {}
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 3
---
A verification of the form "compare A to B" has two independent ways to be worthless, and hardening it against one leaves the other wide open:

1. **The check lies about the result.** Piped commands report the LAST stage's status — `cmd | tail && echo ok` prints `ok` on a failed `cmd`, and `cmd | head; echo $?` reports `head`'s success. Compare observable state, not exit codes; or capture status with no pipe in between (redirect to a file, then read the status) or via the shell's pipeline-status array.
2. **The check is honest, correctly aimed at a target, and the target is wrong.** A comparison passes trivially when both sides are the same object, or when the thing compared is not the thing that matters.

Failure mode 2 is the durable one, because it survives every fix to failure mode 1 and it produces a sincere report. Observed instances: a workspace created as a shared clone of a LOCAL repo had `origin` set to that local path, so the prescribed "re-fetch, then compare local HEAD to origin/branch" check compared the local repo to itself and reported MATCH while nothing had reached the true remote; a deploy script truthfully reported `written: {{N}} records` while a field was silently dropped at the write boundary; a mitigation reported `{{SKIPPED_COUNT}}` filtered items on the path it had fixed, which reads zero both when the harm is absent and when the harm is flowing through a path the fix does not cover.

**Why:** Every verification has a subject and an instrument, and reviewers audit the instrument. Once the instrument stops lying, the result *feels* established — but a correct instrument pointed at a stand-in, a cached copy, a self-referential comparison, or the writer's own account of its intent gives you a clean green with no information in it. This generalizes far past version control: deploy verification against a stale cache, a health check hitting the old process, a test asserting on a fixture instead of the real config, an idempotency check comparing a value to itself.

**How to apply:**
- A verification step must establish BOTH that the state matches AND that the target is the one that counts. Print the target's identity alongside the result — the resolved remote URL, the database path, the deployed build marker — not just PASS/FAIL.
- Prefer an INDEPENDENT observation path from the one that performed the write: ask what the server actually serves rather than what the local tree contains; read the record back through the public API rather than trusting the writer's report.
- Distrust any success where both sides could be the same object. An isolated-workspace brief must set the real remote explicitly, because a shared/local clone silently makes every ref comparison self-referential.
- **When a distribution channel TRANSFORMS the artifact, the property you uploaded is the wrong fact to assert.** One channel ships the artifact exactly as built, so the identity you pinned is the identity that reaches the device; a sibling channel strips that identity and re-signs with its own, so demanding the uploaded one be registered asserts something that was never true there. Assert the weaker true thing on that channel ("some valid identity is registered") rather than the stronger confidently-wrong one, and say in the check WHICH fact each channel can support. Applies to anything with a re-encoding, re-signing, or rewriting intermediary — stores, CDNs, gateways, proxies.
- **A fix's own drop/skip counter is never proof the fix worked.** It reads zero when the harm is absent AND when the harm is arriving through an unfixed path — the two cases you most need to tell apart. Confirm with a consumer-side count of the effect you were preventing (workers started, notifications sent, rows touched) over the incident window.
- **Say which of two adjacent things happened.** Wrong-target failures are usually VOCABULARY failures: "pushed" meaning *copied to the host* rather than *published to the remote*; "deployed" meaning *merged* rather than *serving*; "saved" meaning *written locally* rather than *committed*. Bind each word to its own check — say "pushed" only after a remote query confirms it. If you cannot name the check, you cannot use the word.
- Corollary on exit codes: a non-zero exit is not always an error. Some tools signal a legitimate NEGATIVE ANSWER that way while printing a valid, parseable result; treating the code as authoritative then reports a working tool as broken. Parse the output first and let it win; reserve "error" for output you could not parse at all.
- Sibling lessons: [[match-instrument-to-failure-class]] (the check cannot see this defect class at all) and [[green-means-not-broken]] (the check sees it and approves it).
