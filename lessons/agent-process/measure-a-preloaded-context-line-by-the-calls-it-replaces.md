---
id: measure-a-preloaded-context-line-by-the-calls-it-replaces
title: Judge a preloaded context line by the calls it replaces, not by per-session token totals
scope: [agent-process]
requires: {}
status: active
since: 2026-10-19
provenance: [contrib-2]
corroborated: 1
---
A hook that front-loads one small line (branch, dirty files, upstream distance, whether a named change has landed) to replace exploratory calls cannot be judged by per-session totals: session size ranges from a few turns to hundreds of calls, so the saving drowns in noise.

**How to apply:** judge it on four numbers.
- The rate of the calls it replaces, per 1,000 tool calls and per agent in its first five calls, before and after.
- Cost per start (a line of about 400 characters is about 120 tokens).
- Delivery rate: a hook that times out delivers nothing, silently (14% of starts in one trial, 4% after a fix).
- Whether the optional query it enables is ever used.

Break-even is one avoided call per 20-60 starts. Unless the session mix is held constant, report the result as "plausible, confounded".

Related: [[your-own-usage-is-in-the-metric]], [[a-silent-guard-needs-a-canary]].
