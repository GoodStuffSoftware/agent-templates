---
id: write-target-in-initial-brief
title: Bake the write-target into a writer's initial brief; never redirect mid-flight
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
Decide the worktree and branch a writer agent will use BEFORE spawning it, and state that write-target in the opening brief. Never redirect a writer to a different worktree/branch after it has begun editing.

**Why:** A redirect issued while a multi-file write is in flight crosses the in-flight edits — part of the change lands on the old target, part on the new one. A half-applied multi-file change split across two branches is the worst possible outcome; it's harder to recover than either branch alone would have been.

**How to apply:**
- Put the exact worktree + branch in the writer's first brief.
- If a redirect is genuinely unavoidable: STOP the writer, have it confirm exactly what it already wrote and where, then re-brief from a clean state — never start writing to the new target while an edit is in flight.
- A writer that finds itself on the wrong target (auto-created worktree, the integration branch directly, a tool-generated branch name) should stop and report, not improvise.
