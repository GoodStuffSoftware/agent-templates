---
id: verify-merge-direction
title: Verify merge direction before merging a long-lived branch
scope: [universal]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
Before merging a long-lived branch into the integration branch, confirm it isn't *behind* the integration branch. A branch that was cut a while ago and never updated can be an ancestor's worth of work behind — merging it as-is reverts whatever the integration branch shipped in the meantime.

**Why:** "Merge my branch" feels additive, but a stale branch carries old versions of files that have since moved forward on the integration branch. The merge silently rolls those files back. The damage is shipped work disappearing, which is the worst outcome on any project.

**How to apply:**
- Check the relationship first: is the branch behind, ahead, or diverged? (`git merge-base --is-ancestor`, a diff-stat against the integration branch, or your tool's equivalent.)
- If it's behind or diverged and you only need part of it (e.g. dev-config — see [[branch-what-deploys]]), **cherry-pick** the specific commits rather than merging the whole branch.
- Gate destructive or production-facing pushes on a diff-stat allowlist: confirm the diff contains only what you intend before pushing.
