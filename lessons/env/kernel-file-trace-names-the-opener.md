---
id: kernel-file-trace-names-the-opener
title: When process polling cannot name the culprit, a built-in kernel file trace can — no third-party tools
scope: [env:windows]
requires: {}
status: active
since: 2026-09-21
provenance: [contrib-2]
corroborated: 1
---
A long-running process opening a particular path generates no process-start event, so a process watcher can only narrow the field of suspects, never name the culprit outright.

The incident: several rounds of process-list elimination had narrowed the field to the right application without proving it. One elevated built-in kernel trace named it outright — it showed the application's main process opening a stale session's working folder, at the exact moment of the observed behavior.

Reconstructed generic procedure (do not present real paths in the record — use placeholders): start a kernel file trace with the built-in trace controller, scoped to the FILENAME and CREATE keywords of the kernel file provider, writing to an event-trace file; snapshot the running process list during the same window; stop the trace; then read the events oldest-first with the built-in event reader and keep only events whose string properties match the path of interest. Roughly:

```
logman start {{NAME}} -p Microsoft-Windows-Kernel-File 0x90 0x4 -o {{FILE}}.etl -ets
...reproduce the behavior, capturing a process snapshot during the window...
logman stop {{NAME}} -ets
...read {{FILE}}.etl oldest-first with the built-in event reader, filter on the path of interest...
```

**How to apply:**
- Reach for this when you can name the FILE (or folder) involved but not the PROCESS. Ordinary process watching answers the reverse question well and this one poorly.
- This requires elevation (administrator).
- Keep the trace window short — the kernel file provider is high-volume and a long capture is expensive to read back.
- Correlate hits against the process snapshot taken **inside the same window**, since the trace event alone gives a process ID that may already have exited by the time you read the log.

Related: [[correlate-by-onset-not-by-volume]], [[match-instrument-to-failure-class]].
