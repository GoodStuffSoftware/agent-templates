---
id: a-completed-background-agent-may-only-be-paused
title: A "completed" agent that ran background commands may only be paused — never spawn a second writer onto the same worktree
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A lead saw a background worker listed as "completed" while its task (merging a pull request) was unfinished, took that as "ended", and spawned a replacement for the same pull request. The first worker had only paused: a background command it had started (a CI watch) finished later and re-invoked it. Both then worked the same pull request in the same worktree at once, one starting the merge and the other finding it "half-done". The outcome was correct only by luck.

**Rule.** "Completed" on a subagent that ran background commands means its turn ended, not that its work is over, and a finishing background command wakes it again. Before spawning a replacement for the same write target, do one of:
- stop the old agent and confirm it stopped;
- message it to stand down and wait for the acknowledgement;
- check the state of the pull request or branch, and give the replacement a *different* worktree path.

Never give two live agents the same worktree path.

**Second gotcha, same run:** a bare `npx {{TEST_RUNNER}} run` in a freshly created worktree resolved a different runner version from the npx cache and crashed on a missing peer dependency. Use the repo's own test script, or run after a clean dependency install inside that worktree.

Related: [[background-agents-die-with-their-host]], [[a-worktree-isolated-writer-can-remove-a-peers-worktree]], [[write-target-in-initial-brief]].
