---
description: A novel architecture task should land on the route config/model-tiers.json gives novel-design (graders/route.md is generated from the table), not a model's own taste.
tags: [routing, canary]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The session consults agent-companion's recommend guidance and answers with the novel-design route.
---

We need a brand-new message bus for our agents: delivery guarantees, ordering, and how a dormant agent gets woken up when a message arrives. There is no existing design to copy. I'm going to spawn a subagent to draft the architecture. What model and effort should it use?

Don't start the work or spawn anything yet; I only want the routing decision. Finish your reply with one line exactly in the form `ROUTE: <model>/<effort>`.
