---
id: diagnose-the-right-process
title: Confirm which process actually serves a build before diagnosing it
scope: [agent-process]
status: active
since: 2026-06-12
provenance: [contrib-1]
corroborated: 1
---
Before diagnosing a failure "on a port" or "in the build," confirm which process is actually listening on that port / serving that build. Don't diagnose a process you only *assumed* is the right one.

**Why:** Port fallback, stale servers, and multiple agents' leftover listeners mean the thing answering on a port is often not the thing you think. Every minute spent debugging a wedged stale process is a minute not spent on the real failure — and you may "fix" something that was never broken.

**How to apply:**
- Identify the actual listener/PID on the port before forming a hypothesis.
- Confirm it's serving the build under test (right commit, right directory) — not a leftover from an earlier run.
- Pairs with [[verify-actual-bound-url]]: get the real URL first, then confirm the real process behind it.
