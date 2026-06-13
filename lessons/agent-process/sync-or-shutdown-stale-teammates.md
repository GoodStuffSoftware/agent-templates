---
id: sync-or-shutdown-stale-teammates
title: After invalidating a teammate's world, sync it or shut it down before it reports stale state
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1, contrib-2]
corroborated: 2
---
When an orchestrator action invalidates a teammate's cached view of the world — you merged and removed its worktree, restarted or moved a server it was using, moved the branch it was on — immediately tell that teammate what changed, or shut it down. Do it *before* the teammate sends its next report.

**Why:** A teammate operating on a stale world model sends a now-false report ("still in worktree X, not pushed") after you already merged and removed X. That contradicts what you just told the user and forces a confusing reconciliation. The teammate isn't wrong from its own view — its view is stale because you changed the world under it.

**How to apply:**
- The moment an orchestrator action invalidates a teammate's assumptions, sync it (tell it exactly what changed) or shut it down.
- Don't let an invalidated teammate run another turn and report first.
- Pairs with [[write-target-in-initial-brief]]: many invalidations are worktree/branch moves.
