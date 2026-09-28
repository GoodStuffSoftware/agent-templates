---
id: normalize-timezones-before-timestamp-arithmetic
title: An API timestamp and a git timestamp are usually in different time zones — normalize before comparing, or prefer a structural check
scope: [universal]
requires: {}
status: active
since: 2026-09-28
provenance: [contrib-2]
corroborated: 1
---
An investigation concluded a test had regressed, reasoning that a CI run timestamped 22:52 must postdate a commit that added the test at 19:15 — which would mean the test once existed and passed. Both numbers were accurate and the conclusion was still wrong: the run's timestamp was UTC, the commit's was local at a `-0400` offset, and correcting for the offset put the run about 23 minutes *before* the commit — the test had never run there at all.

**Why:** two timestamps from different systems carry no guarantee of a shared zone, and a bare numeric or wall-clock comparison silently assumes one. The error is invisible in the numbers themselves — both were "correct" readings — and shows up only in the conclusion drawn from comparing them directly.

**How to apply:**
- Normalize both sides to one zone (UTC is the safe default) before doing any arithmetic or ordering comparison on timestamps from different sources.
- Prefer a direct structural check over timestamp arithmetic wherever one is available: whether a file exists at a given commit, or whether one commit is an ancestor of another, answers the real ordering question with no offset to get wrong.
- Treat a surprising conclusion drawn from timestamp math as a reason to check for a cheap corroborating signal before acting on it — in this case, the supposedly-passing historical runs showed a noticeably lower test count than the current suite, which alone should have cast doubt on the story.

Related: [[match-ids-not-dates]], [[bucket-by-the-other-systems-calendar]].
