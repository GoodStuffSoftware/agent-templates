---
id: shared-sequential-id-needs-one-allocator
title: A live check against the trunk cannot allocate a shared sequential id — prefer a non-colliding identifier or one integrator
scope: [universal]
requires: {}
status: active
since: 2026-08-10
provenance: [contrib-2]
corroborated: 1
---
Four unmerged branches, written by three authors in parallel, independently claimed the SAME sequential decision-record number. Every one of them did the correct thing: fetched the current trunk, grepped the register, found the real maximum, incremented. Every one of those checks was right and every one was insufficient, because **a check against the trunk cannot see another branch that has not merged.** Resolution cost several coordination round-trips and one author renaming nine references across seven files. A fifth branch had already burned the same lesson earlier — it carried a number that had been taken by unrelated work while it sat shelved.

**The reusable kernel:** any monotonically-allocated shared identifier — decision/ADR numbers, migration ordinals, fixture ports, feature-flag slots, error codes — cannot be safely allocated by reading the trunk when work happens on concurrent branches. The check is necessary, not sufficient, and nothing local can answer "is this free" until merge time.

**Why it evades review:** each branch is individually correct and passes its own gates. The conflict does not exist in any single tree — it comes into being only at merge, and only if someone happens to be looking at both.

**How to apply:**
- Treat trunk-derived allocation of a shared sequential id as a **conflict-prone guess**, not a decision. It is the right first step and it does not settle the question.
- Prefer identifiers that **cannot collide**: a slug, a date-stamp, a content hash, or an id minted from a single authority. Sequential integers are a shared mutable resource wearing the costume of a constant.
- If sequential numbering is required (readability, an existing corpus), have **one integrator allocate** — the only actor who can see every branch at once. Authors propose; the integrator assigns. This is the same shape as [[one-canonical-deployer]] and [[version-bump-at-integration]].
- Cheap mitigation when neither is possible: **re-verify immediately before push, not only at authoring time**, and sweep every branch rather than the trunk alone (`git log --all`, or a per-branch grep). This narrows the window; it does not close it.
- **Record the renumbering history in the artifact itself.** An entry that silently changed number twice looks authoritative and is uncitable — anything that referenced the old number now points nowhere. One line naming the prior numbers is what makes a late renumber safe ([[correct-a-durable-record-explicitly]]).
- Reviewer prompt: "could two branches in flight both be right about this value?" If yes, it is not a value to derive locally.
