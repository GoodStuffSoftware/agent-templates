---
id: an-inherited-env-var-beats-the-child-cwd
title: An inherited environment variable beats the child's working directory — a fixture test under a hook operates on the real system
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A spawned process resolves its target from environment variables before it looks at its own working directory. A test that builds a throwaway fixture assuming its working directory decides where it operates is safe only in the contexts where nothing has set that variable first.

The incident: a regression test built a disposable fixture repository in a temp directory — initialize it, configure it, rename a branch — to exercise a narrow code path. Run directly, it was harmless: no ambient variable pointed anywhere, so the fixture's own init call set up its own isolated state. Run from a pre-push hook, the same test re-initialized the SHARED repository instead, because the version-control system sets a directory-pointing environment variable in a hook's own environment, a spawned child process inherits that variable from its parent, and the inherited variable takes precedence over the child's working directory. One core repository setting flipped as a result. Every worktree linked to that repository reads the same setting, so routine commands broke simultaneously across roughly eighty worktrees and every concurrent agent session on the machine.

"It worked when I ran it directly" does not prove a fixture test is safe in the one context that actually matters — the context an agent cannot fully see from outside, because the dangerous variable lives in the parent process's environment, not in the test's own code.

**The quiet damage is metadata, and no agent's own report will mention it, because nothing about the run looked like a failure.** The fixture test also carried a configured commit identity for its throwaway repository. That identity landed in the shared config instead, and two genuine, already-pushed commits on two separate branches were authored under the test's fixture identity rather than the real author's. Both agents that produced those commits reported success — the commits landed, the push succeeded, nothing errored. The wrong authorship surfaced only from an independent sweep of commit authorship across every branch touched in that session, run afterward specifically because the repository-level symptom had already been found.

**How to apply:**
- Strip every relevant ambient environment variable from a spawned child before running a fixture or test that assumes it controls its own target — do not rely on the working directory to win against an inherited variable, because it does not.
- Pass the fixture's target location explicitly as a command-line flag to every operation inside the test, rather than depending on directory-based resolution at all.
- After any incident involving shared version-control configuration, audit commit metadata (author identity, committer identity) on every commit produced anywhere in the affected window — not just the working tree that showed the visible symptom. A clean working tree does not mean clean history.
- Repair wrong metadata with an acceptance test that proves content did not move: require the diff between the old branch tip and the corrected new tip to be completely EMPTY before any force-push that rewrites history, and push a verified backup ref first ([[commit-before-you-mutate-to-test]]).
- Never run a repository-mutating fixture test inside a tree that is also a live, shared checkout ([[never-test-in-a-live-deployment-tree]]).
- Closely related but distinct: [[neutralize-ambient-env-in-negative-tests]] covers clearing the ambient environment so a negative test's premise ("no environment is set") actually holds; this lesson covers an inherited variable redirecting a destructive operation onto the real system regardless of what the test intended to prove.
