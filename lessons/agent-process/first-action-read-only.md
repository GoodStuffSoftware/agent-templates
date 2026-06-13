---
id: first-action-read-only
title: Writer agents open with a read-only diagnostic and a liveness report
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1, contrib-2]
corroborated: 2
---
The first tool call of every writer-style agent must be a read-only diagnostic (`pwd`, `git status`, a file read, a grep, a glob), immediately followed by a message to the lead containing that output and a one-line plan. No write tool (edit, create, side-effecting shell command) may be the first call. Then, at the start of every subsequent turn, before any potentially-blocking tool call, the agent sends a one-line heartbeat previewing its intended next action ("about to edit `foo.ts` to add bar").

**Why:** A write tool can trigger a permission prompt, and once that prompt is pending the agent cannot message out to report it — it looks alive but is silently wedged, and the orchestrator's stop-loss has nothing to react to. Opening read-only guarantees the lead sees a liveness signal before any tool can stall the agent; the per-turn heartbeat guarantees the lead keeps seeing one even if a later turn's first write blocks.

**How to apply:**
- Brief every writer-style agent to make its first action a read-only diagnostic + a report.
- Heartbeat at the start of each subsequent turn, before any potentially-blocking tool call — a one-line message previewing the intended next action. This costs one message per turn but guarantees the lead sees the agent is alive even if the very next tool call blocks on a prompt.
- Skip the heartbeat only when the entire turn is a single read-only diagnostic + a report (that turn self-reports).
- If a brief omits this clause and the agent stalls, the orchestrator owns the recovery cost — so make the clause part of every writer brief verbatim.
