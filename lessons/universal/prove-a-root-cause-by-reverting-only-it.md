---
id: prove-a-root-cause-by-reverting-only-it
title: A fix commit's root-cause claim is a guarantee — revert only the named cause and show the test goes red
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
A fix commit credited its root cause to a watch flag plus a test-setup reset. Reverting BOTH on the committed tree left the full suite green — so neither was the fix. The real change was a fake-timer buffer for jitter inside the test. The reviewer's mutation caught it; the writer's own commit message did not.

**Before writing "root cause: X", revert ONLY X on the committed tree and show the named test goes red.** If it stays green, X is not the cause, whatever the reasoning says.

**Why the claim matters more than it looks:** a root-cause line in a commit message is the artifact future sessions reason from. A wrong one sends the next investigator to the wrong subsystem, and it also authorizes removing the *actual* fix as redundant cleanup — the change nobody understood is the one that gets tidied away.

**How to apply:**
- Commit first, mutate after, so the mutation is trivially reversible ([[commit-before-you-mutate-to-test]]).
- Revert exactly one candidate at a time. A combined revert proves only that the SET matters.
- Where the effect is a guard rather than a test, delete the guard's subject from its input and watch the assertions flip ([[assert-the-guard-saw-something]]).
- If you cannot make the test go red, downgrade the commit message from "root cause" to "observed fix" and say what remains unexplained ([[scope-a-broken-finding-to-the-measured-path]]).

Related: [[read-which-error-fired-before-theorising]], [[re-run-the-gate-at-the-integration-point]].
