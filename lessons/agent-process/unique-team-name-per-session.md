---
id: unique-team-name-per-session
title: Use a unique date-stamped team name for every new agent session
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Spawn each agent session into a team whose name includes a date stamp and a scope slug (e.g. `<project>-YYYYMMDD-<scope>`). Never reuse a bare project-name team across sessions.

**Why:** A shared bare team name (e.g. `my-project`) accumulates ghost teammates from prior sessions. Those idle members generate notification traffic into the new conversation and `SendMessage` calls from finished-but-never-reaped agents bleed across session boundaries, confusing the new orchestrator. The cost is non-obvious: everything looks fine, but the orchestrator receives stale status messages it never asked for.

**How to apply:**
- Name every team: `<project>-YYYYMMDD-<scope>` (e.g. `my-project-20260612-auth-refactor`). The date prefix makes teams sortable and self-documenting.
- The same rule applies to sessions spawned via `spawn_task` — each spawned session gets its own unique team name, not the parent's.
- If you inherit a session with a bare team name, don't rename it mid-session; just use the correct convention next time.
