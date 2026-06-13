---
id: recovery-from-silent-teammates
title: Recover from a silent teammate by probing state before respawning
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 1
---
When a teammate stops sending messages without completing their task, follow a three-step recovery protocol before assuming the work was lost: (1) ping the teammate asking for an explicit report; (2) if still silent after two pings, spawn a read-only probe agent to inspect the branch/file the teammate was supposed to touch — the work may have landed but was never reported; (3) only if the state shows no work was done, shut down and respawn with a tighter brief.

**Why:** A silent agent is not the same as an absent agent. A common failure mode is that the teammate completed their work but their final report never made it to the orchestrator (permission-wedged on the last turn, or the session ended). Respawning immediately discards potentially-complete work and adds redundant cost. The probe step is cheap and often reveals the work already happened.

**How to apply:**
- Never go straight to respawn on silence. Ping then probe then respawn, in that order.
- The probe agent is read-only (use a cheap-tier explorer with no write tools) — it checks the commit log, branch diff, or the target file's state.
- If the probe finds partial work, brief the respawned teammate with exactly what's already done so they start from the right point rather than from scratch.
- Related to [[sync-or-shutdown-stale-teammates]] (which covers the orchestrator invalidating a teammate's world); this covers teammates that go silent without being explicitly invalidated.
