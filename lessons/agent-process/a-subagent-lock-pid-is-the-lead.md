---
id: a-subagent-lock-pid-is-the-lead
title: A subagent worktree lock names the lead session's process, not the worker's — it outlives the worker, and it is not yours to stop
scope: [agent-process, vendor:anthropic]
requires: { harness: claude-code }
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
A worktree created for a subagent can be locked with a reason like "agent {{ID}} (pid {{N}})". That pid is the session's own agent-CLI process (a child of the desktop host), not the worker's: subagents run in-process, so the pid stays alive after the worker ends and the worktree looks in use for ever.

**How to apply:**
- Before unlocking, confirm the pid is in your own shell's parent-process chain.
- Then `git worktree unlock` and `git worktree remove`, without `--force`.
- Never stop that pid: it is the lead.

Measured twice in one day.

Related: [[a-worktree-isolated-writer-can-remove-a-peers-worktree]], [[a-completed-background-agent-may-only-be-paused]].
