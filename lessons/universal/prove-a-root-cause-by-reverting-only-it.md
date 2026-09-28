---
id: prove-a-root-cause-by-reverting-only-it
title: A fix commit's root-cause claim is a guarantee — revert only the named cause and show the test goes red
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 3
---
A fix commit credited its root cause to a watch flag plus a test-setup reset. Reverting BOTH on the committed tree left the full suite green — so neither was the fix. The real change was a fake-timer buffer for jitter inside the test. The reviewer's mutation caught it; the writer's own commit message did not.

**Before writing "root cause: X", revert ONLY X on the committed tree and show the named test goes red.** If it stays green, X is not the cause, whatever the reasoning says.

**Why the claim matters more than it looks:** a root-cause line in a commit message is the artifact future sessions reason from. A wrong one sends the next investigator to the wrong subsystem, and it also authorizes removing the *actual* fix as redundant cleanup — the change nobody understood is the one that gets tidied away.

**How to apply:**
- Commit first, mutate after, so the mutation is trivially reversible ([[commit-before-you-mutate-to-test]]).
- Revert exactly one candidate at a time. A combined revert proves only that the SET matters.
- Where the effect is a guard rather than a test, delete the guard's subject from its input and watch the assertions flip ([[assert-the-guard-saw-something]]).
- If you cannot make the test go red, downgrade the commit message from "root cause" to "observed fix" and say what remains unexplained ([[scope-a-broken-finding-to-the-measured-path]]).

**The same mechanism proves whether a defensive term in a ruleset is load-bearing — and here the count that does NOT flip matters as much as the count that does.** A guard term shipped with a comment calling it "the only thing preventing" an authorization hole. Deleting it and running a batch of adversarial inputs changed the verdict on ZERO of them: an evaluation error from dereferencing a missing property denied the request too, by a different path, so the term was error hygiene rather than the safeguard its comment claimed. Establish load-bearingness by removing the term, running the full case set, and restoring it — exactly the cases that depend on the term should flip, and a large count that does NOT flip is itself the evidence that the term does one narrow thing rather than broadly changing behaviour, whatever its comment says.

**A regression test's own header claim needs the identical proof.** A test's comment asserted it guarded a specific, already-fixed defect — a resolver reading the wrong base path, letting a sandboxed run silently fall back onto real user data. The suite was green. Reinjecting the exact line the original fix had deleted — putting the bug straight back — left the whole suite green while the code under test exhibited the bug again. The test had never been capable of catching the defect its own header described; nothing else would ever have surfaced the difference between "the guard works" and "the guard has gone quietly inert," because both read as the same green suite.

**How to apply (continued):**
- Give every test whose comment claims to guard a specific past defect a sensitivity control: take the exact code the original fix removed, put it back, and assert the suite now goes red. A green result is not evidence the guard works until this has been done at least once.
- When establishing whether a ruleset term is load-bearing, report BOTH counts — cases that flip and cases that don't — not just whether "any" case flipped. The non-flip count is what distinguishes "does one specific thing" from "does nothing."
- "All tests pass" and "the guard is inert" produce an identical transcript. The only way to tell them apart is to deliberately fail the one case the guard exists for.

Related: [[read-which-error-fired-before-theorising]], [[re-run-the-gate-at-the-integration-point]], [[a-silent-guard-needs-a-canary]], [[gate-the-write-not-the-aftermath]].
