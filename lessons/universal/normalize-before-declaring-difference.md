---
id: normalize-before-declaring-difference
title: Normalize line endings before calling two copies different — and archive rather than delete when you act on the answer
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Installing a vendored package that ships the same content already hand-copied into a user-level directory: a naive per-file hash comparison reported all 11 shared directories as DIFFERING, which reads as "the local copies were customized — don't touch them." Re-comparing after normalising CRLF to LF showed 10 of the 11 were byte-identical in content; the hashes differed only because the hand-copied set had been checked out on a platform that rewrites line endings. The 11th was genuinely different (32 files vs 13, plus real content diffs) and was the only one worth preserving.

Deleting on the raw-hash signal would have kept 10 stale unmanaged shadows. Trusting a file-count-only check would have destroyed the one real customization.

**Why:** on any cross-platform checkout, *content equality* and *byte equality* are different questions, and the destructive decision hangs on the former. This applies to any dedupe, supersede, or migrate step comparing a vendored copy against a local one.

**How to apply:**
- Before deleting a local copy because a managed/vendored one supersedes it, compare on NORMALIZED content (`git diff --ignore-cr-at-eol`, `diff --strip-trailing-cr`, or read-and-replace in your shell). A raw hash mismatch on a line-ending-rewriting checkout usually means line endings, not edits.
- **Use two independent signals, not one.** *File-set difference* (extra or missing paths) answers "was this extended?"; *normalized content difference* answers "was this edited?" Either one non-zero means stop and inspect. Both zero means safe to supersede.
- **In a tree with no version history, cleanup RELOCATES — it never deletes.** A configuration or state directory that is not a repository has nothing to recover from. Move to a timestamped sibling (`{{DIR}}.archive-{{YYYY-MM-DD}}/`), verify first that nothing unique is at risk, and report the archive path in the same message as the removal. A reversible destructive step still has to be *findably* reversible.
- **Leave recent, unreferenced infrastructure alone while its area is mid-refactor.** "Referenced by nothing" is a strong signal in a settled tree and a weak one in a moving one; pulling a file out from under an in-flight change buys tidiness and costs a debugging session.
- **Report the per-item verdict, not an aggregate.** "10 identical, 1 differs, here is what is extra in that one" is actionable; "the directories differ" is what produces the wrong decision.

Related: [[match-ids-not-dates]] and [[scope-a-broken-finding-to-the-measured-path]] — same family: a plausible proxy standing in for the quantity actually being asked about.
