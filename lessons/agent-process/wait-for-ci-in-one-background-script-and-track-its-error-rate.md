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
Agents that poll pull-request checks with hand-rolled status calls and sleeps burn a model turn per poll. A small wait script that polls internally and returns one verdict (passed, failed, merged, no checks, timeout) removes the loop.

**How to apply:**
- Run it as ONE background command that notifies on exit, never a foreground loop: a foreground call dies at the tool timeout of about two minutes.
- Measure it by runs, verdict mix and the share of runs ending in a permanent error that forces a manual fallback (7 of 59 here, 12%). A wait script that errors often saves nothing.
- Count its internal polls as tool calls when comparing against hand-rolled loops.
- Expect a small saving (1-2% of a session mix); the verdict's reliability is the point.

**Amends** [[hold-a-wait-in-a-cheap-foreground-worker]]: that lesson rejects a background loop and prefers a foreground worker. Parked for an A/B.
