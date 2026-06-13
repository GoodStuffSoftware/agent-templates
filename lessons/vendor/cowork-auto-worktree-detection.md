---
id: cowork-auto-worktree-detection
title: Detect and abort when a writer agent lands in a Cowork auto-generated worktree
scope: [vendor:anthropic]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
Some Claude Desktop configurations auto-spawn writer agents into a "Cowork" worktree with a path matching `.claude/worktrees/<adjective>-<noun>-<hex>` and a throwaway branch named `claude/<adjective>-<noun>-<hex>`. Work committed there never reaches the intended integration branch. Writer agents must detect this condition on their first diagnostic and abort rather than commit to the throwaway branch.

**Why:** An agent that commits work to a Cowork auto-branch and reports "done" has produced commits that are unreachable from any real branch. The orchestrator sees a green report; the work is silently gone. Recovery requires finding the throwaway branch, cherry-picking the commits, and re-running any post-commit checks — it is often cheaper to redo the work entirely.

**How to apply:**
- The writer agent's first-action diagnostic (per [[first-action-read-only]]) checks `pwd` and `git branch --show-current`. If the path contains `.claude/worktrees/` or the branch matches `claude/<adjective>-<noun>-<hex>`, the agent must report "wrong worktree" to the lead and wait — it must NOT commit anything.
- The orchestrator's recovery: create the correct canonical worktree, then re-brief the agent (or re-spawn it) pointing at the right path.
- Add this check to writer-agent templates as a named gotcha alongside the first-action read-only rule.
