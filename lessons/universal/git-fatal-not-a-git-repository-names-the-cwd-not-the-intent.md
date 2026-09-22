---
id: git-fatal-not-a-git-repository-names-the-cwd-not-the-intent
title: "git's \"not a git repository\" names where the command ran, not which repo you meant"
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms: [not a git repository (or any of the parent directories)]
sessions: 29
---
`fatal: not a git repository (or any of the parent directories): .git` means git walked up from the CURRENT WORKING DIRECTORY and never found a `.git` entry (a directory for an ordinary checkout, a file for a worktree). Measured at 29 distinct sessions across 24 projects — reliably recurring because the cause is almost never "there is no repository," it is "the command ran somewhere other than where the repository is."

**Why:** the message reports the search's outcome, not its starting point, so it reads like "there is no repository" when the far more common real cause is that the shell's `cwd` was never inside one to begin with — a command run before a `cd` completed, a subshell or subprocess that inherited a different working directory than intended, a script invoked from outside the checkout, or a directory that was deleted and recreated (a fresh directory of the same name has no git history at all, even though "the project" still looks present).

**How to apply:**
- Before concluding the repository is missing or corrupted, print the actual `cwd` the failing command ran in (`pwd`, or the equivalent in the calling process) — the mismatch is usually here, not in git's state.
- When git is invoked from a script or a subprocess, prefer passing an explicit repository path (`git -C <path> ...`) over relying on an inherited `cwd` — this removes the whole class of "which directory was I actually in" bugs.
- A directory that looks right by name can still be a fresh, un-initialized copy (e.g. after a clean re-clone into the same parent path) — `git rev-parse --show-toplevel` from inside it settles whether a real repository is actually there.
