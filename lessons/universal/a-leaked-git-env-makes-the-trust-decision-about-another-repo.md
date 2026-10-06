---
id: a-leaked-git-env-makes-the-trust-decision-about-another-repo
title: A leaked GIT_DIR makes the trust decision about a different repository — scrub at every boundary that produces a recorded value
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A function deciding whether a test result may be recorded shells out to git. Run from a git hook, it inherited `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` from git itself, so a test using a temp-dir fixture repo silently queried the REAL worktree and reported "tracked files modified" where "clean" was correct. A four-way experiment (hook version old/new x env clean/poisoned) showed exactly one failing cell: old code with a poisoned env. Git resolves a repository from those variables even when invoked from `/`.

**Why:** a leaked git environment does not add noise, it changes which repository every git call *means*. Hook-spawned test suites then corrupt or misjudge the repo that invoked them, and the failure looks environmental or flaky.

A second round found the scrub existed as a helper and the hook unset the variable family first, but the git calls that produced the values actually BANKED (pinned sha, tree, branch) had no scrub of their own. Under a leaked repository-pointing variable the dirt invariant would be proven about worktree B while the ledger banked repo A's tree hash. They were safe only because the caller scrubbed — posture, not guarantee.

**How to apply:**
- **At the top of every hook that spawns tests or trust-deciding code:** `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_QUARANTINE_PATH`. That is load-bearing, not hygiene.
- **Scrub at each module's own boundary**, especially calls feeding a record or a write; a mix of scrubbed and unscrubbed calls in one flow is the bug. Document deliberate exceptions at the call site (a push needs the env).
- **Measure which variables your hook runner exports** instead of assuming: in the measured case a plain checkout's pre-push hook exported none of the family, while a linked worktree exported exactly the git-dir variable, enough to cause an earlier machine-wide config-flip incident.
- **Prove the fix by running the real hook with identical stdin under both a clean and a poisoned environment.**

Related: [[an-inherited-env-var-beats-the-child-cwd]], [[neutralize-ambient-env-in-negative-tests]], [[tests-must-not-write-machine-global-or-live-process-state]].
