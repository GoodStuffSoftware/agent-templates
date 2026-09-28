---
id: gate-review-rounds-on-blocking-findings-not-round-count
title: Gate each new review round on whether the PREVIOUS verdict had blocking findings, never on a round count
scope: [agent-process]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A fixed cap on review rounds ("three rounds, then stop") either stops a worker that is genuinely closing in on a real defect, or lets three rounds of cosmetic re-review through untouched — a round count has no relationship to whether the rounds are doing anything.

The incident: an audit of multi-agent review loops found churn driven by exactly this: rounds continuing past the point where the previous verdict had already cleared every blocking finding, and rounds stopping (by hitting a cap) while a real defect was still open. Neither outcome is what a round cap is meant to produce.

**Why:** a round count measures elapsed effort, not remaining risk. The signal that actually distinguishes "still finding real problems" from "just cycling" is available for free in the previous round's own verdict — whether it named anything blocking — and in the shape of the diff between rounds.

**How to apply:**
- Gate a new review round on whether the PREVIOUS verdict had any blocking findings. No blocking findings → the review is done, regardless of how few rounds ran. Blocking findings still open → another round is warranted, regardless of how many rounds already ran.
- Treat a comment-only or cosmetic diff between rounds, or a writer messaging its reviewer directly to reopen a review the reviewer had already closed, as the churn signal to stop on — not as grounds for another round.
- When a real, unsolved problem survives an honest round, escalate UP a tier (model first, then effort) rather than running another round at the same tier with the same brief; route that escalation through any fan-out/premium cap that governs tier changes rather than around it.
- Log an independent outcome for "done" — merged, a gate went green on the target, or accepted by the requester — rather than trusting a worker's or reviewer's own self-reported "pass".
- Related: [[re-inject-a-standing-rule-from-a-hook]] (the sibling finding from the same audit: written review doctrine gets skipped without a hook-level enforcement point), [[peer-to-peer-review-routing]], [[reviewer-matches-the-tier-it-reviews]].
