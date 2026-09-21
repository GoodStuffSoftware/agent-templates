---
id: a-test-written-from-the-fix-agrees-with-itself
title: An expectation derived from the thing it checks cannot fail — source the expected value independently
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A test written by describing what the fix now does, rather than what the bug used to do, agrees with the fix by construction. It will pass forever, including the day the fix stops actually solving the problem.

The incident: a sanitizer replaced forbidden punctuation with hyphens before content reached a public endpoint. Its unit test asserted the output contained neither the forbidden character nor the target domain string — and passed, because the transform had removed exactly those two things by design. The underlying content survived, fully readable, one substitution away from being reassembled, and shipped to a public unauthenticated endpoint anyway. The test was checking that the transform did what the transform does, not that the output was actually safe.

The fix is to fix the guarantee, not the wording: validate the whole input against the real shape of what is allowed, bucket everything else as rejected, and assert on what SURVIVES rather than on what is absent. "Does not contain X" is a weak, gameable property; "matches an allowed shape" is a strong one. The tell is always the same — the test was written from the FIX rather than from the BUG: write the code, then write a test describing what the code now does, and it agrees with itself forever. Write the test from the failure mode first instead: "what exactly would a broken version of this do, and does this assertion actually see it?"

**Why it recurs one level up, in review rather than in code:** the same session's reviewer pre-computed the expected post-rebase file byte-for-byte and sent that expectation to the implementer before checking the implementer's own work. A later match would have proven transcription — that the implementer copied the reviewer's answer — not correctness of either party's reasoning. Verify against a source neither party authored, and treat a matching hash as a bonus rather than as the evidence. In that same case, the reviewer's OWN independent check then came back FAIL while the hash still matched, because of a bug in the reviewer's own checker — had the reviewer trusted the hash instead of running its own check, it would have been right, but only by luck.

**How to apply:**
- Before trusting a test, ask what a plausible BROKEN version of the code would do, and check whether the assertion actually distinguishes it from the correct version. If a trivially broken implementation still passes, the test is agreeing with itself.
- Assert on the shape of what is ALLOWED to survive, not on the absence of specific known-bad substrings — a substring denylist is exactly the property a determined transform (or a future refactor) games first.
- When a reviewer pre-computes an expected value to hand to an implementer, that pre-computation is not independent verification of the implementer's work — it only proves the implementer can copy. Compute both sides from the source, separately, and compare.
- A matching hash or matching output is corroborating, not conclusive — run your own independent check regardless, since a bug in the comparison tool can pass a hash while the real check fails.
- Related: [[prove-the-mutation-landed]], [[calibrate-a-bound-against-the-real-distribution]], [[match-instrument-to-failure-class]].
