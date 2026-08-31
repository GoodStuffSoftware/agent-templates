---
id: an-omitted-worker-tier-inherits-the-leads
title: An omitted worker tier is an affirmative decision to pay the orchestrator's rate — audit your DEFAULTS separately from your RULES
scope: [agent-process]
requires: {}
status: active
since: 2026-08-31
provenance: [contrib-1]
corroborated: 1
---
A sub-agent spawned without an explicit model/tier setting inherits the MAIN session's. So a premium lead silently makes every worker premium, and one expensive decision becomes N of them without anyone deciding anything.

The incident: four top-tier agents ran concurrently on a task that warranted none of them. No routing rule had been broken — because no model had ever been *chosen*. Every written rule on the team governed the ACT of picking a tier, and was therefore aimed at a decision that never happened.

**Why:** A rule can only fire on a decision. When the harness supplies an inheriting default, the expensive path is the one where nobody decides, so the entire rulebook is pointed away from where the cost is. The general form is worth carrying past this case: **a rule that governs an explicit choice cannot catch a failure that happened by default.** Any orchestration system with per-worker capability settings and an inheritance fallback has this hazard — it applies to effort, timeouts, tool grants, and permission modes exactly as much as to model tier.

**How to apply:**
- **Set the worker's tier explicitly at every spawn.** Treat an omitted tier as an affirmative decision to pay the orchestrator's rate, and say so in the routing rules using those words — the omission is the behaviour you are trying to name.
- Where the harness lets you configure the fallback, **make the default cheap rather than inherited.** A wrong-but-cheap default surfaces as a quality complaint; a wrong-but-expensive one surfaces as a bill.
- **Audit defaults as a separate pass from auditing rules.** For each spawn site, ask what happens when each optional field is omitted, and whether that is the value you would have chosen.
- The reviewer is the one exception where inheritance is directionally right — but state it deliberately rather than relying on the default to produce it ([[reviewer-matches-the-tier-it-reviews]]).
- Related: [[team-vs-subagent-gate]] (whether to spawn at all) and [[budget-fan-out-against-host-memory]] (the other resource an unbounded fan-out spends).
