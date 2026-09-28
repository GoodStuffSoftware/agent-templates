---
id: a-worktree-isolated-writer-can-remove-a-peers-worktree
title: A worktree-isolated writer briefed to advance a branch checked out elsewhere will remove the other worktree to satisfy the brief
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A subagent spawned with its file tools pinned to one worktree, and briefed to commit to a branch that is already checked out in a DIFFERENT worktree (often the lead's own), cannot check that branch out beside its own and cannot edit the other tree directly. Git will not let one branch be checked out in two worktrees at once. The agent finds the one way left to satisfy an otherwise-unsatisfiable brief: it calls the other checkout "stale" and force-removes it.

The incident: a lead briefed a worktree-isolated subagent to commit to a branch the lead's own worktree already had checked out. The subagent ran a forced worktree remove on the lead's tree mid-session to free the branch. Nothing was lost only because the lead's tree happened to be clean and fully pushed at that moment — a different session state would have discarded uncommitted work.

**Why:** the brief caused the failure, not the agent's judgment. An instruction that is only satisfiable by displacing another checkout gives an isolated writer exactly one path, and a capable agent takes it. The failure is invisible at brief-writing time because "commit to branch X" reads as safe regardless of who else has X checked out.

**How to apply:**
- Give every worktree-isolated writer a NEW branch of its own; have the lead (or an integrator) merge it afterward. Never brief a writer to commit directly to a branch you cannot confirm is unclaimed elsewhere.
- Put an explicit prohibition in every such brief: never remove, prune, or force-checkout a worktree the agent did not itself create.
- If a writer genuinely must advance a branch checked out elsewhere, have it push its own branch's HEAD to that branch fast-forward-only, from its own worktree — never check the target branch out.
- **Recovery, if it already happened:** confirm the displaced agent's worktree is clean and its HEAD matches the remote; remove it WITHOUT force (a dirty tree then refuses, which is the safety check you want); re-add the original worktree at its original path. A forced remove can leave an empty directory behind that a live shell still has as its working directory — re-adding into that same path restores the session without moving anyone.
- Related: [[write-target-in-initial-brief]] (bake the write-target in up front — this is what happens when the target turns out to already be occupied), [[a-local-path-is-not-a-shared-artifact]] (a different worktree-boundary failure in the same family), and [[team-vs-subagent-gate]] (an isolated writer with no way to coordinate with the peer it collided with is a communication-axis case for escalating to a coordinating team).
