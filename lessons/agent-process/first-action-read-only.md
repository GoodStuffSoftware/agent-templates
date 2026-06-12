---
id: first-action-read-only
title: Writer agents open with a read-only diagnostic and a liveness report
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
The first tool call of every writer-style agent must be a read-only diagnostic (`pwd`, `git status`, a file read, a grep, a glob), immediately followed by a message to the lead containing that output and a one-line plan. No write tool (edit, create, side-effecting shell command) may be the first call. On every subsequent turn, the agent sends a one-line heartbeat previewing its next action before any potentially-blocking call.

**Why:** A write tool can trigger a permission prompt, and once that prompt is pending the agent cannot message out to report it — it looks alive but is silently wedged, and the orchestrator's stop-loss has nothing to react to. Opening read-only guarantees the lead sees a liveness signal before any tool can stall the agent.

**How to apply:**
- Brief every writer-style agent to make its first action a read-only diagnostic + a report, and to heartbeat at the start of each later turn before any blocking call.
- Skip the heartbeat only when the entire turn is a single read-only diagnostic + a report (that turn self-reports).
- If a brief omits this clause and the agent stalls, the orchestrator owns the recovery cost — so make the clause part of every writer brief verbatim.
