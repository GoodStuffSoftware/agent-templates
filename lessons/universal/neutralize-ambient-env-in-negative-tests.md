---
id: neutralize-ambient-env-in-negative-tests
title: A test for "no environment" must clear the ambient environment — child and hook processes inherit what makes the case impossible
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A helper returned `null` only when its underlying version-control probe THREW, so the "we are outside a checkout" case relied on the tool failing to find a repository when run from the filesystem root. The test asserted exactly that.

It failed — but only inside a pre-push hook. The version-control system exports its repository and work-tree locations into every hook process, so with those variables set the tool resolves a real repository even from `/`. The call succeeded, returned an empty list instead of `null`, and the assertion failed for a purely environmental reason. Every push touching that directory was blocked by a test that was wrong about the environment it runs in, not by any defect in the code — which was right to respect those variables.

**Why:** a negative-case test usually simulates absence by *going somewhere absent* — an empty directory, a bare temp path, the filesystem root. That works only if nothing else is asserting the thing's presence, and ambient environment variables do exactly that, invisibly, from a parent process the test never chose. Hooks, CI runners, and task wrappers are all parents that inject state.

**How to apply:**
- **Clear the relevant environment variables for the duration of the call**, and verify the case passes both with and without them set. If the test is about absence, absence has to be constructed, not assumed.
- **Enumerate what your parent injects.** Version-control hooks, package-manager lifecycle scripts, and CI steps each export a documented set. A test that runs green interactively and red in a hook is almost always reading one of them.
- **When a test fails only in one runner, suspect the runner's environment before the code.** The verdict "the TEST was wrong about its environment" is a legitimate and common outcome, distinct from "the test found a bug" and from "the test is flaky" ([[budget-fan-out-against-host-memory]] is the resource-shaped sibling).
- **Reproduce on an untouched baseline before calling it a regression.** In this case reproducing on the integration branch proved it pre-existing, which changed both the fix and who owned it.
- Related: [[migrated-config-carries-source-host-env]] — the same class of defect where the inherited state comes from another host rather than another process.
