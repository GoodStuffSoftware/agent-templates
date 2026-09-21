---
id: correlate-by-onset-not-by-volume
title: Trace an intermittent event by what starts just before it, not by what runs a lot
scope: [universal]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
Frequency near an event is not correlation. Onset immediately before it is. When tracing an intermittent event, sort candidates by timing offset, not by how busy they are.

The incident: an intermittent focus-stealing window was chased by polling the foreground window plus new-process creation with parent chains. The busiest process near each event — a shell spawning every few seconds for unrelated reasons — was a coincidental match and cost real investigation time. The real signal was a service instance starting a fraction of a second before every occurrence, at a fixed cadence of roughly thirty-five seconds.

**How to apply:**
- Log timestamped process-start and state-change events, then sort by **offset from each occurrence**, not by count. The candidate that consistently starts a fixed interval before the event is the lead, no matter how quiet it otherwise is.
- A fixed inter-event cadence is itself a strong clue that a timer or supervisor, not a user action, is driving the behavior.
- Know the limit of process-start watching: a **long-running** process that opens a path or window produces no new process-start event at all, so a process watcher can only narrow the field. When the field doesn't narrow to a clean answer, escalate to a facility that traces the operation itself rather than the process lifecycle ([[kernel-file-trace-names-the-opener]]).
- Validate the watcher before trusting its silence: a background watcher script that fails to parse still "runs," producing no output while looking like a clean negative result. Parse-check it first, and assert it recorded at least one event in a window where you independently know one occurred ([[assert-the-guard-saw-something]]).
- On PowerShell 5.1 specifically, a single non-ASCII character — an em dash pasted into a script's source — is enough to break the parse silently in some contexts. Keep watcher scripts ASCII-only, or build such characters from their code point instead of pasting them.

Related: [[compare-siblings-outlier-is-the-fault]], [[match-instrument-to-failure-class]].
