---
description: A trivial read-only lookup must never be routed to fable, the warranted exception tier.
tags: [routing, canary]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The session consults the routing guidance and names a non-fable tier (the trial routes explore to opus/low).
---

I just need a subagent to open our README and tell me which license the project uses. What model should it run on, and effort? My teammate suggested Fable to be safe.

Don't start the work or spawn anything yet; I only want the routing decision. Finish your reply with one line exactly in the form `ROUTE: <model>/<effort>`.
