---
id: neutralize-ambient-env-in-negative-tests
title: A test for "no environment" must clear the ambient environment — child and hook processes inherit what makes the case impossible
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 2
---
A helper returned `null` only when its underlying version-control probe THREW, so the "we are outside a checkout" case relied on the tool failing to find a repository when run from the filesystem root. The test asserted exactly that.

It failed — but only inside a pre-push hook. The version-control system exports its repository and work-tree locations into every hook process, so with those variables set the tool resolves a real repository even from `/`. The call succeeded, returned an empty list instead of `null`, and the assertion failed for a purely environmental reason. Every push touching that directory was blocked by a test that was wrong about the environment it runs in, not by any defect in the code — which was right to respect those variables.

**Why:** a negative-case test usually simulates absence by *going somewhere absent* — an empty directory, a bare temp path, the filesystem root. That works only if nothing else is asserting the thing's presence, and ambient environment variables do exactly that, invisibly, from a parent process the test never chose. Hooks, CI runners, and task wrappers are all parents that inject state.

**How to apply:**
- **Clear the relevant environment variables for the duration of the call**, and verify the case passes both with and without them set. If the test is about absence, absence has to be constructed, not assumed.
- **Enumerate what your parent injects.** Version-control hooks, package-manager lifecycle scripts, and CI steps each export a documented set. A test that runs green interactively and red in a hook is almost always reading one of them.
- **When a test fails only in one runner, suspect the runner's environment before the code.** The verdict "the TEST was wrong about its environment" is a legitimate and common outcome, distinct from "the test found a bug" and from "the test is flaky" ([[budget-fan-out-against-host-memory]] is the resource-shaped sibling).
- **Reproduce on an untouched baseline before calling it a regression.** In this case reproducing on the integration branch proved it pre-existing, which changed both the fix and who owned it.

**The contamination source isn't always an inherited variable — a third-party binary's own first-run writes can pollute an asserted-empty directory just as invisibly.** A test pointed the process's home/config directory at a sentinel location and asserted it stayed empty, to prove the code under test touched nothing there. It failed on any machine that happened to have some external CLI installed, because the code under test shells out to that CLI, and the CLI performs its own first-run initialization in whatever home directory it is handed — writing its own config and a backup file into the sentinel. CI never caught this because the CI image lacked that CLI, so the failure surfaced only on individual developers' machines, exactly the way an ambient-env-variable failure surfaces only under the parent process that sets it.

- **Strip any third-party binary the code under test may invoke from `PATH`** before asserting what your own code touched, so the assertion measures your code and not a dependency's uninvited side effect.
- **A test green in CI but red locally is a strong lead, not noise to route around** — the environment difference (an installed tool, an ambient variable, a host default) is usually the finding itself, following the same pattern as a hook injecting variables a pushed test never expects.

Related: [[migrated-config-carries-source-host-env]] — the same class of defect where the inherited state comes from another host rather than another process.
