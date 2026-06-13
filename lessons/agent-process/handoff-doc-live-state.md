---
id: handoff-doc-live-state
title: Keep a live status doc in the worktree; never commit it; archive or delete when done
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Writer-style agents (architects, builders, debuggers) maintain a live status document in the worktree root for the duration of their work. This doc is overwritten (not appended) at every meaningful step. It is explicitly gitignored (never committed) and is archived to a durable location or deleted when the work reaches `DONE` or `ABANDONED_BY_USER`.

**Why:** Without a live status doc, a replacement agent (spawned after a stall, a crash, or a session restart) has no way to know what work was done, what was committed, what decisions were made, or what the next action should be. The doc is the anti-death artifact. Committing it to a feature branch creates noise in the repo history and can mislead future agents into thinking it describes current state (an old `DONE` doc looks like unfinished work).

**How to apply:**
- Each writer agent creates `HANDOFF_<role>-<slug>.md` (or equivalent) in the worktree root at session start.
- Update it on EVERY step transition or pause. Minimum fields: Status (machine-greppable enum), Current step, Files modified, Decisions made, Blockers, Next concrete action.
- Add the pattern to the project's `.gitignore` (e.g. `/HANDOFF_*.md`).
- On completion: if the doc has durable architectural value, move it to a docs archive; otherwise, delete it. Never leave a consumed handoff rotting in the worktree root — it misleads future agents.
- The orchestrator MUST check the Status field before initiating a shutdown request: any value other than `DONE` or `ABANDONED_BY_USER` means work is in progress.
