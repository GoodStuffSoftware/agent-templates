---
id: enumerate-cleanup-candidates-from-both-sides
title: A cleanup tool that enumerates from one side misses everything whose other side is already gone
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A branch garbage-collection script had two blind spots that together made it a poor proxy for "which worktrees are reclaimable." It enumerated REMOTE branches only, so a worktree whose remote branch had already been deleted — while the worktree itself survived on disk, held open by a dirty tree or an open file handle — became permanently invisible to it and accumulated forever. And it judged mergedness by the remote branch's CURRENT tip rather than by the commit the worktree actually held, so a worktree sitting on an already-merged commit whose remote had since diverged with new unmerged work was misclassified in both directions.

**Why:** a cleanup tool's candidate set and its safety test are two separate questions, and both quietly assume the two sides — local objects and remote references — have stayed paired. They don't stay paired; that's exactly what makes cleanup necessary in the first place.

**How to apply:**
- Enumerate candidates from BOTH sides — the local objects (worktrees, branches, reflog entries) and the remote references — and treat anything present on one side only as a finding to investigate, never as absent.
- Classify by the object you actually hold as well as by the moving reference that names it, and treat disagreement between the two as a stop-and-check, not something to average away.
- Use "is this commit reachable from any surviving reference" as the definitive recoverability test, rather than trusting a backup reference's NAME to still point at what it once did.
- Note the structural limit: a cleanup tool that creates a backup reference for everything it removes cannot, by construction, reduce the total reference count — sweeping the backups themselves is a necessary separate pass, not something the original cleanup run will ever do for you.
- A large "unpushed commits" count on a branch that is an ancestor of a mainline branch is not risk by itself — those commits are already reachable elsewhere, via the mainline branch, so the count alone doesn't tell you anything is in danger of being lost.

Related: [[prune-by-exact-name-not-pattern]], [[check-the-merge-base-before-believing-a-deletion-count]], [[a-recorded-commit-id-dies-at-rebase]].
