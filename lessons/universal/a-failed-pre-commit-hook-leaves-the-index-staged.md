---
id: a-failed-pre-commit-hook-leaves-the-index-staged
title: A failed pre-commit hook leaves the index staged, so the next commit lints a stale copy — reset before re-staging
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A failed `git commit` aborts the commit but unstages nothing. That is usually harmless, but it interacts badly with staged-file hook runners (`lint-staged` and equivalents), which deliberately check the STAGED snapshot rather than the working tree.

The sequence: (1) `git add` some files and commit; a hook fails on a lint error. (2) Fix the error in the working tree. (3) `git add` a *different* file and commit again. (4) The hook fails on the same error, because the broken file from step 1 is still staged and the runner is checking that stale snapshot, not your fix.

The symptom misdirects: the reported error no longer exists in any file you can open, so the natural readings — "the hook is broken" or "the fix did not work" — are both wrong.

**How to apply:**
- **Run `git reset` with no paths before re-staging.** It clears the index and leaves the working tree untouched, so the next `git add` stages the corrected content. Re-add deliberately rather than assuming the previous staging is still what you want.
- **Treat a hook failure as invalidating the index, not just the commit.** An agent committing in logical groups stages a subset per commit — exactly the workflow this bites.
- **Never resolve a repeat hook failure with a skip flag** (`--no-verify`): the hook is reporting real staged content, and skipping it commits the broken snapshot.
- **Avoid `git stash` as the reflex cleanup:** the stash stack is shared across worktrees and concurrent sessions, so a stash/pop can capture or restore someone else's work. `git reset` touches only your index.

Related: [[commit-before-you-mutate-to-test]], [[a-read-that-opens-an-edit-is-a-write]].
