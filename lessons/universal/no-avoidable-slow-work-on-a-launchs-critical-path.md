---
id: no-avoidable-slow-work-on-a-launchs-critical-path
title: A pre-launch wrapper must never do avoidable slow work on the critical path of the one action someone is waiting on
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
A launcher wrapper that does its heavy lifting on demand — fetch, rebuild what moved, deploy, then start — turns every upstream change into an outage report from the person waiting on it, even though nothing actually failed.

The incident: a pre-launch script hid its own console for a clean-looking launch. When an upstream dependency moved, it silently spent minutes compiling before starting anything. From the operator's chair the app was simply broken; in fact the design had put slow, invisible work on the critical path of the single action being waited on.

**Why:** doing the slow step lazily, right before the thing that needs it, feels efficient — it only runs when something actually changed. But "only when needed" and "on the path someone is blocked on" are independent properties, and combining them turns an infrequent background cost into a user-facing latency spike with no visibility into why.

**How to apply:**
- Do unavoidable slow work (build, fetch, precompile) OUT OF BAND, triggered by the change itself or by noticing an upstream move — not by the next launch request. Install the result so the launch path always finds nothing left to do.
- Make "after any change, precompile and install" a standing rule for whatever process produces the change, not a step inside the launcher.
- If slow work on the critical path is ever genuinely unavoidable, visibility is the fallback, not the fix: narrate every slow step, and only hide the window when there is truly nothing to do.
- Related: [[dev-server-request-contract]] (the same principle from the requester's side — the thing someone is waiting on should be delivered as done, not as a process report to interpret) and [[a-killed-build-leaves-helpers-a-launcher-mistakes-for-the-app]] (the companion failure when the same critical-path build gets killed mid-flight).
