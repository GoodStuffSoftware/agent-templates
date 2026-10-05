---
id: a-commit-hook-formatter-rewrites-the-bytes-you-verified
title: A formatter in the commit hook changes the bytes after your verification — the committed content was never tested
scope: [universal]
requires: {}
status: active
since: 2026-10-05
provenance: [contrib-2]
corroborated: 1
---
Lint-fix and format-write steps in a pre-commit hook modify staged files. Any build, lint or test run before committing therefore covered the pre-hook bytes, not the committed ones. Nobody changed anything; the hook did, which is what makes the staleness invisible. It is the same gap as verifying at one commit and shipping another, with a mechanism that hides it.

**Why it matters:** verification and artifact diverge at the last step, and the divergence is usually tiny (whitespace, quote style) so it is assumed harmless — until a fixer touches something semantic or an auto-fix interacts with a generated file.

**How to apply:**
- **Where a claim matters** (a build about to ship, a test count in a report), rebuild or re-test from a clean checkout at the committed sha, not from the working tree you edited.
- **Run the same formatter or fixer manually before the verification run**, so the verified bytes equal the committed bytes, and confirm `git diff` is empty afterwards.
- **After committing, `git show --stat HEAD`** and compare against what you meant to commit.

Related: [[verify-at-destination-prove-the-target]], [[a-failed-pre-commit-hook-leaves-the-index-staged]], [[a-checkout-hook-makes-a-fresh-tree-dirty]].
