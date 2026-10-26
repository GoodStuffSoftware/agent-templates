---
id: a-test-with-fixed-dates-fails-when-the-calendar-passes-its-window
title: A test seeded with fixed dates fails the day the calendar passes its lookback window — pin the clock or seed relative to now
scope: [universal]
requires: {}
status: active
since: 2026-10-26
provenance: [contrib-2]
corroborated: 1
---
A handler test seeded with absolute dates passed for a month, then failed with no code change once those dates aged past the handler's 30-day lookback. It failed on unrelated pushes, so it read as a regression or a flake and could block the unit gate.

**How to apply:**
- Test any time-relative logic (lookback, TTL, expiry, streak) with the clock pinned (fake timers or an injected `now`), or with dates computed relative to now.
- When a test fails with no relevant diff, grep its fixtures for absolute date literals before bisecting code.
- Prefer the pinned clock: relative seeds can still hit month and daylight-saving edges.
