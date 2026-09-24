---
description: Negative trigger - an unrelated question must not pull in the routing skill (scored in both arms).
tags: [routing, canary, negative]
max_turns: 6
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: A one-sentence answer about HTTP 418 with no recommend skill invocation.
---

What does HTTP status code 418 mean? One sentence is plenty.
