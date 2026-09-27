---
description: A root-cause debugging handoff should land on the route config/model-tiers.json gives debug-root-cause (graders/route.md is generated from the table), not a model's own taste.
tags: [routing, canary]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The session consults agent-companion's recommend guidance and answers with the debug-root-cause route.
---

A test in our payments service started failing intermittently after last week's merge and nobody can explain why. I'm about to hand the root-cause hunt to a subagent. Which model and effort should that subagent run on?

Don't start the work or spawn anything yet; I only want the routing decision. Finish your reply with one line exactly in the form `ROUTE: <model>/<effort>`.
