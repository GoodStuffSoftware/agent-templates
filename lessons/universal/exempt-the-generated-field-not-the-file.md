---
id: exempt-the-generated-field-not-the-file
title: Exempt the generated FIELD, not the file that holds it — a file-level exemption smuggles every hand-authored change beside it
scope: [universal]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
Test-relevance gates, change-detection filters, and review-required rules all need a carve-out for files that a build regenerates: a version stamp, a lockfile hash, a generated manifest. The tempting carve-out is by PATH — "changes to `{{BUILD_FILE}}` are test-irrelevant". That is wrong whenever the file also holds hand-authored settings, because it exempts them too.

The shape: a platform build descriptor carries a machine-incremented build number **and** the human-facing version string, the application id, the signing config, and the permission set. A gate that skips test selection for any diff touching that file will happily skip them for a diff that changes the application id. The stamp was the reason for the exemption; everything else in the file inherited it for free.

**Why:** The exemption is written while looking at a diff that contains only the stamp, so the file and the field look like the same thing. They diverge on the first diff that does not — which is precisely the diff you wanted tested. And the failure is silent: the gate reports "no relevant changes" and goes green.

**How to apply:**
- Scope the exemption to the **exact field or line pattern**. The rule is "this diff touches ONLY the generated field", not "this diff touches this file" — parse the hunk, or match the changed lines against the stamp's pattern and require every changed line to match.
- Say what happens when the match fails: any other changed line in that file makes the whole diff relevant again. Fail toward running the tests.
- **Unify the rule if it exists more than once.** These exemptions habitually appear twice — once in a shell pre-check and once in the planner that actually selects work — and two implementations of the same predicate drift. One of them becomes the hole. Extract a single checker both call, or make one delegate to the other.
- Test the exemption from the smuggling side, not the happy side: craft a diff that changes the stamp AND one hand-authored line, and assert the gate treats it as relevant. A test that only proves the stamp-only case is skipped proves nothing about coverage ([[a-gate-that-exists-vs-a-gate-that-covers]]).
- Related: [[assert-the-guard-saw-something]] and [[match-instrument-to-failure-class]].
