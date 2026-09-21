---
id: a-guard-that-reads-ambient-state-is-not-reading-the-target
title: A guard that reads ambient state is not reading the thing being promoted — pass the target explicitly
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A guard that reads "the current branch," "the current directory," "the current commit," or any other ambient value instead of an explicitly passed target is not actually checking the thing it claims to check — it is checking whatever happened to be in front of it when it ran.

The incident: a release escape-hatch token was meant to annotate a specific promotion, so a guard parsed it out of the most recent commit of whatever checkout happened to invoke the deploy. In the real workflow, the promotion commit is authored in a dedicated worktree while the deploy itself runs from a different machine's checkout — so the guard had no structural connection to the commit it was meant to gate. It read the ambient "current commit" of an unrelated checkout and passed, having verified nothing about the actual release.

**Why:** "current X" reads as a reasonable default because in the common case — one worktree, one checkout, one invocation — it happens to coincide with the intended target. The guard is only ever exercised in that common case during development, so the coincidence looks like correctness. The gap only opens once the ambient value and the target diverge, which is exactly the case a guard exists to catch.

**How to apply:**
- Generalize past this one incident: any guard that reads "the current branch," "the current directory," "the current user," or "the latest record" instead of the value it was handed is vulnerable the same way. Audit for the pattern, not just the one occurrence.
- Pass the target reference explicitly as an argument to every guard. Offer an environment-variable override only as a documented, auditable fallback — never as the only path.
- Resolve precedence (explicit argument vs. override vs. ambient default) in a single named function, and unit-test the case where the target is NOT the ambient value — that is the case that silently passes otherwise, and it is also the case nobody thinks to write a test for because it never comes up locally.
- Related: [[verify-at-destination-prove-the-target]], [[assert-the-resolved-value-not-the-declaration]], [[derive-session-identity-from-the-session-not-the-cwd]].
