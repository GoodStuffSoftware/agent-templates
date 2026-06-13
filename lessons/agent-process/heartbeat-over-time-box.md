---
id: heartbeat-over-time-box
title: Abort on actual blockers, not elapsed wall-clock time
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-2]
corroborated: 2
---
Teammate briefs should ask for progress reports at natural phase transitions and before blocking calls — not at wall-clock intervals ("if stuck for 5 minutes, abort"). Wall-clock abort triggers fire on slow-but-progressing work (long builds, large uploads, test suites) and cause false aborts.

**Why:** LLM execution time is not human time. A build or test run that takes "too long" by a human estimate may be progressing normally. Aborting it due to elapsed time wastes the work done and forces a restart, often at higher cost than simply waiting. The thing to abort on is actual blockers: an unresolvable error, a repeated permission denial, a missing prerequisite — not elapsed time. Don't bias scope decisions with LLM-time estimates either — a brief that says "this'll take 5 minutes" sets a false expectation that has nothing to do with how the work actually progresses.

**How to apply:**
- Brief teammates to report at step transitions: "after each phase completes" or "before any potentially-blocking tool call."
- Trigger abort logic on error conditions (exit code != 0, a message saying "unresolvable blocker"), not on time.
- For long-running child processes (builds, uploads, large tests), use progress polling (log line markers) instead of a fixed timeout.
- Don't put time estimates in briefs at all — they bias scope without informing it.
