---
id: check-the-merge-base-before-believing-a-deletion-count
title: A diff against a base that moved renders missing commits as deletions — check the merge base before accusing anyone
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Diffing a feature branch against an ADVANCED integration tip showed roughly 2,400 deletions spread across unrelated subsystems — a diff that reads exactly like a worker having destroyed half the repository. The true diff, computed against the actual merge base, was 42 deletions. The branch was fine. The comparison was wrong.

**Why:** a two-dot diff against a moved tip reports everything the tip gained since the branch forked as something the branch LOST. The size of that phantom deletion count scales with how far the base has advanced since the branch was cut — which is largest exactly when a review is most overdue, so the worst-looking diffs are the most likely to be spurious.

**How to apply:**
- Compute the merge base explicitly (`git merge-base`) and diff against it, or use the three-dot diff form, before quoting any deletion or change count to anyone.
- Treat a deletion count that spans subsystems the branch never touched as evidence the base moved, not as evidence of damage — a real destructive change is usually concentrated in files the branch's own commits mention.
- In a multi-agent setting, verify the base before reporting a teammate's work as destructive. The accusation is expensive, hard to walk back cleanly even after a correction, and erodes trust in ways a quiet "I was wrong, here's the real diff" doesn't fully repair.

Related: [[enumerate-cleanup-candidates-from-both-sides]], [[verify-merge-direction]], [[scope-a-broken-finding-to-the-measured-path]].
