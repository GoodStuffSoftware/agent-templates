---
id: a-timeout-message-names-the-threshold-not-the-moment
title: A timeout message names the configured threshold, not the moment the blocking call actually returned
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A "timed out after {{N}}ms" message is emitted by the runner's own timeout logic, which fires only after checking whether the call has finished — and a runner waiting on a SYNCHRONOUS blocking call cannot interrupt it mid-flight. If the underlying call actually takes longer than the configured limit, the runner reports the configured limit, not the wall-clock time the call actually took.

The incident: a test runner's timeout message read "timed out in 5000ms". Two independent investigators anchored on that figure as a clue to the cause. The runner's timeout check only runs after a blocking synchronous child process returns; the child was actually taking around 8 seconds. The reported number was the threshold the runner had been configured with, not a measurement of anything that happened — and both investigations were led toward causes that would explain a roughly-5-second failure, when the real duration was around 60% longer.

**Why:** a timeout message reads like a stopwatch reading, so it gets treated as one. It is closer to a configuration echo: the runner is reporting what it WOULD have allowed, decorated with the word "timed out" that makes it look like a measurement of what happened.

**How to apply:**
- Treat a reported timeout duration as the configured threshold, not as elapsed wall-clock time, unless the runner's own source confirms it measures and reports the actual duration.
- When a timeout is implicated in a diagnosis, independently measure how long the blocking call actually takes (wrap it, log entry/exit timestamps, or run it standalone) before using the reported figure as evidence of magnitude.
- This matters most for a runner built on a language/runtime whose blocking calls cannot be preempted — the gap between "configured limit" and "actual duration" is exactly the overrun the runner was powerless to observe or interrupt.
- Related: [[a-default-timeout-shorter-than-cold-start-manufactures-flakes]] (a different timeout failure: the threshold itself is miscalibrated, not merely misreported).
