---
id: commit-before-you-mutate-to-test
title: Commit first, mutate after — never revert a deliberate mutation with a checkout on a file that carries uncommitted work
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-2]
corroborated: 1
---
Deliberately breaking code to prove a check can catch it — mutation testing, canary runs, "does this guard actually fire?" — ends with an undo step. The natural undo is a checkout of the file from the index or HEAD. That command does not distinguish *your mutation* from *your unrelated in-flight edits to the same file*: it discards both, silently and unrecoverably.

Learned twice in one night, two self-inflicted wipes of in-flight work.

**Why:** The mutation feels like a small, isolated, obviously-temporary edit, which frames the undo as small and obviously-safe. But the mutation shares a file with real work, and the undo is file-scoped, not edit-scoped. There is no warning, no conflict, and no reflog entry for a working-tree discard — the loss is invisible until you go looking for the work that is no longer there.

**How to apply:**
- **Commit (or stash) the real work BEFORE introducing the mutation.** Then the undo has nothing to destroy, and a discarded working tree is exactly the intended state.
- If you must mutate over uncommitted work, undo by **reversing the specific edit** (re-apply the original text) rather than by discarding the file.
- Never point a working-tree discard at a path you have not just checked for other modifications. `git diff -- {{PATH}}` before the discard costs a second and is the whole safeguard.
- The same rule covers any tool that "resets to clean": a clean-tree command, a branch switch with `--force`, a formatter run with `--write` against generated input. Ask what else in that path is uncommitted.
- Related: [[correct-a-durable-record-explicitly]] for the paperwork after a loss. Where the mutation exists to prove a guard fires, [[fail-open-on-the-action-never-on-the-record]] and [[a-silent-guard-needs-a-canary]] explain what you are actually testing.
