---
id: agent-driven-browsers-run-muted
title: Every agent-driven browser or test run of an app that makes sound runs muted
scope: [agent-process]
requires: {}
status: active
since: 2026-11-02
provenance: [contrib-2]
corroborated: 1
---
Agents that drive an app in a browser (preview pane, test harness, experiment matrix, preview checks) play whatever sound the app plays, on the operator's own machine. The operator asked for test runs to be silent while several agents were being set up to replay scenarios.

**How to apply:**
- Launch the browser muted (Chromium: `--mute-audio`) AND turn the app's own sound setting off before playing.
- Put both in the shared runner script and runbook so cheap runner agents inherit them instead of each brief repeating it.
