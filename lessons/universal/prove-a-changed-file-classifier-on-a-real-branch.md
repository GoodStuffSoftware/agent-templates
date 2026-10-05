---
id: prove-a-changed-file-classifier-on-a-real-branch
title: A changed-file classifier decides gate cost — run it on a real rebased branch and classify the whole branch, not the tip
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
A pre-push classifier picks the test subset from `git diff --name-only <base>` with base `@{u}`. Reading its source plus a live diff against a backup ref suggested that after a rebase `@{u}` goes stale and every rebased branch becomes "run everything". That was told to a release coordinator and was **false**: worktrees created from the shared integration ref track that ref as their upstream, which re-converges with the merge base after rebasing onto it. Running the classifier itself on a genuinely rebased branch settled it in one command. (The stale-ref case does exist for branches pushed under their own name.)

Two more traps in the same classifier: diffing only the tip commit lets a branch whose last commit is docs-only classify as "skip" although an earlier commit changed production code (caught only by a fail-closed gate at merge); and any dependency-manifest change beyond scripts/version, or a lockfile change, forces the full suite, so gate cost depends on the file list, not on how code-like the branch looks.

**How to apply:**
- **Settle a theory about a tool by running the tool on a real case** before telling anyone.
- **Check what the base ref resolves to per branch:** `git rev-parse --abbrev-ref --symbolic-full-name @{u}`.
- **Classify the whole branch against the merge base**, never the last commit.
- **Match authority carefully:** a per-worktree marker file and a machine-global ledger answer different questions; quote the authoritative one or say you do not know. A content-keyed store (keyed by tree hash) overwrites the older commit's slot when two commits yield identical trees, so searching it by commit sha can miss a commit that was genuinely tested; match by both.

Related: [[check-the-merge-base-before-believing-a-deletion-count]], [[a-guard-that-reads-ambient-state-is-not-reading-the-target]], [[read-which-error-fired-before-theorising]].
