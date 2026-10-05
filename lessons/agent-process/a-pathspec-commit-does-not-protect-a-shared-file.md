---
id: a-pathspec-commit-does-not-protect-a-shared-file
title: A pathspec commit protects other files, not the same file — the unit of collision is the file, and the orchestrator is also a writer
scope: [agent-process]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Twice in one session, to the ORCHESTRATOR in two repos: a staged deletion belonging to one actor was swept into a subagent's unrelated code commit (`git add paths && git commit` commits the whole index), and a path-scoped commit of a shared notes file picked up three other sessions' draft entries, because they were edits to the same file. Switching to `git commit -- <path>` fixed the first and not the second.

**Why:** commit-scoping tools cannot separate two editors of one file. "One writer per worktree" is usually applied to spawned writers; the lead editing a "small, unrelated" doc in the same tree breaks it just as badly, and docs feel safe when they are not.

**How to apply:**
- **One writer per worktree includes the orchestrator:** do not edit or stage anything in a worktree while a writer agent is live in it.
- **Before any commit in a shared tree, run `git status --porcelain` and account for every line.** An entry you did not create is someone else's work: hold, ask, or commit it deliberately with an honest message.
- **Reviewers sharing a tree are read-only:** no stash, reset, checkout of paths, or clean. For a replaced writer, confirm the old one has terminated before the new one enters the tree, or give it its own worktree ([[a-completed-background-agent-may-only-be-paused]]).

Related: [[first-action-read-only]], [[write-target-in-initial-brief]].
