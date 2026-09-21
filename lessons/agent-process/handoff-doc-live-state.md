---
id: handoff-doc-live-state
title: Keep a live status doc in the worktree; never commit it — the gitignore clause is load-bearing, not tidiness
scope: [agent-process]
requires: {}
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 3
---
Writer-style agents (architects, builders, debuggers) maintain a live status document in the worktree root for the duration of their work. This doc is overwritten (not appended) at every meaningful step. It is explicitly gitignored (never committed) and is archived to a durable location or deleted when the work reaches `DONE` or `ABANDONED_BY_USER`.

**Why:** Without a live status doc, a replacement agent (spawned after a stall, a crash, or a session restart) has no way to know what work was done, what was committed, what decisions were made, or what the next action should be. The doc is the anti-death artifact. Committing it to a feature branch creates noise in the repo history and can mislead future agents into thinking it describes current state (an old `DONE` doc looks like unfinished work).

**How to apply:**
- Each writer agent creates `HANDOFF_<role>-<slug>.md` (or equivalent) in the worktree root at session start.
- Update it on EVERY step transition or pause. Minimum fields: Status (machine-greppable enum), Current step, Files modified, Decisions made, Blockers, Next concrete action.
- Add the pattern to the project's `.gitignore` (e.g. `/HANDOFF_*.md`).
- On completion: if the doc has durable architectural value, move it to a docs archive; otherwise, delete it. Never leave a consumed handoff rotting in the worktree root — it misleads future agents.
- The orchestrator MUST check the Status field before initiating a shutdown request: any value other than `DONE` or `ABANDONED_BY_USER` means work is in progress.

**This is a reinforcement of the "explicitly gitignored" clause above, not a new rule.** Two audit notes an earlier agent wrote into a worktree were untracked AND NOT ignored, so the tree never went clean, a clean-tree-gated CI short-circuit never fired, and roughly six full suite runs — each several minutes — were spent for nothing that a diff would have shown was already covered. The fix was two file deletions.

**How to apply (continued):**
- The "explicitly gitignored" rule is not tidiness — an untracked, UNIGNORED file silently defeats any clean-tree gate, and the symptom is test runs that seem inexplicably slow rather than an obvious error.
- Send anything that is not the handoff doc itself (audit notes, scratch analysis, intermediate dumps) to a scratch directory OUTSIDE the repository. Don't let a second, unlisted file accumulate next to the gitignored handoff doc — it won't inherit the ignore rule just because its sibling has one.
- When a clean-tree-gated short-circuit stops firing, check `git status --porcelain` INCLUDING untracked files before assuming the gate itself is broken — the gate is often working correctly against a tree that genuinely is not clean.
