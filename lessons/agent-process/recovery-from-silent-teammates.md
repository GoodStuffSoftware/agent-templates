---
id: recovery-from-silent-teammates
title: Recover from a silent teammate by probing state before respawning
scope: [agent-process]
requires: {}
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
When a teammate stops sending messages without completing their task, follow a three-step recovery protocol before assuming the work was lost: (1) ping the teammate asking for an explicit report; (2) if still silent after two pings, spawn a read-only probe agent to inspect the branch/file the teammate was supposed to touch — the work may have landed but was never reported; (3) only if the state shows no work was done, shut down and respawn with a tighter brief.

**Why:** A silent agent is not the same as an absent agent. A common failure mode is that the teammate completed their work but their final report never made it to the orchestrator (permission-wedged on the last turn, or the session ended). Respawning immediately discards potentially-complete work and adds redundant cost. The probe step is cheap and often reveals the work already happened.

**The probe and the cure are often the same action.** Where the harness can deliver a message to a background worker, the DELIVERY RESPONSE is itself the liveness verdict: "queued for delivery at its next tool round" proves the task is still alive, while "was stopped; resumed it in the background with your message" proves it had silently ended AND has just been revived from its transcript, with your message as its next instruction. Because the sender cannot know in advance which case applies, write every probe to work in both: *report your stage now; if the work is done, deliver it rather than polishing; if you never started, say so.* The cloud analogue is the same shape — a direct send cold-wakes an armed agent, and a "no wake handle" outcome means queued-durably, NOT unreachable.

**How to apply:**
- Never go straight to respawn on silence. Ping then probe then respawn, in that order — and note that on many harnesses the ping IS the first two steps at once.
- **Arm an evidence fuse at spawn for anything long.** State the expected duration in the brief, and probe at roughly 1.5× it with INDEPENDENT evidence — the process table, worktree modification times, remote branches. A zero-byte output file is weak evidence on its own: healthy agents produce it too. The operator should never be the one to ask "is it stuck?"; the lead owns the fuse.
- **On a confirmed wedge, respawn with a LEANER brief that reuses what the first attempt produced** — its written plan, its diff of test names, its partial branch — rather than paying for that work twice.
- The probe agent is read-only (use a cheap-tier explorer with no write tools) — it checks the commit log, branch diff, or the target file's state.
- If the probe finds partial work, brief the respawned teammate with exactly what's already done so they start from the right point rather than from scratch.
- Related to [[sync-or-shutdown-stale-teammates]] (which covers the orchestrator invalidating a teammate's world); this covers teammates that go silent without being explicitly invalidated.
