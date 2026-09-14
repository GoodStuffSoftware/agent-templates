---
id: stack-work-behind-a-serialized-gate
title: Stack related branches under one gate when the gate is the bottleneck — and always when one opens a hazard the other closes
scope: [universal, stack:git]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
When landing runs through a single serialized gate — one integration runner, a full suite per attempt, tens of minutes per run — the gate, not the review, is the bottleneck. Two rules follow, one economic and one safety-critical.

**Economic: stack a small reviewed change under a larger reviewed branch so one gate lands both.** Keep them as distinct commits so the history still reads as two changes. This is only legitimate for changes that have each been reviewed on their own; stacking is a batching decision about the gate, never a way to smuggle an unreviewed change through with a reviewed one.

**Safety-critical: when one change opens a window and another closes it, they must land in the SAME release.** A change that adds a server-trusted field and the verifier that proves the field is protected are not two work items; splitting them across releases leaves a live gap for exactly as long as the second one waits ([[under-a-denylist-deploy-order-is-a-security-property]], [[ship-the-safe-handle-first]]).

Observed in practice: follow-on work from one feature had been split into three separate tracking items, to land as three branches. Two of them were the guard for the hazard the first one introduced, and a third pinned an assumption the first one's own documentation leaned on. All three were folded back onto one branch. The tell was the question *"why are there more items?"* — proliferation of tracking items after a review is often evidence that one change was cut along the wrong seam.

**How to apply:**
- Before splitting follow-on work into separate items, ask for each: *does this close a window the other opens?* If yes, it is the same change.
- Run related work as one effort with one integration, not as serial one-shots.
- When stacking for cost, record which branch is the base, and reconstruct from backup refs rather than re-triggering blindly if the gate refuses.
- Rebase each stacked source onto the CURRENT integration tip immediately before triggering — every landing moves the tip ([[promoter-strategy-must-match-target-history]]).

Related: [[clean-conflict-map-not-safe-ordering]], [[deploy-sequencing-tests-first]].
