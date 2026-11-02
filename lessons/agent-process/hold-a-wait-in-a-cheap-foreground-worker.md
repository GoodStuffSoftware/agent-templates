---
id: hold-a-wait-in-a-cheap-foreground-worker
title: A wait is held by a cheap worker in the foreground — never by the lead, and never by a background loop
scope: [agent-process]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 2
---
A wait on something the agent does not control (a merge gate, a deploy, a build) must be held by someone. The lead must not hold it: every poll is a premium turn spent learning nothing changed.

**Scope (2026-10-29):** this pattern is for a holder with NO background tool or a short background cap (cloud routine, headless run), or a lead that must block. Where run_in_background and a finish notification exist, use [[wait-for-ci-in-one-background-script-and-track-its-error-rate]]: one lead wake, no worker startup. The "background loop must not hold it" warning is about a self-restarting shell loop, not one script that notifies once on exit.

**How to apply:**
- Spawn a bottom-tier worker, background mode OFF, running a poll script that loops internally (about two-minute interval, timeout under 10 minutes).
- The worker returns once, reporting the status verbatim; the lead decides what to do next ([[an-omitted-worker-tier-inherits-the-leads]]).
