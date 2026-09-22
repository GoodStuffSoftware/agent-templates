---
id: a-deleted-cwd-still-answers-until-a-child-process-uses-it
title: A shell can keep running after its working directory is deleted — the failure surfaces one command later, in a child process, not at the delete
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms: [cannot change to]
sessions: 12
---
`fatal: cannot change to '<dir>': No such file or directory` is git's (and equivalently, any `-C`/`--cwd`-style flag's) way of reporting that the directory it was told to run in no longer exists. This shows up specifically in agent-driven workflows: a worktree, a temp directory, or a scratch checkout gets removed by one step (cleanup, a `--fix` pass, another agent finishing its own task) while a *different* still-running shell or subprocess is still positioned inside it, or still holds that path as a variable. The shell itself does not error at the moment of deletion — POSIX and Windows both let a process keep running with a deleted working directory — so the failure surfaces later and elsewhere, on the next command that actually needs the directory to exist, in whichever process happens to run it. Measured at 12 distinct sessions across 11 projects.

**Why:** because the deletion and the failure are separated in time and often in process, the failing command's own output gives no hint that the real event was "something else removed my working directory a moment ago" — it reads like an ordinary bad-path typo, and the natural first instinct (double-check the spelling, retry the same command) does nothing, since the directory is genuinely gone.

**How to apply:**
- In a multi-agent or multi-process workflow, treat "which process currently has a working directory inside this path" as state that must be tracked before removing it — a worktree cleanup step should confirm nothing is still using the worktree, not just that its own task is done.
- When this fires, check recent activity for a deletion/cleanup step (a `git worktree remove`, an `rm -rf`, a temp-directory sweep) that ran concurrently or just before, rather than assuming the path was always wrong.
- Prefer passing an absolute, freshly-resolved path into a subprocess over relying on an inherited `cwd` that was set once, earlier, and may no longer be valid by the time it is used.

Related: [[background-agents-die-with-their-host]] (a different face of the same class of problem: a process's environment can stop being valid out from under it, for reasons invisible from inside that process).
