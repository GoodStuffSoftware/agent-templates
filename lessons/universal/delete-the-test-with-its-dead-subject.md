---
id: delete-the-test-with-its-dead-subject
title: Before fixing a flaky test, check whether its subject still exists — then delete the test WITH the code, or neither
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A flaky test kept failing a pre-push gate and blocking unrelated work. It failed only inside the full concurrent suite — it spawned real OS processes and blew a default per-test timeout — and passed every time in isolation. The standing backlog entry proposed the two obvious fixes: raise the timeout, or mock the probe.

The actual answer was that the subsystem the test guarded had been retired months earlier and replaced elsewhere. The test had no remaining subject, and every proposed fix was maintenance on a corpse.

**Why:** the triage reflex for a load-only flake is to widen the budget, stub the slow dependency, or retry — all of which assume the guard is worth keeping. Nothing in a failure message tells you whether the guarded code is still reachable, so the question never gets asked, and a dead test survives indefinitely because each individual fix is small.

**How to apply:**
- **Ask first: is the code this test guards still reachable, still shipped, still run by anyone?** Before any timeout, mock, or retry.
- **Delete the test WITH the code it tests.** The two half-measures both do damage in opposite directions: raising the timeout alone leaves a test that costs wall-clock on every push forever and asserts nothing about observable behaviour; deleting the test alone is worse — it silently drops coverage while leaving the code in the tree, so the next reader assumes the code is live and untested.
- **Establish "dead" by evidence, never by reputation:** nothing listening on its port, endpoints returning 404, no process-supervisor entry, no caller in the import graph. "I think that was replaced" is not evidence.
- **Trace what else the removal touches before deleting.** A retired subsystem's directory is usually a mix of dead modules and shared ones live code still imports. Deleting the directory wholesale breaks the survivors — classify per module and relocate the ones with live callers. Follow the clients too: [[a-pure-wrapper-dies-with-its-service]].
- **Record the removal where the next session will look**, or someone restores it as a fix ([[record-intentional-absence]]).
- This is the case where root-causing a flake leads *upstream of the code*. The in-code cases are [[budget-fan-out-against-host-memory]] (the host, not the test) and [[measure-gates-under-normal-load]] (a budget that only passes idle).
