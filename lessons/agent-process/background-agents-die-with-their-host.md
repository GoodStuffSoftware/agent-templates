---
id: background-agents-die-with-their-host
title: A background agent is a child of its host process — long work runs in an independent session and pushes within minutes
scope: [agent-process]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
Five parallel background workers — one holding a local worktree, four in remote sandboxes, carrying hours of build scope between them — were lost in one moment when the orchestrating session's host application restarted between turns. None had pushed. Zero work survived, and there was nothing to recover from: no branch, no report, no partial diff.

The mistaken premise was that "remote" meant "independent". It does not. An agent spawned as a background task by an orchestrator session is a child of that session's host process regardless of where its compute runs, because the thing that holds its lifecycle is the parent's process, not the sandbox. And a long-lived, wake-driven orchestrator is exactly the kind of session whose host gets restarted routinely — updates, crashes, the operator closing a window.

**Why:** the harness's completion notification trains you to treat a spawned worker as durable. It is a convenience, not a contract. Everything a worker holds in memory or in an unpushed working tree is as durable as the parent process, and the parent process is not durable at all.

**How to apply:**
- **Match the container to the duration.** Work expected to run beyond ~15 minutes goes in an INDEPENDENT session — a user-started task, a standing session, a queued job — never a parented background agent. Short, self-contained work is what background agents are for.
- **Order a push within minutes, then a push per step.** Every long worker's brief says: create the branch and push a WIP commit before doing anything substantive, push after each step, and write the final report INTO the branch (a file), not only into a message ([[teammate-reports-to-files]]).
- **Pair a long worker with a durable collector.** A reviewer session watching the remote, or a durable message inbox the worker writes to, so finished work is picked up even when the worker and the lead both die. Anything whose only delivery path is a live parent is a single point of failure with no alarm.
- **When the parent dies, the remote is the only evidence.** Recovery starts with enumerating remote branches, not with asking the workers — see [[check-before-duplicating-a-peers-work]] for the same enumeration used to avoid the opposite mistake.
- Related: [[handoff-doc-live-state]] (keeping the live state where a successor can find it).
