---
id: spawn-task-team-isolation
title: Sessions spawned via spawn_task must use a unique team name to prevent roster bleed
scope: [agent-process, vendor:anthropic]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
When a parallel session is forked via the `spawn_task` tool, the spawned session must be briefed to use a unique team name (distinct from the parent's team). If the spawned session uses the same team name as the parent, its teammate messages flood the parent session's conversation.

**Why:** The `spawn_task` tool creates a sibling session that shares the same underlying message-routing infrastructure. If the sibling creates teammates under the same team name as the parent, those teammates' messages are delivered to the parent session's conversation, not just the sibling's. The result is an uncontrolled flood of messages from agents the parent never spawned.

**How to apply:**
- In any brief for a `spawn_task` session, explicitly include: "Use a unique team name for your session — do NOT use `<parent-team-name>`."
- The unique name convention is `<project>-<scope>` where scope is distinct from the parent's slug.
- This is a specific instance of the general [[unique-team-name-per-session]] rule applied to the cross-session case.
