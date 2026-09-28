---
id: git-status-cannot-see-a-pending-renormalisation
title: git status cannot detect a pending line-ending renormalisation
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A repository that copies files in verbatim added a `.gitattributes` under `core.autocrlf=true`. Its safety gate for "will this touch any files I didn't mean to touch" was `git status --short`, stop if anything besides the new `.gitattributes` shows as changed. The gate came back clean — only the new, untracked `.gitattributes` appeared. A direct comparison of real bytes against the stored blobs, run out of caution rather than because the gate raised anything, found 11 tracked files whose stored bytes already differed from the real working-tree bytes: CRLF-native files that had silently been stored CR-stripped.

**Why:** `git status` and `git diff` both compare through git's content filters (the pair `core.autocrlf` installs), and `git status` additionally trusts its stat cache (size + mtime) before it even decides to re-read a file. Adding or editing `.gitattributes` invalidates neither, so both commands can be confidently wrong about whether the stored bytes match the real bytes: a file can report clean while its raw bytes differ from its committed blob (stale stat cache never re-triggered the read), and a file can report modified while `git diff` shows no hunks at all, because `autocrlf` converts the working copy back before comparing, masking the very difference in question. A gate written as "`git status --short`, stop if anything unexpected shows" is not merely weak here — it is structurally unable to answer the question it was asked.

**How to apply:**
- When the question is "do the stored bytes equal the real bytes," never ask `git status` or `git diff`. Ask `git hash-object --no-filters <path>` against the blob hash `git ls-files -s <path>` already recorded — equivalently, diff `git show HEAD:<path>` against the raw file bytes. Neither side runs a content filter, so the comparison answers "do the stored bytes equal the real bytes" instead of "do the filtered views match."
- When adding or changing line-ending policy (`.gitattributes`, `core.autocrlf`) in a repository that already has history, expect the next commit to contain a correction for every file the old filtering had been silently altering — say so in that commit's own message up front, or it reads as a mystery diff later.

This is a different mechanism from [[normalize-before-declaring-difference]] (comparing two separate copies for equality after normalizing line endings) — here the concern is that git's OWN status/diff tooling cannot see a pending renormalisation within a single repository at all, not that a raw comparison needs normalizing.

Related: [[normalize-before-declaring-difference]], [[content-guard-honors-gitignore]].
