---
id: staff-the-shared-layer-before-fanning-out
title: Disjoint-write fan-out duplicates the shared layer — staff it on day one, then make reuse a repo gate
scope: [agent-process]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A build was fanned out across {{N_PARALLEL_SEATS}} writer agents under keep-your-writes-disjoint orders — the correct instruction for merge safety, and the reason the branches never conflicted. It also silently produced a separate implementation of every repeated UI element: each seat wrote its own status dot, its own version tag, its own timestamp cell, because there was no shared layer to check and no brief told anyone to look before writing.

The gap is precise. Every brief said *build this from components*. Nothing said *reuse components across seats*, and disjointness actively discouraged it: a seat that imported another seat's file would have violated its own write boundary. Component-BASED was mandated; component-REUSE was nowhere.

**Why:** disjointness is a property of the write set, not of the design. Two agents told to stay out of each other's files will independently solve the same sub-problem, and each solution passes its own review because nothing in that review can see the sibling. The duplication is invisible until someone looks at the whole surface at once — by which time it is N implementations to reconcile, not one to write.

**How to apply:**
- **Staff the shared layer as its own seat, before the fan-out, not after.** One agent owns `{{SHARED_COMPONENTS_DIR}}` and lands the canonical elements first; the parallel seats consume them. This is the same ordering rule as [[ship-the-safe-handle-first]] — the correct path has to exist before the work that should take it.
- **When you are already duplicated, AUDIT before you fix.** An element-level audit seat produces the authoritative duplicate map first. Fanning out fixes against guesses re-diverges the tree — you get a second generation of near-identical components instead of one canonical set.
- **Consolidation is one seat, one canon, behaviour-identical swaps.** One component per element type; where two implementations genuinely disagree, resolve toward the reference surface and FLAG the disagreement rather than silently picking a winner — a silent pick is a design decision made by whoever refactored last.
- **Turn the rule into repo machinery, not review culture.** A registry-driven check script that fails when a covered element type is implemented outside the shared directory, when a covered type imports the raw primitive directly, or when a canonical component has zero usages. Wire it at every layer that can catch it — the lint chain, the local hooks, and CI — so a clone with no hooks installed is still gated ([[guard-coverage-enumerate-issuing-surfaces]]).
- **Land gates advisory, flip them blocking.** A check that fails the whole tree on day one gets disabled. Advisory while the canon is being built, blocking once it is the real source, is the sequence that survives.
- **The meta-rule: culture decays under agent turnover.** Every writer is a fresh context that never saw the conversation where the convention was agreed. A discipline that matters ends as a blocking check with its own selftests, or it ends.
