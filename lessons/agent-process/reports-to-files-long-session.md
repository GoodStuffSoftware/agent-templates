---
id: reports-to-files-long-session
title: Teammates write long reports to files and send only a one-line pointer
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Any teammate report exceeding ~10 lines should be written to a file (e.g. `~/.claude/tasks/<team-name>/<batch-id>-<role>.md`), with only a one-line pointer + verdict sent to the lead. The orchestrator reads the file only when briefing the next teammate or escalating an issue.

**Why:** In long multi-teammate sessions, the lead's context fills mostly from teammate reports, not from doing work. A single multi-paragraph review verdict or diagnostic dump in chat can cost as much context as an entire round of delegation. Writing to files preserves context bandwidth for decision-making, and the file is more durable than chat scrollback (it survives context compaction).

**How to apply:**
- Establish a task-file path convention for the session at session start: `~/.claude/tasks/<team-name>/`.
- All writer, reviewer, and debugger agents write their reports there. Explorer agents can use inline messages for short results (under ~10 lines).
- The lead's rule: read a task file only when it's needed for the NEXT action — don't pull it into context speculatively.
- Complements [[idempotent-gates-crossed-messages]] (which covers async correctness) but addresses a different problem (context efficiency).
