---
id: derive-at-read-time-over-storing
title: Derive a state that is already implied by stored data at read time — don't write it back
scope: [universal]
status: active
since: 2026-08-03
provenance: [contrib-2]
corroborated: 1
---
When a status, badge, timeline step, or rollup can be computed from data the system already holds, compute it fresh on every read rather than writing it into a column. The stored alternatives all cost more: writing the derived value back on read makes reads mutating, and a migration backfilling a new column adds schema work plus a permanent reconciliation problem.

The instance: an in-progress status and its derived timeline step were implemented as a read-time derivation over the stored row plus live signals, matching an existing precedent in the same codebase where presence was derived and never re-stored. No migration was needed, the value cannot go stale, and an explicit status set later by a participant trivially wins with zero reconciliation logic. Reversal is deleting two functions and their call sites — nothing was written anywhere.

**Why:** A stored derived field creates a second source of truth that must be kept in sync forever, and every write path that touches the inputs becomes responsible for it. A read-time derivation has no such obligation: it is correct by construction, it is free to change shape later, and it makes the feature genuinely reversible — which is what lets you ship it without a decision-maker present.

**How to apply:**
- Look for the codebase's existing precedent first. If some neighbouring value is already derived rather than stored, follow it; consistency here is worth more than a marginal performance argument.
- Reserve stored derived fields for cases with a measured read cost you cannot pay, and then treat them as a cache with an explicit invalidation owner — not as data.
- An explicitly-set value must beat the derivation, and that precedence should be one line, not a reconciliation routine.
- **Verify against real data AND a synthetic precondition.** A derivation that fires zero times on the production set is not thereby broken — check whether its precondition is currently satisfied anywhere, and separately demonstrate the mechanism against a constructed case that does satisfy it ([[match-instrument-to-failure-class]]). Reporting "0 occurrences, so it works" and "0 occurrences, so it's broken" are equally unverified.
- Prefer the shape whose reversal is "delete the code" when you are deciding without the owner present ([[no-stall-decision-protocol]]).
