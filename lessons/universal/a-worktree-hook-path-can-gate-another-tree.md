---
id: a-worktree-hook-path-can-gate-another-tree
title: A worktree whose hooks path points at another checkout runs that checkout's pre-push gate against that tree
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
Tools that create linked worktrees can set `core.hooksPath` (in the worktree config) to an ABSOLUTE path inside the main checkout. A pre-push hook that derives its repo root from its own location then runs the main checkout's scripts and test suite against the main checkout's working tree: stale, possibly dirty, and never the commit being pushed. Two failures follow: red gates that come from code you did not push (the same file passes on your SHA), and green gates for code that was never tested.

**How to apply:**
- Suspect it when a pre-push failure does not reproduce on the pushed commit. Run `git config --show-origin core.hooksPath` and read the gate's "tested SHA" or tree line.
- One-off fix, no hook skipped: `git -c core.hooksPath=.githooks push`, a RELATIVE path that resolves to the worktree's own hooks. Do not edit the worktree config or push from a main checkout carrying someone else's uncommitted work.
- Durable fix: the hook resolves its root from `git rev-parse --show-toplevel`, or the gate tests the pushed SHA.

Related: [[a-checkout-is-not-the-running-system]], [[never-test-in-a-live-deployment-tree]].
