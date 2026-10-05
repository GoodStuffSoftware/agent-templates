---
id: a-guard-that-reads-ambient-state-is-not-reading-the-target
title: A guard that reads ambient state is not reading the thing being promoted — pass the target explicitly
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 2
---
A guard that reads "the current branch," "the current directory," "the current commit," or any other ambient value instead of an explicitly passed target is not actually checking the thing it claims to check — it is checking whatever happened to be in front of it when it ran.

The incident: a release escape-hatch token was meant to annotate a specific promotion, so a guard parsed it out of the most recent commit of whatever checkout happened to invoke the deploy. In the real workflow, the promotion commit is authored in a dedicated worktree while the deploy itself runs from a different machine's checkout — so the guard had no structural connection to the commit it was meant to gate. It read the ambient "current commit" of an unrelated checkout and passed, having verified nothing about the actual release.

**Why:** "current X" reads as a reasonable default because in the common case — one worktree, one checkout, one invocation — it happens to coincide with the intended target. The guard is only ever exercised in that common case during development, so the coincidence looks like correctness. The gap only opens once the ambient value and the target diverge, which is exactly the case a guard exists to catch.

**How to apply:**
- Generalize past this one incident: any guard that reads "the current branch," "the current directory," "the current user," or "the latest record" instead of the value it was handed is vulnerable the same way. Audit for the pattern, not just the one occurrence.
- Pass the target reference explicitly as an argument to every guard. Offer an environment-variable override only as a documented, auditable fallback — never as the only path.
- Resolve precedence (explicit argument vs. override vs. ambient default) in a single named function, and unit-test the case where the target is NOT the ambient value — that is the case that silently passes otherwise, and it is also the case nobody thinks to write a test for because it never comes up locally.
- Related: [[verify-at-destination-prove-the-target]], [[assert-the-resolved-value-not-the-declaration]], [[derive-session-identity-from-the-session-not-the-cwd]].

**A push gate must key on the PUSHED shas, not the checkout, and the run-scope classifier is part of the gate.** Per-sha caches were keyed correctly, but the component choosing which tests to run was handed the checkout. With the checkout on a clean branch and a side commit touching app source that was not checked out, the classifier saw an empty change set, printed "no relevant changes", banked the checkout's sha and let the push land with zero end-to-end tests. Reachable by pushing `<sha>:<branch>` and by any multi-ref push. Two siblings: a classifier that kept only the first release ref applied that ref's verdict to all of them (ref ORDER decided whether the gate fired), and a diff against the base's tip under-reports where the merge-base form does not (see [[check-the-merge-base-before-believing-a-deletion-count]] for the opposite direction).

- Pass the pushed shas through a channel that survives the wrapper chain (an env var) and take the UNION of the checkout's changes and one (merge-base, sha) change set per pushed sha.
- Classify every pushed ref and require ALL safe; one unsafe ref gates the whole push.
- Test both directions, assert the fixture's premise (tip-form diff empty, merge-base form non-empty), and keep a positive twin (two docs-only refs still skip) so "all must be safe" cannot decay into "never skip". Under-inclusion is the fail-open direction; over-inclusion only wastes time.
