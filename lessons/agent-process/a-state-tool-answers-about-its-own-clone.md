---
id: a-state-tool-answers-about-its-own-clone
title: A repo-state tool that reads its own clone reports absence and staleness that describe the tool, not the repo
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A hosted branch-status tool reported the integration branch's tip as hundreds of commits behind origin and listed neither of two branches that were live local worktrees. Both readings looked authoritative and alarming; both described the tool's own stale clone. The genuinely urgent finding, established only from the primary repo, was the opposite shape: one branch carried 29 commits that existed only on local disk, on no remote.

**Why:** tools answer a narrower question than their output implies. Absence from their listing and a large "behind" number are artifacts of WHICH repository they read. A sibling tool that enumerates only remote branches has the mirror-image blind spot.

**How to apply:**
- **When a tool reports repo state, ask which repo and when it last fetched** before acting on it.
- **Verify against the real repo:** `git ls-remote origin refs/heads/<b>` for what exists on the remote, `git worktree list` and `git branch` for local. Look specifically for local-only commits before declaring a branch gone.
- **Back up (push a backup ref) before any remedial action prompted by such an alarm.**

Related: [[a-checkout-is-not-the-running-system]], [[a-re-injected-file-marked-current-is-still-a-snapshot]], [[verify-at-destination-prove-the-target]].
