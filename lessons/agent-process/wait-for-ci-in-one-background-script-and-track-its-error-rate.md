---
id: wait-for-ci-in-one-background-script-and-track-its-error-rate
title: A CI wait is one background script that returns a verdict — and its permanent-error rate is the number to watch
scope: [agent-process]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
A small wait script that polls checks internally and returns one verdict (passed, failed, merged, no checks, timeout) replaces a model turn per hand-rolled poll.

**How to apply:**
- Run it as ONE background command that notifies on exit. A foreground call is moved to the background at the tool timeout (2 min default, 10 max), and anything a foreground subagent started stops when it returns.
- Track runs, verdict mix and the permanent-error share that forces a manual fallback (exit 3 in 4 of 196 calls here, 2%; exit 1 is a real CI failure, 15 of 137).
- A wait ending after 5 minutes wakes a subagent on an expired cache (about $0.17 against $0.06); the lead's 1h cache keeps the wake cheap.

**Scope:** default wherever run_in_background and a finish notification exist. [[hold-a-wait-in-a-cheap-foreground-worker]] stays for holders without them (cloud routine, headless run).
