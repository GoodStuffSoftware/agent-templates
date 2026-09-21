---
id: a-condition-never-binding-fires-always
title: An anomalous count can be a property of the data, not of the actor — check whether the emitting condition is trivially satisfiable
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Before attributing an anomalous rate to an actor, ask what fraction of events would satisfy the emitting condition **today**. A count that looks like abuse is sometimes just a condition that never fails to bind.

The incident: a single device produced 21 impressions of an earned prompt in under four hours. That rate reads as automation, so two separate sessions spent half a day chasing the visitor — bot, crawler, VPN, shared household. The real cause was the fill level of a list: the prompt fires when a result "would have placed" on a capped top-N leaderboard, every board in the data was far below the cap, and below the cap nothing is ever trimmed — so **every** qualifying result places, and the prompt fires after every single game. The count was never evidence about the visitor at all.

**Why:** a threshold never reached, a quota never hit, a list never full, a dedup window that never closes on an empty dataset — any of these turns "fires when X is notable" into "fires always". The volume this produces is indistinguishable, from the outside, from genuine high-frequency abuse, so the investigation defaults to chasing the actor instead of reading the condition.

There is a second face to the same emptiness, and it is worse than a wasted afternoon: it produces a user-facing lie. While the list is below its cap, telling someone their result "would have placed" is technically true and practically false, because the interface shows only the top ten and they will never appear on it. **Gate the claim on the condition that makes it meaningful** (only claim a placement once the list holds at least as many entries as the interface displays), not on the mechanism that makes it technically accurate.

Cross-team corollary, same emptiness: neither session could have solved this alone — one held the prompt's firing logic, the other had traced the leaderboard cap while fixing unrelated copy. The tell that it was worth crossing the team boundary was a shared number that neither team's own mental model explained.

**How to apply:**
- Before chasing an actor for an anomalous rate, compute what fraction of the current data would satisfy the firing condition. If it is close to 100%, the condition is not selective — the "anomaly" is normal operation.
- List every threshold, cap, quota, or window a firing condition depends on, and check each one against the real current population, not the population it was designed for.
- Separate "the condition is met" from "the claim is meaningful" — a technically-true statement built on an unmet precondition (a list below the size it claims to rank against) is a defect even when no code path is wrong.
- When a shared metric puzzles two teams and neither owns the full explanation, that mutual confusion is itself the signal to compare notes before either team writes a fix.

Related: [[your-own-usage-is-in-the-metric]], [[match-instrument-to-failure-class]], [[calibrate-a-bound-against-the-real-distribution]].
